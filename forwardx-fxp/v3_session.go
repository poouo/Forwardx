package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"

	"github.com/poouo/Forwardx/forwardx-fxp/internal/v3"
)

const v3LogicalFrameLimit = 128 * 1024
const v3PoolSessionLimit = 64

// v3SessionStaleAge is how long a physical session may go without a successful
// write before the pool stops handing it new business streams. It is derived
// from the session write timeout so the two cannot drift apart: a session that
// cannot complete a single write within its own timeout is not healthy.
const v3SessionStaleAge = 3 * v3.DefaultWriteTimeout

var v3BusinessGate = newConnGate(fxpListenerMaxConnections, 0)

// newV3MuxSession completes the V3 inner handshake and starts the multiplex
// session on top of it. The outer transport (HTTP style / WS style / TLS) has
// already been applied to conn.
//
// The handshake and the record layer are ForwardX's own: HKDF-SHA256 with the
// reference's info string, per-direction length and data keys, and a nonce that
// carries a direction byte. It deliberately does not reproduce the reference's
// single shared key with zero-initialised nonces in both directions.
func newV3MuxSession(conn net.Conn, key string, client bool) (*v3.Session, error) {
	if err := setFXPConnDeadline(conn, fxpHandshakeTimeout); err != nil {
		return nil, err
	}
	var (
		inner *v3.InnerConn
		err   error
	)
	if client {
		inner, err = v3.InnerClient(conn, key)
	} else {
		inner, err = v3.InnerServer(conn, key)
	}
	if err != nil {
		return nil, err
	}
	if err := clearFXPConnDeadline(conn); err != nil {
		return nil, err
	}
	return v3.NewSession(inner, v3.SessionOptions{Client: client}), nil
}

func (c *secureConn) writeV3LogicalFrame(plain []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if len(plain) > v3LogicalFrameLimit {
		return errors.New("v3: business frame too large")
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(plain)))
	if _, err := writeFull(c.conn, header[:]); err != nil {
		return err
	}
	_, err := writeFull(c.conn, plain)
	return err
}

func (c *secureConn) readV3LogicalFrame() ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(c.conn, header[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n > v3LogicalFrameLimit {
		return nil, errors.New("v3: business frame too large")
	}
	p := make([]byte, n)
	_, err := io.ReadFull(c.conn, p)
	return p, err
}

// serveV3Session runs the server side of one physical V3 connection: inner
// handshake, then one logical business handler per accepted stream. cfg supplies
// the tunnel key used for the inner handshake.
func serveV3Session(conn net.Conn, cfg config, handler func(*secureConn) error) error {
	session, err := newV3MuxSession(conn, cfg.Key, false)
	if err != nil {
		return err
	}
	defer session.Wait()
	defer session.Close()
	var streams sync.WaitGroup
	defer streams.Wait()
	for {
		stream, err := session.Accept()
		if err != nil {
			// Close streams before waiting for their business handlers to exit.
			session.Close()
			if errors.Is(err, v3.ErrIdle) {
				return nil
			}
			return err
		}
		release, ok, _ := v3BusinessGate.acquire(stream.RemoteAddr())
		if !ok {
			stream.Close()
			fxpVerbosef("fxp V3 stream rejected: global business connection limit=%d", fxpListenerMaxConnections)
			continue
		}
		streams.Add(1)
		go func() {
			defer streams.Done()
			defer release()
			defer stream.Close()
			if err := handler(&secureConn{conn: stream, logicalFrames: true}); err != nil && !isClosedErr(err) {
				log.Printf("fxp V3 stream error peer=%s: %v", stream.RemoteAddr(), err)
			}
		}()
	}
}

type v3PoolBucket struct {
	sessions []*v3.Session
	dialing  bool
	changed  chan struct{}
	lastErr  error
}

type v3SessionPool struct {
	mu      sync.Mutex
	buckets map[[32]byte]*v3PoolBucket
	count   int // Includes in-flight handshakes, so parallel dials stay bounded.
	closed  bool
}

var v3Outbound = &v3SessionPool{buckets: make(map[[32]byte]*v3PoolBucket)}

func v3PoolKey(host string, port int, cfg config) [32]byte {
	// No rule-specific target, quota, listener or PROXY flags: those belong to
	// logical streams. Never share across tunnel keys or outer transport options.
	data, _ := json.Marshal([]any{host, port, cfg.TunnelID, cfg.Key, cfg.V3Transport, cfg.V3Host, cfg.V3Path, cfg.V3ServerName})
	return sha256.Sum256(data)
}

// dialV3Physical opens the raw transport for one physical V3 session and applies
// the outer HTTP/WS/TLS wrapper. The legacy FXP secure handshake is deliberately
// skipped on this path: the V3 inner handshake replaces it.
func dialV3Physical(host string, port int, cfg config) (net.Conn, error) {
	conn, err := dialTCP(host, port, secureDialTimeout(cfg))
	if err != nil {
		return nil, err
	}
	wrapped, err := wrapV3Client(conn, cfg)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return wrapped, nil
}

// v3SessionPool.open returns a logical stream on a pooled physical session. When
// a selector is supplied the pool may move to another exit endpoint, and it
// reports dial outcomes back so the selector's health table stays accurate.
// Previously the pooled path returned as soon as any session existed, so the
// selector never learned that an endpoint had died and ExitStrategy fallback
// silently degraded to "keep using the dead endpoint".
func (p *v3SessionPool) open(host string, port int, cfg config, selector *exitEndpointSelector, selectionKey string) (net.Conn, *secureConn, error) {
	if err := validateTransportConfig(cfg); err != nil {
		return nil, nil, err
	}
	attempted := map[int]bool{}
	if selector != nil && selector.count() > 0 {
		for len(attempted) < selector.count() {
			endpoint, index, ok := selector.pick(attempted, selectionKey)
			if !ok {
				break
			}
			attempted[index] = true
			dialCfg := cfg
			if endpoint.Key != "" {
				dialCfg.Key = endpoint.Key
			}
			stream, sec, err := p.openAt(endpoint.Host, endpoint.Port, dialCfg)
			if err == nil {
				selector.markHealthy(index)
				return stream, sec, nil
			}
			selector.markFailure(index, err)
			if !v3EndpointFailureIsRetryable(err) {
				return nil, nil, err
			}
		}
		return nil, nil, errors.New("v3: no healthy exit endpoint available")
	}
	return p.openAt(host, port, cfg)
}

// v3EndpointFailureIsRetryable reports whether moving to another exit endpoint
// could plausibly help. A pool-capacity error is a local limit, not an endpoint
// fault, so it is returned immediately.
func v3EndpointFailureIsRetryable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, net.ErrClosed) || errors.Is(err, v3.ErrDraining) || errors.Is(err, v3.ErrStreamLimit) {
		return false
	}
	return !strings.Contains(err.Error(), "physical session pool limit reached")
}

