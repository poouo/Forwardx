package v3

import (
	"bytes"
	"encoding/hex"
	"errors"
	"io"
	"testing"
)

func TestFrameGolden(t *testing.T) {
	// Independently transcribed from nJFDVL4: type, BE stream ID, BE length.
	want, _ := hex.DecodeString("02123456780003616263")
	var b bytes.Buffer
	if err := WriteFrame(&b, Frame{FrameData, 0x12345678, []byte("abc")}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b.Bytes(), want) {
		t.Fatalf("wire=%x want=%x", b.Bytes(), want)
	}
	f, err := ReadFrame(bytes.NewReader(want))
	if err != nil || f.Type != FrameData || f.StreamID != 0x12345678 || string(f.Payload) != "abc" {
		t.Fatalf("frame=%+v err=%v", f, err)
	}
}

func TestPaddedControlIsTwoFrames(t *testing.T) {
	// zqw3lYT1IdS allocates 26 zeroed bytes for close, sets type 3 at 0,
	// type 4 at 7, and BE length 26-14 at 12. It is not a 19-byte close.
	wire, _ := hex.DecodeString("030000000100000400000000000c000000000000000000000000")
	var encoded bytes.Buffer
	if err := WritePaddedControl(&encoded, FrameClose, 1, 26); err != nil || !bytes.Equal(encoded.Bytes(), wire) {
		t.Fatalf("padded control bytes=%x err=%v", encoded.Bytes(), err)
	}
	r := bytes.NewReader(wire)
	f, err := ReadFrame(r)
	if err != nil || f.Type != FrameClose || f.StreamID != 1 || len(f.Payload) != 0 {
		t.Fatalf("close=%+v err=%v", f, err)
	}
	f, err = ReadFrame(r)
	if err != nil || f.Type != FramePadding || f.StreamID != 0 || len(f.Payload) != 12 || r.Len() != 0 {
		t.Fatalf("padding=%+v err=%v remaining=%d", f, err, r.Len())
	}
}

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return w.Buffer.Write(p)
}

type zeroWriter struct{}

func (zeroWriter) Write([]byte) (int, error) { return 0, nil }

func TestFrameBoundsAndShortIO(t *testing.T) {
	w := &shortWriter{}
	if err := WriteFrame(w, Frame{FrameData, 7, bytes.Repeat([]byte{1}, MaxPayload)}); err != nil {
		t.Fatal(err)
	}
	if f, err := ReadFrame(&w.Buffer); err != nil || len(f.Payload) != MaxPayload {
		t.Fatalf("length=%d err=%v", len(f.Payload), err)
	}
	if err := WriteFrame(io.Discard, Frame{FrameData, 7, make([]byte, MaxPayload+1)}); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatal(err)
	}
	if err := WriteFrame(zeroWriter{}, Frame{Type: FrameOpen}); !errors.Is(err, io.ErrShortWrite) {
		t.Fatal(err)
	}
	for n := 0; n < 10; n++ {
		wire := []byte{2, 0, 0, 0, 1, 0, 3, 'a', 'b', 'c'}[:n]
		if _, err := ReadFrame(bytes.NewReader(wire)); err == nil {
			t.Fatalf("truncated frame accepted: %x", wire)
		}
	}
	if _, err := ReadFrame(bytes.NewReader(make([]byte, 7))); !errors.Is(err, ErrFrameType) {
		t.Fatal(err)
	}
}

func FuzzFrameRoundTrip(f *testing.F) {
	f.Add(uint8(2), uint32(42), []byte("payload"))
	f.Add(uint8(1), uint32(0), []byte{})
	f.Fuzz(func(t *testing.T, kind uint8, id uint32, payload []byte) {
		if len(payload) > MaxPayload {
			t.Skip()
		}
		kind = kind%5 + 1
		var b bytes.Buffer
		if err := WriteFrame(&b, Frame{kind, id, payload}); err != nil {
			t.Fatal(err)
		}
		got, err := ReadFrame(&b)
		if err != nil || got.Type != kind || got.StreamID != id || !bytes.Equal(got.Payload, payload) {
			t.Fatalf("round trip mismatch: %+v %v", got, err)
		}
	})
}
