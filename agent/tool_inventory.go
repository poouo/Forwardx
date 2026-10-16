package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Discovery only: no version subprocesses, downloads or service restarts on
// the heartbeat path. Match the fallback paths used by the panel's apply code.
func discoverForwardTools(lookup func(string) (string, error), executable func(string) bool, platform string) map[string]bool {
	anyExecutable := func(paths ...string) bool {
		for _, path := range paths {
			if executable(path) {
				return true
			}
		}
		return false
	}
	command := func(name string) bool { path, err := lookup(name); return err == nil && executable(path) }
	linux := platform == "linux"
	return map[string]bool{
		"iptables": linux && command("iptables"),
		"nftables": linux && command("nft"),
		"realm":    linux && executable("/usr/local/bin/realm"),
		"socat":    linux && executable("/usr/bin/socat"),
		"gost":     linux && (anyExecutable("/usr/local/bin/forwardx-runtime", "/usr/local/bin/gost") || command("gost")),
		"nginx":    linux && (anyExecutable("/usr/local/bin/forwardx-nginx", "/usr/sbin/nginx", "/usr/local/nginx/sbin/nginx") || command("nginx")),
	}
}

var forwardToolInventoryCache struct {
	sync.Mutex
	tools     map[string]bool
	checkedAt time.Time
}

func forwardToolInventory() (map[string]bool, int64) {
	forwardToolInventoryCache.Lock()
	defer forwardToolInventoryCache.Unlock()
	if forwardToolInventoryCache.tools == nil || time.Since(forwardToolInventoryCache.checkedAt) >= 30*time.Second {
		tools := discoverForwardTools(exec.LookPath, func(path string) bool {
			info, err := os.Stat(path)
			return err == nil && !info.IsDir() && info.Mode()&0111 != 0
		}, runtime.GOOS)
		if fmt.Sprint(tools) != fmt.Sprint(forwardToolInventoryCache.tools) {
			available, missing := []string{}, []string{}
			for tool, found := range tools {
				if found {
					available = append(available, tool)
				} else {
					missing = append(missing, tool)
				}
			}
			sort.Strings(available)
			sort.Strings(missing)
			logf("forward tool inventory available=%s missing=%s platform=%s; executable discovery only", strings.Join(available, ","), strings.Join(missing, ","), runtime.GOOS)
		}
		forwardToolInventoryCache.tools = tools
		forwardToolInventoryCache.checkedAt = time.Now()
	}
	copy := map[string]bool{}
	for key, value := range forwardToolInventoryCache.tools {
		copy[key] = value
	}
	return copy, forwardToolInventoryCache.checkedAt.UnixMilli()
}
