package main

import "testing"

func TestFXPByteBufferPoolUsesSmallestTier(t *testing.T) {
	buffer := getFXPByteBuffer(33 * 1024)
	if len(buffer) != 33*1024 || cap(buffer) != 64*1024 {
		t.Fatalf("unexpected pooled buffer len=%d cap=%d", len(buffer), cap(buffer))
	}
	putFXPByteBuffer(buffer)
}

func TestFXPByteBufferPoolDoesNotRetainOversizedFrames(t *testing.T) {
	const size = 66 * 1024
	buffer := getFXPByteBuffer(size)
	if len(buffer) != size || cap(buffer) != size {
		t.Fatalf("unexpected oversized buffer len=%d cap=%d", len(buffer), cap(buffer))
	}
	putFXPByteBuffer(buffer)
}

func TestFXPByteBufferPoolHasBoundedRetainedSlots(t *testing.T) {
	pool := newFXPBytePool(1024)
	for i := 0; i < fxpBytePoolSlots*2; i++ {
		select {
		case pool.pool <- make([]byte, pool.size):
		default:
		}
	}
	if got := len(pool.pool); got != fxpBytePoolSlots {
		t.Fatalf("retained buffers = %d, want bounded capacity %d", got, fxpBytePoolSlots)
	}
}
