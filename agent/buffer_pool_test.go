package main

import "testing"

func TestAgentByteBufferPoolUsesBoundedTiers(t *testing.T) {
	buffer := getAgentByteBuffer(33 * 1024)
	if len(buffer) != 33*1024 || cap(buffer) != 65*1024 {
		t.Fatalf("unexpected pooled buffer len=%d cap=%d", len(buffer), cap(buffer))
	}
	putAgentByteBuffer(buffer)

	const oversized = 66 * 1024
	buffer = getAgentByteBuffer(oversized)
	if len(buffer) != oversized || cap(buffer) != oversized {
		t.Fatalf("unexpected oversized buffer len=%d cap=%d", len(buffer), cap(buffer))
	}
	putAgentByteBuffer(buffer)
}
