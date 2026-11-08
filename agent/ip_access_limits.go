package main

// Distinct source-IP admission is local to one Agent/user, shared by all entry
// ports (TCP and UDP). Conntrack is observed only while limits are configured.
// A persistent, bidirectional flow must pass probation before consuming a slot.
import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const ipLimitProbation = 5 * time.Second
const ipLimitReleaseGrace = 10 * time.Second
const ipLimitUDPIdle = 20 * time.Second // plus release grace: about 30 s total
const ipLimitSampleInterval = 2 * time.Second
const ipLimitMaxFlows = 20000
const ipLimitSnapshotBytes = 8 * 1024 * 1024

type ipAccessLimitSpec struct {
	UserID   int   `json:"userId"`
	MaxIPs   int   `json:"maxIPs"`
	TCPPorts []int `json:"tcpPorts"`
	UDPPorts []int `json:"udpPorts"`
}

type ipLimitFlow struct {
	key, ip, protocol string
	user              int
	in, out           uint64
	business          bool
}
type ipLimitObservation struct {
	first, activity time.Time
	in, out         uint64
}
type ipLimitAdmission struct {
	spec ipAccessLimitSpec
	ips  map[string]time.Time
}
type ipLimitPolicy struct {
	Spec ipAccessLimitSpec
	IPs  []string
	Full bool
}
type ipLimitState struct {
	flows map[string]ipLimitObservation
	users map[int]*ipLimitAdmission
}

func normalizeIPAccessLimits(specs []ipAccessLimitSpec) ([]ipAccessLimitSpec, error) {
	if len(specs) > 5000 {
		return nil, fmt.Errorf("too many IP-limit users")
	}
	result := make([]ipAccessLimitSpec, 0, len(specs))
	users := map[int]bool{}
	owners := map[string]int{}
	for _, spec := range specs {
		if spec.UserID <= 0 || users[spec.UserID] || spec.MaxIPs < 0 || spec.MaxIPs > 100000 {
			return nil, fmt.Errorf("invalid IP limit user=%d", spec.UserID)
		}
		users[spec.UserID] = true
		if spec.MaxIPs == 0 {
			continue
		}
		normalize := func(ports []int, protocol string) ([]int, error) {
			unique := map[int]bool{}
			for _, port := range ports {
				key := protocol + ":" + strconv.Itoa(port)
				if port < 1 || port > 65535 || (owners[key] != 0 && owners[key] != spec.UserID) {
					return nil, fmt.Errorf("invalid or overlapping IP-limit port=%s", key)
				}
				owners[key], unique[port] = spec.UserID, true
			}
			out := make([]int, 0, len(unique))
			for port := range unique {
				out = append(out, port)
			}
			sort.Ints(out)
			return out, nil
		}
		var err error
		if spec.TCPPorts, err = normalize(spec.TCPPorts, "tcp"); err != nil {
			return nil, err
		}
		if spec.UDPPorts, err = normalize(spec.UDPPorts, "udp"); err != nil {
			return nil, err
		}
		if len(spec.TCPPorts)+len(spec.UDPPorts) > 0 {
			result = append(result, spec)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UserID < result[j].UserID })
	return result, nil
}

func (s *ipLimitState) configure(specs []ipAccessLimitSpec) {
	users := map[int]*ipLimitAdmission{}
	for _, spec := range specs {
		state := s.users[spec.UserID]
		if state == nil {
			state = &ipLimitAdmission{ips: map[string]time.Time{}}
		}
		state.spec = spec
		// Preserve existing slots when ports are added. A reduced quota keeps
		// the most recently active clients rather than resetting all admissions.
		if len(state.ips) > spec.MaxIPs {
			ips := make([]string, 0, len(state.ips))
			for ip := range state.ips {
				ips = append(ips, ip)
			}
			sort.Slice(ips, func(i, j int) bool {
				if state.ips[ips[i]].Equal(state.ips[ips[j]]) {
					return ips[i] < ips[j]
				}
				return state.ips[ips[i]].After(state.ips[ips[j]])
			})
			for _, ip := range ips[spec.MaxIPs:] {
				delete(state.ips, ip)
			}
		}
		users[spec.UserID] = state
	}
	s.users = users
}

