package main

import (
	"log"
	"net"
	"sort"
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
	fxpUDPSoftSessions       = 960
	fxpUDPMaxSessions        = 1024
	fxpUDPSoftSessionsPerIP  = 60
	fxpUDPMaxSessionsPerIP   = 64
	fxpUDPReclaimAfter       = 30 * time.Second
	fxpUDPMaxQueueDelay      = 75 * time.Millisecond
	fxpUDPDropLogInterval    = 5 * time.Second
)

type fxpUDPQueuedPacket struct {
	payload       []byte
	queuedAt      time.Time
	leaseBudget   *fxpUDPQueueRuleBudget
	leaseInFlight *atomic.Int64
	leaseBytes    int
	leaseDone     bool
}

func (packet *fxpUDPQueuedPacket) done() {
	if packet == nil || packet.leaseDone {
		return
	}
	packet.leaseDone = true
	if packet.leaseBudget != nil {
		packet.leaseBudget.release(packet.leaseBytes)
	}
	if packet.leaseInFlight != nil {
		packet.leaseInFlight.Add(-1)
	}
}

type fxpUDPQueue struct {
	mu          sync.Mutex
	packets     []fxpUDPQueuedPacket
	head        int
	size        int
	queuedBytes int
	maxBytes    int
	budget      *fxpUDPQueueRuleBudget
	closed      bool
	ready       chan struct{}
}

func newFXPUDPQueue(maxPackets, maxBytes int) *fxpUDPQueue {
	return newFXPUDPQueueWithBudget(maxPackets, maxBytes, nil)
}

func newFXPUDPQueueWithBudget(maxPackets, maxBytes int, budget *fxpUDPQueueRuleBudget) *fxpUDPQueue {
	if maxPackets <= 0 {
		maxPackets = 1
	}
	if maxBytes <= 0 {
		maxBytes = 1
	}
	return &fxpUDPQueue{
		packets:  make([]fxpUDPQueuedPacket, maxPackets),
		maxBytes: maxBytes,
		budget:   budget,
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
	if q.closed {
		return true
	}
	if packetBytes > q.maxBytes {
		return true
	}
	dropCount := 0
	releaseBytes := 0
	remainingPackets := q.size
	remainingBytes := q.queuedBytes
	for remainingPackets > 0 && (remainingPackets >= len(q.packets) || remainingBytes+packetBytes > q.maxBytes) {
		index := (q.head + dropCount) % len(q.packets)
		bytes := len(q.packets[index].payload)
		dropCount++
		releaseBytes += bytes
		remainingPackets--
		remainingBytes -= bytes
	}
	if remainingPackets >= len(q.packets) || remainingBytes+packetBytes > q.maxBytes {
		return true
	}
	if q.budget != nil && !q.budget.replace(releaseBytes, packetBytes) {
		return true
	}
	for i := 0; i < dropCount; i++ {
		q.popOldestLocked(false)
	}
	index := (q.head + q.size) % len(q.packets)
	q.packets[index] = packet
	q.size++
	q.queuedBytes += packetBytes
	q.signalLocked()
	return dropCount > 0
}

func (q *fxpUDPQueue) next(done <-chan struct{}) (fxpUDPQueuedPacket, bool) {
	return q.nextTracked(done, nil)
}

func (q *fxpUDPQueue) nextTracked(done <-chan struct{}, inFlight *atomic.Int64) (fxpUDPQueuedPacket, bool) {
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
		packet := q.popOldestLocked(false)
		packet.leaseBudget = q.budget
		packet.leaseInFlight = inFlight
		packet.leaseBytes = len(packet.payload)
		if inFlight != nil {
			inFlight.Add(1)
		}
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
		q.dropOldestLocked(true)
	}
	select {
	case <-q.ready:
	default:
	}
	q.mu.Unlock()
}

func (q *fxpUDPQueue) close() {
	if q == nil {
		return
	}
	q.mu.Lock()
	q.closed = true
	for q.size > 0 {
		q.dropOldestLocked(true)
	}
	select {
	case <-q.ready:
	default:
	}
	q.mu.Unlock()
}

func (q *fxpUDPQueue) popOldestLocked(releaseBudget bool) fxpUDPQueuedPacket {
	packet := q.packets[q.head]
	q.packets[q.head] = fxpUDPQueuedPacket{}
	q.head = (q.head + 1) % len(q.packets)
	q.size--
	q.queuedBytes -= len(packet.payload)
	if q.queuedBytes < 0 {
		q.queuedBytes = 0
	}
	if releaseBudget && q.budget != nil {
		q.budget.release(len(packet.payload))
	}
	return packet
}

