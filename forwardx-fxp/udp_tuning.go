package main

import (
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	fxpUDPListenBufferBytes  = 4 * 1024 * 1024
	fxpUDPSessionBufferBytes = 256 * 1024
	fxpUDPDirectQueueSize    = 64
	fxpUDPStreamQueueSize    = 64
	fxpUDPQueueMaxBytes      = 512 * 1024
	fxpUDPMaxSessions        = 1024
	fxpUDPMaxSessionsPerIP   = 64
	fxpUDPMaxQueueDelay      = 25 * time.Millisecond
	fxpUDPDropLogInterval    = 5 * time.Second
)

type fxpUDPQueuedPacket struct {
	payload  []byte
	queuedAt time.Time
}

type fxpUDPQueue struct {
	mu          sync.Mutex
	packets     []fxpUDPQueuedPacket
	head        int
	size        int
	queuedBytes int
	maxBytes    int
	ready       chan struct{}
}

func newFXPUDPQueue(maxPackets, maxBytes int) *fxpUDPQueue {
	if maxPackets <= 0 {
		maxPackets = 1
	}
	if maxBytes <= 0 {
		maxBytes = 1
	}
	return &fxpUDPQueue{
		packets:  make([]fxpUDPQueuedPacket, maxPackets),
		maxBytes: maxBytes,
		ready:    make(chan struct{}, 1),
	}
}

func (q *fxpUDPQueue) enqueue(payload []byte) bool {
	if q == nil {
		return true
	}
	packet := fxpUDPQueuedPacket{payload: payload, queuedAt: time.Now()}
	packetBytes := len(payload)
	q.mu.Lock()
	defer q.mu.Unlock()
	if packetBytes > q.maxBytes {
		return true
	}
	dropped := false
	for q.size > 0 && (q.size >= len(q.packets) || q.queuedBytes+packetBytes > q.maxBytes) {
		q.dropOldestLocked()
		dropped = true
	}
	if q.size >= len(q.packets) || q.queuedBytes+packetBytes > q.maxBytes {
		return true
	}
	index := (q.head + q.size) % len(q.packets)
	q.packets[index] = packet
	q.size++
	q.queuedBytes += packetBytes
	q.signalLocked()
	return dropped
}

func (q *fxpUDPQueue) next(done <-chan struct{}) (fxpUDPQueuedPacket, bool) {
	if q == nil {
		return fxpUDPQueuedPacket{}, false
	}
	for {
		select {
		case <-done:
			return fxpUDPQueuedPacket{}, false
		default:
		}
		select {
		case <-done:
			return fxpUDPQueuedPacket{}, false
		case <-q.ready:
		}
		q.mu.Lock()
		if q.size == 0 {
			q.mu.Unlock()
			continue
		}
		packet := q.popOldestLocked()
		q.signalLocked()
		q.mu.Unlock()
		return packet, true
	}
}

func (q *fxpUDPQueue) pending() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.size
}

func (q *fxpUDPQueue) bytes() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.queuedBytes
}

func (q *fxpUDPQueue) clear() {
	if q == nil {
		return
	}
	q.mu.Lock()
	for q.size > 0 {
		q.dropOldestLocked()
	}
	select {
	case <-q.ready:
	default:
	}
	q.mu.Unlock()
}

func (q *fxpUDPQueue) popOldestLocked() fxpUDPQueuedPacket {
	packet := q.packets[q.head]
	q.packets[q.head] = fxpUDPQueuedPacket{}
	q.head = (q.head + 1) % len(q.packets)
	q.size--
	q.queuedBytes -= len(packet.payload)
	if q.queuedBytes < 0 {
		q.queuedBytes = 0
	}
	return packet
}

func (q *fxpUDPQueue) dropOldestLocked() {
	_ = q.popOldestLocked()
}

func (q *fxpUDPQueue) signalLocked() {
	if q.size == 0 {
		return
	}
	select {
	case q.ready <- struct{}{}:
	default:
	}
}

func fxpUDPSessionLimits(cfg config) (int, int) {
	maxSessions := cfg.MaxConnections
	if maxSessions <= 0 || maxSessions > fxpUDPMaxSessions {
		maxSessions = fxpUDPMaxSessions
	}
	maxPerIP := cfg.MaxIPs
	if maxPerIP <= 0 || maxPerIP > fxpUDPMaxSessionsPerIP {
		maxPerIP = fxpUDPMaxSessionsPerIP
	}
	if maxPerIP > maxSessions {
		maxPerIP = maxSessions
	}
	return maxSessions, maxPerIP
}

func (packet fxpUDPQueuedPacket) expired(now time.Time) bool {
	return !packet.queuedAt.IsZero() && now.Sub(packet.queuedAt) >= fxpUDPMaxQueueDelay
}

func (packet fxpUDPQueuedPacket) superseded(now time.Time, pendingNewer int) bool {
	return pendingNewer > 0 && packet.expired(now)
}

type rateLimitedLog struct {
	interval   time.Duration
	last       atomic.Int64
	suppressed atomic.Uint64
}

func newRateLimitedLog(interval time.Duration) *rateLimitedLog {
	return &rateLimitedLog{interval: interval}
}

func (l *rateLimitedLog) Printf(format string, args ...any) {
	if l == nil {
		log.Printf(format, args...)
		return
	}
	now := time.Now().UnixNano()
	interval := int64(l.interval)
	if interval <= 0 {
		log.Printf(format, args...)
		return
	}
	last := l.last.Load()
	if now-last >= interval && l.last.CompareAndSwap(last, now) {
		if suppressed := l.suppressed.Swap(0); suppressed > 0 {
			format += " suppressed=%d"
			args = append(args, suppressed)
		}
		log.Printf(format, args...)
		return
	}
	l.suppressed.Add(1)
}

var fxpUDPDropLog = newRateLimitedLog(fxpUDPDropLogInterval)
var fxpUDPTuneLog = newRateLimitedLog(time.Minute)

func tuneUDPConn(conn *net.UDPConn, label string, bytes int) {
	if conn == nil {
		return
	}
	if bytes <= 0 {
		return
	}
	if err := conn.SetReadBuffer(bytes); err != nil {
		fxpUDPTuneLog.Printf("%s udp read buffer tune skipped: %v", label, err)
	}
	if err := conn.SetWriteBuffer(bytes); err != nil {
		fxpUDPTuneLog.Printf("%s udp write buffer tune skipped: %v", label, err)
	}
}
