//go:build linux

package main

import (
	"bytes"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

// Explicit opt-in only. Every kernel mutation happens in a new network
// namespace, never in the CI runner's or user's host namespace.
func TestIPAccessLimitsNetworkNamespace(t *testing.T) {
	if os.Getenv("FORWARDX_TEST_PORT_LIMITS") != "1" {
		t.Skip("requires isolated Linux firewall test")
	}
	if os.Geteuid() != 0 {
		t.Fatal("root is required")
	}
	if os.Getenv("FORWARDX_IP_LIMIT_NETNS_CHILD") != "1" {
		cmd := exec.Command("unshare", "--net", os.Args[0], "-test.run=^TestIPAccessLimitsNetworkNamespace$", "-test.v", "-test.timeout=45s")
		cmd.Env = append(os.Environ(), "FORWARDX_IP_LIMIT_NETNS_CHILD=1")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("isolated IP-limit test: %v\n%s", err, out)
		} else {
			t.Log(string(out))
		}
		return
	}
	ours, err := os.Readlink("/proc/self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	host, err := os.Readlink("/proc/1/ns/net")
	if err != nil || ours == host {
		t.Fatal("refusing to modify host network namespace")
	}
	run := func(binary string, args ...string) {
		t.Helper()
		if out, err := exec.Command(binary, args...).CombinedOutput(); err != nil {
			t.Fatalf("%s: %v %s", binary, err, out)
		}
	}
	run("ip", "link", "set", "lo", "up")
	for _, addr := range []string{"192.0.2.1/32", "192.0.2.2/32", "192.0.2.3/32"} {
		run("ip", "addr", "add", addr, "dev", "lo")
	}
	run("ip", "-6", "addr", "add", "::2/128", "dev", "lo", "nodad")
	listen := func(network, addr string) int {
		t.Helper()
		ln, err := net.Listen(network, addr)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				go func() { defer conn.Close(); io.Copy(conn, conn) }()
			}
		}()
		return ln.Addr().(*net.TCPAddr).Port
	}
	port := listen("tcp4", "192.0.2.1:0")
	listen("tcp6", net.JoinHostPort("::1", strconv.Itoa(port)))
	udp, err := net.ListenPacket("udp4", "192.0.2.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { udp.Close() })
	go func() {
		buf := make([]byte, 4096)
		for {
			n, peer, err := udp.ReadFrom(buf)
			if err != nil {
				return
			}
			udp.WriteTo(buf[:n], peer)
		}
	}()
	udpPort := udp.LocalAddr().(*net.UDPAddr).Port
	policies := []ipLimitPolicy{{Spec: ipAccessLimitSpec{UserID: 1, MaxIPs: 1, TCPPorts: []int{port}, UDPPorts: []int{udpPort}}}}
	apply := func() {
		t.Helper()
		if err := syncIPLimitFirewall(policies, false); err != nil {
			t.Fatal(err)
		}
		if err := syncIPLimitFirewall(policies, true); err != nil {
			t.Fatal(err)
		}
	}
	apply()
	// Installing the conntrack hook above also loads the kernel module before
	// accessing its namespace-local accounting setting. No flows exist yet.
	run("sysctl", "-w", "net.netfilter.nf_conntrack_acct=1")
	dial := func(network, source, dest string, port int) (net.Conn, error) {
		d := net.Dialer{Timeout: 300 * time.Millisecond}
		if network == "udp4" {
			d.LocalAddr = &net.UDPAddr{IP: net.ParseIP(source)}
		} else {
			d.LocalAddr = &net.TCPAddr{IP: net.ParseIP(source)}
		}
		return d.Dial(network, net.JoinHostPort(dest, strconv.Itoa(port)))
	}
	echo := func(conn net.Conn) {
		t.Helper()
		if conn == nil {
			t.Fatal("nil echo connection")
		}
		conn.SetDeadline(time.Now().Add(time.Second))
		payload := bytes.Repeat([]byte("business"), 128)
		if _, err := conn.Write(payload); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, len(payload))
		if _, err := io.ReadFull(conn, buf); err != nil || !bytes.Equal(buf, payload) {
			t.Fatalf("echo failed: %v", err)
		}
	}
	connect := func(network, source, dest string, port int) net.Conn {
		t.Helper()
		conn, err := dial(network, source, dest, port)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	live := connect("tcp4", "192.0.2.2", "192.0.2.1", port)
	echo(live)
	flows, err := readIPLimitFlows([]ipAccessLimitSpec{policies[0].Spec})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, flow := range flows {
		found = found || (flow.ip == "192.0.2.2" && flow.business)
	}
	if !found {
		t.Fatalf("real conntrack accounting not observed: %+v", flows)
	}
	policies[0].Full, policies[0].IPs = true, []string{"192.0.2.2"}
	apply()
	echo(live)                                               // Existing admitted traffic survives a policy update.
	echo(connect("tcp4", "192.0.2.2", "192.0.2.1", port))    // Same IP, another connection.
	echo(connect("udp4", "192.0.2.2", "192.0.2.1", udpPort)) // Same shared TCP/UDP slot.
	for _, addr := range []struct{ network, source, dest string }{{"tcp4", "192.0.2.3", "192.0.2.1"}, {"tcp6", "::2", "::1"}} {
		if conn, err := dial(addr.network, addr.source, addr.dest, port); err == nil {
			conn.Close()
			t.Fatal("quota admitted another source/family")
		}
	}
	blocked := connect("udp4", "192.0.2.3", "192.0.2.1", udpPort)
	blocked.SetDeadline(time.Now().Add(300 * time.Millisecond))
	blocked.Write([]byte("probe"))
	if _, err := blocked.Read(make([]byte, 8)); err == nil {
		t.Fatal("UDP bypassed IP quota")
	}
	policies = nil
	apply()
	echo(live)
	echo(connect("tcp4", "192.0.2.3", "192.0.2.1", port))
	echo(connect("tcp6", "::2", "::1", port))
}
