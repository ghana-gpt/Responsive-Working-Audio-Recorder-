# Vendored speech runtime

These files are copied verbatim from upstream releases so the app can transcribe
audio without a CDN and without a build step.

| File                        | Origin                                                                 | Licence      |
| --------------------------- | ---------------------------------------------------------------------- | ------------ |
| `transformers.min.js`       | [Transformers.js](https://github.com/huggingface/transformers.js) 2.17  | Apache-2.0   |
| `ort-wasm-simd.wasm`        | [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.17       | MIT          |
| `LICENSE`                   | Transformers.js licence text                                           | Apache-2.0   |
| `LICENSE.onnxruntime`       | ONNX Runtime licence text                                              | MIT          |

Only the SIMD, single-threaded ONNX Runtime binary is shipped: GitHub Pages
cannot send the COOP/COEP headers threaded WebAssembly needs, so
`ort-wasm-threaded.wasm` and the pthread worker are not part of this app.

`transformers.min.js` is loaded from `scripts/modules/asr-worker.js` only, inside
a dedicated worker, with `env.allowRemoteModels = false`; every model file comes
from `models/whisper-tiny/` on this origin. Those ~45 MB of ONNX graphs are not
committed to git: they are installed from the checksum-pinned release asset
described by `model-package.json` (`npm run models:download`), so the runtime here
and the model there are versioned and reviewed separately.
