# ForwardX FXP Rust Runtime

This crate is the default implementation of the `forwardx-fxp` release binary. It keeps the existing Agent JSON configuration, FXP TCP wire v2, compatibility wire context, and UDP wire v3 unchanged so Rust and Go nodes can operate in the same tunnel during upgrades.

The original Go implementation remains in `forwardx-fxp/` as the protocol reference and emergency release fallback. Releases still contain one FXP asset per architecture.

## Local verification

```bash
cargo fmt --manifest-path forwardx-fxp-rust/Cargo.toml -- --check
cargo test --manifest-path forwardx-fxp-rust/Cargo.toml --locked
cargo clippy --manifest-path forwardx-fxp-rust/Cargo.toml --all-targets --locked

(cd forwardx-fxp && go build -o ../.tmp/forwardx-fxp-go .)
cargo build --manifest-path forwardx-fxp-rust/Cargo.toml --locked
node scripts/test-fxp-interop.mjs
```

## Release selection

Rust is the default:

```bash
bash scripts/build-agent-release.sh
```

To rebuild the same release asset from the retained Go source during an emergency:

```bash
FXP_IMPLEMENTATION=go bash scripts/build-agent-release.sh
```
