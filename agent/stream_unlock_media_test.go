package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestStreamUnlockMediaRequiresPlatformEvidence(t *testing.T) {
	tests := []struct {
		name, id, body, endpoint, wantStatus, wantRegion string
		status                                           int
	}{
		{"YouTube offer", "youtube", `<script>{"contentRegion":"JP"}</script><h1>YouTube Premium</h1><button>Get YouTube Premium</button>`, "https://www.youtube.com/premium", "available", "JP", 200},
		{"YouTube embedded purchase button", "youtube", `<script>ytInitialData=JSON.parse('\x7b\x22contentRegion\x22:\x22US\x22,\x22premiumPurchaseButtonRenderer\x22:\x7b\x7d\x7d')</script>`, "https://www.youtube.com/premium", "available", "US", 200},
		{"YouTube marketing copy", "youtube", `<script>{"contentRegion":"JP"}</script><h1>YouTube Premium</h1><p>Watch ad-free</p>`, "https://www.youtube.com/premium", "unknown", "JP", 200},
		{"YouTube denied with HTTP 200", "youtube", `<h1>Premium is not available in your country</h1>`, "https://www.youtube.com/premium", "blocked", "", 200},
		{"YouTube consent", "youtube", `<h1>Before you continue to YouTube</h1>`, "https://consent.youtube.com/", "unknown", "", 200},
		{"Disney visitor locale", "disney-plus", `<script id="langRegionRedirect">window.langRegionRedirectProps = {"availableLocales":["en-hk"],"location":"HK","urlRegion":"us"};</script>`, "https://www.disneyplus.com/", "available", "HK", 200},
		{"Disney unrelated store locale", "disney-plus", `<script id="langRegionRedirect">{"availableLocales":["en-us"],"location":"HK"}</script>`, "https://www.disneyplus.com/", "unknown", "HK", 200},
		{"Disney preview", "disney-plus", `<h1>Disney+</h1>`, "https://www.disneyplus.com/en-jp/preview", "partial", "", 200},
		{"Abema rejects proxy", "abema", `{"message":"anonymous_ip"}`, "https://api.abema.io/v1/ip/check", "blocked", "", 403},
		{"Abema generic forbidden", "abema", `Access denied`, "https://api.abema.io/v1/ip/check", "unknown", "", 403},
		{"Bilibili empty page", "bilibili-tv", "", "https://www.bilibili.tv/", "unknown", "", 200},
		{"TikTok Hong Kong visitor on global homepage", "tiktok", `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"region":"US","userRegion":"HK"}}}</script>`, "https://www.tiktok.com/", "blocked", "HK", 200},
		{"TikTok Hong Kong visitor in legacy bootstrap", "tiktok", `<script id="SIGI_STATE">{"AppContext":{"appContext":{"region":"HK"}}}</script>`, "https://www.tiktok.com/explore", "blocked", "HK", 200},
		{"TikTok explicit Hong Kong closure notice without inferred region", "tiktok", `<h1>We have discontinued operating TikTok in Hong Kong.</h1>`, "https://www.tiktok.com/", "blocked", "", 200},
		{"TikTok content country is independent of visitor region", "tiktok", `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"userRegion":"SG"},"webapp.recommend-feed":{"items":[{"id":"123","region":"HK","video":{"duration":10}}]}}}</script>`, "https://www.tiktok.com/explore", "available", "SG", 200},
		{"TikTok Macao region alone is inconclusive", "tiktok", `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"userRegion":"MO"}}}</script>`, "https://www.tiktok.com/explore", "unknown", "MO", 200},
		{"TikTok Macao explicit restriction", "tiktok", `{"countryCode":"MO","statusMsg":"Not available in your region"}`, "https://www.tiktok.com/explore", "blocked", "MO", 200},
		{"TikTok embedded feed region restriction", "tiktok", `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"userRegion":"MO"},"webapp.recommend-feed":{"statusCode":1,"statusMsg":"Not available in your region"}}}</script>`, "https://www.tiktok.com/explore", "blocked", "MO", 200},
		{"TikTok Macao video feed", "tiktok", `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"userRegion":"MO"},"webapp.recommend-feed":{"statusCode":0,"itemList":[{"id":"123","video":{"duration":10}}]}}}</script>`, "https://www.tiktok.com/explore", "available", "MO", 200},
		{"TikTok unsuccessful feed is inconclusive", "tiktok", `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"userRegion":"JP"},"webapp.recommend-feed":{"statusCode":1,"itemList":[{"id":"123","video":{"duration":10}}]}}}</script>`, "https://www.tiktok.com/explore", "unknown", "JP", 200},
		{"TikTok empty feed is inconclusive", "tiktok", `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"userRegion":"JP"},"webapp.recommend-feed":{"statusCode":0,"itemList":[]}}}</script>`, "https://www.tiktok.com/explore", "unknown", "JP", 200},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			state, region, _, _ := streamUnlockMediaPageState(tc.id, tc.status, tc.body, tc.endpoint)
			if state != tc.wantStatus || region != tc.wantRegion {
				t.Fatalf("got (%s, %s), want (%s, %s)", state, region, tc.wantStatus, tc.wantRegion)
			}
		})
	}
}

func TestStreamUnlockNetflixProbesOriginalAndLicensedTitle(t *testing.T) {
	for _, tc := range []struct {
		name, licensedBody, wantStatus string
		licensedHTTP                   int
	}{
		{"licensed available", `{"metaData":{"isIndexable":true,"isAvailable":true},"requestCountry":{"id":"JP"}}`, "available", http.StatusOK},
		{"original only in sample", `{"metaData":{"isAvailable":false}}`, "partial", http.StatusOK},
		{"licensed title missing", `<h1>Oh no!</h1>`, "partial", http.StatusNotFound},
		{"generic forbidden cannot prove originals only", "Access denied", "unknown", http.StatusForbidden},
		{"marketing page cannot prove licensed access", "<title>Netflix</title>", "unknown", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			provider := streamUnlockProviders()["netflix"]
			client := &http.Client{Transport: streamUnlockTestTransport(func(req *http.Request) (*http.Response, error) {
				status, body := tc.licensedHTTP, tc.licensedBody
				if req.URL.String() == provider.url {
					status, body = http.StatusOK, `{"metaData":{"isAvailable":true},"requestCountry":{"id":"JP"}}`
				} else if req.URL.String() != streamUnlockNetflixLicensedTitle {
					t.Errorf("unexpected probe %s", req.URL)
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
			})}
			result := streamUnlockProbeProviderWithClient(context.Background(), client, provider, "ipv4")
			if result.Status != tc.wantStatus || result.Region != "JP" || result.HTTPStatus != tc.licensedHTTP {
				t.Fatalf("unexpected Netflix result: %+v", result)
			}
		})
	}
}

func TestStreamUnlockTikTokFallsBackToExplore(t *testing.T) {
	provider := streamUnlockProviders()["tiktok"]
	client := &http.Client{Transport: streamUnlockTestTransport(func(req *http.Request) (*http.Response, error) {
		body := `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"region":"TH"}}}</script>`
		if req.URL.Path == "/explore" {
			body = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.recommend-feed":{"itemList":[{"id":"123","video":{"duration":10}}]}}}</script>`
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
	})}
	result := streamUnlockProbeProviderWithClient(context.Background(), client, provider, "ipv6")
	if result.Status != "available" || result.Region != "TH" || result.Family != "ipv6" {
		t.Fatalf("unexpected TikTok result: %+v", result)
	}
}
