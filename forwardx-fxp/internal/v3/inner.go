package v3

// Inner authenticated record layer for V3, aligned with the inspected reference
// handshake and record shape:
//
//   - the peer sends a 17-byte initialisation: one mode byte plus 16 bytes of
//     material;
//   - the payload length is sealed separately from the payload, so the length is
//     confidential as well as authenticated;
//   - the 12-byte nonce increments once per AEAD operation.
//
// The reference derives ONE key and uses zero-initialised nonces in BOTH
// directions (0xbd7140 stores the same key slice into both objects), which is
// cross-direction keystream reuse. ForwardX keeps the shape but not the flaw:
// HKDF-SHA256 derives independent length and data keys per direction, and every
// nonce carries a direction byte and an operation kind.
//
// The reference compares its 16-byte material with runtime.memequal. Here the
// material is a random nonce authenticated by a truncated HMAC-SHA256 tag and
// compared with hmac.Equal, so the handshake is constant time and resists
// replay.
//
// This layer is ForwardX's own and is NOT interoperable with the reference.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

const (
	// InnerHandshakeSize is the first handshake message: mode byte + 16 material
	// bytes. The reference reads 17 bytes here (0xd00080) before anything else.
	InnerHandshakeSize = 17
	// innerMaterialSize is the random material carried by the first message.
	innerMaterialSize = 16
	// innerTagSize is the second handshake message. The reference then reads a
	// further 16 bytes out of the inner message and compares them with local
	// material using runtime.memequal; ForwardX uses that slot for a mutual
	// HMAC-SHA256 tag instead, which is constant time and not replayable.
	innerTagSize = 16
	// InnerHandshakeTotal is both handshake messages together.
	InnerHandshakeTotal = InnerHandshakeSize + innerTagSize

	// InnerModeAEAD selects the authenticated record layer. The reference uses 1
	// for its OFB stream and 2 for its AEAD branch; ForwardX only implements an
	// authenticated layer, so the value is a fixed marker, not a negotiation.
	InnerModeAEAD byte = 2

	// innerInfo matches the reference HKDF info literal, recovered from
	// 0xbd71ee/0xbd71f8 and decoded by 0xbd8380.
	innerInfo = "ss-neko-aead"

	// innerRecordLimit is the reference's reader buffer size (mov ebx, 0x400f at
	// 0xbd7531). The effective payload cap is this minus the 2-byte length record
	// and the 16-byte tag.
	innerRecordLimit = 0x400f
	// InnerPayloadLimit is therefore 16381, not 16383 as an earlier reading of
	// 0x3fff suggested.
	InnerPayloadLimit = innerRecordLimit - 2 - 16

	// innerNonceSize is the AES-GCM standard nonce size.
	innerNonceSize = 12
	// innerMaxCounter bounds the per-direction operation counter so a long-lived
	// session can never wrap a nonce.
	innerMaxCounter = 1<<62 - 1
)

// Direction bytes keep the two directions in disjoint nonce spaces.
const (
	innerDirClientToServer byte = 0x01
	innerDirServerToClient byte = 0x02
)

// Per-operation kinds keep the sealed length and the sealed payload in disjoint
// nonce spaces, because both consume a counter value.
const (
	innerKindLength byte = 0x00
	innerKindData   byte = 0x01
)

var (
	ErrInnerHandshake = errors.New("v3: inner handshake rejected")
	ErrInnerRecord    = errors.New("v3: invalid inner record")
	ErrInnerNonce     = errors.New("v3: inner nonce exhausted")
)

// InnerConn is a net.Conn carrying the inner authenticated record layer. It
// serialises writes internally; callers may use it from multiple goroutines.
type InnerConn struct {
	conn net.Conn

	writeAEAD, readAEAD       cipher.AEAD
	lenWriteAEAD, lenReadAEAD cipher.AEAD
	writeCounter, readCounter uint64
	writeDir, readDir         byte
	// writeKeyID / readKeyID are non-reversible fingerprints of the derived
	// record keys. They exist for tests and for diagnostics that must never log
	// key material.
	writeKeyID, readKeyID [32]byte
	writeMu               sync.Mutex
	readBuf               []byte
	readLen               int
	readOff               int
	readErr               error
	maxPayload            int
}

