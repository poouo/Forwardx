package main

import (
	"sync/atomic"
)

type trafficCounter struct {
	in  atomic.Uint64
	out atomic.Uint64
}
