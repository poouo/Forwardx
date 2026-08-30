package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
)

// fxpConfigUsesRemovedTrafficPadding reports whether a persisted FXP runtime
// config was produced by a build that supported the removed traffic-padding
// feature.  The current fxpSpec intentionally no longer contains those JSON
// fields, so checking only after unmarshalling would silently lose the signal
// and could cause an old process to be adopted after an upgrade.
func fxpConfigUsesRemovedTrafficPadding(raw []byte) bool {
	if !json.Valid(raw) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return false
	}
	// Reject trailing non-whitespace data as a malformed runtime snapshot. The
	// caller will already reject malformed JSON, but keeping this helper strict
	// prevents an accidental partial decode from being treated as clean.
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return false
	}
	return fxpJSONValueUsesRemovedTrafficPadding(value)
}

func fxpRuntimeConfigUsesRemovedTrafficPadding(configPath string) bool {
	if strings.TrimSpace(configPath) == "" {
		return false
	}
	raw, err := os.ReadFile(configPath)
	return err == nil && fxpConfigUsesRemovedTrafficPadding(raw)
}

func fxpJSONValueUsesRemovedTrafficPadding(value any) bool {
	switch value := value.(type) {
	case map[string]any:
		if enabled, ok := value["trafficPaddingEnabled"]; ok && fxpLegacyBoolEnabled(enabled) {
			return true
		}
		for _, key := range []string{"trafficPaddingRatio", "trafficPaddingMaxMbps"} {
			if candidate, ok := value[key]; ok && fxpLegacyNumberNonZero(candidate) {
				return true
			}
		}
		for _, child := range value {
			if fxpJSONValueUsesRemovedTrafficPadding(child) {
				return true
			}
		}
	case []any:
		for _, child := range value {
			if fxpJSONValueUsesRemovedTrafficPadding(child) {
				return true
			}
		}
	}
	return false
}

func fxpLegacyBoolEnabled(value any) bool {
	switch value := value.(type) {
	case bool:
		return value
	case json.Number:
		return fxpLegacyNumberNonZero(value)
	case string:
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "true", "yes", "on", "1":
			return true
		}
	}
	return false
}

func fxpLegacyNumberNonZero(value any) bool {
	var text string
	switch value := value.(type) {
	case json.Number:
		text = value.String()
	case float64:
		text = strconv.FormatFloat(value, 'g', -1, 64)
	case string:
		text = strings.TrimSpace(value)
	default:
		return false
	}
	if text == "" {
		return false
	}
	number, err := strconv.ParseFloat(text, 64)
	if err != nil {
		// A non-empty, non-numeric legacy value is safer to rebuild than to
		// silently reuse a runtime whose semantics the current Agent removed.
		return true
	}
	return number != 0
}