// openAt returns a logical stream on a pooled physical session for one exact
// endpoint.
func (p *v3SessionPool) openAt(host string, port int, cfg config) (net.Conn, *secureConn, error) {
	key := v3PoolKey(host, port, cfg)
	retries := 0
	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return nil, nil, net.ErrClosed
		}
		bucket := p.buckets[key]
		if bucket == nil {
			bucket = &v3PoolBucket{changed: make(chan struct{})}
			p.buckets[key] = bucket
		}
		var selected *v3.Session
		mostSlots := 0
		// Drop sessions that already failed and skip sessions that have not
		// proven themselves recently. A session whose peer vanished silently
		// still reports free slots, so slot count alone is not health.
		alive := bucket.sessions[:0]
		for _, session := range bucket.sessions {
			if session.Err() != nil {
				continue
			}
			if !session.Alive(v3SessionStaleAge) {
				// Stale sessions are drained out of the bucket and closed; their
				// own goroutine releases the pool slot.
				session.Close()
				continue
			}
			alive = append(alive, session)
			if n := session.OpenSlots(); n > mostSlots {
				selected = session
				mostSlots = n
			}
		}
		bucket.sessions = alive
		if selected != nil {
			p.mu.Unlock()
			stream, err := selected.Open()
			if errors.Is(err, v3.ErrStreamLimit) {
				continue
			}
			if err != nil {
				// The session just died under us. Close it so the next iteration
				// dials a fresh physical session instead of retrying a dead one,
				// and never replay a business hello or payload.
				selected.Close()
				if retries < 2 {
					retries++
					continue
				}
				return nil, nil, err
			}
			return stream, &secureConn{conn: stream, logicalFrames: true}, nil
		}
		if bucket.dialing {
			changed := bucket.changed
			p.mu.Unlock()
			<-changed
			p.mu.Lock()
			err := bucket.lastErr
			p.mu.Unlock()
			if err != nil {
				return nil, nil, err
			}
			continue
		}
		if p.count >= v3PoolSessionLimit {
			if len(bucket.sessions) == 0 {
				delete(p.buckets, key)
			}
			p.mu.Unlock()
			return nil, nil, fmt.Errorf("v3: physical session pool limit reached (%d sessions, 128 streams/session)", v3PoolSessionLimit)
		}
		bucket.dialing = true
		p.count++
		p.mu.Unlock()
		conn, err := dialV3Physical(host, port, cfg)
		var session *v3.Session
		if err == nil {
			session, err = newV3MuxSession(conn, cfg.Key, true)
		}
		p.mu.Lock()
		bucket.dialing = false
		if p.closed && err == nil {
			session.Close()
			err = net.ErrClosed
		}
		bucket.lastErr = err
		if err == nil {
			bucket.sessions = append(bucket.sessions, session)
		} else {
			p.count--
			if len(bucket.sessions) == 0 {
				delete(p.buckets, key)
			}
		}
		close(bucket.changed)
		bucket.changed = make(chan struct{})
		p.mu.Unlock()
		if err != nil {
			if conn != nil {
				conn.Close()
			}
			return nil, nil, err
		}
		go p.releaseWhenClosed(key, bucket, session)
		// Loop through the normal selection path; concurrent callers can now
		// share the authenticated session instead of all creating their own.
	}
}

// releaseWhenClosed returns a physical session's pool slot exactly once. The
// count is decremented unconditionally because the session was counted when its
// dial started; the bucket may already have pruned it (a stale session is removed
// before it is closed), in which case only the list removal is skipped. Tying the
// decrement to list membership leaked a slot whenever the pool pruned a session,
// which would eventually exhaust the pool's capacity permanently.
func (p *v3SessionPool) releaseWhenClosed(key [32]byte, bucket *v3PoolBucket, session *v3.Session) {
	<-session.Done()
	session.Wait()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.count > 0 {
		p.count--
	}
	for i, value := range bucket.sessions {
		if value == session {
			bucket.sessions = append(bucket.sessions[:i], bucket.sessions[i+1:]...)
			break
		}
	}
	if len(bucket.sessions) == 0 && !bucket.dialing && p.buckets[key] == bucket {
		delete(p.buckets, key)
	}
}

func (p *v3SessionPool) Close() {
	p.mu.Lock()
	p.closed = true
	var sessions []*v3.Session
	for _, bucket := range p.buckets {
		sessions = append(sessions, bucket.sessions...)
	}
	p.mu.Unlock()
	for _, session := range sessions {
		session.Close()
	}
	for _, session := range sessions {
		session.Wait()
	}
}
