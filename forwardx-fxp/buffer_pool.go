package main

// FXP uses a small tiered pool for the short-lived buffers used by the data
// path.  This follows gost's bufpool pattern: common packet/frame sizes are
// reused, while unusually large frames are allocated normally and are not
// retained by the process. Use bounded channels instead of sync.Pool so a
// source-address burst cannot leave one 65 KiB buffer per historical session
// behind until a future GC cycle.
const fxpBytePoolSlots = 32

type fxpBytePool struct {
	size int
	pool chan []byte
}

func newFXPBytePool(size int) fxpBytePool {
	if size <= 0 {
		size = 1
	}
	return fxpBytePool{
		size: size,
		pool: make(chan []byte, fxpBytePoolSlots),
	}
}

var fxpBytePools = []fxpBytePool{
	newFXPBytePool(4 * 1024),
	newFXPBytePool(8 * 1024),
	newFXPBytePool(16 * 1024),
	newFXPBytePool(32 * 1024),
	newFXPBytePool(64 * 1024),
	newFXPBytePool(65 * 1024),
}

func getFXPByteBuffer(size int) []byte {
	if size <= 0 {
		return nil
	}
	for i := range fxpBytePools {
		if size <= fxpBytePools[i].size {
			select {
			case buffer := <-fxpBytePools[i].pool:
				return buffer[:size]
			default:
				return make([]byte, fxpBytePools[i].size)[:size]
			}
		}
	}
	return make([]byte, size)
}

func putFXPByteBuffer(buffer []byte) {
	if len(buffer) == 0 {
		return
	}
	capacity := cap(buffer)
	for i := range fxpBytePools {
		if capacity != fxpBytePools[i].size {
			continue
		}
		select {
		case fxpBytePools[i].pool <- buffer[:capacity]:
		default:
			// The bounded pool is full. Let this buffer be reclaimed normally.
		}
		return
	}
}
