#!/bin/sh
# Builds the wasm module into www/pkg. Serve www/ with any static server.
set -e
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir www/pkg target/wasm32-unknown-unknown/release/audio_viz_web.wasm
