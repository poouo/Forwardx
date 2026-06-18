package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
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
	cfg.RelayExitHost = strings.TrimSpace(cfg.RelayExitHost)
	return cfg, nil
}

func validateConfig(cfg config) error {
	if cfg.Key == "" {
		return errors.New("empty key")
	}
	if cfg.ListenPort <= 0 || cfg.ListenPort > 65535 {
		return fmt.Errorf("bad listen port %d", cfg.ListenPort)
	}
	if cfg.Role == "entry" {
		if cfg.ExitHost == "" || cfg.ExitPort <= 0 || cfg.ExitPort > 65535 {
			return errors.New("entry requires exit host and port")
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
	}
	return nil
}
