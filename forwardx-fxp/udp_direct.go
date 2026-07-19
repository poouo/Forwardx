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
	stopReporting   func()
	send            chan []byte
	recv            chan []byte
	done            chan struct{}
	closeOnce       sync.Once
	lastActivity    atomic.Int64
	sendSequence    atomic.Uint64
	returnReplay    udpReplayWindow
	returnFragments udpFragmentReassembler
	remove          func(*udpDirectEntrySession)
}

type udpDirectExitSession struct {
	key           string
	sessionID     uint64
	peerAddr      *net.UDPAddr
	conn          *net.UDPConn
	target        *net.UDPConn
	send          chan []byte
	cfg           config
	ruleID        int
	targetIP      string
	targetPort    int
	done          chan struct{}
	closeOnce     sync.Once
	lastActivity  atomic.Int64
	sendSequence  atomic.Uint64
	dataReplay    udpReplayWindow
	dataFragments udpFragmentReassembler
	remove        func(*udpDirectExitSession)
}

type udpDirectRelaySession struct {
	key             string
	sessionID       uint64
	upstreamAddr    *net.UDPAddr
	downstreamAddr  *net.UDPAddr
	conn            *net.UDPConn
	cfg             config
	ruleID          int
	endpoint        exitEndpoint
	endpointIndex   int
	downstreamSend  chan []byte
	upstreamSend    chan []byte
	done            chan struct{}
	closeOnce       sync.Once
	lastActivity    atomic.Int64
	downstreamSeq   atomic.Uint64
	upstreamSeq     atomic.Uint64
	dataReplay      udpReplayWindow
	returnReplay    udpReplayWindow
	dataFragments   udpFragmentReassembler
	returnFragments udpFragmentReassembler
	remove          func(*udpDirectRelaySession)
}

func serveEntryUDPDirect(conn *net.UDPConn, cfg config, selector *exitEndpointSelector, inLimiter, outLimiter *limiter) error {
	sessionsByClient := map[string]*udpDirectEntrySession{}
	sessionsByID := map[uint64]*udpDirectEntrySession{}
	var sessionsMu sync.Mutex
	removeSession := func(session *udpDirectEntrySession) {
		sessionsMu.Lock()
		if sessionsByClient[session.key] == session {
			delete(sessionsByClient, session.key)
		}
		if sessionsByID[session.sessionID] == session {
			delete(sessionsByID, session.sessionID)
		}
		sessionsMu.Unlock()
	}
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
			return err
		}
		if fxpUDPHasMagic(buf[:n]) {
			handledReturn := false
			if sessionID, ok := fxpUDPSessionID(buf[:n]); ok {
				sessionsMu.Lock()
				session := sessionsByID[sessionID]
				sessionsMu.Unlock()
				if session != nil && udpAddrEqual(addr, session.remoteAddr) {
					packet, err := openFXPUDPPacket(buf[:n], udpEndpointKey(session.endpoint, session.cfg.Key))
					if err == nil && packet.packetType == fxpUDPTypeReturn && packetMatchesConfig(packet, cfg) {
						session.handleResponse(packet)
						handledReturn = true
					}
				}
			}
			if handledReturn {
				continue
			}
		}
		payload := append([]byte(nil), buf[:n]...)
		key := addr.String()
		sessionsMu.Lock()
		session := sessionsByClient[key]
		sessionsMu.Unlock()
		startSession := false
		if session == nil {
			created, err := newUDPDirectEntrySession(conn, addr, cfg, selector, inLimiter, outLimiter, removeSession)
			if err != nil {
				if !isClosedErr(err) {
					log.Printf("entry udp direct session create failed tunnel=%d rule=%d client=%s: %v", cfg.TunnelID, cfg.RuleID, addr, err)
				}
				continue
			}
			var closeCreated *udpDirectEntrySession
			sessionsMu.Lock()
			if existing := sessionsByClient[key]; existing != nil {
				session = existing
				closeCreated = created
			} else if existing := sessionsByID[created.sessionID]; existing != nil {
				session = existing
				closeCreated = created
			} else {
				sessionsByClient[key] = created
				sessionsByID[created.sessionID] = created
				session = created
				startSession = true
			}
			sessionsMu.Unlock()
			if closeCreated != nil {
				closeCreated.close()
			}
		}
		if startSession {
			session.start()
		}
		session.enqueue(payload)
	}
}

