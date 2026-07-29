package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

const (
	forwardXWireGuardVersion       = "v2"
	wireGuardRuntimeWaitTimeout    = 12 * time.Second
	wireGuardProxyDialTimeout      = 10 * time.Second
	wireGuardUDPSessionIdleTimeout = 10 * time.Minute
	wireGuardUDPIdlePollInterval   = 15 * time.Second
	wireGuardUDPProxyQueueSize     = 64
	wireGuardUDPProxyQueueBytes    = 512 * 1024
	wireGuardUDPProxyMaxSessions   = 1024
	wireGuardUDPProxyMaxQueueDelay = 25 * time.Millisecond
	wireGuardUDPProxyBufferBytes   = 4 * 1024 * 1024
	wireGuardUDPSessionBufferBytes = 256 * 1024
	wireGuardRuntimeReleaseDelay   = time.Minute
	wireGuardProbeReadyPoll        = 100 * time.Millisecond
	wireGuardProbeRetryDelay       = 250 * time.Millisecond
)

type wireGuardPeerSpec struct {
	ID                  string `json:"id"`
	HostID              int    `json:"hostId"`
	PublicKey           string `json:"publicKey"`
	Address             string `json:"address"`
	EndpointHost        string `json:"endpointHost,omitempty"`
	EndpointPort        int    `json:"endpointPort,omitempty"`
	PersistentKeepalive int    `json:"persistentKeepalive,omitempty"`
}

type wireGuardSpec struct {
	TunnelID   int                 `json:"tunnelId"`
	Generation int                 `json:"generation,omitempty"`
	PrivateKey string              `json:"privateKey,omitempty"`
	PublicKey  string              `json:"publicKey,omitempty"`
	Address    string              `json:"address,omitempty"`
	ListenPort int                 `json:"listenPort,omitempty"`
	MTU        int                 `json:"mtu,omitempty"`
	Peers      []wireGuardPeerSpec `json:"peers,omitempty"`
}

type wireGuardOutboundProxy struct {
	key        string
	peerID     string
	tcpPort    int
	udpPort    int
	tcpLn      net.Listener
	udpConn    *net.UDPConn
	done       chan struct{}
	closeOnce  sync.Once
	sessionsMu sync.Mutex
	sessions   map[string]*wireGuardUDPProxySession
}

type wireGuardInboundProxy struct {
	key         string
	tcpPort     int
	udpPort     int
	backendHost string
	backendTCP  int
	backendUDP  int
	tcpLn       net.Listener
	udpConn     net.PacketConn
	done        chan struct{}
	closeOnce   sync.Once
	sessionsMu  sync.Mutex
	sessions    map[string]*wireGuardUDPProxySession
}

type wireGuardUDPProxySession struct {
	conn         net.Conn
	send         chan wireGuardUDPProxyPacket
	done         chan struct{}
	queueMu      sync.Mutex
	queuedBytes  int
	lastActivity atomic.Int64
	closeOnce    sync.Once
}

type wireGuardUDPProxyPacket struct {
	payload  []byte
	queuedAt time.Time
}

func oldestWireGuardUDPProxySession(sessions map[string]*wireGuardUDPProxySession) (string, *wireGuardUDPProxySession) {
	var oldestKey string
	var oldest *wireGuardUDPProxySession
	var oldestActivity int64
	for key, session := range sessions {
		if session == nil {
			continue
		}
		activity := session.lastActivity.Load()
		if oldest == nil || activity < oldestActivity {
			oldestKey = key
			oldest = session
			oldestActivity = activity
		}
	}
	return oldestKey, oldest
}

// evictOldestWireGuardUDPProxySession must be called while the proxy's
// sessions lock is held. The caller closes the returned session after
// releasing that lock so its cleanup callback cannot deadlock on the map.
func evictOldestWireGuardUDPProxySession(sessions map[string]*wireGuardUDPProxySession, limit int) *wireGuardUDPProxySession {
	if limit <= 0 || len(sessions) < limit {
		return nil
	}
	oldestKey, oldest := oldestWireGuardUDPProxySession(sessions)
	if oldest != nil {
		delete(sessions, oldestKey)
	}
	return oldest
}

type wireGuardRuntime struct {
	mu           sync.RWMutex
	spec         wireGuardSpec
	signature    string
	tunDevice    tun.Device
	netstack     *netstack.Net
	device       *device.Device
	peers        map[string]wireGuardPeerSpec
	outbound     map[string]*wireGuardOutboundProxy
	outboundRefs map[string]int
	refOutbound  map[string]map[string]struct{}
	inbound      map[string]*wireGuardInboundProxy
	inboundRefs  map[string]int
	refInbound   map[string]map[string]struct{}
	refs         map[string]int
	releaseTimer *time.Timer
	closed       bool
}

var (
	wireGuardRuntimesMu sync.RWMutex
	wireGuardRuntimes   = map[int]*wireGuardRuntime{}
)

func normalizeWireGuardSpec(spec wireGuardSpec) (wireGuardSpec, error) {
	spec.TunnelID = int(spec.TunnelID)
	spec.PrivateKey = strings.ToLower(strings.TrimSpace(spec.PrivateKey))
	spec.PublicKey = strings.ToLower(strings.TrimSpace(spec.PublicKey))
	spec.Address = strings.TrimSpace(spec.Address)
	if spec.TunnelID <= 0 {
		return spec, errors.New("wireguard tunnel id is required")
	}
	if _, err := decodeWireGuardKey(spec.PrivateKey); err != nil {
		return spec, fmt.Errorf("wireguard private key: %w", err)
	}
	if spec.PublicKey != "" {
		if _, err := decodeWireGuardKey(spec.PublicKey); err != nil {
			return spec, fmt.Errorf("wireguard public key: %w", err)
		}
	}
	address, err := netip.ParseAddr(spec.Address)
	if err != nil || !address.Is4() {
		return spec, fmt.Errorf("wireguard address %q is invalid", spec.Address)
	}
	if spec.ListenPort < 0 || spec.ListenPort > 65535 {
		return spec, fmt.Errorf("wireguard listen port %d is invalid", spec.ListenPort)
	}
	if spec.MTU <= 0 {
		spec.MTU = 1380
	}
	if spec.MTU < 1200 || spec.MTU > 1420 {
		return spec, fmt.Errorf("wireguard mtu %d is invalid", spec.MTU)
	}
	seen := map[string]bool{}
	peers := make([]wireGuardPeerSpec, 0, len(spec.Peers))
	for _, peer := range spec.Peers {
		peer.ID = strings.TrimSpace(peer.ID)
		peer.PublicKey = strings.ToLower(strings.TrimSpace(peer.PublicKey))
		peer.Address = strings.TrimSpace(peer.Address)
		peer.EndpointHost = strings.TrimSpace(peer.EndpointHost)
		if peer.ID == "" || seen[peer.ID] {
			continue
		}
		if _, err := decodeWireGuardKey(peer.PublicKey); err != nil {
			return spec, fmt.Errorf("wireguard peer %s public key: %w", peer.ID, err)
		}
		peerAddress, err := netip.ParseAddr(peer.Address)
		if err != nil || !peerAddress.Is4() || peerAddress == address {
			return spec, fmt.Errorf("wireguard peer %s address %q is invalid", peer.ID, peer.Address)
		}
		if peer.EndpointHost != "" && (peer.EndpointPort <= 0 || peer.EndpointPort > 65535) {
			return spec, fmt.Errorf("wireguard peer %s endpoint port is invalid", peer.ID)
		}
		if peer.PersistentKeepalive < 0 || peer.PersistentKeepalive > 65535 {
			peer.PersistentKeepalive = 0
		}
		seen[peer.ID] = true
		peers = append(peers, peer)
	}
	sort.Slice(peers, func(i, j int) bool { return peers[i].ID < peers[j].ID })
	spec.Peers = peers
	return spec, nil
}

