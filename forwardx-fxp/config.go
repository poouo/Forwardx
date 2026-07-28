package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

func readConfig(path string) (config, error) {
	var cfg config
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, err
	}
	return normalizeConfig(cfg), nil
}

func normalizeConfig(cfg config) config {
	cfg.Role = strings.ToLower(strings.TrimSpace(cfg.Role))
	cfg.Protocol = normalizeProtocol(cfg.Protocol)
	cfg.TargetIP = strings.TrimSpace(cfg.TargetIP)
	cfg.ExitHost = strings.TrimSpace(cfg.ExitHost)
	cfg.ExitStrategy = normalizeExitStrategy(cfg.ExitStrategy)
	cfg.RelayExitHost = strings.TrimSpace(cfg.RelayExitHost)
	cfg.ListenHost = strings.TrimSpace(cfg.ListenHost)
	cfg.ProxyProtocolVersion = normalizeProxyProtocolVersion(cfg.ProxyProtocolVersion)
	if cfg.UDPListenPort <= 0 {
		cfg.UDPListenPort = cfg.ListenPort
	}
	if cfg.UDPExitPort <= 0 {
		cfg.UDPExitPort = cfg.ExitPort
	}
	if cfg.UDPRelayExitPort <= 0 {
		cfg.UDPRelayExitPort = cfg.RelayExitPort
	}
	for i := range cfg.Exits {
		cfg.Exits[i].Host = strings.TrimSpace(cfg.Exits[i].Host)
		if cfg.Exits[i].UDPPort <= 0 {
			cfg.Exits[i].UDPPort = cfg.Exits[i].Port
		}
		if cfg.Exits[i].Key == "" {
			cfg.Exits[i].Key = cfg.Key
		}
	}
	udpTargets := make([]udpTarget, 0, len(cfg.UDPTargets))
	seenUDPTargets := make(map[int]bool)
	for _, target := range cfg.UDPTargets {
		target.RuleID = int(target.RuleID)
		target.TargetIP = strings.TrimSpace(target.TargetIP)
		if target.RuleID <= 0 || target.TargetIP == "" || target.TargetPort <= 0 || target.TargetPort > 65535 || seenUDPTargets[target.RuleID] {
			continue
		}
		seenUDPTargets[target.RuleID] = true
		udpTargets = append(udpTargets, target)
	}
	sort.Slice(udpTargets, func(i, j int) bool { return udpTargets[i].RuleID < udpTargets[j].RuleID })
	cfg.UDPTargets = udpTargets
	for i := range cfg.Entries {
		cfg.Entries[i] = normalizeConfig(cfg.Entries[i])
	}
	return cfg
}

func normalizeExitStrategy(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "fallback", "random", "ip_hash":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "round_robin"
	}
}

func validateConfig(cfg config) error {
	if cfg.Role == "entry-group" {
		return validateEntryGroupConfig(cfg)
	}
	if cfg.Key == "" {
		return errors.New("empty key")
	}
	if cfg.ListenPort <= 0 || cfg.ListenPort > 65535 {
		return fmt.Errorf("bad listen port %d", cfg.ListenPort)
	}
	if cfg.UDPListenPort < 0 || cfg.UDPListenPort > 65535 {
		return fmt.Errorf("bad udp listen port %d", cfg.UDPListenPort)
	}
	if cfg.ListenHost != "" && cfg.ListenHost != "127.0.0.1" && cfg.ListenHost != "::1" {
		return fmt.Errorf("unsupported listen host %q", cfg.ListenHost)
	}
	if cfg.Role == "entry" {
		if cfg.ExitHost == "" || cfg.ExitPort <= 0 || cfg.ExitPort > 65535 {
			return errors.New("entry requires exit host and port")
		}
		for _, exit := range cfg.Exits {
			if exit.Host == "" || exit.Port <= 0 || exit.Port > 65535 || exit.UDPPort <= 0 || exit.UDPPort > 65535 {
				return errors.New("entry exits require host and port")
			}
		}
		if cfg.UDPExitPort < 0 || cfg.UDPExitPort > 65535 {
			return errors.New("entry requires a valid udp exit port")
		}
		if cfg.TargetIP == "" || cfg.TargetPort <= 0 || cfg.TargetPort > 65535 {
			return errors.New("entry requires target host and port")
		}
	}
	if (cfg.ProxyProtocolReceive || cfg.ProxyProtocolSend || cfg.ProxyProtocolExitReceive || cfg.ProxyProtocolExitSend) && cfg.Protocol == "udp" {
		return errors.New("proxy protocol requires tcp protocol")
	}
	if cfg.Role == "relay" {
		if cfg.RelayExitHost == "" || cfg.RelayExitPort <= 0 || cfg.RelayExitPort > 65535 || cfg.RelayKey == "" {
			return errors.New("relay requires relay exit host, port, and key")
		}
		if cfg.UDPRelayExitPort < 0 || cfg.UDPRelayExitPort > 65535 {
			return errors.New("relay requires a valid udp relay exit port")
		}
	}
	return nil
}

type entryListenLane struct {
	network string
	host    string
	port    int
	index   int
}

type entryListenLaneRegistry struct {
	first    map[string]entryListenLane
	wildcard map[string]entryListenLane
	exact    map[string]entryListenLane
}

func newEntryListenLaneRegistry(size int) *entryListenLaneRegistry {
	return &entryListenLaneRegistry{
		first:    make(map[string]entryListenLane, size),
		wildcard: make(map[string]entryListenLane, size),
		exact:    make(map[string]entryListenLane, size),
	}
}

func validateEntryGroupConfig(cfg config) error {
	if len(cfg.Entries) == 0 {
		return errors.New("entry-group requires at least one entry")
	}
	lanes := newEntryListenLaneRegistry(len(cfg.Entries) * 2)
	for i, entry := range cfg.Entries {
		if entry.Role != "entry" {
			return fmt.Errorf("entry-group entry %d requires role entry", i)
		}
		if entry.TunnelID != cfg.TunnelID {
			return fmt.Errorf("entry-group entry %d tunnel %d does not match group tunnel %d", i, entry.TunnelID, cfg.TunnelID)
		}
		if err := validateConfig(entry); err != nil {
			return fmt.Errorf("entry-group entry %d: %w", i, err)
		}
		if protocolHas(entry, "tcp") {
			if err := lanes.add(entryListenLane{network: "tcp", host: entry.ListenHost, port: entry.ListenPort, index: i}); err != nil {
				return err
			}
		}
		if protocolHas(entry, "udp") {
			if err := lanes.add(entryListenLane{network: "udp", host: entry.ListenHost, port: udpListenPort(entry), index: i}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (registry *entryListenLaneRegistry) add(lane entryListenLane) error {
	lane.host = strings.TrimSpace(lane.host)
	key := lane.network + ":" + strconv.Itoa(lane.port)
	var existing entryListenLane
	conflict := false
	if lane.host == "" {
		existing, conflict = registry.first[key]
	} else {
		existing, conflict = registry.wildcard[key]
		if !conflict {
			existing, conflict = registry.exact[key+"\x00"+lane.host]
		}
	}
	if conflict {
		return fmt.Errorf(
			"entry-group entries %d and %d conflict on %s listen %s",
			existing.index,
			lane.index,
			lane.network,
			listenAddress(lane.host, lane.port),
		)
	}
	if _, exists := registry.first[key]; !exists {
		registry.first[key] = lane
	}
	if lane.host == "" {
		registry.wildcard[key] = lane
	} else {
		registry.exact[key+"\x00"+lane.host] = lane
	}
	return nil
}
