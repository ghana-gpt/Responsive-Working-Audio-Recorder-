# MP3 encoder (WebAssembly)

`mp3-encoder.wasm` is a WebAssembly build of the MPEG-1 Layer III encoder from
[`audiobox`](https://github.com/jmsansan/audiobox-rs) **0.5.1** by Jose Sanchez, reached
from JavaScript through the small bridge crate in [`encoder/`](../../encoder).

| | |
| --- | --- |
| Upstream | `audiobox` 0.5.1, MIT — vendored unmodified in [`../audiobox-0.5.1/`](../audiobox-0.5.1) |
| Bridge | [`encoder/`](../../encoder) in this repository, MIT — moves samples in, bytes out |
| Target | `wasm32-unknown-unknown`, `opt-level = "s"`, LTO, `codegen-units = 1`, `panic = "abort"`, stripped |
| Artefact | `mp3-encoder.wasm`, 86 KB, no imports at all (no JS glue, no wasm-bindgen) |
| Rebuild | `npm run build:wasm` — needs Rust ≥ 1.85 and the `wasm32-unknown-unknown` target |
| Verify | `npm run check:wasm` — re-hashes the sources and the artefact, no Rust needed |

The exact source hashes, byte size and digests of the shipped binary are recorded in
[`build-info.json`](build-info.json), which `npm run check:wasm` and the unit tests read.
The app loads the file directly with `WebAssembly.instantiate`; there is no generated
JavaScript package to keep in sync.

## What was taken from upstream

`vendor/audiobox-0.5.1/` is the published `audiobox` crate archive with one change: the
test fixtures (7.6 MB of reference audio, `tests/`), the demo site (`site/`) and the
release scripts (`scripts/`) are not vendored. Every file under `src/` is byte-identical
to upstream. The encoder is built from that source with the default feature set
(`default = []`), so the synthesiser, mixer and streaming features are compiled out.

## Licence

`audiobox` is **MIT** © Jose Sanchez; the full text is
[`../audiobox-0.5.1/LICENSE`](../audiobox-0.5.1/LICENSE). The bridge in `encoder/` is
**MIT**, like the rest of this application.

Neither the crate nor the bridge contains LAME, `lamejs` or any other LGPL/GPL encoder
code: `src/mp3/` implements MPEG-1 Layer III from the ISO/IEC 11172-3 specification, and
the scalefactor-band tables in `src/mp3/tables.rs` are the constants that standard
defines. That is why this build could replace the previous LGPL-3.0 `lamejs` dependency.

## Bridge ABI

The bridge exports a pointer-based C ABI, documented in
[`encoder/src/lib.rs`](../../encoder/src/lib.rs). Every exported call may grow the WASM
heap and therefore detach previously created typed-array views; callers must re-create
their views after each call.

| Export | Meaning |
| --- | --- |
| `abx_input(samples) -> ptr` | Resize the planar f32 input buffer (channel 0 frames, then channel 1) and return its address, or `0` when refused |
| `abx_encode(frames, channels, rate, bitrate) -> 1\|0` | Encode as MP3; `channels` is 1 or 2, `rate` is in Hz and `bitrate` in kbit/s (32–320) |
| `abx_output_ptr()` / `abx_output_len()` | Address and length of the encoded file, valid until the next call |
| `abx_error_ptr()` / `abx_error_len()` | Address and length of the UTF-8 error message, empty after a success |

Failures never unwind — the bridge returns `0` and leaves a readable message in the error
buffer — which keeps the binary free of the unwinding machinery a `--target wasm32` build
would otherwise have to carry.
