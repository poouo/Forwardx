package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// An in-memory wire keeps network scheduling out of the allocation benchmark.
type frameTestConn struct {
	net.Conn
	bytes.Buffer
}

func (c *frameTestConn) Read(p []byte) (int, error)  { return c.Buffer.Read(p) }
func (c *frameTestConn) Write(p []byte) (int, error) { return c.Buffer.Write(p) }

func frameTestPair(t testing.TB) (*secureConn, *secureConn, *frameTestConn) {
	t.Helper()
	wire := &frameTestConn{}
	salt := bytes.Repeat([]byte{0x3e}, fxpSaltSize)
	writer, err := newSessionSecureConn(wire, "frame-reader-test", salt, true)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := newSessionSecureConn(wire, "frame-reader-test", salt, false)
	if err != nil {
		t.Fatal(err)
	}
	return writer, reader, wire
}

func BenchmarkV1ReadFrameOwned(b *testing.B) {
	writer, reader, wire := frameTestPair(b)
	payload := bytes.Repeat([]byte{0x42}, 32*1024)
	if err := writer.writeFrame(payload); err != nil {
		b.Fatal(err)
	}
	record := bytes.Clone(wire.Bytes())
	b.ReportAllocs()
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		wire.Buffer = *bytes.NewBuffer(record)
		reader.readCounter = 0
		frame, err := reader.readFrame()
		if err != nil || len(frame) != len(payload) {
			b.Fatalf("read: len=%d err=%v", len(frame), err)
		}
	}
}

func BenchmarkV1ReadFrameBorrowed(b *testing.B) {
	writer, reader, wire := frameTestPair(b)
	payload := bytes.Repeat([]byte{0x42}, 32*1024)
	if err := writer.writeFrame(payload); err != nil {
		b.Fatal(err)
	}
	record := bytes.Clone(wire.Bytes())
	r := &secureFrameReader{conn: reader}
	defer r.release()
	b.ReportAllocs()
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		wire.Buffer = *bytes.NewBuffer(record)
		reader.readCounter = 0
		frame, err := r.readFrame()
		if err != nil || len(frame) != len(payload) {
			b.Fatalf("read: len=%d err=%v", len(frame), err)
		}
	}
}

func TestBorrowedFramesPreserveWireContextsAndOwnedFrames(t *testing.T) {
	for _, context := range fxpWireContexts {
		for _, client := range []bool{true, false} {
			name := context.name + "/entry-to-exit"
			if !client {
				name = context.name + "/exit-to-entry"
			}
			t.Run(name, func(t *testing.T) {
				wire := &frameTestConn{}
				salt := bytes.Repeat([]byte{0x3e}, fxpSaltSize)
				writer, err := newSessionSecureConnWithWire(wire, "test", salt, client, context)
				if err != nil {
					t.Fatal(err)
				}
				reader, err := newSessionSecureConnWithWire(wire, "test", salt, !client, context)
				if err != nil {
					t.Fatal(err)
				}
				payloads := [][]byte{[]byte("owned hello"), bytes.Repeat([]byte{0x42}, 32*1024), bytes.Repeat([]byte{0x73}, 200*1024), []byte("small"), nil}
				for _, p := range payloads {
					if err := writer.writeFrame(p); err != nil {
						t.Fatal(err)
					}
				}
				owned, err := reader.readFrame()
				if err != nil {
					t.Fatal(err)
				}
				r := &secureFrameReader{conn: reader}
				defer r.release()
				for i, want := range payloads[1:] {
					got, err := r.readFrame()
					if err != nil || !bytes.Equal(got, want) {
						t.Fatalf("frame %d: len=%d err=%v", i, len(got), err)
					}
				}
				if !bytes.Equal(owned, payloads[0]) {
					t.Fatal("borrowed frame overwrote owned handshake storage")
				}
				if _, err := r.readFrame(); !errors.Is(err, io.EOF) || r.buffer != nil {
					t.Fatalf("EOF did not release buffer: %v", err)
				}
				r.release() // Idempotent, including after a zero-length frame.
			})
		}
	}
}

