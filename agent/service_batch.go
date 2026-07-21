package main

import (
	"strings"
	"sync"
	"time"
)

const (
	managedServiceBatchWindow    = 20 * time.Millisecond
	managedServiceBatchSize      = 128
	managedServiceCommandTimeout = 90 * time.Second
	managedServiceActivityTTL    = 5 * time.Second
)

type managedServiceStartRequest struct {
	name             string
	changed          bool
	signatureMatches bool
	result           chan bool
}

type managedServiceBatchExecutor func([]managedServiceStartRequest) []bool

type managedServiceBatcher struct {
	once     sync.Once
	queue    chan managedServiceStartRequest
	window   time.Duration
	maxBatch int
	execute  managedServiceBatchExecutor
}

var systemdManagedServiceBatcher = newManagedServiceBatcher(
	managedServiceBatchWindow,
	managedServiceBatchSize,
	executeSystemdManagedServiceBatch,
)

func newManagedServiceBatcher(window time.Duration, maxBatch int, execute managedServiceBatchExecutor) *managedServiceBatcher {
	if window <= 0 {
		window = time.Millisecond
	}
	if maxBatch <= 0 {
		maxBatch = 1
	}
	return &managedServiceBatcher{
		queue:    make(chan managedServiceStartRequest, actionQueueCapacity),
		window:   window,
		maxBatch: maxBatch,
		execute:  execute,
	}
}

func (b *managedServiceBatcher) submit(name string, changed bool, signatureMatches bool) bool {
	if b == nil || b.execute == nil {
		return false
	}
	b.once.Do(func() { go b.loop() })
	result := make(chan bool, 1)
	b.queue <- managedServiceStartRequest{
		name:             name,
		changed:          changed,
		signatureMatches: signatureMatches,
		result:           result,
	}
	return <-result
}

func (b *managedServiceBatcher) loop() {
	for first := range b.queue {
		batch := []managedServiceStartRequest{first}
		timer := time.NewTimer(b.window)
	collect:
		for len(batch) < b.maxBatch {
			select {
			case request := <-b.queue:
				batch = append(batch, request)
			case <-timer.C:
				break collect
			}
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		results := b.execute(batch)
		for index, request := range batch {
			ok := index < len(results) && results[index]
			request.result <- ok
		}
	}
}

type systemdManagedServiceItem struct {
	name       string
	changed    bool
	canSkip    bool
	requestIDs []int
}

func executeSystemdManagedServiceBatch(requests []managedServiceStartRequest) []bool {
	results := make([]bool, len(requests))
	if len(requests) == 0 {
		return results
	}
	itemsByName := map[string]*systemdManagedServiceItem{}
	items := make([]*systemdManagedServiceItem, 0, len(requests))
	for index, request := range requests {
		name := sanitizeServiceName(request.name)
		if name == "" {
			continue
		}
		item := itemsByName[name]
		if item == nil {
			item = &systemdManagedServiceItem{name: name, canSkip: true}
			itemsByName[name] = item
			items = append(items, item)
		}
		item.changed = item.changed || request.changed
		item.canSkip = item.canSkip && !request.changed && request.signatureMatches
		item.requestIDs = append(item.requestIDs, index)
	}
	if len(items) == 0 {
		return results
	}

	reloadNeeded := false
	for _, item := range items {
		reloadNeeded = reloadNeeded || item.changed
	}
	reloadOK := true
	if reloadNeeded {
		reloadOK = runManagedServiceCommand("systemctl", "daemon-reload")
	}

	checkNames := make([]string, 0, len(items))
	for _, item := range items {
		if item.canSkip {
			checkNames = append(checkNames, item.name)
		}
	}
	active := systemdServicesActive(checkNames)
	restartItems := make([]*systemdManagedServiceItem, 0, len(items))
	for _, item := range items {
		if item.changed && !reloadOK {
			continue
		}
		if item.canSkip && active[item.name] {
			for _, index := range item.requestIDs {
				results[index] = true
			}
			continue
		}
		restartItems = append(restartItems, item)
	}
	if len(restartItems) == 0 {
		return results
	}

	unitNames := make([]string, 0, len(restartItems))
	for _, item := range restartItems {
		unitNames = append(unitNames, item.name+".service")
	}
	_ = runManagedServiceCommand("systemctl", append([]string{"reset-failed"}, unitNames...)...)
	enableOK := runManagedServiceCommand("systemctl", append([]string{"enable"}, unitNames...)...)
	restartOK := enableOK && runManagedServiceCommand("systemctl", append([]string{"restart"}, unitNames...)...)
	if restartOK {
		for _, item := range restartItems {
			for _, index := range item.requestIDs {
				results[index] = true
			}
		}
		if len(restartItems) > 1 {
			logf("managed services started batch=%d reload=%v", len(restartItems), reloadNeeded)
		}
		return results
	}

	// A single malformed unit must not hide which other services started. The
	// slower per-service fallback is used only after the normal batch path fails.
	for _, item := range restartItems {
		unit := item.name + ".service"
		ok := runManagedServiceCommand("systemctl", "enable", unit) &&
			runManagedServiceCommand("systemctl", "restart", unit)
		for _, index := range item.requestIDs {
			results[index] = ok
		}
	}
	return results
}

func systemdServicesActive(names []string) map[string]bool {
	active := make(map[string]bool, len(names))
	if len(names) == 0 {
		return active
	}
	args := make([]string, 0, len(names)+1)
	args = append(args, "is-active")
	for _, name := range names {
		args = append(args, name+".service")
	}
	out, _ := commandCombinedOutputWithTimeout(10*time.Second, "systemctl", args...)
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for index, name := range names {
		if index < len(lines) {
			active[name] = strings.TrimSpace(lines[index]) == "active"
		}
	}
	return active
}

func runManagedServiceCommand(name string, args ...string) bool {
	started := time.Now()
	out, err := commandCombinedOutputWithTimeout(managedServiceCommandTimeout, name, args...)
	elapsed := time.Since(started)
	if err != nil {
		logf("managed service command failed duration=%s command=%s error=%v output=%s", elapsed.Round(time.Millisecond), name+" "+strings.Join(args, " "), err, compactLogOutput(string(out)))
		return false
	}
	if elapsed >= actionShellSlowThreshold {
		logf("managed service command slow duration=%s command=%s", elapsed.Round(time.Millisecond), name+" "+strings.Join(args, " "))
	}
	return true
}

type managedServiceActivityEntry struct {
	active    bool
	checkedAt time.Time
}

var managedServiceActivityMu sync.Mutex
var managedServiceActivityCache = map[string]managedServiceActivityEntry{}

func cacheManagedServiceActivity(name string, active bool) {
	name = sanitizeServiceName(name)
	if name == "" {
		return
	}
	managedServiceActivityMu.Lock()
	managedServiceActivityCache[name] = managedServiceActivityEntry{active: active, checkedAt: time.Now()}
	managedServiceActivityMu.Unlock()
}

func cachedManagedServiceActivity(name string) (bool, bool) {
	name = sanitizeServiceName(name)
	managedServiceActivityMu.Lock()
	entry, ok := managedServiceActivityCache[name]
	if ok && time.Since(entry.checkedAt) >= managedServiceActivityTTL {
		delete(managedServiceActivityCache, name)
		ok = false
	}
	managedServiceActivityMu.Unlock()
	return entry.active, ok
}