func newUDPDirectEntrySession(conn *net.UDPConn, clientAddr *net.UDPAddr, cfg config, selector *exitEndpointSelector, inLimiter, outLimiter *limiter, remove func(*udpDirectEntrySession)) (*udpDirectEntrySession, error) {
	endpoint, index, remoteAddr, err := pickUDPDirectEndpoint(selector, cfg, clientAddr.IP.String())
	if err != nil {
		return nil, err
	}
	sessionID, err := randomUint64()
	if err != nil {
		return nil, err
	}
	counter := &trafficCounter{}
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
		stopReporting: startTrafficReporter(cfg, counter),
		send:          make(chan []byte, fxpUDPDirectQueueSize),
		recv:          make(chan []byte, fxpUDPDirectQueueSize),
		done:          make(chan struct{}),
		remove:        remove,
	}
	session.touch()
	return session, nil
}

func (s *udpDirectEntrySession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpDirectEntrySession) start() {
	go s.writeLoop()
	go s.clientWriteLoop()
	go s.idleLoop()
	log.Printf("entry udp direct session started tunnel=%d rule=%d client=%s exit=%s:%d target=%s:%d session=%d", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, s.endpoint.Host, s.endpoint.Port, s.cfg.TargetIP, s.cfg.TargetPort, s.sessionID)
}

func (s *udpDirectEntrySession) enqueue(payload []byte) {
	select {
	case <-s.done:
		return
	case s.send <- payload:
	default:
		fxpUDPDropLog.Printf("entry udp direct queue full tunnel=%d rule=%d client=%s; dropping packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
	}
}

func (s *udpDirectEntrySession) writeLoop() {
	for {
		select {
		case <-s.done:
			return
		case payload := <-s.send:
			s.touch()
			s.inLimiter.wait(len(payload))
			packets, err := sealFXPUDPDatagrams(fxpUDPPacket{
				packetType: fxpUDPTypeData,
				tunnelID:   s.cfg.TunnelID,
				ruleID:     s.cfg.RuleID,
				sessionID:  s.sessionID,
				payload:    payload,
			}, udpEndpointKey(s.endpoint, s.cfg.Key), &s.sendSequence)
			if err != nil {
				log.Printf("entry udp direct seal failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
				s.close()
				return
			}
			for _, packet := range packets {
				if _, err := s.conn.WriteToUDP(packet, s.remoteAddr); err != nil {
					log.Printf("entry udp direct send failed tunnel=%d rule=%d client=%s exit=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, s.remoteAddr, err)
					s.close()
					return
				}
			}
			s.counter.in.Add(uint64(len(payload)))
		}
	}
}

func (s *udpDirectEntrySession) handleResponse(packet fxpUDPPacket) {
	payload, ok := s.returnFragments.accept(packet, &s.returnReplay)
	if !ok {
		return
	}
	select {
	case <-s.done:
		return
	case s.recv <- payload:
	default:
		fxpUDPDropLog.Printf("entry udp direct response queue full tunnel=%d rule=%d client=%s; dropping packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
	}
}

func (s *udpDirectEntrySession) clientWriteLoop() {
	for {
		select {
		case <-s.done:
			return
		case payload := <-s.recv:
			s.writeResponse(payload)
		}
	}
}

func (s *udpDirectEntrySession) writeResponse(payload []byte) {
	s.outLimiter.wait(len(payload))
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

func (s *udpDirectEntrySession) idleLoop() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			last := time.Unix(0, s.lastActivity.Load())
			if time.Since(last) >= fxpUDPIdleTimeout {
				log.Printf("entry udp direct session idle timeout tunnel=%d rule=%d client=%s idle=%s", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, time.Since(last).Round(time.Second))
				s.close()
				return
			}
		}
	}
}

func (s *udpDirectEntrySession) close() {
	s.closeOnce.Do(func() {
		close(s.done)
		if s.stopReporting != nil {
			s.stopReporting()
		}
		if s.remove != nil {
			s.remove(s)
		}
	})
}

func serveExitUDPDirect(conn *net.UDPConn, cfg config) error {
	sessions := map[string]*udpDirectExitSession{}
	var sessionsMu sync.Mutex
	removeSession := func(session *udpDirectExitSession) {
		sessionsMu.Lock()
		if sessions[session.key] == session {
			delete(sessions, session.key)
		}
		sessionsMu.Unlock()
	}
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
			return err
		}
		packet, err := openFXPUDPPacket(buf[:n], cfg.Key)
		if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) {
			continue
		}
		target, ok := udpTargetForRule(cfg, packet.ruleID)
		if !ok {
			fxpUDPDropLog.Printf("exit udp direct target missing tunnel=%d rule=%d peer=%s", cfg.TunnelID, packet.ruleID, peerAddr)
			continue
		}
		key := udpSessionKey(peerAddr, packet.sessionID)
		var closeStale *udpDirectExitSession
		sessionsMu.Lock()
		session := sessions[key]
		if session != nil && (session.targetIP != target.TargetIP || session.targetPort != target.TargetPort) {
			closeStale = session
			session = nil
		}
		sessionsMu.Unlock()
		if closeStale != nil {
			closeStale.close()
		}
		if session == nil {
			created, err := newUDPDirectExitSession(conn, peerAddr, cfg, packet.ruleID, packet.sessionID, target.TargetIP, target.TargetPort, removeSession)
			if err != nil {
				log.Printf("exit udp direct session create failed tunnel=%d rule=%d peer=%s target=%s:%d: %v", cfg.TunnelID, packet.ruleID, peerAddr, target.TargetIP, target.TargetPort, err)
				continue
			}
			var closeCreated *udpDirectExitSession
			sessionsMu.Lock()
			if existing := sessions[key]; existing != nil {
				session = existing
				closeCreated = created
			} else {
				sessions[key] = created
				session = created
				session.start()
			}
			sessionsMu.Unlock()
			if closeCreated != nil {
				closeCreated.close()
			}
		}
		payload, ok := session.dataFragments.accept(packet, &session.dataReplay)
		if !ok {
			continue
		}
		session.forwardToTarget(payload)
	}
}

