package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/text/language"
)

// Platform pages often embed escaped JSON in scripts. Decode quote escapes for
// targeted field matching, without evaluating any JavaScript from the page.
func streamUnlockPageText(body string) string {
	return strings.NewReplacer(`\"`, `"`, `\u0022`, `"`, `\x22`, `"`).Replace(body)
}

func streamUnlockCountry(value string) string {
	value = strings.TrimSpace(value)
	if len(value) != 2 && len(value) != 3 {
		return ""
	}
	for _, c := range value {
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
			return ""
		}
	}
	region, err := language.ParseRegion(value)
	if err != nil || !region.IsCountry() || len(region.String()) != 2 {
		return ""
	}
	return region.String()
}

func streamUnlockScript(body, id string) string {
	return streamUnlockRegex(body, `(?is)<script\b[^>]*\bid\s*=\s*["']`+regexp.QuoteMeta(id)+`["'][^>]*>(.*?)</script\s*>`)
}

func streamUnlockJSONCountry(body string, paths ...[]string) string {
	var value any
	if json.Unmarshal([]byte(body), &value) != nil {
		return ""
	}
	for _, path := range paths {
		current := value
		for _, key := range path {
			object, ok := current.(map[string]any)
			if !ok {
				current = nil
				break
			}
			current = object[key]
		}
		if text, ok := current.(string); ok {
			if country := streamUnlockCountry(text); country != "" {
				return country
			}
		}
	}
	return ""
}

// Read the visitor's platform-specific fields, not arbitrary country names in
// language selectors, content metadata, CDN settings or a generic IP database.
func streamUnlockProviderRegion(providerID, body string) string {
	if region := streamUnlockJSONCountry(body, []string{"countryCode"}, []string{"country_code"}, []string{"isoCountryCode"}, []string{"country"}, []string{"data", "countryCode"}); region != "" {
		return region
	}
	text := streamUnlockPageText(body)
	var region string
	switch providerID {
	case "netflix":
		region = streamUnlockRegex(text, `"requestCountry"\s*:\s*\{[^{}]{0,1000}?"id"\s*:\s*"([A-Za-z]{2})"`)
	case "youtube":
		region = streamUnlockRegex(text, `"INNERTUBE_CONTEXT_GL"\s*:\s*"([A-Za-z]{2})"`)
	case "disney-plus":
		// urlRegion describes the selected storefront; location is the visitor.
		config := streamUnlockPageText(streamUnlockScript(body, "langRegionRedirect"))
		region = streamUnlockRegex(config, `"location"\s*:\s*"([A-Za-z]{2})"`)
		if region == "" {
			region = streamUnlockJSONCountry(streamUnlockScript(body, "__NEXT_DATA__"), []string{"props", "pageProps", "location"})
		}
	case "spotify":
		encoded := strings.TrimSpace(streamUnlockScript(body, "appServerConfig"))
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err == nil {
			region = streamUnlockJSONCountry(string(decoded), []string{"market"})
		}
	case "bahamut":
		region = streamUnlockRegex(body, `(?is)<html\b[^>]*\bdata-geo\s*=\s*["']([A-Za-z]{2})["']`)
	case "tiktok":
		region = streamUnlockJSONCountry(streamUnlockScript(body, "__UNIVERSAL_DATA_FOR_REHYDRATION__"),
			[]string{"__DEFAULT_SCOPE__", "webapp.app-context", "region"},
			[]string{"__DEFAULT_SCOPE__", "webapp.app-context", "userRegion"})
		if region == "" {
			region = streamUnlockJSONCountry(streamUnlockScript(body, "SIGI_STATE"),
				[]string{"AppContext", "appContext", "region"}, []string{"AppContext", "region"})
		}
	case "gemini":
		region = streamUnlockRegex(text, `,\s*2\s*,\s*1\s*,\s*200\s*,\s*"([A-Z]{3})"`)
	}
	return streamUnlockCountry(region)
}

func streamUnlockTraceRegion(body, host, family string) string {
	fields := map[string]string{}
	for _, line := range strings.Split(body, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			fields[key] = value
		}
	}
	ip := net.ParseIP(fields["ip"])
	if !strings.EqualFold(fields["h"], host) || ip == nil {
		return ""
	}
	if (family == "ipv4" && ip.To4() == nil) || (family == "ipv6" && ip.To4() != nil) {
		return ""
	}
	return streamUnlockCountry(fields["loc"])
}

// These platforms expose the request country on their own edge. This supplies
// region only; an accessible trace must never turn a denied login into success.
func streamUnlockAIRegion(ctx context.Context, client *http.Client, providerID, family string) string {
	hosts := map[string]string{"chatgpt": "chatgpt.com", "claude": "claude.ai", "grok": "grok.com"}
	host := hosts[providerID]
	if host == "" {
		return ""
	}
	status, body, effectiveURL, _, err := streamUnlockHTTPGet(ctx, client, "https://"+host+"/cdn-cgi/trace")
	resolved, parseErr := url.Parse(effectiveURL)
	if err != nil || parseErr != nil || status != http.StatusOK || resolved.Scheme != "https" || !strings.EqualFold(resolved.Hostname(), host) {
		return ""
	}
	return streamUnlockTraceRegion(body, host, family)
}