func decodeWireGuardKey(value string) ([]byte, error) {
	if len(value) != 64 {
		return nil, errors.New("expected 32-byte hex key")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("expected 32-byte hex key")
	}
	return decoded, nil
}

func wireGuardSpecSignature(spec wireGuardSpec) string {
	raw, _ := json.Marshal(spec)
	return string(raw)
}

func wireGuardPeerMapByPublicKey(spec wireGuardSpec) map[string]wireGuardPeerSpec {
	peers := make(map[string]wireGuardPeerSpec, len(spec.Peers))
	for _, peer := range spec.Peers {
		peers[peer.PublicKey] = peer
	}
	return peers
}

func wireGuardPeerRequiresRecreate(previous, next wireGuardPeerSpec) bool {
	return previous.EndpointHost != "" && next.EndpointHost == ""
}

func wireGuardPeerUpdateSummary(previous, next wireGuardSpec) (added, removed, updated int, removedKeys []string) {
	previousPeers := wireGuardPeerMapByPublicKey(previous)
	nextPeers := wireGuardPeerMapByPublicKey(next)
	for publicKey, previousPeer := range previousPeers {
		nextPeer, exists := nextPeers[publicKey]
		if !exists || wireGuardPeerRequiresRecreate(previousPeer, nextPeer) {
			removed++
			removedKeys = append(removedKeys, publicKey)
		}
	}
	for publicKey, nextPeer := range nextPeers {
		previousPeer, exists := previousPeers[publicKey]
		if !exists || wireGuardPeerRequiresRecreate(previousPeer, nextPeer) {
			added++
			continue
		}
		if previousPeer != nextPeer {
			updated++
		}
	}
	sort.Strings(removedKeys)
	return added, removed, updated, removedKeys
}

func wireGuardDeviceConfig(spec wireGuardSpec, replacePeers bool, removedKeys []string) string {
	var builder strings.Builder
	if replacePeers {
		builder.WriteString("private_key=")
		builder.WriteString(spec.PrivateKey)
		builder.WriteByte('\n')
		builder.WriteString("listen_port=")
		builder.WriteString(strconv.Itoa(spec.ListenPort))
		builder.WriteByte('\n')
		builder.WriteString("replace_peers=true\n")
	} else {
		for _, publicKey := range removedKeys {
			builder.WriteString("public_key=")
			builder.WriteString(publicKey)
			builder.WriteString("\nremove=true\n")
		}
	}
	for _, peer := range spec.Peers {
		builder.WriteString("public_key=")
		builder.WriteString(peer.PublicKey)
		builder.WriteByte('\n')
		builder.WriteString("replace_allowed_ips=true\n")
		builder.WriteString("allowed_ip=")
		builder.WriteString(peer.Address)
		builder.WriteString("/32\n")
		if peer.EndpointHost != "" && peer.EndpointPort > 0 {
			builder.WriteString("endpoint=")
			builder.WriteString(net.JoinHostPort(peer.EndpointHost, strconv.Itoa(peer.EndpointPort)))
			builder.WriteByte('\n')
		}
		builder.WriteString("persistent_keepalive_interval=")
		builder.WriteString(strconv.Itoa(peer.PersistentKeepalive))
		builder.WriteByte('\n')
	}
	return builder.String()
}

