package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

const connectionLimitTable = "forwardx_connection_limits"

type connectionLimitSpec struct {
	UserID         int   `json:"userId"`
	MaxConnections int   `json:"maxConnections"`
	TCPPorts       []int `json:"tcpPorts"`
	UDPPorts       []int `json:"udpPorts"`
}

type connectionLimitSnapshot struct {
	exists bool
	chains map[string]bool
	rules  map[string][]string
}

var connectionLimitMu sync.Mutex

func normalizedConnectionLimits(specs []connectionLimitSpec) ([]connectionLimitSpec, error) {
	if len(specs) > 5000 {
		return nil, fmt.Errorf("too many connection-limit users")
	}
	out := make([]connectionLimitSpec, 0, len(specs))
	users, owners := map[int]bool{}, map[string]int{}
	for _, spec := range specs {
		if spec.UserID <= 0 || users[spec.UserID] || spec.MaxConnections < 0 {
			return nil, fmt.Errorf("invalid connection-limit user=%d", spec.UserID)
		}
		users[spec.UserID] = true
		if spec.MaxConnections == 0 {
			continue
		}
		normalize := func(ports []int, protocol string) ([]int, error) {
			unique := map[int]bool{}
			for _, port := range ports {
				key := fmt.Sprintf("%s:%d", protocol, port)
				if port < 1 || port > 65535 || (owners[key] != 0 && owners[key] != spec.UserID) {
					return nil, fmt.Errorf("invalid or overlapping connection-limit port=%s", key)
				}
				owners[key], unique[port] = spec.UserID, true
			}
			result := make([]int, 0, len(unique))
			for port := range unique {
				result = append(result, port)
			}
			sort.Ints(result)
			return result, nil
		}
		var err error
		if spec.TCPPorts, err = normalize(spec.TCPPorts, "tcp"); err != nil {
			return nil, err
		}
		if spec.UDPPorts, err = normalize(spec.UDPPorts, "udp"); err != nil {
			return nil, err
		}
		if len(spec.TCPPorts)+len(spec.UDPPorts) > 0 {
			out = append(out, spec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out, nil
}

func connectionLimitChain(spec connectionLimitSpec) string {
	return fmt.Sprintf("user_%d_limit_%d", spec.UserID, spec.MaxConnections)
}

func connectionLimitMarker(specs []connectionLimitSpec) string {
	raw, _ := json.Marshal(specs)
	hash := sha256.Sum256(raw)
	return fmt.Sprintf("fwx-connections-%x", hash[:16])
}

func readConnectionLimitSnapshot(raw []byte) (connectionLimitSnapshot, error) {
	result := connectionLimitSnapshot{chains: map[string]bool{}, rules: map[string][]string{}}
	var document struct {
		NFTables []struct {
			Table *struct{ Family, Name string }                  `json:"table"`
			Chain *struct{ Family, Table, Name string }           `json:"chain"`
			Rule  *struct{ Family, Table, Chain, Comment string } `json:"rule"`
		} `json:"nftables"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		return result, err
	}
	for _, item := range document.NFTables {
		if item.Table != nil && item.Table.Family == "inet" && item.Table.Name == connectionLimitTable {
			result.exists = true
		}
		if item.Chain != nil && item.Chain.Family == "inet" && item.Chain.Table == connectionLimitTable {
			result.chains[item.Chain.Name] = true
		}
		if item.Rule != nil && item.Rule.Family == "inet" && item.Rule.Table == connectionLimitTable {
			result.rules[item.Rule.Chain] = append(result.rules[item.Rule.Chain], item.Rule.Comment)
		}
	}
	return result, nil
}

// The inet connlimit expression owns one tuple list across both address families
// and both protocols. Do not replace its chain just because a port was added.
func connectionLimitPlan(specs []connectionLimitSpec, current connectionLimitSnapshot) string {
	table := "inet " + connectionLimitTable
	if len(specs) == 0 {
		if current.exists {
			return "delete table " + table + "\n"
		}
		return ""
	}
	var plan strings.Builder
	fmt.Fprintf(&plan, "add table %s\n", table)
	for _, base := range []struct{ name, hook string }{{"ingress", "prerouting"}, {"local", "output"}} {
		fmt.Fprintf(&plan, "add chain %s %s { type filter hook %s priority -140; policy accept; }\nflush chain %s %s\n", table, base.name, base.hook, table, base.name)
	}
	fmt.Fprintf(&plan, "add chain %s dispatch\nflush chain %s dispatch\n", table, table)
	wanted := map[string]bool{"ingress": true, "local": true, "dispatch": true}
	for _, spec := range specs {
		chain := connectionLimitChain(spec)
		wanted[chain] = true
		marker := "fwx-" + chain
		if !current.chains[chain] || len(current.rules[chain]) != 1 || current.rules[chain][0] != marker {
			fmt.Fprintf(&plan, "add chain %s %s\nflush chain %s %s\n", table, chain, table, chain)
			// Only NEW flows can be dropped. Connections established before a
			// threshold change are grandfathered until they close; the kernel's
			// connlimit list admits unconfirmed conntrack tuples only.
			fmt.Fprintf(&plan, "add rule %s %s ct count over %d ct state new counter drop comment %q\n", table, chain, spec.MaxConnections, marker)
		}
		for _, group := range []struct {
			protocol string
			ports    []int
		}{{"tcp", spec.TCPPorts}, {"udp", spec.UDPPorts}} {
			if len(group.ports) == 0 {
				continue
			}
			ports := make([]string, len(group.ports))
			for i, port := range group.ports {
				ports[i] = fmt.Sprint(port)
			}
			fmt.Fprintf(&plan, "add rule %s dispatch %s dport { %s } jump %s\n", table, group.protocol, strings.Join(ports, ", "), chain)
		}
	}
	marker := connectionLimitMarker(specs)
	fmt.Fprintf(&plan, "add rule %s ingress iifname != lo meta l4proto { tcp, udp } ct direction original fib daddr type local jump dispatch comment %q\n", table, marker)
	fmt.Fprintf(&plan, "add rule %s local meta l4proto { tcp, udp } ct direction original fib daddr type local jump dispatch comment %q\n", table, marker)
	for chain := range current.chains {
		if !wanted[chain] {
			fmt.Fprintf(&plan, "delete chain %s %s\n", table, chain)
		}
	}
	return plan.String()
}

func connectionLimitsHealthy(specs []connectionLimitSpec, current connectionLimitSnapshot) bool {
	if len(specs) == 0 {
		return !current.exists
	}
	marker := connectionLimitMarker(specs)
	for _, base := range []string{"ingress", "local"} {
		if len(current.rules[base]) != 1 || current.rules[base][0] != marker {
			return false
		}
	}
	count := 0
	for _, spec := range specs {
		chain := connectionLimitChain(spec)
		if len(current.rules[chain]) != 1 || current.rules[chain][0] != "fwx-"+chain {
			return false
		}
		if len(spec.TCPPorts) > 0 {
			count++
		}
		if len(spec.UDPPorts) > 0 {
			count++
		}
	}
	return len(current.rules["dispatch"]) == count && len(current.chains) == len(specs)+3
}

func runConnectionLimitNFT(input string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nft", args...)
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("连接数限制未生效（需要 nftables、内核 connlimit 和 CAP_NET_ADMIN）: %s", compactShellFailureOutput(out, err, ctx.Err() != nil))
	}
	return out, nil
}

func syncConnectionLimits(specs []connectionLimitSpec, checkOnly bool) error {
	connectionLimitMu.Lock()
	defer connectionLimitMu.Unlock()
	normalized, err := normalizedConnectionLimits(specs)
	if err != nil {
		return err
	}
	if !commandExists("nft") {
		if len(normalized) == 0 {
			return nil
		}
		return fmt.Errorf("连接数限制未生效：请在节点安装 nftables 并提供 CAP_NET_ADMIN")
	}
	// List tables first: a missing owned table is normal; permission or syntax
	// errors must not masquerade as an empty successful configuration.
	raw, err := runConnectionLimitNFT("", "-j", "list", "tables")
	if err != nil {
		return err
	}
	current, err := readConnectionLimitSnapshot(raw)
	if err != nil {
		return err
	}
	if current.exists {
		raw, err = runConnectionLimitNFT("", "-j", "list", "table", "inet", connectionLimitTable)
		if err != nil {
			return err
		}
		current, err = readConnectionLimitSnapshot(raw)
		if err != nil {
			return err
		}
	}
	if connectionLimitsHealthy(normalized, current) {
		return nil
	}
	if checkOnly {
		return fmt.Errorf("connection limits need reconciliation")
	}
	_, err = runConnectionLimitNFT(connectionLimitPlan(normalized, current), "-f", "-")
	return err
}
