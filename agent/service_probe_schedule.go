package main

import (
	"strings"
	"sync"
	"time"
)

type serviceProbeRun struct {
	probe hostProbeServiceProbe
	at    time.Time
}

// The overall TCPing loop may run frequently for another service or failover.
// Only services actually selected for execution consume their own interval.
type serviceProbeSchedule struct {
	mu     sync.Mutex
	last   map[int]serviceProbeRun
	cursor int
}

var agentServiceProbeSchedule serviceProbeSchedule

func serviceProbeInterval(probe hostProbeServiceProbe) time.Duration {
	seconds := probe.IntervalSeconds
	if seconds <= 0 {
		seconds = 30
	}
	if seconds < 5 {
		seconds = 5
	}
	return time.Duration(seconds) * time.Second
}

func validServiceProbe(probe hostProbeServiceProbe) bool {
	if probe.ServiceID <= 0 || probe.TargetIP == "" {
		return false
	}
	method := strings.ToLower(strings.TrimSpace(probe.Method))
	return method == "ping" || method == "url" || probe.TargetPort > 0
}

func (s *serviceProbeSchedule) dueLocked(probe hostProbeServiceProbe, now time.Time) bool {
	last, found := s.last[probe.ServiceID]
	return !found || last.probe != probe || now.Sub(last.at) >= serviceProbeInterval(probe)
}

func (s *serviceProbeSchedule) due(probes []hostProbeServiceProbe, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, probe := range probes {
		if validServiceProbe(probe) && s.dueLocked(probe, now) {
			return true
		}
	}
	return false
}

func (s *serviceProbeSchedule) selectTasks(tasks []tcpingTask, probes []hostProbeServiceProbe, limit int, force bool, now time.Time) []tcpingTask {
	s.mu.Lock()
	defer s.mu.Unlock()
	byID := make(map[int]hostProbeServiceProbe, len(probes))
	for _, probe := range probes {
		if validServiceProbe(probe) {
			byID[probe.ServiceID] = probe
		}
	}
	// Removed/disabled services must not leave historical scheduling keys behind.
	for id := range s.last {
		if _, active := byID[id]; !active {
			delete(s.last, id)
		}
	}
	due := make([]tcpingTask, 0, len(tasks))
	for _, task := range tasks {
		if probe, active := byID[task.ServiceID]; active && (force || s.dueLocked(probe, now)) {
			due = append(due, task)
		}
	}
	selected := rotateTCPingTasks(due, &s.cursor, limit)
	if s.last == nil && len(selected) > 0 {
		s.last = make(map[int]serviceProbeRun)
	}
	for _, task := range selected {
		s.last[task.ServiceID] = serviceProbeRun{probe: byID[task.ServiceID], at: now}
	}
	return selected
}
