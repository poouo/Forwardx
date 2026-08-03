package main

import (
	"bytes"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestFXPUDPSequenceSeedAllocatorIsMonotonicWithinTickAndRollback(t *testing.T) {
	var allocator fxpUDPSequenceSeedAllocator
	now := time.Unix(0, 10_000)

	first, err := allocator.next(now)
	if err != nil {
		t.Fatalf("allocate first seed: %v", err)
	}
	second, err := allocator.next(now)
	if err != nil {
		t.Fatalf("allocate same-tick seed: %v", err)
	}
	third, err := allocator.next(now.Add(-time.Nanosecond))
	if err != nil {
		t.Fatalf("allocate rollback seed: %v", err)
	}
	if second != first+1 || third != second+1 {
		t.Fatalf("seeds = %d, %d, %d; want consecutive monotonic values", first, second, third)
	}
}

func TestFXPUDPSequenceSeedAllocatorConcurrentAllocationsAreUniqueAndConsecutive(t *testing.T) {
	const allocations = 128
	var allocator fxpUDPSequenceSeedAllocator
	now := time.Unix(0, 50_000)
	seeds := make([]uint64, allocations)
	errs := make(chan error, allocations)
	var wg sync.WaitGroup

	for index := range seeds {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			seed, err := allocator.next(now)
			if err != nil {
				errs <- err
				return
			}
			seeds[index] = seed
		}(index)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("allocate concurrent seed: %v", err)
	}

	sort.Slice(seeds, func(i, j int) bool { return seeds[i] < seeds[j] })
	for index, seed := range seeds {
		want := uint64(now.UnixNano()) + uint64(index)
		if seed != want {
			t.Fatalf("sorted seed %d = %d, want %d", index, seed, want)
		}
	}
}

func TestFXPUDPSequenceSeedAllocatorObserveAdvancesNextSeed(t *testing.T) {
	var allocator fxpUDPSequenceSeedAllocator
	now := time.Unix(0, 75_000)
	observed := uint64(90_000)
	allocator.observe(observed)

	seed, err := allocator.next(now)
	if err != nil {
		t.Fatalf("allocate seed after observe: %v", err)
	}
	if seed != observed+1 {
		t.Fatalf("seed after observe = %d, want %d", seed, observed+1)
	}
}

func TestFXPUDPSequenceSeedAllocatorSurvivesClockRollback(t *testing.T) {
	var allocator fxpUDPSequenceSeedAllocator
	first, err := allocator.next(time.Unix(0, 10_000))
	if err != nil {
		t.Fatalf("allocate first seed: %v", err)
	}
	allocator.observe(first + 500)

	second, err := allocator.next(time.Unix(0, 5_000))
	if err != nil {
		t.Fatalf("allocate seed after clock rollback: %v", err)
	}
	if second != first+501 {
		t.Fatalf("seed after rollback = %d, want %d", second, first+501)
	}
}

func TestFXPUDPRecreatedSenderDoesNotReuseNonce(t *testing.T) {
	const key = "udp-sequence-recreation-test-key"
	packet := fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   41,
		ruleID:     73,
		sessionID:  9001,
		payload:    []byte("same encrypted response"),
	}
	codec, err := newFXPUDPCodec(key, packet)
	if err != nil {
		t.Fatalf("create codec: %v", err)
	}

	var allocator fxpUDPSequenceSeedAllocator
	firstSeed, err := allocator.next(time.Unix(0, 20_000))
	if err != nil {
		t.Fatalf("allocate first sender seed: %v", err)
	}
	var firstCounter atomic.Uint64
	firstCounter.Store(firstSeed)
	firstWire, err := sealFXPUDPDatagramsWithCodec(packet, codec, &firstCounter)
	if err != nil {
		t.Fatalf("seal first sender packet: %v", err)
	}
	allocator.observe(firstCounter.Load())

	secondSeed, err := allocator.next(time.Unix(0, 20_000))
	if err != nil {
		t.Fatalf("allocate recreated sender seed: %v", err)
	}
	var secondCounter atomic.Uint64
	secondCounter.Store(secondSeed)
	secondWire, err := sealFXPUDPDatagramsWithCodec(packet, codec, &secondCounter)
	if err != nil {
		t.Fatalf("seal recreated sender packet: %v", err)
	}

	firstOpened, err := codec.openPacket(firstWire[0])
	if err != nil {
		t.Fatalf("open first sender packet: %v", err)
	}
	secondOpened, err := codec.openPacket(secondWire[0])
	if err != nil {
		t.Fatalf("open recreated sender packet: %v", err)
	}
	if secondOpened.sequence <= firstOpened.sequence {
		t.Fatalf("recreated sequence = %d, want greater than %d", secondOpened.sequence, firstOpened.sequence)
	}
	if bytes.Equal(
		fxpUDPNonce(firstOpened.sequence, firstOpened.fragment),
		fxpUDPNonce(secondOpened.sequence, secondOpened.fragment),
	) {
		t.Fatal("recreated sender reused an AEAD nonce")
	}
	if bytes.Equal(firstWire[0], secondWire[0]) {
		t.Fatal("recreated sender produced identical authenticated wire packets")
	}

	var replay udpReplayWindow
	if !replay.accept(firstOpened.sequence) {
		t.Fatal("replay window rejected the original sender packet")
	}
	if !replay.accept(secondOpened.sequence) {
		t.Fatal("replay window rejected the recreated sender packet")
	}
	if replay.accept(firstOpened.sequence) {
		t.Fatal("replay window accepted the retired sender packet twice")
	}
}
