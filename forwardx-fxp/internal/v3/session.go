package v3

// The frame layout follows the inspected reference. Authentication, resource
// limits, deadlines and session lifetime are ForwardX policies, not claims of
// interoperability with the reference's private protocol.
import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"net"
	"os"
	"sync"
	"time"
)

var (
	ErrStreamLimit    = errors.New("v3: stream limit reached")
	ErrWindowExceeded = errors.New("v3: peer exceeded receive window")
	ErrDraining       = errors.New("v3: session is draining")
	ErrIdle           = errors.New("v3: idle session expired")
)

// dataChunk is the largest business payload carried by one DATA frame. It must
// leave room for the 7-byte multiplex header inside the inner record limit
// (InnerPayloadLimit), otherwise a full-size frame could not be sealed.
const dataChunk = InnerPayloadLimit - HeaderSize

// DefaultWriteTimeout bounds one physical write. It is exported so callers can
// derive health thresholds from it instead of hardcoding a second number.
const DefaultWriteTimeout = 10 * time.Second

// ForwardX-only, encrypted DATA contents. These are not reference protocol
// semantics: tag 0 carries stream bytes, tag 1 grants a bounded receive window.
const streamBytes byte = 0
const streamCredit byte = 1

type SessionOptions struct {
	Client        bool
	MaxStreams    int
	StreamBuffer  int
	SessionBuffer int
	IdleTimeout   time.Duration
	WriteTimeout  time.Duration
}

type writeRequest struct {
	frame  Frame
	stream *Stream
	result chan error
}

// Session owns exactly three goroutines, irrespective of the stream count.
// Per-stream credit backpressures a slow consumer without blocking siblings.
type Session struct {
	conn         net.Conn
	opts         SessionOptions
	mu           sync.Mutex
	openMu       sync.Mutex
	streams      map[uint32]*Stream
	nextID       uint32
	lastRemoteID uint32
	buffered     int
	idleSince    time.Time
	// lastWrite is the time of the last successful physical write. A session
	// whose peer went away silently keeps reporting free slots because nothing
	// fails until the next write, so the pool uses this to avoid handing new
	// business streams to a session that has not proven itself recently.
	lastWrite  time.Time
	draining   bool
	err        error
	done       chan struct{}
	accept     chan *Stream
	writes     chan writeRequest
	controls   chan Frame
	creditWake chan struct{}
	wg         sync.WaitGroup
}

func NewSession(conn net.Conn, opts SessionOptions) *Session {
	if opts.MaxStreams <= 0 || opts.MaxStreams > 128 {
		opts.MaxStreams = 128
	}
	if opts.StreamBuffer <= 0 || opts.StreamBuffer > 256*1024 {
		opts.StreamBuffer = 64 * 1024
	}
	if opts.SessionBuffer <= 0 || opts.SessionBuffer > 8*1024*1024 {
		opts.SessionBuffer = 8 * 1024 * 1024
	}
	if opts.SessionBuffer < opts.MaxStreams {
		opts.MaxStreams = opts.SessionBuffer
	}
	// Advertised windows, even when all streams stall, fit the aggregate cap.
	if max := opts.SessionBuffer / opts.MaxStreams; opts.StreamBuffer > max {
		opts.StreamBuffer = max
	}
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = 30 * time.Second
	}
	if opts.WriteTimeout <= 0 {
		opts.WriteTimeout = DefaultWriteTimeout
	}
	s := &Session{conn: conn, opts: opts, streams: make(map[uint32]*Stream), nextID: 1,
		idleSince: time.Now(), lastWrite: time.Now(), done: make(chan struct{}),
		accept: make(chan *Stream, opts.MaxStreams),
		writes: make(chan writeRequest, 32), controls: make(chan Frame, 128), creditWake: make(chan struct{}, 1)}
	s.wg.Add(3)
	go func() { defer s.wg.Done(); s.readLoop() }()
	go func() { defer s.wg.Done(); s.writeLoop() }()
	go func() { defer s.wg.Done(); s.idleLoop() }()
	return s
}

func (s *Session) Done() <-chan struct{} { return s.done }
func (s *Session) Wait()                 { s.wg.Wait() }
func (s *Session) Err() error            { s.mu.Lock(); defer s.mu.Unlock(); return s.err }
func (s *Session) ActiveStreams() int    { s.mu.Lock(); defer s.mu.Unlock(); return len(s.streams) }
func (s *Session) BufferedBytes() int    { s.mu.Lock(); defer s.mu.Unlock(); return s.buffered }

