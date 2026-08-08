package main

import "sync"

// The Agent has a few in-process proxy paths. Reuse their fixed-size copy
// buffers in the same way gost does, but do not pool allocations above a UDP
// datagram so unusual payloads cannot become permanent process high water.
type agentBytePool struct {
	size int
	pool sync.Pool
}

func newAgentBytePool(size int) agentBytePool {
	return agentBytePool{
		size: size,
		pool: sync.Pool{New: func() any { return make([]byte, size) }},
	}
}

var agentBytePools = []agentBytePool{
	newAgentBytePool(32 * 1024),
	newAgentBytePool(65 * 1024),
}

func getAgentByteBuffer(size int) []byte {
	if size <= 0 {
		return nil
	}
	for i := range agentBytePools {
		if size <= agentBytePools[i].size {
			buffer := agentBytePools[i].pool.Get().([]byte)
			return buffer[:size]
		}
	}
	return make([]byte, size)
}

func putAgentByteBuffer(buffer []byte) {
	if len(buffer) == 0 {
		return
	}
	capacity := cap(buffer)
	for i := range agentBytePools {
		if capacity == agentBytePools[i].size {
			agentBytePools[i].pool.Put(buffer[:capacity])
			return
		}
	}
}
