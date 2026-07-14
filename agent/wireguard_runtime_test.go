package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

func testWireGuardKeyPair(t *testing.T) (string, string) {
	t.Helper()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	raw[0] &= 248
	raw[31] &= 127
	raw[31] |= 64
	privateKey, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(raw), hex.EncodeToString(privateKey.PublicKey().Bytes())
}

func testUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	port := conn.LocalAddr().(*net.UDPAddr).Port
	_ = conn.Close()
	return port
}

func TestWireGuardRuntimeTCPAndUDPProxy(t *testing.T) {
	leftPrivate, leftPublic := testWireGuardKeyPair(t)
	rightPrivate, rightPublic := testWireGuardKeyPair(t)
	rightWirePort := testUDPPort(t)

	tcpBackend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	servicePort := tcpBackend.Addr().(*net.TCPAddr).Port
	defer tcpBackend.Close()
	go func() {
		for {
			connection, err := tcpBackend.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				_, _ = io.Copy(connection, connection)
			}()
		}
	}()

	udpBackend, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: servicePort})
	if err != nil {
		t.Fatal(err)
	}
	defer udpBackend.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := udpBackend.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = udpBackend.WriteToUDP(buf[:n], addr)
		}
	}()

	right, err := newWireGuardRuntime(wireGuardSpec{
		TunnelID:   901,
		PrivateKey: rightPrivate,
		PublicKey:  rightPublic,
		Address:    "100.100.0.2",
		ListenPort: rightWirePort,
		MTU:        1380,
		Peers: []wireGuardPeerSpec{{
			ID: "1", HostID: 1, PublicKey: leftPublic, Address: "100.100.0.1",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer right.close()
	if err := right.ensureInboundProxy(servicePort, servicePort); err != nil {
		t.Fatal(err)
	}

	left, err := newWireGuardRuntime(wireGuardSpec{
		TunnelID:   901,
		PrivateKey: leftPrivate,
		PublicKey:  leftPublic,
		Address:    "100.100.0.1",
		MTU:        1380,
		Peers: []wireGuardPeerSpec{{
			ID: "2", HostID: 2, PublicKey: rightPublic, Address: "100.100.0.2",
			EndpointHost: "127.0.0.1", EndpointPort: rightWirePort, PersistentKeepalive: 25,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer left.close()

	_, localTCPPort, localUDPPort, err := left.ensureOutboundProxy("2", servicePort, servicePort)
	if err != nil {
		t.Fatal(err)
	}

	tcpClient, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(localTCPPort)), 8*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer tcpClient.Close()
	_ = tcpClient.SetDeadline(time.Now().Add(8 * time.Second))
	if _, err := tcpClient.Write([]byte("wireguard-tcp")); err != nil {
		t.Fatal(err)
	}
	tcpReply := make([]byte, len("wireguard-tcp"))
	if _, err := io.ReadFull(tcpClient, tcpReply); err != nil {
		t.Fatal(err)
	}
	if string(tcpReply) != "wireguard-tcp" {
		t.Fatalf("unexpected tcp reply %q", tcpReply)
	}

	udpClient, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: localUDPPort})
	if err != nil {
		t.Fatal(err)
	}
	defer udpClient.Close()
	_ = udpClient.SetDeadline(time.Now().Add(8 * time.Second))
	if _, err := udpClient.Write([]byte("wireguard-udp")); err != nil {
		t.Fatal(err)
	}
	udpReply := make([]byte, 64)
	n, err := udpClient.Read(udpReply)
	if err != nil {
		t.Fatal(err)
	}
	if string(udpReply[:n]) != "wireguard-udp" {
		t.Fatalf("unexpected udp reply %q", udpReply[:n])
	}
}
