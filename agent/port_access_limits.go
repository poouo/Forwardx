package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type portAccessLimitSpec struct {
	UserID int   `json:"userId"`
	MaxIPs int   `json:"maxIPs"`
	Ports  []int `json:"ports"`
}

type portLimitFirewall interface {
	Available(string) bool
	IPv6Enabled() bool
	Run(string, ...string) (string, error)
}

type systemPortLimitFirewall struct{}

var portLimitHealth struct {
	sync.Mutex
	signature string
	checkedAt time.Time
}

func rememberPortLimitHealth(a action, ok bool) {
	portLimitHealth.Lock()
	defer portLimitHealth.Unlock()
	portLimitHealth.signature = actionCommandSignature(a)
	portLimitHealth.checkedAt = time.Time{}
	if ok {
		portLimitHealth.checkedAt = time.Now()
	}
}

func portAccessLimitsReady(a action) bool {
	portLimitHealth.Lock()
	recent := portLimitHealth.signature == actionCommandSignature(a) && !portLimitHealth.checkedAt.IsZero() && time.Since(portLimitHealth.checkedAt) < accessLimitMaintenanceInterval
	portLimitHealth.Unlock()
	if recent {
		return true
	}
	ok := syncPortAccessLimits(systemPortLimitFirewall{}, a.PortAccessLimits, true) == nil
	rememberPortLimitHealth(a, ok)
	return ok
}

func (systemPortLimitFirewall) Available(binary string) bool { return commandExists(binary) }
func (systemPortLimitFirewall) IPv6Enabled() bool {
	data, err := os.ReadFile("/proc/sys/net/ipv6/conf/all/disable_ipv6")
	return err == nil && strings.TrimSpace(string(data)) != "1"
}
func (systemPortLimitFirewall) Run(binary string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, binary, append([]string{"-w", "5", "-t", "mangle"}, args...)...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s: %s", binary, compactShellFailureOutput(out, err, ctx.Err() != nil))
	}
	return string(out), nil
}

func portLimitChain(prefix string, value any) string {
	raw, _ := json.Marshal(value)
	hash := sha256.Sum256(raw)
	return fmt.Sprintf("%s%x", prefix, hash[:10])
}

