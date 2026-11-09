package main

import (
	"encoding/binary"
	"errors"
	"net"
	"os"
	"runtime"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type icmpTestPacket struct {
	body []byte
	from net.Addr
}

type icmpTestConn struct {
	packets  []icmpTestPacket
	closed   bool
	deadline time.Time
	writes   int
	ip       net.IP
}

func (c *icmpTestConn) ReadFrom(buffer []byte) (int, net.Addr, error) {
	if len(c.packets) == 0 {
		return 0, nil, os.ErrDeadlineExceeded
	}
	packet := c.packets[0]
	c.packets = c.packets[1:]
	return copy(buffer, packet.body), packet.from, nil
}
func (c *icmpTestConn) WriteTo(packet []byte, address net.Addr) (int, error) {
	c.writes++
	if !address.(*net.IPAddr).IP.Equal(c.ip) {
		return 0, errors.New("wrong target")
	}
	reply := append([]byte(nil), packet...)
	if c.ip.To4() != nil {
		if packet[0] != 8 {
			return 0, errors.New("IPv4 requires echo request type 8")
		}
		reply[0] = 0
	} else {
		if packet[0] != 128 {
			return 0, errors.New("IPv6 requires echo request type 128")
		}
		if binary.BigEndian.Uint16(packet[2:4]) != 0 {
			return 0, errors.New("ICMPv6 checksum must be left for the kernel")
		}
		reply[0] = 129
	}
	peer := &net.IPAddr{IP: c.ip}
	// A reply from another concurrent probe must not count, even if its
	// identifier and sequence happen to match this process's current request.
	unrelated := append([]byte(nil), reply...)
	unrelated[len(unrelated)-1] ^= 1
	c.packets = append(c.packets, icmpTestPacket{unrelated, peer})
	c.packets = append(c.packets, icmpTestPacket{append([]byte(nil), reply...), &net.IPAddr{IP: net.ParseIP("192.0.2.254")}})
	c.packets = append(c.packets, icmpTestPacket{reply, peer})
	return len(packet), nil
}
func (c *icmpTestConn) Close() error                           { c.closed = true; return nil }
func (c *icmpTestConn) LocalAddr() net.Addr                    { return &net.IPAddr{} }
func (c *icmpTestConn) SetDeadline(value time.Time) error      { c.deadline = value; return nil }
func (c *icmpTestConn) SetReadDeadline(value time.Time) error  { return c.SetDeadline(value) }
func (c *icmpTestConn) SetWriteDeadline(value time.Time) error { return c.SetDeadline(value) }

func TestNativePingBothAddressFamiliesWithoutTCP(t *testing.T) {
	for _, target := range []string{"192.0.2.10", "2001:db8::10"} {
		t.Run(target, func(t *testing.T) {
			ip := net.ParseIP(target)
			conn := &icmpTestConn{ip: ip}
			listen := func(network, bind string) (net.PacketConn, error) {
				if ip.To4() == nil {
					if network != "ip6:ipv6-icmp" || bind != "::" {
						t.Fatalf("wrong IPv6 transport %s %s", network, bind)
					}
				} else if network != "ip4:icmp" || bind != "0.0.0.0" {
					t.Fatalf("wrong IPv4 transport %s %s", network, bind)
				}
				return conn, nil
			}
			latency, ok, err, sent, successes := nativePingIPWithPacketConn(ip, time.Second, 3, listen)
			if err != nil || !ok || latency < 1 || sent != 3 || successes != 3 {
				t.Fatalf("result %d %v %v %d/%d", latency, ok, err, successes, sent)
			}
			if !conn.closed || conn.deadline.IsZero() || conn.writes != 3 {
				t.Fatalf("socket lifecycle %+v", conn)
			}
		})
	}
}

func TestNativePingTargetsTryBothFamiliesAndKeepCountsForOneAddress(t *testing.T) {
	var calls atomic.Int32
	probe := func(ip net.IP, timeout time.Duration, count int) (int, bool, error, int, int) {
		calls.Add(1)
		if timeout <= 0 || timeout > time.Second {
			return 0, false, errors.New("invalid budget"), 0, 0
		}
		if ip.To4() != nil {
			return 0, false, nil, count, 0
		}
		return 42, true, nil, count, 3
	}
	latency, ok, detail, sent, successes, err := nativePingTargetsDetailed([]string{"192.0.2.1", "192.0.2.1", "2001:db8::1"}, time.Now().Add(time.Second), 5, probe)
	if err != nil || !ok || latency != 42 || detail != "2001:db8::1" || sent != 5 || successes != 3 || calls.Load() != 2 {
		t.Fatalf("bad dual-stack result %d %v %s %d/%d calls=%d err=%v", latency, ok, detail, successes, sent, calls.Load(), err)
	}
}

func TestNativePingTargetsBoundWorkAndShareOneDeadline(t *testing.T) {
	var active, peak, calls atomic.Int32
	probe := func(_ net.IP, timeout time.Duration, count int) (int, bool, error, int, int) {
		current := active.Add(1)
		defer active.Add(-1)
		for previous := peak.Load(); current > previous; previous = peak.Load() {
			if peak.CompareAndSwap(previous, current) {
				break
			}
		}
		calls.Add(1)
		time.Sleep(timeout)
		return 0, false, nil, count, 0
	}
	targets := []string{"192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4", "192.0.2.5", "192.0.2.6", "192.0.2.7", "192.0.2.8", "192.0.2.9", "192.0.2.10", "2001:db8::1"}
	started := time.Now()
	_, ok, _, _, _, err := nativePingTargetsDetailed(targets, started.Add(50*time.Millisecond), 1, probe)
	if err != nil || ok {
		t.Fatalf("unexpected result ok=%v err=%v", ok, err)
	}
	if peak.Load() > 8 || calls.Load() > 8 || active.Load() != 0 {
		t.Fatalf("unbounded or unfinished probes peak=%d calls=%d active=%d", peak.Load(), calls.Load(), active.Load())
	}
	if elapsed := time.Since(started); elapsed > 400*time.Millisecond {
		t.Fatalf("per-address timeouts accumulated: %s", elapsed)
	}
	_, _, _, _, _, _ = nativePingTargetsDetailed(targets, time.Now().Add(-time.Second), 1, func(net.IP, time.Duration, int) (int, bool, error, int, int) {
		t.Error("DNS-expired deadline must not start new probes")
		return 0, false, nil, 0, 0
	})
}

func TestNativePingTargetsCannotLetDeadAddressesHideALaterHealthyOne(t *testing.T) {
	targets := []string{"192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4", "192.0.2.5", "192.0.2.6", "192.0.2.7", "192.0.2.8"}
	probe := func(ip net.IP, timeout time.Duration, count int) (int, bool, error, int, int) {
		if ip.Equal(net.ParseIP(targets[7])) {
			return 23, true, nil, count, count
		}
		time.Sleep(timeout)
		return 0, false, nil, count, 0
	}
	latency, ok, detail, _, _, err := nativePingTargetsDetailed(targets, time.Now().Add(100*time.Millisecond), 1, probe)
	if err != nil || !ok || latency != 23 || detail != targets[7] {
		t.Fatalf("healthy answer hidden: %d %v %s err=%v", latency, ok, detail, err)
	}
}

func TestNativePingLoopbackIPv4AndIPv6(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux raw-socket integration")
	}
	for _, target := range []string{"127.0.0.1", "::1"} {
		t.Run(target, func(t *testing.T) {
			latency, ok, err, sent, successes := nativePingIPDetailed(net.ParseIP(target), time.Second, 2)
			if errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EAFNOSUPPORT) || errors.Is(err, syscall.EADDRNOTAVAIL) {
				t.Skipf("raw ICMP unavailable: %v", err)
			}
			if err != nil || !ok || latency < 1 || sent != 2 || successes != 2 {
				t.Fatalf("loopback %s: %d %v %v %d/%d", target, latency, ok, err, successes, sent)
			}
		})
	}
}
