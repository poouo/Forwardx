package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"
)

const gostAdditiveSyncMarker = "# forwardx-gost-additive-sync "
const gostAPIDir = "/run/forwardx-agent/gost-api"

var gostObjectNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)

type gostAPIClient struct {
	client  *http.Client
	baseURL string
}

type gostAPIError struct{ status, code int }

func (e *gostAPIError) Error() string {
	return fmt.Sprintf("GOST API HTTP=%d code=%d", e.status, e.code)
}

// The response body can contain credentials/target addresses in upstream
// parser errors. Never include it in logs or status messages.
func (api gostAPIClient) request(ctx context.Context, method, path string, object any) ([]byte, error) {
	var body io.Reader
	if object != nil {
		data, err := json.Marshal(object)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, api.baseURL+"/config"+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := api.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GOST local API unavailable: %w", err)
	}
	defer resp.Body.Close()
	const responseLimit = 16 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > responseLimit {
		return nil, fmt.Errorf("GOST API response exceeds limit")
	}
	var envelope struct {
		Code int `json:"code"`
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = json.Unmarshal(data, &envelope)
		return nil, &gostAPIError{resp.StatusCode, envelope.Code}
	}
	if method != http.MethodGet {
		if err := json.Unmarshal(data, &envelope); err != nil {
			return nil, fmt.Errorf("invalid GOST API acknowledgement")
		}
		if envelope.Code != 0 {
			return nil, &gostAPIError{resp.StatusCode, envelope.Code}
		}
	}
	return data, nil
}

func localGostAPI(socket string) (gostAPIClient, func()) {
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socket)
		},
	}
	return gostAPIClient{&http.Client{Transport: transport, Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, "http://localhost"}, transport.CloseIdleConnections
}

type gostAddition struct {
	collection, name string
	object           map[string]any
}

// GOST serializes omitted optional fields as empty/default values and adds a
// live service status. Those must not turn an unchanged listener into an edit.
func normalizedGostValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, item := range v {
			// Metadata is an untyped map: explicit false/zero can be meaningful
			// and must not be treated like omitted Go struct defaults.
			if key == "metadata" {
				if metadata, ok := item.(map[string]any); ok && len(metadata) > 0 {
					out[key] = metadata
				} else if item != nil && !ok {
					out[key] = item
				}
				continue
			}
			// GOST loads duration strings from JSON through Viper, but its API
			// returns Go time.Duration as nanoseconds. Compare those semantically.
			switch key {
			case "failTimeout", "timeout", "reload", "ttl", "validity":
				if text, ok := item.(string); ok {
					if duration, err := time.ParseDuration(text); err == nil {
						item = float64(duration)
					}
				}
				if number, ok := item.(float64); ok && number == 0 {
					continue
				}
			case "maxFails":
				if number, ok := item.(float64); ok && number == 0 {
					continue
				}
			}
			if normalized := normalizedGostValue(item); normalized != nil {
				out[key] = normalized
			}
		}
		if len(out) == 0 {
			return nil
		}
		return out
	case []any:
		if len(v) == 0 {
			return nil
		}
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = normalizedGostValue(item)
		}
		return out
	case nil:
		return nil
	case string:
		if v == "" {
			return nil
		}
	}
	return value
}

func gostObjects(config map[string]any, collection string) (map[string]map[string]any, error) {
	result := map[string]map[string]any{}
	if config[collection] == nil {
		return result, nil
	}
	items, ok := config[collection].([]any)
	if !ok {
		return nil, fmt.Errorf("invalid GOST %s list", collection)
	}
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("invalid GOST %s object", collection)
		}
		name, _ := object["name"].(string)
		if !gostObjectNamePattern.MatchString(name) || result[name] != nil {
			return nil, fmt.Errorf("invalid or duplicate GOST %s name", collection)
		}
		// Do not mutate either input snapshot.
		copy := map[string]any{}
		for key, value := range object {
			if collection != "services" || key != "status" {
				copy[key] = value
			}
		}
		if collection == "services" {
			// ForwardNodeConfig in bundled GOST 3.2.6 does not carry the
			// redundant TCP/UDP connector/dialer hints emitted by the panel.
			// The service handler determines these lanes. The live API drops
			// these hints; do not mistake that for an existing-rule edit.
			if forwarder, ok := copy["forwarder"].(map[string]any); ok {
				f := map[string]any{}
				for key, value := range forwarder {
					f[key] = value
				}
				if nodes, ok := forwarder["nodes"].([]any); ok {
					filtered := make([]any, len(nodes))
					for i, raw := range nodes {
						node, ok := raw.(map[string]any)
						if !ok {
							filtered[i] = raw
							continue
						}
						n := map[string]any{}
						for key, value := range node {
							if key == "connector" || key == "dialer" {
								if hint, ok := value.(map[string]any); ok && len(hint) == 1 && (hint["type"] == "tcp" || hint["type"] == "udp") {
									continue
								}
							}
							n[key] = value
						}
						filtered[i] = n
					}
					f["nodes"] = filtered
				}
				copy["forwarder"] = f
			}
		}
		result[name] = copy
	}
	return result, nil
}

