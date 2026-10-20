package main

import (
	"math"
	"os"
	"strconv"
	"strings"
)

// Linux load averages are runnable/uninterruptible task counts, not CPU percent.
func parseLoadAverage(raw string) []float64 {
	fields := strings.Fields(raw)
	if len(fields) < 3 {
		return nil
	}
	values := make([]float64, 3)
	for i := range values {
		value, err := strconv.ParseFloat(fields[i], 64)
		if err != nil || value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil
		}
		values[i] = value
	}
	return values
}

func systemLoadAverage() []float64 {
	raw, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return nil
	}
	return parseLoadAverage(string(raw))
}
