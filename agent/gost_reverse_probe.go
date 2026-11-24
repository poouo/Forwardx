package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-gost/relay"
)

type reverseGostProbe struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	RouteID    string `json:"routeId"`
	CAFile     string `json:"caFile"`
	ServerName string `json:"serverName"`
}

func probeReverseGost(port int, probe reverseGostProbe, timeout time.Duration) probeMeasurement {
	result := probeMeasurement{ProbeCount: 1}
	id, err := hex.DecodeString(strings.ReplaceAll(probe.RouteID, "-", ""))
	if err != nil || len(id) != 16 {
		return result
	}
	pem, err := os.ReadFile(probe.CAFile)
	if err != nil {
		return result
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		return result
	}
	start := time.Now()
	dialer := &net.Dialer{Deadline: start.Add(timeout)}
	conn, err := tls.DialWithDialer(dialer, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), &tls.Config{
		RootCAs: roots, ServerName: probe.ServerName, MinVersion: tls.VersionTLS12,
	})
	if err != nil {
		return result
	}
	defer conn.Close()
	if err := conn.SetDeadline(dialer.Deadline); err != nil {
		return result
	}
	src := &relay.AddrFeature{}
	dst := &relay.AddrFeature{}
	_ = src.ParseFrom(conn.LocalAddr().String())
	_ = dst.ParseFrom("127.0.0.1:1")
	request := relay.Request{Version: relay.Version1, Cmd: relay.CmdConnect, Features: []relay.Feature{
		&relay.UserAuthFeature{Username: probe.Username, Password: probe.Password},
		src, dst, &relay.TunnelFeature{ID: relay.NewTunnelID(id)},
	}}
	if _, err := request.WriteTo(conn); err != nil {
		return result
	}
	var response relay.Response
	if _, err := response.ReadFrom(conn); err != nil || response.Version != relay.Version1 || response.Status != relay.StatusOK {
		return result
	}
	// Opening a mux stream can succeed before the exit sees it. The health
	// handler at the exit has no routes and rejects the second CONNECT.
	if _, err := request.WriteTo(conn); err != nil {
		return result
	}
	if _, err := response.ReadFrom(conn); err != nil || response.Version != relay.Version1 || response.Status != relay.StatusHostUnreachable {
		return result
	}
	result.Reachable = true
	result.ProbeSuccesses = 1
	result.LatencyMs = int(max(1, time.Since(start).Milliseconds()))
	return result
}
