package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	countingChainStateSchema = 1
	countingChainStatePrefix = "counting_"
	countingChainStateSuffix = ".state"
)

type persistedCountingChainState struct {
	Schema    int    `json:"schema"`
	BootID    string `json:"bootId"`
	Signature string `json:"signature"`
	CheckedAt int64  `json:"checkedAt"`
}

var countingChainStateIOMu sync.Mutex

func countingChainStatePath(port string) string {
	return filepath.Join(trafficStateDir, countingChainStatePrefix+port+countingChainStateSuffix)
}

func countingChainStatePort(name string) (string, bool) {
	if !strings.HasPrefix(name, countingChainStatePrefix) || !strings.HasSuffix(name, countingChainStateSuffix) {
		return "", false
	}
	port := strings.TrimSuffix(strings.TrimPrefix(name, countingChainStatePrefix), countingChainStateSuffix)
	value, err := strconv.Atoi(port)
	if err != nil || value <= 0 || value > 65535 || strconv.Itoa(value) != port {
		return "", false
	}
	return port, true
}

func validPersistedCountingChainState(port string, state persistedCountingChainState, bootID string) bool {
	return state.Schema == countingChainStateSchema &&
		strings.TrimSpace(bootID) != "" &&
		strings.TrimSpace(state.BootID) == strings.TrimSpace(bootID) &&
		state.CheckedAt > 0 &&
		strings.HasPrefix(state.Signature, countingLayoutVersion+"|"+port+"|")
}

// restoreCountingChainStates runs after the process has acquired the Agent
// state-directory lock, before counting repair workers can be started.
func restoreCountingChainStates(bootID string) {
	countingChainStateIOMu.Lock()
	defer countingChainStateIOMu.Unlock()

	restoredSignatures := map[string]string{}
	restoredCheckedAt := map[string]time.Time{}
	files, err := os.ReadDir(trafficStateDir)
	if err == nil {
		for _, file := range files {
			port, ok := countingChainStatePort(file.Name())
			if !ok || file.IsDir() {
				continue
			}
			path := countingChainStatePath(port)
			raw, readErr := os.ReadFile(path)
			var state persistedCountingChainState
			if readErr == nil {
				readErr = json.Unmarshal(raw, &state)
			}
			if readErr != nil || !validPersistedCountingChainState(port, state, bootID) {
				_ = removeTrafficStateFile(path, trafficStateDir)
				continue
			}
			// Keep the layout signature so the first desired-state heartbeat can
			// reuse the rule identity, but force one post-restart verification.
			// The persisted timestamp only proves that the previous process
			// completed a repair; it cannot prove that the current process still
			// has the kernel layout (iptables/nftables may have been reset while
			// the Agent was stopped).
			restoredSignatures[port] = state.Signature
			restoredCheckedAt[port] = time.Time{}
		}
	}

	countingChainMu.Lock()
	countingChainSignatures = restoredSignatures
	countingChainCheckedAt = restoredCheckedAt
	countingChainMu.Unlock()
}

// finishCountingChainRepair records only a completed repair for the rule that
// is still desired. The I/O lock also orders this write against rule deletion.
func finishCountingChainRepair(rule runningRule, repaired bool) {
	port := strconv.Itoa(rule.SourcePort)
	signature := countingChainRuleSignature(rule)

	countingChainStateIOMu.Lock()
	defer countingChainStateIOMu.Unlock()

	current, exists := desiredRunningRuleForStatePort(rule.RuleID, rule.SourcePort)
	desiredMatches := exists && countingChainRuleSignature(current) == signature
	checkedAt := time.Now()

	countingChainMu.Lock()
	delete(countingChainRepairPending, port)
	delete(countingChainRepairCleanup, port)
	if countingChainSignatures[port] != signature {
		countingChainMu.Unlock()
		return
	}
	if !desiredMatches {
		delete(countingChainSignatures, port)
		delete(countingChainCheckedAt, port)
		countingChainMu.Unlock()
		removeCountingChainStateFile(port)
		return
	}
	if !repaired {
		countingChainCheckedAt[port] = time.Time{}
		countingChainMu.Unlock()
		removeCountingChainStateFile(port)
		return
	}
	countingChainCheckedAt[port] = checkedAt
	countingChainMu.Unlock()

	bootID := strings.TrimSpace(agentBootID)
	state := persistedCountingChainState{
		Schema:    countingChainStateSchema,
		BootID:    bootID,
		Signature: signature,
		CheckedAt: checkedAt.Unix(),
	}
	raw, err := json.Marshal(state)
	if err == nil && bootID != "" {
		err = writeTrafficStateFile(countingChainStatePath(port), raw, 0600)
	} else if err == nil {
		err = fmt.Errorf("Agent boot ID is empty")
	}
	if err == nil {
		return
	}

	countingChainMu.Lock()
	if countingChainSignatures[port] == signature && countingChainCheckedAt[port].Equal(checkedAt) {
		countingChainCheckedAt[port] = time.Time{}
	}
	countingChainMu.Unlock()
	removeCountingChainStateFile(port)
	if shouldLogAgentReport("traffic-counting-state-write:"+port, agentReportLogInterval) {
		logf("traffic counting state persist failed port=%s error=%v", port, err)
	}
}

func forgetCountingChainState(port string) {
	if _, ok := countingChainStatePort(countingChainStatePrefix + port + countingChainStateSuffix); !ok {
		return
	}
	countingChainStateIOMu.Lock()
	defer countingChainStateIOMu.Unlock()

	countingChainMu.Lock()
	delete(countingChainSignatures, port)
	delete(countingChainCheckedAt, port)
	delete(countingChainRepairCleanup, port)
	countingChainMu.Unlock()
	removeCountingChainStateFile(port)
}

// invalidateCountingChainState makes a missing firewall layout eligible for
// repair. An already queued repair keeps ownership of the in-memory signature
// so its completion cannot strand the port in a permanently pending state.
func invalidateCountingChainState(port string) bool {
	if _, ok := countingChainStatePort(countingChainStatePrefix + port + countingChainStateSuffix); !ok {
		return false
	}
	countingChainStateIOMu.Lock()
	defer countingChainStateIOMu.Unlock()

	countingChainMu.Lock()
	if countingChainRepairPending[port] {
		countingChainMu.Unlock()
		return false
	}
	delete(countingChainSignatures, port)
	delete(countingChainCheckedAt, port)
	countingChainMu.Unlock()
	removeCountingChainStateFile(port)
	return true
}

func removeCountingChainStateFile(port string) {
	path := countingChainStatePath(port)
	if err := removeTrafficStateFile(path, trafficStateDir); err != nil && shouldLogAgentReport("traffic-counting-state-remove:"+port, agentReportLogInterval) {
		logf("traffic counting state remove failed port=%s error=%v", port, err)
	}
}
