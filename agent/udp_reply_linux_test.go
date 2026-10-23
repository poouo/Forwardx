//go:build linux

package main

import (
	"bytes"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestParseUDPReplyPacketInfo(t *testing.T) {
	peer := &net.UDPAddr{IP: net.ParseIP("192.0.2.5"), Port: 45000}
	for _, tc := range []struct {
		name    string
		oob     []byte
		wantIP  string
		wantIf  int
		wantErr bool
	}{
		{
			name: "IPv4 uses local address, not broadcast destination or ingress interface",
			oob: unix.PktInfo4(&unix.Inet4Pktinfo{
				Ifindex: 3, Spec_dst: [4]byte{203, 0, 113, 10}, Addr: [4]byte{203, 0, 113, 255},
			}),
			wantIP: "203.0.113.10",
		},
		{
			name:   "IPv6 preserves destination without overriding egress route",
			oob:    unix.PktInfo6(&unix.Inet6Pktinfo{Addr: netip.MustParseAddr("2001:db8::10").As16(), Ifindex: 3}),
			wantIP: "2001:db8::10",
		},
		{
			name:   "IPv4 mapped IPv6",
			oob:    unix.PktInfo6(&unix.Inet6Pktinfo{Addr: netip.MustParseAddr("::ffff:203.0.113.10").As16(), Ifindex: 3}),
			wantIP: "203.0.113.10",
		},
		{
			name:   "IPv6 link local preserves scope",
			oob:    unix.PktInfo6(&unix.Inet6Pktinfo{Addr: netip.MustParseAddr("fe80::10").As16(), Ifindex: 3}),
			wantIP: "fe80::10", wantIf: 3,
		},
		{name: "missing packet info is not silently ignored", wantErr: true},
		{name: "malformed packet info", oob: []byte{1, 2, 3}, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			addr, err := parseUDPReplyAddr(peer, tc.oob)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if addr.localIP.String() != tc.wantIP || addr.ifIndex != tc.wantIf {
				t.Fatalf("reply path = %s/%d, want %s/%d", addr.localIP, addr.ifIndex, tc.wantIP, tc.wantIf)
			}
		})
	}
}

// No public IPs, firewall changes, or root privileges are needed. Linux routes
// all of 127/8 locally: replying from a plain wildcard socket chooses 127.0.0.1,
// reproducing the reported failure when the client contacts 127.0.0.2 instead.
func TestProtocolGuardUDPMultiIPReplySource(t *testing.T) {
	for _, tc := range []struct {
		name    string
		network string
		listen  string
		entries []string
	}{
		{"IPv4 wildcard", "udp4", "0.0.0.0:0", []string{"127.0.0.1", "127.0.0.2"}},
		{"dual stack wildcard", "udp", "[::]:0", []string{"127.0.0.1", "127.0.0.2", "::1"}},
		{"explicit IPv4 bind", "udp4", "127.0.0.2:0", []string{"127.0.0.2"}},
		{"explicit IPv6 bind", "udp6", "[::1]:0", []string{"::1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend, err := net.ListenPacket("udp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = backend.Close() })
			// Include the backend session's peer port in every reply, to prove
			// that different local destinations do not share a session.
			go func() {
				buf := make([]byte, 2048)
				for {
					n, peer, err := backend.ReadFrom(buf)
					if err != nil {
						return
					}
					_, _ = backend.WriteTo(append([]byte(peer.String()+"|"), buf[:n]...), peer)
				}
			}()
			wrapped, err := listenUDPReplyConn(tc.network, tc.listen)
			if err != nil {
				if strings.Contains(tc.listen, "::") && (errors.Is(err, unix.EAFNOSUPPORT) || errors.Is(err, unix.EADDRNOTAVAIL) || errors.Is(err, unix.EPROTONOSUPPORT)) {
					t.Skipf("IPv6 unavailable: %v", err)
				}
				t.Fatal(err)
			}
			server := newProtocolGuardServer(guardRule{
				RuleID: 9001, Protocol: "udp", TargetIP: "127.0.0.1", TargetPort: backend.LocalAddr().(*net.UDPAddr).Port,
			})
			server.udpConn = wrapped
			done := make(chan struct{})
			go func() { defer close(done); server.serveUDP() }()
			t.Cleanup(func() {
				server.close()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Error("UDP receive loop did not stop")
				}
			})
			clients := map[bool]*net.UDPConn{}
			for _, entry := range tc.entries {
				v4 := net.ParseIP(entry).To4() != nil
				if clients[v4] != nil {
					continue
				}
				network, host := "udp6", "::1"
				if v4 {
					network, host = "udp4", "127.0.0.1"
				}
				client, err := net.ListenUDP(network, &net.UDPAddr{IP: net.ParseIP(host)})
				if err != nil {
					t.Fatal(err)
				}
				clients[v4] = client
				t.Cleanup(func() { _ = client.Close() })
			}
			seenSessions := map[string]string{}
			port := wrapped.LocalAddr().(*net.UDPAddr).Port
			for round := 0; round < 3; round++ {
				// Send to every entry before reading, so concurrent replies
				// cannot accidentally rely on a last-seen per-client address.
				for _, entry := range tc.entries {
					client := clients[net.ParseIP(entry).To4() != nil]
					payload := []byte(entry + "/" + strconv.Itoa(round))
					_ = client.SetDeadline(time.Now().Add(3 * time.Second))
					if _, err := client.WriteToUDP(payload, &net.UDPAddr{IP: net.ParseIP(entry), Port: port}); err != nil {
						t.Fatal(err)
					}
				}
				seenEntries := map[string]bool{}
				for _, entry := range tc.entries {
					client := clients[net.ParseIP(entry).To4() != nil]
					buf := make([]byte, 2048)
					n, source, err := client.ReadFromUDP(buf)
					if err != nil {
						t.Fatalf("read UDP response: %v", err)
					}
					parts := bytes.SplitN(buf[:n], []byte("|"), 2)
					if len(parts) != 2 {
						t.Fatalf("invalid backend response %q", buf[:n])
					}
					payload := string(parts[1])
					address, _, ok := strings.Cut(payload, "/")
					if !ok || source.IP.String() != address || source.Port != port {
						t.Fatalf("reply source %s does not match entry for %q (port %d)", source, payload, port)
					}
					if seenEntries[address] {
						t.Fatalf("duplicate reply from %s", address)
					}
					seenEntries[address] = true
					upstream := string(parts[0])
					if previous := seenSessions[address]; previous != "" && previous != upstream {
						t.Fatalf("entry %s did not reuse its UDP session", address)
					}
					for other, session := range seenSessions {
						if other != address && session == upstream {
							t.Fatalf("entries %s and %s shared UDP session %s", other, address, upstream)
						}
					}
					seenSessions[address] = upstream
				}
				if len(seenEntries) != len(tc.entries) {
					t.Fatalf("missing entry replies: %v", seenEntries)
				}
			}
		})
	}
}