// hkdfSHA256 implements RFC 5869 extract-and-expand over HMAC-SHA256. It is
// written out here rather than pulling in golang.org/x/crypto so the FXP module
// keeps its dependency-free module graph. Output matches the standard HKDF
// construction the reference uses (only the hash differs: the reference picks
// SHA-1 at 0xbd7218, ForwardX uses SHA-256).
func hkdfSHA256(secret, salt, info []byte, length int) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	extract := hmac.New(sha256.New, salt)
	extract.Write(secret)
	prk := extract.Sum(nil)

	out := make([]byte, 0, length)
	var block []byte
	for counter := byte(1); len(out) < length; counter++ {
		expand := hmac.New(sha256.New, prk)
		expand.Write(block)
		expand.Write(info)
		expand.Write([]byte{counter})
		block = expand.Sum(nil)
		out = append(out, block...)
	}
	return out[:length]
}

// deriveInnerKeys expands the tunnel PSK into four independent keys. It never
// reuses a key across directions or across the length/data split.
func deriveInnerKeys(psk string, salt []byte) (c2sLen, c2sData, s2cLen, s2cData []byte, err error) {
	secret := sha256.Sum256([]byte(psk))
	material := hkdfSHA256(secret[:], salt, []byte(innerInfo), 64)
	return material[0:16], material[16:32], material[32:48], material[48:64], nil
}

// newInnerAEAD builds one AES-GCM instance over a 16-byte key.
func newInnerAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// innerTag authenticates both handshake materials under the tunnel PSK, binding
// the two sides together. The local material is listed first so the two
// directions cannot produce the same tag.
func innerTag(psk string, local, peer []byte) []byte {
	key := sha256.Sum256([]byte("forwardx-v3 inner handshake\x00" + psk))
	mac := hmac.New(sha256.New, key[:])
	mac.Write(local)
	mac.Write(peer)
	return mac.Sum(nil)[:innerTagSize]
}

// writeInnerInit sends mode + material as one 17-byte message.
func writeInnerInit(conn net.Conn, material []byte) error {
	if len(material) != innerMaterialSize {
		return errors.New("v3: invalid inner material length")
	}
	msg := make([]byte, 0, InnerHandshakeSize)
	msg = append(msg, InnerModeAEAD)
	msg = append(msg, material...)
	return writeFull(conn, msg)
}

// readInnerInit reads one 17-byte message and checks its mode byte.
func readInnerInit(conn net.Conn) ([]byte, error) {
	msg := make([]byte, InnerHandshakeSize)
	if _, err := io.ReadFull(conn, msg); err != nil {
		return nil, err
	}
	if msg[0] != InnerModeAEAD {
		return nil, ErrInnerHandshake
	}
	return msg[1:], nil
}

// writeInnerProof sends the mutual tag over both materials.
func writeInnerProof(conn net.Conn, psk string, local, peer []byte) error {
	return writeFull(conn, innerTag(psk, local, peer))
}

// readInnerProof reads the peer's tag and compares it in constant time.
func readInnerProof(conn net.Conn, psk string, local, peer []byte) error {
	proof := make([]byte, innerTagSize)
	if _, err := io.ReadFull(conn, proof); err != nil {
		return err
	}
	if !hmac.Equal(proof, innerTag(psk, peer, local)) {
		return ErrInnerHandshake
	}
	return nil
}

// innerSalt binds both handshake materials into the key-derivation salt.
func innerSalt(local, peer []byte) []byte {
	salt := make([]byte, 0, innerMaterialSize*2)
	salt = append(salt, local...)
	salt = append(salt, peer...)
	return salt
}

// InnerClient performs the client side of the inner handshake and returns a
// record-layer connection. The caller owns conn. A failed handshake closes conn
// so a rejected peer can never leave a half-open connection behind.
func InnerClient(conn net.Conn, psk string) (*InnerConn, error) {
	inner, err := innerClientHandshake(conn, psk)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return inner, nil
}

