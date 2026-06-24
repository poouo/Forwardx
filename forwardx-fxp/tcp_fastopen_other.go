//go:build !linux

package main

import (
	"net"
	"strconv"
)

func listenTCP(port int, _ bool) (net.Listener, error) {
	return net.Listen("tcp", ":"+strconv.Itoa(port))
}
