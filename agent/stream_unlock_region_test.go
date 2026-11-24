package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStreamUnlockPlatformVisitorRegions(t *testing.T) {
	spotify := base64.StdEncoding.EncodeToString([]byte(`{"market":"HK","locale":"en-US"}`))
	tests := []struct{ name, provider, body, want string }{
		{"Netflix request country beats locale list", "netflix", `{"supportedLocales":[{"id":"en","country":"US"}],"requestCountry":{"supportedLocales":["zh","en"],"id":"HK","countryName":"Hong Kong"}}`, "HK"},
		{"Netflix escaped bootstrap", "netflix", `window.data={\"requestCountry\":{\"id\":\"JP\"}}`, "JP"},
		{"Netflix ignores language identifiers", "netflix", `{"id":"en","title":"Something"}`, ""},
		{"Netflix HTML ignores locale country", "netflix", `<script>{"supportedLocales":[{"id":"en","country":"US"}]}</script>`, ""},
		{"YouTube actual GL", "youtube", `ytcfg.set({"INNERTUBE_CONTEXT_HL":"en","INNERTUBE_CONTEXT_GL":"DE"});`, "DE"},
		{"YouTube Premium content country", "youtube", `{"contentRegion":"JP","INNERTUBE_CONTEXT_GL":"US"}`, "JP"},
		{"Disney location beats storefront and dictionary", "disney-plus", `<script id="langRegionRedirect">window.langRegionRedirectProps={"countriesConfig":{"US":{"country":"US"}},"urlRegion":"us","location":"HK"};</script>`, "HK"},
		{"Disney next data visitor", "disney-plus", `<script id="__NEXT_DATA__">{"props":{"pageProps":{"location":"TW","region":"us"}}}</script>`, "TW"},
		{"Spotify encoded server market", "spotify", `<script type="text/plain" id="appServerConfig">` + spotify + `</script>`, "HK"},
		{"Spotify malformed config", "spotify", `<script id="appServerConfig">invalid</script>`, ""},
		{"Bahamut root geo", "bahamut", `<html lang="zh-Hant-TW" data-geo="HK"><body>`, "HK"},
		{"Bahamut locale alone is not location", "bahamut", `<html lang="zh-Hant-TW"><body>`, ""},
		{"TikTok viewer region", "tiktok", `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"region":"JP"},"cdn":{"region":"SG"}}}</script>`, "JP"},
		{"TikTok explicit user region", "tiktok", `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"region":"US","userRegion":"JP"}}}</script>`, "JP"},
		{"TikTok CDN region is not visitor region", "tiktok", `<script>{"region":"sg-tiktok","vregion":"Singapore-Central"}</script>`, ""},
		{"Gemini ISO alpha3", "gemini", `AF_initDataCallback({data:[null,2,1,200,"HKG",null]});`, "HK"},
		{"Gemini escaped bootstrap", "gemini", `,2,1,200,\"USA\",null`, "US"},
		{"Bilibili API country", "bilibili-tv", `{"data":{"countryCode":"sg"}}`, "SG"},
		{"no guessing for Bilibili page", "bilibili-tv", `<html lang="en-US"></html>`, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := streamUnlockProviderRegion(tc.provider, tc.body); got != tc.want {
				t.Fatalf("region=%q, want %q", got, tc.want)
			}
		})
	}
}

func TestStreamUnlockCountryNormalization(t *testing.T) {
	for input, want := range map[string]string{"sg": "SG", "HKG": "HK", "USA": "US", "TWN": "TW", "CHN": "CN", "GBR": "GB", "ZZ": "", "ZZZ": "", "001": "", "EU": "", "Singapore-Central": ""} {
		if got := streamUnlockCountry(input); got != want {
			t.Errorf("country(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestStreamUnlockTraceValidatesPlatformAndIPFamily(t *testing.T) {
	body := "h=chatgpt.com\nip=192.0.2.1\nloc=HK\ncolo=NRT\n"
	if got := streamUnlockTraceRegion(body, "chatgpt.com", "ipv4"); got != "HK" {
		t.Fatalf("got %q, want visitor country HK rather than edge location NRT", got)
	}
	for _, tc := range []struct{ body, host, family string }{
		{body, "grok.com", "ipv4"}, {body, "chatgpt.com", "ipv6"},
		{"h=chatgpt.com\nloc=HK", "chatgpt.com", "ipv4"},
		{"h=chatgpt.com\nip=192.0.2.1\nloc=ZZ", "chatgpt.com", "ipv4"},
	} {
		if got := streamUnlockTraceRegion(tc.body, tc.host, tc.family); got != "" {
			t.Errorf("unverified trace returned %q", got)
		}
	}
}

func TestStreamUnlockReadsLateRegionWithinBoundedResponse(t *testing.T) {
	body := strings.Repeat(" ", 400*1024) + `ytcfg.set({"INNERTUBE_CONTEXT_GL":"JP"});`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	client := server.Client()
	_, page, _, _, err := streamUnlockHTTPGet(context.Background(), client, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if got := streamUnlockProviderRegion("youtube", page); got != "JP" {
		t.Fatalf("late region=%q, want JP", got)
	}
}
