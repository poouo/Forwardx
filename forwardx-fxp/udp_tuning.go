package main

import (
	"log"
	"net"
	"sync/atomic"
	"time"
)

const (
	fxpUDPListenBufferBytes  = 4 * 1024 * 1024
	fxpUDPSessionBufferBytes = 512 * 1024
	fxpUDPDirectQueueSize    = 512
	fxpUDPStreamQueueSize    = 512
	fxpUDPMaxQueueDelay      = 25 * time.Millisecond
	fxpUDPDropLogInterval    = 5 * time.Second
)

type fxpUDPQueuedPacket struct {
	payload  []byte
	queuedAt time.Time
}

func enqueueFXPUDPPacket(queue chan fxpUDPQueuedPacket, payload []byte) bool {
	packet := fxpUDPQueuedPacket{payload: payload, queuedAt: time.Now()}
	select {
	case queue <- packet:
		return false
	default:
	}

	// Prefer the newest datagram over replaying an older burst after congestion.
	select {
	case <-queue:
	default:
		return true
	}
	select {
	case queue <- packet:
	default:
	}
	return true
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
