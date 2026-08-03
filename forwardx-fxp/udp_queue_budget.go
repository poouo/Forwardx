package main

import "sync"

const (
	fxpUDPQueueRuleBudgetBytes    int64 = 16 * 1024 * 1024
	fxpUDPQueueProcessBudgetBytes int64 = 64 * 1024 * 1024
)

// fxpUDPQueueProcessBudget owns the lock for both process and rule accounting.
// Reserving through a rule budget therefore updates both limits atomically.
type fxpUDPQueueProcessBudget struct {
	mu    sync.Mutex
	limit int64
	used  int64
}

type fxpUDPQueueRuleBudget struct {
	process *fxpUDPQueueProcessBudget
	limit   int64
	used    int64
}

var fxpUDPDefaultProcessQueueBudget = newFXPUDPQueueProcessBudget(fxpUDPQueueProcessBudgetBytes)

func newFXPUDPQueueProcessBudget(limit int64) *fxpUDPQueueProcessBudget {
	if limit < 0 {
		limit = 0
	}
	return &fxpUDPQueueProcessBudget{limit: limit}
}

func newFXPUDPQueueRuleBudget(process *fxpUDPQueueProcessBudget, limit int64) *fxpUDPQueueRuleBudget {
	if limit < 0 {
		limit = 0
	}
	return &fxpUDPQueueRuleBudget{process: process, limit: limit}
}

func newDefaultFXPUDPQueueRuleBudget() *fxpUDPQueueRuleBudget {
	return newFXPUDPQueueRuleBudget(fxpUDPDefaultProcessQueueBudget, fxpUDPQueueRuleBudgetBytes)
}

func (b *fxpUDPQueueRuleBudget) reserve(bytes int) bool {
	if b == nil || b.process == nil || bytes < 0 {
		return false
	}
	if bytes == 0 {
		return true
	}
	n := int64(bytes)
	b.process.mu.Lock()
	defer b.process.mu.Unlock()
	if n > b.limit-b.used || n > b.process.limit-b.process.used {
		return false
	}
	b.used += n
	b.process.used += n
	return true
}

// replace atomically swaps bytes already owned by one queue for a new packet.
// This lets a congested queue keep its existing packets when a shared limit
// cannot admit the replacement.
func (b *fxpUDPQueueRuleBudget) replace(releaseBytes, reserveBytes int) bool {
	if b == nil || b.process == nil || releaseBytes < 0 || reserveBytes < 0 {
		return false
	}
	release := int64(releaseBytes)
	reserve := int64(reserveBytes)
	b.process.mu.Lock()
	defer b.process.mu.Unlock()
	if release > b.used || release > b.process.used {
		return false
	}
	ruleBase := b.used - release
	processBase := b.process.used - release
	if reserve > b.limit-ruleBase || reserve > b.process.limit-processBase {
		return false
	}
	b.used = ruleBase + reserve
	b.process.used = processBase + reserve
	return true
}

func (b *fxpUDPQueueRuleBudget) release(bytes int) {
	if b == nil || b.process == nil || bytes <= 0 {
		return
	}
	n := int64(bytes)
	b.process.mu.Lock()
	if n > b.used {
		n = b.used
	}
	b.used -= n
	b.process.used -= n
	b.process.mu.Unlock()
}

func (b *fxpUDPQueueRuleBudget) usedBytes() int64 {
	if b == nil || b.process == nil {
		return 0
	}
	b.process.mu.Lock()
	defer b.process.mu.Unlock()
	return b.used
}

func (b *fxpUDPQueueProcessBudget) usedBytes() int64 {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.used
}