func newWireGuardRuntime(spec wireGuardSpec) (*wireGuardRuntime, error) {
	normalized, err := normalizeWireGuardSpec(spec)
	if err != nil {
		return nil, err
	}
	address := netip.MustParseAddr(normalized.Address)
	tunDevice, tnet, err := netstack.CreateNetTUN([]netip.Addr{address}, nil, normalized.MTU)
	if err != nil {
		return nil, fmt.Errorf("create wireguard netstack: %w", err)
	}
	logger := &device.Logger{
		Verbosef: device.DiscardLogf,
		Errorf: func(format string, args ...any) {
			logf("wireguard tunnel=%d "+format, append([]any{normalized.TunnelID}, args...)...)
		},
	}
	dev := device.NewDevice(tunDevice, conn.NewDefaultBind(), logger)
	if err := dev.IpcSet(wireGuardDeviceConfig(normalized, true, nil)); err != nil {
		dev.Close()
		return nil, fmt.Errorf("configure wireguard: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, fmt.Errorf("start wireguard: %w", err)
	}
	runtime := &wireGuardRuntime{
		spec:         normalized,
		signature:    wireGuardSpecSignature(normalized),
		tunDevice:    tunDevice,
		netstack:     tnet,
		device:       dev,
		peers:        map[string]wireGuardPeerSpec{},
		outbound:     map[string]*wireGuardOutboundProxy{},
		outboundRefs: map[string]int{},
		refOutbound:  map[string]map[string]struct{}{},
		inbound:      map[string]*wireGuardInboundProxy{},
		inboundRefs:  map[string]int{},
		refInbound:   map[string]map[string]struct{}{},
		refs:         map[string]int{},
	}
	for _, peer := range normalized.Peers {
		runtime.peers[peer.ID] = peer
	}
	logf("wireguard runtime started tunnel=%d address=%s listen=:%d peers=%d mtu=%d", normalized.TunnelID, normalized.Address, normalized.ListenPort, len(normalized.Peers), normalized.MTU)
	return runtime, nil
}

func (runtime *wireGuardRuntime) update(spec wireGuardSpec) error {
	normalized, err := normalizeWireGuardSpec(spec)
	if err != nil {
		return err
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closed {
		return net.ErrClosed
	}
	if runtime.spec.PrivateKey != normalized.PrivateKey || runtime.spec.Address != normalized.Address || runtime.spec.MTU != normalized.MTU {
		return errors.New("wireguard runtime identity changed")
	}
	signature := wireGuardSpecSignature(normalized)
	if runtime.signature == signature {
		return nil
	}
	added, removed, updated, removedKeys := wireGuardPeerUpdateSummary(runtime.spec, normalized)
	dnsRefresh := runtime.spec.Generation != normalized.Generation
	if err := runtime.device.IpcSet(wireGuardDeviceConfig(normalized, false, removedKeys)); err != nil {
		return fmt.Errorf("update wireguard: %w", err)
	}
	runtime.spec = normalized
	runtime.signature = signature
	runtime.peers = map[string]wireGuardPeerSpec{}
	for _, peer := range normalized.Peers {
		runtime.peers[peer.ID] = peer
	}
	logf("wireguard runtime updated tunnel=%d listen=:%d peers=%d generation=%d peerAdded=%d peerRemoved=%d peerUpdated=%d dnsRefresh=%v", normalized.TunnelID, normalized.ListenPort, len(normalized.Peers), normalized.Generation, added, removed, updated, dnsRefresh)
	return nil
}

func applyWireGuardRuntime(spec wireGuardSpec) error {
	normalized, err := normalizeWireGuardSpec(spec)
	if err != nil {
		return err
	}
	wireGuardRuntimesMu.Lock()
	existing := wireGuardRuntimes[normalized.TunnelID]
	if existing != nil {
		if err := existing.update(normalized); err == nil {
			wireGuardRuntimesMu.Unlock()
			if persistErr := persistWireGuardSpec(normalized); persistErr != nil {
				logf("wireguard persistent snapshot write failed tunnel=%d: %v", normalized.TunnelID, persistErr)
			}
			return nil
		} else if !strings.Contains(err.Error(), "identity changed") {
			wireGuardRuntimesMu.Unlock()
			return err
		}
		delete(wireGuardRuntimes, normalized.TunnelID)
	}
	wireGuardRuntimesMu.Unlock()
	if existing != nil {
		existing.close()
		stopFXPByTunnelTransport(normalized.TunnelID, forwardXWireGuardVersion)
	}
	created, err := newWireGuardRuntime(normalized)
	if err != nil {
		return err
	}
	wireGuardRuntimesMu.Lock()
	if current := wireGuardRuntimes[normalized.TunnelID]; current != nil {
		wireGuardRuntimesMu.Unlock()
		created.close()
		err := current.update(normalized)
		if err == nil {
			if persistErr := persistWireGuardSpec(normalized); persistErr != nil {
				logf("wireguard persistent snapshot write failed tunnel=%d: %v", normalized.TunnelID, persistErr)
			}
		}
		return err
	}
	wireGuardRuntimes[normalized.TunnelID] = created
	wireGuardRuntimesMu.Unlock()
	if persistErr := persistWireGuardSpec(normalized); persistErr != nil {
		logf("wireguard persistent snapshot write failed tunnel=%d: %v", normalized.TunnelID, persistErr)
	}
	return nil
}

func stopWireGuardRuntime(tunnelID int) {
	stopWireGuardRuntimeOnly(tunnelID)
	removePersistedWireGuardSpec(tunnelID)
}

// stopWireGuardRuntimeOnly tears down sockets and the in-memory runtime while
// preserving the configuration needed to restore it after an Agent restart.
// It is used by reference-counted idle cleanup and transport replacement;
// explicit panel remove actions use stopWireGuardRuntime above.
func stopWireGuardRuntimeOnly(tunnelID int) {
	if tunnelID <= 0 {
		return
	}
	wireGuardRuntimesMu.Lock()
	runtime := wireGuardRuntimes[tunnelID]
	delete(wireGuardRuntimes, tunnelID)
	wireGuardRuntimesMu.Unlock()
	if runtime != nil {
		runtime.close()
	}
}

func wireGuardRuntimeReady(tunnelID int, expected *wireGuardSpec) bool {
	wireGuardRuntimesMu.RLock()
	runtime := wireGuardRuntimes[tunnelID]
	wireGuardRuntimesMu.RUnlock()
	if runtime == nil {
		return false
	}
	runtime.mu.RLock()
	defer runtime.mu.RUnlock()
	if runtime.closed {
		return false
	}
	if expected == nil || strings.TrimSpace(expected.PrivateKey) == "" {
		return true
	}
	normalized, err := normalizeWireGuardSpec(*expected)
	return err == nil && runtime.signature == wireGuardSpecSignature(normalized)
}

func waitForWireGuardRuntime(tunnelID int, timeout time.Duration) (*wireGuardRuntime, error) {
	if timeout <= 0 {
		timeout = wireGuardRuntimeWaitTimeout
	}
	deadline := time.Now().Add(timeout)
	for {
		wireGuardRuntimesMu.RLock()
		runtime := wireGuardRuntimes[tunnelID]
		wireGuardRuntimesMu.RUnlock()
		if runtime != nil && wireGuardRuntimeReady(tunnelID, nil) {
			return runtime, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("wireguard runtime tunnel=%d is not ready", tunnelID)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (runtime *wireGuardRuntime) addRef(id string, outboundKeys ...string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("wireguard runtime reference is required")
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closed {
		return net.ErrClosed
	}
	if runtime.releaseTimer != nil {
		runtime.releaseTimer.Stop()
		runtime.releaseTimer = nil
	}
	if runtime.refs == nil {
		runtime.refs = map[string]int{}
	}
	if runtime.refOutbound == nil {
		runtime.refOutbound = map[string]map[string]struct{}{}
	}
	if runtime.outboundRefs == nil {
		runtime.outboundRefs = map[string]int{}
	}
	if runtime.refInbound == nil {
		runtime.refInbound = map[string]map[string]struct{}{}
	}
	if runtime.inboundRefs == nil {
		runtime.inboundRefs = map[string]int{}
	}
	runtime.refs[id]++
	keys := runtime.refOutbound[id]
	if keys == nil {
		keys = map[string]struct{}{}
		runtime.refOutbound[id] = keys
	}
	for _, key := range outboundKeys {
		key = strings.TrimSpace(key)
		if key == "" || runtime.outbound[key] == nil {
			continue
		}
		if _, exists := keys[key]; exists {
			continue
		}
		keys[key] = struct{}{}
		runtime.outboundRefs[key]++
	}
	return nil
}

func releaseWireGuardRuntimeRef(tunnelID int, id string) {
	wireGuardRuntimesMu.RLock()
	runtime := wireGuardRuntimes[tunnelID]
	wireGuardRuntimesMu.RUnlock()
	if runtime == nil {
		return
	}
	releaseWireGuardRuntimeInstanceRef(runtime, tunnelID, id)
}

func releaseWireGuardRuntimeInstanceRef(runtime *wireGuardRuntime, tunnelID int, id string) {
	if runtime == nil {
		return
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return
	}
	outboundToClose := make([]*wireGuardOutboundProxy, 0)
	inboundToClose := make([]*wireGuardInboundProxy, 0)
	runtime.mu.Lock()
	if runtime.refs[id] <= 0 {
		runtime.mu.Unlock()
		return
	}
	if runtime.refs[id] <= 1 {
		delete(runtime.refs, id)
		for key := range runtime.refOutbound[id] {
			if runtime.outboundRefs[key] <= 1 {
				delete(runtime.outboundRefs, key)
				if proxy := runtime.outbound[key]; proxy != nil {
					delete(runtime.outbound, key)
					outboundToClose = append(outboundToClose, proxy)
				}
			} else {
				runtime.outboundRefs[key]--
			}
		}
		delete(runtime.refOutbound, id)
		for key := range runtime.refInbound[id] {
			if runtime.inboundRefs[key] <= 1 {
				delete(runtime.inboundRefs, key)
				if proxy := runtime.inbound[key]; proxy != nil {
					delete(runtime.inbound, key)
					inboundToClose = append(inboundToClose, proxy)
				}
			} else {
				runtime.inboundRefs[key]--
			}
		}
		delete(runtime.refInbound, id)
	} else {
		runtime.refs[id]--
	}
	if len(runtime.refs) == 0 && runtime.releaseTimer == nil && !runtime.closed {
		runtime.releaseTimer = time.AfterFunc(wireGuardRuntimeReleaseDelay, func() {
			wireGuardRuntimesMu.RLock()
			current := wireGuardRuntimes[tunnelID]
			wireGuardRuntimesMu.RUnlock()
			if current != runtime {
				return
			}
			runtime.mu.RLock()
			unused := len(runtime.refs) == 0 && !runtime.closed
			runtime.mu.RUnlock()
			if unused {
				stopWireGuardRuntimeOnly(tunnelID)
			}
		})
	}
	runtime.mu.Unlock()
	for _, proxy := range outboundToClose {
		proxy.close()
		logf("wireguard outbound proxy stopped tunnel=%d target=%s", tunnelID, proxy.key)
	}
	for _, proxy := range inboundToClose {
		proxy.close()
		logf("wireguard inbound proxy stopped tunnel=%d target=%s", tunnelID, proxy.key)
	}
}

func (runtime *wireGuardRuntime) peerAddress(peerID string) (net.IP, error) {
	runtime.mu.RLock()
	peer, ok := runtime.peers[strings.TrimSpace(peerID)]
	closed := runtime.closed
	runtime.mu.RUnlock()
	if closed {
		return nil, net.ErrClosed
	}
	if !ok {
		return nil, fmt.Errorf("wireguard peer %q is not configured", peerID)
	}
	ip := net.ParseIP(peer.Address)
	if ip == nil {
		return nil, fmt.Errorf("wireguard peer %q address is invalid", peerID)
	}
	return ip, nil
}

func (runtime *wireGuardRuntime) dialPeerTCP(ctx context.Context, peerID string, port int) (net.Conn, error) {
	ip, err := runtime.peerAddress(peerID)
	if err != nil {
		return nil, err
	}
	return runtime.netstack.DialContextTCP(ctx, &net.TCPAddr{IP: ip, Port: port})
}

func (runtime *wireGuardRuntime) dialPeerUDP(peerID string, port int) (net.Conn, error) {
	ip, err := runtime.peerAddress(peerID)
	if err != nil {
		return nil, err
	}
	return runtime.netstack.DialUDP(nil, &net.UDPAddr{IP: ip, Port: port})
}

func tuneWireGuardUDPConn(conn *net.UDPConn, bufferBytes int) {
	if conn == nil || bufferBytes <= 0 {
		return
	}
	_ = conn.SetReadBuffer(bufferBytes)
	_ = conn.SetWriteBuffer(bufferBytes)
}

func newWireGuardUDPProxySession(conn net.Conn) *wireGuardUDPProxySession {
	session := &wireGuardUDPProxySession{
		conn: conn,
		send: make(chan wireGuardUDPProxyPacket, wireGuardUDPProxyQueueSize),
		done: make(chan struct{}),
	}
	if udpConn, ok := conn.(*net.UDPConn); ok {
		tuneWireGuardUDPConn(udpConn, wireGuardUDPSessionBufferBytes)
	}
	session.touch()
	return session
}

func (session *wireGuardUDPProxySession) touch() {
	session.lastActivity.Store(time.Now().UnixNano())
}

func (session *wireGuardUDPProxySession) idleExpired(now time.Time) bool {
	last := session.lastActivity.Load()
	return last > 0 && now.Sub(time.Unix(0, last)) >= wireGuardUDPSessionIdleTimeout
}

func (session *wireGuardUDPProxySession) readDeadline(now time.Time) time.Time {
	last := session.lastActivity.Load()
	if last <= 0 {
		return now.Add(wireGuardUDPIdlePollInterval)
	}
	idleDeadline := time.Unix(0, last).Add(wireGuardUDPSessionIdleTimeout)
	pollDeadline := now.Add(wireGuardUDPIdlePollInterval)
	if idleDeadline.Before(pollDeadline) {
		return idleDeadline
	}
	return pollDeadline
}

func (session *wireGuardUDPProxySession) enqueue(payload []byte) bool {
	select {
	case <-session.done:
		return false
	default:
	}
	session.touch()
	packet := wireGuardUDPProxyPacket{
		payload:  append([]byte(nil), payload...),
		queuedAt: time.Now(),
	}
	packetBytes := len(packet.payload)
	dropped := false
	session.queueMu.Lock()
	defer session.queueMu.Unlock()
	for len(session.send) > 0 && (len(session.send) >= cap(session.send) || session.queuedBytes+packetBytes > wireGuardUDPProxyQueueBytes) {
		select {
		case displaced := <-session.send:
			session.queuedBytes -= len(displaced.payload)
			if session.queuedBytes < 0 {
				session.queuedBytes = 0
			}
			dropped = true
		default:
		}
	}
	if session.queuedBytes+packetBytes > wireGuardUDPProxyQueueBytes {
		return false
	}
	select {
	case <-session.done:
		return false
	case session.send <- packet:
		session.queuedBytes += packetBytes
		return !dropped
	default:
		return false
	}
}

func (session *wireGuardUDPProxySession) markDequeued(packet wireGuardUDPProxyPacket) {
	session.queueMu.Lock()
	session.queuedBytes -= len(packet.payload)
	if session.queuedBytes < 0 {
		session.queuedBytes = 0
	}
	session.queueMu.Unlock()
}

func (packet wireGuardUDPProxyPacket) expired(now time.Time) bool {
	return !packet.queuedAt.IsZero() && now.Sub(packet.queuedAt) >= wireGuardUDPProxyMaxQueueDelay
}

func (packet wireGuardUDPProxyPacket) superseded(now time.Time, pendingNewer int) bool {
	return pendingNewer > 0 && packet.expired(now)
}

func (session *wireGuardUDPProxySession) writeLoop() {
	for {
		select {
		case <-session.done:
			return
		case packet := <-session.send:
			session.markDequeued(packet)
			now := time.Now()
			pendingNewer := len(session.send)
			if packet.superseded(now, pendingNewer) {
				continue
			}
			writeDeadline := now.Add(wireGuardProxyDialTimeout)
			if pendingNewer > 0 && !packet.queuedAt.IsZero() {
				freshnessDeadline := packet.queuedAt.Add(wireGuardUDPProxyMaxQueueDelay)
				if freshnessDeadline.Before(writeDeadline) {
					writeDeadline = freshnessDeadline
				}
			}
			_ = session.conn.SetWriteDeadline(writeDeadline)
			if _, err := session.conn.Write(packet.payload); err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() && pendingNewer > 0 {
					continue
				}
				session.close()
				return
			}
		}
	}
}
func listenLoopbackTCPAndUDP() (net.Listener, *net.UDPConn, int, error) {
	for attempt := 0; attempt < 32; attempt++ {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, nil, 0, err
		}
		port := listener.Addr().(*net.TCPAddr).Port
		udpConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: port})
		if err == nil {
			tuneWireGuardUDPConn(udpConn, wireGuardUDPProxyBufferBytes)
			return listener, udpConn, port, nil
		}
		_ = listener.Close()
	}
	return nil, nil, 0, errors.New("allocate wireguard loopback proxy port failed")
}

func wireGuardOutboundProxyKey(peerID string, tcpPort, udpPort int) string {
	return fmt.Sprintf("%s:%d:%d", strings.TrimSpace(peerID), tcpPort, udpPort)
}

func (runtime *wireGuardRuntime) ensureOutboundProxy(refID string, peerID string, tcpPort, udpPort int) (string, int, int, error) {
	peerID = strings.TrimSpace(peerID)
	refID = strings.TrimSpace(refID)
	if refID == "" || peerID == "" || tcpPort <= 0 || tcpPort > 65535 || udpPort <= 0 || udpPort > 65535 {
		return "", 0, 0, errors.New("wireguard outbound proxy target is invalid")
	}
	if _, err := runtime.peerAddress(peerID); err != nil {
		return "", 0, 0, err
	}
	key := wireGuardOutboundProxyKey(peerID, tcpPort, udpPort)
	runtime.mu.Lock()
	if runtime.closed {
		runtime.mu.Unlock()
		return "", 0, 0, net.ErrClosed
	}
	retain := func() error {
		if runtime.refs[refID] <= 0 {
			return fmt.Errorf("wireguard runtime reference %q is not registered", refID)
		}
		if runtime.refOutbound == nil {
			runtime.refOutbound = map[string]map[string]struct{}{}
		}
		if runtime.outboundRefs == nil {
			runtime.outboundRefs = map[string]int{}
		}
		keys := runtime.refOutbound[refID]
		if keys == nil {
			keys = map[string]struct{}{}
			runtime.refOutbound[refID] = keys
		}
		if _, exists := keys[key]; !exists {
			keys[key] = struct{}{}
			runtime.outboundRefs[key]++
		}
		return nil
	}
	if proxy := runtime.outbound[key]; proxy != nil {
		port := proxy.tcpLn.Addr().(*net.TCPAddr).Port
		if err := retain(); err != nil {
			runtime.mu.Unlock()
			return "", 0, 0, err
		}
		runtime.mu.Unlock()
		return "127.0.0.1", port, port, nil
	}
	listener, udpConn, localPort, err := listenLoopbackTCPAndUDP()
	if err != nil {
		runtime.mu.Unlock()
		return "", 0, 0, err
	}
	proxy := &wireGuardOutboundProxy{
		key: key, peerID: peerID, tcpPort: tcpPort, udpPort: udpPort,
		tcpLn: listener, udpConn: udpConn, done: make(chan struct{}), sessions: map[string]*wireGuardUDPProxySession{},
	}
	runtime.outbound[key] = proxy
	if err := retain(); err != nil {
		delete(runtime.outbound, key)
		runtime.mu.Unlock()
		proxy.close()
		return "", 0, 0, err
	}
	runtime.mu.Unlock()
	go runtime.serveOutboundTCP(proxy)
	go runtime.serveOutboundUDP(proxy)
	logf("wireguard outbound proxy started tunnel=%d peer=%s local=127.0.0.1:%d remote=%s:%d/%d", runtime.spec.TunnelID, peerID, localPort, peerID, tcpPort, udpPort)
	return "127.0.0.1", localPort, localPort, nil
}

func (runtime *wireGuardRuntime) serveOutboundTCP(proxy *wireGuardOutboundProxy) {
	for {
		client, err := proxy.tcpLn.Accept()
		if err != nil {
			return
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), wireGuardProxyDialTimeout)
			remote, err := runtime.dialPeerTCP(ctx, proxy.peerID, proxy.tcpPort)
			cancel()
			if err != nil {
				_ = client.Close()
				logf("wireguard tcp proxy dial failed tunnel=%d peer=%s port=%d: %v", runtime.spec.TunnelID, proxy.peerID, proxy.tcpPort, err)
				return
			}
			proxyWireGuardConnections(client, remote)
		}()
	}
}

