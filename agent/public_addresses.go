package main

import (
	"encoding/json"
	"net"
	"sort"
	"strings"
	"time"
)

var publicIPv4AddressesCache []string // Guarded by publicIPMu.
var publicIPv6AddressesCache []string

func publicIPv4Literal(value string) string {
	ip := net.ParseIP(strings.TrimSpace(value)).To4()
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip[0] == 0 || ip[0] >= 224 || (ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127) || (ip[0] == 198 && (ip[1] == 18 || ip[1] == 19)) {
		return ""
	}
	return ip.String()
}
func canonicalPublicAddresses(values []string, ipv6 bool) []string {
	seen := make(map[string]bool)
	for _, value := range values {
		ip := publicIPv4Literal(value)
		if ipv6 {
			ip = publicIPv6Literal(value)
		}
		if ip != "" {
			seen[ip] = true
		}
	}
	result := make([]string, 0, len(seen))
	for ip := range seen {
		result = append(result, ip)
	}
	sort.Strings(result)
	if len(result) > 128 {
		result = result[:128]
	}
	return result
}
func publicAddressInventory() ([]string, []string) {
	publicIPMu.Lock()
	defer publicIPMu.Unlock()
	return append([]string{}, publicIPv4AddressesCache...), append([]string{}, publicIPv6AddressesCache...)
}

func parseLocalPublicAddresses(data []byte) ([]string, []string, error) {
	var interfaces []struct {
		Flags     []string `json:"flags"`
		Addresses []struct {
			Family     string   `json:"family"`
			Local      string   `json:"local"`
			Scope      string   `json:"scope"`
			Flags      []string `json:"flags"`
			Tentative  bool     `json:"tentative"`
			DADFailed  bool     `json:"dadfailed"`
			Deprecated bool     `json:"deprecated"`
			Temporary  bool     `json:"temporary"`
		} `json:"addr_info"`
	}
	if err := json.Unmarshal(data, &interfaces); err != nil {
		return nil, nil, err
	}
	v4, v6 := []string{}, []string{}
	for _, iface := range interfaces {
		flags := "," + strings.Join(iface.Flags, ",") + ","
		if !strings.Contains(flags, ",UP,") || strings.Contains(flags, ",LOOPBACK,") {
			continue
		}
		for _, addr := range iface.Addresses {
			flags := strings.ToLower(strings.Join(addr.Flags, ","))
			if addr.Scope != "global" || addr.Tentative || addr.DADFailed || addr.Deprecated || addr.Temporary || strings.Contains(flags, "tentative") || strings.Contains(flags, "dadfailed") || strings.Contains(flags, "deprecated") || strings.Contains(flags, "temporary") {
				continue
			}
			if addr.Family == "inet" {
				v4 = append(v4, addr.Local)
			}
			if addr.Family == "inet6" {
				v6 = append(v6, addr.Local)
			}
		}
	}
	return canonicalPublicAddresses(v4, false), canonicalPublicAddresses(v6, true), nil
}
func localPublicAddresses() ([]string, []string, error) {
	if data, err := commandOutputWithTimeout(3*time.Second, "ip", "-j", "address", "show"); err == nil {
		if v4, v6, err := parseLocalPublicAddresses(data); err == nil {
			return v4, v6, nil
		}
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, nil, err
	}
	values := []string{}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			return nil, nil, err
		}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil {
				values = append(values, ip.String())
			}
		}
	}
	return canonicalPublicAddresses(values, false), canonicalPublicAddresses(values, true), nil
}