// Only additive changes are eligible: edits/removals keep the established
// restart/rollback path. In particular a changed shared limiter cannot silently
// be ignored merely because all listener names are unchanged.
func planGostAdditions(live, desired map[string]any) ([]gostAddition, string, error) {
	if services, ok := live["services"].([]any); ok {
		for _, item := range services {
			service, _ := item.(map[string]any)
			status, _ := service["status"].(map[string]any)
			if state, _ := status["state"].(string); state == "closed" || state == "failed" {
				return nil, "unhealthy-listener", nil
			}
		}
	}
	for key, value := range live {
		if key == "services" || key == "chains" || key == "limiters" || key == "api" {
			continue
		}
		if !reflect.DeepEqual(normalizedGostValue(value), normalizedGostValue(desired[key])) {
			return nil, "global-config-changed", nil
		}
	}
	for key, value := range desired {
		if key == "services" || key == "chains" || key == "limiters" || key == "api" {
			continue
		}
		if !reflect.DeepEqual(normalizedGostValue(value), normalizedGostValue(live[key])) {
			return nil, "global-config-changed", nil
		}
	}
	var additions []gostAddition
	for _, collection := range []string{"limiters", "chains", "services"} {
		old, err := gostObjects(live, collection)
		if err != nil {
			return nil, "", err
		}
		next, err := gostObjects(desired, collection)
		if err != nil {
			return nil, "", err
		}
		for name, object := range old {
			if next[name] == nil {
				return nil, collection + "-removed", nil
			}
			if !reflect.DeepEqual(normalizedGostValue(object), normalizedGostValue(next[name])) {
				return nil, collection + "-changed", nil
			}
		}
		names := make([]string, 0)
		for name := range next {
			if old[name] == nil {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		for _, name := range names {
			additions = append(additions, gostAddition{collection, name, next[name]})
		}
	}
	return additions, "", nil
}

func applyGostAdditions(ctx context.Context, api gostAPIClient, additions []gostAddition, setRestore func(func() bool)) error {
	// Include the attempted object before issuing POST: a lost response may hide
	// a successful creation. DELETE-not-found is harmless during rollback.
	attempted := []gostAddition{}
	setRestore(func() bool {
		defer api.client.CloseIdleConnections()
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ok := true
		for i := len(attempted) - 1; i >= 0; i-- {
			item := attempted[i]
			_, err := api.request(rollbackCtx, http.MethodDelete, "/"+item.collection+"/"+item.name, nil)
			if apiErr, yes := err.(*gostAPIError); yes && apiErr.code == 40004 {
				err = nil
			}
			if err != nil {
				ok = false
				logf("gost additive rollback failed collection=%s name=%s error=%v", item.collection, item.name, err)
			}
		}
		if len(attempted) > 0 {
			logf("gost additive rollback complete objects=%d ok=%v; existing listeners preserved", len(attempted), ok)
		}
		return ok
	})
	for _, item := range additions {
		attempted = append(attempted, item)
		if _, err := api.request(ctx, http.MethodPost, "/"+item.collection, item.object); err != nil {
			if apiErr, ok := err.(*gostAPIError); ok && apiErr.code == 40002 {
				// Another root operator may have added it after our snapshot. It is
				// not owned by this transaction and must not be deleted on rollback.
				attempted = attempted[:len(attempted)-1]
			}
			return fmt.Errorf("add %s/%s: %w", item.collection, item.name, err)
		}
	}
	return nil
}

func gostAPISocket(config map[string]any) string {
	api, _ := config["api"].(map[string]any)
	addr, _ := api["addr"].(string)
	if !strings.HasPrefix(addr, "unix://") {
		return ""
	}
	return strings.TrimPrefix(addr, "unix://")
}

// Both main and tunnel configs belong to one transaction. Protect eligible
// running processes before executing any shell command, so an earlier failure
// cannot restart the untouched second runtime during transaction rollback.
func protectGostRuntimeRollback(tx *managedConfigTransaction) {
	if tx == nil {
		return
	}
	for _, backup := range tx.backups {
		service := backup.spec.ServiceName
		if !((service == runtimeServiceName && backup.spec.Path == runtimeConfigPath) ||
			(service == tunnelRuntimeServiceName && backup.spec.Path == tunnelRuntimeConfigPath)) {
			continue
		}
		var previous, desired map[string]any
		data, err := os.ReadFile(backup.spec.Path)
		if err != nil {
			continue
		}
		if json.Unmarshal(backup.previous, &previous) != nil || json.Unmarshal(data, &desired) != nil {
			continue
		}
		socket := gostAPIDir + "/" + service + ".sock"
		services, _ := desired["services"].([]any)
		if len(services) > 0 && gostAPISocket(previous) == socket && gostAPISocket(desired) == socket && managedServiceActive(service) {
			tx.setRuntimeRestore(backup.spec.Path, func() bool { return true })
		}
	}
}

// handled=false permits the legacy shell restart only for initial bootstrap,
// a stopped process, or intentional edits/removals. A failed incremental add
// must never fall back to restarting a healthy shared process.
func tryGostAdditiveSync(service, path string, tx *managedConfigTransaction) (handled bool, err error) {
	var backup *managedConfigBackup
	if tx != nil {
		for i := range tx.backups {
			if tx.backups[i].spec.Path == path && tx.backups[i].spec.ServiceName == service {
				backup = &tx.backups[i]
				break
			}
		}
	}
	if backup == nil {
		return true, fmt.Errorf("GOST sync missing managed config transaction")
	}
	var desired, previous map[string]any
	data, err := os.ReadFile(path)
	if err != nil {
		return true, err
	}
	if err := json.Unmarshal(data, &desired); err != nil {
		return true, err
	}
	socket := gostAPIDir + "/" + service + ".sock"
	if gostAPISocket(desired) != socket {
		return true, fmt.Errorf("GOST sync requires private Unix API")
	}
	_ = json.Unmarshal(backup.previous, &previous)
	if !backup.hadPrevious || gostAPISocket(previous) != socket || !managedServiceActive(service) {
		logf("gost runtime bootstrap/recovery requires restart service=%s", service)
		return false, nil
	}
	// Even if the API is unavailable, restoring a config file must not restart
	// this already-running process and disconnect otherwise healthy rules.
	tx.setRuntimeRestore(path, func() bool { return true })
	api, closeIdle := localGostAPI(socket)
	// Rollback executes after this function returns, so its own client must
	// remain usable. Closing idle connections does not disable the transport.
	defer closeIdle()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	liveData, err := api.request(ctx, http.MethodGet, "", nil)
	if err != nil {
		return true, err
	}
	var live map[string]any
	if err := json.Unmarshal(liveData, &live); err != nil {
		return true, fmt.Errorf("invalid GOST live config")
	}
	additions, reason, err := planGostAdditions(live, desired)
	if err != nil {
		return true, err
	}
	if reason != "" {
		// The on-disk hash can be unchanged despite drift in the live API
		// state (e.g. an interrupted earlier sync). Ensure recovery really
		// restarts rather than letting the shell's hash check skip it.
		if err := os.Remove(path + ".sha256"); err != nil && !os.IsNotExist(err) {
			return true, err
		}
		tx.setRuntimeRestore(path, nil)
		logf("gost runtime non-additive update requires restart service=%s reason=%s", service, reason)
		return false, nil
	}
	if err := applyGostAdditions(ctx, api, additions, func(restore func() bool) { tx.setRuntimeRestore(path, restore) }); err != nil {
		return true, err
	}
	hash := sha256.Sum256(data)
	if err := writeManagedConfigAtomic(path+".sha256", []byte(fmt.Sprintf("sha256:%x", hash)), 0644); err != nil {
		return true, err
	}
	if len(additions) > 0 {
		logf("gost runtime additive sync service=%s objectsAdded=%d; existing listeners preserved", service, len(additions))
	}
	return true, nil
}

func runGostAdditiveSyncCommands(commands []string, tx *managedConfigTransaction, message *actionMessage) bool {
	var pending []string
	flush := func() bool { ok := runShellBatch(pending); pending = nil; return ok }
	for _, command := range commands {
		if !strings.HasPrefix(command, gostAdditiveSyncMarker) {
			pending = append(pending, command)
			continue
		}
		if !flush() {
			return false
		}
		line, fallback, found := strings.Cut(command, "\n")
		fields := strings.Fields(strings.TrimPrefix(line, gostAdditiveSyncMarker))
		if !found || len(fields) != 2 || !((fields[0] == runtimeServiceName && fields[1] == runtimeConfigPath) || (fields[0] == tunnelRuntimeServiceName && fields[1] == tunnelRuntimeConfigPath)) {
			message.set("invalid GOST incremental sync marker")
			return false
		}
		handled, err := tryGostAdditiveSync(fields[0], fields[1], tx)
		if err != nil {
			message.set("GOST incremental sync failed service=%s: %v", fields[0], err)
			logf("gost additive sync failed service=%s error=%v; refusing shared restart", fields[0], err)
			return false
		}
		if !handled && !runShell(fallback) {
			return false
		}
	}
	return flush()
}