func newUDPDirectExitSession(conn *net.UDPConn, peerAddr *net.UDPAddr, cfg config, ruleID int, sessionID uint64, targetIP string, targetPort int, remove func(*udpDirectExitSession)) (*udpDirectExitSession, error) {
	targetAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(targetIP, strconv.Itoa(targetPort)))
	if err != nil {
		return nil, err
	}
	target, err := net.DialUDP("udp", nil, targetAddr)
	if err != nil {
		return nil, err
	}
	tuneUDPConn(target, "exit target", fxpUDPSessionBufferBytes)
	session := &udpDirectExitSession{
		key:        udpSessionKey(peerAddr, sessionID),
		sessionID:  sessionID,
		peerAddr:   peerAddr,
		conn:       conn,
		target:     target,
		send:       make(chan []byte, fxpUDPDirectQueueSize),
		cfg:        cfg,
		ruleID:     ruleID,
		targetIP:   targetIP,
		targetPort: targetPort,
		done:       make(chan struct{}),
		remove:     remove,
	}
	session.touch()
	return session, nil
}

func (s *udpDirectExitSession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpDirectExitSession) start() {
	go s.writeTargetLoop()
	go s.readTargetLoop()
	go s.idleLoop()
	log.Printf("exit udp direct session routed tunnel=%d rule=%d peer=%s target=%s:%d session=%d", s.cfg.TunnelID, s.ruleID, s.peerAddr, s.targetIP, s.targetPort, s.sessionID)
}

func (s *udpDirectExitSession) forwardToTarget(payload []byte) {
	select {
	case <-s.done:
		return
	case s.send <- payload:
	default:
		fxpUDPDropLog.Printf("exit udp direct target queue full tunnel=%d rule=%d peer=%s target=%s:%d; dropping packet", s.cfg.TunnelID, s.ruleID, s.peerAddr, s.targetIP, s.targetPort)
	}
}

func (s *udpDirectExitSession) writeTargetLoop() {
	for {
		select {
		case <-s.done:
			return
		case payload := <-s.send:
			s.writeTarget(payload)
		}
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
		packets, err := sealFXPUDPDatagrams(fxpUDPPacket{
			packetType: fxpUDPTypeReturn,
			tunnelID:   s.cfg.TunnelID,
			ruleID:     s.ruleID,
			sessionID:  s.sessionID,
			payload:    append([]byte(nil), buf[:n]...),
		}, s.cfg.Key, &s.sendSequence)
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

func (s *udpDirectExitSession) idleLoop() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			last := time.Unix(0, s.lastActivity.Load())
			if time.Since(last) >= fxpUDPIdleTimeout {
				log.Printf("exit udp direct session idle timeout tunnel=%d rule=%d peer=%s idle=%s", s.cfg.TunnelID, s.ruleID, s.peerAddr, time.Since(last).Round(time.Second))
				s.close()
				return
			}
		}
	}
}

