package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// These are current network-namespace socket counts, not a cumulative counter
// of connections since boot. TCP total includes TIME_WAIT; UDP has sockets,
// not TCP-style established connections. Never sum the global "alloc" field.
type hostSocketCount struct {
	Status       string  `json:"status"`
	Total        *uint64 `json:"total,omitempty"`
	InUse        *uint64 `json:"inUse,omitempty"`
	TimeWait     *uint64 `json:"timeWait,omitempty"`
	IPv6Included bool    `json:"ipv6Included"`
	Reason       string  `json:"reason,omitempty"`
}

type hostConnectionStats struct {
	Version   int             `json:"version"`
	Scope     string          `json:"scope"`
	Source    string          `json:"source"`
	SampledAt int64           `json:"sampledAt"`
	TCP       hostSocketCount `json:"tcp"`
	UDP       hostSocketCount `json:"udp"`
}

var hostConnectionCache struct {
	sync.Mutex
	stats hostConnectionStats
	at    time.Time
}

func systemConnectionStats() hostConnectionStats {
	hostConnectionCache.Lock()
	defer hostConnectionCache.Unlock()
	now := time.Now()
	if !hostConnectionCache.at.IsZero() && now.Sub(hostConnectionCache.at) < 5*time.Second {
		return hostConnectionCache.stats
	}
	if runtime.GOOS == "linux" {
		hostConnectionCache.stats = readHostConnectionStats("/proc/net", now)
	} else {
		hostConnectionCache.stats = unavailableHostConnectionStats(now, "unsupported-platform")
	}
	hostConnectionCache.at = now
	stats := hostConnectionCache.stats
	if (stats.TCP.Status != "ok" || stats.UDP.Status != "ok") && shouldLogAgentReport("host-connection-stats-unavailable", 5*time.Minute) {
		logf("host socket counts unavailable tcp=%s udp=%s; missing counts are omitted, not reported as zero", stats.TCP.Reason, stats.UDP.Reason)
	}
	return stats
}

func unavailableHostConnectionStats(now time.Time, reason string) hostConnectionStats {
	return hostConnectionStats{Version: 1, Scope: "network-namespace", Source: "proc-sockstat", SampledAt: now.Unix(),
		TCP: hostSocketCount{Status: "unavailable", Reason: reason}, UDP: hostSocketCount{Status: "unavailable", Reason: reason}}
}

// Only small kernel summaries are read. This remains O(1) in connection count,
// unlike enumerating /proc/net/tcp* or launching ss/conntrack on every heartbeat.
func readSocketSummary(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	const limit = 64 * 1024
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err == nil && len(data) > limit {
		err = fmt.Errorf("socket summary exceeds limit")
	}
	return string(data), err
}

func parseSocketSummary(raw, protocol, field string) (uint64, error) {
	found := false
	protocolSeen := false
	var result uint64
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != protocol+":" {
			continue
		}
		if protocolSeen || len(fields)%2 != 1 {
			return 0, fmt.Errorf("invalid socket summary")
		}
		protocolSeen = true
		for i := 1; i+1 < len(fields); i += 2 {
			if fields[i] != field {
				continue
			}
			if found {
				return 0, fmt.Errorf("duplicate socket counter")
			}
			value, err := strconv.ParseUint(fields[i+1], 10, 64)
			if err != nil {
				return 0, err
			}
			result, found = value, true
		}
	}
	if !found {
		return 0, fmt.Errorf("socket counter missing")
	}
	return result, nil
}

func socketReadFailure(err error) string {
	switch {
	case errors.Is(err, os.ErrPermission):
		return "permission-denied"
	case errors.Is(err, os.ErrNotExist):
		return "summary-missing"
	default:
		return "summary-unreadable"
	}
}

func readHostConnectionStats(procNet string, now time.Time) hostConnectionStats {
	result := unavailableHostConnectionStats(now, "summary-invalid")
	v4, err4 := readSocketSummary(filepath.Join(procNet, "sockstat"))
	if err4 != nil {
		result.TCP.Reason, result.UDP.Reason = socketReadFailure(err4), socketReadFailure(err4)
		return result
	}
	v6, err6 := readSocketSummary(filepath.Join(procNet, "sockstat6"))
	readProtocol := func(protocol string, tcp bool) hostSocketCount {
		unavailable := hostSocketCount{Status: "unavailable", Reason: "summary-invalid"}
		inUse, err := parseSocketSummary(v4, protocol, "inuse")
		if err != nil {
			return unavailable
		}
		includesIPv6 := err6 == nil
		if err6 == nil {
			ipv6, err := parseSocketSummary(v6, protocol+"6", "inuse")
			if err != nil || ^uint64(0)-inUse < ipv6 {
				return unavailable
			}
			inUse += ipv6
		} else if !errors.Is(err6, os.ErrNotExist) {
			unavailable.Reason = socketReadFailure(err6)
			return unavailable
		} else {
			// No IPv6 module is normal. A present IPv6 socket table with a hidden
			// summary is not: do not silently report IPv4 as the complete total.
			_, statErr := os.Stat(filepath.Join(procNet, strings.ToLower(protocol)+"6"))
			if !errors.Is(statErr, os.ErrNotExist) {
				unavailable.Reason = "ipv6-summary-missing"
				return unavailable
			}
		}
		total := inUse
		count := hostSocketCount{Status: "ok", InUse: &inUse, IPv6Included: includesIPv6}
		if tcp {
			// Linux reports the namespace's IPv4+IPv6 TIME_WAIT count once in
			// sockstat (not sockstat6). Adding it twice would inflate the total.
			timeWait, err := parseSocketSummary(v4, protocol, "tw")
			if err != nil || ^uint64(0)-total < timeWait {
				return unavailable
			}
			total += timeWait
			count.TimeWait = &timeWait
		}
		count.Total = &total
		return count
	}
	result.TCP, result.UDP = readProtocol("TCP", true), readProtocol("UDP", false)
	return result
}
