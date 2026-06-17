package main

import (
	"net"
	"testing"
)

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