func (s *ipLimitState) observe(flows []ipLimitFlow, now time.Time) []ipLimitPolicy {
	next := make(map[string]ipLimitObservation, len(flows))
	type candidate struct {
		user  int
		ip    string
		first time.Time
	}
	candidates := []candidate{}
	for _, flow := range flows {
		user := s.users[flow.user]
		if user == nil {
			continue
		}
		observation, found := s.flows[flow.key]
		if !found || flow.in < observation.in || flow.out < observation.out {
			observation = ipLimitObservation{first: now, activity: now}
		}
		if flow.in != observation.in || flow.out != observation.out {
			observation.activity = now
		}
		observation.in, observation.out = flow.in, flow.out
		next[flow.key] = observation
		active := flow.protocol == "tcp" || now.Sub(observation.activity) <= ipLimitUDPIdle
		if _, admitted := user.ips[flow.ip]; admitted && active {
			user.ips[flow.ip] = now
		} else if active && flow.business && now.Sub(observation.first) >= ipLimitProbation && (flow.protocol == "tcp" || observation.activity.Equal(now)) {
			candidates = append(candidates, candidate{flow.user, flow.ip, observation.first})
		}
	}
	s.flows = next // Short-lived scans disappear, never accumulating over time.
	for _, user := range s.users {
		for ip, last := range user.ips {
			if now.Sub(last) >= ipLimitReleaseGrace {
				delete(user.ips, ip)
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].first.Equal(candidates[j].first) {
			return candidates[i].ip < candidates[j].ip
		}
		return candidates[i].first.Before(candidates[j].first)
	})
	for _, candidate := range candidates {
		user := s.users[candidate.user]
		if _, exists := user.ips[candidate.ip]; !exists && len(user.ips) < user.spec.MaxIPs {
			user.ips[candidate.ip] = now
		}
	}
	return s.policies()
}

func (s *ipLimitState) policies() []ipLimitPolicy {
	out := make([]ipLimitPolicy, 0, len(s.users))
	for _, user := range s.users {
		policy := ipLimitPolicy{Spec: user.spec, Full: len(user.ips) >= user.spec.MaxIPs}
		for ip := range user.ips {
			policy.IPs = append(policy.IPs, ip)
		}
		sort.Strings(policy.IPs)
		out = append(out, policy)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Spec.UserID < out[j].Spec.UserID })
	return out
}

