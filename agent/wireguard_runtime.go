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
	wireGuardUDPSessionIdleTimeout = 2 * time.Minute
	wireGuardRuntimeReleaseDelay   = time.Minute
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
	clientAddr   net.Addr
	lastActivity time.Time
	closeOnce    sync.Once
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
	inbound      map[string]*wireGuardInboundProxy
	refs         map[string]struct{}
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

func wireGuardDeviceConfig(spec wireGuardSpec) string {
	var builder strings.Builder
	builder.WriteString("private_key=")
	builder.WriteString(spec.PrivateKey)
	builder.WriteByte('\n')
	builder.WriteString("listen_port=")
	builder.WriteString(strconv.Itoa(spec.ListenPort))
	builder.WriteByte('\n')
	builder.WriteString("replace_peers=true\n")
	for _, peer := range spec.Peers {
		builder.WriteString("public_key=")
		builder.WriteString(peer.PublicKey)
		builder.WriteByte('\n')
		builder.WriteString("allowed_ip=")
		builder.WriteString(peer.Address)
		builder.WriteString("/32\n")
		if peer.EndpointHost != "" && peer.EndpointPort > 0 {
			builder.WriteString("endpoint=")
			builder.WriteString(net.JoinHostPort(peer.EndpointHost, strconv.Itoa(peer.EndpointPort)))
			builder.WriteByte('\n')
		}
		if peer.PersistentKeepalive > 0 {
			builder.WriteString("persistent_keepalive_interval=")
			builder.WriteString(strconv.Itoa(peer.PersistentKeepalive))
			builder.WriteByte('\n')
		}
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
	if err := dev.IpcSet(wireGuardDeviceConfig(normalized)); err != nil {
		dev.Close()
		return nil, fmt.Errorf("configure wireguard: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, fmt.Errorf("start wireguard: %w", err)
	}
	runtime := &wireGuardRuntime{
		spec:      normalized,
		signature: wireGuardSpecSignature(normalized),
		tunDevice: tunDevice,
		netstack:  tnet,
		device:    dev,
		peers:     map[string]wireGuardPeerSpec{},
		outbound:  map[string]*wireGuardOutboundProxy{},
		inbound:   map[string]*wireGuardInboundProxy{},
		refs:      map[string]struct{}{},
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
	if err := runtime.device.IpcSet(wireGuardDeviceConfig(normalized)); err != nil {
		return fmt.Errorf("update wireguard: %w", err)
	}
	runtime.spec = normalized
	runtime.signature = signature
	runtime.peers = map[string]wireGuardPeerSpec{}
	for _, peer := range normalized.Peers {
		runtime.peers[peer.ID] = peer
	}
	logf("wireguard runtime updated tunnel=%d listen=:%d peers=%d generation=%d", normalized.TunnelID, normalized.ListenPort, len(normalized.Peers), normalized.Generation)
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
		return current.update(normalized)
	}
	wireGuardRuntimes[normalized.TunnelID] = created
	wireGuardRuntimesMu.Unlock()
	return nil
}

func stopWireGuardRuntime(tunnelID int) {
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

func (runtime *wireGuardRuntime) addRef(id string) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.releaseTimer != nil {
		runtime.releaseTimer.Stop()
		runtime.releaseTimer = nil
	}
	runtime.refs[id] = struct{}{}
}

func releaseWireGuardRuntimeRef(tunnelID int, id string) {
	wireGuardRuntimesMu.RLock()
	runtime := wireGuardRuntimes[tunnelID]
	wireGuardRuntimesMu.RUnlock()
	if runtime == nil {
		return
	}
	runtime.mu.Lock()
	delete(runtime.refs, id)
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
				stopWireGuardRuntime(tunnelID)
			}
		})
	}
	runtime.mu.Unlock()
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

func listenLoopbackTCPAndUDP() (net.Listener, *net.UDPConn, int, error) {
	for attempt := 0; attempt < 32; attempt++ {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, nil, 0, err
		}
		port := listener.Addr().(*net.TCPAddr).Port
		udpConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: port})
		if err == nil {
			return listener, udpConn, port, nil
		}
		_ = listener.Close()
	}
	return nil, nil, 0, errors.New("allocate wireguard loopback proxy port failed")
}

func (runtime *wireGuardRuntime) ensureOutboundProxy(peerID string, tcpPort, udpPort int) (string, int, int, error) {
	peerID = strings.TrimSpace(peerID)
	if peerID == "" || tcpPort <= 0 || tcpPort > 65535 || udpPort <= 0 || udpPort > 65535 {
		return "", 0, 0, errors.New("wireguard outbound proxy target is invalid")
	}
	if _, err := runtime.peerAddress(peerID); err != nil {
		return "", 0, 0, err
	}
	key := fmt.Sprintf("%s:%d:%d", peerID, tcpPort, udpPort)
	runtime.mu.Lock()
	if proxy := runtime.outbound[key]; proxy != nil {
		port := proxy.tcpLn.Addr().(*net.TCPAddr).Port
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
		proxy.sessionsMu.Lock()
		session := proxy.sessions[key]
		if session == nil {
			remote, dialErr := runtime.dialPeerUDP(proxy.peerID, proxy.udpPort)
			if dialErr != nil {
				proxy.sessionsMu.Unlock()
				logf("wireguard udp proxy dial failed tunnel=%d peer=%s port=%d: %v", runtime.spec.TunnelID, proxy.peerID, proxy.udpPort, dialErr)
				continue
			}
			session = &wireGuardUDPProxySession{conn: remote, clientAddr: clientAddr, lastActivity: time.Now()}
			proxy.sessions[key] = session
			go copyWireGuardUDPResponses(remote, proxy.udpConn, clientAddr, func() {
				proxy.sessionsMu.Lock()
				if proxy.sessions[key] == session {
					delete(proxy.sessions, key)
				}
				proxy.sessionsMu.Unlock()
			})
		}
		session.lastActivity = time.Now()
		remote := session.conn
		proxy.sessionsMu.Unlock()
		_ = remote.SetWriteDeadline(time.Now().Add(wireGuardProxyDialTimeout))
		if _, err := remote.Write(buf[:n]); err != nil {
			session.close()
		}
	}
}