// LastWrite reports when this session last completed a physical write.
func (s *Session) LastWrite() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastWrite
}

// Alive reports whether the session is usable and has proven itself within
// maxAge. A session whose peer vanished without closing the socket still reports
// free slots, so the pool must not treat slot count alone as health.
func (s *Session) Alive(maxAge time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil || s.draining {
		return false
	}
	if maxAge <= 0 {
		return true
	}
	return time.Since(s.lastWrite) <= maxAge
}

// AgeLastWrite rewinds the recorded successful-write time. It exists so callers
// outside this package can exercise the half-open session path, where nothing has
// failed yet but the peer has not proven itself recently.
func (s *Session) AgeLastWrite(d time.Duration) {
	s.mu.Lock()
	s.lastWrite = time.Now().Add(-d)
	s.mu.Unlock()
}

// OpenSlots reports free stream slots. Callers that select a session for new
// business traffic should combine this with Alive.
func (s *Session) OpenSlots() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil || s.draining {
		return 0
	}
	return s.opts.MaxStreams - len(s.streams)
}
func (s *Session) Close() error { s.fail(net.ErrClosed); return nil }

func (s *Session) fail(err error) {
	s.mu.Lock()
	if s.err != nil {
		s.mu.Unlock()
		return
	}
	s.err = err
	close(s.done)
	for _, st := range s.streams {
		s.finishLocked(st, err)
	}
	s.mu.Unlock()
	_ = s.conn.Close()
}

// Drain refuses new streams without interrupting existing business sessions.
func (s *Session) Drain() {
	s.mu.Lock()
	s.draining = true
	empty := len(s.streams) == 0
	s.mu.Unlock()
	if empty {
		s.fail(ErrDraining)
	}
}

func (s *Session) newStreamLocked(id uint32) *Stream {
	st := &Stream{session: s, id: id, changed: make(chan struct{}), creditDue: s.opts.StreamBuffer}
	s.streams[id] = st
	s.idleSince = time.Time{}
	return st
}

func (s *Session) Open() (*Stream, error) {
	// IDs must reach the wire in allocation order, including concurrent opens.
	s.openMu.Lock()
	defer s.openMu.Unlock()
	s.mu.Lock()
	if s.err != nil {
		err := s.err
		s.mu.Unlock()
		return nil, err
	}
	if !s.opts.Client || s.draining {
		s.mu.Unlock()
		return nil, ErrDraining
	}
	if len(s.streams) >= s.opts.MaxStreams {
		s.mu.Unlock()
		return nil, ErrStreamLimit
	}
	if s.nextID == 0 {
		s.draining = true
		s.mu.Unlock()
		return nil, ErrDraining
	}
	st := s.newStreamLocked(s.nextID)
	s.nextID++
	s.mu.Unlock()
	if err := st.send(Frame{Type: FrameOpen, StreamID: st.id}); err != nil {
		_ = st.Close()
		return nil, err
	}
	s.mu.Lock()
	st.announced = true
	s.wakeCreditLocked()
	s.mu.Unlock()
	return st, nil
}

func (s *Session) wakeCreditLocked() {
	select {
	case s.creditWake <- struct{}{}:
	default:
	}
}

func (s *Session) nextCredit() (Frame, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, st := range s.streams {
		if st.announced && !st.remoteEOF && st.err == nil && st.creditDue > 0 {
			payload := make([]byte, 5)
			payload[0] = streamCredit
			binary.BigEndian.PutUint32(payload[1:], uint32(st.creditDue))
			st.receiveCredit += st.creditDue
			st.creditDue = 0
			s.wakeCreditLocked() // One bounded wake covers all other pending grants.
			return Frame{Type: FrameData, StreamID: st.id, Payload: payload}, true
		}
	}
	return Frame{}, false
}

func (s *Session) Accept() (*Stream, error) {
	for {
		select {
		case <-s.done:
			return nil, s.Err()
		case st := <-s.accept:
			s.mu.Lock()
			live := st.err == nil && s.err == nil
			s.mu.Unlock()
			if live {
				return st, nil
			}
		}
	}
}

// control queues one session-level control frame. A full control queue must not
// tear the session down: the old behaviour failed the whole physical session
// (and every sibling stream) once 128 close frames piled up behind a slow
// physical write. Instead the producer waits for room, bounded by the session
// lifetime, so a burst of stream closes becomes backpressure rather than an
// outage. Callers that cannot afford to block use tryControl.
func (s *Session) control(f Frame) {
	select {
	case <-s.done:
	case s.controls <- f:
	}
}

