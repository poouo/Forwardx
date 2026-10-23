package main

import (
	"net"
	"net/netip"
	"strconv"
)

// Keep the local destination with the peer, rather than in a peer-IP cache:
// the same client socket can contact several addresses on one wildcard listener.
type udpReplyAddr struct {
	net.Addr
	localIP netip.Addr
	ifIndex int
}

func udpReplySessionKey(addr net.Addr) string {
	if reply, ok := addr.(*udpReplyAddr); ok {
		return reply.Addr.String() + "@" + reply.localIP.String() + "%" + strconv.Itoa(reply.ifIndex)
	}
	return addr.String()
}
