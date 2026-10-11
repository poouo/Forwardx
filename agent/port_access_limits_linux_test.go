//go:build linux

package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Run with FORWARDX_TEST_PORT_LIMITS=1 as root. All firewall operations are
// isolated in a fresh network namespace; never alter the runner/host ruleset.
func TestPortAccessLimitsNetworkNamespace(t *testing.T) {
	if os.Getenv("FORWARDX_TEST_PORT_LIMITS") != "1" {
		t.Skip("requires explicit isolated Linux firewall test")
	}
	if os.Geteuid() != 0 {
		t.Fatal("run the isolated firewall test as root")
	}
	if os.Getenv("FORWARDX_PORT_LIMIT_NETNS_CHILD") != "1" {
		cmd := exec.Command("unshare", "--net", os.Args[0], "-test.run=^TestPortAccessLimitsNetworkNamespace$", "-test.v", "-test.timeout=60s")
		cmd.Env = append(os.Environ(), "FORWARDX_PORT_LIMIT_NETNS_CHILD=1")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated firewall test failed: %v\n%s", err, out)
		}
		t.Log(string(out))
		return
	}
	ours, err := os.Readlink("/proc/self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	host, err := os.Readlink("/proc/1/ns/net")
	if err != nil || ours == host {
		t.Fatal("refusing to modify the host network namespace")
	}
	if out, err := exec.Command("ip", "link", "set", "lo", "up").CombinedOutput(); err != nil {
		t.Fatalf("loopback: %v %s", err, out)
	}
	for _, ipv6 := range []bool{false, true} {
		t.Run(fmt.Sprintf("ipv6=%v", ipv6), func(t *testing.T) { testPortAccessLimitTraffic(t, ipv6) })
	}
}

func testPortAccessLimitTraffic(t *testing.T, ipv6 bool) {
	t.Helper()
	host, otherSource, binary, network := "127.0.0.1", "127.0.0.2", "iptables", "tcp4"
	if ipv6 {
		host, otherSource, binary, network = "::1", "::2", "ip6tables", "tcp6"
		if out, err := exec.Command("ip", "-6", "addr", "add", "::2/128", "dev", "lo", "nodad").CombinedOutput(); err != nil {
			t.Fatalf("IPv6 source: %v %s", err, out)
		}
	}
	listen := func() (net.Listener, int) {
		ln, err := net.Listen(network, net.JoinHostPort(host, "0"))
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
		return ln, ln.Addr().(*net.TCPAddr).Port
	}
	_, portA := listen()
	_, portB := listen()
	_, portC := listen()
	_, portOtherUser := listen()
	free, natEntry := listen()
	free.Close()
	// The destination port is changed after mangle OUTPUT, simulating the same
	// pre-DNAT port identity as a kernel forwarding entry.
	natArgs := []string{"-w", "5", "-t", "nat", "-A", "OUTPUT", "-p", "tcp", "-d", host, "--dport", strconv.Itoa(natEntry), "-j", "DNAT", "--to-destination", net.JoinHostPort(host, strconv.Itoa(portC))}
	if out, err := exec.Command(binary, natArgs...).CombinedOutput(); err != nil {
		t.Fatalf("DNAT fixture: %v %s", err, out)
	}
	fw := systemPortLimitFirewall{}
	specs := []portAccessLimitSpec{{UserID: 1, MaxIPs: 2, Ports: []int{portA, portB, natEntry}}, {UserID: 2, MaxIPs: 2, Ports: []int{portOtherUser}}}
	apply := func() {
		if err := syncPortAccessLimits(fw, specs, false); err != nil {
			t.Fatal(err)
		}
		if err := syncPortAccessLimits(fw, specs, true); err != nil {
			t.Fatal(err)
		}
	}
	apply()
	dial := func(port int, source string) (net.Conn, error) {
		d := net.Dialer{Timeout: 250 * time.Millisecond, LocalAddr: &net.TCPAddr{IP: net.ParseIP(source)}}
		return d.Dial(network, net.JoinHostPort(host, strconv.Itoa(port)))
	}
	connect := func(port int, source string) net.Conn {
		conn, err := dial(port, source)
		if err != nil {
			t.Fatalf("connect %d source=%s: %v", port, source, err)
		}
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	echo := func(conn net.Conn) {
		conn.SetDeadline(time.Now().Add(time.Second))
		if _, err := conn.Write([]byte("payload")); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 7)
		if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "payload" {
			t.Fatalf("existing connection interrupted: %s %v", buf, err)
		}
	}
	first, second := connect(portA, host), connect(portB, host)
	echo(first)
	echo(second)
	if conn, err := dial(natEntry, host); err == nil {
		conn.Close()
		t.Fatal("shared single-IP limit did not reject the third connection")
	}
	echo(connect(natEntry, otherSource)) // Another source IP is independent, including DNAT.
	echo(connect(portOtherUser, host))   // Another user is independent.
	_, addedPort := listen()
	specs[0].Ports = append(specs[0].Ports, addedPort)
	apply()
	if conn, err := dial(addedPort, host); err == nil {
		conn.Close()
		t.Fatal("adding a rule reset active connection counts")
	}
	echo(first)
	echo(second)
	second.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		conn, err := dial(addedPort, host)
		if err == nil {
			echo(conn)
			conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("closed connections did not release the per-IP limit")
		}
		time.Sleep(100 * time.Millisecond)
	}
	specs = nil
	apply()
	echo(first)
	echo(connect(addedPort, host))
	// The independent DNAT rule must survive limit removal.
	out, err := exec.Command(binary, "-t", "nat", "-S", "OUTPUT").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "--dport "+strconv.Itoa(natEntry)) {
		t.Fatal("limit cleanup altered DNAT")
	}
}
