package main

import "testing"

func TestAgentEventHTTPTransportSupportsHTTP2(t *testing.T) {
	transport := newAgentEventHTTPTransport()
	if !transport.ForceAttemptHTTP2 {
		t.Fatal("event stream transport must support HTTP/2 proxies")
	}
}
