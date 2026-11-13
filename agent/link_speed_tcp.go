package main

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

type speedSample struct {
	Direction string  `json:"direction"`
	ElapsedMs int64   `json:"elapsedMs"`
	Bytes     uint64  `json:"bytes"`
	Mbps      float64 `json:"mbps"`
}
type speedMeasurement struct {
	Bytes       uint64  `json:"bytes"`
	DurationMs  int64   `json:"durationMs"`
	Mbps        float64 `json:"mbps"`
	PeakMbps    float64 `json:"peakMbps"`
	Packets     uint64  `json:"packets,omitempty"`
	SentPackets uint64  `json:"sentPackets,omitempty"`
	LostPackets uint64  `json:"lostPackets,omitempty"`
	LossPercent float64 `json:"lossPercent,omitempty"`
	JitterMs    float64 `json:"jitterMs,omitempty"`
}
type speedMeter struct {
	start     time.Time
	last      time.Time
	bytes     uint64
	lastBytes uint64
	peak      float64
	direction string
	emit      func(speedSample)
}

func newSpeedMeter(direction string, emit func(speedSample)) *speedMeter {
	now := time.Now()
	return &speedMeter{start: now, last: now, direction: direction, emit: emit}
}
func (m *speedMeter) add(n int) {
	m.bytes += uint64(n)
	if time.Since(m.last) >= 500*time.Millisecond {
		m.sample()
	}
}
func (m *speedMeter) sample() {
	now := time.Now()
	elapsed := now.Sub(m.last).Seconds()
	if elapsed <= 0 {
		return
	}
	mbps := float64(m.bytes-m.lastBytes) * 8 / elapsed / 1e6
	if mbps > m.peak {
		m.peak = mbps
	}
	if m.emit != nil {
		m.emit(speedSample{Direction: m.direction, ElapsedMs: now.Sub(m.start).Milliseconds(), Bytes: m.bytes, Mbps: mbps})
	}
	m.last = now
	m.lastBytes = m.bytes
}
func (m *speedMeter) result() speedMeasurement {
	m.sample()
	duration := time.Since(m.start).Milliseconds()
	if duration < 1 {
		duration = 1
	}
	return speedMeasurement{Bytes: m.bytes, DurationMs: duration, Mbps: float64(m.bytes) * 8 / float64(duration) / 1000, PeakMbps: m.peak}
}

type speedTCPUpdate struct {
	Sample *speedSample      `json:"sample,omitempty"`
	Result *speedMeasurement `json:"result,omitempty"`
}

// Framed payloads have an explicit terminator so TLS/proxy half-close behavior
// cannot truncate the upload result or leave the receiver waiting for EOF.
func writeSpeedFrame(conn net.Conn, data []byte) error {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(data)))
	buffers := net.Buffers{length[:], data}
	_, err := buffers.WriteTo(conn)
	return err
}
func readSpeedFrames(conn net.Conn, meter *speedMeter) error {
	buffer := make([]byte, 64*1024)
	var length [4]byte
	for {
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			return err
		}
		n := binary.BigEndian.Uint32(length[:])
		if n == 0 {
			return nil
		}
		if n > uint32(len(buffer)) {
			return errors.New("invalid speed payload frame")
		}
		read, err := io.ReadFull(conn, buffer[:n])
		meter.add(read)
		if err != nil {
			return err
		}
	}
}
func sendSpeedFrames(ctx context.Context, conn net.Conn, duration time.Duration, rateMbps float64) error {
	data := speedPayload(speedFrameSize(rateMbps))
	started := time.Now()
	var total uint64
	for time.Since(started) < duration {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := writeSpeedFrame(conn, data); err != nil {
			return err
		}
		total += uint64(len(data))
		if rateMbps > 0 {
			wait := time.Duration(float64(total) * 8 / rateMbps / 1e6 * float64(time.Second))
			if err := speedWait(ctx, started.Add(wait)); err != nil {
				return err
			}
		}
	}
	return writeSpeedFrame(conn, nil)
}

// Low rate limits use smaller frames (about 50 ms of payload) so pacing stays
// smooth and half-second samples do not read as bursts above the limit.
func speedFrameSize(rateMbps float64) int {
	const largest = 64 * 1024
	if rateMbps <= 0 {
		return largest
	}
	size := int(rateMbps * 1e6 / 8 / 20)
	if size >= largest {
		return largest
	}
	if size < 1024 {
		return 1024
	}
	return size
}
func serveSpeedTCP(ctx context.Context, task linkSpeedTask, conn net.Conn) {
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	_ = conn.SetDeadline(time.Now().Add(time.Duration(task.Duration+12) * time.Second))
	var header [65]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return
	}
	if subtle.ConstantTimeCompare(header[:64], []byte(task.Token)) != 1 {
		return
	}
	if _, err := conn.Write([]byte{1}); err != nil {
		return
	}
	switch header[64] {
	case 'U':
		encoder := json.NewEncoder(conn)
		var writeErr error
		meter := newSpeedMeter("upload", func(sample speedSample) {
			if writeErr == nil {
				writeErr = encoder.Encode(speedTCPUpdate{Sample: &sample})
			}
		})
		if readSpeedFrames(conn, meter) != nil {
			return
		}
		result := meter.result()
		_ = encoder.Encode(speedTCPUpdate{Result: &result})
	case 'D':
		_ = sendSpeedFrames(ctx, conn, time.Duration(task.Duration)*time.Second, task.RateMbps)
	}
}
func runSpeedTCP(ctx context.Context, task linkSpeedTask, direction string, emit func(speedSample)) (speedMeasurement, error) {
	var zero speedMeasurement
	if !speedAddressValid(task.Target) {
		return zero, errors.New("invalid test target")
	}
	var conn net.Conn
	var err error
	// Listeners on remote Agents may still be completing their runtime startup.
	for attempt := 0; attempt < 5; attempt++ {
		conn, err = (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", task.Target)
		if err == nil {
			break
		}
		if speedWait(ctx, time.Now().Add(300*time.Millisecond)) != nil {
			return zero, ctx.Err()
		}
	}
	if err != nil {
		return zero, err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	_ = conn.SetDeadline(time.Now().Add(time.Duration(task.Duration+15) * time.Second))
	operation := byte('U')
	if direction == "download" {
		operation = 'D'
	}
	if _, err = io.WriteString(conn, task.Token+string(operation)); err != nil {
		return zero, err
	}
	var ack [1]byte
	if _, err = io.ReadFull(conn, ack[:]); err != nil || ack[0] != 1 {
		return zero, fmt.Errorf("链路接收端无响应，请检查临时端口连通性: %v", err)
	}
	if direction == "download" {
		meter := newSpeedMeter(direction, emit)
		if err := readSpeedFrames(conn, meter); err != nil {
			return zero, err
		}
		return meter.result(), nil
	}
	decoder := json.NewDecoder(conn)
	done := make(chan struct {
		result speedMeasurement
		err    error
	}, 1)
	go func() {
		for {
			var update speedTCPUpdate
			if err := decoder.Decode(&update); err != nil {
				done <- struct {
					result speedMeasurement
					err    error
				}{zero, err}
				return
			}
			if update.Sample != nil {
				emit(*update.Sample)
			}
			if update.Result != nil {
				done <- struct {
					result speedMeasurement
					err    error
				}{*update.Result, nil}
				return
			}
		}
	}()
	if err := sendSpeedFrames(ctx, conn, time.Duration(task.Duration)*time.Second, task.RateMbps); err != nil {
		return zero, err
	}
	select {
	case result := <-done:
		return result.result, result.err
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}
