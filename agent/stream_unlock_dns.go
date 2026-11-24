package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strings"
	"time"
)

type streamUnlockDNSAnswer struct {
	addresses []string
	cnames    []string
}

func streamUnlockDNS(ctx context.Context, provider streamUnlockProvider, probe streamUnlockProviderResult) streamUnlockDNSResult {
	family := probe.Family
	result := streamUnlockDNSResult{Domain: provider.domain, Family: family, Mode: "unknown", CheckedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	page, err := url.Parse(provider.url)
	if err != nil || page.Hostname() == "" {
		return result
	}
	host := page.Hostname()
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	client := streamUnlockDoHClient(family)
	defer client.CloseIdleConnections()

	publicAnswer := make(chan streamUnlockDNSAnswer, 1)
	go func() {
		answer, _ := streamUnlockPublicDNS(ctx, client, host, family)
		publicAnswer <- answer
	}()
	system := streamUnlockSystemDNS(ctx, host, family)
	public := <-publicAnswer
	result.SystemAddresses, result.SystemCnames = system.addresses, system.cnames
	result.PublicAddresses, result.PublicCnames = public.addresses, public.cnames
	result.Mode, result.Detail = streamUnlockDNSComparison(system, public)
	if (result.Mode != "mismatch" && result.Mode != "smart_dns_suspected") || probe.Status != "available" {
		return result
	}

	if result.Mode == "mismatch" && streamUnlockWildcardDNS(ctx, client, provider.domain, family, system) {
		result.Mode = "smart_dns_suspected"
		result.Detail = "系统 DNS 将随机子域名解析到平台相同的地址或 CNAME"
	}
	if (provider.id == "bilibili-tv" && probe.Region == "") || (result.Mode == "mismatch" && streamUnlockDNSOverlap(system.cnames, public.cnames)) {
		return result
	}

	baseline := streamUnlockDNSBaselineClient(family, client, host, public.addresses)
	defer baseline.CloseIdleConnections()
	direct := streamUnlockProbeProviderWithClient(ctx, baseline, provider, family)
	return streamUnlockCompareDNSProbes(result, probe, direct)
}

func streamUnlockDNSComparison(system, public streamUnlockDNSAnswer) (mode, detail string) {
	if len(system.addresses) == 0 {
		return "unknown", "系统 DNS 未返回当前协议的地址"
	}
	if len(public.addresses) == 0 {
		return "unknown", "公共 DNS 未返回当前协议的地址"
	}
	if streamUnlockDNSOverlap(system.addresses, public.addresses) {
		return "public_dns", "系统 DNS 与公共 DNS 返回了相同的目标地址"
	}
	for _, address := range system.addresses {
		if streamUnlockPublicAddress(address) {
			return "mismatch", "系统与公共 DNS 的目标地址不同，可能是 CDN 分流"
		}
	}
	return "smart_dns_suspected", "系统 DNS 仅返回非公网地址，疑似存在 DNS 代理或本地映射"
}

func streamUnlockCompareDNSProbes(result streamUnlockDNSResult, system, public streamUnlockProviderResult) streamUnlockDNSResult {
	if system.Status != "available" || (result.Mode != "smart_dns_suspected" && result.Mode != "mismatch") {
		return result
	}
	switch public.Status {
	case "blocked", "partial":
		result.Mode = "dns_unlocked"
		result.Detail = "使用系统 DNS 时可访问；改用公共 DNS 后，同一平台探针返回访问限制"
	case "available":
		if result.Mode == "smart_dns_suspected" && system.Region != "" && system.Region == public.Region {
			result.Mode = "mismatch"
			result.Detail = "系统 DNS 与公共 DNS 返回不同地址，平台可访问状态和地区一致"
		} else if result.Mode == "smart_dns_suspected" && system.Region != "" && public.Region != "" {
			result.Mode = "dns_region_override"
			result.Detail = fmt.Sprintf("系统 DNS 与公共 DNS 下，平台识别的地区从 %s 切换到 %s", public.Region, system.Region)
		}
	}
	return result
}

func streamUnlockDNSOverlap(left, right []string) bool {
	for _, a := range left {
		for _, b := range right {
			if a == b {
				return true
			}
		}
	}
	return false
}

var streamUnlockSharedAddress = netip.MustParsePrefix("100.64.0.0/10")
var streamUnlockBenchmarkAddress = netip.MustParsePrefix("198.18.0.0/15")

func streamUnlockPublicAddress(value string) bool {
	address, err := netip.ParseAddr(value)
	return err == nil && address.IsGlobalUnicast() && !address.IsPrivate() &&
		!streamUnlockSharedAddress.Contains(address) && !streamUnlockBenchmarkAddress.Contains(address)
}

func streamUnlockSystemDNS(ctx context.Context, host, family string) streamUnlockDNSAnswer {
	network := "ip4"
	if family == "ipv6" {
		network = "ip6"
	}
	ips, _ := net.DefaultResolver.LookupIP(ctx, network, host)
	answer := streamUnlockDNSAnswer{addresses: []string{}}
	for _, ip := range ips {
		answer.addresses = append(answer.addresses, ip.String())
	}
	sort.Strings(answer.addresses)
	if len(ips) > 0 {
		if cname, err := net.DefaultResolver.LookupCNAME(ctx, host); err == nil {
			cname = strings.ToLower(strings.TrimSuffix(cname, "."))
			if cname != "" && cname != strings.ToLower(strings.TrimSuffix(host, ".")) {
				answer.cnames = []string{cname}
			}
		}
	}
	return answer
}

func streamUnlockDoHClient(family string) *http.Client {
	address := "1.1.1.1:443"
	if family == "ipv6" {
		address = "[2606:4700:4700::1111]:443"
	}
	dialer := &net.Dialer{Timeout: streamUnlockRequestTimeout}
	client := streamUnlockHTTPClientWithDial(family, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, address)
	})
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client
}

