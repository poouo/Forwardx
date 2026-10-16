package v3

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

// TestHKDFSHA256MatchesRFC5869 uses the RFC 5869 test vector for SHA-256
// (test case 1), so the hand-written HKDF is checked against the specification
// rather than against itself.
func TestHKDFSHA256MatchesRFC5869(t *testing.T) {
	ikm, _ := hex.DecodeString("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
	salt, _ := hex.DecodeString("000102030405060708090a0b0c")
	info, _ := hex.DecodeString("f0f1f2f3f4f5f6f7f8f9")
	want, _ := hex.DecodeString("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
	got := hkdfSHA256(ikm, salt, info, 42)
	if !bytes.Equal(got, want) {
		t.Fatalf("hkdf mismatch\n got %x\nwant %x", got, want)
	}
}

// innerTCPPair builds a real TCP pair. net.Pipe is synchronous and unbuffered,
// so a writer and reader that are not concurrent would deadlock; TCP also
// exercises the real record framing.
func innerTCPPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	type accepted struct {
		conn net.Conn
		err  error
	}
	ch := make(chan accepted, 1)
	go func() {
		conn, err := listener.Accept()
		ch <- accepted{conn, err}
	}()
	client, err := net.DialTimeout("tcp", listener.Addr().String(), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	result := <-ch
	if result.err != nil {
		client.Close()
		t.Fatal(result.err)
	}
	t.Cleanup(func() { client.Close(); result.conn.Close() })
	return client, result.conn
}

func innerPair(t *testing.T, psk string) (*InnerConn, *InnerConn) {
	t.Helper()
	a, b := innerTCPPair(t)
	clientCh := make(chan *InnerConn, 1)
	errCh := make(chan error, 1)
	go func() {
		conn, err := InnerServer(b, psk)
		if err != nil {
			errCh <- err
			return
		}
		clientCh <- conn
	}()
	client, err := InnerClient(a, psk)
	if err != nil {
		t.Fatalf("client handshake: %v", err)
	}
	select {
	case server := <-clientCh:
		return client, server
	case err := <-errCh:
		t.Fatalf("server handshake: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("handshake did not complete")
	}
	return nil, nil
}

func TestInnerHandshakeAndRecordRoundTrip(t *testing.T) {
	client, server := innerPair(t, "tunnel-psk")
	payloads := [][]byte{
		[]byte("hello"),
		bytes.Repeat([]byte{0xff}, InnerPayloadLimit),
		// Larger than one record: Write must split it.
		bytes.Repeat([]byte("record-boundary"), 3000),
	}
	for i, payload := range payloads {
		writeErr := make(chan error, 1)
		go func(p []byte) {
			if len(p) > InnerPayloadLimit {
				_, err := client.Write(p)
				writeErr <- err
				return
			}
			writeErr <- client.WriteRecord(p)
		}(payload)
		got := make([]byte, len(payload))
		if _, err := io.ReadFull(server, got); err != nil {
			t.Fatalf("payload %d read: %v", i, err)
		}
		if err := <-writeErr; err != nil {
			t.Fatalf("payload %d write: %v", i, err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("payload %d mismatch length=%d", i, len(got))
		}
	}
	// A zero-length record is a valid record and must survive the layer.
	go func() { _ = client.WriteRecord(nil) }()
	if err := server.readRecord(); err != nil {
		t.Fatalf("empty record read: %v", err)
	}
	if server.readLen != 0 {
		t.Fatalf("empty record produced %d bytes", server.readLen)
	}
}

func TestInnerRejectsWrongKey(t *testing.T) {
	a, b := innerTCPPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := InnerServer(b, "server-secret")
		done <- err
	}()
	clientErr := make(chan error, 1)
	go func() {
		_, err := InnerClient(a, "client-secret")
		clientErr <- err
	}()
	select {
	case err := <-clientErr:
		if err == nil {
			t.Fatal("wrong PSK accepted by client")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("client did not finish")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("wrong PSK accepted by server")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reject")
	}
}

func TestInnerRejectsTamperedHandshake(t *testing.T) {
	a, b := innerTCPPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := InnerServer(b, "psk")
		done <- err
	}()
	// Correct 17-byte init shape, then a wrong proof.
	go func() {
		init := make([]byte, InnerHandshakeSize)
		init[0] = InnerModeAEAD
		if _, err := a.Write(init); err != nil {
			return
		}
		_, _ = a.Write(make([]byte, innerTagSize))
	}()
	select {
	case err := <-done:
		if !errors.Is(err, ErrInnerHandshake) {
			t.Fatalf("tampered proof not rejected: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reject tampered handshake")
	}
}

func TestInnerRejectsTamperedServerProof(t *testing.T) {
	a, b := innerTCPPair(t)
	serverErr := make(chan error, 1)
	go func() {
		// A server that answers with a wrong proof must be rejected by the
		// client rather than yielding a session.
		peer, err := readInnerInit(b)
		if err != nil {
			serverErr <- err
			return
		}
		material := make([]byte, innerMaterialSize)
		if err := writeInnerInit(b, material); err != nil {
			serverErr <- err
			return
		}
		if err := readInnerProof(b, "psk", material, peer); err != nil {
			serverErr <- err
			return
		}
		_, _ = b.Write(make([]byte, innerTagSize)) // wrong proof
		serverErr <- nil
	}()
	if _, err := InnerClient(a, "psk"); !errors.Is(err, ErrInnerHandshake) {
		t.Fatalf("client accepted a forged server proof: %v", err)
	}
	<-serverErr
}

func TestInnerRejectsWrongModeByte(t *testing.T) {
	a, b := innerTCPPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := InnerServer(b, "psk")
		done <- err
	}()
	msg := make([]byte, InnerHandshakeSize)
	msg[0] = 1 // the reference's OFB marker; ForwardX implements no such mode
	go func() { _, _ = a.Write(msg) }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrInnerHandshake) {
			t.Fatalf("unsupported mode accepted: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reject unsupported mode")
	}
}

func TestInnerSessionsWithSamePSKDoNotShareKeys(t *testing.T) {
	// Fresh random material per handshake must give every session its own keys,
	// so a record sealed in one session is undecryptable in another even though
	// both use the same tunnel PSK.
	first, firstPeer := innerPair(t, "psk")
	second, _ := innerPair(t, "psk")

	if first.writeKeyID == second.writeKeyID {
		t.Fatal("two sessions derived the same write key")
	}
	if first.writeKeyID == first.readKeyID {
		t.Fatal("write and read keys are not separated")
	}
	// The peer's read key must equal our write key, otherwise the two sides
	// disagree about the direction mapping.
	if firstPeer.readKeyID != first.writeKeyID {
		t.Fatal("peer read key does not match local write key")
	}
	if firstPeer.writeKeyID != first.readKeyID {
		t.Fatal("peer write key does not match local read key")
	}
}

func TestInnerRejectsTamperedRecord(t *testing.T) {
	client, server := innerPair(t, "psk")
	sealed, err := client.sealRecord(nil, []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	sealed[len(sealed)-1] ^= 0x01
	// The tampered bytes must be rejected rather than yielding plaintext.
	go func() { _, _ = client.conn.Write(sealed) }()
	buf := make([]byte, 32)
	server.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := server.Read(buf); !errors.Is(err, ErrInnerRecord) {
		t.Fatalf("tampered record accepted: %v", err)
	}
}

func TestInnerRejectsOversizedPayload(t *testing.T) {
	client, _ := innerPair(t, "psk")
	if err := client.WriteRecord(make([]byte, InnerPayloadLimit+1)); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("oversized record accepted: %v", err)
	}
	// The cap comes from the reference reader buffer 0x400f minus the 2-byte
	// length record and the 16-byte tag.
	if InnerPayloadLimit != 16381 {
		t.Fatalf("payload limit changed: %d", InnerPayloadLimit)
	}
	if innerRecordLimit != 0x400f {
		t.Fatalf("record limit changed: %#x", innerRecordLimit)
	}
}

func TestInnerLargeWriteSplitsIntoRecords(t *testing.T) {
	client, server := innerPair(t, "psk")
	payload := bytes.Repeat([]byte("split-me"), 20000)
	done := make(chan error, 1)
	go func() {
		_, err := client.Write(payload)
		done <- err
	}()
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(server, got); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("split write corrupted payload")
	}
}

func TestInnerConcurrentWritesDoNotInterleave(t *testing.T) {
	client, server := innerPair(t, "psk")
	const writers = 8
	const each = 200
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			payload := bytes.Repeat([]byte{byte('A' + w)}, each)
			if _, err := client.Write(payload); err != nil {
				t.Error(err)
			}
		}(w)
	}
	total := writers * each
	got := make([]byte, total)
	readDone := make(chan error, 1)
	go func() {
		_, err := io.ReadFull(server, got)
		readDone <- err
	}()
	wg.Wait()
	if err := <-readDone; err != nil {
		t.Fatal(err)
	}
	// Each writer's bytes must arrive contiguously and unmixed.
	for w := 0; w < writers; w++ {
		marker := byte('A' + w)
		count := 0
		for _, b := range got {
			if b == marker {
				count++
			}
		}
		if count != each {
			t.Fatalf("writer %c contributed %d bytes, want %d", marker, count, each)
		}
	}
}

