//go:build !linux

package main

import "net"

// Released Agents run on Linux. Keep development builds on other platforms
// working without claiming support for Linux packet-info socket options.
func listenUDPReplyConn(network, address string) (net.PacketConn, error) {
	return net.ListenPacket(network, address)
}
