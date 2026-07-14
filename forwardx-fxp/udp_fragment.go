package main

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

const (
	fxpUDPAuthTagSize            = 16
	fxpUDPMaxDatagramPayload     = 65507
	fxpUDPMaxSinglePayload       = 65507 - fxpUDPHeaderSize - fxpUDPAuthTagSize
	fxpUDPMaxWirePacketSize      = 1200
	fxpUDPFragmentPayloadSize    = fxpUDPMaxWirePacketSize - fxpUDPHeaderSize - fxpUDPAuthTagSize
	fxpUDPMaxFragments           = (fxpUDPMaxDatagramPayload + fxpUDPFragmentPayloadSize - 1) / fxpUDPFragmentPayloadSize
	fxpUDPFragmentTimeout        = 5 * time.Second
	fxpUDPMaxPendingFragmentSets = 8
)

type udpFragmentAssembly struct {
	fragments uint8
	chunks    [][]byte
	received  int
	total     int
	createdAt time.Time
}

type udpFragmentReassembler struct {
	mu      sync.Mutex
	pending map[uint64]*udpFragmentAssembly
}

func validFXPUDPFragmentMetadata(fragment, fragments uint8) bool {
	if fragments == 0 {
		return fragment == 0
	}
	return fragments >= 2 && int(fragments) <= fxpUDPMaxFragments && fragment < fragments
}

func fxpUDPFragmentCount(payloadSize int) (int, error) {
	if payloadSize < 0 || payloadSize > fxpUDPMaxDatagramPayload {
		return 0, fmt.Errorf("udp datagram payload too large: %d", payloadSize)
	}
	if payloadSize <= fxpUDPFragmentPayloadSize {
		return 1, nil
	}
	count := (payloadSize + fxpUDPFragmentPayloadSize - 1) / fxpUDPFragmentPayloadSize
	if count > fxpUDPMaxFragments {
		return 0, fmt.Errorf("udp datagram requires too many fragments: %d", count)
	}
	return count, nil
}

func nextFXPUDPSequence(counter *atomic.Uint64) (uint64, error) {
	if counter == nil {
		return 0, errors.New("invalid udp sequence counter")
	}
	for {
		current := counter.Load()
		if current == ^uint64(0) {
			return 0, errors.New("udp packet sequence exhausted")
		}
		if counter.CompareAndSwap(current, current+1) {
			return current + 1, nil
		}
	}
}

func sealFXPUDPDatagrams(packet fxpUDPPacket, key string, counter *atomic.Uint64) ([][]byte, error) {
	if packet.fragment != 0 || packet.fragments != 0 || packet.sequence != 0 {
		return nil, errors.New("udp datagram already has wire metadata")
	}
	count, err := fxpUDPFragmentCount(len(packet.payload))
	if err != nil {
		return nil, err
	}
	sequence, err := nextFXPUDPSequence(counter)
	if err != nil {
		return nil, err
	}
	frames := make([][]byte, 0, count)
	for index := 0; index < count; index++ {
		start := index * fxpUDPFragmentPayloadSize
		end := min(start+fxpUDPFragmentPayloadSize, len(packet.payload))
		fragment := packet
		fragment.sequence = sequence
		fragment.payload = packet.payload[start:end]
		if count > 1 {
			fragment.fragment = uint8(index)
			fragment.fragments = uint8(count)
		}
		sealed, err := sealFXPUDPPacket(fragment, key)
		if err != nil {
			return nil, err
		}
		if len(sealed) > fxpUDPMaxWirePacketSize {
			return nil, fmt.Errorf("sealed udp fragment exceeds wire limit: %d", len(sealed))
		}
		frames = append(frames, sealed)
	}
	return frames, nil
}

func (r *udpFragmentReassembler) accept(packet fxpUDPPacket, replay *udpReplayWindow) ([]byte, bool) {
	if replay == nil || !validFXPUDPFragmentMetadata(packet.fragment, packet.fragments) {
		return nil, false
	}
	if packet.fragments == 0 {
		if !replay.accept(packet.sequence) {
			return nil, false
		}
		return packet.payload, true
	}
	if len(packet.payload) == 0 || len(packet.payload) > fxpUDPFragmentPayloadSize {
		return nil, false
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.expireLocked(now)
	assembly := r.pending[packet.sequence]
	if assembly == nil {
		if len(r.pending) >= fxpUDPMaxPendingFragmentSets {
			r.evictOldestLocked()
		}
		if r.pending == nil {
			r.pending = make(map[uint64]*udpFragmentAssembly)
		}
		assembly = &udpFragmentAssembly{
			fragments: packet.fragments,
			chunks:    make([][]byte, int(packet.fragments)),
			createdAt: now,
		}
		r.pending[packet.sequence] = assembly
	} else if assembly.fragments != packet.fragments {
		delete(r.pending, packet.sequence)
		return nil, false
	}

	index := int(packet.fragment)
	if assembly.chunks[index] != nil {
		return nil, false
	}
	assembly.total += len(packet.payload)
	if assembly.total > fxpUDPMaxDatagramPayload {
		delete(r.pending, packet.sequence)
		return nil, false
	}
	assembly.chunks[index] = packet.payload
	assembly.received++
	if assembly.received != int(assembly.fragments) {
		return nil, false
	}
	delete(r.pending, packet.sequence)
	if !replay.accept(packet.sequence) {
		return nil, false
	}
	payload := make([]byte, assembly.total)
	offset := 0
	for _, chunk := range assembly.chunks {
		offset += copy(payload[offset:], chunk)
	}
	return payload, true
}

func (r *udpFragmentReassembler) expireLocked(now time.Time) {
	for sequence, assembly := range r.pending {
		if now.Sub(assembly.createdAt) >= fxpUDPFragmentTimeout {
			delete(r.pending, sequence)
		}
	}
}

func (r *udpFragmentReassembler) evictOldestLocked() {
	var oldestSequence uint64
	var oldestTime time.Time
	for sequence, assembly := range r.pending {
		if oldestTime.IsZero() || assembly.createdAt.Before(oldestTime) {
			oldestSequence = sequence
			oldestTime = assembly.createdAt
		}
	}
	if !oldestTime.IsZero() {
		delete(r.pending, oldestSequence)
	}
}