func scanIPLimitFlows(reader io.Reader, specs []ipAccessLimitSpec, local map[string]bool) ([]ipLimitFlow, error) {
	owners := map[string]int{}
	for _, spec := range specs {
		for _, port := range spec.TCPPorts {
			owners["tcp:"+strconv.Itoa(port)] = spec.UserID
		}
		for _, port := range spec.UDPPorts {
			owners["udp:"+strconv.Itoa(port)] = spec.UserID
		}
	}
	bounded := &io.LimitedReader{R: reader, N: ipLimitSnapshotBytes}
	scanner := bufio.NewScanner(bounded)
	scanner.Buffer(make([]byte, 4096), 65536)
	flows := []ipLimitFlow{}
	seen := map[string]bool{}
	for scanner.Scan() {
		line := scanner.Text()
		protocol, src, dst, sport, port, ok := conntrackOriginalTuple(line)
		src, dst = normalizedSourceIP(src), normalizedSourceIP(dst)
		user := owners[protocol+":"+port]
		if !ok || user == 0 || src == "" || !local[dst] || strings.Contains(line, "[UNREPLIED]") {
			continue
		}
		if protocol == "tcp" && !strings.Contains(line, " ESTABLISHED ") {
			continue
		}
		if protocol != "tcp" && protocol != "udp" {
			continue
		}
		ip := net.ParseIP(src)
		if ip.IsUnspecified() || ip.IsMulticast() {
			continue
		}
		counter := sourceAccounting(line)
		if !counter.accounting {
			return nil, fmt.Errorf("IP limit requires conntrack byte accounting (net.netfilter.nf_conntrack_acct=1); existing flows may need reconnecting")
		}
		key := strconv.Itoa(user) + "|" + protocol + "|" + src + "|" + dst + "|" + sport + "|" + port
		if seen[key] {
			continue
		}
		if len(flows) >= ipLimitMaxFlows {
			return nil, fmt.Errorf("IP-limit flow observation budget exceeded; retaining previous admission state")
		}
		seen[key] = true
		// Require reply traffic and more than a bare TCP handshake. This is a
		// traffic heuristic, not application authentication or scan detection.
		business := counter.in > 0 && counter.out > 0 && counter.in+counter.out >= 512
		flows = append(flows, ipLimitFlow{key, src, protocol, user, counter.in, counter.out, business})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if bounded.N == 0 {
		return nil, fmt.Errorf("IP-limit conntrack snapshot exceeds observation budget")
	}
	return flows, nil
}

func readIPLimitFlows(specs []ipAccessLimitSpec) ([]ipLimitFlow, error) {
	local := localAnalyticsAddresses()
	for _, path := range []string{"/proc/net/nf_conntrack", "/proc/net/ip_conntrack"} {
		if file, err := os.Open(path); err == nil {
			defer file.Close()
			return scanIPLimitFlows(file, specs, local)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "conntrack", "-L", "-o", "extended")
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, fmt.Errorf("IP-limit conntrack unavailable: %w", err)
	}
	flows, scanErr := scanIPLimitFlows(pipe, specs, local)
	if scanErr != nil {
		_ = cmd.Process.Kill()
	}
	err = cmd.Wait()
	if scanErr != nil {
		return nil, scanErr
	}
	if err != nil {
		return nil, fmt.Errorf("IP-limit conntrack snapshot failed: %w", err)
	}
	return flows, nil
}

func ipLimitSetName(user int, ipv6 bool) string {
	prefix := "FWX_IA_"
	if ipv6 {
		prefix = "FWX_IB_"
	}
	return portLimitChain(prefix, user)
}

func ipLimitRules(policies []ipLimitPolicy, ipv6 bool) (string, map[string][][]string) {
	rules := map[string][][]string{}
	if len(policies) == 0 {
		return "", rules
	}
	// IP membership is atomically updated in ipset, so large quotas do not
	// create a firewall rule or command per active client on every sample.
	type shape struct {
		Spec ipAccessLimitSpec
		Full bool
	}
	shapes := []shape{}
	for _, policy := range policies {
		shapes = append(shapes, shape{policy.Spec, policy.Full})
	}
	dispatch := portLimitChain("FWX_ID_", shapes)
	for _, policy := range policies {
		counter := portLimitChain("FWX_IU_", []any{policy.Spec.UserID, policy.Full})
		if policy.Full {
			rules[counter] = [][]string{{"-m", "set", "--match-set", ipLimitSetName(policy.Spec.UserID, ipv6), "src", "-j", "RETURN"}, {"-j", "DROP"}}
		} else {
			rules[counter] = [][]string{{"-j", "RETURN"}}
		}
		for _, group := range []struct {
			protocol string
			ports    []int
		}{{"tcp", policy.Spec.TCPPorts}, {"udp", policy.Spec.UDPPorts}} {
			for start := 0; start < len(group.ports); start += 15 {
				end := start + 15
				if end > len(group.ports) {
					end = len(group.ports)
				}
				ports := []string{}
				for _, port := range group.ports[start:end] {
					ports = append(ports, strconv.Itoa(port))
				}
				rules[dispatch] = append(rules[dispatch], []string{"-p", group.protocol, "-m", "multiport", "--dports", strings.Join(ports, ","), "-j", counter})
			}
		}
	}
	rules[dispatch] = append(rules[dispatch], []string{"-j", "RETURN"})
	return dispatch, rules
}

func ipLimitHook(dispatch, base string) []string {
	args := []string{"-m", "conntrack", "--ctdir", "ORIGINAL", "-m", "addrtype", "--dst-type", "LOCAL"}
	if base == "PREROUTING" {
		args = append(args, "!", "-i", "lo")
	}
	return append(args, "-j", dispatch)
}

func ipsetCommand(input string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ipset", args...)
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("IP-limit ipset: %s", compactShellFailureOutput(out, err, ctx.Err() != nil))
	}
	return string(out), nil
}

func syncIPLimitFirewall(policies []ipLimitPolicy, checkOnly bool) error {
	return syncIPLimitFirewallWith(systemPortLimitFirewall{}, policies, checkOnly, commandExists("ipset"), ipsetCommand)
}

