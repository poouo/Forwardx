//go:build linux

package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"net/netip"
	"syscall"

	"golang.org/x/sys/unix"
)

type udpReplyPacketConn struct {
	*net.UDPConn
	oob []byte // ReadFrom has one reader, just like the guard's receive loop.
}

func listenUDPReplyConn(network, address string) (net.PacketConn, error) {
	// Enable packet info before bind, so packets arriving as the listener
	// starts cannot be queued without their destination metadata.
	config := net.ListenConfig{Control: configureUDPReplySocket}
	conn, err := config.ListenPacket(context.Background(), network, address)
	if err != nil {
		return nil, err
	}
	udp, ok := conn.(*net.UDPConn)
	if !ok {
		_ = conn.Close()
		return nil, fmt.Errorf("UDP packet info requires a UDP socket")
	}
	return &udpReplyPacketConn{
		UDPConn: udp,
		oob:     make([]byte, unix.CmsgSpace(unix.SizeofInet4Pktinfo)+unix.CmsgSpace(unix.SizeofInet6Pktinfo)),
	}, nil
}

func configureUDPReplySocket(network, _ string, raw syscall.RawConn) error {
	var optionErr error
	err := raw.Control(func(fd uintptr) {
		// Linux supports IP_PKTINFO on dual-stack IPv6 sockets too. Enable
		// both families so IPv4-mapped packets retain their destination.
		optionErr = unix.SetsockoptInt(int(fd), unix.IPPROTO_IP, unix.IP_PKTINFO, 1)
		if optionErr == nil && network == "udp6" {
			optionErr = unix.SetsockoptInt(int(fd), unix.IPPROTO_IPV6, unix.IPV6_RECVPKTINFO, 1)
		}
	})
	if err != nil {
		return err
	}
	if optionErr != nil {
		return fmt.Errorf("enable UDP reply packet info: %w", optionErr)
	}
	return nil
}

func (conn *udpReplyPacketConn) ReadFrom(buf []byte) (int, net.Addr, error) {
	n, oobn, flags, peer, err := conn.ReadMsgUDP(buf, conn.oob)
	if err != nil {
		return n, peer, err
	}
	if flags&unix.MSG_CTRUNC != 0 {
		return 0, nil, fmt.Errorf("UDP reply packet info truncated")
	}
	addr, err := parseUDPReplyAddr(peer, conn.oob[:oobn])
	return n, addr, err
}

func parseUDPReplyAddr(peer *net.UDPAddr, oob []byte) (*udpReplyAddr, error) {
	messages, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return nil, err
	}
	addr := &udpReplyAddr{Addr: peer}
	for _, message := range messages {
		switch {
		case message.Header.Level == unix.IPPROTO_IP && message.Header.Type == unix.IP_PKTINFO && len(message.Data) >= unix.SizeofInet4Pktinfo:
			// in_pktinfo: ifindex, spec_dst, addr. spec_dst is the local
			// unicast destination, also safe when receiving a broadcast.
			addr.localIP = netip.AddrFrom4([4]byte(message.Data[4:8]))
			// Do not pin an interface: preserve routing to the client.
			addr.ifIndex = 0
			return addr, nil
		case message.Header.Level == unix.IPPROTO_IPV6 && message.Header.Type == unix.IPV6_PKTINFO && len(message.Data) >= unix.SizeofInet6Pktinfo:
			addr.localIP = netip.AddrFrom16([16]byte(message.Data[:16])).Unmap()
			if addr.localIP.Is6() && (addr.localIP.IsLinkLocalUnicast() || addr.localIP.IsMulticast()) {
				addr.ifIndex = int(binary.NativeEndian.Uint32(message.Data[16:20]))
			}
		}
	}
	if !addr.localIP.IsValid() {
		return nil, fmt.Errorf("UDP destination packet info missing")
	}
	return addr, nil
}

func (conn *udpReplyPacketConn) WriteTo(buf []byte, addr net.Addr) (int, error) {
	reply, ok := addr.(*udpReplyAddr)
	if !ok {
		return conn.UDPConn.WriteTo(buf, addr)
	}
	peer, ok := reply.Addr.(*net.UDPAddr)
	if !ok {
		return 0, fmt.Errorf("invalid UDP reply peer %T", reply.Addr)
	}
	var oob []byte
	if reply.localIP.Is4() {
		oob = unix.PktInfo4(&unix.Inet4Pktinfo{Spec_dst: reply.localIP.As4()})
	} else if reply.localIP.Is6() {
		info := unix.Inet6Pktinfo{Ifindex: uint32(reply.ifIndex)}
		if !reply.localIP.IsMulticast() {
			info.Addr = reply.localIP.As16()
		}
		oob = unix.PktInfo6(&info)
	} else {
		return 0, fmt.Errorf("invalid UDP reply source")
	}
	n, _, err := conn.WriteMsgUDP(buf, oob, peer)
	return n, err
}
