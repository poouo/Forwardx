package main

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestStreamUnlockDNSNeedsMoreThanDifferentCDNAddresses(t *testing.T) {
	for _, tc := range []struct {
		name           string
		system, public []string
		want           string
	}{
		{"overlapping CDN", []string{"8.8.4.4", "8.8.8.8"}, []string{"8.8.8.8", "1.1.1.1"}, "public_dns"},
		{"different CDN", []string{"8.8.4.4"}, []string{"1.1.1.1"}, "mismatch"},
		{"synthetic IPv4", []string{"198.18.0.1"}, []string{"1.1.1.1"}, "smart_dns_suspected"},
		{"synthetic IPv6", []string{"fd00::1"}, []string{"2606:4700:4700::1111"}, "smart_dns_suspected"},
		{"no local IPv6", nil, []string{"2606:4700:4700::1111"}, "unknown"},
		{"no public address", []string{"10.0.0.1"}, nil, "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := streamUnlockDNSComparison(streamUnlockDNSAnswer{addresses: tc.system}, streamUnlockDNSAnswer{addresses: tc.public})
			if got != tc.want {
				t.Fatalf("mode = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestStreamUnlockDNSRequiresPlatformOutcomeDifference(t *testing.T) {
	for _, tc := range []struct{ mode, system, public, publicRegion, want string }{
		{"mismatch", "available", "available", "JP", "mismatch"},
		{"mismatch", "available", "available", "US", "mismatch"},
		{"mismatch", "available", "blocked", "US", "dns_unlocked"},
		{"mismatch", "available", "partial", "US", "dns_unlocked"},
		{"mismatch", "available", "error", "", "mismatch"},
		{"smart_dns_suspected", "available", "unknown", "", "smart_dns_suspected"},
		{"smart_dns_suspected", "available", "available", "US", "dns_region_override"},
		{"smart_dns_suspected", "available", "available", "JP", "mismatch"},
		{"smart_dns_suspected", "unknown", "blocked", "JP", "smart_dns_suspected"},
		{"public_dns", "available", "blocked", "US", "public_dns"},
	} {
		system := streamUnlockProviderResult{Region: "JP", Status: tc.system}
		public := streamUnlockProviderResult{Region: tc.publicRegion, Status: tc.public}
		got := streamUnlockCompareDNSProbes(streamUnlockDNSResult{Mode: tc.mode}, system, public)
		if got.Mode != tc.want {
			t.Errorf("%+v: mode=%s want %s", tc, got.Mode, tc.want)
		}
	}
}

func TestStreamUnlockPublicDNSReadsFamilyAndCNAME(t *testing.T) {
	client := &http.Client{Transport: streamUnlockTestTransport(func(req *http.Request) (*http.Response, error) {
		if req.URL.Query().Get("type") != "AAAA" || req.URL.Query().Get("name") != "www.example.com" || req.Header.Get("Accept") != "application/dns-json" {
			t.Fatalf("unexpected DoH request: %s", req.URL)
		}
		body := `{"Status":0,"Answer":[{"type":5,"data":"Edge.Example.com."},{"type":1,"data":"1.1.1.1"},{"type":28,"data":"fd00::1"},{"type":28,"data":"2606:4700:4700:0::1111"}]}`
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	result, ok := streamUnlockPublicDNS(context.Background(), client, "www.example.com", "ipv6")
	if !ok || !reflect.DeepEqual(result.addresses, []string{"2606:4700:4700::1111"}) || !reflect.DeepEqual(result.cnames, []string{"edge.example.com"}) {
		t.Fatalf("unexpected DoH answer: %+v, ok=%v", result, ok)
	}
}
