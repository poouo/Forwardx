//go:build linux

package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

func TestConnectionLimitsNetworkNamespace(t *testing.T) {
	if os.Getenv("FORWARDX_TEST_CONNECTION_LIMITS") != "1" {
		t.Skip("requires isolated Linux firewall test")
	}
	if os.Geteuid() != 0 {
		t.Fatal("requires root")
	}
	if os.Getenv("FORWARDX_CONNECTION_LIMIT_NETNS_CHILD") != "1" {
		cmd := exec.Command("unshare", "--net", os.Args[0], "-test.run=^TestConnectionLimitsNetworkNamespace$", "-test.v", "-test.timeout=90s")
		cmd.Env = append(os.Environ(), "FORWARDX_CONNECTION_LIMIT_NETNS_CHILD=1")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated connection test: %v\n%s", err, out)
		}
		t.Log(string(out))
		return
	}
	ours, err := os.Readlink("/proc/self/ns/net")
	host, hostErr := os.Readlink("/proc/1/ns/net")
	if err != nil || hostErr != nil || ours == host {
		t.Fatal("refusing host firewall access")
	}
	if out, err := exec.Command("ip", "link", "set", "lo", "up").CombinedOutput(); err != nil {
		t.Fatalf("loopback: %v %s", err, out)
	}
	for _, key := range []string{"nf_conntrack_udp_timeout", "nf_conntrack_udp_timeout_stream"} {
		if err := os.WriteFile("/proc/sys/net/netfilter/"+key, []byte("2"), 0644); err != nil {
			t.Fatal(err)
		}
	}

	listenTCP := func(network, host string) int {
		ln, err := net.Listen(network, net.JoinHostPort(host, "0"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		go func() {
			for {
				c, e := ln.Accept()
				if e != nil {
					return
				}
				go func() { defer c.Close(); io.Copy(c, c) }()
			}
		}()
		return ln.Addr().(*net.TCPAddr).Port
	}
	listenUDP := func(network, host string) int {
		ln, err := net.ListenPacket(network, net.JoinHostPort(host, "0"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		go func() {
			b := make([]byte, 1024)
			for {
				n, a, e := ln.ReadFrom(b)
				if e != nil {
					return
				}
				ln.WriteTo(b[:n], a)
			}
		}()
		return ln.LocalAddr().(*net.UDPAddr).Port
	}
	tcp4, tcp6 := listenTCP("tcp4", "127.0.0.1"), listenTCP("tcp6", "::1")
	udp4, udp6 := listenUDP("udp4", "127.0.0.1"), listenUDP("udp6", "::1")
	specs := []connectionLimitSpec{{UserID: 1, MaxConnections: 4, TCPPorts: []int{tcp4, tcp6}, UDPPorts: []int{udp4, udp6}}}
	apply := func() {
		t.Helper()
		if err := syncConnectionLimits(specs, false); err != nil {
			t.Fatal(err)
		}
		if err := syncConnectionLimits(specs, true); err != nil {
			t.Fatal(err)
		}
	}
	apply()
	dial := func(network, host string, port int) net.Conn {
		c, e := net.DialTimeout(network, net.JoinHostPort(host, strconv.Itoa(port)), 300*time.Millisecond)
		if e != nil {
			return nil
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
	echo := func(c net.Conn) bool {
		if c == nil {
			return false
		}
		c.SetDeadline(time.Now().Add(300 * time.Millisecond))
		if _, e := c.Write([]byte("probe")); e != nil {
			return false
		}
		b := make([]byte, 5)
		_, e := io.ReadFull(c, b)
		return e == nil && string(b) == "probe"
	}
	first, second := dial("tcp4", "127.0.0.1", tcp4), dial("tcp6", "::1", tcp6)
	third, fourth := dial("udp4", "127.0.0.1", udp4), dial("udp6", "::1", udp6)
	for i, c := range []net.Conn{first, second, third, fourth} {
		if !echo(c) {
			t.Fatalf("admitted flow %d failed", i)
		}
	}
	for _, v := range []struct {
		network, host string
		port          int
	}{{"tcp4", "127.0.0.1", tcp4}, {"tcp6", "::1", tcp6}, {"udp4", "127.0.0.1", udp4}, {"udp6", "::1", udp6}} {
		c := dial(v.network, v.host, v.port)
		if echo(c) {
			t.Fatalf("shared cap bypassed by %s", v.network)
		}
		if c != nil {
			c.Close()
		}
	}
	for _, c := range []net.Conn{first, second, third, fourth} {
		if !echo(c) {
			t.Fatal("over-limit attempt interrupted established flow")
		}
	}
	added := listenTCP("tcp4", "127.0.0.1")
	specs[0].TCPPorts = append(specs[0].TCPPorts, added)
	apply()
	if c := dial("tcp4", "127.0.0.1", added); echo(c) {
		t.Fatal("adding a port reset active quota")
	} else if c != nil {
		c.Close()
	}
	second.Close()
	deadline := time.Now().Add(8 * time.Second)
	var replacement net.Conn
	for time.Now().Before(deadline) {
		// Keep UDP established while waiting for TCP conntrack cleanup.
		echo(third)
		echo(fourth)
		c := dial("tcp4", "127.0.0.1", added)
		if echo(c) {
			replacement = c
			break
		}
		if c != nil {
			c.Close()
		}
		time.Sleep(100 * time.Millisecond)
	}
	if replacement == nil {
		t.Fatal("TCP closure did not release quota")
	}
	third.Close()
	fourth.Close()
	time.Sleep(4 * time.Second)
	if c := dial("udp6", "::1", udp6); !echo(c) {
		t.Fatal("UDP idle sessions did not release quota")
	}
	specs[0].MaxConnections = 1
	apply()
	if !echo(first) || !echo(replacement) {
		t.Fatal("lowering quota interrupted established TCP")
	}
	// A new threshold creates a new conntrack admission list. Old established
	// flows are grandfathered, while new admissions obey the changed ceiling.
	newAdmission := dial("tcp4", "127.0.0.1", added)
	if !echo(newAdmission) {
		t.Fatal("changed quota failed to admit its first new flow")
	}
	if c := dial("tcp4", "127.0.0.1", added); echo(c) {
		t.Fatal("changed quota admitted more than one new flow")
	} else if c != nil {
		c.Close()
	}
	specs = nil
	apply()
	if !echo(first) || !echo(dial("tcp4", "127.0.0.1", added)) {
		t.Fatal("removing quota failed")
	}
	t.Log(fmt.Sprintf("TCP+UDP IPv4+IPv6 quota, live port addition, close/idle release and established preservation passed"))
}