func (s *udpDirectExitSession) close() {
	s.closeOnce.Do(func() {
		close(s.done)
		_ = s.target.Close()
		if s.remove != nil {
			s.remove(s)
		}
	})
}

func serveRelayUDPDirect(conn *net.UDPConn, cfg config, selector *exitEndpointSelector) error {
	sessionsByUpstream := map[string]*udpDirectRelaySession{}
	sessionsByID := map[uint64]*udpDirectRelaySession{}
	var sessionsMu sync.Mutex
	removeSession := func(session *udpDirectRelaySession) {
		sessionsMu.Lock()
		if sessionsByUpstream[session.key] == session {
			delete(sessionsByUpstream, session.key)
		}
		if sessionsByID[session.sessionID] == session {
			delete(sessionsByID, session.sessionID)
		}
		sessionsMu.Unlock()
	}
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
		sessionsMu.Unlock()
		if session != nil && udpAddrEqual(addr, session.downstreamAddr) {
			packet, err := openFXPUDPPacket(buf[:n], udpEndpointKey(session.endpoint, session.cfg.RelayKey))
			if err == nil && packet.packetType == fxpUDPTypeReturn && packetMatchesConfig(packet, cfg) {
				session.forwardToUpstream(packet)
			}
			continue
		}
		packet, err := openFXPUDPPacket(buf[:n], cfg.Key)
		if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) {
			continue
		}
		key := udpSessionKey(addr, packet.sessionID)
		sessionsMu.Lock()
		session = sessionsByUpstream[key]
		sessionsMu.Unlock()
		if session == nil {
			created, err := newUDPDirectRelaySession(conn, addr, cfg, selector, packet.ruleID, packet.sessionID, removeSession)
			if err != nil {
				log.Printf("relay udp direct session create failed tunnel=%d rule=%d upstream=%s: %v", cfg.TunnelID, packet.ruleID, addr, err)
				continue
			}
			var closeCreated *udpDirectRelaySession
			sessionsMu.Lock()
			if existing := sessionsByUpstream[key]; existing != nil {
				session = existing
				closeCreated = created
			} else if existing := sessionsByID[created.sessionID]; existing != nil {
				session = existing
				closeCreated = created
			} else {
				sessionsByUpstream[key] = created
				sessionsByID[created.sessionID] = created
				session = created
				session.start()
			}
			sessionsMu.Unlock()
			if closeCreated != nil {
				closeCreated.close()
			}
		}
		session.forwardToDownstream(packet)
	}
}

func newUDPDirectRelaySession(conn *net.UDPConn, upstreamAddr *net.UDPAddr, cfg config, selector *exitEndpointSelector, ruleID int, sessionID uint64, remove func(*udpDirectRelaySession)) (*udpDirectRelaySession, error) {
	endpoint, index, downstreamAddr, err := pickUDPDirectEndpoint(selector, cfg, strconv.FormatUint(sessionID, 10))
	if err != nil {
		return nil, err
	}
	session := &udpDirectRelaySession{
		key:            udpSessionKey(upstreamAddr, sessionID),
		sessionID:      sessionID,
		upstreamAddr:   upstreamAddr,
		downstreamAddr: downstreamAddr,
		conn:           conn,
		cfg:            cfg,
		ruleID:         ruleID,
		endpoint:       endpoint,
		endpointIndex:  index,
		downstreamSend: make(chan []byte, fxpUDPDirectQueueSize),
		upstreamSend:   make(chan []byte, fxpUDPDirectQueueSize),
		done:           make(chan struct{}),
		remove:         remove,
	}
	session.touch()
	return session, nil
}

func (s *udpDirectRelaySession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpDirectRelaySession) start() {
	go s.downstreamWriteLoop()
	go s.upstreamWriteLoop()
	go s.idleLoop()
	log.Printf("relay udp direct session routed tunnel=%d rule=%d upstream=%s downstream=%s:%d session=%d", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, s.endpoint.Host, s.endpoint.Port, s.sessionID)
}

