package main

import (
	"sync"
	"time"
)

const (
	fxpTrafficPaddingMaxRatio       = 50
	fxpTrafficPaddingMaxConfigured  = 1000
	fxpTrafficPaddingDefaultMaxMbps = 10
	fxpTrafficPaddingChunkSize      = 16 * 1024
)

var fxpTrafficPaddingChunk [fxpTrafficPaddingChunkSize]byte

func normalizeTrafficPadding(cfg config) config {
	// Padding is currently defined only for TCP streams. UDP direct and
	// UDP-over-TCP sessions retain their original datagram framing.
	if normalizeProtocol(cfg.Protocol) == "udp" || !cfg.TrafficPaddingEnabled {
		// A disabled/UDP-only configuration must be represented consistently.
		// Leaving the boolean set while clearing the numeric fields makes the
		// persisted config look enabled and breaks the normalization contract.
		cfg.TrafficPaddingEnabled = false
		cfg.TrafficPaddingRatio = 0
		cfg.TrafficPaddingMaxMbps = 0
		return cfg
	}
	if cfg.TrafficPaddingRatio < 0 {
		cfg.TrafficPaddingRatio = 0
	}
	if cfg.TrafficPaddingRatio > fxpTrafficPaddingMaxRatio {
		cfg.TrafficPaddingRatio = fxpTrafficPaddingMaxRatio
	}
	if cfg.TrafficPaddingRatio == 0 {
		cfg.TrafficPaddingEnabled = false
		cfg.TrafficPaddingMaxMbps = 0
		return cfg
	}
	if cfg.TrafficPaddingMaxMbps < 0 {
		cfg.TrafficPaddingMaxMbps = 0
	}
	if cfg.TrafficPaddingMaxMbps > fxpTrafficPaddingMaxConfigured {
		cfg.TrafficPaddingMaxMbps = fxpTrafficPaddingMaxConfigured
	}
	return cfg
}

func trafficPaddingMaxBytesPerSecond(maxMbps int) int64 {
	if maxMbps <= 0 {
		maxMbps = fxpTrafficPaddingDefaultMaxMbps
	}
	if maxMbps > fxpTrafficPaddingMaxConfigured {
		maxMbps = fxpTrafficPaddingMaxConfigured
	}
	return int64(maxMbps) * 1000 * 1000 / 8
}

// trafficPaddingBudget is shared by all return-direction writers in one
// runtime. This keeps the configured cap a tunnel-wide limit when multiple
// connections are active at once.
type trafficPaddingBudget struct {
	mu        sync.Mutex
	ratio     int64
	remainder int64
	rate      int64
	burst     float64
	tokens    float64
	last      time.Time
}

// trafficPaddingEmitter is used by one return-direction writer. It keeps no
// payload backlog: bytes denied by the cap are discarded instead of being
// emitted later after the real session becomes idle.
type trafficPaddingEmitter struct {
	budget *trafficPaddingBudget

	mu       sync.Mutex
	disabled bool
}

func newTrafficPaddingEmitter(sec *secureConn) *trafficPaddingEmitter {
	if sec == nil || !sec.trafficPadding || sec.trafficPaddingRatio <= 0 {
		return nil
	}
	if sec.trafficPaddingBudget != nil {
		return &trafficPaddingEmitter{budget: sec.trafficPaddingBudget}
	}
	return newTrafficPaddingEmitterConfig(true, sec.trafficPaddingRatio, sec.trafficPaddingMaxMbps)
}

func withTrafficPaddingBudget(cfg config) config {
	if !cfg.TrafficPaddingEnabled || cfg.TrafficPaddingRatio <= 0 {
		cfg.trafficPaddingBudget = nil
		return cfg
	}
	if cfg.trafficPaddingBudget == nil {
		cfg.trafficPaddingBudget = newTrafficPaddingBudget(true, cfg.TrafficPaddingRatio, cfg.TrafficPaddingMaxMbps)
	}
	return cfg
}

func newTrafficPaddingEmitterConfig(enabled bool, ratio, maxMbps int) *trafficPaddingEmitter {
	budget := newTrafficPaddingBudget(enabled, ratio, maxMbps)
	if budget == nil {
		return nil
	}
	return &trafficPaddingEmitter{budget: budget}
}

func newTrafficPaddingBudget(enabled bool, ratio, maxMbps int) *trafficPaddingBudget {
	if !enabled || ratio <= 0 {
		return nil
	}
	if ratio > fxpTrafficPaddingMaxRatio {
		ratio = fxpTrafficPaddingMaxRatio
	}
	if maxMbps < 0 {
		maxMbps = 0
	}
	if maxMbps > fxpTrafficPaddingMaxConfigured {
		maxMbps = fxpTrafficPaddingMaxConfigured
	}
	rate := trafficPaddingMaxBytesPerSecond(maxMbps)
	burst := float64(rate) / 4
	if burst < fxpTrafficPaddingChunkSize {
		burst = fxpTrafficPaddingChunkSize
	}
	if burst > 256*1024 {
		burst = 256 * 1024
	}
	now := time.Now()
	return &trafficPaddingBudget{
		ratio:  int64(ratio),
		rate:   rate,
		burst:  burst,
		tokens: burst,
		last:   now,
	}
}

func (e *trafficPaddingEmitter) allowance(actualBytes int, now time.Time) int {
	if e == nil || e.budget == nil || actualBytes <= 0 {
		return 0
	}
	b := e.budget
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ratio <= 0 || b.rate <= 0 {
		return 0
	}
	weighted := int64(actualBytes)*b.ratio + b.remainder
	desired := weighted / 100
	b.remainder = weighted % 100
	if desired <= 0 {
		return 0
	}
	if now.After(b.last) {
		b.tokens += now.Sub(b.last).Seconds() * float64(b.rate)
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}
	allowed := int64(b.tokens)
	if allowed > desired {
		allowed = desired
	}
	if allowed <= 0 {
		return 0
	}
	b.tokens -= float64(allowed)
	return int(allowed)
}

func writeTrafficPadding(sec *secureConn, emitter *trafficPaddingEmitter, actualBytes int) error {
	if emitter == nil {
		return nil
	}
	emitter.mu.Lock()
	disabled := emitter.disabled
	emitter.mu.Unlock()
	if disabled {
		return nil
	}
	remaining := emitter.allowance(actualBytes, time.Now())
	for remaining > 0 {
		chunk := remaining
		if chunk > len(fxpTrafficPaddingChunk) {
			chunk = len(fxpTrafficPaddingChunk)
		}
		if err := sec.writePaddingFrame(fxpTrafficPaddingChunk[:chunk]); err != nil {
			// Padding is an optional cover channel. A failed cover write must not
			// turn into a business-stream failure or cause a retry storm. Disable
			// padding for this session and let the next real frame use the normal
			// forwarding path.
			emitter.mu.Lock()
			emitter.disabled = true
			emitter.mu.Unlock()
			fxpVerbosef("traffic padding disabled after write failure: %v", err)
			return nil
		}
		remaining -= chunk
	}
	return nil
}
