# ForwardX runtime failover patch

Applied by `scripts/patch-runtime.sh` to a **private build copy** of the pinned
`github.com/go-gost/x v0.8.1` dependency. No module-cache files are changed.
`scripts/build-runtime.sh` runs selector and parser tests before linking, and
records patch SHA-256 values in `RUNTIME_BUILD.txt`. Keep the original MIT license.

## Behavior

- Node selectors `fifo` / `ha` retain configured ordering among unfailed nodes.
- A failed node's exclusion timer expiring is **not recovery evidence**. Prefer
  unfailed alternatives, including a healthy backup, regardless of that timer.
- Recovery is passive, not a new background probe service. A working fallback is
  not preempted by an unverified former primary. If every node has failed, rotate
  attempts among expired candidates (or all nodes when none has expired).
- Always return a real node when all candidates have failed. Upstream treats a
  nil selection as a missing hop and may construct a direct/partial route; that
  must not bypass an intended proxy or tunnel. Existing router retry limits and
  dial timeouts still bound each request. Do not replay application payloads.
- Preserve per-node failure thresholds and backup flags. Leave round-robin,
  random, hash and chain-level selectors unchanged. No background workers,
  timers, additional health traffic or unbounded per-client state are added.
- A sudden failure may still delay the first connection. Restarting/recreating
  a hop resets its in-memory failure markers, as upstream already does.

This is **runtime node selection**, not the panel forwarding group's DDNS
failover/recovery window, nor the Agent's local target-failover health loop.

## Verification and release

Run `bash scripts/build-runtime.sh all` for Linux amd64/arm64; set
`FORWARDX_RUNTIME_GOOS=windows` for a native Windows test binary. Tests include
the real parser, hop and route machinery, marker updates, 100 subsequent echo
connections, all-down recovery, backup handling and concurrent selections.

Use a new runtime version for changed binaries. Upload both binaries plus
`RUNTIME_BUILD.txt` and `RUNTIME_LICENSE.txt` to that immutable runtime release
**before** publishing dependent panel/Agent packages. Update the four artifact
hashes in `shared/runtimeBuild.ts`; never overwrite the existing `.1` release.

## 中文说明

此补丁仅修复 GOST 节点级主备选择：有正常候选时，不再因计时到期而让业务反复访问
已知故障节点，也不会主动回切旧首选。全部失败时才轮流尝试恢复，始终保留必需的
代理/隧道路由。首次故障仍可能等待连接超时。面板 DDNS 的自动切回策略和 Agent
本地目标主备检测保持原样。构建、测试及补丁均可审计，未添加后台探测或额外线程。
