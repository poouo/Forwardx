package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestStreamUnlockAIRejectsReachableRegionDenialPages(t *testing.T) {
	tests := []struct {
		name, provider, body, url, want string
		status                          int
	}{
		{"Claude HTTP 200 region redirect", "claude", `<html><title>App unavailable in region</title><h1>App unavailable</h1></html>`, "https://claude.com/app-unavailable-in-region#_", "blocked", 200},
		{"ChatGPT structured regional denial", "chatgpt", `{"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}`, "https://api.openai.com/compliance/cookie_requirements", "blocked", 403},
		{"Claude structured regional denial", "claude", `{"type":"error","error":{"type":"permission_error","message":"Claude isn't available in your region.","details":{"error_code":"region_unavailable"}}}`, "https://claude.ai/api/bootstrap", "blocked", 403},
		{"Gemini visible warning with successful HTTP", "gemini", `<html><body><p>Gemini isn’t available in your country yet.</p></body></html>`, "https://gemini.google.com/app", "blocked", 200},
		{"plain ChatGPT login is not proof", "chatgpt", `<html><title>ChatGPT</title><button>Log in</button></html>`, "https://chatgpt.com/auth/login", "unknown", 200},
		{"plain Claude login is not proof", "claude", `<html><title>Claude</title><button>Sign in</button></html>`, "https://claude.ai/login", "unknown", 200},
		{"Grok challenge is inconclusive", "grok", `<html><title>Just a moment...</title></html>`, "https://grok.com/", "unknown", 200},
		{"forbidden without region evidence is inconclusive", "chatgpt", `Request blocked`, "https://chatgpt.com/auth/login", "unknown", 403},
		{"localized visible restriction", "claude", `<div>您所在的国家或地区不可用</div>`, "https://claude.ai/login", "blocked", 200},
		{"JSON escaped localized restriction", "claude", `{"error":{"message":"\u60a8\u6240\u5728\u7684\u56fd\u5bb6\u6216\u5730\u533a\u4e0d\u53ef\u7528"}}`, "https://claude.ai/api/bootstrap", "blocked", 403},
		{"script catalog restriction is not visitor denial", "gemini", `<script>{"message":"not available in your country","45631641":true}</script><main>Sign in to Gemini</main>`, "https://gemini.google.com/app", "available", 200},
		{"hidden template is not visitor denial", "claude", `<template>not available in your country</template><main>Sign in</main>`, "https://claude.ai/login", "unknown", 200},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			state, _, _ := streamUnlockAIPageState(tc.provider, tc.status, tc.body, tc.url)
			if state != tc.want {
				t.Fatalf("state=%q, want %q", state, tc.want)
			}
		})
	}
}

func TestStreamUnlockAIServiceRequiresValidResponse(t *testing.T) {
	for _, tc := range []struct {
		status     int
		body, want string
	}{
		{200, `{"config":{"enabled":true},"user":null}`, "available"},
		{200, `<html><title>Sign in</title></html>`, "unknown"},
		{200, `<html><title>Just a moment...</title></html>`, "unknown"},
		{200, `{}`, "unknown"},
		{200, `{"error":"unsupported_country"}`, "blocked"},
		{200, `{"error":"rate_limited"}`, "unknown"},
		{200, `{"statusCode":503}`, "unknown"},
		{200, `{"success":false}`, "unknown"},
		{200, `{"message":"Please try again later"}`, "unknown"},
		{200, `{"is_country_supported":false}`, "blocked"},
		{401, `{"error":"login_required"}`, "unknown"},
		{403, `{"error":{"code":"unsupported_country_region_territory"}}`, "blocked"},
		{403, `Request blocked`, "unknown"},
	} {
		state, _, _ := streamUnlockAIServiceState(tc.status, tc.body, "https://claude.ai/api/bootstrap")
		if state != tc.want {
			t.Errorf("status=%d body=%s: state=%q want %q", tc.status, tc.body, state, tc.want)
		}
	}
}

type streamUnlockTestTransport func(*http.Request) (*http.Response, error)

func (f streamUnlockTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestStreamUnlockAIServiceDenialOverridesReachablePage(t *testing.T) {
	for provider, endpoint := range map[string]string{
		"chatgpt": "https://api.openai.com/compliance/cookie_requirements",
		"claude":  "https://claude.ai/api/bootstrap",
	} {
		t.Run(provider, func(t *testing.T) {
			client := &http.Client{Transport: streamUnlockTestTransport(func(req *http.Request) (*http.Response, error) {
				if req.URL.String() != endpoint {
					t.Fatalf("unexpected endpoint %s", req.URL)
				}
				return &http.Response{StatusCode: 403, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"unsupported_country_region_territory"}}`)), Header: make(http.Header), Request: req}, nil
			})}
			result := streamUnlockProviderResult{Status: "unknown", HTTPStatus: 200, Region: "HK"}
			streamUnlockProbeAIAvailability(context.Background(), client, provider, &result)
			if result.Status != "blocked" || result.HTTPStatus != 403 || result.Region != "HK" {
				t.Fatalf("unexpected result: %+v", result)
			}
		})
	}
}

func TestStreamUnlockAITraceNeverOpensDeniedService(t *testing.T) {
	var requests []string
	client := &http.Client{Transport: streamUnlockTestTransport(func(req *http.Request) (*http.Response, error) {
		requests = append(requests, req.URL.String())
		status, body := 200, ""
		switch req.URL.String() {
		case "https://chatgpt.com/auth/login":
			body = `<html><title>ChatGPT</title><button>Sign in</button></html>`
		case "https://api.openai.com/compliance/cookie_requirements":
			status, body = 403, `{"error":{"code":"unsupported_country_region_territory"}}`
		case "https://chatgpt.com/cdn-cgi/trace":
			body = "h=chatgpt.com\nip=192.0.2.1\nloc=HK\n"
		default:
			t.Fatalf("unexpected endpoint %s", req.URL)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header), Request: req}, nil
	})}
	result := streamUnlockProbeProviderWithClient(context.Background(), client, streamUnlockProviders()["chatgpt"], "ipv4")
	if len(requests) != 3 || result.Region != "HK" || result.Status != "blocked" || result.HTTPStatus != 403 {
		t.Fatalf("trace must only supply region: %+v", result)
	}
}
