package main

import (
	"encoding/hex"
	"testing"
)

func TestRustInteropUDPVector(t *testing.T) {
	packet, err := sealFXPUDPPacket(fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   8000,
		ruleID:     8001,
		sessionID:  0x0102030405060708,
		sequence:   1,
		payload:    []byte("forwardx-rust-udp"),
	}, "rust-interop-key")
	if err != nil {
		t.Fatal(err)
	}
	const rustVector = "465850550301000000001f4000001f4101020304050607080000000000000001a338daf35a62369ec293b6ab0dfba6c4231885ee6f20a7bd57fafd4fbe3913810c"
	if encoded := hex.EncodeToString(packet); encoded != rustVector {
		t.Fatalf("Go UDP packet no longer matches the Rust wire vector: %s", encoded)
	}
}
