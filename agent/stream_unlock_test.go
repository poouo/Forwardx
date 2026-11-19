package main

import "testing"

func TestStreamUnlockAvailabilityState(t *testing.T) {
	tests := []struct {
		name         string
		status       int
		body         string
		effectiveURL string
		wantState    string
	}{
		{name: "login page is reachable", status: 200, body: `<html><title>Sign in</title></html>`, wantState: "available"},
		{name: "login-required response is reachable", status: 401, body: `{"error":"login required"}`, wantState: "available"},
		{name: "explicit country restriction", status: 200, body: `{"error":"unsupported_country"}`, wantState: "blocked"},
		{name: "localized region restriction", status: 200, body: `This service is not available in your region`, wantState: "blocked"},
		{name: "redirected to country restriction", status: 302, effectiveURL: "https://chatgpt.com/unsupported_country", wantState: "blocked"},
		{name: "legal restriction", status: 451, wantState: "blocked"},
		{name: "generic forbidden is inconclusive", status: 403, body: "Request blocked", wantState: "unknown"},
		{name: "server error", status: 503, wantState: "error"},
		{name: "connection failure", status: 0, wantState: "error"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			state, _, _ := streamUnlockAvailabilityState(test.status, test.body, test.effectiveURL)
			if state != test.wantState {
				t.Fatalf("state = %q, want %q", state, test.wantState)
			}
		})
	}
}

func TestStreamUnlockProvidersIncludesAIAvailabilityChecks(t *testing.T) {
	providers := streamUnlockProviders()
	for _, id := range []string{"tiktok", "gemini", "grok", "chatgpt", "claude"} {
		provider, ok := providers[id]
		if !ok {
			t.Fatalf("provider %q is missing", id)
		}
		if provider.url == "" || provider.parse == nil {
			t.Fatalf("provider %q is missing its URL or parser", id)
		}
		if provider.domain != "" {
			t.Errorf("provider %q unexpectedly requests DNS classification for domain %q", id, provider.domain)
		}
		state, region, _, _ := provider.parse(200, `<html><title>Sign in</title></html>`, provider.url)
		wantState := "unknown"
		if id == "tiktok" {
			wantState = "available"
		}
		if state != wantState {
			t.Errorf("provider %q login entry state = %q, want %q", id, state, wantState)
		}
		if region != "" {
			t.Errorf("provider %q unexpectedly reports a country region %q", id, region)
		}
		state, region, _, _ = provider.parse(200, `{"countryCode":"sg"}`, provider.url)
		if state != wantState || region != "SG" {
			t.Errorf("provider %q detected region = (%q, %q), want (%q, SG)", id, state, region, wantState)
		}
	}
}

func TestStreamUnlockProvidersIncludesBilibiliTVRegionProbe(t *testing.T) {
	providers := streamUnlockProviders()
	provider, ok := providers["bilibili-tv"]
	if !ok {
		t.Fatal("provider bilibili-tv is missing")
	}
	if provider.domain != "bilibili.tv" || provider.url != "https://www.bilibili.tv/" {
		t.Fatalf("unexpected Bilibili TV probe target: domain=%q url=%q", provider.domain, provider.url)
	}
	if _, exists := providers["bilibili"]; exists {
		t.Fatal("domestic Bilibili provider must not be probed")
	}
	if providers["bahamut"].id != "bahamut" {
		t.Fatal("existing Bahamut provider was replaced")
	}

	state, region, _, _ := provider.parse(200, `{"data":{"countryCode":"sg"}}`, provider.url)
	if state != "available" || region != "SG" {
		t.Fatalf("probe result = (%q, %q), want (available, SG)", state, region)
	}
	state, region, _, _ = provider.parse(200, `<html><title>Bilibili TV</title></html>`, provider.url)
	if state != "available" || region != "" {
		t.Fatalf("probe without region data = (%q, %q), want (available, empty)", state, region)
	}
}
