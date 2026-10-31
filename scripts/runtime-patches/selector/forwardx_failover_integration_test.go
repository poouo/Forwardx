package selector_test

import (
	"context"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-gost/core/chain"
	xchain "github.com/go-gost/x/chain"
	"github.com/go-gost/x/config"
	parser "github.com/go-gost/x/config/parsing/selector"
	"github.com/go-gost/x/hop"
	"github.com/go-gost/x/logger"
)

// Exercise the real config parser, hop, route and upstream failure markers, not
// just an isolated replacement strategy. No external servers are involved.
type failoverTestTransport struct {
	chain.Transporter
	available atomic.Bool
	dials     atomic.Int64
}

func (tr *failoverTestTransport) Dial(ctx context.Context, _ string) (net.Conn, error) {
	tr.dials.Add(1)
	if !tr.available.Load() {
		return nil, errors.New("simulated offline upstream")
	}
	client, server := net.Pipe()
	go func() {
		defer server.Close()
		io.Copy(server, server)
	}()
	return client, nil
}

func (*failoverTestTransport) Handshake(_ context.Context, conn net.Conn) (net.Conn, error) {
	return conn, nil
}
func (*failoverTestTransport) Connect(_ context.Context, conn net.Conn, _, _ string) (net.Conn, error) {
	return conn, nil
}
func (*failoverTestTransport) Multiplex() bool { return false }

func TestForwardXParsedFailoverRoutes(t *testing.T) {
	for _, strategy := range []string{"fifo", "ha"} {
		t.Run(strategy, func(t *testing.T) {
			primary, fallback := &failoverTestTransport{}, &failoverTestTransport{}
			fallback.available.Store(true)
			nodes := []*chain.Node{
				chain.NewNode("offline", "127.0.0.1:1", chain.TransportNodeOption(primary)),
				chain.NewNode("online", "127.0.0.1:2", chain.TransportNodeOption(fallback)),
			}
			h := hop.NewHop(hop.NodeOption(nodes...), hop.SelectorOption(parser.ParseNodeSelector(&config.SelectorConfig{
				Strategy: strategy, MaxFails: 1, FailTimeout: time.Nanosecond,
			})))
			defer h.(io.Closer).Close()
			c := xchain.NewChain("regression")
			c.AddHop(h)
			dial := func() error {
				route := c.Route(context.Background(), "tcp", "127.0.0.1:3")
				if route == nil || len(route.Nodes()) != 1 {
					t.Fatal("required upstream disappeared from the route")
				}
				conn, err := route.Dial(context.Background(), "tcp", "127.0.0.1:3", chain.LoggerDialOption(logger.Nop()))
				if err == nil {
					defer conn.Close()
					conn.SetDeadline(time.Now().Add(time.Second))
					if _, err = conn.Write([]byte("ok")); err != nil {
						return err
					}
					_, err = io.ReadFull(conn, make([]byte, 2))
				}
				return err
			}
			if dial() == nil {
				t.Fatal("initial offline primary must fail and mark the real node")
			}
			for i := 0; i < 100; i++ {
				if err := dial(); err != nil {
					t.Fatalf("business request %d retried an offline primary: %v", i, err)
				}
			}
			if primary.dials.Load() != 1 || fallback.dials.Load() != 100 {
				t.Fatal("dead primary was reinstated without recovery")
			}
			// All-down retries must retain the hop and eventually recover when a
			// previously failed node comes back. No payload is replayed by selector.
			fallback.available.Store(false)
			if dial() == nil {
				t.Fatal("fallback should now fail")
			}
			primary.available.Store(true)
			recovered := false
			for i := 0; i < 2; i++ {
				if dial() == nil {
					recovered = true
					break
				}
			}
			if !recovered {
				t.Fatal("all-down retry never reached recovered primary")
			}
		})
	}
}
