package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

func streamUnlockIsAI(providerID string) bool {
	return providerID == "chatgpt" || providerID == "claude" || providerID == "grok" || providerID == "gemini"
}

// Ignore script bundles and translation catalogues: a restriction message in
// application source is not proof that this visitor is seeing that message.
func streamUnlockVisibleText(body string) string {
	z := html.NewTokenizer(strings.NewReader(body))
	ignored := map[string]bool{"script": true, "style": true, "template": true, "svg": true, "noscript": true}
	depth := 0
	var text strings.Builder
	for {
		switch z.Next() {
		case html.ErrorToken:
			return strings.Join(strings.Fields(text.String()), " ")
		case html.StartTagToken:
			if ignored[z.Token().Data] {
				depth++
			}
		case html.EndTagToken:
			if ignored[z.Token().Data] && depth > 0 {
				depth--
			}
		case html.TextToken:
			if depth == 0 {
				text.Write(z.Text())
				text.WriteByte(' ')
			}
		}
	}
}

func streamUnlockRestrictionText(body, effectiveURL string) string {
	var object map[string]json.RawMessage
	var parts []string
	if json.Unmarshal([]byte(body), &object) == nil {
		for _, key := range []string{"error", "errors", "message", "detail", "error_code", "code", "reason", "statusMsg", "status_msg"} {
			if value := object[key]; len(value) > 0 {
				parts = append(parts, streamUnlockJSONErrorText(value))
			}
		}
	} else {
		parts = append(parts, streamUnlockVisibleText(body))
	}
	if parsed, err := url.Parse(effectiveURL); err == nil {
		parts = append(parts, parsed.Path, parsed.Query().Get("error"))
	}
	return strings.ToLower(strings.Join(parts, "\n"))
}

func streamUnlockJSONErrorText(raw json.RawMessage) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	var parts []string
	var collect func(any)
	collect = func(item any) {
		switch item := item.(type) {
		case string:
			parts = append(parts, item)
		case map[string]any:
			for _, child := range item {
				collect(child)
			}
		case []any:
			for _, child := range item {
				collect(child)
			}
		}
	}
	collect(value)
	return strings.Join(parts, " ")
}

func streamUnlockAIPageState(providerID string, status int, body, effectiveURL string) (state, detail, evidence string) {
	state, detail, evidence = streamUnlockAvailabilityState(status, body, effectiveURL)
	if state != "available" || !streamUnlockIsAI(providerID) {
		return
	}
	// The Gemini probe used by RegionRestrictionCheck has an affirmative
	// availability flag. Its absence/false value alone is inconclusive.
	if providerID == "gemini" {
		text := streamUnlockPageText(body)
		if streamUnlockRegex(text, `(?:"45631641"\s*:\s*|45631641\s*,\s*null\s*,\s*)(true)\b`) == "true" {
			return "available", "平台页面返回地区开放标记；实际账号权限需登录后确认", "Gemini affirmative availability flag"
		}
	}
	return "unknown", "页面可访问，但尚未确认该出口的服务开放状态", "reachable page is not availability proof"
}

func streamUnlockAIServiceState(status int, body, effectiveURL string) (state, detail, evidence string) {
	state, detail, evidence = streamUnlockAvailabilityState(status, body, effectiveURL)
	if state != "available" {
		return
	}
	var object map[string]json.RawMessage
	if status < 200 || status >= 300 || json.Unmarshal([]byte(body), &object) != nil || len(object) == 0 {
		return "unknown", "服务接口未返回有效的开放状态", "no valid service response"
	}
	for _, key := range []string{"error", "errors"} {
		if value, ok := object[key]; ok && string(value) != "null" && string(value) != "false" && string(value) != "[]" {
			return "unknown", "服务接口返回错误，无法确认开放状态", "service error is inconclusive"
		}
	}
	for _, key := range []string{"code", "status", "statusCode"} {
		var code int
		if value, ok := object[key]; ok && json.Unmarshal(value, &code) == nil && code >= 400 {
			return "unknown", "服务接口返回错误，无法确认开放状态", "service error is inconclusive"
		}
	}
	if value, ok := object["success"]; ok && string(value) == "false" {
		return "unknown", "服务接口未确认开放状态", "service response rejected"
	}
	for _, key := range []string{"is_country_supported", "region_supported", "inSupportedLocation"} {
		if value, ok := object[key]; ok && string(value) == "false" {
			return "blocked", "服务接口提示当前国家或地区不可用", "explicit region restriction flag"
		}
	}
	hasData := false
	for key := range object {
		switch key {
		case "error", "errors", "message", "detail", "code", "status", "statusCode", "success":
		default:
			hasData = true
		}
	}
	if !hasData {
		return "unknown", "服务接口未返回足够的开放状态信息", "no service data"
	}
	return "available", "服务接口通过地区检查；实际账号权限需登录后确认", "valid service region-check response"
}

func streamUnlockProbeAIAvailability(ctx context.Context, client *http.Client, providerID string, result *streamUnlockProviderResult) {
	if !streamUnlockIsAI(providerID) || result.Status == "blocked" {
		return
	}
	endpoints := map[string]string{
		"chatgpt": "https://api.openai.com/compliance/cookie_requirements",
		"claude":  "https://claude.ai/api/bootstrap",
		"grok":    "https://grok.com/rest/auth/get-session",
	}
	endpoint := endpoints[providerID]
	if endpoint == "" {
		return
	}
	status, body, effectiveURL, _, err := streamUnlockHTTPGet(ctx, client, endpoint)
	if err != nil {
		return
	}
	state, detail, evidence := streamUnlockAIServiceState(status, body, effectiveURL)
	// Ignore redirects to unrelated marketing/login origins as positive proof.
	requested, requestErr := url.Parse(endpoint)
	resolved, resolvedErr := url.Parse(effectiveURL)
	if state == "available" && (requestErr != nil || resolvedErr != nil || resolved.Scheme != "https" || !strings.EqualFold(requested.Hostname(), resolved.Hostname())) {
		return
	}
	if state == "available" || state == "blocked" {
		result.Status, result.Detail, result.Evidence = state, detail, endpoint+": "+evidence
		result.HTTPStatus = status
	}
	if result.Region == "" {
		result.Region = streamUnlockProviderRegion(providerID, body)
	}
}