func TestBorrowedFramesRejectInvalidInput(t *testing.T) {
	for _, test := range []string{"header-auth", "body-auth", "header-truncated", "body-truncated", "read-limit", "global-limit", "replay"} {
		t.Run(test, func(t *testing.T) {
			writer, reader, wire := frameTestPair(t)
			if err := writer.writeFrame([]byte("authenticated payload")); err != nil {
				t.Fatal(err)
			}
			record := bytes.Clone(wire.Bytes())
			switch test {
			case "header-auth":
				record[0] ^= 1
			case "body-auth":
				record[len(record)-1] ^= 1
			case "header-truncated":
				record = record[:3]
			case "body-truncated":
				record = record[:len(record)-1]
			case "read-limit":
				reader.maxReadFrame = 5
			case "global-limit":
				var length [4]byte
				binary.BigEndian.PutUint32(length[:], fxpMaxFrame+1)
				record = writer.lenWriteAEAD.Seal(nil, fxpNonce(writer.writeDir, 0, 0), length[:], writer.lengthAD)
			case "replay":
				reader.readCounter = 1
			}
			wire.Buffer = *bytes.NewBuffer(record)
			r := &secureFrameReader{conn: reader}
			defer r.release()
			frame, err := r.readFrame()
			if err == nil || frame != nil || r.buffer != nil {
				t.Fatalf("invalid frame exposed data or retained storage: len=%d err=%v", len(frame), err)
			}
			if test == "read-limit" && wire.Len() != len(record)-(4+reader.lenReadAEAD.Overhead()) {
				t.Fatal("read body before checking authenticated size limit")
			}
		})
	}
}

type observedFrameReadConn struct {
	net.Conn
	beforeRead func()
}

func (c *observedFrameReadConn) Read(p []byte) (int, error) {
	c.beforeRead()
	return c.Conn.Read(p)
}

func TestBorrowedFrameReleasedBeforeWaitingForNextHeader(t *testing.T) {
	writer, reader, _ := frameTestPair(t)
	if err := writer.writeFrame(bytes.Repeat([]byte{1}, 32*1024)); err != nil {
		t.Fatal(err)
	}
	r := &secureFrameReader{conn: reader}
	defer r.release()
	if _, err := r.readFrame(); err != nil {
		t.Fatal(err)
	}
	if r.buffer == nil {
		t.Fatal("test did not acquire storage")
	}
	reader.conn = &observedFrameReadConn{Conn: reader.conn, beforeRead: func() {
		if r.buffer != nil {
			t.Fatal("idle read retained the previous frame buffer")
		}
	}}
	if _, err := r.readFrame(); !errors.Is(err, io.EOF) {
		t.Fatalf("expected EOF: %v", err)
	}
}

func TestBorrowedFrameCopyPreservesTraffic(t *testing.T) {
	writer, reader, _ := frameTestPair(t)
	want := bytes.Repeat([]byte("test payload"), 4096)
	for _, frame := range [][]byte{want[:100], want[100:], nil} {
		if err := writer.writeFrame(frame); err != nil {
			t.Fatal(err)
		}
	}
	out := &frameTestConn{}
	var counter atomic.Uint64
	if err := copySecureToPlain(out, reader, nil, &counter); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out.Bytes(), want) || counter.Load() != uint64(len(want)) {
		t.Fatalf("copy mismatch: bytes=%d counter=%d", out.Len(), counter.Load())
	}
}

// Reject any client pre-read before the downstream listener accepts. This
// verifies server-first setup without relying on a fragile <150ms timing test.
type serverFirstEntryConn struct {
	net.Conn
	accepted <-chan struct{}
}

func (c *serverFirstEntryConn) Read(p []byte) (int, error) {
	select {
	case <-c.accepted:
		return c.Conn.Read(p)
	default:
		return 0, errors.New("client pre-read before downstream connection")
	}
}

