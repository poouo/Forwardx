package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const streamUnlockProbeVersion = "1"
const streamUnlockRequestTimeout = 8 * time.Second

// Region bootstrap data can occur near the end of large platform pages.
const streamUnlockResponseLimit = 2 * 1024 * 1024

type streamUnlockTask struct {
	TaskID      string   `json:"taskId"`
	Family      string   `json:"family"`
	ProviderIDs []string `json:"providerIds"`
	CreatedAt   string   `json:"createdAt"`
}

type streamUnlockProviderResult struct {
	ProviderID   string `json:"providerId"`
	ProviderName string `json:"providerName"`
	Family       string `json:"family,omitempty"`
	Status       string `json:"status"`
	Region       string `json:"region,omitempty"`
	HTTPStatus   int    `json:"httpStatus,omitempty"`
	LatencyMs    int64  `json:"latencyMs,omitempty"`
	Detail       string `json:"detail,omitempty"`
	Evidence     string `json:"evidence,omitempty"`
	CheckedAt    string `json:"checkedAt,omitempty"`
}

type streamUnlockDNSResult struct {
	Domain          string   `json:"domain"`
	Family          string   `json:"family"`
	Mode            string   `json:"mode"`
	SystemAddresses []string `json:"systemAddresses"`
	PublicAddresses []string `json:"publicAddresses"`
	SystemCnames    []string `json:"systemCnames,omitempty"`
	PublicCnames    []string `json:"publicCnames,omitempty"`
	Detail          string   `json:"detail,omitempty"`
	CheckedAt       string   `json:"checkedAt,omitempty"`
}

type streamUnlockResult struct {
	TaskID       string                       `json:"taskId"`
	ProbeVersion string                       `json:"probeVersion"`
	Family       string                       `json:"family"`
	ExitIPv4     string                       `json:"exitIPv4,omitempty"`
	ExitIPv6     string                       `json:"exitIPv6,omitempty"`
	Providers    []streamUnlockProviderResult `json:"providers"`
	DNS          []streamUnlockDNSResult      `json:"dns"`
	StartedAt    string                       `json:"startedAt"`
	FinishedAt   string                       `json:"finishedAt"`
	Error        string                       `json:"error,omitempty"`
}

type streamUnlockProvider struct {
	id     string
	name   string
	domain string
	url    string
	parse  func(status int, body, effectiveURL string) (state, region, detail, evidence string)
}

func streamUnlockState(status int, body string) (state, detail string) {
	if status <= 0 {
		return "error", "网络连接失败或超时"
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return "blocked", fmt.Sprintf("HTTP %d", status)
	}
	if status >= 500 {
		return "error", fmt.Sprintf("HTTP %d", status)
	}
	if status < 200 || status >= 400 {
		return "unknown", fmt.Sprintf("HTTP %d", status)
	}
	return "available", "公开接口可访问"
}

func streamUnlockAvailabilityState(status int, body, effectiveURL string) (state, detail, evidence string) {
	if status <= 0 {
		return "error", "网络连接失败或超时", "no response"
	}
	if status >= 500 {
		return "error", fmt.Sprintf("服务入口返回 HTTP %d", status), fmt.Sprintf("HTTP %d", status)
	}

	response := streamUnlockRestrictionText(body, effectiveURL)
	for _, marker := range []string{
		"unsupported_country",
		"unsupported_country_region_territory",
		"country_not_supported",
		"region_not_supported",
		"region_unavailable",
		"app-unavailable-in-region",
		"app unavailable in region",
		"isn't available in your region",
		"isn’t available in your region",
		"isn't available in your country",
		"isn’t available in your country",
		"not available in your country",
		"not available in your region",
		"not available in your location",
		"not currently available in your country",
		"not currently available in your region",
		"not supported in your country",
		"not supported in your region",
		"not supported in your location",
		"not offered in your country",
		"services are not available in your country",
		"your region is not supported",
		"country or region is not supported",
		"service is unavailable in your country",
		"service unavailable in your region",
		"unavailable in your area",
		"当前所在国家或地区不可用",
		"不支持您所在的国家/地区",
		"您所在的国家或地区不可用",
		"所在国家或地区暂不支持",
		"您所在地区不可用",
	} {
		if strings.Contains(response, marker) {
			return "blocked", "服务入口提示当前国家或地区不可用", "explicit region restriction"
		}
	}
	if status == http.StatusUnavailableForLegalReasons {
		return "blocked", "服务因地区或法律限制不可用", "HTTP 451"
	}
	if status == http.StatusForbidden {
		return "unknown", "服务入口拒绝访问，无法确认是否为地区限制", "HTTP 403"
	}
	if status >= 400 && status != http.StatusUnauthorized {
		return "unknown", fmt.Sprintf("服务入口返回 HTTP %d，无法确认开放状态", status), fmt.Sprintf("HTTP %d", status)
	}
	return "available", "服务入口可访问；实际账号登录需用户自行验证", "login entry accessible"
}

