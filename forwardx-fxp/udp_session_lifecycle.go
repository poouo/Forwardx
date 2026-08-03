package main

import (
	"sync"
	"time"
)

const (
	fxpUDPSweepInterval    = 5 * time.Second
	fxpUDPMinSweepInterval = 250 * time.Millisecond
)

func fxpUDPSessionIdleAt(now time.Time, lastActivity int64) bool {
	if lastActivity <= 0 {
		return false
	}
	return now.Sub(time.Unix(0, lastActivity)) >= fxpUDPIdleTimeout
}

func startFXPUDPSessionSweeper(sweep func(time.Time)) (stop func(), wake func()) {
	done := make(chan struct{})
	stopped := make(chan struct{})
	wakeCh := make(chan struct{}, 1)
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(fxpUDPSweepInterval)
		defer ticker.Stop()
		var lastSweep time.Time
		run := func(now time.Time) {
			if sweep != nil {
				sweep(now)
			}
			lastSweep = now
		}
		for {
			select {
			case <-done:
				return
			case now := <-ticker.C:
				run(now)
			case <-wakeCh:
				now := time.Now()
				if lastSweep.IsZero() || now.Sub(lastSweep) >= fxpUDPMinSweepInterval {
					run(now)
				}
			}
		}
	}()

	var once sync.Once
	stop = func() {
		once.Do(func() {
			close(done)
			<-stopped
		})
	}
	wake = func() {
		select {
		case wakeCh <- struct{}{}:
		default:
		}
	}
	return stop, wake
}

func startFXPUDPSessionWorker(wg *sync.WaitGroup, worker func()) {
	if worker == nil {
		return
	}
	if wg != nil {
		wg.Add(1)
	}
	go func() {
		if wg != nil {
			defer wg.Done()
		}
		worker()
	}()
}