func TestV1EntryServerFirstWithoutClientPreread(t *testing.T) {
	accepted := make(chan struct{})
	exitResult := make(chan error, 1)
	cfg := config{Key: "server-first-test", TunnelID: 27, TargetIP: "127.0.0.1", TargetPort: 80}
	port, _ := v3TestListener(t, func(conn net.Conn) {
		close(accepted)
		sec, err := newServerSecureConn(conn, cfg)
		if err == nil {
			_, err = readSecureHello(sec)
		}
		if err == nil {
			err = sec.writeFrame([]byte("server greeting"))
		}
		if err == nil {
			var frame []byte
			frame, err = sec.readFrame()
			if err == nil && string(frame) != "client reply" {
				err = errors.New("incorrect client reply")
			}
		}
		if err == nil {
			var frame []byte
			frame, err = sec.readFrame()
			if err == nil && len(frame) != 0 {
				err = errors.New("missing client half-close")
			}
		}
		if err == nil {
			err = sec.writeFrame([]byte("final response"))
		}
		if err == nil {
			err = sec.writeFrame(nil)
		}
		exitResult <- err
	})
	cfg.ExitHost, cfg.ExitPort = "127.0.0.1", port
	selector := newExitEndpointSelector(nil, exitEndpoint{Host: cfg.ExitHost, Port: port, Key: cfg.Key}, "")
	client, entry := v3TestTCPPair(t)
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	entryResult := make(chan error, 1)
	go func() {
		entryResult <- handleEntryTCP(&serverFirstEntryConn{Conn: entry, accepted: accepted}, cfg, selector, nil, nil)
	}()
	greeting := make([]byte, len("server greeting"))
	if _, err := io.ReadFull(client, greeting); err != nil || string(greeting) != "server greeting" {
		t.Fatalf("server-first greeting: %q, %v", greeting, err)
	}
	if _, err := client.Write([]byte("client reply")); err != nil {
		t.Fatal(err)
	}
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(client)
	if err != nil || string(response) != "final response" {
		t.Fatalf("half-close response: %q, %v", response, err)
	}
	for name, result := range map[string]<-chan error{"entry": entryResult, "exit": exitResult} {
		select {
		case err := <-result:
			if err != nil {
				t.Fatalf("%s failed: %v", name, err)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("%s did not stop", name)
		}
	}
}

func TestV1EntryStillBlocksHTTPWithoutPreread(t *testing.T) {
	cfg := config{Key: "blocked-protocol-test", TunnelID: 28, TargetIP: "127.0.0.1", TargetPort: 80, BlockHTTP: true}
	exitResult := make(chan error, 1)
	port, _ := v3TestListener(t, func(conn net.Conn) {
		sec, err := newServerSecureConn(conn, cfg)
		if err == nil {
			_, err = readSecureHello(sec)
		}
		if err == nil {
			frame, readErr := sec.readFrame()
			if len(frame) > 0 || readErr == nil {
				err = errors.New("blocked payload reached downstream")
			} else if !isClosedErr(readErr) {
				err = readErr
			}
		}
		exitResult <- err
	})
	cfg.ExitHost, cfg.ExitPort = "127.0.0.1", port
	selector := newExitEndpointSelector(nil, exitEndpoint{Host: cfg.ExitHost, Port: port, Key: cfg.Key}, "")
	client, entry := v3TestTCPPair(t)
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	entryResult := make(chan error, 1)
	go func() { entryResult <- handleEntryTCP(entry, cfg, selector, nil, nil) }()
	if _, err := client.Write([]byte("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-entryResult:
		if err == nil || !strings.Contains(err.Error(), "protocol blocked") {
			t.Fatalf("HTTP was not blocked: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("blocked entry did not stop")
	}
	select {
	case err := <-exitResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("downstream did not close after protocol block")
	}
}
