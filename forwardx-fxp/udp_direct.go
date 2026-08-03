package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	fxpUDPMagic      = "FXPU"
	fxpUDPVersion    = byte(3)
	fxpUDPTypeData   = byte(1)
	fxpUDPTypeReturn = byte(2)
	fxpUDPHeaderSize = 32
	fxpUDPReplayBits = 64
)

type fxpUDPPacket struct {
	packetType byte
	tunnelID   int
	ruleID     int
	sessionID  uint64
	sequence   uint64
	fragment   uint8
	fragments  uint8
	payload    []byte
}

type fxpUDPCodec struct {
	packetType byte
	tunnelID   int
	ruleID     int
	sessionID  uint64
	aead       cipher.AEAD
}

// udpReplayWindow admits each authenticated datagram sequence once while allowing
// bounded UDP reordering. Fragments share that sequence and use their index in
// the AEAD nonce, so a nonce is never reused within the session direction.
type udpReplayWindow struct {
	mu          sync.Mutex
	initialized bool
	highest     uint64
	seen        uint64
}

func (w *udpReplayWindow) accept(sequence uint64) bool {
	if sequence == 0 {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.initialized {
		w.initialized = true
		w.highest = sequence
		w.seen = 1
		return true
	}
	if sequence > w.highest {
		shift := sequence - w.highest
		if shift >= fxpUDPReplayBits {
			w.seen = 1
		} else {
			w.seen = (w.seen << shift) | 1
		}
		w.highest = sequence
		return true
	}
	distance := w.highest - sequence
	if distance >= fxpUDPReplayBits {
		return false
	}
	bit := uint64(1) << distance
	if w.seen&bit != 0 {
		return false
	}
	w.seen |= bit
	return true
}

type udpDirectEntrySession struct {
	key             string
	sessionID       uint64
	clientAddr      *net.UDPAddr
	conn            *net.UDPConn
	remoteAddr      *net.UDPAddr
	endpoint        exitEndpoint
	endpointIndex   int
	cfg             config
	inLimiter       *limiter
	outLimiter      *limiter
	counter         *trafficCounter
	send            *fxpUDPQueue
	recv            *fxpUDPQueue
	done            chan struct{}
	closeOnce       sync.Once
	lastActivity    atomic.Int64
	inFlight        atomic.Int64
	sendSequence    atomic.Uint64
	returnReplay    udpReplayWindow
	returnFragments udpFragmentReassembler
	dataSealer      *fxpUDPCodec
	returnOpener    *fxpUDPCodec
	remove          func(*udpDirectEntrySession)
}

type udpDirectExitSession struct {
	key           string
	sessionID     uint64
	peerAddr      *net.UDPAddr
	conn          *net.UDPConn
	target        *net.UDPConn
	send          *fxpUDPQueue
	cfg           config
	ruleID        int
	targetIP      string
	targetPort    int
	done          chan struct{}
	closeOnce     sync.Once
	lastActivity  atomic.Int64
	inFlight      atomic.Int64
	sendSequence  atomic.Uint64
	dataReplay    udpReplayWindow
	dataFragments udpFragmentReassembler
	dataOpener    *fxpUDPCodec
	returnSealer  *fxpUDPCodec
	remove        func(*udpDirectExitSession)
}

type udpDirectRelaySession struct {
	key                    string
	sessionID              uint64
	upstreamAddr           *net.UDPAddr
	downstreamAddr         *net.UDPAddr
	conn                   *net.UDPConn
	cfg                    config
	ruleID                 int
	endpoint               exitEndpoint
	endpointIndex          int
	downstreamSend         *fxpUDPQueue
	upstreamSend           *fxpUDPQueue
	done                   chan struct{}
	closeOnce              sync.Once
	lastActivity           atomic.Int64
	inFlight               atomic.Int64
	downstreamSeq          atomic.Uint64
	upstreamSeq            atomic.Uint64
	dataReplay             udpReplayWindow
	returnReplay           udpReplayWindow
	dataFragments          udpFragmentReassembler
	returnFragments        udpFragmentReassembler
	upstreamDataOpener     *fxpUDPCodec
	downstreamDataSealer   *fxpUDPCodec
	downstreamReturnOpener *fxpUDPCodec
	upstreamReturnSealer   *fxpUDPCodec
	remove                 func(*udpDirectRelaySession)
}

func udpDirectEntrySessionSnapshot(session *udpDirectEntrySession) fxpUDPSessionSnapshot {
	state := fxpUDPSessionSnapshot{}
	if session == nil {
		return state
	}
	if session.clientAddr != nil {
		state.sourceIP = session.clientAddr.IP.String()
	}
	state.lastActivity = session.lastActivity.Load()
	if session.send != nil {
		state.pending += session.send.pending()
	}
	if session.recv != nil {
		state.pending += session.recv.pending()
	}
	state.pending += session.returnFragments.pendingCount()
	state.pending += int(session.inFlight.Load())
	return state
}

func udpDirectExitSessionSnapshot(session *udpDirectExitSession) fxpUDPSessionSnapshot {
	state := fxpUDPSessionSnapshot{}
	if session == nil {
		return state
	}
	state.lastActivity = session.lastActivity.Load()
	if session.send != nil {
		state.pending = session.send.pending()
	}
	state.pending += session.dataFragments.pendingCount()
	state.pending += int(session.inFlight.Load())
	return state
}

func udpDirectRelaySessionSnapshot(session *udpDirectRelaySession) fxpUDPSessionSnapshot {
	state := fxpUDPSessionSnapshot{}
	if session == nil {
		return state
	}
	state.lastActivity = session.lastActivity.Load()
	if session.downstreamSend != nil {
		state.pending += session.downstreamSend.pending()
	}
	if session.upstreamSend != nil {
		state.pending += session.upstreamSend.pending()
	}
	state.pending += session.dataFragments.pendingCount()
	state.pending += session.returnFragments.pendingCount()
	state.pending += int(session.inFlight.Load())
	return state
}

func serveEntryUDPDirect(conn *net.UDPConn, cfg config, selector *exitEndpointSelector, inLimiter, outLimiter *limiter) error {
	sessionsByClient := map[string]*udpDirectEntrySession{}
	sessionsByID := map[uint64]*udpDirectEntrySession{}
	sessionsPerIP := map[string]int{}
	policy := defaultFXPUDPSessionPolicy()
	var sessionsMu sync.Mutex
	var workerWG sync.WaitGroup
	counter := &trafficCounter{}
	stopReporting := startTrafficReporter(cfg, counter)
	defer stopReporting()
	queueBudget := newDefaultFXPUDPQueueRuleBudget()
	detachSessionLocked := func(session *udpDirectEntrySession) bool {
		if session == nil || sessionsByClient[session.key] != session {
			return false
		}
		delete(sessionsByClient, session.key)
		if sessionsByID[session.sessionID] == session {
			delete(sessionsByID, session.sessionID)
		}
		if session.clientAddr != nil {
			sourceIP := session.clientAddr.IP.String()
			if sessionsPerIP[sourceIP] <= 1 {
				delete(sessionsPerIP, sourceIP)
			} else {
				sessionsPerIP[sourceIP]--
			}
		}
		return true
	}
	removeSession := func(session *udpDirectEntrySession) {
		sessionsMu.Lock()
		detachSessionLocked(session)
		sessionsMu.Unlock()
	}
	stopSweeper, wakeSweeper := startFXPUDPSessionSweeper(func(now time.Time) {
		var expired []*udpDirectEntrySession
		var reclaimed []*udpDirectEntrySession
		sessionsMu.Lock()
		for key, session := range sessionsByClient {
			if session != nil {
				session.returnFragments.expire(now)
			}
			state := udpDirectEntrySessionSnapshot(session)
			if session != nil && state.pending == 0 && fxpUDPSessionIdleAt(now, state.lastActivity) {
				if sessionsByClient[key] == session && detachSessionLocked(session) {
					expired = append(expired, session)
				}
			}
		}
		for _, victim := range planFXPUDPPressureReclamation(now, sessionsByClient, policy, udpDirectEntrySessionSnapshot) {
			if sessionsByClient[victim.key] == victim.session && detachSessionLocked(victim.session) {
				reclaimed = append(reclaimed, victim.session)
			}
		}
		sessionsMu.Unlock()
		for _, session := range expired {
			fxpVerbosef("entry udp direct session idle timeout tunnel=%d rule=%d client=%s", session.cfg.TunnelID, session.cfg.RuleID, session.clientAddr)
			session.close()
		}
		for _, session := range reclaimed {
			session.close()
			fxpUDPDropLog.Printf("entry udp direct reclaimed idle session tunnel=%d rule=%d client=%s reason=capacity-pressure", session.cfg.TunnelID, session.cfg.RuleID, session.clientAddr)
		}
	})
	defer stopSweeper()
	buf := make([]byte, 65535)
	for {
		n, addr, err := conn.ReadFromUDP(buf)
		if err != nil {
			var closing []*udpDirectEntrySession
			sessionsMu.Lock()
			for _, session := range sessionsByClient {
				closing = append(closing, session)
			}
			sessionsMu.Unlock()
			for _, session := range closing {
				session.close()
			}
			workerWG.Wait()
			return err
		}
		if fxpUDPHasMagic(buf[:n]) {
			if sessionID, ok := fxpUDPSessionID(buf[:n]); ok {
				sessionsMu.Lock()
				session := sessionsByID[sessionID]
				claimedReturn := session != nil && udpAddrEqual(addr, session.remoteAddr)
				if claimedReturn {
					session.inFlight.Add(1)
				}
				sessionsMu.Unlock()
				if claimedReturn {
					func() {
						defer session.inFlight.Add(-1)
						packet, err := session.returnOpener.openPacket(buf[:n])
						if err == nil && packet.packetType == fxpUDPTypeReturn && packetMatchesConfig(packet, cfg) {
							sessionsMu.Lock()
							current := sessionsByID[sessionID] == session && udpAddrEqual(addr, session.remoteAddr)
							if current {
								session.touch()
							}
							sessionsMu.Unlock()
							if current {
								session.handleResponse(packet)
							}
						}
					}()
					continue
				}
			}
		}
		key := addr.String()
		sourceIP := addr.IP.String()
		sessionsMu.Lock()
		session := sessionsByClient[key]
		if session != nil {
			session.touch()
		}
		preflight := fxpUDPAdmission{allow: true}
		if session == nil {
			preflight = checkFXPUDPSessionCapacity(len(sessionsByClient), sessionsPerIP[sourceIP], sourceIP, policy)
		}
		sessionsMu.Unlock()
		if !preflight.allow {
			wakeSweeper()
			fxpUDPDropLog.Printf("entry udp direct rejected new session tunnel=%d rule=%d client=%s reason=%s sessions=%d perIP=%d hardSessions=%d hardPerIP=%d", cfg.TunnelID, cfg.RuleID, addr, preflight.reason, preflight.total, preflight.perIP, policy.hardSessions, policy.hardPerIP)
			continue
		}
		startSession := false
		if session == nil {
			created, err := newUDPDirectEntrySession(conn, addr, cfg, selector, inLimiter, outLimiter, counter, queueBudget, removeSession)
			if err != nil {
				if !isClosedErr(err) {
					log.Printf("entry udp direct session create failed tunnel=%d rule=%d client=%s: %v", cfg.TunnelID, cfg.RuleID, addr, err)
				}
				continue
			}
			var closeCreated *udpDirectEntrySession
			var admission fxpUDPAdmission
			rejected := false
			collision := false
			pressure := false
			sessionsMu.Lock()
			if existing := sessionsByClient[key]; existing != nil {
				session = existing
				session.touch()
				closeCreated = created
			} else if sessionsByID[created.sessionID] != nil {
				closeCreated = created
				collision = true
			} else {
				admission = checkFXPUDPSessionCapacity(len(sessionsByClient), sessionsPerIP[sourceIP], sourceIP, policy)
				if !admission.allow {
					closeCreated = created
					rejected = true
				} else {
					sessionsByClient[key] = created
					sessionsByID[created.sessionID] = created
					sessionsPerIP[sourceIP]++
					session = created
					startSession = true
					pressure = fxpUDPSessionPressure(len(sessionsByClient), sessionsPerIP[sourceIP], sourceIP, policy)
				}
			}
			sessionsMu.Unlock()
			if closeCreated != nil {
				closeCreated.close()
			}
			if collision {
				fxpUDPDropLog.Printf("entry udp direct rejected session id collision tunnel=%d rule=%d client=%s session=%d", cfg.TunnelID, cfg.RuleID, addr, created.sessionID)
				continue
			}
			if rejected {
				wakeSweeper()
				fxpUDPDropLog.Printf("entry udp direct rejected new session tunnel=%d rule=%d client=%s reason=%s sessions=%d perIP=%d hardSessions=%d hardPerIP=%d", cfg.TunnelID, cfg.RuleID, addr, admission.reason, admission.total, admission.perIP, policy.hardSessions, policy.hardPerIP)
				continue
			}
			if pressure {
				wakeSweeper()
			}
		}
		if startSession {
			session.counter.connections.Add(1)
			session.start(&workerWG)
		}
		session.enqueue(append([]byte(nil), buf[:n]...))
	}
}

func newUDPDirectEntrySession(conn *net.UDPConn, clientAddr *net.UDPAddr, cfg config, selector *exitEndpointSelector, inLimiter, outLimiter *limiter, counter *trafficCounter, queueBudget *fxpUDPQueueRuleBudget, remove func(*udpDirectEntrySession)) (*udpDirectEntrySession, error) {
	endpoint, index, remoteAddr, err := pickUDPDirectEndpoint(selector, cfg, clientAddr.IP.String())
	if err != nil {
		return nil, err
	}
	sessionID, err := randomUint64()
	if err != nil {
		return nil, err
	}
	codecKey := udpEndpointKey(endpoint, cfg.Key)
	dataSealer, err := newFXPUDPCodec(codecKey, fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   cfg.TunnelID,
		ruleID:     cfg.RuleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	returnOpener, err := newFXPUDPCodec(codecKey, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   cfg.TunnelID,
		ruleID:     cfg.RuleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	sendSeed, err := allocateFXPUDPSequenceSeed()
	if err != nil {
		return nil, err
	}
	if counter == nil {
		counter = &trafficCounter{}
	}
	session := &udpDirectEntrySession{
		key:           clientAddr.String(),
		sessionID:     sessionID,
		clientAddr:    clientAddr,
		conn:          conn,
		remoteAddr:    remoteAddr,
		endpoint:      endpoint,
		endpointIndex: index,
		cfg:           cfg,
		inLimiter:     inLimiter,
		outLimiter:    outLimiter,
		counter:       counter,
		send:          newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		recv:          newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		done:          make(chan struct{}),
		dataSealer:    dataSealer,
		returnOpener:  returnOpener,
		remove:        remove,
	}
	session.sendSequence.Store(sendSeed)
	session.returnFragments.bindBudget(queueBudget)
	session.touch()
	return session, nil
}

func (s *udpDirectEntrySession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpDirectEntrySession) start(workerWG *sync.WaitGroup) {
	startFXPUDPSessionWorker(workerWG, s.writeLoop)
	startFXPUDPSessionWorker(workerWG, s.clientWriteLoop)
	fxpVerbosef("entry udp direct session started tunnel=%d rule=%d client=%s exit=%s:%d target=%s:%d session=%d", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, s.endpoint.Host, s.endpoint.Port, s.cfg.TargetIP, s.cfg.TargetPort, s.sessionID)
}

func (s *udpDirectEntrySession) enqueue(payload []byte) {
	s.touch()
	select {
	case <-s.done:
		return
	default:
		if s.send.enqueue(payload) {
			fxpUDPDropLog.Printf("entry udp direct queue congested tunnel=%d rule=%d client=%s; packet dropped", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
		}
	}
}

func (s *udpDirectEntrySession) writeLoop() {
	defer observeFXPUDPSequence(&s.sendSequence)
	for {
		queued, ok := s.send.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if queued.superseded(time.Now(), s.send.pending()) {
			fxpUDPDropLog.Printf("entry udp direct queued packet expired tunnel=%d rule=%d client=%s; dropping stale packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
			queued.done()
			continue
		}
		payload := queued.payload
		s.touch()
		if !s.inLimiter.waitDone(s.done, len(payload)) {
			queued.done()
			return
		}
		if queued.superseded(time.Now(), s.send.pending()) {
			fxpUDPDropLog.Printf("entry udp direct queued packet expired after wait tunnel=%d rule=%d client=%s; dropping stale packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
			queued.done()
			continue
		}
		packets, err := sealFXPUDPDatagramsWithCodec(fxpUDPPacket{
			packetType: fxpUDPTypeData,
			tunnelID:   s.cfg.TunnelID,
			ruleID:     s.cfg.RuleID,
			sessionID:  s.sessionID,
			payload:    payload,
		}, s.dataSealer, &s.sendSequence)
		if err != nil {
			log.Printf("entry udp direct seal failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
			queued.done()
			s.close()
			return
		}
		for _, packet := range packets {
			if _, err := s.conn.WriteToUDP(packet, s.remoteAddr); err != nil {
				log.Printf("entry udp direct send failed tunnel=%d rule=%d client=%s exit=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, s.remoteAddr, err)
				queued.done()
				s.close()
				return
			}
		}
		s.counter.in.Add(uint64(len(payload)))
		queued.done()
	}
}

func (s *udpDirectEntrySession) handleResponse(packet fxpUDPPacket) {
	payload, ok := s.returnFragments.accept(packet, &s.returnReplay)
	if !ok {
		return
	}
	s.touch()
	select {
	case <-s.done:
		return
	default:
		if s.recv.enqueue(payload) {
			fxpUDPDropLog.Printf("entry udp direct response queue congested tunnel=%d rule=%d client=%s; packet dropped", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
		}
	}
}

func (s *udpDirectEntrySession) clientWriteLoop() {
	for {
		packet, ok := s.recv.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if packet.superseded(time.Now(), s.recv.pending()) {
			fxpUDPDropLog.Printf("entry udp direct response expired tunnel=%d rule=%d client=%s; dropping stale packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
			packet.done()
			continue
		}
		s.writeResponse(packet.payload)
		packet.done()
	}
}

func (s *udpDirectEntrySession) writeResponse(payload []byte) {
	if !s.outLimiter.waitDone(s.done, len(payload)) {
		return
	}
	if _, err := s.conn.WriteToUDP(payload, s.clientAddr); err != nil {
		if !isClosedErr(err) {
			log.Printf("entry udp direct client write failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
		}
		s.close()
		return
	}
	s.counter.out.Add(uint64(len(payload)))
	s.touch()
}

func (s *udpDirectEntrySession) close() {
	s.closeOnce.Do(func() {
		observeFXPUDPSequence(&s.sendSequence)
		close(s.done)
		s.send.close()
		s.recv.close()
		s.returnFragments.close()
		if s.remove != nil {
			s.remove(s)
		}
	})
}

func serveExitUDPDirect(conn *net.UDPConn, cfg config) error {
	sessions := map[string]*udpDirectExitSession{}
	policy := defaultFXPUDPSessionPolicy()
	targetsByRule := make(map[int]udpTarget, len(cfg.UDPTargets))
	for _, target := range cfg.UDPTargets {
		if _, exists := targetsByRule[target.RuleID]; !exists {
			targetsByRule[target.RuleID] = target
		}
	}
	targetForRule := func(ruleID int) (udpTarget, bool) {
		target, ok := targetsByRule[ruleID]
		return target, ok
	}
	queueBudgets := map[int]*fxpUDPQueueRuleBudget{}
	queueBudgetForRule := func(ruleID int) *fxpUDPQueueRuleBudget {
		budget := queueBudgets[ruleID]
		if budget == nil {
			budget = newDefaultFXPUDPQueueRuleBudget()
			queueBudgets[ruleID] = budget
		}
		return budget
	}
	var sessionsMu sync.Mutex
	var workerWG sync.WaitGroup
	detachSessionLocked := func(session *udpDirectExitSession) bool {
		if session == nil || sessions[session.key] != session {
			return false
		}
		delete(sessions, session.key)
		return true
	}
	removeSession := func(session *udpDirectExitSession) {
		sessionsMu.Lock()
		detachSessionLocked(session)
		sessionsMu.Unlock()
	}
	stopSweeper, wakeSweeper := startFXPUDPSessionSweeper(func(now time.Time) {
		var expired []*udpDirectExitSession
		var reclaimed []*udpDirectExitSession
		sessionsMu.Lock()
		for key, session := range sessions {
			if session != nil {
				session.dataFragments.expire(now)
			}
			state := udpDirectExitSessionSnapshot(session)
			if session != nil && state.pending == 0 && fxpUDPSessionIdleAt(now, state.lastActivity) {
				if sessions[key] == session && detachSessionLocked(session) {
					expired = append(expired, session)
				}
			}
		}
		for _, victim := range planFXPUDPPressureReclamation(now, sessions, policy, udpDirectExitSessionSnapshot) {
			if sessions[victim.key] == victim.session && detachSessionLocked(victim.session) {
				reclaimed = append(reclaimed, victim.session)
			}
		}
		sessionsMu.Unlock()
		for _, session := range expired {
			fxpVerbosef("exit udp direct session idle timeout tunnel=%d rule=%d peer=%s", session.cfg.TunnelID, session.ruleID, session.peerAddr)
			session.close()
		}
		for _, session := range reclaimed {
			session.close()
			fxpUDPDropLog.Printf("exit udp direct reclaimed idle session tunnel=%d rule=%d peer=%s reason=capacity-pressure", session.cfg.TunnelID, session.ruleID, session.peerAddr)
		}
	})
	defer stopSweeper()
	buf := make([]byte, 65535)
	for {
		n, peerAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			var closing []*udpDirectExitSession
			sessionsMu.Lock()
			for _, session := range sessions {
				closing = append(closing, session)
			}
			sessionsMu.Unlock()
			for _, session := range closing {
				session.close()
			}
			workerWG.Wait()
			return err
		}
		header, err := parseFXPUDPHeader(buf[:n])
		if err != nil || header.packetType != fxpUDPTypeData || !packetMatchesConfig(header, cfg) {
			continue
		}
		key := udpRuleSessionKey(peerAddr, header.ruleID, header.sessionID)
		sessionsMu.Lock()
		session := sessions[key]
		if session != nil {
			session.inFlight.Add(1)
		}
		preflight := fxpUDPAdmission{allow: true}
		if session == nil {
			preflight = checkFXPUDPSessionCapacity(len(sessions), 0, "", policy)
		}
		sessionsMu.Unlock()
		if session != nil {
			func() {
				defer session.inFlight.Add(-1)
				packet, err := session.dataOpener.openParsedPacket(buf[:n], header)
				if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) {
					return
				}
				target, ok := targetForRule(packet.ruleID)
				if !ok {
					fxpUDPDropLog.Printf("exit udp direct target missing tunnel=%d rule=%d peer=%s", cfg.TunnelID, packet.ruleID, peerAddr)
					return
				}
				sessionsMu.Lock()
				current := sessions[key] == session
				conflict := current && (session.targetIP != target.TargetIP || session.targetPort != target.TargetPort)
				if current && !conflict {
					session.touch()
				}
				sessionsMu.Unlock()
				if !current {
					return
				}
				if conflict {
					fxpUDPDropLog.Printf("exit udp direct rejected session target conflict tunnel=%d rule=%d peer=%s session=%d", cfg.TunnelID, packet.ruleID, peerAddr, packet.sessionID)
					return
				}
				payload, ok := session.dataFragments.accept(packet, &session.dataReplay)
				if ok {
					session.forwardToTarget(payload)
				}
			}()
			continue
		}
		if !preflight.allow {
			wakeSweeper()
			fxpUDPDropLog.Printf("exit udp direct rejected new session tunnel=%d rule=%d peer=%s reason=%s sessions=%d hardSessions=%d", cfg.TunnelID, header.ruleID, peerAddr, preflight.reason, preflight.total, policy.hardSessions)
			continue
		}
		packet, err := openFXPUDPPacket(buf[:n], cfg.Key)
		if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) {
			continue
		}
		target, ok := targetForRule(packet.ruleID)
		if !ok {
			fxpUDPDropLog.Printf("exit udp direct target missing tunnel=%d rule=%d peer=%s", cfg.TunnelID, packet.ruleID, peerAddr)
			continue
		}
		if session == nil {
			created, err := newUDPDirectExitSession(conn, peerAddr, cfg, packet.ruleID, packet.sessionID, target.TargetIP, target.TargetPort, queueBudgetForRule(packet.ruleID), removeSession)
			if err != nil {
				log.Printf("exit udp direct session create failed tunnel=%d rule=%d peer=%s target=%s:%d: %v", cfg.TunnelID, packet.ruleID, peerAddr, target.TargetIP, target.TargetPort, err)
				continue
			}
			var closeCreated *udpDirectExitSession
			var admission fxpUDPAdmission
			rejected := false
			startSession := false
			pressure := false
			sessionsMu.Lock()
			if existing := sessions[key]; existing != nil {
				session = existing
				session.touch()
				closeCreated = created
			} else {
				admission = checkFXPUDPSessionCapacity(len(sessions), 0, "", policy)
				if !admission.allow {
					closeCreated = created
					rejected = true
				} else {
					sessions[key] = created
					session = created
					startSession = true
					pressure = fxpUDPSessionPressure(len(sessions), 0, "", policy)
				}
			}
			sessionsMu.Unlock()
			if closeCreated != nil {
				closeCreated.close()
			}
			if rejected {
				wakeSweeper()
				fxpUDPDropLog.Printf("exit udp direct rejected new session tunnel=%d rule=%d peer=%s reason=%s sessions=%d hardSessions=%d", cfg.TunnelID, packet.ruleID, peerAddr, admission.reason, admission.total, policy.hardSessions)
				continue
			}
			if pressure {
				wakeSweeper()
			}
			if startSession {
				session.start(&workerWG)
			}
		}
		payload, ok := session.dataFragments.accept(packet, &session.dataReplay)
		if !ok {
			continue
		}
		session.forwardToTarget(payload)
	}
}

func newUDPDirectExitSession(conn *net.UDPConn, peerAddr *net.UDPAddr, cfg config, ruleID int, sessionID uint64, targetIP string, targetPort int, queueBudget *fxpUDPQueueRuleBudget, remove func(*udpDirectExitSession)) (*udpDirectExitSession, error) {
	dataOpener, err := newFXPUDPCodec(cfg.Key, fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	returnSealer, err := newFXPUDPCodec(cfg.Key, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	targetAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(targetIP, strconv.Itoa(targetPort)))
	if err != nil {
		return nil, err
	}
	target, err := net.DialUDP("udp", nil, targetAddr)
	if err != nil {
		return nil, err
	}
	tuneUDPConn(target, "exit target", fxpUDPSessionBufferBytes)
	sendSeed, err := allocateFXPUDPSequenceSeed()
	if err != nil {
		_ = target.Close()
		return nil, err
	}
	session := &udpDirectExitSession{
		key:          udpRuleSessionKey(peerAddr, ruleID, sessionID),
		sessionID:    sessionID,
		peerAddr:     peerAddr,
		conn:         conn,
		target:       target,
		send:         newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		cfg:          cfg,
		ruleID:       ruleID,
		targetIP:     targetIP,
		targetPort:   targetPort,
		done:         make(chan struct{}),
		dataOpener:   dataOpener,
		returnSealer: returnSealer,
		remove:       remove,
	}
	session.sendSequence.Store(sendSeed)
	session.dataFragments.bindBudget(queueBudget)
	session.touch()
	return session, nil
}

func (s *udpDirectExitSession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpDirectExitSession) start(workerWG *sync.WaitGroup) {
	startFXPUDPSessionWorker(workerWG, s.writeTargetLoop)
	startFXPUDPSessionWorker(workerWG, s.readTargetLoop)
	fxpVerbosef("exit udp direct session routed tunnel=%d rule=%d peer=%s target=%s:%d session=%d", s.cfg.TunnelID, s.ruleID, s.peerAddr, s.targetIP, s.targetPort, s.sessionID)
}

func (s *udpDirectExitSession) forwardToTarget(payload []byte) {
	s.touch()
	select {
	case <-s.done:
		return
	default:
		if s.send.enqueue(payload) {
			fxpUDPDropLog.Printf("exit udp direct target queue congested tunnel=%d rule=%d peer=%s target=%s:%d; packet dropped", s.cfg.TunnelID, s.ruleID, s.peerAddr, s.targetIP, s.targetPort)
		}
	}
}

func (s *udpDirectExitSession) writeTargetLoop() {
	for {
		packet, ok := s.send.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if packet.superseded(time.Now(), s.send.pending()) {
			fxpUDPDropLog.Printf("exit udp direct target packet expired tunnel=%d rule=%d peer=%s target=%s:%d; dropping stale packet", s.cfg.TunnelID, s.ruleID, s.peerAddr, s.targetIP, s.targetPort)
			packet.done()
			continue
		}
		s.writeTarget(packet.payload)
		packet.done()
	}
}

func (s *udpDirectExitSession) writeTarget(payload []byte) {
	if _, err := s.target.Write(payload); err != nil {
		log.Printf("exit udp direct target write failed tunnel=%d rule=%d peer=%s target=%s:%d: %v", s.cfg.TunnelID, s.ruleID, s.peerAddr, s.targetIP, s.targetPort, err)
		s.close()
		return
	}
	s.touch()
}

func (s *udpDirectExitSession) readTargetLoop() {
	defer observeFXPUDPSequence(&s.sendSequence)
	buf := make([]byte, 65535)
	for {
		_ = s.target.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, err := s.target.Read(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				select {
				case <-s.done:
					return
				default:
					continue
				}
			}
			if !isClosedErr(err) {
				log.Printf("exit udp direct target read failed tunnel=%d rule=%d peer=%s target=%s:%d: %v", s.cfg.TunnelID, s.ruleID, s.peerAddr, s.targetIP, s.targetPort, err)
			}
			s.close()
			return
		}
		if n <= 0 {
			continue
		}
		s.touch()
		packets, err := sealFXPUDPDatagramsWithCodec(fxpUDPPacket{
			packetType: fxpUDPTypeReturn,
			tunnelID:   s.cfg.TunnelID,
			ruleID:     s.ruleID,
			sessionID:  s.sessionID,
			payload:    buf[:n],
		}, s.returnSealer, &s.sendSequence)
		if err != nil {
			log.Printf("exit udp direct seal failed tunnel=%d rule=%d peer=%s: %v", s.cfg.TunnelID, s.ruleID, s.peerAddr, err)
			s.close()
			return
		}
		for _, packet := range packets {
			if _, err := s.conn.WriteToUDP(packet, s.peerAddr); err != nil {
				log.Printf("exit udp direct peer write failed tunnel=%d rule=%d peer=%s: %v", s.cfg.TunnelID, s.ruleID, s.peerAddr, err)
				s.close()
				return
			}
		}
		s.touch()
	}
}

func (s *udpDirectExitSession) close() {
	s.closeOnce.Do(func() {
		observeFXPUDPSequence(&s.sendSequence)
		close(s.done)
		s.send.close()
		s.dataFragments.close()
		if s.remove != nil {
			s.remove(s)
		}
		_ = s.target.Close()
	})
}

func serveRelayUDPDirect(conn *net.UDPConn, cfg config, selector *exitEndpointSelector) error {
	sessionsByUpstream := map[string]*udpDirectRelaySession{}
	sessionsByID := map[uint64]*udpDirectRelaySession{}
	policy := defaultFXPUDPSessionPolicy()
	queueBudget := newDefaultFXPUDPQueueRuleBudget()
	var sessionsMu sync.Mutex
	var workerWG sync.WaitGroup
	detachSessionLocked := func(session *udpDirectRelaySession) bool {
		if session == nil || sessionsByUpstream[session.key] != session {
			return false
		}
		delete(sessionsByUpstream, session.key)
		if sessionsByID[session.sessionID] == session {
			delete(sessionsByID, session.sessionID)
		}
		return true
	}
	removeSession := func(session *udpDirectRelaySession) {
		sessionsMu.Lock()
		detachSessionLocked(session)
		sessionsMu.Unlock()
	}
	stopSweeper, wakeSweeper := startFXPUDPSessionSweeper(func(now time.Time) {
		var expired []*udpDirectRelaySession
		var reclaimed []*udpDirectRelaySession
		sessionsMu.Lock()
		for key, session := range sessionsByUpstream {
			if session != nil {
				session.dataFragments.expire(now)
				session.returnFragments.expire(now)
			}
			state := udpDirectRelaySessionSnapshot(session)
			if session != nil && state.pending == 0 && fxpUDPSessionIdleAt(now, state.lastActivity) {
				if sessionsByUpstream[key] == session && detachSessionLocked(session) {
					expired = append(expired, session)
				}
			}
		}
		for _, victim := range planFXPUDPPressureReclamation(now, sessionsByUpstream, policy, udpDirectRelaySessionSnapshot) {
			if sessionsByUpstream[victim.key] == victim.session && detachSessionLocked(victim.session) {
				reclaimed = append(reclaimed, victim.session)
			}
		}
		sessionsMu.Unlock()
		for _, session := range expired {
			fxpVerbosef("relay udp direct session idle timeout tunnel=%d rule=%d upstream=%s", session.cfg.TunnelID, session.ruleID, session.upstreamAddr)
			session.close()
		}
		for _, session := range reclaimed {
			session.close()
			fxpUDPDropLog.Printf("relay udp direct reclaimed idle session tunnel=%d rule=%d upstream=%s reason=capacity-pressure", session.cfg.TunnelID, session.ruleID, session.upstreamAddr)
		}
	})
	defer stopSweeper()
	buf := make([]byte, 65535)
	for {
		n, addr, err := conn.ReadFromUDP(buf)
		if err != nil {
			var closing []*udpDirectRelaySession
			sessionsMu.Lock()
			for _, session := range sessionsByUpstream {
				closing = append(closing, session)
			}
			sessionsMu.Unlock()
			for _, session := range closing {
				session.close()
			}
			workerWG.Wait()
			return err
		}
		if !fxpUDPHasMagic(buf[:n]) {
			continue
		}
		sessionID, ok := fxpUDPSessionID(buf[:n])
		if !ok {
			continue
		}
		sessionsMu.Lock()
		session := sessionsByID[sessionID]
		claimedReturn := session != nil && udpAddrEqual(addr, session.downstreamAddr)
		if claimedReturn {
			session.inFlight.Add(1)
		}
		sessionsMu.Unlock()
		if claimedReturn {
			func() {
				defer session.inFlight.Add(-1)
				packet, err := session.downstreamReturnOpener.openPacket(buf[:n])
				if err == nil && packet.packetType == fxpUDPTypeReturn && packetMatchesConfig(packet, cfg) {
					sessionsMu.Lock()
					current := sessionsByID[sessionID] == session && udpAddrEqual(addr, session.downstreamAddr)
					if current {
						session.touch()
					}
					sessionsMu.Unlock()
					if current {
						session.forwardToUpstream(packet)
					}
				}
			}()
			continue
		}
		header, err := parseFXPUDPHeader(buf[:n])
		if err != nil || header.packetType != fxpUDPTypeData || !packetMatchesConfig(header, cfg) {
			continue
		}
		key := udpSessionKey(addr, header.sessionID)
		sessionsMu.Lock()
		session = sessionsByUpstream[key]
		if session != nil {
			session.inFlight.Add(1)
		}
		preflight := fxpUDPAdmission{allow: true}
		if session == nil {
			preflight = checkFXPUDPSessionCapacity(len(sessionsByUpstream), 0, "", policy)
		}
		sessionsMu.Unlock()
		if session != nil {
			func() {
				defer session.inFlight.Add(-1)
				packet, err := session.upstreamDataOpener.openParsedPacket(buf[:n], header)
				if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) {
					return
				}
				sessionsMu.Lock()
				current := sessionsByUpstream[key] == session
				if current {
					session.touch()
				}
				sessionsMu.Unlock()
				if current {
					session.forwardToDownstream(packet)
				}
			}()
			continue
		}
		if !preflight.allow {
			wakeSweeper()
			fxpUDPDropLog.Printf("relay udp direct rejected new session tunnel=%d rule=%d upstream=%s reason=%s sessions=%d hardSessions=%d", cfg.TunnelID, header.ruleID, addr, preflight.reason, preflight.total, policy.hardSessions)
			continue
		}
		packet, err := openFXPUDPPacket(buf[:n], cfg.Key)
		if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) {
			continue
		}
		if session == nil {
			created, err := newUDPDirectRelaySession(conn, addr, cfg, selector, packet.ruleID, packet.sessionID, queueBudget, removeSession)
			if err != nil {
				log.Printf("relay udp direct session create failed tunnel=%d rule=%d upstream=%s: %v", cfg.TunnelID, packet.ruleID, addr, err)
				continue
			}
			var closeCreated *udpDirectRelaySession
			var admission fxpUDPAdmission
			rejected := false
			collision := false
			startSession := false
			pressure := false
			sessionsMu.Lock()
			if existing := sessionsByUpstream[key]; existing != nil {
				closeCreated = created
				if existing.ruleID == packet.ruleID {
					session = existing
				} else {
					collision = true
				}
			} else if existing := sessionsByID[created.sessionID]; existing != nil {
				closeCreated = created
				collision = true
			} else {
				admission = checkFXPUDPSessionCapacity(len(sessionsByUpstream), 0, "", policy)
				if !admission.allow {
					closeCreated = created
					rejected = true
				} else {
					sessionsByUpstream[key] = created
					sessionsByID[created.sessionID] = created
					session = created
					startSession = true
					pressure = fxpUDPSessionPressure(len(sessionsByUpstream), 0, "", policy)
				}
			}
			sessionsMu.Unlock()
			if closeCreated != nil {
				closeCreated.close()
			}
			if collision {
				fxpUDPDropLog.Printf("relay udp direct rejected session id collision tunnel=%d rule=%d upstream=%s session=%d", cfg.TunnelID, packet.ruleID, addr, packet.sessionID)
				continue
			}
			if rejected {
				wakeSweeper()
				fxpUDPDropLog.Printf("relay udp direct rejected new session tunnel=%d rule=%d upstream=%s reason=%s sessions=%d hardSessions=%d", cfg.TunnelID, packet.ruleID, addr, admission.reason, admission.total, policy.hardSessions)
				continue
			}
			if pressure {
				wakeSweeper()
			}
			if startSession {
				session.start(&workerWG)
			}
		}
		session.forwardToDownstream(packet)
	}
}

func newUDPDirectRelaySession(conn *net.UDPConn, upstreamAddr *net.UDPAddr, cfg config, selector *exitEndpointSelector, ruleID int, sessionID uint64, queueBudget *fxpUDPQueueRuleBudget, remove func(*udpDirectRelaySession)) (*udpDirectRelaySession, error) {
	endpoint, index, downstreamAddr, err := pickUDPDirectEndpoint(selector, cfg, strconv.FormatUint(sessionID, 10))
	if err != nil {
		return nil, err
	}
	downstreamKey := udpEndpointKey(endpoint, cfg.RelayKey)
	upstreamDataOpener, err := newFXPUDPCodec(cfg.Key, fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	downstreamDataSealer, err := newFXPUDPCodec(downstreamKey, fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	downstreamReturnOpener, err := newFXPUDPCodec(downstreamKey, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	upstreamReturnSealer, err := newFXPUDPCodec(cfg.Key, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	downstreamSeed, err := allocateFXPUDPSequenceSeed()
	if err != nil {
		return nil, err
	}
	upstreamSeed, err := allocateFXPUDPSequenceSeed()
	if err != nil {
		return nil, err
	}
	session := &udpDirectRelaySession{
		key:                    udpSessionKey(upstreamAddr, sessionID),
		sessionID:              sessionID,
		upstreamAddr:           upstreamAddr,
		downstreamAddr:         downstreamAddr,
		conn:                   conn,
		cfg:                    cfg,
		ruleID:                 ruleID,
		endpoint:               endpoint,
		endpointIndex:          index,
		downstreamSend:         newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		upstreamSend:           newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		done:                   make(chan struct{}),
		upstreamDataOpener:     upstreamDataOpener,
		downstreamDataSealer:   downstreamDataSealer,
		downstreamReturnOpener: downstreamReturnOpener,
		upstreamReturnSealer:   upstreamReturnSealer,
		remove:                 remove,
	}
	session.downstreamSeq.Store(downstreamSeed)
	session.upstreamSeq.Store(upstreamSeed)
	session.dataFragments.bindBudget(queueBudget)
	session.returnFragments.bindBudget(queueBudget)
	session.touch()
	return session, nil
}

func (s *udpDirectRelaySession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpDirectRelaySession) start(workerWG *sync.WaitGroup) {
	startFXPUDPSessionWorker(workerWG, s.downstreamWriteLoop)
	startFXPUDPSessionWorker(workerWG, s.upstreamWriteLoop)
	fxpVerbosef("relay udp direct session routed tunnel=%d rule=%d upstream=%s downstream=%s:%d session=%d", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, s.endpoint.Host, s.endpoint.Port, s.sessionID)
}

func (s *udpDirectRelaySession) forwardToDownstream(packet fxpUDPPacket) {
	payload, ok := s.dataFragments.accept(packet, &s.dataReplay)
	if !ok {
		return
	}
	s.touch()
	select {
	case <-s.done:
		return
	default:
		if s.downstreamSend.enqueue(payload) {
			fxpUDPDropLog.Printf("relay udp direct downstream queue congested tunnel=%d rule=%d upstream=%s downstream=%s; packet dropped", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, s.downstreamAddr)
		}
	}
}

func (s *udpDirectRelaySession) downstreamWriteLoop() {
	defer observeFXPUDPSequence(&s.downstreamSeq)
	for {
		packet, ok := s.downstreamSend.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if packet.superseded(time.Now(), s.downstreamSend.pending()) {
			fxpUDPDropLog.Printf("relay udp direct downstream packet expired tunnel=%d rule=%d upstream=%s downstream=%s; dropping stale packet", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, s.downstreamAddr)
			packet.done()
			continue
		}
		s.writeDownstream(packet.payload)
		packet.done()
	}
}

func (s *udpDirectRelaySession) writeDownstream(payload []byte) {
	packets, err := sealFXPUDPDatagramsWithCodec(fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   s.cfg.TunnelID,
		ruleID:     s.ruleID,
		sessionID:  s.sessionID,
		payload:    payload,
	}, s.downstreamDataSealer, &s.downstreamSeq)
	if err != nil {
		log.Printf("relay udp direct downstream seal failed tunnel=%d rule=%d upstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, err)
		s.close()
		return
	}
	for _, packet := range packets {
		if _, err := s.conn.WriteToUDP(packet, s.downstreamAddr); err != nil {
			log.Printf("relay udp direct downstream write failed tunnel=%d rule=%d downstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.downstreamAddr, err)
			s.close()
			return
		}
	}
	s.touch()
}

func (s *udpDirectRelaySession) forwardToUpstream(packet fxpUDPPacket) {
	payload, ok := s.returnFragments.accept(packet, &s.returnReplay)
	if !ok {
		return
	}
	s.touch()
	select {
	case <-s.done:
		return
	default:
		if s.upstreamSend.enqueue(payload) {
			fxpUDPDropLog.Printf("relay udp direct upstream queue congested tunnel=%d rule=%d upstream=%s; packet dropped", s.cfg.TunnelID, s.ruleID, s.upstreamAddr)
		}
	}
}

func (s *udpDirectRelaySession) upstreamWriteLoop() {
	defer observeFXPUDPSequence(&s.upstreamSeq)
	for {
		packet, ok := s.upstreamSend.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if packet.superseded(time.Now(), s.upstreamSend.pending()) {
			fxpUDPDropLog.Printf("relay udp direct upstream packet expired tunnel=%d rule=%d upstream=%s; dropping stale packet", s.cfg.TunnelID, s.ruleID, s.upstreamAddr)
			packet.done()
			continue
		}
		s.writeUpstream(packet.payload)
		packet.done()
	}
}

func (s *udpDirectRelaySession) writeUpstream(payload []byte) {
	packets, err := sealFXPUDPDatagramsWithCodec(fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   s.cfg.TunnelID,
		ruleID:     s.ruleID,
		sessionID:  s.sessionID,
		payload:    payload,
	}, s.upstreamReturnSealer, &s.upstreamSeq)
	if err != nil {
		log.Printf("relay udp direct upstream seal failed tunnel=%d rule=%d upstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, err)
		s.close()
		return
	}
	for _, packet := range packets {
		if _, err := s.conn.WriteToUDP(packet, s.upstreamAddr); err != nil {
			log.Printf("relay udp direct upstream write failed tunnel=%d rule=%d upstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, err)
			s.close()
			return
		}
	}
	s.touch()
}

func (s *udpDirectRelaySession) close() {
	s.closeOnce.Do(func() {
		observeFXPUDPSequence(&s.downstreamSeq)
		observeFXPUDPSequence(&s.upstreamSeq)
		close(s.done)
		s.downstreamSend.close()
		s.upstreamSend.close()
		s.dataFragments.close()
		s.returnFragments.close()
		if s.remove != nil {
			s.remove(s)
		}
	})
}

func pickUDPDirectEndpoint(selector *exitEndpointSelector, cfg config, selectionKey string) (exitEndpoint, int, *net.UDPAddr, error) {
	if selector == nil || selector.count() == 0 {
		return exitEndpoint{}, -1, nil, errors.New("no exit endpoints")
	}
	attempted := map[int]bool{}
	var lastErr error
	for len(attempted) < selector.count() {
		endpoint, index, ok := selector.pick(attempted, selectionKey)
		if !ok {
			break
		}
		attempted[index] = true
		udpPort := endpoint.UDPPort
		if udpPort <= 0 {
			udpPort = endpoint.Port
		}
		addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(endpoint.Host, strconv.Itoa(udpPort)))
		if err != nil {
			lastErr = err
			selector.markFailure(index, err)
			continue
		}
		selector.markHealthy(index)
		return endpoint, index, addr, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no exit endpoint available")
	}
	return exitEndpoint{}, -1, nil, lastErr
}

func newFXPUDPCodec(key string, packet fxpUDPPacket) (*fxpUDPCodec, error) {
	if err := validateFXPUDPContext(packet); err != nil {
		return nil, err
	}
	aead, err := fxpUDPAEAD(key, packet)
	if err != nil {
		return nil, err
	}
	return &fxpUDPCodec{
		packetType: packet.packetType,
		tunnelID:   packet.tunnelID,
		ruleID:     packet.ruleID,
		sessionID:  packet.sessionID,
		aead:       aead,
	}, nil
}

func (c *fxpUDPCodec) matches(packet fxpUDPPacket) bool {
	return c != nil && c.aead != nil &&
		packet.packetType == c.packetType &&
		packet.tunnelID == c.tunnelID &&
		packet.ruleID == c.ruleID &&
		packet.sessionID == c.sessionID
}

func (c *fxpUDPCodec) sealPacket(packet fxpUDPPacket) ([]byte, error) {
	if !c.matches(packet) {
		return nil, errors.New("udp packet does not match cached encryption context")
	}
	if len(packet.payload) > fxpUDPMaxSinglePayload {
		return nil, fmt.Errorf("udp payload too large: %d", len(packet.payload))
	}
	header, err := fxpUDPHeader(packet)
	if err != nil {
		return nil, err
	}
	ciphertext := c.aead.Seal(nil, fxpUDPNonce(packet.sequence, packet.fragment), packet.payload, header)
	return append(header, ciphertext...), nil
}

func sealFXPUDPPacket(packet fxpUDPPacket, key string) ([]byte, error) {
	codec, err := newFXPUDPCodec(key, packet)
	if err != nil {
		return nil, err
	}
	return codec.sealPacket(packet)
}

func parseFXPUDPHeader(raw []byte) (fxpUDPPacket, error) {
	if len(raw) < fxpUDPHeaderSize+fxpUDPAuthTagSize {
		return fxpUDPPacket{}, errors.New("udp packet too small")
	}
	if !fxpUDPHasMagic(raw) || raw[4] != fxpUDPVersion {
		return fxpUDPPacket{}, errors.New("invalid udp packet header")
	}
	packet := fxpUDPPacket{
		packetType: raw[5],
		fragment:   raw[6],
		fragments:  raw[7],
		tunnelID:   int(binary.BigEndian.Uint32(raw[8:12])),
		ruleID:     int(binary.BigEndian.Uint32(raw[12:16])),
		sessionID:  binary.BigEndian.Uint64(raw[16:24]),
		sequence:   binary.BigEndian.Uint64(raw[24:32]),
	}
	if err := validateFXPUDPPacket(packet); err != nil {
		return fxpUDPPacket{}, err
	}
	return packet, nil
}

func (c *fxpUDPCodec) openParsedPacket(raw []byte, packet fxpUDPPacket) (fxpUDPPacket, error) {
	if !c.matches(packet) {
		return fxpUDPPacket{}, errors.New("udp packet does not match cached decryption context")
	}
	payload, err := c.aead.Open(nil, fxpUDPNonce(packet.sequence, packet.fragment), raw[fxpUDPHeaderSize:], raw[:fxpUDPHeaderSize])
	if err != nil {
		return fxpUDPPacket{}, errors.New("invalid udp packet authentication")
	}
	packet.payload = payload
	return packet, nil
}

func (c *fxpUDPCodec) openPacket(raw []byte) (fxpUDPPacket, error) {
	packet, err := parseFXPUDPHeader(raw)
	if err != nil {
		return fxpUDPPacket{}, err
	}
	return c.openParsedPacket(raw, packet)
}

func openFXPUDPPacket(raw []byte, key string) (fxpUDPPacket, error) {
	packet, err := parseFXPUDPHeader(raw)
	if err != nil {
		return fxpUDPPacket{}, err
	}
	codec, err := newFXPUDPCodec(key, packet)
	if err != nil {
		return fxpUDPPacket{}, err
	}
	return codec.openParsedPacket(raw, packet)
}

func validateFXPUDPContext(packet fxpUDPPacket) error {
	if packet.packetType != fxpUDPTypeData && packet.packetType != fxpUDPTypeReturn {
		return errors.New("invalid udp packet type")
	}
	if packet.tunnelID < 0 || packet.ruleID < 0 || packet.sessionID == 0 {
		return errors.New("invalid udp packet fields")
	}
	return nil
}

func validateFXPUDPPacket(packet fxpUDPPacket) error {
	if err := validateFXPUDPContext(packet); err != nil {
		return err
	}
	if packet.sequence == 0 {
		return errors.New("invalid udp packet fields")
	}
	if !validFXPUDPFragmentMetadata(packet.fragment, packet.fragments) {
		return errors.New("invalid udp fragment metadata")
	}
	return nil
}

func fxpUDPHeader(packet fxpUDPPacket) ([]byte, error) {
	if err := validateFXPUDPPacket(packet); err != nil {
		return nil, err
	}
	header := make([]byte, fxpUDPHeaderSize)
	copy(header[0:4], []byte(fxpUDPMagic))
	header[4] = fxpUDPVersion
	header[5] = packet.packetType
	header[6] = packet.fragment
	header[7] = packet.fragments
	binary.BigEndian.PutUint32(header[8:12], uint32(packet.tunnelID))
	binary.BigEndian.PutUint32(header[12:16], uint32(packet.ruleID))
	binary.BigEndian.PutUint64(header[16:24], packet.sessionID)
	binary.BigEndian.PutUint64(header[24:32], packet.sequence)
	return header, nil
}

func fxpUDPAEAD(key string, packet fxpUDPPacket) (cipher.AEAD, error) {
	if key == "" {
		return nil, errors.New("empty udp key")
	}
	context := make([]byte, 1+4+4+8)
	context[0] = packet.packetType
	binary.BigEndian.PutUint32(context[1:5], uint32(packet.tunnelID))
	binary.BigEndian.PutUint32(context[5:9], uint32(packet.ruleID))
	binary.BigEndian.PutUint64(context[9:17], packet.sessionID)
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte("forwardx-fxp-udp-v3/aead/"))
	_, _ = mac.Write(context)
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func fxpUDPNonce(sequence uint64, fragment uint8) []byte {
	nonce := make([]byte, 12)
	nonce[3] = fragment
	binary.BigEndian.PutUint64(nonce[4:], sequence)
	return nonce
}

func fxpUDPHasMagic(raw []byte) bool {
	return len(raw) >= fxpUDPHeaderSize && string(raw[0:4]) == fxpUDPMagic
}

func fxpUDPSessionID(raw []byte) (uint64, bool) {
	if !fxpUDPHasMagic(raw) || raw[4] != fxpUDPVersion {
		return 0, false
	}
	return binary.BigEndian.Uint64(raw[16:24]), true
}

func packetMatchesConfig(packet fxpUDPPacket, cfg config) bool {
	if packet.tunnelID != cfg.TunnelID {
		return false
	}
	return cfg.RuleID <= 0 || packet.ruleID == cfg.RuleID
}

func udpTargetForRule(cfg config, ruleID int) (udpTarget, bool) {
	for _, target := range cfg.UDPTargets {
		if target.RuleID == ruleID {
			return target, true
		}
	}
	return udpTarget{}, false
}

func udpEndpointKey(endpoint exitEndpoint, fallback string) string {
	if endpoint.Key != "" {
		return endpoint.Key
	}
	return fallback
}

func randomUint64() (uint64, error) {
	var b [8]byte
	for i := 0; i < 4; i++ {
		if _, err := rand.Read(b[:]); err != nil {
			return 0, err
		}
		value := binary.BigEndian.Uint64(b[:])
		if value != 0 {
			return value, nil
		}
	}
	return 0, errors.New("random session id is zero")
}

func udpSessionKey(addr *net.UDPAddr, sessionID uint64) string {
	if addr == nil {
		return strconv.FormatUint(sessionID, 10)
	}
	return addr.String() + "|" + strconv.FormatUint(sessionID, 10)
}

func udpRuleSessionKey(addr *net.UDPAddr, ruleID int, sessionID uint64) string {
	return strconv.Itoa(ruleID) + "|" + udpSessionKey(addr, sessionID)
}

func udpAddrEqual(a, b *net.UDPAddr) bool {
	if a == nil || b == nil {
		return false
	}
	return a.Port == b.Port && a.IP.Equal(b.IP) && a.Zone == b.Zone
}