func syncIPLimitFirewallWith(fw portLimitFirewall, policies []ipLimitPolicy, checkOnly, hasIPSet bool, runIPSet func(string, ...string) (string, error)) error {
	if len(policies) > 0 && (!hasIPSet || !fw.Available("iptables")) {
		return fmt.Errorf("IP限制需要 ipset、iptables 和连接跟踪权限；请安装组件并确认 CAP_NET_ADMIN")
	}
	for _, binary := range []string{"iptables", "ip6tables"} {
		ipv6 := binary == "ip6tables"
		if ipv6 && !fw.IPv6Enabled() {
			continue
		}
		if !fw.Available(binary) {
			if len(policies) > 0 {
				return fmt.Errorf("IP限制未生效：缺少 %s", binary)
			}
			continue
		}
		for _, policy := range policies {
			name := ipLimitSetName(policy.Spec.UserID, ipv6)
			if checkOnly {
				saved, err := runIPSet("", "save", name)
				if err != nil {
					return err
				}
				actual := map[string]bool{}
				for _, line := range strings.Split(saved, "\n") {
					fields := strings.Fields(line)
					if len(fields) >= 3 && fields[0] == "add" && fields[1] == name {
						actual[normalizedSourceIP(fields[2])] = true
					}
				}
				expected := map[string]bool{}
				for _, raw := range policy.IPs {
					ip := net.ParseIP(raw)
					if ip != nil && (ip.To4() == nil) == ipv6 {
						expected[ip.String()] = true
					}
				}
				if len(actual) != len(expected) {
					return fmt.Errorf("IP-limit membership drift: %s", name)
				}
				for ip := range expected {
					if !actual[ip] {
						return fmt.Errorf("IP-limit membership missing: %s", name)
					}
				}
				continue
			}
			family := "inet"
			if ipv6 {
				family = "inet6"
			}
			temporary := name + "_T"
			var restore strings.Builder
			fmt.Fprintf(&restore, "create %s hash:ip family %s maxelem 100000 -exist\ncreate %s hash:ip family %s maxelem 100000 -exist\nflush %s\n", name, family, temporary, family, temporary)
			for _, raw := range policy.IPs {
				ip := net.ParseIP(raw)
				if ip == nil || (ip.To4() == nil) != ipv6 {
					continue
				}
				fmt.Fprintf(&restore, "add %s %s -exist\n", temporary, ip.String())
			}
			fmt.Fprintf(&restore, "swap %s %s\ndestroy %s\n", temporary, name, temporary)
			if _, err := runIPSet(restore.String(), "restore"); err != nil {
				return err
			}
		}
		dispatch, rules := ipLimitRules(policies, ipv6)
		if err := reconcileLimitPlan(fw, binary, dispatch, rules, checkOnly, []string{"FWX_ID_", "FWX_IU_"}, ipLimitHook); err != nil {
			return err
		}
	}
	if !checkOnly && hasIPSet {
		// Only delete our unreferenced sets, never another application's sets.
		names, err := runIPSet("", "list", "-name")
		if err != nil {
			return err
		}
		keep := map[string]bool{}
		for _, policy := range policies {
			keep[ipLimitSetName(policy.Spec.UserID, false)] = true
			keep[ipLimitSetName(policy.Spec.UserID, true)] = true
		}
		for _, name := range strings.Fields(names) {
			base := strings.TrimSuffix(name, "_T")
			if !keep[name] && managedLimitChain(base, []string{"FWX_IA_", "FWX_IB_"}) {
				if _, err := runIPSet("", "destroy", name); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// Old tunnel actions used filter-table per-IP connlimit rules. Preserve their
// independent total-connection cap (mask 0), removing only the obsolete cap.
func cleanupLegacyIPConnectionCaps() error {
	for _, binary := range []string{"iptables", "ip6tables"} {
		if !commandExists(binary) {
			continue
		}
		if binary == "ip6tables" && !(systemPortLimitFirewall{}).IPv6Enabled() {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, binary, "-w", "5", "-S").CombinedOutput()
		cancel()
		if err != nil {
			return fmt.Errorf("旧 IP 连接限制清理失败: %s", compactShellFailureOutput(out, err, false))
		}
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 6 || fields[0] != "-A" || !strings.HasPrefix(fields[1], "FWX_LIMIT_u") {
				continue
			}
			perIP := false
			for i := 2; i+1 < len(fields); i++ {
				if fields[i] == "--connlimit-mask" && (fields[i+1] == "32" || fields[i+1] == "128") {
					perIP = true
				}
			}
			if !perIP || !strings.Contains(line, "--connlimit-above") {
				continue
			}
			fields[0] = "-D"
			ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
			out, err = exec.CommandContext(ctx, binary, append([]string{"-w", "5"}, fields...)...).CombinedOutput()
			cancel()
			if err != nil {
				return fmt.Errorf("旧 IP 连接限制清理失败: %s", compactShellFailureOutput(out, err, false))
			}
		}
	}
	return nil
}

var distinctIPController struct {
	sync.Mutex
	state     ipLimitState
	specs     []ipAccessLimitSpec
	stop      chan struct{}
	signature string
	applied   string
	ready     time.Time
	verified  time.Time
}

func configureIPAccessLimits(specs []ipAccessLimitSpec, checkOnly bool) error {
	normalized, err := normalizeIPAccessLimits(specs)
	if err != nil {
		return err
	}
	c := &distinctIPController
	c.Lock()
	defer c.Unlock()
	if checkOnly {
		if c.stop == nil && len(normalized) > 0 {
			return fmt.Errorf("IP-limit observer not running")
		}
		if c.signature != portLimitChain("", normalized) || (len(normalized) > 0 && time.Since(c.ready) > 15*time.Second) {
			return fmt.Errorf("IP-limit observation is not healthy")
		}
		return nil
	}
	if len(normalized) > 0 {
		accounting, readErr := os.ReadFile("/proc/sys/net/netfilter/nf_conntrack_acct")
		if readErr != nil || strings.TrimSpace(string(accounting)) != "1" {
			return fmt.Errorf("IP限制需要开启 net.netfilter.nf_conntrack_acct=1，并具备连接跟踪读取权限")
		}
		if _, err := readIPLimitFlows(normalized); err != nil {
			return err
		}
	}
	state := ipLimitState{flows: c.state.flows, users: map[int]*ipLimitAdmission{}}
	for user, admission := range c.state.users {
		copyAdmission := &ipLimitAdmission{spec: admission.spec, ips: map[string]time.Time{}}
		for ip, last := range admission.ips {
			copyAdmission.ips[ip] = last
		}
		state.users[user] = copyAdmission
	}
	state.configure(normalized)
	// With no configured restriction, lack of netfilter permissions must not
	// cause an endless failing action on unprivileged/LXC Agents. Still attempt
	// stale-rule cleanup once; disabling a previously active limit is strict.
	cleanupOnly := len(normalized) == 0 && len(c.specs) == 0
	apply := func() error {
		if err := syncIPLimitFirewall(state.policies(), false); err != nil {
			return err
		}
		// Remove the previous per-IP connection cap only after the new firewall
		// plan is ready. No listener, NAT rule or active runtime is restarted.
		if err := syncPortAccessLimits(systemPortLimitFirewall{}, nil, false); err != nil {
			return err
		}
		return cleanupLegacyIPConnectionCaps()
	}
	if err := apply(); err != nil {
		if !cleanupOnly {
			return err
		}
		if shouldLogAgentReport("ip-access-limit-idle-cleanup", time.Hour) {
			logf("IP限制未配置；旧限制清理无法确认（请检查权限或旧防火墙规则）: %v", err)
		}
	}
	c.state, c.specs = state, normalized
	c.applied = portLimitChain("", state.policies())
	c.signature = portLimitChain("", normalized)
	c.ready, c.verified = time.Now(), time.Now()
	if len(normalized) == 0 {
		if c.stop != nil {
			close(c.stop)
			c.stop = nil
		}
		c.state = ipLimitState{}
		return nil
	}
	if c.stop == nil {
		c.stop = make(chan struct{})
		go observeIPAccessLimits(c.stop)
	}
	return nil
}

func observeIPAccessLimits(stop <-chan struct{}) {
	ticker := time.NewTicker(ipLimitSampleInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-ticker.C:
			c := &distinctIPController
			c.Lock()
			select {
			case <-stop:
				c.Unlock()
				return
			default:
			}
			flows, err := readIPLimitFlows(c.specs)
			if err == nil {
				policies := c.state.observe(flows, now)
				policySignature := portLimitChain("", policies)
				if c.applied != policySignature {
					err = syncIPLimitFirewall(policies, false)
					if err == nil {
						c.verified = now
						c.applied = policySignature
					}
				} else if now.Sub(c.verified) >= 30*time.Second {
					err = syncIPLimitFirewall(policies, true)
					if err != nil {
						err = syncIPLimitFirewall(policies, false)
					}
					if err == nil {
						c.verified = now
					}
					if err == nil {
						err = cleanupLegacyIPConnectionCaps()
					}
				}
			}
			if err == nil {
				c.ready = now
			} else {
				c.ready = time.Time{}
				// Retry the desired firewall on the next tick after an apply failure.
				c.verified = time.Time{}
				if shouldLogAgentReport("ip-access-limit-observer", time.Minute) {
					logf("IP限制未完整生效: %v; retaining forwarding and previous firewall admission state", err)
				}
			}
			c.Unlock()
		}
	}
}