func (q *fxpUDPQueue) dropOldestLocked(releaseBudget bool) {
	_ = q.popOldestLocked(releaseBudget)
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

type fxpUDPSessionPolicy struct {
	softSessions int
	hardSessions int
	softPerIP    int
	hardPerIP    int
	reclaimAfter time.Duration
}

func defaultFXPUDPSessionPolicy() fxpUDPSessionPolicy {
	return fxpUDPSessionPolicy{
		softSessions: fxpUDPSoftSessions,
		hardSessions: fxpUDPMaxSessions,
		softPerIP:    fxpUDPSoftSessionsPerIP,
		hardPerIP:    fxpUDPMaxSessionsPerIP,
		reclaimAfter: fxpUDPReclaimAfter,
	}
}

type fxpUDPSessionSnapshot struct {
	sourceIP     string
	lastActivity int64
	pending      int
}

type fxpUDPAdmissionReason string

const (
	fxpUDPAdmissionBelowLimit         fxpUDPAdmissionReason = "below-limit"
	fxpUDPAdmissionRejectActivePerIP  fxpUDPAdmissionReason = "reject-active-per-ip"
	fxpUDPAdmissionRejectActiveGlobal fxpUDPAdmissionReason = "reject-active-global"
)

type fxpUDPAdmission struct {
	allow  bool
	reason fxpUDPAdmissionReason
	total  int
	perIP  int
}

type fxpUDPReclamation[T any] struct {
	key     string
	session *T
}

func checkFXPUDPSessionCapacity(total, perIP int, incomingIP string, policy fxpUDPSessionPolicy) fxpUDPAdmission {
	decision := fxpUDPAdmission{allow: true, reason: fxpUDPAdmissionBelowLimit, total: total, perIP: perIP}
	if incomingIP != "" && policy.hardPerIP > 0 && perIP >= policy.hardPerIP {
		decision.allow = false
		decision.reason = fxpUDPAdmissionRejectActivePerIP
		return decision
	}
	if policy.hardSessions > 0 && total >= policy.hardSessions {
		decision.allow = false
		decision.reason = fxpUDPAdmissionRejectActiveGlobal
	}
	return decision
}

func fxpUDPSessionPressure(total, perIP int, incomingIP string, policy fxpUDPSessionPolicy) bool {
	return (policy.softSessions > 0 && total >= policy.softSessions) ||
		(incomingIP != "" && policy.softPerIP > 0 && perIP >= policy.softPerIP)
}

func planFXPUDPPressureReclamation[T any](
	now time.Time,
	sessions map[string]*T,
	policy fxpUDPSessionPolicy,
	snapshot func(*T) fxpUDPSessionSnapshot,
) []fxpUDPReclamation[T] {
	if snapshot == nil || len(sessions) == 0 {
		return nil
	}
	reclaimAfter := policy.reclaimAfter
	if reclaimAfter <= 0 {
		reclaimAfter = fxpUDPReclaimAfter
	}
	cutoff := now.Add(-reclaimAfter).UnixNano()
	total := 0
	perIP := make(map[string]int)
	type candidate struct {
		key          string
		session      *T
		sourceIP     string
		lastActivity int64
	}
	candidates := make([]candidate, 0)
	for key, session := range sessions {
		if session == nil {
			continue
		}
		state := snapshot(session)
		total++
		if state.sourceIP != "" {
			perIP[state.sourceIP]++
		}
		if state.lastActivity > 0 && state.lastActivity <= cutoff && state.pending <= 0 {
			candidates = append(candidates, candidate{key: key, session: session, sourceIP: state.sourceIP, lastActivity: state.lastActivity})
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].lastActivity == candidates[j].lastActivity {
			return candidates[i].key < candidates[j].key
		}
		return candidates[i].lastActivity < candidates[j].lastActivity
	})

	reclaimed := make([]fxpUDPReclamation[T], 0, len(candidates))
	for _, candidate := range candidates {
		globalPressure := policy.softSessions > 0 && total >= policy.softSessions
		perIPPressure := candidate.sourceIP != "" && policy.softPerIP > 0 && perIP[candidate.sourceIP] >= policy.softPerIP
		if !globalPressure && !perIPPressure {
			continue
		}
		reclaimed = append(reclaimed, fxpUDPReclamation[T]{key: candidate.key, session: candidate.session})
		total--
		if candidate.sourceIP != "" {
			perIP[candidate.sourceIP]--
		}
	}
	return reclaimed
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