func (runtime *wireGuardRuntime) serveOutboundUDP(proxy *wireGuardOutboundProxy) {
	buf := make([]byte, 65535)
	for {
		n, clientAddr, err := proxy.udpConn.ReadFrom(buf)
		if err != nil {
			return
		}
		key := clientAddr.String()
		var evicted *wireGuardUDPProxySession
		proxy.sessionsMu.Lock()
		session := proxy.sessions[key]
		if session == nil {
			remote, dialErr := runtime.dialPeerUDP(proxy.peerID, proxy.udpPort)
			if dialErr != nil {
				proxy.sessionsMu.Unlock()
				logf("wireguard udp proxy dial failed tunnel=%d peer=%s port=%d: %v", runtime.spec.TunnelID, proxy.peerID, proxy.udpPort, dialErr)
				continue
			}
			evicted = evictOldestWireGuardUDPProxySession(proxy.sessions, wireGuardUDPProxyMaxSessions)
			session = newWireGuardUDPProxySession(remote)
			proxy.sessions[key] = session
			created := session
			sessionKey := key
			responseAddr := clientAddr
			go created.writeLoop()
			go copyWireGuardUDPResponses(created, proxy.udpConn, responseAddr, func() {
				proxy.sessionsMu.Lock()
				if proxy.sessions[sessionKey] == created {
					delete(proxy.sessions, sessionKey)
				}
				proxy.sessionsMu.Unlock()
			})
		}
		proxy.sessionsMu.Unlock()
		if evicted != nil {
			evicted.close()
			if shouldLogAgentReport("wireguard-udp-outbound-session-evict:"+proxy.key, agentReportLogInterval) {
				logf("wireguard udp outbound session limit reached tunnel=%d peer=%s limit=%d; evicted oldest session", runtime.spec.TunnelID, proxy.peerID, wireGuardUDPProxyMaxSessions)
			}
		}
		if !session.enqueue(buf[:n]) && shouldLogAgentReport("wireguard-udp-outbound-queue:"+proxy.key, agentReportLogInterval) {
			logf("wireguard udp outbound queue congested tunnel=%d peer=%s; dropping oldest packet", runtime.spec.TunnelID, proxy.peerID)
		}
	}
}

