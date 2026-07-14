package main

import (
	"bytes"
	"net"
	"testing"
	"time"
)

func TestDetectHTTPProtocolRequiresRequestLine(t *testing.T) {
	if detectHTTPProtocol([]byte("GET /")) {
		t.Fatal("expected short prefix to be rejected")
	}
	if !detectHTTPProtocol([]byte("GET / HTTP/1.1\r\nHost: example.com\r\n")) {
		t.Fatal("expected full request line to be detected")
	}
}

func TestDetectTLSProtocolRequiresHandshakeShape(t *testing.T) {
	if detectTLSProtocol([]byte{0x16, 0x03, 0x03, 0x00, 0x10}) {
		t.Fatal("expected short tls record to be rejected")
	}
	if !detectTLSProtocol([]byte{0x16, 0x03, 0x03, 0x00, 0x48, 0x01, 0x00, 0x00, 0x44}) {
		t.Fatal("expected shaped tls record to be detected")
	}
}

func TestDetectSocksProtocolRequiresFullGreeting(t *testing.T) {
	if detectSocksProtocol([]byte{0x05, 0x01, 0x00}) {
		t.Fatal("expected short socks greeting to be rejected")
	}
	if !detectSocksProtocol([]byte{0x05, 0x02, 0x00, 0x02}) {
		t.Fatal("expected socks greeting to be detected")
	}
}

func TestConsumeProxyProtocolV1(t *testing.T) {
	info, remaining, ok, err := consumeProxyProtocolV1([]byte("PROXY TCP4 203.0.113.9 10.0.0.5 45123 443\r\nGET / HTTP/1.1\r\n"))
	if err != nil {
		t.Fatalf("consumeProxyProtocolV1 error: %v", err)
	}
	if !ok {
		t.Fatal("expected proxy protocol header")
	}
	if got := string(remaining); got != "GET / HTTP/1.1\r\n" {
		t.Fatalf("remaining payload = %q", got)
	}
	if info.SourceIP != "203.0.113.9" || info.SourcePort != 45123 || info.DestIP != "10.0.0.5" || info.DestPort != 443 {
		t.Fatalf("unexpected proxy info: %+v", info)
	}
}

func TestConsumeProxyProtocolV1WithoutHeader(t *testing.T) {
	input := []byte("GET / HTTP/1.1\r\n")
	_, remaining, ok, err := consumeProxyProtocolV1(input)
	if err != nil {
		t.Fatalf("consumeProxyProtocolV1 error: %v", err)
	}
	if ok {
		t.Fatal("did not expect proxy protocol header")
	}
	if string(remaining) != string(input) {
		t.Fatalf("remaining payload = %q", string(remaining))
	}
}

func TestBuildProxyProtocolV1UsesParsedSource(t *testing.T) {
	header := buildProxyProtocolV1(
		proxyProtocolInfo{SourceIP: "198.51.100.7", SourcePort: 51443, DestIP: "10.0.0.5", DestPort: 8443},
		&net.TCPAddr{IP: net.ParseIP("192.0.2.10"), Port: 40000},
		nil,
		&net.TCPAddr{IP: net.ParseIP("10.0.0.5"), Port: 8443},
	)
	want := "PROXY TCP4 198.51.100.7 10.0.0.5 51443 8443\r\n"
	if header != want {
		t.Fatalf("header = %q, want %q", header, want)
	}
}

func TestBuildProxyProtocolV1FallsBackToClientAddr(t *testing.T) {
	header := buildProxyProtocolV1(
		proxyProtocolInfo{},
		&net.TCPAddr{IP: net.ParseIP("192.0.2.10"), Port: 40000},
		nil,
		&net.TCPAddr{IP: net.ParseIP("10.0.0.5"), Port: 8443},
	)
	want := "PROXY TCP4 192.0.2.10 10.0.0.5 40000 8443\r\n"
	if header != want {
		t.Fatalf("header = %q, want %q", header, want)
	}
}

func TestBuildAndConsumeProxyProtocolV2(t *testing.T) {
	header := buildProxyProtocol(2,
		proxyProtocolInfo{SourceIP: "198.51.100.7", SourcePort: 51443, DestIP: "10.0.0.5", DestPort: 8443},
		&net.TCPAddr{IP: net.ParseIP("192.0.2.10"), Port: 40000},
		nil,
		&net.TCPAddr{IP: net.ParseIP("10.0.0.5"), Port: 8443},
	)
	payload := append(header, []byte("payload")...)
	info, remaining, ok, err := consumeProxyProtocol(payload)
	if err != nil {
		t.Fatalf("consumeProxyProtocol v2 error: %v", err)
	}
	if !ok {
		t.Fatal("expected proxy protocol v2 header")
	}
	if string(remaining) != "payload" {
		t.Fatalf("remaining payload = %q", string(remaining))
	}
	if info.SourceIP != "198.51.100.7" || info.SourcePort != 51443 || info.DestIP != "10.0.0.5" || info.DestPort != 8443 {
		t.Fatalf("unexpected proxy info: %+v", info)
	}
}

