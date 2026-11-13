package main

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net"
	"strconv"
	"sync"
	"time"
)

const speedUDPHeader = 49
const speedUDPSize = 1200

type speedUDPStats struct {
	mu          sync.Mutex
	first       time.Time
	last        time.Time
	bytes       uint64
	packets     uint64
	seen        []uint64
	lastSender  int64
	lastArrival time.Time
	jitter      float64
	peak        float64
	sampleAt    time.Time
	sampleBytes uint64
	peer        string
	started     bool
	done        bool
	sent        uint64
}

func newSpeedUDPStats(task linkSpeedTask) *speedUDPStats {
	count := int(task.RateMbps*1e6/8/speedUDPSize*float64(task.Duration+2)) + 1024
	return &speedUDPStats{seen: make([]uint64, (count+63)/64)}
}
func (s *speedUDPStats) record(sequence uint64, sender int64, n int, peer string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sequence == 0 || sequence/64 >= uint64(len(s.seen)) || (s.peer != "" && s.peer != peer) {
		return false
	}
	index, mask := sequence/64, uint64(1)<<(sequence%64)
	if s.seen[index]&mask != 0 {
		return false
	}
	s.seen[index] |= mask
	now := time.Now()
	if s.first.IsZero() {
		s.first = now
		s.sampleAt = now
		s.peer = peer
	}
	if !s.lastArrival.IsZero() {
		delta := math.Abs(float64(now.Sub(s.lastArrival).Nanoseconds()-(sender-s.lastSender)) / 1e6)
		s.jitter += (delta - s.jitter) / 16
	}
	s.lastArrival = now
	s.lastSender = sender
	s.last = now
	s.bytes += uint64(n)
	s.packets++
	if elapsed := now.Sub(s.sampleAt).Seconds(); elapsed >= .5 {
		rate := float64(s.bytes-s.sampleBytes) * 8 / elapsed / 1e6
		if rate > s.peak {
			s.peak = rate
		}
		s.sampleAt = now
		s.sampleBytes = s.bytes
	}
	return true
}
func (s *speedUDPStats) result(sent uint64, durationMs int64) speedMeasurement {
	s.mu.Lock()
	defer s.mu.Unlock()
	if durationMs < 1 {
		durationMs = s.last.Sub(s.first).Milliseconds()
		if durationMs < 1 {
			durationMs = 1
		}
	}
	lost := uint64(0)
	if sent > s.packets {
		lost = sent - s.packets
	}
	loss := float64(0)
	if sent > 0 {
		loss = float64(lost) * 100 / float64(sent)
	}
	peak := s.peak
	if peak == 0 {
		peak = float64(s.bytes) * 8 / float64(durationMs) / 1000
	}
	return speedMeasurement{Bytes: s.bytes, DurationMs: durationMs, Mbps: float64(s.bytes) * 8 / float64(durationMs) / 1000, PeakMbps: peak, Packets: s.packets, SentPackets: sent, LostPackets: lost, LossPercent: loss, JitterMs: s.jitter}
}

type speedUDPReply struct {
	Result speedMeasurement `json:"result"`
	Done   bool             `json:"done"`
}

func speedUDPPacket(token []byte, op byte, sequence uint64, timestamp int64, payload []byte) []byte {
	packet := make([]byte, speedUDPHeader+len(payload))
	copy(packet, token)
	packet[32] = op
	binary.BigEndian.PutUint64(packet[33:41], sequence)
	binary.BigEndian.PutUint64(packet[41:49], uint64(timestamp))
	copy(packet[speedUDPHeader:], payload)
	return packet
}
func validSpeedUDP(packet, token []byte) bool {
	return len(packet) >= speedUDPHeader && len(token) == 32 && subtle.ConstantTimeCompare(packet[:32], token) == 1
}

