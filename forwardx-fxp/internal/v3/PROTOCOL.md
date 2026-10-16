# V3 implementation evidence / 实现依据

Status: **V3 inner handshake and record layer implemented; outer transports aligned
with the reference; multiplex sessions, pool health, endpoint failover and
backpressure wired into FXP. Panel selection still pending (separate change).**
V1/V2 are unchanged. This directory is built into the existing FXP module; it
does not introduce another executable.

Reference: user-supplied Linux amd64 node `zf-nc20260412`, SHA-256
`e432273ac9d7f29287989f6269ef5c9b8fc1080a365d2879a00973b60441f569`
(re-verified locally). Two independent analysis rounds are recorded in
`../nypass_temp/rea-analysis/`: the first used REA + Ghidra, the second
re-derived the wire facts with a self-written ELF/pclntab reader plus Capstone.
No sample code was executed.

## What V3 is now

```
business TCP/UDP
  -> FXP logical frame (4-byte length prefix)
  -> multiplex frame (type u8, stream ID u32 BE, length u16 BE)
  -> inner AEAD record (2-byte sealed length, sealed payload)
  -> outer transport (HTTP style / WS style / TLS)
  -> TCP
```

The inner record layer **replaces** the legacy FXP secure handshake on every V3
path, multiplexed or not. V3 no longer wraps the V1/V2 handshake.

## Implemented / 已实现

### Outer transport

- Request shape follows the recovered reference template
  `%s %s HTTP/1.1\r\nUser-Agent: %s\r\n` (literal at `0x104f501`). The reference
  sends **no Host header** on this path, so V3 does not either. A configurable
  `v3UserAgent` supplies the agent string.
- WS-style is a **real RFC 6455 handshake**: the client sends
  `Sec-WebSocket-Version: 13` and a `Sec-WebSocket-Key`, and the server answers
  with `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: <base64(HMAC-SHA1(key, GUID))>`,
  byte-for-byte matching the reference literal at `0x108480d`. The client
  verifies the accept value when the server sends it.
- Data framing after the WS handshake is **not** RFC 6455: the tunnel carries its
  own byte stream. This matches the reference, whose write path adds no opcode,
  mask or payload-length fields.
- The server response is withheld until the first `Read`, so a peer that sends a
  preface and then goes silent never receives a success status. The reference's
  own timing has not been recovered; this ordering is a ForwardX policy.
- TLS uses the standard library with the tunnel PSK pinning the self-signed
  certificate's Ed25519 public key. uTLS fingerprints are not implemented.

### Inner handshake

Two phases, mirroring the reference's "read 17 bytes, then compare a further 16":

