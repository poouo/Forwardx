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

type fxpUDPSequenceSeedAllocator struct {
	last atomic.Uint64
}

var fxpUDPDefaultSequenceSeeds fxpUDPSequenceSeedAllocator

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
	budget  *fxpUDPQueueRuleBudget
	closed  atomic.Bool
}

func (r *udpFragmentReassembler) bindBudget(budget *fxpUDPQueueRuleBudget) {
	r.setBudget(budget)
}

func (r *udpFragmentReassembler) setBudget(budget *fxpUDPQueueRuleBudget) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.budget == budget {
		return
	}
	r.clearLocked()
	r.budget = budget
}

func (r *udpFragmentReassembler) clear() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.clearLocked()
	r.mu.Unlock()
}

func (r *udpFragmentReassembler) close() {
	if r == nil {
		return
	}
	r.closed.Store(true)
	r.mu.Lock()
	r.clearLocked()
	r.mu.Unlock()
}

func (r *udpFragmentReassembler) expire(now time.Time) {
	if r == nil || r.closed.Load() {
		return
	}
	r.mu.Lock()
	if !r.closed.Load() {
		r.expireLocked(now)
	}
	r.mu.Unlock()
}

func (r *udpFragmentReassembler) pendingCount() int {
	if r == nil || r.closed.Load() {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending)
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

func (a *fxpUDPSequenceSeedAllocator) next(now time.Time) (uint64, error) {
	if a == nil {
		return 0, errors.New("invalid udp sequence seed allocator")
	}
	nanos := now.UnixNano()
	if nanos <= 0 {
		return 0, errors.New("udp sequence seed time out of range")
	}
	candidate := uint64(nanos)
	for {
		last := a.last.Load()
		if candidate <= last {
			if last == ^uint64(0) {
				return 0, errors.New("udp sequence seed exhausted")
			}
			candidate = last + 1
		}
		if a.last.CompareAndSwap(last, candidate) {
			return candidate, nil
		}
	}
}

func (a *fxpUDPSequenceSeedAllocator) observe(sequence uint64) {
	if a == nil || sequence == 0 {
		return
	}
	for {
		last := a.last.Load()
		if sequence <= last || a.last.CompareAndSwap(last, sequence) {
			return
		}
	}
}

func allocateFXPUDPSequenceSeed() (uint64, error) {
	return fxpUDPDefaultSequenceSeeds.next(time.Now())
}

func observeFXPUDPSequence(counter *atomic.Uint64) {
	if counter != nil {
		fxpUDPDefaultSequenceSeeds.observe(counter.Load())
	}
}

func sealFXPUDPDatagrams(packet fxpUDPPacket, key string, counter *atomic.Uint64) ([][]byte, error) {
	if packet.fragment != 0 || packet.fragments != 0 || packet.sequence != 0 {
		return nil, errors.New("udp datagram already has wire metadata")
	}
	codec, err := newFXPUDPCodec(key, packet)
	if err != nil {
		return nil, err
	}
	return sealFXPUDPDatagramsWithCodec(packet, codec, counter)
}

func sealFXPUDPDatagramsWithCodec(packet fxpUDPPacket, codec *fxpUDPCodec, counter *atomic.Uint64) ([][]byte, error) {
	if packet.fragment != 0 || packet.fragments != 0 || packet.sequence != 0 {
		return nil, errors.New("udp datagram already has wire metadata")
	}
	if codec == nil || !codec.matches(packet) {
		return nil, errors.New("udp datagram does not match cached encryption context")
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
		sealed, err := codec.sealPacket(fragment)
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
	if r == nil || r.closed.Load() || replay == nil || !validFXPUDPFragmentMetadata(packet.fragment, packet.fragments) {
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
	if r.closed.Load() {
		return nil, false
	}
	now := time.Now()
	r.expireLocked(now)
	assembly := r.pending[packet.sequence]
	newAssembly := assembly == nil
	if assembly == nil {
		if len(r.pending) >= fxpUDPMaxPendingFragmentSets {
			r.evictOldestLocked()
		}
		assembly = &udpFragmentAssembly{
			fragments: packet.fragments,
			chunks:    make([][]byte, int(packet.fragments)),
			createdAt: now,
		}
	} else if assembly.fragments != packet.fragments {
		r.removeAssemblyLocked(packet.sequence)
		return nil, false
	}

	index := int(packet.fragment)
	if assembly.chunks[index] != nil {
		return nil, false
	}
	if assembly.total+len(packet.payload) > fxpUDPMaxDatagramPayload {
		if !newAssembly {
			r.removeAssemblyLocked(packet.sequence)
		}
		return nil, false
	}
	if r.budget != nil && !r.budget.reserve(len(packet.payload)) {
		if !newAssembly {
			r.removeAssemblyLocked(packet.sequence)
		}
		return nil, false
	}
	if newAssembly {
		if r.pending == nil {
			r.pending = make(map[uint64]*udpFragmentAssembly)
		}
		r.pending[packet.sequence] = assembly
	}
	assembly.total += len(packet.payload)
	assembly.chunks[index] = packet.payload
	assembly.received++
	if assembly.received != int(assembly.fragments) {
		return nil, false
	}
	r.removeAssemblyLocked(packet.sequence)
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
			r.removeAssemblyLocked(sequence)
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
		r.removeAssemblyLocked(oldestSequence)
	}
}

func (r *udpFragmentReassembler) removeAssemblyLocked(sequence uint64) {
	assembly := r.pending[sequence]
	if assembly == nil {
		return
	}
	delete(r.pending, sequence)
	if r.budget != nil {
		r.budget.release(assembly.total)
	}
}

func (r *udpFragmentReassembler) clearLocked() {
	for sequence := range r.pending {
		r.removeAssemblyLocked(sequence)
	}
	r.pending = nil
}
