package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

func copyFXPV3Options(dst *fxpSpec, src fxpSpec) {
	dst.V3Transport = src.V3Transport
	dst.V3Host = src.V3Host
	dst.V3Path = src.V3Path
	dst.V3UserAgent = src.V3UserAgent
	dst.V3ServerName = src.V3ServerName
	// Config snapshots must not retain a mutable caller-owned bool pointer.
	dst.V3Multiplex = nil
	if src.V3Multiplex != nil {
		value := *src.V3Multiplex
		dst.V3Multiplex = &value
	}
}

func fxpV3OptionsSignature(spec fxpSpec) string {
	multiplex := spec.V3Multiplex == nil || *spec.V3Multiplex
	encoded, _ := json.Marshal([]any{spec.V3Transport, spec.V3Host, spec.V3Path, spec.V3UserAgent, spec.V3ServerName, multiplex})
	digest := sha256.Sum256(encoded)
	return "v3-options:" + hex.EncodeToString(digest[:])
}

// Validate before touching a working process or its persisted config. Older
// runtimes reject V3 themselves; the panel must gate exposure by Agent/runtime
// capability before enabling the UI (that integration is still pending).
func validateFXPTransport(spec fxpSpec) error {
	switch spec.TransportVersion {
	case "v1", "v2":
		if spec.V3Transport != "" || spec.V3Host != "" || spec.V3Path != "" || spec.V3UserAgent != "" || spec.V3ServerName != "" || spec.V3Multiplex != nil {
			return fmt.Errorf("V3 options require transportVersion v3")
		}
	case "v3":
		switch spec.V3Transport {
		case "http", "ws":
			if strings.ContainsAny(spec.V3Host, "\r\n\x00\t ") || strings.ContainsAny(spec.V3Path, "\r\n\x00\t ") || len(spec.V3Host)+len(spec.V3Path) > 32*1024-256 {
				return fmt.Errorf("invalid V3 HTTP host/path")
			}
		case "tls":
			if len(spec.V3ServerName) > 253 || strings.ContainsAny(spec.V3ServerName, "\x00\r\n\t /\\") {
				return fmt.Errorf("invalid V3 TLS server name")
			}
		default:
			return fmt.Errorf("V3 requires http, ws, or tls transport")
		}
	default:
		return fmt.Errorf("unsupported FXP transport version %q", spec.TransportVersion)
	}
	if spec.Role == fxpEntryGroupRole {
		for _, entry := range spec.Entries {
			if err := validateFXPTransport(entry); err != nil {
				return fmt.Errorf("entry rule=%d: %w", entry.RuleID, err)
			}
			if spec.TransportVersion == "v3" && fxpV3OptionsSignature(spec) != fxpV3OptionsSignature(entry) {
				return fmt.Errorf("entry rule=%d has inconsistent V3 transport options", entry.RuleID)
			}
		}
	}
	return nil
}
