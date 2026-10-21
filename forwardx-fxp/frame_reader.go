package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// secureFrameReader borrows pooled storage for synchronous forwarding. Frames
// are valid only until the next readFrame or release; callers that retain frames
// (including handshakes) must keep using secureConn.readFrame instead.
// Like secureConn.readFrame, it must have only one reader per connection.
type secureFrameReader struct {
	conn      *secureConn
	buffer    []byte
	lenCipher [64]byte
	lenPlain  [4]byte
	nonce     [12]byte
}

func (r *secureFrameReader) release() {
	putFXPByteBuffer(r.buffer)
	r.buffer = nil
}

func (r *secureFrameReader) readFrame() ([]byte, error) {
	// Return the previous frame before waiting for the next header. Idle
	// connections must not retain one large pooled buffer each.
	r.release()
	c := r.conn
	if c.logicalFrames {
		return c.readV3LogicalFrame()
	}
	counter := c.readCounter
	c.readCounter++
	lenSize := 4 + c.lenReadAEAD.Overhead()
	if lenSize > len(r.lenCipher) {
		return nil, errors.New("invalid encrypted frame length")
	}
	if _, err := io.ReadFull(c.conn, r.lenCipher[:lenSize]); err != nil {
		return nil, err
	}
	fillFXPNonce(r.nonce[:], c.readDir, counter, 0)
	plain, err := c.lenReadAEAD.Open(r.lenPlain[:0], r.nonce[:], r.lenCipher[:lenSize], c.lengthAD)
	if err != nil {
		return nil, err
	}
	if len(plain) != 4 {
		return nil, errors.New("invalid frame length")
	}
	n := binary.BigEndian.Uint32(plain)
	if n > fxpMaxFrame || (c.maxReadFrame > 0 && n > c.maxReadFrame) {
		return nil, fmt.Errorf("invalid frame size %d", n)
	}
	// Authenticate the length before borrowing storage, then decrypt the body
	// in place. No plaintext is exposed if authentication fails.
	r.buffer = getFXPByteBuffer(int(n) + c.dataReadAEAD.Overhead())
	if _, err := io.ReadFull(c.conn, r.buffer); err != nil {
		r.release()
		return nil, err
	}
	fillFXPNonce(r.nonce[:], c.readDir, counter, 1)
	frame, err := c.dataReadAEAD.Open(r.buffer[:0], r.nonce[:], r.buffer, c.payloadAD)
	if err != nil {
		r.release()
		return nil, err
	}
	return frame, nil
}
