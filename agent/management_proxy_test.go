package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestManagementProxyValidation(t *testing.T) {
	for _, raw := range []string{"http://host", "socks5://host:0", "socks5://host:65536", "ftp://host:21", "http://user:secret@host:80/path", "http://user:secret@host:80?x=1"} {
		_, err := parseAgentProxy(raw)
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("expected redacted validation error: %v", err)
		}
	}
	u, err := parseAgentProxy("socks5://user:pass@localhost:1080")
	if err != nil || u.Scheme != "socks5h" {
		t.Fatalf("normalize: %v %v", u, err)
	}
}

func TestManagementHTTPProxyAndExplicitDirect(t *testing.T) {
	defer configureAgentManagementProxy("")
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Host != "panel.invalid" {
			t.Errorf("unexpected target: %s", r.URL.Host)
		}
		io.WriteString(w, "proxied")
	}))
	defer proxy.Close()
	if err := configureAgentManagementProxy(proxy.URL); err != nil {
		t.Fatal(err)
	}
	for _, client := range []*http.Client{agentSyncHTTPClient, agentPresenceHTTPClient, agentEventHTTPClient} {
		res, err := client.Get("http://panel.invalid/status")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if string(body) != "proxied" {
			t.Fatal(string(body))
		}
	}
	if agentPublicHTTPClient.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("public IP discovery must stay direct")
	}
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("ALL_PROXY", proxy.URL)
	if err := configureAgentManagementProxy(""); err != nil {
		t.Fatal(err)
	}
	for _, client := range []*http.Client{agentSyncHTTPClient, agentPresenceHTTPClient, agentEventHTTPClient} {
		if client.Transport.(*http.Transport).Proxy != nil {
			t.Fatal("empty config must be explicitly direct")
		}
	}
}

func TestManagementSOCKSProxyRemoteDNSAndAuthentication(t *testing.T) {
	defer configureAgentManagementProxy("")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	result := make(chan error, 1)
	go func() {
		result <- func() error {
			c, err := listener.Accept()
			if err != nil {
				return err
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(5 * time.Second))
			read := func(n int) ([]byte, error) { b := make([]byte, n); _, err := io.ReadFull(c, b); return b, err }
			b, err := read(2)
			if err != nil {
				return err
			}
			if b[0] != 5 {
				return fmt.Errorf("not SOCKS5")
			}
			if _, err = read(int(b[1])); err != nil {
				return err
			}
			c.Write([]byte{5, 2})
			b, err = read(2)
			if err != nil {
				return err
			}
			user, err := read(int(b[1]))
			if err != nil {
				return err
			}
			b, err = read(1)
			if err != nil {
				return err
			}
			pass, err := read(int(b[0]))
			if err != nil {
				return err
			}
			if string(user) != "test" || string(pass) != "secret" {
				return fmt.Errorf("wrong authentication")
			}
			c.Write([]byte{1, 0})
			b, err = read(5)
			if err != nil {
				return err
			}
			if b[0] != 5 || b[1] != 1 || b[3] != 3 {
				return fmt.Errorf("expected remote DNS domain")
			}
			host, err := read(int(b[4]))
			if err != nil {
				return err
			}
			port, err := read(2)
			if err != nil {
				return err
			}
			if string(host) != "panel.invalid" || binary.BigEndian.Uint16(port) != 80 {
				return fmt.Errorf("wrong target")
			}
			c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 80})
			req, err := http.ReadRequest(bufio.NewReader(c))
			if err != nil {
				return err
			}
			req.Body.Close()
			_, err = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
			return err
		}()
	}()
	if err := configureAgentManagementProxy("socks5://test:secret@" + listener.Addr().String()); err != nil {
		t.Fatal(err)
	}
	res, err := agentPresenceHTTPClient.Get("http://panel.invalid/status")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestUpgradeProxyReadsProtectedConfig(t *testing.T) {
	setup := agentUpgradeProxySetup("/etc/forwardx/agent/config.json")
	for _, expected := range []string{"jq -er", "proxyUrl", "unset http_proxy", "FORWARDX_AGENT_PROXY", "socks5h://", "upgrade cancelled"} {
		if !strings.Contains(setup, expected) {
			t.Fatalf("missing %s", expected)
		}
	}
}
