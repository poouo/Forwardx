package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var streamUnlockNetflixTitle = regexp.MustCompile(`(?i)"metaData"\s*:\s*\{[^{}]{0,300}?"isAvailable"\s*:\s*(true|false)\b`)

func streamUnlockMediaPageState(id string, status int, body, effectiveURL string) (state, region, detail, evidence string) {
	state, detail, evidence = streamUnlockAvailabilityState(status, body, effectiveURL)
	region = streamUnlockProviderRegion(id, body)
	page, _ := url.Parse(effectiveURL)
	if id == "tiktok" && state != "error" && state != "blocked" {
		if strings.Contains(streamUnlockRestrictionText(body, effectiveURL), "discontinued operating tiktok in ") {
			return "blocked", region, "TikTok 页面提示已停止在当地运营", "TikTok regional service notice"
		}
		if region == "HK" {
			return "blocked", region, "TikTok 将当前访客地区识别为香港，香港地区未开放", "TikTok visitor country HK"
		}
	}
	if id == "abema" && status == http.StatusForbidden && strings.Contains(streamUnlockRestrictionText(body, ""), "anonymous_ip") {
		return "blocked", region, "AbemaTV 拒绝匿名代理 IP", "Abema anonymous_ip"
	}
	if id == "netflix" && (status == http.StatusNotFound || status == http.StatusGone) {
		return "blocked", region, "当前出口无法访问测试片目", "Netflix title not found"
	}
	if id == "youtube" && page != nil && strings.EqualFold(page.Hostname(), "www.google.cn") {
		return "blocked", "CN", "YouTube 入口跳转到 Google 中国", "YouTube redirect to google.cn"
	}
	if state != "available" {
		return
	}
	if status < 200 || status >= 300 || strings.TrimSpace(body) == "" {
		return "unknown", region, "平台未返回有效的检测页面", "no valid streaming response"
	}
	state, detail, evidence = "available", "公开页面可访问", "public page reachable"
	switch id {
	case "netflix":
		match := streamUnlockNetflixTitle.FindStringSubmatch(streamUnlockPageText(body))
		if len(match) > 1 && match[1] == "true" {
			return "available", region, "Netflix 确认测试片目在当前地区可用", "Netflix title metadata available"
		}
		if len(match) > 1 || strings.Contains(strings.ToLower(streamUnlockVisibleText(body)), "oh no!") {
			return "blocked", region, "Netflix 显示当前地区的测试片目不可用", "Netflix title unavailable"
		}
	case "youtube":
		// The purchase control is often rendered by ytInitialData rather than HTML.
		if page != nil && strings.EqualFold(page.Hostname(), "www.youtube.com") && strings.TrimRight(page.Path, "/") == "/premium" &&
			region != "" && strings.Contains(streamUnlockPageText(body), `"premiumPurchaseButtonRenderer"`) {
			return "available", region, "当前地区显示 YouTube Premium 订阅入口", "YouTube Premium purchase renderer"
		}
		visible := strings.ToLower(streamUnlockVisibleText(body))
		if strings.Contains(visible, "get youtube premium") || (strings.Contains(visible, "youtube premium") && strings.Contains(visible, "try it free")) {
			return "available", region, "当前地区显示 YouTube Premium 订阅入口", "YouTube Premium offer"
		}
	case "disney-plus":
		if page != nil && (page.Hostname() == "www.disneyplus.com" || page.Hostname() == "disneyplus.com") {
			for _, segment := range strings.Split(page.Path, "/") {
				if segment == "preview" {
					return "partial", region, "当前出口跳转到 Disney+ 预览站点", "Disney+ preview redirect"
				}
			}
		}
		for _, locale := range streamUnlockDisneyVisitor(body).AvailableLocales {
			if region != "" && strings.HasSuffix(strings.ToUpper(locale), "-"+region) {
				return "available", region, "Disney+ 返回当前地区的站点配置", "Disney+ visitor storefront"
			}
		}
	case "tiktok":
		if page != nil && (page.Hostname() == "www.tiktok.com" || page.Hostname() == "tiktok.com") {
			switch strings.TrimRight(page.Path, "/") {
			case "", "/explore", "/foryou":
				switch streamUnlockTikTokFeedState(body) {
				case "blocked":
					return "blocked", region, "TikTok 视频列表提示当前国家或地区不可用", "TikTok video feed region restriction"
				case "available":
					return "available", region, "TikTok 返回公开视频列表", "TikTok public video feed"
				}
			}
		}
	case "spotify", "bahamut", "abema":
		if region != "" {
			return "available", region, "平台入口可访问，已识别当前访客地区", "platform visitor country"
		}
	default:
		return
	}
	return "unknown", region, "平台入口可访问，但缺少确认开放状态的字段", "no affirmative platform signal"
}

func streamUnlockTikTokFeedState(body string) string {
	type item struct {
		ID    string `json:"id"`
		Video struct {
			Duration int `json:"duration"`
		} `json:"video"`
	}
	var data struct {
		Scope struct {
			Feed json.RawMessage `json:"webapp.recommend-feed"`
		} `json:"__DEFAULT_SCOPE__"`
	}
	script := streamUnlockScript(body, "__UNIVERSAL_DATA_FOR_REHYDRATION__")
	if json.Unmarshal([]byte(script), &data) != nil || len(data.Scope.Feed) == 0 {
		return "unknown"
	}
	if state, _, _ := streamUnlockAvailabilityState(http.StatusOK, string(data.Scope.Feed), ""); state == "blocked" {
		return state
	}
	var feed struct {
		StatusCode int    `json:"statusCode"`
		ItemList   []item `json:"itemList"`
		Items      []item `json:"items"`
	}
	if json.Unmarshal(data.Scope.Feed, &feed) != nil || feed.StatusCode != 0 {
		return "unknown"
	}
	for _, items := range [][]item{feed.ItemList, feed.Items} {
		for _, video := range items {
			if video.ID != "" && video.Video.Duration > 0 {
				return "available"
			}
		}
	}
	return "unknown"
}

const streamUnlockNetflixLicensedTitle = "https://www.netflix.com/title/70143836"

func streamUnlockProbeNetflix(ctx context.Context, client *http.Client, provider streamUnlockProvider, family string) streamUnlockProviderResult {
	originalResult := make(chan streamUnlockProviderResult, 1)
	go func(original streamUnlockProvider) {
		originalResult <- streamUnlockProbePage(ctx, client, original, family)
	}(provider)
	provider.url = streamUnlockNetflixLicensedTitle
	licensed := streamUnlockProbePage(ctx, client, provider, family)
	original := <-originalResult
	return streamUnlockNetflixResult(original, licensed)
}

func streamUnlockNetflixResult(original, licensed streamUnlockProviderResult) streamUnlockProviderResult {
	licensedStatus := licensed.Status
	if licensed.Region == "" {
		licensed.Region = original.Region
	}
	switch {
	case licensed.Status == "available":
		licensed.Detail = "Netflix 确认测试的第三方片目可用"
	case licensed.Status == "blocked" && original.Status == "available":
		licensed.Status = "partial"
		licensed.Detail = "测试的 Netflix 自制片可用，第三方片目不可用"
	case licensed.Status == "blocked" && original.Status == "blocked":
		licensed.Detail = "Netflix 自制与第三方测试片目均不可用"
	case licensed.Status == "error" && original.Status == "error":
	default:
		licensed.Status = "unknown"
		licensed.Detail = "Netflix 未返回足够的片目可用性证据"
	}
	licensed.Evidence = "Netflix original: " + original.Status + "; licensed: " + licensedStatus + " (" + licensed.Evidence + ")"
	return licensed
}
