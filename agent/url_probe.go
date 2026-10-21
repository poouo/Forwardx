package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
	"unicode"
)

func urlProbeKey(serviceID int, target string, timeout, status int) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s\n%d\n%d", target, timeout, status)))
	return fmt.Sprintf("service:%d:url:%x", serviceID, digest)
}

// One fresh, direct GET. Measure DNS + TCP + TLS + first response byte, not
// download speed or a reused connection. Do not follow redirects or use the
// host's HTTP_PROXY: a probe must describe this host's actual outbound path.
func urlConnectionProbe(target string, timeoutSeconds, expectedStatus int) probeMeasurement {
	result := probeMeasurement{ProbeCount: 1}
	parsed, err := url.Parse(target)
	if err != nil || len(target) > 2048 || parsed == nil || parsed.Hostname() == "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.Fragment != "" ||
		strings.ContainsAny(target, "\\") || strings.IndexFunc(target, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 ||
		timeoutSeconds < 1 || timeoutSeconds > 30 || expectedStatus < 200 || expectedStatus > 599 {
		result.Detail = "invalid URL probe settings"
		return result
	}
	timeout := time.Duration(timeoutSeconds) * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            (&net.Dialer{Timeout: timeout}).DialContext,
		DisableKeepAlives:      true,
		DisableCompression:     true,
		TLSHandshakeTimeout:    timeout,
		ResponseHeaderTimeout:  timeout,
		MaxResponseHeaderBytes: 64 * 1024,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport:     transport,
		Timeout:       timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	started := time.Now()
	var firstByteNanos atomic.Int64
	trace := &httptrace.ClientTrace{GotFirstResponseByte: func() { firstByteNanos.CompareAndSwap(0, time.Since(started).Nanoseconds()) }}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodGet, target, nil)
	if err != nil {
		result.Detail = "invalid URL probe request"
		return result
	}
	req.Close = true
	req.Header.Set("User-Agent", "ForwardX-URL-Probe")
	response, err := client.Do(req)
	if err != nil {
		// Do not echo the URL/query into shared logs; endpoints can contain keys.
		result.Detail = "URL connection, TLS or response failed"
		return result
	}
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		result.Detail = fmt.Sprintf("unexpected HTTP status %d", response.StatusCode)
		return result
	}
	elapsed := time.Duration(firstByteNanos.Load())
	if elapsed <= 0 {
		elapsed = time.Since(started)
	}
	result.LatencyMs = int(elapsed.Milliseconds())
	if result.LatencyMs < 1 {
		result.LatencyMs = 1
	}
	result.Reachable = true
	result.ProbeSuccesses = 1
	return result
}