func streamUnlockProviders() map[string]streamUnlockProvider {
	parseGeneric := func(providerID string) func(int, string, string) (string, string, string, string) {
		return func(status int, body, effectiveURL string) (string, string, string, string) {
			state, detail := streamUnlockState(status, body)
			return state, streamUnlockProviderRegion(providerID, body), detail, "HTTP status; platform visitor region"
		}
	}
	parseNetflix := func(status int, body, effectiveURL string) (string, string, string, string) {
		state, detail := streamUnlockState(status, body)
		region := streamUnlockProviderRegion("netflix", body)
		if state == "available" && strings.Contains(strings.ToLower(body), "oh no!") {
			return "partial", region, "仅检测到 Netflix Original 或地区内容受限", "页面包含 Oh no!"
		}
		return state, strings.ToUpper(region), detail, "Netflix title page"
	}
	parseBahamut := func(status int, body, effectiveURL string) (string, string, string, string) {
		state, detail := streamUnlockState(status, body)
		region := streamUnlockProviderRegion("bahamut", body)
		if state == "available" && region == "" {
			return "unknown", "", "接口可访问但未返回地区字段", "Bahamut page"
		}
		return state, region, detail, "Bahamut data-geo"
	}
	parseAbema := func(status int, body, effectiveURL string) (string, string, string, string) {
		state, detail := streamUnlockState(status, body)
		region := streamUnlockProviderRegion("abema", body)
		if state == "available" && region == "" {
			return "unknown", "", "接口可访问但未返回地区字段", "Abema ip/check"
		}
		return state, region, detail, "Abema isoCountryCode"
	}
	parseAvailability := func(providerID string) func(int, string, string) (string, string, string, string) {
		return func(status int, body, effectiveURL string) (string, string, string, string) {
			state, detail, evidence := streamUnlockAIPageState(providerID, status, body, effectiveURL)
			return state, streamUnlockProviderRegion(providerID, body), detail, evidence
		}
	}
	return map[string]streamUnlockProvider{
		"netflix":     {"netflix", "Netflix", "netflix.com", "https://www.netflix.com/title/81280792", parseNetflix},
		"disney-plus": {"disney-plus", "Disney+", "disneyplus.com", "https://www.disneyplus.com/", parseGeneric("disney-plus")},
		"youtube":     {"youtube", "YouTube", "youtube.com", "https://www.youtube.com/premium", parseGeneric("youtube")},
		"spotify":     {"spotify", "Spotify", "spotify.com", "https://open.spotify.com/", parseGeneric("spotify")},
		"bilibili-tv": {"bilibili-tv", "Bilibili TV", "bilibili.tv", "https://www.bilibili.tv/", parseGeneric("bilibili-tv")},
		"bahamut":     {"bahamut", "巴哈姆特动画疯", "ani.gamer.com.tw", "https://ani.gamer.com.tw/", parseBahamut},
		"abema":       {"abema", "AbemaTV", "api.abema.io", "https://api.abema.io/v1/ip/check?device=android", parseAbema},
		"tiktok":      {"tiktok", "TikTok", "", "https://www.tiktok.com/", parseAvailability("tiktok")},
		"gemini":      {"gemini", "Gemini", "", "https://gemini.google.com/app", parseAvailability("gemini")},
		"grok":        {"grok", "Grok", "", "https://grok.com/", parseAvailability("grok")},
		"chatgpt":     {"chatgpt", "ChatGPT", "", "https://chatgpt.com/auth/login", parseAvailability("chatgpt")},
		"claude":      {"claude", "Claude", "", "https://claude.ai/login", parseAvailability("claude")},
	}
}

