package main

import (
	"bytes"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestUDPReplySessionKeySeparatesLocalDestinations(t *testing.T) {
	peer := &net.UDPAddr{IP: net.ParseIP("192.0.2.5"), Port: 45000}
	first := &udpReplyAddr{Addr: peer, localIP: netip.MustParseAddr("203.0.113.10")}
	second := &udpReplyAddr{Addr: peer, localIP: netip.MustParseAddr("198.51.100.20")}
	if udpReplySessionKey(first) == udpReplySessionKey(second) {
		t.Fatal("same client targeting different entry IPs must not share an upstream session")
	}
	if udpReplySessionKey(first) != udpReplySessionKey(&udpReplyAddr{Addr: peer, localIP: first.localIP}) {
		t.Fatal("subsequent packets for the same entry must reuse their session")
	}
	if first.String() != peer.String() {
		t.Fatal("reply metadata must not change the client address used for network I/O")
	}
	if udpReplySessionKey(peer) != peer.String() {
		t.Fatal("plain packet connections must keep the existing session key")
	}
}

func TestUDPReplySessionKeySeparatesIPv6Scopes(t *testing.T) {
	peer := &net.UDPAddr{IP: net.ParseIP("fe80::5"), Port: 45000, Zone: "eth0"}
	first := &udpReplyAddr{Addr: peer, localIP: netip.MustParseAddr("fe80::10"), ifIndex: 2}
	second := &udpReplyAddr{Addr: peer, localIP: first.localIP, ifIndex: 3}
	if udpReplySessionKey(first) == udpReplySessionKey(second) {
		t.Fatal("link-local destinations on different interfaces must not share a session")
	}
}

// Supply receive metadata on non-Linux development machines too, so the
// guard's real session lifecycle can be tested independently of kernel options.
type testUDPReplyMetadataConn struct{ net.PacketConn }

func (conn testUDPReplyMetadataConn) ReadFrom(buf []byte) (int, net.Addr, error) {
	n, addr, err := conn.PacketConn.ReadFrom(buf)
	if err != nil {
		return n, addr, err
	}
	entry, _, _ := strings.Cut(string(buf[:n]), "/")
	ip, err := netip.ParseAddr(entry)
	return n, &udpReplyAddr{Addr: addr, localIP: ip}, err
}

func (conn testUDPReplyMetadataConn) WriteTo(buf []byte, addr net.Addr) (int, error) {
	reply, ok := addr.(*udpReplyAddr)
	if !ok {
		return 0, fmt.Errorf("lost UDP reply metadata")
	}
	_, payload, ok := strings.Cut(string(buf), "|")
	entry, _, _ := strings.Cut(payload, "/")
	if !ok || reply.localIP.String() != entry {
		return 0, fmt.Errorf("UDP reply used %s, want %s", reply.localIP, entry)
	}
	return conn.PacketConn.WriteTo(buf, reply.Addr)
}

func TestProtocolGuardUDPReplyMetadataSessionLifecycle(t *testing.T) {
	backend, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := backend.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = backend.WriteTo(append([]byte(addr.String()+"|"), buf[:n]...), addr)
		}
	}()
	listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := newProtocolGuardServer(guardRule{
		RuleID: 9002, Protocol: "udp", TargetIP: "127.0.0.1", TargetPort: backend.LocalAddr().(*net.UDPAddr).Port,
	})
	server.udpConn = testUDPReplyMetadataConn{listener}
	done := make(chan struct{})
	go func() { defer close(done); server.serveUDP() }()
	defer func() {
		server.close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("UDP receive loop did not stop")
		}
	}()
	client, err := net.Dial("udp4", listener.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	sessions := map[string]string{}
	for round := 0; round < 3; round++ {
		for _, entry := range []string{"203.0.113.10", "198.51.100.20", "2001:db8::10"} {
			payload := []byte(fmt.Sprintf("%s/%d", entry, round))
			_ = client.SetDeadline(time.Now().Add(3 * time.Second))
			if _, err := client.Write(payload); err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, 2048)
			n, err := client.Read(buf)
			if err != nil {
				t.Fatalf("entry %s: %v", entry, err)
			}
			parts := bytes.SplitN(buf[:n], []byte("|"), 2)
			if len(parts) != 2 || !bytes.Equal(parts[1], payload) {
				t.Fatalf("unexpected UDP echo %q", buf[:n])
			}
			upstream := string(parts[0])
			if previous := sessions[entry]; previous != "" && previous != upstream {
				t.Fatalf("entry %s did not reuse its session", entry)
			}
			for other, session := range sessions {
				if other != entry && session == upstream {
					t.Fatalf("entries %s and %s shared UDP session %s", other, entry, upstream)
				}
			}
			sessions[entry] = upstream
		}
	}
}