// tryControl queues a control frame without blocking. It reports whether the
// frame was queued, so a caller can decide to retry or drop it.
func (s *Session) tryControl(f Frame) bool {
	select {
	case <-s.done:
		return false
	case s.controls <- f:
		return true
	default:
		return false
	}
}

func (s *Session) finishLocked(st *Stream, err error) {
	if st.err != nil {
		return
	}
	st.err = err
	s.buffered -= st.buffered
	st.buffered = 0
	st.buffers = nil
	delete(s.streams, st.id)
	if len(s.streams) == 0 {
		s.idleSince = time.Now()
	}
	st.signalLocked()
}

func (s *Session) readLoop() {
	for {
		f, err := ReadFrame(s.conn)
		if err != nil {
			s.fail(err)
			return
		}
		if f.Type == FramePadding {
			continue
		}
		// Type 5 has no verified lifecycle meaning and is deliberately not sent
		// or interpreted by ForwardX. Fail closed instead of guessing semantics.
		if f.Type == FrameType5 || f.StreamID == 0 || ((f.Type == FrameOpen || f.Type == FrameClose) && len(f.Payload) != 0) {
			s.fail(errors.New("v3: invalid session control"))
			return
		}
		s.mu.Lock()
		if s.err != nil {
			s.mu.Unlock()
			return
		}
		st := s.streams[f.StreamID]
		closeStream := false
		switch f.Type {
		case FrameOpen:
			if s.opts.Client || f.StreamID <= s.lastRemoteID {
				s.mu.Unlock()
				s.fail(errors.New("v3: invalid stream ID"))
				return
			}
			s.lastRemoteID = f.StreamID
			if s.draining || len(s.streams) >= s.opts.MaxStreams {
				closeStream = true
			} else {
				st = s.newStreamLocked(f.StreamID)
				st.announced = true
				s.wakeCreditLocked()
				select {
				case s.accept <- st:
				default:
					s.finishLocked(st, ErrStreamLimit)
					closeStream = true
				}
			}
		case FrameData:
			if st == nil || st.remoteEOF {
				break
			} // In-flight data after a local close is harmless.
			if len(f.Payload) == 5 && f.Payload[0] == streamCredit {
				credit := int(binary.BigEndian.Uint32(f.Payload[1:]))
				if st.remoteWindow == 0 && credit > 0 && credit <= 256*1024 {
					st.remoteWindow = credit
				}
				if credit <= 0 || st.remoteWindow == 0 || credit > st.remoteWindow-st.sendCredit {
					s.finishLocked(st, errors.New("v3: invalid credit grant"))
					closeStream = true
				} else {
					st.sendCredit += credit
					st.signalLocked()
				}
				break
			}
			if len(f.Payload) < 2 || f.Payload[0] != streamBytes {
				s.finishLocked(st, errors.New("v3: invalid stream data"))
				closeStream = true
				break
			}
			f.Payload = f.Payload[1:]
			if len(f.Payload) > 0 {
				if len(f.Payload) > st.receiveCredit || st.buffered+len(f.Payload) > s.opts.StreamBuffer || s.buffered+len(f.Payload) > s.opts.SessionBuffer {
					s.finishLocked(st, ErrWindowExceeded)
					closeStream = true
				} else {
					st.receiveCredit -= len(f.Payload)
					last := len(st.buffers) - 1
					if last >= 0 && len(st.buffers[last])+len(f.Payload) <= dataChunk {
						st.buffers[last] = append(st.buffers[last], f.Payload...)
					} else {
						st.buffers = append(st.buffers, f.Payload)
					}
					st.buffered += len(f.Payload)
					s.buffered += len(f.Payload)
					st.signalLocked()
				}
			}
		case FrameClose:
			if st != nil {
				// Keep the slot until Read reaches EOF or the owner calls Close.
				// This also bounds unaccepted, closed streams with unread buffers.
				st.remoteEOF = true
				st.signalLocked()
			}
		}
		drained := s.draining && len(s.streams) == 0
		s.mu.Unlock()
		if closeStream {
			s.control(Frame{Type: FrameClose, StreamID: f.StreamID})
		}
		if drained {
			s.fail(ErrDraining)
			return
		}
	}
}

