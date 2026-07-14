package main

import (
	"context"
	"net"
	"strconv"
	"syscall"
)

const tcpFastOpenBacklog = 256

func listenTCP(host string, port int, fastOpen bool) (net.Listener, error) {
	address := net.JoinHostPort(host, strconv.Itoa(port))
	if !fastOpen {
		return net.Listen("tcp", address)
	}
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var controlErr error
			err := c.Control(func(fd uintptr) {
				controlErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, 23, tcpFastOpenBacklog)
			})
			if err != nil {
				return err
			}
			return controlErr
		},
	}
	ln, err := lc.Listen(context.Background(), "tcp", address)
	if err == nil {
		return ln, nil
	}
	return net.Listen("tcp", address)
}
