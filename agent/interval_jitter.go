package main

import (
	"hash/fnv"
	"time"
)

const agentPeriodicJitterPercent = 10

// stableIntervalJitter returns a deterministic interval in base +/- percent.
// A stable per-Agent key spreads periodic work without causing timer drift.
func stableIntervalJitter(base time.Duration, key string, percent int) time.Duration {
	if base <= 0 || percent <= 0 || key == "" {
		return base
	}
	if percent > 20 {
		percent = 20
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(key))
	spreadBasisPoints := int64(percent * 100)
	span := uint64(spreadBasisPoints*2 + 1)
	offsetBasisPoints := int64(hash.Sum64()%span) - spreadBasisPoints
	jittered := base + time.Duration(int64(base)*offsetBasisPoints/10_000)
	if jittered < time.Millisecond {
		return time.Millisecond
	}
	return jittered
}

// stableIntervalJitterBelow spreads an interval across [base-percent, base].
// It is used where base is also a hard audit deadline.
func stableIntervalJitterBelow(base time.Duration, key string, percent int) time.Duration {
	if base <= 0 || percent <= 0 || key == "" {
		return base
	}
	if percent > 20 {
		percent = 20
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(key))
	spreadBasisPoints := uint64(percent * 100)
	offsetBasisPoints := int64(hash.Sum64() % (spreadBasisPoints + 1))
	return base - time.Duration(int64(base)*offsetBasisPoints/10_000)
}

func agentPeriodicInterval(base time.Duration, scope string) time.Duration {
	return stableIntervalJitter(base, agentBootID+":"+scope, agentPeriodicJitterPercent)
}
