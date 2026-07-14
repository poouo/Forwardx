//go:build !linux

package main

import (
	"net"
	"strconv"
)

func listenTCP(host string, port int, _ bool) (net.Listener, error) {
	return net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
}