func (runtime *wireGuardRuntime) ensureInboundProxy(refID string, tcpPort, udpPort int) error {
	refID = strings.TrimSpace(refID)
	if tcpPort <= 0 || tcpPort > 65535 || udpPort <= 0 || udpPort > 65535 {
		return errors.New("wireguard inbound proxy port is invalid")
	}
	if refID == "" {
		return errors.New("wireguard inbound proxy reference is required")
	}
	key := fmt.Sprintf("%d:%d", tcpPort, udpPort)
	runtime.mu.Lock()
	if runtime.closed {
		runtime.mu.Unlock()
		return net.ErrClosed
	}
	retain := func() error {
		if runtime.refs[refID] <= 0 {
			return fmt.Errorf("wireguard runtime reference %q is not registered", refID)
		}
		if runtime.refInbound == nil {
			runtime.refInbound = map[string]map[string]struct{}{}
		}
		if runtime.inboundRefs == nil {
			runtime.inboundRefs = map[string]int{}
		}
		keys := runtime.refInbound[refID]
		if keys == nil {
			keys = map[string]struct{}{}
			runtime.refInbound[refID] = keys
		}
		if _, exists := keys[key]; !exists {
			keys[key] = struct{}{}
			runtime.inboundRefs[key]++
		}
		return nil
	}
	if runtime.inbound[key] != nil {
		if err := retain(); err != nil {
			runtime.mu.Unlock()
			return err
		}
		runtime.mu.Unlock()
		return nil
	}
	localIP := net.ParseIP(runtime.spec.Address)
	tcpLn, err := runtime.netstack.ListenTCP(&net.TCPAddr{IP: localIP, Port: tcpPort})
	if err != nil {
		runtime.mu.Unlock()
		return fmt.Errorf("wireguard tcp inbound listen %d: %w", tcpPort, err)
	}
	udpConn, err := runtime.netstack.ListenUDP(&net.UDPAddr{IP: localIP, Port: udpPort})
	if err != nil {
		_ = tcpLn.Close()
		runtime.mu.Unlock()
		return fmt.Errorf("wireguard udp inbound listen %d: %w", udpPort, err)
	}
	proxy := &wireGuardInboundProxy{
		key: key, tcpPort: tcpPort, udpPort: udpPort, backendHost: "127.0.0.1", backendTCP: tcpPort, backendUDP: udpPort,
		tcpLn: tcpLn, udpConn: udpConn, done: make(chan struct{}), sessions: map[string]*wireGuardUDPProxySession{},
	}
	runtime.inbound[key] = proxy
	if err := retain(); err != nil {
		delete(runtime.inbound, key)
		runtime.mu.Unlock()
		proxy.close()
		return err
	}
	runtime.mu.Unlock()
	go runtime.serveInboundTCP(proxy)
	go runtime.serveInboundUDP(proxy)
	logf("wireguard inbound proxy started tunnel=%d address=%s tcp=%d udp=%d backend=127.0.0.1", runtime.spec.TunnelID, runtime.spec.Address, tcpPort, udpPort)
	return nil
}

