package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
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
	return cfg, nil
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