func innerClientHandshake(conn net.Conn, psk string) (*InnerConn, error) {
	material := make([]byte, innerMaterialSize)
	if _, err := rand.Read(material); err != nil {
		return nil, err
	}
	if err := writeInnerInit(conn, material); err != nil {
		return nil, err
	}
	peer, err := readInnerInit(conn)
	if err != nil {
		return nil, err
	}
	if err := writeInnerProof(conn, psk, material, peer); err != nil {
		return nil, err
	}
	if err := readInnerProof(conn, psk, material, peer); err != nil {
		return nil, err
	}
	c2sLen, c2sData, s2cLen, s2cData, err := deriveInnerKeys(psk, innerSalt(material, peer))
	if err != nil {
		return nil, err
	}
	return buildInnerConn(conn, c2sLen, c2sData, s2cLen, s2cData,
		innerDirClientToServer, innerDirServerToClient)
}

// InnerServer performs the server side of the inner handshake and returns a
// record-layer connection. The caller owns conn. A failed handshake closes conn
// so an unauthenticated peer cannot hold a connection slot open.
func InnerServer(conn net.Conn, psk string) (*InnerConn, error) {
	inner, err := innerServerHandshake(conn, psk)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return inner, nil
}

func innerServerHandshake(conn net.Conn, psk string) (*InnerConn, error) {
	peer, err := readInnerInit(conn)
	if err != nil {
		return nil, err
	}
	material := make([]byte, innerMaterialSize)
	if _, err := rand.Read(material); err != nil {
		return nil, err
	}
	if err := writeInnerInit(conn, material); err != nil {
		return nil, err
	}
	// The client proves itself first so an unauthenticated peer cannot make the
	// server commit to a session.
	if err := readInnerProof(conn, psk, material, peer); err != nil {
		return nil, err
	}
	if err := writeInnerProof(conn, psk, material, peer); err != nil {
		return nil, err
	}
	c2sLen, c2sData, s2cLen, s2cData, err := deriveInnerKeys(psk, innerSalt(peer, material))
	if err != nil {
		return nil, err
	}
	return buildInnerConn(conn, c2sLen, c2sData, s2cLen, s2cData,
		innerDirServerToClient, innerDirClientToServer)
}

// buildInnerConn wires the four derived keys to the correct direction.
func buildInnerConn(conn net.Conn, c2sLen, c2sData, s2cLen, s2cData []byte, writeDir, readDir byte) (*InnerConn, error) {
	writeLen, err := newInnerAEAD(selectKey(writeDir, c2sLen, s2cLen))
	if err != nil {
		return nil, err
	}
	writeData, err := newInnerAEAD(selectKey(writeDir, c2sData, s2cData))
	if err != nil {
		return nil, err
	}
	readLen, err := newInnerAEAD(selectKey(readDir, c2sLen, s2cLen))
	if err != nil {
		return nil, err
	}
	readData, err := newInnerAEAD(selectKey(readDir, c2sData, s2cData))
	if err != nil {
		return nil, err
	}
	return &InnerConn{
		conn: conn, writeAEAD: writeData, readAEAD: readData,
		lenWriteAEAD: writeLen, lenReadAEAD: readLen,
		writeDir: writeDir, readDir: readDir,
		writeKeyID: sha256.Sum256(selectKey(writeDir, c2sData, s2cData)),
		readKeyID:  sha256.Sum256(selectKey(readDir, c2sData, s2cData)),
		maxPayload: InnerPayloadLimit,
	}, nil
}

// selectKey returns the c2s key when the direction is client-to-server and the
// s2c key otherwise.
func selectKey(dir byte, c2s, s2c []byte) []byte {
	if dir == innerDirClientToServer {
		return c2s
	}
	return s2c
}

func innerNonce(dst []byte, dir byte, counter uint64, kind byte) {
	dst[0] = dir
	dst[1] = kind
	dst[2] = 0
	dst[3] = 0
	binary.BigEndian.PutUint64(dst[4:12], counter)
}