func (s *Session) writeLoop() {
	// Control frames are drained first when both queues have work, but the
	// writer no longer gives them absolute priority: an unbounded run of control
	// frames used to starve DATA frames of every sibling stream.
	for {
		var req writeRequest
		select {
		case <-s.done:
			return
		default:
		}
		select {
		case req.frame = <-s.controls:
		default:
			select {
			case <-s.done:
				return
			case req.frame = <-s.controls:
			case req = <-s.writes:
			case <-s.creditWake:
				var ok bool
				req.frame, ok = s.nextCredit()
				if !ok {
					continue
				}
			}
		}
		if req.stream != nil {
			s.mu.Lock()
			err := req.stream.writeErrorLocked()
			s.mu.Unlock()
			if err != nil {
				req.result <- err
				continue
			}
		}
		err := s.conn.SetWriteDeadline(time.Now().Add(s.opts.WriteTimeout))
		if err == nil {
			switch req.frame.Type {
			case FrameOpen:
				// Static inspection of 0xa0bd20: crypto/rand.Int(max-min)+min.
				// OpenStream passes (20,100), so the upper endpoint is exclusive.
				n, randomErr := rand.Int(rand.Reader, big.NewInt(80))
				if randomErr != nil {
					err = randomErr
				} else {
					err = WritePaddedControl(s.conn, FrameOpen, req.frame.StreamID, 20+int(n.Int64()))
				}
			case FrameClose:
				err = WritePaddedControl(s.conn, FrameClose, req.frame.StreamID, 26)
			default:
				err = WriteFrame(s.conn, req.frame)
			}
		}
		if err == nil {
			s.mu.Lock()
			s.lastWrite = time.Now()
			s.mu.Unlock()
		}
		if req.result != nil {
			req.result <- err
		}
		if err != nil {
			s.fail(err)
			return
		}
	}
}

func (s *Session) idleLoop() {
	interval := s.opts.IdleTimeout / 2
	if interval > time.Second {
		interval = time.Second
	}
	if interval < time.Millisecond {
		interval = time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.mu.Lock()
			idle := len(s.streams) == 0 && time.Since(s.idleSince) >= s.opts.IdleTimeout
			s.mu.Unlock()
			if idle {
				s.fail(ErrIdle)
				return
			}
		}
	}
}

// Stream is a bounded net.Conn. Close closes the whole logical stream (type 3).
// Business half-close is carried inside the stream by the existing FXP EOF
// record; no unverified extension of the reference frame types is introduced.
type Stream struct {
	session                     *Session
	id                          uint32
	writeMu                     sync.Mutex
	buffers                     [][]byte
	buffered                    int
	err                         error
	remoteEOF                   bool
	announced                   bool
	sendCredit, remoteWindow    int
	receiveCredit, creditDue    int
	readDeadline, writeDeadline time.Time
	changed                     chan struct{}
}

func (st *Stream) signalLocked() { close(st.changed); st.changed = make(chan struct{}) }
func (st *Stream) writeErrorLocked() error {
	if st.err != nil {
		return st.err
	}
	if st.remoteEOF {
		return io.ErrClosedPipe
	}
	if st.session.err != nil {
		return st.session.err
	}
	if !st.writeDeadline.IsZero() && !time.Now().Before(st.writeDeadline) {
		return os.ErrDeadlineExceeded
	}
	return nil
}

func waitChange(ch, done <-chan struct{}, deadline time.Time, result <-chan error) error {
	var timeout <-chan time.Time
	var timer *time.Timer
	if !deadline.IsZero() {
		timer = time.NewTimer(time.Until(deadline))
		timeout = timer.C
		defer timer.Stop()
	}
	select {
	case err := <-result:
		return err
	case <-ch:
		return nil
	case <-done:
		return net.ErrClosed
	case <-timeout:
		return os.ErrDeadlineExceeded
	}
}

func (st *Stream) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	s := st.session
	for {
		s.mu.Lock()
		if st.err != nil {
			err := st.err
			s.mu.Unlock()
			return 0, err
		}
		if !st.readDeadline.IsZero() && !time.Now().Before(st.readDeadline) {
			s.mu.Unlock()
			return 0, os.ErrDeadlineExceeded
		}
		if len(st.buffers) > 0 {
			n := copy(p, st.buffers[0])
			st.buffers[0] = st.buffers[0][n:]
			st.buffered -= n
			s.buffered -= n
			st.creditDue += n
			s.wakeCreditLocked()
			if len(st.buffers[0]) == 0 {
				st.buffers[0] = nil
				st.buffers = st.buffers[1:]
			}
			s.mu.Unlock()
			return n, nil
		}
		if st.remoteEOF {
			s.finishLocked(st, io.EOF)
			drained := s.draining && len(s.streams) == 0
			s.mu.Unlock()
			if drained {
				s.fail(ErrDraining)
			}
			return 0, io.EOF
		}
		if s.err != nil {
			err := s.err
			s.mu.Unlock()
			return 0, err
		}
		ch, deadline := st.changed, st.readDeadline
		s.mu.Unlock()
		if err := waitChange(ch, s.done, deadline, nil); err != nil {
			return 0, err
		}
	}
}