func (runtime *wireGuardRuntime) serveInboundTCP(proxy *wireGuardInboundProxy) {
	for {
		client, err := proxy.tcpLn.Accept()
		if err != nil {
			return
		}
		go func() {
			backend, err := net.DialTimeout("tcp", net.JoinHostPort(proxy.backendHost, strconv.Itoa(proxy.backendTCP)), wireGuardProxyDialTimeout)
			if err != nil {
				_ = client.Close()
				logf("wireguard tcp backend dial failed tunnel=%d port=%d: %v", runtime.spec.TunnelID, proxy.backendTCP, err)
				return
			}
			proxyWireGuardConnections(client, backend)
		}()
	}
}

func (runtime *wireGuardRuntime) serveInboundUDP(proxy *wireGuardInboundProxy) {
	buf := make([]byte, 65535)
	for {
		n, peerAddr, err := proxy.udpConn.ReadFrom(buf)
		if err != nil {
			return
		}
		key := peerAddr.String()
		var evicted *wireGuardUDPProxySession
		proxy.sessionsMu.Lock()
		session := proxy.sessions[key]
		if session == nil {
			backend, dialErr := net.DialTimeout("udp", net.JoinHostPort(proxy.backendHost, strconv.Itoa(proxy.backendUDP)), wireGuardProxyDialTimeout)
			if dialErr != nil {
				proxy.sessionsMu.Unlock()
				logf("wireguard udp backend dial failed tunnel=%d port=%d: %v", runtime.spec.TunnelID, proxy.backendUDP, dialErr)
				continue
			}
			evicted = evictOldestWireGuardUDPProxySession(proxy.sessions, wireGuardUDPProxyMaxSessions)
			session = newWireGuardUDPProxySession(backend)
			proxy.sessions[key] = session
			created := session
			sessionKey := key
			responseAddr := peerAddr
			go created.writeLoop()
			go copyWireGuardPacketResponses(created, proxy.udpConn, responseAddr, func() {
				proxy.sessionsMu.Lock()
				if proxy.sessions[sessionKey] == created {
					delete(proxy.sessions, sessionKey)
				}
				proxy.sessionsMu.Unlock()
			})
		}
		proxy.sessionsMu.Unlock()
		if evicted != nil {
			evicted.close()
			if shouldLogAgentReport("wireguard-udp-inbound-session-evict:"+proxy.key, agentReportLogInterval) {
				logf("wireguard udp inbound session limit reached tunnel=%d port=%d limit=%d; evicted oldest session", runtime.spec.TunnelID, proxy.backendUDP, wireGuardUDPProxyMaxSessions)
			}
		}
		if !session.enqueue(buf[:n]) && shouldLogAgentReport("wireguard-udp-inbound-queue:"+proxy.key, agentReportLogInterval) {
			logf("wireguard udp inbound queue congested tunnel=%d port=%d; dropping oldest packet", runtime.spec.TunnelID, proxy.backendUDP)
		}
	}
}