// Millisecond batches avoid one timer per packet, which otherwise caps UDP
// generation far below the configured offered rate on fast links.
func sendSpeedUDP(ctx context.Context, duration int, rate float64, write func([]byte) error, token []byte, op byte) (uint64, time.Duration, error) {
	started := time.Now()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	var sent uint64
	payload := speedPayload(speedUDPSize - speedUDPHeader)
	for {
		select {
		case <-ctx.Done():
			return sent, time.Since(started), ctx.Err()
		case now := <-ticker.C:
			elapsed := now.Sub(started)
			if elapsed >= time.Duration(duration)*time.Second {
				return sent, time.Since(started), nil
			}
			expected := uint64(elapsed.Seconds() * rate * 1e6 / 8 / speedUDPSize)
			if expected > sent+256 {
				expected = sent + 256
			}
			for sent < expected {
				sent++
				packet := speedUDPPacket(token, op, sent, time.Since(started).Nanoseconds(), payload)
				if err := write(packet); err != nil {
					return sent, time.Since(started), err
				}
			}
		}
	}
}
func startSpeedUDPReceiver(s *linkSpeedSession, task linkSpeedTask, c linkSpeedComponent) error {
	token, err := hex.DecodeString(task.Token)
	if err != nil {
		return err
	}
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(c.ListenHost, strconv.Itoa(c.Port)))
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return err
	}
	_ = conn.SetReadBuffer(4 * 1024 * 1024)
	_ = conn.SetWriteBuffer(4 * 1024 * 1024)
	s.addCleanup(func() { _ = conn.Close() })
	upload, download := newSpeedUDPStats(task), newSpeedUDPStats(task)
	reply := func(peer *net.UDPAddr, result speedMeasurement, done bool) {
		payload, _ := json.Marshal(speedUDPReply{Result: result, Done: done})
		_, _ = conn.WriteToUDP(speedUDPPacket(token, 'R', 0, 0, payload), peer)
	}
	go func() {
		buffer := make([]byte, 65535)
		for {
			n, peer, err := conn.ReadFromUDP(buffer)
			if err != nil {
				return
			}
			packet := buffer[:n]
			if !validSpeedUDP(packet, token) {
				continue
			}
			sequence := binary.BigEndian.Uint64(packet[33:41])
			stamp := int64(binary.BigEndian.Uint64(packet[41:49]))
			switch packet[32] {
			case 'P':
				reply(peer, speedMeasurement{}, false)
			case 'U':
				upload.record(sequence, stamp, n, peer.String())
			case 'S', 'F':
				upload.mu.Lock()
				matches := upload.peer == "" || upload.peer == peer.String()
				upload.mu.Unlock()
				if !matches {
					continue
				}
				duration := int64(0)
				if packet[32] == 'F' {
					duration = stamp
				}
				reply(peer, upload.result(sequence, duration), packet[32] == 'F')
			case 'D':
				download.mu.Lock()
				if download.started {
					download.mu.Unlock()
					continue
				}
				download.started = true
				download.peer = peer.String()
				download.mu.Unlock()
				go func(peer *net.UDPAddr) {
					sent, elapsed, _ := sendSpeedUDP(s.ctx, task.Duration, task.RateMbps, func(b []byte) error { _, err := conn.WriteToUDP(b, peer); return err }, token, 'd')
					download.mu.Lock()
					download.sent = sent
					download.done = true
					download.first = time.Now().Add(-elapsed)
					download.last = time.Now()
					download.mu.Unlock()
				}(peer)
			case 'Q':
				download.mu.Lock()
				matches := download.peer == peer.String()
				done := download.done
				sent := download.sent
				duration := download.last.Sub(download.first).Milliseconds()
				download.mu.Unlock()
				if matches {
					reply(peer, speedMeasurement{SentPackets: sent, DurationMs: duration}, done)
				}
			}
		}
	}()
	return nil
}
func runSpeedUDP(ctx context.Context, task linkSpeedTask, direction string, emit func(speedSample)) (speedMeasurement, error) {
	var zero speedMeasurement
	token, err := hex.DecodeString(task.Token)
	if err != nil {
		return zero, err
	}
	if !speedAddressValid(task.Target) {
		return zero, errors.New("invalid test target")
	}
	address, err := net.ResolveUDPAddr("udp", task.Target)
	if err != nil {
		return zero, err
	}
	conn, err := net.DialUDP("udp", nil, address)
	if err != nil {
		return zero, err
	}
	defer conn.Close()
	_ = conn.SetReadBuffer(4 * 1024 * 1024)
	_ = conn.SetWriteBuffer(4 * 1024 * 1024)
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	sendControl := func(op byte, seq uint64, stamp int64) { _, _ = conn.Write(speedUDPPacket(token, op, seq, stamp, nil)) }
	buffer := make([]byte, 65535)
	// Authenticate the complete path before beginning either timed phase.
	connected := false
	for attempt := 0; attempt < 8; attempt++ {
		sendControl('P', 0, 0)
		_ = conn.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
		n, err := conn.Read(buffer)
		if err == nil && validSpeedUDP(buffer[:n], token) && buffer[32] == 'R' {
			connected = true
			break
		}
		if ctx.Err() != nil {
			return zero, ctx.Err()
		}
	}
	if !connected {
		return zero, errors.New("UDP 链路接收端无响应，请检查端口和链路是否支持 UDP")
	}
	if direction == "upload" {
		return runSpeedUDPUpload(ctx, conn, task, token, emit)
	}
	stats := newSpeedUDPStats(task)
	started := time.Now()
	lastLive := started
	var lastLiveBytes uint64
	deadline := started.Add(time.Duration(task.Duration+10) * time.Second)
	lastQuery := time.Time{}
	var remote speedUDPReply
	var drainUntil time.Time
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return zero, ctx.Err()
		}
		if time.Since(lastQuery) >= 300*time.Millisecond {
			stats.mu.Lock()
			hasData := stats.packets > 0
			stats.mu.Unlock()
			if !hasData {
				sendControl('D', 0, 0)
			}
			sendControl('Q', 0, 0)
			lastQuery = time.Now()
		}
		_ = conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		n, err := conn.Read(buffer)
		if err == nil && validSpeedUDP(buffer[:n], token) {
			if buffer[32] == 'd' {
				stats.record(binary.BigEndian.Uint64(buffer[33:41]), int64(binary.BigEndian.Uint64(buffer[41:49])), n, "download")
			}
			if buffer[32] == 'R' {
				var reply speedUDPReply
				if json.Unmarshal(buffer[speedUDPHeader:n], &reply) == nil && reply.Done {
					remote = reply
					if drainUntil.IsZero() {
						drainUntil = time.Now().Add(400 * time.Millisecond)
					}
				}
			}
		}
		if time.Since(lastLive) >= 500*time.Millisecond {
			result := stats.result(0, 0)
			mbps := float64(result.Bytes-lastLiveBytes) * 8 / time.Since(lastLive).Seconds() / 1e6
			emit(speedSample{Direction: direction, ElapsedMs: min(time.Since(started).Milliseconds(), int64(task.Duration*1000)), Bytes: result.Bytes, Mbps: mbps})
			lastLiveBytes = result.Bytes
			lastLive = time.Now()
		}
		if !drainUntil.IsZero() && time.Now().After(drainUntil) {
			result := stats.result(remote.Result.SentPackets, remote.Result.DurationMs)
			if result.Packets == 0 {
				return zero, errors.New("UDP 下载未收到数据")
			}
			return result, nil
		}
	}
	return zero, errors.New("UDP 下载结果超时")
}
func runSpeedUDPUpload(ctx context.Context, conn *net.UDPConn, task linkSpeedTask, token []byte, emit func(speedSample)) (speedMeasurement, error) {
	type sentResult struct {
		packets uint64
		elapsed time.Duration
		err     error
	}
	done := make(chan sentResult, 1)
	sendCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		n, elapsed, err := sendSpeedUDP(sendCtx, task.Duration, task.RateMbps, func(b []byte) error { _, err := conn.Write(b); return err }, token, 'U')
		done <- sentResult{n, elapsed, err}
	}()
	start := time.Now()
	deadline := start.Add(time.Duration(task.Duration+8) * time.Second)
	lastQuery := time.Time{}
	var sent *sentResult
	var finishAt time.Time
	var result speedMeasurement
	var lastBytes uint64
	lastSample := start
	buffer := make([]byte, 65535)
	for time.Now().Before(deadline) {
		select {
		case current := <-done:
			if current.err != nil {
				return speedMeasurement{}, current.err
			}
			sent = &current
			finishAt = time.Now().Add(800 * time.Millisecond)
		case <-ctx.Done():
			return speedMeasurement{}, ctx.Err()
		default:
		}
		if time.Since(lastQuery) >= 250*time.Millisecond {
			op := byte('S')
			var count uint64
			var duration int64
			if sent != nil {
				op = 'F'
				count = sent.packets
				duration = sent.elapsed.Milliseconds()
			}
			_, _ = conn.Write(speedUDPPacket(token, op, count, duration, nil))
			lastQuery = time.Now()
		}
		_ = conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		n, err := conn.Read(buffer)
		if err == nil && validSpeedUDP(buffer[:n], token) && buffer[32] == 'R' {
			var reply speedUDPReply
			if json.Unmarshal(buffer[speedUDPHeader:n], &reply) == nil {
				if reply.Done {
					result = reply.Result
				}
				if time.Since(lastSample) >= 400*time.Millisecond && reply.Result.Bytes >= lastBytes {
					elapsed := time.Since(lastSample).Seconds()
					mbps := float64(reply.Result.Bytes-lastBytes) * 8 / elapsed / 1e6
					emit(speedSample{Direction: "upload", ElapsedMs: min(time.Since(start).Milliseconds(), int64(task.Duration*1000)), Bytes: reply.Result.Bytes, Mbps: mbps})
					lastBytes = reply.Result.Bytes
					lastSample = time.Now()
				}
			}
		}
		if sent != nil && !finishAt.IsZero() && time.Now().After(finishAt) && result.DurationMs > 0 {
			return result, nil
		}
	}
	return speedMeasurement{}, errors.New("UDP 上传接收结果超时")
}