func normalizedPortLimits(specs []portAccessLimitSpec) ([]portAccessLimitSpec, error) {
	out := make([]portAccessLimitSpec, 0, len(specs))
	users, ports := map[int]bool{}, map[int]bool{}
	for _, spec := range specs {
		if spec.UserID <= 0 || spec.MaxIPs < 0 || users[spec.UserID] {
			return nil, fmt.Errorf("invalid or duplicate port access limit user=%d", spec.UserID)
		}
		users[spec.UserID] = true
		if spec.MaxIPs == 0 {
			continue
		}
		seen := map[int]bool{}
		copySpec := spec
		copySpec.Ports = nil
		for _, port := range spec.Ports {
			if port < 1 || port > 65535 || (ports[port] && !seen[port]) {
				return nil, fmt.Errorf("invalid or overlapping port access limit port=%d", port)
			}
			if !seen[port] {
				copySpec.Ports = append(copySpec.Ports, port)
			}
			seen[port], ports[port] = true, true
		}
		sort.Ints(copySpec.Ports)
		if len(copySpec.Ports) > 0 {
			out = append(out, copySpec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out, nil
}

// Each user's counter chain is independent of its port list. Adding/removing
// listeners changes only dispatch, preserving the live connlimit state. Only
// an explicit threshold change creates a fresh counter chain.
func portLimitRules(specs []portAccessLimitSpec, ipv6 bool) (string, map[string][][]string) {
	rules := map[string][][]string{}
	if len(specs) == 0 {
		return "", rules
	}
	dispatch := portLimitChain("FWX_PD_", specs)
	mask := "32"
	if ipv6 {
		mask = "128"
	}
	for _, spec := range specs {
		counter := portLimitChain("FWX_PC_", []int{spec.UserID, spec.MaxIPs})
		if spec.MaxIPs > 0 {
			rules[counter] = append(rules[counter], []string{"-p", "tcp", "-m", "connlimit", "--connlimit-above", strconv.Itoa(spec.MaxIPs), "--connlimit-mask", mask, "--connlimit-saddr", "-j", "DROP"})
		}
		rules[counter] = append(rules[counter], []string{"-j", "RETURN"})
		for start := 0; start < len(spec.Ports); start += 15 {
			end := start + 15
			if end > len(spec.Ports) {
				end = len(spec.Ports)
			}
			ports := make([]string, 0, end-start)
			for _, port := range spec.Ports[start:end] {
				ports = append(ports, strconv.Itoa(port))
			}
			rules[dispatch] = append(rules[dispatch], []string{"-p", "tcp", "-m", "multiport", "--dports", strings.Join(ports, ","), "-j", counter})
		}
	}
	rules[dispatch] = append(rules[dispatch], []string{"-j", "RETURN"})
	return dispatch, rules
}

func portLimitHook(dispatch, base string) []string {
	// mangle precedes DNAT, so kernel and process forwarding use the same
	// original entry port. Never touch established data or forwarded transit
	// traffic addressed to another machine. OUTPUT covers local clients too.
	args := []string{"-p", "tcp", "-m", "tcp", "--syn", "-m", "conntrack", "--ctstate", "NEW", "--ctdir", "ORIGINAL", "-m", "addrtype", "--dst-type", "LOCAL"}
	// A local SYN traverses OUTPUT and then loopback PREROUTING. Counting it
	// twice in the same kernel tick can consume two connlimit slots.
	if base == "PREROUTING" {
		args = append(args, "!", "-i", "lo")
	}
	return append(args, "-j", dispatch)
}

func managedPortLimitChain(name string) bool {
	if !strings.HasPrefix(name, "FWX_PD_") && !strings.HasPrefix(name, "FWX_PC_") {
		return false
	}
	if len(name) != 27 {
		return false
	}
	for _, char := range name[7:] {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}

// Reconciliation never flushes an in-use counter, NAT table, or any forwarding
// runtime. A preparation failure leaves the previous hooks/counters in place.
// checkOnly is read-only and is used for desired-state health checks.
func reconcilePortLimitFamily(fw portLimitFirewall, binary string, specs []portAccessLimitSpec, checkOnly bool) error {
	dispatch, desired := portLimitRules(specs, binary == "ip6tables")
	snapshot, err := fw.Run(binary, "-S")
	if err != nil {
		return err
	}
	existing := map[string]bool{}
	var obsoleteHooks [][]string
	for _, line := range strings.Split(snapshot, "\n") {
		args := strings.Fields(line)
		if len(args) == 2 && args[0] == "-N" && managedPortLimitChain(args[1]) {
			existing[args[1]] = true
		}
		if len(args) >= 4 && args[0] == "-A" && (args[1] == "PREROUTING" || args[1] == "OUTPUT") && args[len(args)-2] == "-j" && managedPortLimitChain(args[len(args)-1]) && args[len(args)-1] != dispatch {
			obsoleteHooks = append(obsoleteHooks, args)
		}
	}
	// Prepare counters before dispatch and install all rules before hooking it.
	names := make([]string, 0, len(desired))
	for name := range desired {
		if name != dispatch {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if dispatch != "" {
		names = append(names, dispatch)
	}
	for _, name := range names {
		if !existing[name] {
			if checkOnly {
				return fmt.Errorf("%s limit chain missing", binary)
			}
			if _, err := fw.Run(binary, "-N", name); err != nil {
				return err
			}
		}
		for _, rule := range desired[name] {
			if _, err := fw.Run(binary, append([]string{"-C", name}, rule...)...); err == nil {
				continue
			}
			if checkOnly {
				return fmt.Errorf("%s limit rule missing", binary)
			}
			// Missing rules go before RETURN (also repairs a partial apply).
			operation := []string{"-I", name, "1"}
			if len(rule) == 2 && rule[0] == "-j" && rule[1] == "RETURN" {
				operation = []string{"-A", name}
			}
			if _, err := fw.Run(binary, append(operation, rule...)...); err != nil {
				return err
			}
		}
	}
	if dispatch != "" {
		for _, base := range []string{"PREROUTING", "OUTPUT"} {
			args := portLimitHook(dispatch, base)
			if _, err := fw.Run(binary, append([]string{"-C", base}, args...)...); err == nil {
				continue
			}
			if checkOnly {
				return fmt.Errorf("%s limit hook missing", binary)
			}
			if _, err := fw.Run(binary, append([]string{"-I", base, "1"}, args...)...); err != nil {
				return err
			}
		}
	}
	if checkOnly {
		if len(obsoleteHooks) > 0 {
			return fmt.Errorf("%s stale limit hooks", binary)
		}
		return nil
	}
	for _, hook := range obsoleteHooks {
		hook[0] = "-D"
		if _, err := fw.Run(binary, hook...); err != nil {
			return err
		}
	}
	// Remove obsolete dispatchers first, then their now-unreferenced counters.
	for _, prefix := range []string{"FWX_PD_", "FWX_PC_"} {
		for name := range existing {
			if !strings.HasPrefix(name, prefix) || desired[name] != nil {
				continue
			}
			if _, err := fw.Run(binary, "-F", name); err != nil {
				return err
			}
			if _, err := fw.Run(binary, "-X", name); err != nil {
				return err
			}
		}
	}
	return nil
}

func syncPortAccessLimits(fw portLimitFirewall, specs []portAccessLimitSpec, checkOnly bool) error {
	normalized, err := normalizedPortLimits(specs)
	if err != nil {
		return err
	}
	var failures []string
	for _, binary := range []string{"iptables", "ip6tables"} {
		required := binary == "iptables" || fw.IPv6Enabled()
		if !fw.Available(binary) {
			if required && len(normalized) > 0 {
				failures = append(failures, binary+" missing")
			}
			continue
		}
		if !required {
			continue
		}
		if err := reconcilePortLimitFamily(fw, binary, normalized, checkOnly); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("TCP port access limits not fully applied: %s; forwarding remains active", strings.Join(failures, "; "))
	}
	return nil
}
