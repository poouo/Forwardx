package main

import "fmt"

func agentUpgradeProxySetup(path string) string {
	if path == "" {
		path = defaultConfigPath
	}
	return fmt.Sprintf(`proxy=$(jq -er 'if type == "object" and (.proxyUrl == null or (.proxyUrl | type == "string")) then (.proxyUrl // "") else error("invalid proxy config") end' %s) || { echo '[ERROR] Cannot read Agent proxy configuration; upgrade cancelled' >&2; exit 1; }; unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY no_proxy NO_PROXY; case "$proxy" in socks5://*) proxy="socks5h://${proxy#socks5://}";; esac; export FORWARDX_AGENT_PROXY="$proxy" http_proxy="$proxy" https_proxy="$proxy" all_proxy="$proxy" HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" ALL_PROXY="$proxy" no_proxy='' NO_PROXY=''; `, shellQuote(path))
}