func (runtime *wireGuardRuntime) ensureInboundProxy(tcpPort, udpPort int) error {
	if tcpPort <= 0 || tcpPort > 65535 || udpPort <= 0 || udpPort > 65535 {
		return errors.New("wireguard inbound proxy port is invalid")
	}
	key := fmt.Sprintf("%d:%d", tcpPort, udpPort)
	runtime.mu.Lock()
	if runtime.inbound[key] != nil {
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
		proxy.sessionsMu.Lock()
		session := proxy.sessions[key]
		if session == nil {
			backend, dialErr := net.DialTimeout("udp", net.JoinHostPort(proxy.backendHost, strconv.Itoa(proxy.backendUDP)), wireGuardProxyDialTimeout)
			if dialErr != nil {
				proxy.sessionsMu.Unlock()
				logf("wireguard udp backend dial failed tunnel=%d port=%d: %v", runtime.spec.TunnelID, proxy.backendUDP, dialErr)
				continue
			}
			session = &wireGuardUDPProxySession{conn: backend, clientAddr: peerAddr, lastActivity: time.Now()}
			proxy.sessions[key] = session
			go copyWireGuardPacketResponses(backend, proxy.udpConn, peerAddr, func() {
				proxy.sessionsMu.Lock()
				if proxy.sessions[key] == session {
					delete(proxy.sessions, key)
				}
				proxy.sessionsMu.Unlock()
			})
		}
		session.lastActivity = time.Now()
		backend := session.conn
		proxy.sessionsMu.Unlock()
		_ = backend.SetWriteDeadline(time.Now().Add(wireGuardProxyDialTimeout))
		if _, err := backend.Write(buf[:n]); err != nil {
			session.close()
		}
	}
}

func copyWireGuardUDPResponses(source net.Conn, target *net.UDPConn, clientAddr net.Addr, done func()) {
	defer done()
	defer source.Close()
	buf := make([]byte, 65535)
	for {
		_ = source.SetReadDeadline(time.Now().Add(wireGuardUDPSessionIdleTimeout))
		n, err := source.Read(buf)
		if err != nil {
			return
		}
		_, _ = target.WriteTo(buf[:n], clientAddr)
	}
}

func copyWireGuardPacketResponses(source net.Conn, target net.PacketConn, clientAddr net.Addr, done func()) {
	defer done()
	defer source.Close()
	buf := make([]byte, 65535)
	for {
		_ = source.SetReadDeadline(time.Now().Add(wireGuardUDPSessionIdleTimeout))
		n, err := source.Read(buf)
		if err != nil {
			return
		}
		_, _ = target.WriteTo(buf[:n], clientAddr)
	}
}

func (session *wireGuardUDPProxySession) close() {
	session.closeOnce.Do(func() { _ = session.conn.Close() })
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

func prepareFXPWireGuard(spec fxpSpec) (fxpSpec, error) {
	if strings.ToLower(strings.TrimSpace(spec.TransportVersion)) != forwardXWireGuardVersion {
		return spec, nil
	}
	runtime, err := waitForWireGuardRuntime(spec.TunnelID, wireGuardRuntimeWaitTimeout)
	if err != nil {
		return spec, err
	}
	if spec.Role == "exit" || spec.Role == "relay" {
		if err := runtime.ensureInboundProxy(spec.ListenPort, spec.UDPListenPort); err != nil {
			return spec, err
		}
		spec.ListenHost = "127.0.0.1"
	}
	prepareEndpoint := func(peerID string, tcpPort, udpPort int) (string, int, int, error) {
		if udpPort <= 0 {
			udpPort = tcpPort
		}
		return runtime.ensureOutboundProxy(peerID, tcpPort, udpPort)
	}
	if spec.Role == "entry" {
		host, tcpPort, udpPort, err := prepareEndpoint(spec.ExitPeerID, spec.ExitPort, spec.UDPExitPort)
		if err != nil {
			return spec, err
		}
		spec.ExitHost, spec.ExitPort, spec.UDPExitPort = host, tcpPort, udpPort
		for index := range spec.Exits {
			exit := &spec.Exits[index]
			host, tcpPort, udpPort, err := prepareEndpoint(exit.PeerID, exit.Port, exit.UDPPort)
			if err != nil {
				return spec, err
			}
			exit.Host, exit.Port, exit.UDPPort = host, tcpPort, udpPort
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
	runtime.addRef(fxpServerID(spec))
	return spec, nil
}

func wireGuardTCPLatency(tunnelID int, peerID string, port int, timeout time.Duration) (int, bool) {
	wireGuardRuntimesMu.RLock()
	runtime := wireGuardRuntimes[tunnelID]
	wireGuardRuntimesMu.RUnlock()
	if runtime == nil || port <= 0 {
		return 0, false
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	started := time.Now()
	connection, err := runtime.dialPeerTCP(ctx, peerID, port)
	if err != nil {
		return 0, false
	}
	_ = connection.Close()
	latency := int(time.Since(started).Milliseconds())
	if latency < 1 {
		latency = 1
	}
	return latency, true
}