func streamUnlockRegex(value, pattern string) string {
	match := regexp.MustCompile(pattern).FindStringSubmatch(value)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func streamUnlockHTTPClient(family string) *http.Client {
	network := "tcp"
	if family == "ipv4" {
		network = "tcp4"
	} else if family == "ipv6" {
		network = "tcp6"
	}
	transport := &http.Transport{
		Proxy:             nil,
		ForceAttemptHTTP2: true,
		DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			return (&net.Dialer{Timeout: streamUnlockRequestTimeout}).DialContext(ctx, network, address)
		},
	}
	return &http.Client{Transport: transport, Timeout: streamUnlockRequestTimeout, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 {
			return http.ErrUseLastResponse
		}
		return nil
	}}
}

func streamUnlockHTTPGet(ctx context.Context, client *http.Client, rawURL string) (int, string, string, int64, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, "", "", 0, err
	}
	request.Header.Set("User-Agent", "ForwardX-Agent-StreamUnlock/"+streamUnlockProbeVersion)
	request.Header.Set("Accept", "application/json, text/html;q=0.8, */*;q=0.5")
	started := time.Now()
	response, err := client.Do(request)
	latency := time.Since(started).Milliseconds()
	if err != nil {
		return 0, "", "", latency, err
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, streamUnlockResponseLimit))
	if readErr != nil {
		return response.StatusCode, "", response.Request.URL.String(), latency, readErr
	}
	return response.StatusCode, string(body), response.Request.URL.String(), latency, nil
}

func streamUnlockProbeProvider(ctx context.Context, provider streamUnlockProvider, family string) streamUnlockProviderResult {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	client := streamUnlockHTTPClient(family)
	defer client.CloseIdleConnections()
	return streamUnlockProbeProviderWithClient(ctx, client, provider, family)
}