func TestProtocolGuardProxyProtocolEndToEnd(t *testing.T) {
	tests := []struct {
		name           string
		version        int
		receive        bool
		send           bool
		incoming       proxyProtocolInfo
		expectedSource string
		expectHeader   bool
	}{
		{name: "plain input generates v1", version: 1, send: true, expectedSource: "127.0.0.1", expectHeader: true},
		{name: "v1 source is preserved", version: 1, receive: true, send: true, incoming: proxyProtocolInfo{SourceIP: "198.51.100.71", SourcePort: 45123, DestIP: "127.0.0.1", DestPort: 443}, expectedSource: "198.51.100.71", expectHeader: true},
		{name: "v2 source is preserved", version: 2, receive: true, send: true, incoming: proxyProtocolInfo{SourceIP: "203.0.113.82", SourcePort: 45124, DestIP: "127.0.0.1", DestPort: 8443}, expectedSource: "203.0.113.82", expectHeader: true},
		{name: "receive without send strips header", version: 1, receive: true, incoming: proxyProtocolInfo{SourceIP: "192.0.2.93", SourcePort: 45125, DestIP: "127.0.0.1", DestPort: 9443}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			targetLn, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatalf("target listen: %v", err)
			}
			defer targetLn.Close()
			targetAddr := targetLn.Addr().(*net.TCPAddr)

			guardLn, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatalf("guard listen: %v", err)
			}
			guardAddr := guardLn.Addr().(*net.TCPAddr)
			server := &protocolGuardServer{
				rule: guardRule{
					RuleID:               991,
					ListenPort:           guardAddr.Port,
					TargetIP:             targetAddr.IP.String(),
					TargetPort:           targetAddr.Port,
					Protocol:             "tcp",
					ProxyProtocolReceive: tc.receive,
					ProxyProtocolSend:    tc.send,
					ProxyProtocolVersion: tc.version,
				},
				tcpLn: guardLn,
				done:  make(chan struct{}),
			}
			go server.serveTCP(Config{})
			defer server.close()

			client, err := net.DialTimeout("tcp", guardAddr.String(), 2*time.Second)
			if err != nil {
				t.Fatalf("dial guard: %v", err)
			}
			defer client.Close()
			payload := []byte("guard-proxy-payload")
			input := append([]byte(nil), payload...)
			if tc.receive {
				input = append(buildProxyProtocol(tc.version, tc.incoming, nil, nil, nil), payload...)
			}
			if _, err := client.Write(input); err != nil {
				t.Fatalf("write guard input: %v", err)
			}

			if tcpLn, ok := targetLn.(*net.TCPListener); ok {
				_ = tcpLn.SetDeadline(time.Now().Add(3 * time.Second))
			}
			target, err := targetLn.Accept()
			if err != nil {
				t.Fatalf("accept target: %v", err)
			}
			defer target.Close()
			_ = target.SetReadDeadline(time.Now().Add(3 * time.Second))
			received := make([]byte, 0, 256)
			buf := make([]byte, 256)
			for !bytes.Contains(received, payload) {
				n, readErr := target.Read(buf)
				if n > 0 {
					received = append(received, buf[:n]...)
				}
				if readErr != nil {
					t.Fatalf("read target: %v", readErr)
				}
			}

			info, remaining, ok, err := consumeProxyProtocol(received)
			if err != nil {
				t.Fatalf("parse target proxy header: %v", err)
			}
			if tc.expectHeader {
				if !ok {
					t.Fatalf("expected proxy header, got %q", received)
				}
				if info.SourceIP != tc.expectedSource {
					t.Fatalf("source IP = %q, want %q", info.SourceIP, tc.expectedSource)
				}
				if !bytes.Equal(remaining, payload) {
					t.Fatalf("remaining payload = %q", remaining)
				}
			} else {
				if ok {
					t.Fatalf("did not expect proxy header: %+v", info)
				}
				if !bytes.Equal(remaining, payload) {
					t.Fatalf("plain payload = %q", remaining)
				}
			}
		})
	}
}
func TestNormalizeNetworkTargetHost(t *testing.T) {
	cases := map[string]string{
		"2402:4e00:c05::1":             "2402:4e00:c05::1",
		"[2402:4e00:c05::1]":           "2402:4e00:c05::1",
		"[2402:4e00:c05::1]:444":       "2402:4e00:c05::1",
		"tcp://[2402:4e00:c05::1]:444": "2402:4e00:c05::1",
		"ipv6.example.com:1888":        "ipv6.example.com",
	}
	for input, want := range cases {
		if got := normalizeNetworkTargetHost(input); got != want {
			t.Fatalf("normalizeNetworkTargetHost(%q) = %q, want %q", input, got, want)
		}
	}
}
