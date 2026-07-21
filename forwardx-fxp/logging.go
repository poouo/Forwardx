package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	fxpVerboseLogEnv        = "FORWARDX_FXP_VERBOSE_LOG"
	fxpLogWindow            = time.Minute
	fxpLogMaxBytesPerWindow = 64 * 1024
	fxpLogMaxLineBytes      = 4 * 1024
)

var fxpVerboseLogs = envTruthy(os.Getenv(fxpVerboseLogEnv))

type boundedLogWriter struct {
	destination io.Writer
	window      time.Duration
	maxBytes    int
	now         func() time.Time

	mu         sync.Mutex
	windowAt   time.Time
	written    int
	suppressed uint64
}

func newBoundedLogWriter(destination io.Writer, window time.Duration, maxBytes int) *boundedLogWriter {
	return &boundedLogWriter{
		destination: destination,
		window:      window,
		maxBytes:    maxBytes,
		now:         time.Now,
	}
}

func (w *boundedLogWriter) Write(p []byte) (int, error) {
	originalLength := len(p)
	if w == nil || w.destination == nil || originalLength == 0 {
		return originalLength, nil
	}
	line := compactRuntimeLogLine(p, fxpLogMaxLineBytes)
	now := w.now()

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.windowAt.IsZero() || now.Sub(w.windowAt) >= w.window {
		w.writeSuppressedSummaryLocked()
		w.windowAt = now
		w.written = 0
	}
	if w.maxBytes <= 0 || len(line) > w.maxBytes-w.written {
		w.suppressed++
		return originalLength, nil
	}
	_, err := w.destination.Write(line)
	if err == nil {
		w.written += len(line)
	}
	return originalLength, err
}

func (w *boundedLogWriter) writeSuppressedSummaryLocked() {
	if w.suppressed == 0 || w.destination == nil {
		return
	}
	summary := []byte(fmt.Sprintf("forwardx-fxp log rate limit suppressed=%d\n", w.suppressed))
	_, _ = w.destination.Write(summary)
	w.suppressed = 0
}

func compactRuntimeLogLine(p []byte, maxBytes int) []byte {
	if maxBytes <= 0 || len(p) <= maxBytes {
		return p
	}
	suffix := []byte("... [truncated]\n")
	keep := maxBytes - len(suffix)
	if keep < 0 {
		keep = 0
	}
	line := make([]byte, 0, maxBytes)
	line = append(line, p[:keep]...)
	line = append(line, suffix...)
	return line
}

func configureFXPLogging() {
	log.SetOutput(newBoundedLogWriter(os.Stderr, fxpLogWindow, fxpLogMaxBytesPerWindow))
}

func fxpVerbosef(format string, args ...any) {
	if fxpVerboseLogs {
		log.Printf(format, args...)
	}
}

func envTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