func streamUnlockProbeProviderWithClient(ctx context.Context, client *http.Client, provider streamUnlockProvider, family string) streamUnlockProviderResult {
	result := streamUnlockProviderResult{ProviderID: provider.id, ProviderName: provider.name, Family: family, Status: "error", CheckedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	status, body, effectiveURL, latency, err := streamUnlockHTTPGet(ctx, client, provider.url)
	result.HTTPStatus = status
	result.LatencyMs = latency
	if err != nil {
		result.Detail = err.Error()
		return result
	}
	result.Status, result.Region, result.Detail, result.Evidence = provider.parse(status, body, effectiveURL)
	streamUnlockProbeAIAvailability(ctx, client, provider.id, &result)
	if result.Region == "" {
		if region := streamUnlockAIRegion(ctx, client, provider.id, family); region != "" {
			result.Region = region
			result.Evidence += "; platform edge request country (not account entitlement)"
		}
	}
	return result
}

func streamUnlockRequestFamily(taskFamily string) []string {
	switch taskFamily {
	case "ipv4":
		return []string{"ipv4"}
	case "ipv6":
		return []string{"ipv6"}
	default:
		return []string{"ipv4", "ipv6"}
	}
}

func streamUnlockPublicIP(ctx context.Context, family string) string {
	endpoint := "https://api.ipify.org"
	if family == "ipv6" {
		endpoint = "https://api6.ipify.org"
	}
	status, body, _, _, err := streamUnlockHTTPGet(ctx, streamUnlockHTTPClient(family), endpoint)
	if err != nil || status < 200 || status >= 300 {
		return ""
	}
	address := strings.TrimSpace(body)
	parsed := net.ParseIP(address)
	if parsed == nil || (family == "ipv4" && parsed.To4() == nil) || (family == "ipv6" && parsed.To4() != nil) {
		return ""
	}
	return address
}

type streamUnlockDoHResponse struct {
	Answer []struct {
		Type int    `json:"type"`
		Data string `json:"data"`
	} `json:"Answer"`
}

func streamUnlockDNS(ctx context.Context, domain, family string) streamUnlockDNSResult {
	ctx, cancel := context.WithTimeout(ctx, streamUnlockRequestTimeout)
	defer cancel()
	result := streamUnlockDNSResult{Domain: domain, Family: family, Mode: "unknown", CheckedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	resolver := net.DefaultResolver
	systemAddresses, systemErr := resolver.LookupHost(ctx, domain)
	for _, address := range systemAddresses {
		parsed := net.ParseIP(address)
		if parsed == nil || (family == "ipv4" && parsed.To4() == nil) || (family == "ipv6" && parsed.To4() != nil) {
			continue
		}
		result.SystemAddresses = append(result.SystemAddresses, address)
	}
	if cname, err := resolver.LookupCNAME(ctx, domain); err == nil && cname != "" && !strings.EqualFold(cname, domain+".") {
		result.SystemCnames = []string{strings.TrimSuffix(cname, ".")}
	}
	dohURL := "https://cloudflare-dns.com/dns-query?name=" + url.QueryEscape(domain) + "&type="
	if family == "ipv6" {
		dohURL += "AAAA"
	} else {
		dohURL += "A"
	}
	status, body, _, _, dohErr := streamUnlockHTTPGet(ctx, streamUnlockHTTPClient(family), dohURL)
	if dohErr == nil && status >= 200 && status < 300 {
		var response streamUnlockDoHResponse
		if json.Unmarshal([]byte(body), &response) == nil {
			for _, answer := range response.Answer {
				parsed := net.ParseIP(strings.TrimSpace(answer.Data))
				if parsed == nil || (family == "ipv4" && parsed.To4() == nil) || (family == "ipv6" && parsed.To4() != nil) {
					continue
				}
				result.PublicAddresses = append(result.PublicAddresses, parsed.String())
			}
		}
	}
	result.SystemAddresses = uniqueSortedIPs(result.SystemAddresses)
	result.PublicAddresses = uniqueSortedIPs(result.PublicAddresses)
	if systemErr != nil && len(result.SystemAddresses) == 0 {
		result.Detail = "系统 DNS 查询失败"
		return result
	}
	if dohErr != nil || len(result.PublicAddresses) == 0 {
		result.Detail = "公共 DNS 对比查询失败"
		return result
	}
	if sameStringSet(result.SystemAddresses, result.PublicAddresses) {
		result.Mode = "public_dns"
		result.Detail = "系统 DNS 与公共 DNS 结果一致，未发现智能 DNS 特征"
	} else {
		result.Mode = "smart_dns_suspected"
		result.Detail = "系统 DNS 与公共 DNS 结果不同，可能存在智能 DNS 或解析分流"
	}
	return result
}

func uniqueSortedIPs(values []string) []string {
	set := map[string]bool{}
	for _, value := range values {
		if parsed := net.ParseIP(value); parsed != nil {
			set[parsed.String()] = true
		}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func streamUnlockResultCopy(result streamUnlockResult) streamUnlockResult {
	copyResult := result
	copyResult.Providers = append([]streamUnlockProviderResult(nil), result.Providers...)
	copyResult.DNS = append([]streamUnlockDNSResult(nil), result.DNS...)
	return copyResult
}

func reportStreamUnlockProgress(cfg Config, result streamUnlockResult) {
	if err := post(cfg, "/api/agent/stream-unlock-progress", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("stream-unlock-progress", err)
		} else {
			logf("stream unlock progress report failed task=%s: %v", result.TaskID, err)
		}
	}
}

func mergeStreamUnlockProviderResults(results []streamUnlockProviderResult) streamUnlockProviderResult {
	if len(results) == 0 {
		return streamUnlockProviderResult{Status: "unknown"}
	}
	merged := results[0]
	for _, candidate := range results[1:] {
		if candidate.Status == "available" || (candidate.Status == "partial" && merged.Status != "available") {
			merged.Status = candidate.Status
		}
		if merged.Region == "" {
			merged.Region = candidate.Region
		}
		if merged.HTTPStatus == 0 {
			merged.HTTPStatus = candidate.HTTPStatus
		}
		if merged.LatencyMs == 0 {
			merged.LatencyMs = candidate.LatencyMs
		}
		if merged.Detail == "" {
			merged.Detail = candidate.Detail
		}
		if merged.Evidence == "" {
			merged.Evidence = candidate.Evidence
		}
	}
	return merged
}

func runStreamUnlockTask(cfg Config, task streamUnlockTask) streamUnlockResult {
	started := time.Now()
	result := streamUnlockResult{TaskID: task.TaskID, ProbeVersion: streamUnlockProbeVersion, Family: task.Family, Providers: []streamUnlockProviderResult{}, DNS: []streamUnlockDNSResult{}, StartedAt: started.UTC().Format(time.RFC3339Nano)}
	providers := streamUnlockProviders()
	families := streamUnlockRequestFamily(task.Family)
	providerIDs := task.ProviderIDs
	if len(providerIDs) == 0 {
		providerIDs = []string{"netflix", "disney-plus", "youtube", "spotify", "bilibili-tv", "bahamut", "abema", "tiktok", "gemini", "grok", "chatgpt", "claude"}
	}
	var outputMu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, family := range families {
		family := family
		wg.Add(1)
		go func() {
			defer wg.Done()
			ip := streamUnlockPublicIP(context.Background(), family)
			var progress streamUnlockResult
			outputMu.Lock()
			if family == "ipv4" {
				result.ExitIPv4 = ip
			} else {
				result.ExitIPv6 = ip
			}
			progress = streamUnlockResultCopy(result)
			outputMu.Unlock()
			// Report the exit address as soon as it is known. This also lets the
			// panel show that the task has started before the first provider probe
			// finishes.
			reportStreamUnlockProgress(cfg, progress)
		}()
		for _, providerID := range providerIDs {
			provider, ok := providers[providerID]
			if !ok {
				continue
			}
			provider, family := provider, family
			wg.Add(1)
			go func() {
				defer wg.Done()
				sem <- struct{}{}
				probe := streamUnlockProbeProvider(context.Background(), provider, family)
				probe.Evidence = family + ":" + probe.Evidence
				var progress streamUnlockResult
				outputMu.Lock()
				result.Providers = append(result.Providers, probe)
				progress = streamUnlockResultCopy(result)
				outputMu.Unlock()
				reportStreamUnlockProgress(cfg, progress)
				<-sem
			}()
		}
		for _, providerID := range providerIDs {
			if provider, ok := providers[providerID]; ok && provider.domain != "" {
				wg.Add(1)
				go func(provider streamUnlockProvider, family string) {
					defer wg.Done()
					sem <- struct{}{}
					dns := streamUnlockDNS(context.Background(), provider.domain, family)
					outputMu.Lock()
					result.DNS = append(result.DNS, dns)
					progress := streamUnlockResultCopy(result)
					outputMu.Unlock()
					reportStreamUnlockProgress(cfg, progress)
					<-sem
				}(provider, family)
			}
		}
	}
	wg.Wait()
	sort.Slice(result.Providers, func(i, j int) bool { return result.Providers[i].ProviderID < result.Providers[j].ProviderID })
	sort.Slice(result.DNS, func(i, j int) bool { return result.DNS[i].Domain < result.DNS[j].Domain })
	result.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return result
}

func handleStreamUnlockTask(cfg Config, task streamUnlockTask) {
	result := runStreamUnlockTask(cfg, task)
	if err := post(cfg, "/api/agent/stream-unlock-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("stream-unlock-result", err)
		} else {
			logf("stream unlock result report failed task=%s: %v", task.TaskID, err)
		}
	}
}