func (s *udpDirectRelaySession) forwardToDownstream(packet fxpUDPPacket) {
	payload, ok := s.dataFragments.accept(packet, &s.dataReplay)
	if !ok {
		return
	}
	select {
	case <-s.done:
		return
	case s.downstreamSend <- payload:
	default:
		fxpUDPDropLog.Printf("relay udp direct downstream queue full tunnel=%d rule=%d upstream=%s downstream=%s; dropping packet", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, s.downstreamAddr)
	}
}

func (s *udpDirectRelaySession) downstreamWriteLoop() {
	for {
		select {
		case <-s.done:
			return
		case payload := <-s.downstreamSend:
			s.writeDownstream(payload)
		}
	}
}

func (s *udpDirectRelaySession) writeDownstream(payload []byte) {
	packets, err := sealFXPUDPDatagrams(fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   s.cfg.TunnelID,
		ruleID:     s.ruleID,
		sessionID:  s.sessionID,
		payload:    payload,
	}, udpEndpointKey(s.endpoint, s.cfg.RelayKey), &s.downstreamSeq)
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
	select {
	case <-s.done:
		return
	case s.upstreamSend <- payload:
	default:
		fxpUDPDropLog.Printf("relay udp direct upstream queue full tunnel=%d rule=%d upstream=%s; dropping packet", s.cfg.TunnelID, s.ruleID, s.upstreamAddr)
	}
}

func (s *udpDirectRelaySession) upstreamWriteLoop() {
	for {
		select {
		case <-s.done:
			return
		case payload := <-s.upstreamSend:
			s.writeUpstream(payload)
		}
	}
}

func (s *udpDirectRelaySession) writeUpstream(payload []byte) {
	packets, err := sealFXPUDPDatagrams(fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   s.cfg.TunnelID,
		ruleID:     s.ruleID,
		sessionID:  s.sessionID,
		payload:    payload,
	}, s.cfg.Key, &s.upstreamSeq)
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

func (s *udpDirectRelaySession) idleLoop() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			last := time.Unix(0, s.lastActivity.Load())
			if time.Since(last) >= fxpUDPIdleTimeout {
				log.Printf("relay udp direct session idle timeout tunnel=%d rule=%d upstream=%s idle=%s", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, time.Since(last).Round(time.Second))
				s.close()
				return
			}
		}
	}
}

func (s *udpDirectRelaySession) close() {
	s.closeOnce.Do(func() {
		close(s.done)
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

func sealFXPUDPPacket(packet fxpUDPPacket, key string) ([]byte, error) {
	if len(packet.payload) > fxpUDPMaxSinglePayload {
		return nil, fmt.Errorf("udp payload too large: %d", len(packet.payload))
	}
	header, err := fxpUDPHeader(packet)
	if err != nil {
		return nil, err
	}
	aead, err := fxpUDPAEAD(key, packet)
	if err != nil {
		return nil, err
	}
	ciphertext := aead.Seal(nil, fxpUDPNonce(packet.sequence, packet.fragment), packet.payload, header)
	return append(header, ciphertext...), nil
}

func openFXPUDPPacket(raw []byte, key string) (fxpUDPPacket, error) {
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
	if _, err := fxpUDPHeader(packet); err != nil {
		return fxpUDPPacket{}, err
	}
	aead, err := fxpUDPAEAD(key, packet)
	if err != nil {
		return fxpUDPPacket{}, err
	}
	payload, err := aead.Open(nil, fxpUDPNonce(packet.sequence, packet.fragment), raw[fxpUDPHeaderSize:], raw[:fxpUDPHeaderSize])
	if err != nil {
		return fxpUDPPacket{}, errors.New("invalid udp packet authentication")
	}
	packet.payload = payload
	return packet, nil
}

func fxpUDPHeader(packet fxpUDPPacket) ([]byte, error) {
	if packet.packetType != fxpUDPTypeData && packet.packetType != fxpUDPTypeReturn {
		return nil, errors.New("invalid udp packet type")
	}
	if packet.tunnelID < 0 || packet.ruleID < 0 || packet.sessionID == 0 || packet.sequence == 0 {
		return nil, errors.New("invalid udp packet fields")
	}
	if !validFXPUDPFragmentMetadata(packet.fragment, packet.fragments) {
		return nil, errors.New("invalid udp fragment metadata")
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

func udpAddrEqual(a, b *net.UDPAddr) bool {
	if a == nil || b == nil {
		return false
	}
	return a.Port == b.Port && a.IP.Equal(b.IP) && a.Zone == b.Zone
}