// sealRecord appends one sealed record to dst. The 2-byte big-endian length is
// sealed separately from the payload, matching the reference layout.
func (c *InnerConn) sealRecord(dst, payload []byte) ([]byte, error) {
	if len(payload) > c.maxPayload {
		return nil, ErrFrameTooLarge
	}
	if c.writeCounter > innerMaxCounter {
		return nil, ErrInnerNonce
	}
	var lenPlain [2]byte
	binary.BigEndian.PutUint16(lenPlain[:], uint16(len(payload)))
	var lenNonce, dataNonce [innerNonceSize]byte
	innerNonce(lenNonce[:], c.writeDir, c.writeCounter, innerKindLength)
	innerNonce(dataNonce[:], c.writeDir, c.writeCounter, innerKindData)
	dst = c.lenWriteAEAD.Seal(dst, lenNonce[:], lenPlain[:], nil)
	dst = c.writeAEAD.Seal(dst, dataNonce[:], payload, nil)
	c.writeCounter++
	return dst, nil
}

// WriteRecord seals and sends exactly one record.
func (c *InnerConn) WriteRecord(payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	out, err := c.sealRecord(nil, payload)
	if err != nil {
		return err
	}
	return writeFull(c.conn, out)
}

// readRecord refills the buffer with exactly one decrypted record.
func (c *InnerConn) readRecord() error {
	lenSize := 2 + c.lenReadAEAD.Overhead()
	head := make([]byte, lenSize)
	if _, err := io.ReadFull(c.conn, head); err != nil {
		return err
	}
	if c.readCounter > innerMaxCounter {
		return ErrInnerNonce
	}
	var lenNonce [innerNonceSize]byte
	innerNonce(lenNonce[:], c.readDir, c.readCounter, innerKindLength)
	lenPlain, err := c.lenReadAEAD.Open(nil, lenNonce[:], head, nil)
	if err != nil {
		return ErrInnerRecord
	}
	if len(lenPlain) != 2 {
		return ErrInnerRecord
	}
	n := int(binary.BigEndian.Uint16(lenPlain))
	if n > c.maxPayload {
		return ErrFrameTooLarge
	}
	body := make([]byte, n+c.readAEAD.Overhead())
	if _, err := io.ReadFull(c.conn, body); err != nil {
		return err
	}
	var dataNonce [innerNonceSize]byte
	innerNonce(dataNonce[:], c.readDir, c.readCounter, innerKindData)
	plain, err := c.readAEAD.Open(nil, dataNonce[:], body, nil)
	if err != nil {
		return ErrInnerRecord
	}
	c.readCounter++
	c.readBuf = plain
	c.readLen = len(plain)
	c.readOff = 0
	return nil
}

func (c *InnerConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for c.readOff >= c.readLen {
		if c.readErr != nil {
			return 0, c.readErr
		}
		if err := c.readRecord(); err != nil {
			c.readErr = err
			return 0, err
		}
	}
	n := copy(p, c.readBuf[c.readOff:c.readLen])
	c.readOff += n
	return n, nil
}

// Write splits oversized buffers into records. The whole call holds the write
// lock so a record can never interleave with another writer's record.
func (c *InnerConn) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	written := 0
	for written < len(p) {
		size := len(p) - written
		if size > c.maxPayload {
			size = c.maxPayload
		}
		out, err := c.sealRecord(nil, p[written:written+size])
		if err != nil {
			return written, err
		}
		if err := writeFull(c.conn, out); err != nil {
			return written, err
		}
		written += size
	}
	return written, nil
}

func (c *InnerConn) Close() error                       { return c.conn.Close() }
func (c *InnerConn) LocalAddr() net.Addr                { return c.conn.LocalAddr() }
func (c *InnerConn) RemoteAddr() net.Addr               { return c.conn.RemoteAddr() }
func (c *InnerConn) SetDeadline(t time.Time) error      { return c.conn.SetDeadline(t) }
func (c *InnerConn) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *InnerConn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }
