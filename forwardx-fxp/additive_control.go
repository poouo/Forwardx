package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"
)

// This root-only local endpoint deliberately supports additions only. Listener
// edits/removals continue through the Agent's existing replacement workflow.
type liveUDPTargets struct {
	mu      sync.RWMutex
	targets map[int]udpTarget
}

func (targets *liveUDPTargets) get(id int) (udpTarget, bool) {
	targets.mu.RLock()
	defer targets.mu.RUnlock()
	target, ok := targets.targets[id]
	return target, ok
}

func (targets *liveUDPTargets) set(values []udpTarget) {
	next := make(map[int]udpTarget, len(values))
	for _, target := range values {
		next[target.RuleID] = target
	}
	targets.mu.Lock()
	targets.targets = next
	targets.mu.Unlock()
}

func planFXPConfigAddition(old, next config) ([]config, error) {
	old, next = normalizeConfig(old), normalizeConfig(next)
	old.udpTargetsLive, next.udpTargetsLive = nil, nil
	if err := validateConfig(next); err != nil {
		return nil, err
	}
	if old.Role != next.Role || old.TunnelID != next.TunnelID {
		return nil, errors.New("runtime identity changed")
	}
	switch old.Role {
	case "entry-group":
		previous, desired := old.Entries, next.Entries
		old.Entries, next.Entries = nil, nil
		if !reflect.DeepEqual(old, next) {
			return nil, errors.New("group settings changed")
		}
		byID := make(map[int]config, len(desired))
		for _, entry := range desired {
			if _, exists := byID[entry.RuleID]; exists {
				return nil, errors.New("duplicate rule")
			}
			byID[entry.RuleID] = entry
		}
		for _, entry := range previous {
			value, ok := byID[entry.RuleID]
			if !ok || !reflect.DeepEqual(entry, value) {
				return nil, errors.New("existing entry changed or removed")
			}
			delete(byID, entry.RuleID)
		}
		var additions []config
		for _, entry := range desired {
			if _, ok := byID[entry.RuleID]; ok {
				additions = append(additions, entry)
			}
		}
		return additions, nil
	case "exit":
		previous, desired := old.UDPTargets, next.UDPTargets
		old.UDPTargets, next.UDPTargets = nil, nil
		if !reflect.DeepEqual(old, next) {
			return nil, errors.New("exit settings changed")
		}
		byID := make(map[int]udpTarget, len(desired))
		for _, target := range desired {
			byID[target.RuleID] = target
		}
		for _, target := range previous {
			if byID[target.RuleID] != target {
				return nil, errors.New("existing UDP target changed or removed")
			}
		}
		return nil, nil
	default:
		return nil, errors.New("runtime does not support additions")
	}
}

type additiveFXPRuntime struct {
	mu       sync.Mutex
	cfg      config
	done     <-chan struct{}
	runtimes []*entryRuntime
	current  map[int]*entryRuntime
	wg       sync.WaitGroup
	closed   bool
}

func newAdditiveFXPRuntime(done <-chan struct{}, cfg config) (*additiveFXPRuntime, error) {
	cfg = normalizeConfig(cfg)
	runtime := &additiveFXPRuntime{cfg: cfg, done: done, current: make(map[int]*entryRuntime)}
	if cfg.Role == "entry-group" {
		for _, entry := range cfg.Entries {
			prepared, err := prepareEntryRuntime(entry)
			if err != nil {
				for _, previous := range runtime.runtimes {
					previous.close()
				}
				return nil, err
			}
			runtime.runtimes = append(runtime.runtimes, prepared)
			runtime.current[entry.RuleID] = prepared
		}
	} else {
		runtime.cfg.udpTargetsLive = &liveUDPTargets{}
		runtime.cfg.udpTargetsLive.set(cfg.UDPTargets)
	}
	return runtime, nil
}

func (runtime *additiveFXPRuntime) start(entries []*entryRuntime) {
	for _, entry := range entries {
		runtime.wg.Add(1)
		go func(entry *entryRuntime) {
			defer runtime.wg.Done()
			if err := entry.serve(runtime.done); err != nil && !errors.Is(err, net.ErrClosed) {
				// Isolate failures to their listener; never close sibling rules.
				log.Printf("entry listener stopped tunnel=%d rule=%d: %v", entry.cfg.TunnelID, entry.cfg.RuleID, err)
			}
		}(entry)
	}
}

func (runtime *additiveFXPRuntime) apply(next config) error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	select {
	case <-runtime.done:
		return errors.New("runtime is stopping")
	default:
	}
	if runtime.closed {
		return errors.New("runtime is stopping")
	}
	next = normalizeConfig(next)
	entries, err := planFXPConfigAddition(runtime.cfg, next)
	if err != nil {
		return err
	}
	for _, entry := range next.Entries {
		if previous := runtime.current[entry.RuleID]; previous != nil && previous.closed.Load() {
			entries = append(entries, entry)
		}
	}
	var prepared []*entryRuntime
	for _, entry := range entries {
		listener, err := prepareEntryRuntime(entry)
		if err != nil {
			for _, added := range prepared {
				added.close()
			}
			return fmt.Errorf("new listener rule=%d port=%d: %w", entry.RuleID, entry.ListenPort, err)
		}
		prepared = append(prepared, listener)
	}
	if runtime.cfg.udpTargetsLive != nil {
		next.udpTargetsLive = runtime.cfg.udpTargetsLive
		next.udpTargetsLive.set(next.UDPTargets)
	}
	runtime.start(prepared)
	for _, entry := range prepared {
		runtime.current[entry.cfg.RuleID] = entry
	}
	runtime.runtimes = runtime.runtimes[:0]
	for _, entry := range runtime.current {
		runtime.runtimes = append(runtime.runtimes, entry)
	}
	runtime.cfg = next
	if len(entries) > 0 {
		log.Printf("additive entry sync tunnel=%d added=%d; existing connections preserved", next.TunnelID, len(entries))
	}
	return nil
}

func (runtime *additiveFXPRuntime) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || request.URL.Path != "/additive" {
		http.NotFound(w, request)
		return
	}
	defer request.Body.Close()
	var next config
	decoder := json.NewDecoder(http.MaxBytesReader(w, request.Body, 16<<20))
	if err := decoder.Decode(&next); err != nil {
		http.Error(w, "invalid config", http.StatusBadRequest)
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid trailing data", http.StatusBadRequest)
		return
	}
	if err := runtime.apply(next); err != nil {
		// Do not echo keys, panel tokens or full configs in API errors/logs.
		log.Printf("additive update refused tunnel=%d; existing listeners preserved: %v", next.TunnelID, err)
		http.Error(w, "additive update refused; existing listeners preserved", http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func listenFXPControl(path string) (net.Listener, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("control socket must be absolute")
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("control path is not a socket")
		}
		conn, dialErr := net.DialTimeout("unix", path, time.Second)
		if dialErr == nil {
			_ = conn.Close()
			return nil, errors.New("control socket is already active")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

func runControlledFXP(done <-chan struct{}, cfg config) error {
	runtime, err := newAdditiveFXPRuntime(done, cfg)
	if err != nil {
		return err
	}
	listener, err := listenFXPControl(cfg.ControlSocket)
	if err != nil {
		for _, entry := range runtime.runtimes {
			entry.close()
		}
		return err
	}
	server := &http.Server{Handler: runtime, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 5 * time.Second}
	exitConfig := runtime.cfg
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	if cfg.Role == "exit" {
		return runExit(done, exitConfig)
	}
	runtime.mu.Lock()
	runtime.start(runtime.runtimes)
	runtime.mu.Unlock()
	<-done
	runtime.mu.Lock()
	runtime.closed = true
	for _, entry := range runtime.runtimes {
		entry.close()
	}
	runtime.mu.Unlock()
	runtime.wg.Wait()
	return nil
}