func TestInnerNonceExhaustionFailsClosed(t *testing.T) {
	client, _ := innerPair(t, "psk")
	client.writeCounter = innerMaxCounter + 1
	if err := client.WriteRecord([]byte("x")); !errors.Is(err, ErrInnerNonce) {
		t.Fatalf("nonce exhaustion not enforced: %v", err)
	}
}

func TestInnerHandshakeTagIsHMACSHA256(t *testing.T) {
	local := bytes.Repeat([]byte{7}, innerMaterialSize)
	peer := bytes.Repeat([]byte{9}, innerMaterialSize)
	tag := innerTag("psk", local, peer)
	if len(tag) != innerTagSize {
		t.Fatalf("tag length %d", len(tag))
	}
	key := sha256.Sum256([]byte("forwardx-v3 inner handshake\x00psk"))
	mac := hmac.New(sha256.New, key[:])
	mac.Write(local)
	mac.Write(peer)
	if !hmac.Equal(tag, mac.Sum(nil)[:innerTagSize]) {
		t.Fatal("tag construction drifted from HMAC-SHA256")
	}
	// The first message is exactly the reference's 17 bytes.
	if InnerHandshakeSize != 17 {
		t.Fatalf("handshake size changed: %d", InnerHandshakeSize)
	}
	// Swapping the materials must change the tag, so the two directions cannot
	// accept each other's proof.
	if hmac.Equal(innerTag("psk", local, peer), innerTag("psk", peer, local)) {
		t.Fatal("tag is symmetric in the two materials")
	}
}

func TestInnerDeadlinesPropagateToUnderlyingConn(t *testing.T) {
	client, _ := innerPair(t, "psk")
	if err := client.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1)
	if _, err := client.Read(buf); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("read deadline not honoured: %v", err)
	}
}
