package main

import (
	"crypto/cipher"
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
	fxpUDPVersion    = byte(1)
	fxpUDPTypeData   = byte(1)
	fxpUDPTypeReturn = byte(2)
	fxpUDPHeaderSize = 36
	fxpUDPMaxPayload = 65535 - fxpUDPHeaderSize - 16
)

var (
	fxpUDPContext = []byte("forwardx-fxp-v2 udp datagram")
	fxpUDPAD      = []byte("forwardx-fxp-v2 udp header")
)

type fxpUDPPacket struct {
	packetType byte
	tunnelID   int
	ruleID     int
	sessionID  uint64
	payload    []byte
}

type udpDirectEntrySession struct {
	key           string
	sessionID     uint64
	clientAddr    *net.UDPAddr
	conn          *net.UDPConn
	remoteAddr    *net.UDPAddr
	endpoint      exitEndpoint
	endpointIndex int
	aead          cipher.AEAD
	cfg           config
	inLimiter     *limiter
	outLimiter    *limiter
	counter       *trafficCounter
	stopReporting func()
	send          chan []byte
	done          chan struct{}
	closeOnce     sync.Once
	lastActivity  atomic.Int64
	remove        func(*udpDirectEntrySession)
}

type udpDirectExitSession struct {
	key          string
	sessionID    uint64
	peerAddr     *net.UDPAddr
	conn         *net.UDPConn
	target       *net.UDPConn
	aead         cipher.AEAD
	cfg          config
	ruleID       int
	targetIP     string
	targetPort   int
	done         chan struct{}
	closeOnce    sync.Once
	lastActivity atomic.Int64
	remove       func(*udpDirectExitSession)
}

type udpDirectRelaySession struct {
	key            string
	sessionID      uint64
	upstreamAddr   *net.UDPAddr
	downstreamAddr *net.UDPAddr
	conn           *net.UDPConn
	upstreamAEAD   cipher.AEAD
	downstreamAEAD cipher.AEAD
	cfg            config
	ruleID         int
	endpoint       exitEndpoint
	endpointIndex  int
	done           chan struct{}
	closeOnce      sync.Once
	lastActivity   atomic.Int64
	remove         func(*udpDirectRelaySession)
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
		payload := append([]byte(nil), buf[:n]...)
		if fxpUDPHasMagic(payload) {
			handledReturn := false
			if sessionID, ok := fxpUDPSessionID(payload); ok {
				sessionsMu.Lock()
				session := sessionsByID[sessionID]
				sessionsMu.Unlock()
				if session != nil && udpAddrEqual(addr, session.remoteAddr) {
					packet, err := openFXPUDPPacket(session.aead, payload)
					if err == nil && packet.packetType == fxpUDPTypeReturn && packetMatchesConfig(packet, cfg) {
						session.handleResponse(packet.payload)
						handledReturn = true
					}
				}
			}
			if handledReturn {
				continue
			}
		}
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
	endpoint, index, remoteAddr, aead, err := pickUDPDirectEndpoint(selector, cfg)
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
		aead:          aead,
		cfg:           cfg,
		inLimiter:     inLimiter,
		outLimiter:    outLimiter,
		counter:       counter,
		stopReporting: startTrafficReporter(cfg, counter),
		send:          make(chan []byte, 512),
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
	go s.idleLoop()
	log.Printf("entry udp direct session started tunnel=%d rule=%d client=%s exit=%s:%d target=%s:%d session=%d", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, s.endpoint.Host, s.endpoint.Port, s.cfg.TargetIP, s.cfg.TargetPort, s.sessionID)
}

