package main

import (
	"context"
	"sync"
)

// At most one event stream exists. Cancel only that communication request on a
// panel URL switch, not forwarding runtimes or unrelated in-flight work.
var panelURLStream = struct {
	sync.Mutex
	generation uint64
	url        string
	cancel     context.CancelFunc
}{}

func newPanelURLStreamContext(cfg Config) (context.Context, string, func()) {
	panelURLStream.Lock()
	defer panelURLStream.Unlock()
	if panelURLStream.cancel != nil {
		panelURLStream.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	panelURLStream.generation++
	generation := panelURLStream.generation
	panelURL := currentPanelURL(cfg)
	panelURLStream.url = panelURL
	panelURLStream.cancel = cancel
	return ctx, panelURL, func() {
		panelURLStream.Lock()
		if panelURLStream.generation == generation {
			panelURLStream.cancel = nil
			panelURLStream.url = ""
		}
		panelURLStream.Unlock()
		cancel()
	}
}