func streamUnlockPublicDNS(ctx context.Context, client *http.Client, host, family string) (streamUnlockDNSAnswer, bool) {
	answer := streamUnlockDNSAnswer{addresses: []string{}}
	record, addressType := "A", 1
	if family == "ipv6" {
		record, addressType = "AAAA", 28
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://cloudflare-dns.com/dns-query?name="+url.QueryEscape(host)+"&type="+record, nil)
	if err != nil {
		return answer, false
	}
	request.Header.Set("Accept", "application/dns-json")
	response, err := client.Do(request)
	if err != nil {
		return answer, false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return answer, false
	}
	return streamUnlockReadDoH(response, addressType)
}

func streamUnlockReadDoH(response *http.Response, addressType int) (streamUnlockDNSAnswer, bool) {
	answer := streamUnlockDNSAnswer{addresses: []string{}}
	var packet struct {
		Status *int
		TC     bool
		Answer []struct {
			Type int
			Data string
		}
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&packet); err != nil || packet.Status == nil || packet.TC || (*packet.Status != 0 && *packet.Status != 3) {
		return answer, false
	}
	if *packet.Status == 3 {
		return answer, true
	}
	for _, record := range packet.Answer {
		switch record.Type {
		case addressType:
			address, err := netip.ParseAddr(record.Data)
			if err == nil && address.Is4() == (addressType == 1) && !address.Is4In6() && streamUnlockPublicAddress(record.Data) {
				answer.addresses = append(answer.addresses, address.String())
			}
		case 5:
			answer.cnames = append(answer.cnames, strings.ToLower(strings.TrimSuffix(record.Data, ".")))
		}
	}
	sort.Strings(answer.addresses)
	return answer, true
}

func streamUnlockWildcardDNS(ctx context.Context, client *http.Client, domain, family string, target streamUnlockDNSAnswer) bool {
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	host := "forwardx-" + hex.EncodeToString(nonce[:]) + "." + domain
	system := streamUnlockSystemDNS(ctx, host+".", family)
	if !streamUnlockDNSOverlap(system.addresses, target.addresses) && !streamUnlockDNSOverlap(system.cnames, target.cnames) {
		return false
	}
	public, ok := streamUnlockPublicDNS(ctx, client, host, family)
	return ok && len(public.addresses) == 0 && len(public.cnames) == 0
}

func streamUnlockDNSBaselineClient(family string, doh *http.Client, originalHost string, originalIPs []string) *http.Client {
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	client := streamUnlockHTTPClientWithDial(family, func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips := originalIPs
		if !strings.EqualFold(host, originalHost) {
			answer, _ := streamUnlockPublicDNS(ctx, doh, host, family)
			ips = answer.addresses
		}
		err = fmt.Errorf("public DNS returned no addresses for %s", host)
		for _, ip := range ips {
			var conn net.Conn
			conn, err = dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
			if err == nil {
				return conn, nil
			}
		}
		return nil, err
	})
	checkRedirect := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" {
			return http.ErrUseLastResponse
		}
		return checkRedirect(req, via)
	}
	return client
}
