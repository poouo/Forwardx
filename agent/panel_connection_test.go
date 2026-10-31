package main

import (
	"testing"
)

func TestPanelURLSwitchCancelsOnlyStaleEventStreamAndPersists(t *testing.T) {
	cfg := Config{PanelURL: "https://global.example.com", Token: "connection-test-token", Interval: 30}
	activeConfigPath = writePanelMigrationTestConfig(t, cfg)
	setRuntimePanelURL(cfg.PanelURL)
	ctx, originalURL, release := newPanelURLStreamContext(cfg)
	defer release()
	if originalURL != cfg.PanelURL {
		t.Fatal("wrong initial stream URL")
	}
	syncPanelURLFromResponse(cfg.PanelURL + "/")
	if ctx.Err() != nil {
		t.Fatal("equivalent URL must not reconnect a working stream")
	}
	syncPanelURLFromResponse("https://custom.example.com:8443")
	if ctx.Err() == nil {
		t.Fatal("old stream must be cancelled on panel URL change")
	}
	saved := readPanelMigrationTestConfig(t, activeConfigPath)
	if saved["panelUrl"] != "https://custom.example.com:8443" || saved["token"] != cfg.Token {
		t.Fatal("URL update must persist without changing the token")
	}
	next, nextURL, releaseNext := newPanelURLStreamContext(cfg)
	defer releaseNext()
	release() // Stale cleanup must not detach the new stream's cancellation.
	if nextURL != "https://custom.example.com:8443" || next.Err() != nil {
		t.Fatal("new stream must use the host's custom URL")
	}
	syncPanelURLFromResponse("invalid")
	syncPanelURLFromResponse("")
	if next.Err() != nil {
		t.Fatal("absent/invalid response URL must not disrupt the stream")
	}
	syncPanelURLFromResponse(cfg.PanelURL)
	if next.Err() == nil || currentPanelURL(cfg) != cfg.PanelURL {
		t.Fatal("disabling override must reconnect and return to global URL")
	}
}