func copyWireGuardUDPResponses(session *wireGuardUDPProxySession, target *net.UDPConn, clientAddr net.Addr, done func()) {
	defer done()
	defer session.close()
	buf := make([]byte, 65535)
	for {
		_ = session.conn.SetReadDeadline(session.readDeadline(time.Now()))
		n, err := session.conn.Read(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() && !session.idleExpired(time.Now()) {
				continue
			}
			return
		}
		session.touch()
		if _, err := target.WriteTo(buf[:n], clientAddr); err != nil {
			return
		}
	}
}

func copyWireGuardPacketResponses(session *wireGuardUDPProxySession, target net.PacketConn, clientAddr net.Addr, done func()) {
	defer done()
	defer session.close()
	buf := make([]byte, 65535)
	for {
		_ = session.conn.SetReadDeadline(session.readDeadline(time.Now()))
		n, err := session.conn.Read(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() && !session.idleExpired(time.Now()) {
				continue
			}
			return
		}
		session.touch()
		if _, err := target.WriteTo(buf[:n], clientAddr); err != nil {
			return
		}
	}
}

func (session *wireGuardUDPProxySession) close() {
	session.closeOnce.Do(func() {
		close(session.done)
		session.queueMu.Lock()
		for len(session.send) > 0 {
			packet := <-session.send
			session.queuedBytes -= len(packet.payload)
		}
		session.queuedBytes = 0
		session.queueMu.Unlock()
		_ = session.conn.Close()
	})
}

func proxyWireGuardConnections(left, right net.Conn) {
	defer left.Close()
	defer right.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(left, right); done <- struct{}{} }()
	go func() { _, _ = io.Copy(right, left); done <- struct{}{} }()
	<-done
}

func (proxy *wireGuardOutboundProxy) close() {
	proxy.closeOnce.Do(func() {
		close(proxy.done)
		_ = proxy.tcpLn.Close()
		_ = proxy.udpConn.Close()
		proxy.sessionsMu.Lock()
		for _, session := range proxy.sessions {
			session.close()
		}
		proxy.sessions = map[string]*wireGuardUDPProxySession{}
		proxy.sessionsMu.Unlock()
	})
}

func (proxy *wireGuardInboundProxy) close() {
	proxy.closeOnce.Do(func() {
		close(proxy.done)
		_ = proxy.tcpLn.Close()
		_ = proxy.udpConn.Close()
		proxy.sessionsMu.Lock()
		for _, session := range proxy.sessions {
			session.close()
		}
		proxy.sessions = map[string]*wireGuardUDPProxySession{}
		proxy.sessionsMu.Unlock()
	})
}

func (runtime *wireGuardRuntime) close() {
	runtime.mu.Lock()
	if runtime.closed {
		runtime.mu.Unlock()
		return
	}
	runtime.closed = true
	if runtime.releaseTimer != nil {
		runtime.releaseTimer.Stop()
		runtime.releaseTimer = nil
	}
	outbound := make([]*wireGuardOutboundProxy, 0, len(runtime.outbound))
	for _, proxy := range runtime.outbound {
		outbound = append(outbound, proxy)
	}
	inbound := make([]*wireGuardInboundProxy, 0, len(runtime.inbound))
	for _, proxy := range runtime.inbound {
		inbound = append(inbound, proxy)
	}
	runtime.outbound = map[string]*wireGuardOutboundProxy{}
	runtime.outboundRefs = map[string]int{}
	runtime.refOutbound = map[string]map[string]struct{}{}
	runtime.inbound = map[string]*wireGuardInboundProxy{}
	runtime.inboundRefs = map[string]int{}
	runtime.refInbound = map[string]map[string]struct{}{}
	runtime.refs = map[string]int{}
	runtime.mu.Unlock()
	for _, proxy := range outbound {
		proxy.close()
	}
	for _, proxy := range inbound {
		proxy.close()
	}
	if runtime.device != nil {
		runtime.device.Close()
	} else if runtime.tunDevice != nil {
		_ = runtime.tunDevice.Close()
	}
	logf("wireguard runtime stopped tunnel=%d", runtime.spec.TunnelID)
}

