package main

import (
	"net"
	"testing"
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