1. Each side sends 17 bytes: a mode byte plus 16 bytes of random material. The
   reference reads exactly 17 bytes at `0xd00080`; the mode byte selects its
   crypto branch. ForwardX only implements an authenticated layer, so the byte is
   a fixed marker (`2`, the reference's AEAD branch) rather than a negotiation.
2. Each side sends a 16-byte proof. The reference compares 16 bytes with
   `runtime.memequal`; ForwardX sends
   `HMAC-SHA256(PSK, local_material || peer_material)[:16]` and compares it with
   `hmac.Equal`, which is constant time and not replayable.

Both materials are mixed into the key-derivation salt, so every session gets
fresh keys even with a fixed PSK.

### Inner record layer

- Key derivation: HKDF-SHA256 over the tunnel PSK with info `ss-neko-aead` — the
  reference's info literal, recovered from `0xbd71ee`/`0xbd71f8`. The reference
  picks SHA-1 at `0xbd7218`; ForwardX uses SHA-256. The HKDF is implemented in
  this package (RFC 5869) so the module stays dependency-free, and it is checked
  against the RFC 5869 SHA-256 test vector.
- Four independent keys are derived: length and data, per direction. **This is
  where ForwardX deliberately diverges.** The reference factory at `0xbd7140`
  stores the *same* 16-byte derived key into both direction objects
  (`0xbd74ba`-`0xbd74e4` and `0xbd760a`-`0xbd763c`) and initialises both nonces to
  zero, which is cross-direction keystream reuse. ForwardX uses a distinct key
  per direction and per purpose.
- Nonce: 12 bytes, `direction || kind || 0 || 0 || counter(u64 BE)`, incremented
  once per AEAD operation. The reference also increments once per operation
  (`0xbd694c` after the length, `0xbd6b1a` after the payload) but has no
  direction or kind byte.
- Record layout: the 2-byte big-endian length is sealed separately from the
  payload, so the length is confidential as well as authenticated. The reference
  does the same: it reads 18 bytes (2 + 16 tag) at `0xbd6872`, decrypts the
  length, then reads `length + 16`.
- Payload cap `InnerPayloadLimit = 16381`, derived from the reference's reader
  buffer `0x400f` (16399) minus the 2-byte length record and the 16-byte tag.
  An earlier reading of the reference as `0x3fff` (16383) was wrong; the writer
  buffer is `0x4021` (16417).
- The multiplex `dataChunk` is `InnerPayloadLimit - 7` so a full DATA frame always
  fits inside one inner record.

### Multiplex

- Wire header unchanged and matching the reference: type u8, stream ID u32 BE,
  length u16 BE, payload. Data sender `0xccae20`; receiver `0xcc8c60` reads
  7-byte headers.
- Open = 1, data = 2, close = 3, padding = 4. Type 5 exists in the reference but
  its lifecycle meaning is unverified, so it is neither sent nor interpreted;
  receiving it fails closed.
- Padded control layout matches `0xccb120`: a zero-length control frame followed
  by a separate type-4 frame. Open padding is `crypto/rand.Int(80) + 20` → 20..99
  total bytes, matching `Int(max-min)+min` at `0xa0bd20`. Close padding is 26
  total bytes.
- DATA payload tags (`0` = stream bytes, `1` = u32-BE window credit) and the
  credit scheme are **ForwardX additions**, not recovered reference semantics.

### Session lifetime, health and fairness

- 128 logical streams per physical session; 64 physical outbound sessions per
  process, growing on demand. Pool exhaustion returns an explicit capacity error.
- Pool identity includes tunnel ID, endpoint, key, transport, Host/path/SNI;
  rule-specific targets, quotas and PROXY flags stay in each business hello.
- **Session health**: each session records the time of its last successful
  physical write. A session whose peer vanished silently still reports free
  slots, so the pool skips any session that has not proven itself within
  `v3SessionStaleAge` (30s) and drains failed sessions out of its bucket. Before
  this, the pool kept selecting a dead session and the resulting write timeout
  failed the whole physical session, breaking every sibling stream on it.
- **Endpoint feedback**: the multiplexed dial path hands endpoint selection to the
  pool, which walks the selector's candidates, reports `markHealthy` /
  `markFailure`, and moves to another endpoint when a dial or handshake fails.
  Previously the pooled path returned as soon as any session existed, so the
  selector never learned an endpoint had died and `ExitStrategy: fallback`
  silently degraded to "keep using the dead endpoint".
- **Control backpressure**: a full control queue no longer fails the session. It
  used to `fail()` the whole physical session — and every sibling stream — once
  128 close frames piled up behind a slow physical write. Producers now wait for
  room, bounded by the session lifetime; `tryControl` offers a non-blocking
  variant.
- **Writer fairness**: control frames are still drained first when both queues
  have work, but no longer with absolute priority, so an unbounded run of control
  frames cannot starve DATA frames.
- Ten-second physical write timeout; logical read/write deadlines can be updated
  while blocked. Thirty-second idle expiry when no streams remain.
- Drain refuses new streams and lets existing ones finish. In-flight business
  bytes are never replayed after a transport failure.

## Inspected but deliberately not copied / 已分析但不照搬

| Reference behaviour | Evidence | Why not copied |
| --- | --- | --- |
| One derived key for both directions | `0xbd74ba`-`0xbd74e4`, `0xbd760a`-`0xbd763c` write the same key slice into both objects | Cross-direction keystream reuse |
| Both nonces start at zero | nonce buffers allocated and zero-filled, increment loops touch only 12 bytes | Same as above |
| AES-OFB branch | `0xbd7880`: `crypto/aes.NewCipher` + two `cipher.NewOFB` | Stream cipher with no integrity protection |
| `runtime.memequal` material compare | reported in round one, consistent with `0xd00651` | Not constant time; ForwardX uses `hmac.Equal` |
| HKDF-SHA1 | `0xbd7218` loads the `crypto/sha1.New` factory slot | SHA-256 is the stronger default |
| uTLS fingerprints | `0xc98642` calls `utls.UClient` | Not implemented; certificate pinning is used instead |

## Not implemented / 未实现

- Native UDP and UDP-over-TCP: neither analysis round recovered their data
  formats, so implementing them would mean inventing a protocol.
- Reverse tunnel control protocol.
- Multiplex type 5 lifecycle (no verified semantics).
- uTLS fingerprint profiles and custom HTTP templates.

## Verification

- `go vet ./...` clean; `gofmt` clean.
- `go test -count=1 ./...` passes for both `forwardx-fxp` and `internal/v3`.
- Inner layer tests cover: RFC 5869 HKDF vector, handshake round trip, wrong PSK,
  tampered proof in both directions, unsupported mode byte, per-session key
  separation, tampered record, oversized payload, multi-record writes, concurrent
  writes not interleaving, nonce exhaustion, and deadline propagation.
- Session tests cover: liveness ageing and refresh, a 512-frame control burst not
  killing the session, `tryControl` overflow being non-fatal, concurrent streams,
  slow-consumer isolation, half-close, flow control, and resource release.
- Integration tests cover: all three outer transports end to end, real TCP target
  echo, half-close, 140 logical streams over two physical sessions, multi-hop with
  per-hop keys, failed-exit fallback, reconnect after physical failure, and
  additive rule updates keeping existing TCP/UDP alive.
- **Not yet run**: `go test -race`. The local toolchain has no C compiler
  (`CGO_ENABLED=1` unavailable), so the race detector could not be built. This is
  the largest remaining verification gap given the session kernel and pool.
- Not yet done: long-duration and multi-host runs.