func prepareFXPWireGuard(spec fxpSpec, refID string) (prepared fxpSpec, err error) {
	if strings.ToLower(strings.TrimSpace(spec.TransportVersion)) != forwardXWireGuardVersion {
		return spec, nil
	}
	runtime, err := waitForWireGuardRuntime(spec.TunnelID, wireGuardRuntimeWaitTimeout)
	if err != nil {
		return spec, err
	}
	refID = strings.TrimSpace(refID)
	if refID == "" {
		return spec, errors.New("wireguard runtime reference is required")
	}
	if err := runtime.addRef(refID); err != nil {
		return spec, err
	}
	committed := false
	defer func() {
		if !committed {
			releaseWireGuardRuntimeInstanceRef(runtime, spec.TunnelID, refID)
		}
	}()
	if spec.Role == "exit" || spec.Role == "relay" {
		if err := runtime.ensureInboundProxy(refID, spec.ListenPort, spec.UDPListenPort); err != nil {
			return spec, err
		}
		spec.ListenHost = "127.0.0.1"
	}
	prepareEndpoint := func(peerID string, tcpPort, udpPort int) (string, int, int, error) {
		if udpPort <= 0 {
			udpPort = tcpPort
		}
		return runtime.ensureOutboundProxy(refID, peerID, tcpPort, udpPort)
	}
	prepareEntry := func(entry *fxpSpec) error {
		host, tcpPort, udpPort, err := prepareEndpoint(entry.ExitPeerID, entry.ExitPort, entry.UDPExitPort)
		if err != nil {
			return err
		}
		entry.ExitHost, entry.ExitPort, entry.UDPExitPort = host, tcpPort, udpPort
		for index := range entry.Exits {
			exit := &entry.Exits[index]
			host, tcpPort, udpPort, err := prepareEndpoint(exit.PeerID, exit.Port, exit.UDPPort)
			if err != nil {
				return err
			}
			exit.Host, exit.Port, exit.UDPPort = host, tcpPort, udpPort
		}
		return nil
	}
	if spec.Role == "entry" {
		if err := prepareEntry(&spec); err != nil {
			return spec, err
		}
	}
	if isFXPEntryGroup(spec) {
		for index := range spec.Entries {
			entry := &spec.Entries[index]
			if entry.Role != "entry" || entry.TunnelID != spec.TunnelID || entry.TransportVersion != forwardXWireGuardVersion {
				return spec, fmt.Errorf("invalid V2 entry group member tunnel=%d rule=%d", entry.TunnelID, entry.RuleID)
			}
			if err := prepareEntry(entry); err != nil {
				return spec, fmt.Errorf("prepare V2 entry group rule=%d: %w", entry.RuleID, err)
			}
		}
	}
	if spec.Role == "relay" {
		host, tcpPort, udpPort, err := prepareEndpoint(spec.RelayPeerID, spec.RelayExitPort, spec.UDPRelayExitPort)
		if err != nil {
			return spec, err
		}
		spec.RelayExitHost, spec.RelayExitPort, spec.UDPRelayExitPort = host, tcpPort, udpPort
		for index := range spec.Exits {
			exit := &spec.Exits[index]
			host, tcpPort, udpPort, err := prepareEndpoint(exit.PeerID, exit.Port, exit.UDPPort)
			if err != nil {
				return spec, err
			}
			exit.Host, exit.Port, exit.UDPPort = host, tcpPort, udpPort
		}
	}
	committed = true
	return spec, nil
}

type wireGuardProbeStatus uint8

const (
	wireGuardProbeSuccess wireGuardProbeStatus = iota
	wireGuardProbeTimeout
	wireGuardProbeNotReady
)

type wireGuardProbeDialFunc func(context.Context, *wireGuardRuntime, string, int) (net.Conn, error)

func wireGuardTCPLatency(tunnelID int, peerID string, port int, timeout time.Duration) (int, bool) {
	latency, status := wireGuardTCPLatencyDetailed(tunnelID, peerID, port, timeout)
	return latency, status == wireGuardProbeSuccess
}

func wireGuardTCPLatencyDetailed(tunnelID int, peerID string, port int, timeout time.Duration) (int, wireGuardProbeStatus) {
	return wireGuardTCPLatencyWithDial(
		tunnelID,
		peerID,
		port,
		timeout,
		func(ctx context.Context, runtime *wireGuardRuntime, peerID string, port int) (net.Conn, error) {
			return runtime.dialPeerTCP(ctx, peerID, port)
		},
	)
}

func wireGuardTCPLatencyWithDial(tunnelID int, peerID string, port int, timeout time.Duration, dial wireGuardProbeDialFunc) (int, wireGuardProbeStatus) {
	peerID = strings.TrimSpace(peerID)
	if tunnelID <= 0 || peerID == "" {
		return 0, wireGuardProbeNotReady
	}
	if port <= 0 || port > 65535 || dial == nil {
		return 0, wireGuardProbeTimeout
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	sawReadyPeer := false
	for {
		runtime, err := waitForWireGuardProbePeer(ctx, tunnelID, peerID)
		if err != nil {
			if !sawReadyPeer {
				return 0, wireGuardProbeNotReady
			}
			return 0, wireGuardProbeTimeout
		}
		sawReadyPeer = true
		started := time.Now()
		connection, err := dial(ctx, runtime, peerID, port)
		if err == nil {
			_ = connection.Close()
			latency := int(time.Since(started).Milliseconds())
			if latency < 1 {
				latency = 1
			}
			return latency, wireGuardProbeSuccess
		}
		if !waitForWireGuardProbeRetry(ctx) {
			return 0, wireGuardProbeTimeout
		}
	}
}

func waitForWireGuardProbePeer(ctx context.Context, tunnelID int, peerID string) (*wireGuardRuntime, error) {
	peerID = strings.TrimSpace(peerID)
	if tunnelID <= 0 || peerID == "" {
		return nil, errors.New("wireguard probe peer is invalid")
	}
	for {
		wireGuardRuntimesMu.RLock()
		runtime := wireGuardRuntimes[tunnelID]
		wireGuardRuntimesMu.RUnlock()
		if runtime != nil {
			runtime.mu.RLock()
			_, peerReady := runtime.peers[peerID]
			ready := !runtime.closed && peerReady
			runtime.mu.RUnlock()
			if ready {
				return runtime, nil
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wireGuardProbeReadyPoll):
		}
	}
}

func waitForWireGuardProbeRetry(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(wireGuardProbeRetryDelay):
		return true
	}
}
