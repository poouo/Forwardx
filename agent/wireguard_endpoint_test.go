package main

import (
	"context"
	"errors"
	"net/netip"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestWireGuardEndpointLiteralsDoNotNeedDNS(t *testing.T) {
	for _, host := range []string{"192.0.2.10", "2001:db8::10", "[2001:db8::10]", "fe80::1%eth0", "::ffff:192.0.2.10"} {
		t.Run(host, func(t *testing.T) {
			spec := wireGuardSpec{Peers: []wireGuardPeerSpec{{ID: "exit", EndpointHost: host, EndpointPort: 64182}}}
			resolved, err := resolveWireGuardEndpoints(context.Background(), spec, func(context.Context, string, string) ([]netip.Addr, error) {
				t.Fatal("numeric endpoint performed DNS lookup")
				return nil, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := netip.ParseAddr(resolved.Peers[0].EndpointHost); err != nil {
				t.Fatalf("non-numeric endpoint: %v", err)
			}
			if spec.Peers[0].EndpointHost != host || resolved.Peers[0].EndpointPort != 64182 {
				t.Fatal("resolution mutated the desired host or endpoint port")
			}
		})
	}
}

func TestWireGuardEndpointDNSFamiliesAndPerApplyCache(t *testing.T) {
	for _, ipv6Only := range []bool{false, true} {
		t.Run(map[bool]string{false: "dual-stack", true: "AAAA-only"}[ipv6Only], func(t *testing.T) {
			spec := wireGuardSpec{Peers: []wireGuardPeerSpec{
				{ID: "exit", EndpointHost: "exit.example", EndpointPort: 64182},
				{ID: "same-domain", EndpointHost: "EXIT.EXAMPLE", EndpointPort: 64183},
				{ID: "inbound"},
			}}
			calls := 0
			resolved, err := resolveWireGuardEndpoints(context.Background(), spec, func(_ context.Context, network, host string) ([]netip.Addr, error) {
				calls++
				if network != "ip" || host != "exit.example" {
					t.Fatalf("unexpected lookup network=%s host=%s", network, host)
				}
				ips := []netip.Addr{netip.MustParseAddr("2001:db8::10")}
				if !ipv6Only {
					ips = append(ips, netip.MustParseAddr("192.0.2.10"))
				}
				return ips, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			want := "192.0.2.10"
			if ipv6Only {
				want = "2001:db8::10"
			}
			if calls != 1 || resolved.Peers[0].EndpointHost != want || resolved.Peers[1].EndpointHost != want || resolved.Peers[2].EndpointHost != "" {
				t.Fatalf("unexpected resolution calls=%d peers=%+v", calls, resolved.Peers)
			}
			if strings.Contains(wireGuardDeviceConfig(resolved, false, nil), "EXAMPLE") || strings.Contains(wireGuardDeviceConfig(resolved, false, nil), "example") {
				t.Fatal("domain leaked into numeric WireGuard IPC endpoint")
			}
		})
	}
}

func TestWireGuardEndpointDNSRefreshKeepsDesiredDomain(t *testing.T) {
	spec := wireGuardSpec{Peers: []wireGuardPeerSpec{{ID: "exit", EndpointHost: "ddns.example", EndpointPort: 64182}}}
	for _, ip := range []string{"192.0.2.10", "192.0.2.11"} {
		resolved, err := resolveWireGuardEndpoints(context.Background(), spec, func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr(ip)}, nil
		})
		if err != nil || resolved.Peers[0].EndpointHost != ip {
			t.Fatalf("refresh did not pick up changed DNS: %v", err)
		}
		if spec.Peers[0].EndpointHost != "ddns.example" {
			t.Fatal("resolved IP replaced the desired/persisted domain")
		}
	}
}

func TestWireGuardEndpointDNSFailureDoesNotMutateDesiredPeers(t *testing.T) {
	spec := wireGuardSpec{Peers: []wireGuardPeerSpec{
		{ID: "good", EndpointHost: "good.example", EndpointPort: 64182},
		{ID: "bad", EndpointHost: "bad.example", EndpointPort: 64183},
	}}
	original := append([]wireGuardPeerSpec(nil), spec.Peers...)
	dnsError := errors.New("DNS unavailable")
	_, err := resolveWireGuardEndpoints(context.Background(), spec, func(_ context.Context, _, host string) ([]netip.Addr, error) {
		if host == "bad.example" {
			return nil, dnsError
		}
		return []netip.Addr{netip.MustParseAddr("192.0.2.10")}, nil
	})
	if !errors.Is(err, dnsError) || !strings.Contains(err.Error(), "peer bad endpoint") || !reflect.DeepEqual(spec.Peers, original) {
		t.Fatalf("DNS failure lost context or mutated desired config: %v", err)
	}
	_, err = resolveWireGuardEndpoints(context.Background(), spec, func(context.Context, string, string) ([]netip.Addr, error) { return nil, nil })
	if err == nil || !strings.Contains(err.Error(), "no usable A/AAAA records") {
		t.Fatalf("empty DNS response was not rejected: %v", err)
	}
}

func TestWireGuardEndpointDNSHasOneSharedDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	wantDeadline, _ := ctx.Deadline()
	spec := wireGuardSpec{Peers: []wireGuardPeerSpec{
		{ID: "first", EndpointHost: "first.example"}, {ID: "slow", EndpointHost: "slow.example"},
	}}
	_, err := resolveWireGuardEndpoints(ctx, spec, func(ctx context.Context, _, host string) ([]netip.Addr, error) {
		deadline, ok := ctx.Deadline()
		if !ok || !deadline.Equal(wantDeadline) {
			t.Fatal("DNS budget was reset for another peer")
		}
		if host == "first.example" {
			return []netip.Addr{netip.MustParseAddr("192.0.2.10")}, nil
		}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unresponsive DNS was not bounded: %v", err)
	}
}
