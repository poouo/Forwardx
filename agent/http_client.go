package main

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var agentSyncHTTPClient = &http.Client{
	Timeout:   60 * time.Second,
	Transport: newAgentHTTPTransport(true),
}

// Presence must fail fast enough to retry before the panel's online TTL even
// when a full reconciliation request is still stuck behind a slow proxy.
var agentPresenceHTTPClient = &http.Client{
	Timeout:   8 * time.Second,
	Transport: newAgentHTTPTransport(true),
}

var agentEventHTTPClient = &http.Client{
	Transport: newAgentEventHTTPTransport(),
}

var agentPublicHTTPClient = &http.Client{
	Timeout:   5 * time.Second,
	Transport: newAgentHTTPTransport(true),
}

func newAgentHTTPTransport(enableHTTP2 bool) *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// Only explicit config proxies management traffic, never probes or public-IP
	// discovery. Empty config means direct even with host-wide proxy variables.
	transport.Proxy = nil
	transport.MaxIdleConns = 64
	transport.MaxIdleConnsPerHost = 32
	transport.MaxConnsPerHost = 64
	transport.IdleConnTimeout = 90 * time.Second
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.ExpectContinueTimeout = time.Second
	transport.ForceAttemptHTTP2 = enableHTTP2
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	} else {
		transport.TLSClientConfig = transport.TLSClientConfig.Clone()
		transport.TLSClientConfig.MinVersion = tls.VersionTLS12
	}
	return transport
}

func newAgentEventHTTPTransport() *http.Transport {
	transport := newAgentHTTPTransport(true)
	transport.ResponseHeaderTimeout = 30 * time.Second
	return transport
}

func parseAgentProxy(raw string) (*url.URL, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" || u.Port() == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("proxyUrl must be http(s)://host:port or socks5(h)://host:port (optional URL-encoded credentials)")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("proxyUrl port must be between 1 and 65535")
	}
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return nil, fmt.Errorf("unsupported proxyUrl scheme; use http, https, socks5 or socks5h")
	}
	if u.Scheme == "socks5" {
		u.Scheme = "socks5h"
	}
	return u, nil
}

// Called once before any communication goroutines are started.
func configureAgentManagementProxy(raw string) error {
	u, err := parseAgentProxy(raw)
	if err != nil {
		return err
	}
	for _, client := range []*http.Client{agentSyncHTTPClient, agentPresenceHTTPClient, agentEventHTTPClient} {
		transport := client.Transport.(*http.Transport)
		transport.CloseIdleConnections()
		if u == nil {
			transport.Proxy = nil
		} else {
			transport.Proxy = http.ProxyURL(u)
		}
	}
	if u == nil {
		logf("management proxy disabled; direct connection")
	} else {
		logf("management proxy enabled scheme=%s endpoint=%s", u.Scheme, u.Host)
	}
	return nil
}
