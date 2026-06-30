package main

import (
	"context"
	"net"
	"sort"
	"strings"
	"time"
)

func takePendingDNSChanges() []dnsChangeReport {
	dnsWatchMu.Lock()
	defer dnsWatchMu.Unlock()
	if len(pendingDNSChanges) == 0 {
		return nil
	}
	changes := append([]dnsChangeReport(nil), pendingDNSChanges...)
	pendingDNSChanges = nil
	return changes
}

func queuePendingDNSChanges(changes []dnsChangeReport) {
	if len(changes) == 0 {
		return
	}
	dnsWatchMu.Lock()
	pendingDNSChanges = append(pendingDNSChanges, changes...)
	dnsWatchMu.Unlock()
}

func updateDNSWatch(items []dnsWatchItem) bool {
	watched := map[string]string{}
	watchedItems := map[string][]dnsWatchItem{}
	for _, item := range items {
		host := normalizeDNSWatchHost(item.Host)
		if host == "" {
			continue
		}
		item.Host = host
		key := strings.ToLower(host)
		watched[key] = host
		watchedItems[key] = append(watchedItems[key], item)
	}

	resolved := map[string][]string{}
	for key, host := range watched {
		if ips := lookupDNSWatchIPs(host); len(ips) > 0 {
			resolved[key] = ips
		}
	}

	dnsWatchMu.Lock()
	defer dnsWatchMu.Unlock()

	nextSnapshot := map[string][]string{}
	for key, oldIPs := range dnsWatchSnapshot {
		if _, ok := watched[key]; ok && len(oldIPs) > 0 {
			nextSnapshot[key] = append([]string(nil), oldIPs...)
		}
	}

	var reports []dnsChangeReport
	for key, host := range watched {
		ips := resolved[key]
		if len(ips) == 0 {
			continue
		}
		oldIPs, hadOld := dnsWatchSnapshot[key]
		nextSnapshot[key] = append([]string(nil), ips...)
		if hadOld && len(oldIPs) > 0 && !sameStringSlice(oldIPs, ips) {
			refs := watchedItems[key]
			if len(refs) == 0 {
				refs = []dnsWatchItem{{Host: host}}
			}
			for _, item := range refs {
				reports = append(reports, dnsChangeReport{
					Host:  host,
					Scope: item.Scope,
					RefID: item.RefID,
					Old:   append([]string(nil), oldIPs...),
					New:   append([]string(nil), ips...),
				})
			}
		}
	}

	dnsWatchSnapshot = nextSnapshot
	if len(reports) > 0 {
		pendingDNSChanges = append(pendingDNSChanges, reports...)
		return true
	}
	return false
}

func normalizeDNSWatchHost(raw string) string {
	host := strings.TrimSpace(raw)
	if host == "" || len(host) > 253 || net.ParseIP(host) != nil {
		return ""
	}
	host = strings.TrimSuffix(host, ".")
	if host == "" || !dnsWatchHostPattern.MatchString(host) {
		return ""
	}
	return host
}

func lookupDNSWatchIPs(host string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil
	}
	values := make([]string, 0, len(ips))
	seen := map[string]bool{}
	for _, ip := range ips {
		if ip == nil {
			continue
		}
		value := ip.String()
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		values = append(values, value)
	}
	sort.Strings(values)
	return values
}

func sameStringSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