func (st *Stream) send(f Frame) error {
	s := st.session
	req := writeRequest{frame: f, stream: st, result: make(chan error, 1)}
	queued := false
	for {
		s.mu.Lock()
		err := st.writeErrorLocked()
		ch, deadline := st.changed, st.writeDeadline
		s.mu.Unlock()
		if err != nil {
			return err
		}
		if !queued {
			var timer *time.Timer
			var timeout <-chan time.Time
			if !deadline.IsZero() {
				timer = time.NewTimer(time.Until(deadline))
				timeout = timer.C
			}
			select {
			case s.writes <- req:
				queued = true
			case <-s.done:
				err = net.ErrClosed
			case <-ch:
			case <-timeout:
				err = os.ErrDeadlineExceeded
			}
			if timer != nil {
				timer.Stop()
			}
			if err != nil {
				return err
			}
			if !queued {
				continue
			}
		}
		// Recheck deadline/closure whenever SetDeadline, Read or Close wakes us.
		var timer *time.Timer
		var timeout <-chan time.Time
		if !deadline.IsZero() {
			timer = time.NewTimer(time.Until(deadline))
			timeout = timer.C
		}
		select {
		case err = <-req.result:
			if timer != nil {
				timer.Stop()
			}
			return err
		case <-ch:
		case <-s.done:
			err = net.ErrClosed
		case <-timeout:
			err = os.ErrDeadlineExceeded
		}
		if timer != nil {
			timer.Stop()
		}
		if err != nil {
			return err
		}
	}
}

func (st *Stream) Write(p []byte) (int, error) {
	st.writeMu.Lock()
	defer st.writeMu.Unlock()
	n := 0
	for len(p) > 0 {
		size := len(p)
		if size > dataChunk {
			size = dataChunk
		}
		var err error
		size, err = st.reserveCredit(size)
		if err != nil {
			_ = st.Close()
			return n, err
		}
		payload := make([]byte, size+1)
		payload[0] = streamBytes
		copy(payload[1:], p[:size])
		if err := st.send(Frame{Type: FrameData, StreamID: st.id, Payload: payload}); err != nil {
			// A partially queued timed-out record must never be reused for a new
			// business message. Reset this stream, not the whole session.
			_ = st.Close()
			return n, err
		}
		n += size
		p = p[size:]
	}
	return n, nil
}

func (st *Stream) reserveCredit(size int) (int, error) {
	s := st.session
	for {
		s.mu.Lock()
		if err := st.writeErrorLocked(); err != nil {
			s.mu.Unlock()
			return 0, err
		}
		if st.sendCredit > 0 {
			if size > st.sendCredit {
				size = st.sendCredit
			}
			st.sendCredit -= size
			s.mu.Unlock()
			return size, nil
		}
		ch, deadline := st.changed, st.writeDeadline
		s.mu.Unlock()
		if err := waitChange(ch, s.done, deadline, nil); err != nil {
			return 0, err
		}
	}
}

func (st *Stream) Close() error {
	s := st.session
	s.mu.Lock()
	already := st.err != nil
	remote := st.remoteEOF
	s.finishLocked(st, net.ErrClosed)
	drained := s.draining && len(s.streams) == 0
	s.mu.Unlock()
	if !already && !remote {
		s.control(Frame{Type: FrameClose, StreamID: st.id})
	}
	if drained {
		s.fail(ErrDraining)
	}
	return nil
}

func (st *Stream) LocalAddr() net.Addr  { return st.session.conn.LocalAddr() }
func (st *Stream) RemoteAddr() net.Addr { return st.session.conn.RemoteAddr() }
func (st *Stream) SetDeadline(t time.Time) error {
	s := st.session
	s.mu.Lock()
	st.readDeadline = t
	st.writeDeadline = t
	st.signalLocked()
	s.mu.Unlock()
	return nil
}
func (st *Stream) SetReadDeadline(t time.Time) error {
	s := st.session
	s.mu.Lock()
	st.readDeadline = t
	st.signalLocked()
	s.mu.Unlock()
	return nil
}
func (st *Stream) SetWriteDeadline(t time.Time) error {
	s := st.session
	s.mu.Lock()
	st.writeDeadline = t
	st.signalLocked()
	s.mu.Unlock()
	return nil
}
