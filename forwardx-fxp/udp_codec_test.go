package main

import (
	"bytes"
	"sync/atomic"
	"testing"
)

var fxpUDPCodecWireSink []byte
var fxpUDPCodecPacketSink fxpUDPPacket

func TestFXPUDPCodecIsWireCompatibleAndRejectsTampering(t *testing.T) {
	const key = "udp-codec-compatibility-key"
	packet := fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   401,
		ruleID:     402,
		sessionID:  403,
		sequence:   404,
		payload:    []byte("cached-codec-payload"),
	}
	sealer, err := newFXPUDPCodec(key, packet)
	if err != nil {
		t.Fatal(err)
	}
	opener, err := newFXPUDPCodec(key, packet)
	if err != nil {
		t.Fatal(err)
	}

	cachedWire, err := sealer.sealPacket(packet)
	if err != nil {
		t.Fatal(err)
	}
	statelessWire, err := sealFXPUDPPacket(packet, key)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(cachedWire, statelessWire) {
		t.Fatal("cached codec changed the FXP UDP wire format")
	}

	statelessPacket, err := openFXPUDPPacket(cachedWire, key)
	if err != nil || !bytes.Equal(statelessPacket.payload, packet.payload) {
		t.Fatalf("stateless opener rejected cached wire packet: payload=%q err=%v", statelessPacket.payload, err)
	}
	cachedPacket, err := opener.openPacket(statelessWire)
	if err != nil || !bytes.Equal(cachedPacket.payload, packet.payload) {
		t.Fatalf("cached opener rejected stateless wire packet: payload=%q err=%v", cachedPacket.payload, err)
	}

	wrongDirection, err := newFXPUDPCodec(key, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   packet.tunnelID,
		ruleID:     packet.ruleID,
		sessionID:  packet.sessionID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrongDirection.openPacket(cachedWire); err == nil {
		t.Fatal("cached codec accepted a packet from the wrong direction")
	}

	tamperedHeader := append([]byte(nil), cachedWire...)
	tamperedHeader[15] ^= 0x01
	if _, err := opener.openPacket(tamperedHeader); err == nil {
		t.Fatal("cached codec accepted a tampered header")
	}
	tamperedCiphertext := append([]byte(nil), cachedWire...)
	tamperedCiphertext[len(tamperedCiphertext)-1] ^= 0x01
	if _, err := opener.openPacket(tamperedCiphertext); err == nil {
		t.Fatal("cached codec accepted tampered ciphertext")
	}
}

func TestFXPUDPCodecPreservesMultiFragmentReassembly(t *testing.T) {
	const key = "udp-codec-fragment-key"
	packet := fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   411,
		ruleID:     412,
		sessionID:  413,
		payload:    bytes.Repeat([]byte("game-state-"), 4096),
	}
	codec, err := newFXPUDPCodec(key, packet)
	if err != nil {
		t.Fatal(err)
	}
	var cachedSequence atomic.Uint64
	cachedFrames, err := sealFXPUDPDatagramsWithCodec(packet, codec, &cachedSequence)
	if err != nil {
		t.Fatal(err)
	}
	var statelessSequence atomic.Uint64
	statelessFrames, err := sealFXPUDPDatagrams(packet, key, &statelessSequence)
	if err != nil {
		t.Fatal(err)
	}
	if len(cachedFrames) <= 1 || len(cachedFrames) != len(statelessFrames) {
		t.Fatalf("fragment counts cached=%d stateless=%d", len(cachedFrames), len(statelessFrames))
	}
	for i := range cachedFrames {
		if !bytes.Equal(cachedFrames[i], statelessFrames[i]) {
			t.Fatalf("cached codec changed fragment %d", i)
		}
	}

	var reassembler udpFragmentReassembler
	var replay udpReplayWindow
	var reassembled []byte
	for i := len(cachedFrames) - 1; i >= 0; i-- {
		fragment, err := codec.openPacket(cachedFrames[i])
		if err != nil {
			t.Fatalf("open fragment %d: %v", i, err)
		}
		if payload, ok := reassembler.accept(fragment, &replay); ok {
			reassembled = payload
		}
	}
	if !bytes.Equal(reassembled, packet.payload) {
		t.Fatalf("cached codec reassembly mismatch: got=%d want=%d", len(reassembled), len(packet.payload))
	}
}

func TestFXPUDPCodecReducesPerPacketAllocations(t *testing.T) {
	const key = "udp-codec-allocation-key"
	packet := fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   421,
		ruleID:     422,
		sessionID:  423,
		sequence:   424,
		payload:    []byte("allocation-check-payload"),
	}
	codec, err := newFXPUDPCodec(key, packet)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := codec.sealPacket(packet)
	if err != nil {
		t.Fatal(err)
	}

	cachedSeal := testing.AllocsPerRun(1000, func() {
		fxpUDPCodecWireSink, _ = codec.sealPacket(packet)
	})
	statelessSeal := testing.AllocsPerRun(1000, func() {
		fxpUDPCodecWireSink, _ = sealFXPUDPPacket(packet, key)
	})
	cachedOpen := testing.AllocsPerRun(1000, func() {
		fxpUDPCodecPacketSink, _ = codec.openPacket(wire)
	})
	statelessOpen := testing.AllocsPerRun(1000, func() {
		fxpUDPCodecPacketSink, _ = openFXPUDPPacket(wire, key)
	})
	t.Logf("allocations per packet: seal cached=%.1f stateless=%.1f, open cached=%.1f stateless=%.1f", cachedSeal, statelessSeal, cachedOpen, statelessOpen)
	if cachedSeal >= statelessSeal {
		t.Fatalf("cached seal allocations %.1f, want less than stateless %.1f", cachedSeal, statelessSeal)
	}
	if cachedOpen >= statelessOpen {
		t.Fatalf("cached open allocations %.1f, want less than stateless %.1f", cachedOpen, statelessOpen)
	}
}
