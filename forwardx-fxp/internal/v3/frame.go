// Package v3 contains independently tested V3 wire primitives. Panel/Agent
// exposure remains disabled until session lifecycle and integration are complete.
package v3

import (
	"encoding/binary"
	"errors"
	"io"
)

const (
	FrameOpen    byte = 1
	FrameData    byte = 2
	FrameClose   byte = 3
	FramePadding byte = 4
	// Type 5 exists in the reference. Its lifecycle semantics are not yet
	// verified, so the codec preserves it without assigning it an operation.
	FrameType5 byte = 5
	MaxPayload      = 1<<16 - 1
	HeaderSize      = 7
)

var ErrFrameTooLarge = errors.New("v3: frame payload exceeds uint16 length")
var ErrFrameType = errors.New("v3: unsupported frame type")

type Frame struct {
	Type     byte
	StreamID uint32
	Payload  []byte
}

// ReadFrame reads precisely one frame, including zero-length control frames.
// A padded open/close is two frames, not one extended control header.
func ReadFrame(r io.Reader) (Frame, error) {
	var header [HeaderSize]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return Frame{}, err
	}
	f := Frame{Type: header[0], StreamID: binary.BigEndian.Uint32(header[1:5])}
	if f.Type < FrameOpen || f.Type > FrameType5 {
		return Frame{}, ErrFrameType
	}
	n := int(binary.BigEndian.Uint16(header[5:7]))
	if n > 0 {
		f.Payload = make([]byte, n)
		if _, err := io.ReadFull(r, f.Payload); err != nil {
			return Frame{}, err
		}
	}
	return f, nil
}

// WriteFrame must be serialized by the session writer. The codec itself owns
// no session state and does not retain payloads or create goroutines.
func WriteFrame(w io.Writer, f Frame) error {
	if f.Type < FrameOpen || f.Type > FrameType5 {
		return ErrFrameType
	}
	if len(f.Payload) > MaxPayload {
		return ErrFrameTooLarge
	}
	var header [HeaderSize]byte
	header[0] = f.Type
	binary.BigEndian.PutUint32(header[1:5], f.StreamID)
	binary.BigEndian.PutUint16(header[5:7], uint16(len(f.Payload)))
	if err := writeFull(w, header[:]); err != nil {
		return err
	}
	return writeFull(w, f.Payload)
}

// WritePaddedControl reproduces the inspected control + separate padding
// layout (0xccb120), not an extended control frame. Padding bytes are zero.
func WritePaddedControl(w io.Writer, kind byte, id uint32, total int) error {
	if (kind != FrameOpen && kind != FrameClose) || total < 2*HeaderSize || total > MaxPayload+2*HeaderSize {
		return errors.New("v3: invalid padded control")
	}
	buf := make([]byte, total)
	buf[0] = kind
	binary.BigEndian.PutUint32(buf[1:5], id)
	buf[HeaderSize] = FramePadding
	binary.BigEndian.PutUint16(buf[HeaderSize+5:HeaderSize+7], uint16(total-2*HeaderSize))
	return writeFull(w, buf)
}

func writeFull(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if n < 0 || n > len(p) {
			return io.ErrShortWrite
		}
		p = p[n:]
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}
