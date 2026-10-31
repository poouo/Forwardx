package selector

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/go-gost/core/chain"
	"github.com/go-gost/core/selector"
	mdutil "github.com/go-gost/x/metadata/util"
)

// ForwardXFailoverNodeSelector keeps known-failed nodes out of business traffic
// while an unfailed alternative exists. Upstream FailFilter alone reinstates a
// failed node after failTimeout, even without evidence that it has recovered.
// FIFO then repeatedly sends real connections to a dead, higher-priority node.
//
// Recovery is deliberately passive: do not preempt a working fallback merely
// because a timer expired. When every node has failed, bounded router retries
// can try failed nodes again. Always return an actual node in that case: nil
// means "bypass this hop" in upstream Chain.Route, NOT "fail closed".
func ForwardXFailoverNodeSelector(maxFails int, timeout time.Duration) selector.Selector[*chain.Node] {
	return &forwardXFailoverSelector{maxFails: maxFails, timeout: timeout}
}

type forwardXFailoverSelector struct {
	maxFails int
	timeout  time.Duration
	retry    uint64
}

func (s *forwardXFailoverSelector) Select(ctx context.Context, nodes ...*chain.Node) *chain.Node {
	var all, healthy []*chain.Node
	for _, node := range nodes {
		if node == nil {
			continue
		}
		all = append(all, node)
		maxFails := s.maxFails
		if md := node.Metadata(); md != nil && md.IsExists(labelMaxFails) {
			maxFails = mdutil.GetInt(md, labelMaxFails)
		}
		if maxFails <= 0 {
			maxFails = DefaultMaxFails
		}
		if marker := node.Marker(); marker == nil || marker.Count() < int64(maxFails) {
			healthy = append(healthy, node)
		}
	}
	if len(healthy) > 0 {
		return BackupFilter[*chain.Node]().Filter(ctx, healthy...)[0]
	}
	if len(all) == 0 {
		return nil
	}
	// Prefer failures whose exclusion window has expired; if all windows are
	// still open, keep the required hop and rotate retries rather than bypass it.
	candidates := FailFilter[*chain.Node](s.maxFails, s.timeout).Filter(ctx, all...)
	if len(candidates) == 0 {
		candidates = all
	}
	candidates = BackupFilter[*chain.Node]().Filter(ctx, candidates...)
	i := atomic.AddUint64(&s.retry, 1) - 1
	return candidates[i%uint64(len(candidates))]
}