func (s *udpDirectEntrySession) enqueue(payload []byte) {
	select {
	case <-s.done:
		return
	case s.send <- payload:
	default:
		log.Printf("entry udp direct queue full tunnel=%d rule=%d client=%s; dropping packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
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
			forwardPayload, err := encodeUDPForwardPayload(s.cfg.TargetIP, s.cfg.TargetPort, payload)
			if err != nil {
				log.Printf("entry udp direct encode failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
				s.close()
				return
			}
			packet, err := sealFXPUDPPacket(s.aead, fxpUDPPacket{
				packetType: fxpUDPTypeData,
				tunnelID:   s.cfg.TunnelID,
				ruleID:     s.cfg.RuleID,
				sessionID:  s.sessionID,
				payload:    forwardPayload,
			})
			if err != nil {
				log.Printf("entry udp direct seal failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
				s.close()
				return
			}
			if _, err := s.conn.WriteToUDP(packet, s.remoteAddr); err != nil {
				log.Printf("entry udp direct send failed tunnel=%d rule=%d client=%s exit=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, s.remoteAddr, err)
				s.close()
				return
			}
			s.counter.in.Add(uint64(len(payload)))
		}
	}
}

func (s *udpDirectEntrySession) handleResponse(payload []byte) {
	select {
	case <-s.done:
		return
	default:
	}
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
	aead, err := newFXPUDPAEAD(cfg.Key)
	if err != nil {
		return err
	}
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
		packet, err := openFXPUDPPacket(aead, buf[:n])
		if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) {
			continue
		}
		targetIP, targetPort, payload, err := decodeUDPForwardPayload(packet.payload)
		if err != nil {
			log.Printf("exit udp direct decode failed tunnel=%d rule=%d peer=%s: %v", cfg.TunnelID, packet.ruleID, peerAddr, err)
			continue
		}
		key := udpSessionKey(peerAddr, packet.sessionID)
		var closeStale *udpDirectExitSession
		sessionsMu.Lock()
		session := sessions[key]
		if session != nil && (session.targetIP != targetIP || session.targetPort != targetPort) {
			closeStale = session
			session = nil
		}
		sessionsMu.Unlock()
		if closeStale != nil {
			closeStale.close()
		}
		if session == nil {
			created, err := newUDPDirectExitSession(conn, peerAddr, cfg, aead, packet.ruleID, packet.sessionID, targetIP, targetPort, removeSession)
			if err != nil {
				log.Printf("exit udp direct session create failed tunnel=%d rule=%d peer=%s target=%s:%d: %v", cfg.TunnelID, packet.ruleID, peerAddr, targetIP, targetPort, err)
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
		session.forwardToTarget(payload)
	}
}

func newUDPDirectExitSession(conn *net.UDPConn, peerAddr *net.UDPAddr, cfg config, aead cipher.AEAD, ruleID int, sessionID uint64, targetIP string, targetPort int, remove func(*udpDirectExitSession)) (*udpDirectExitSession, error) {
	targetAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(targetIP, strconv.Itoa(targetPort)))
	if err != nil {
		return nil, err
	}
	target, err := net.DialUDP("udp", nil, targetAddr)
	if err != nil {
		return nil, err
	}
	session := &udpDirectExitSession{
		key:        udpSessionKey(peerAddr, sessionID),
		sessionID:  sessionID,
		peerAddr:   peerAddr,
		conn:       conn,
		target:     target,
		aead:       aead,
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
	go s.readTargetLoop()
	go s.idleLoop()
	log.Printf("exit udp direct session routed tunnel=%d rule=%d peer=%s target=%s:%d session=%d", s.cfg.TunnelID, s.ruleID, s.peerAddr, s.targetIP, s.targetPort, s.sessionID)
}

func (s *udpDirectExitSession) forwardToTarget(payload []byte) {
	select {
	case <-s.done:
		return
	default:
	}
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
		packet, err := sealFXPUDPPacket(s.aead, fxpUDPPacket{
			packetType: fxpUDPTypeReturn,
			tunnelID:   s.cfg.TunnelID,
			ruleID:     s.ruleID,
			sessionID:  s.sessionID,
			payload:    append([]byte(nil), buf[:n]...),
		})
		if err != nil {
			log.Printf("exit udp direct seal failed tunnel=%d rule=%d peer=%s: %v", s.cfg.TunnelID, s.ruleID, s.peerAddr, err)
			s.close()
			return
		}
		if _, err := s.conn.WriteToUDP(packet, s.peerAddr); err != nil {
			log.Printf("exit udp direct peer write failed tunnel=%d rule=%d peer=%s: %v", s.cfg.TunnelID, s.ruleID, s.peerAddr, err)
			s.close()
			return
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
	upstreamAEAD, err := newFXPUDPAEAD(cfg.Key)
	if err != nil {
		return err
	}
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
		raw := append([]byte(nil), buf[:n]...)
		if !fxpUDPHasMagic(raw) {
			continue
		}
		sessionID, ok := fxpUDPSessionID(raw)
		if !ok {
			continue
		}
		sessionsMu.Lock()
		session := sessionsByID[sessionID]
		sessionsMu.Unlock()
		if session != nil && udpAddrEqual(addr, session.downstreamAddr) {
			packet, err := openFXPUDPPacket(session.downstreamAEAD, raw)
			if err == nil && packet.packetType == fxpUDPTypeReturn && packetMatchesConfig(packet, cfg) {
				session.forwardToUpstream(packet.payload)
			}
			continue
		}
		packet, err := openFXPUDPPacket(upstreamAEAD, raw)
		if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) {
			continue
		}
		key := udpSessionKey(addr, packet.sessionID)
		sessionsMu.Lock()
		session = sessionsByUpstream[key]
		sessionsMu.Unlock()
		if session == nil {
			created, err := newUDPDirectRelaySession(conn, addr, cfg, selector, upstreamAEAD, packet.ruleID, packet.sessionID, removeSession)
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
		session.forwardToDownstream(packet.payload)
	}
}

func newUDPDirectRelaySession(conn *net.UDPConn, upstreamAddr *net.UDPAddr, cfg config, selector *exitEndpointSelector, upstreamAEAD cipher.AEAD, ruleID int, sessionID uint64, remove func(*udpDirectRelaySession)) (*udpDirectRelaySession, error) {
	endpoint, index, downstreamAddr, downstreamAEAD, err := pickUDPDirectEndpoint(selector, cfg)
	if err != nil {
		return nil, err
	}
	session := &udpDirectRelaySession{
		key:            udpSessionKey(upstreamAddr, sessionID),
		sessionID:      sessionID,
		upstreamAddr:   upstreamAddr,
		downstreamAddr: downstreamAddr,
		conn:           conn,
		upstreamAEAD:   upstreamAEAD,
		downstreamAEAD: downstreamAEAD,
		cfg:            cfg,
		ruleID:         ruleID,
		endpoint:       endpoint,
		endpointIndex:  index,
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
	go s.idleLoop()
	log.Printf("relay udp direct session routed tunnel=%d rule=%d upstream=%s downstream=%s:%d session=%d", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, s.endpoint.Host, s.endpoint.Port, s.sessionID)
}

func (s *udpDirectRelaySession) forwardToDownstream(payload []byte) {
	select {
	case <-s.done:
		return
	default:
	}
	packet, err := sealFXPUDPPacket(s.downstreamAEAD, fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   s.cfg.TunnelID,
		ruleID:     s.ruleID,
		sessionID:  s.sessionID,
		payload:    payload,
	})
	if err != nil {
		log.Printf("relay udp direct downstream seal failed tunnel=%d rule=%d upstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, err)
		s.close()
		return
	}
	if _, err := s.conn.WriteToUDP(packet, s.downstreamAddr); err != nil {
		log.Printf("relay udp direct downstream write failed tunnel=%d rule=%d downstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.downstreamAddr, err)
		s.close()
		return
	}
	s.touch()
}

func (s *udpDirectRelaySession) forwardToUpstream(payload []byte) {
	select {
	case <-s.done:
		return
	default:
	}
	packet, err := sealFXPUDPPacket(s.upstreamAEAD, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   s.cfg.TunnelID,
		ruleID:     s.ruleID,
		sessionID:  s.sessionID,
		payload:    payload,
	})
	if err != nil {
		log.Printf("relay udp direct upstream seal failed tunnel=%d rule=%d upstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, err)
		s.close()
		return
	}
	if _, err := s.conn.WriteToUDP(packet, s.upstreamAddr); err != nil {
		log.Printf("relay udp direct upstream write failed tunnel=%d rule=%d upstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.upstreamAddr, err)
		s.close()
		return
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

func pickUDPDirectEndpoint(selector *exitEndpointSelector, cfg config) (exitEndpoint, int, *net.UDPAddr, cipher.AEAD, error) {
	if selector == nil || selector.count() == 0 {
		return exitEndpoint{}, -1, nil, nil, errors.New("no exit endpoints")
	}
	attempted := map[int]bool{}
	var lastErr error
	for len(attempted) < selector.count() {
		endpoint, index, ok := selector.pick(attempted)
		if !ok {
			break
		}
		attempted[index] = true
		addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(endpoint.Host, strconv.Itoa(endpoint.Port)))
		if err != nil {
			lastErr = err
			selector.markFailure(index, err)
			continue
		}
		key := endpoint.Key
		if key == "" {
			key = cfg.Key
		}
		aead, err := newFXPUDPAEAD(key)
		if err != nil {
			lastErr = err
			selector.markFailure(index, err)
			continue
		}
		selector.markHealthy(index)
		return endpoint, index, addr, aead, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no exit endpoint available")
	}
	return exitEndpoint{}, -1, nil, nil, lastErr
}

func newFXPUDPAEAD(key string) (cipher.AEAD, error) {
	master := sha256.Sum256([]byte(key))
	material := blake3Derive(master[:], []byte("udp"), fxpUDPContext, fxpMasterContext, 32)
	return newAEAD(material)
}

func sealFXPUDPPacket(aead cipher.AEAD, packet fxpUDPPacket) ([]byte, error) {
	if aead == nil {
		return nil, errors.New("nil udp aead")
	}
	if len(packet.payload) > fxpUDPMaxPayload {
		return nil, fmt.Errorf("udp payload too large: %d", len(packet.payload))
	}
	out := make([]byte, fxpUDPHeaderSize)
	copy(out[0:4], []byte(fxpUDPMagic))
	out[4] = fxpUDPVersion
	out[5] = packet.packetType
	binary.BigEndian.PutUint32(out[8:12], uint32(packet.tunnelID))
	binary.BigEndian.PutUint32(out[12:16], uint32(packet.ruleID))
	binary.BigEndian.PutUint64(out[16:24], packet.sessionID)
	if _, err := rand.Read(out[24:36]); err != nil {
		return nil, err
	}
	ciphertext := aead.Seal(nil, out[24:36], packet.payload, fxpUDPAssociatedData(out[:fxpUDPHeaderSize]))
	out = append(out, ciphertext...)
	return out, nil
}

func openFXPUDPPacket(aead cipher.AEAD, raw []byte) (fxpUDPPacket, error) {
	if len(raw) < fxpUDPHeaderSize+16 {
		return fxpUDPPacket{}, errors.New("udp packet too small")
	}
	if !fxpUDPHasMagic(raw) || raw[4] != fxpUDPVersion {
		return fxpUDPPacket{}, errors.New("invalid udp packet header")
	}
	plain, err := aead.Open(nil, raw[24:36], raw[fxpUDPHeaderSize:], fxpUDPAssociatedData(raw[:fxpUDPHeaderSize]))
	if err != nil {
		return fxpUDPPacket{}, err
	}
	return fxpUDPPacket{
		packetType: raw[5],
		tunnelID:   int(binary.BigEndian.Uint32(raw[8:12])),
		ruleID:     int(binary.BigEndian.Uint32(raw[12:16])),
		sessionID:  binary.BigEndian.Uint64(raw[16:24]),
		payload:    plain,
	}, nil
}

func fxpUDPHasMagic(raw []byte) bool {
	return len(raw) >= fxpUDPHeaderSize && string(raw[0:4]) == fxpUDPMagic
}

func fxpUDPAssociatedData(header []byte) []byte {
	ad := make([]byte, 0, len(fxpUDPAD)+len(header))
	ad = append(ad, fxpUDPAD...)
	ad = append(ad, header...)
	return ad
}

func fxpUDPSessionID(raw []byte) (uint64, bool) {
	if !fxpUDPHasMagic(raw) {
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

func encodeUDPForwardPayload(targetIP string, targetPort int, payload []byte) ([]byte, error) {
	host := []byte(targetIP)
	if len(host) == 0 || len(host) > 65535 {
		return nil, errors.New("invalid target host")
	}
	if targetPort <= 0 || targetPort > 65535 {
		return nil, errors.New("invalid target port")
	}
	out := make([]byte, 4+len(host)+len(payload))
	binary.BigEndian.PutUint16(out[0:2], uint16(len(host)))
	binary.BigEndian.PutUint16(out[2:4], uint16(targetPort))
	copy(out[4:4+len(host)], host)
	copy(out[4+len(host):], payload)
	return out, nil
}

func decodeUDPForwardPayload(raw []byte) (string, int, []byte, error) {
	if len(raw) < 4 {
		return "", 0, nil, errors.New("udp forward payload too small")
	}
	hostLen := int(binary.BigEndian.Uint16(raw[0:2]))
	targetPort := int(binary.BigEndian.Uint16(raw[2:4]))
	if hostLen <= 0 || len(raw) < 4+hostLen {
		return "", 0, nil, errors.New("invalid udp forward target")
	}
	if targetPort <= 0 || targetPort > 65535 {
		return "", 0, nil, errors.New("invalid udp forward port")
	}
	return string(raw[4 : 4+hostLen]), targetPort, raw[4+hostLen:], nil
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
