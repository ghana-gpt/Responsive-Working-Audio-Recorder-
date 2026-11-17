# 🎙️ Audio Recorder

A responsive, accessible, offline-capable audio recorder that runs **entirely in your
browser**. Record, pause, trim, tag, play back and download audio — no uploads, no
accounts, no analytics, no build step.

[![CI](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/actions/workflows/ci.yml/badge.svg)](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/actions/workflows/ci.yml)
[![Deploy](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/actions/workflows/deploy-pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Live app:** <https://ghana-gpt.github.io/Responsive-Working-Audio-Recorder-/>

---

## Why this exists

Most browser recorders are a single 200-line script: buttons toggle visibility,
the microphone stream leaks after every take, downloads pile up one click at a
time and nothing survives a reload. This rewrite keeps the "just open the page"
promise while fixing the engineering:

| Problem in the naive version                     | What this version does                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Impossible UI states (stop clickable while idle) | A typed state machine (`scripts/modules/state.js`) validates every transition            |
| Microphone stays open after stop                 | The stream and `AudioContext` are released on stop, cancel **and** `pagehide`            |
| Hard-coded `audio/webm`                          | Capability detection picks the best supported container; WAV and MP3 are encoded locally |
| Recordings vanish on reload                      | IndexedDB repository with an in-memory cache in front                                    |
| Recording duration includes pauses               | Elapsed time excludes paused intervals                                                   |
| One download at a time                           | Bulk selection, ZIP export and restore, Web Share API                                    |
| English-only, light-only                         | Two locales (EN/FR), system/light/dark themes, no FOUC                                   |
| Untested                                         | 213 unit tests, HTML/service-worker validation, 21 recorder + 13 transcript e2e steps    |

## Features

- **Recording** — start / pause / resume / stop, live input meter, elapsed timer, a
  four-container fallback ladder (`webm/opus` → `ogg/opus` → `mp4/aac` → `mp3`, eight
  candidate MIME types), a bitrate control, microphone processing toggles (echo cancellation,
  noise suppression, auto gain), a WAV path that captures compressed audio then re-encodes
  16-bit PCM, and an MP3 path for browsers that cannot record MP3 natively.
- **Library** — every take is stored in IndexedDB with a name, tags, duration and size;
  search, sort (newest / oldest / name / longest), inline rename, multi-select,
  bulk delete, "download all as ZIP", per-item download and share.
- **Import and restore** — audio files picked from disk are decoded before they are
  stored, and a ZIP backup exported by the app can be dropped back in: every entry is
  checksum-verified against the archive's central directory, so damaged files are
  skipped and reported instead of corrupting the library.
- **Storage insight** — a preferences panel shows usage against the browser quota,
  the largest recordings and the current protection state.
- **Trimming** — canvas waveform preview with draggable handles; the trimmed copy is
  saved as a **new** WAV recording (the original is never destroyed).
- **Progress and cancellation** — every WAV conversion (saving a capture or a trim)
  re-encodes in chunks so the page stays responsive, reports real encode progress in a
  panel next to the recorder (indeterminate while decoding, which browsers cannot
  report on) and can be cancelled mid-way: nothing is saved and the library is untouched.
- **Local MP3 export** — pick MP3 and the capture is re-encoded on the device by a
  WebAssembly build of the [audiobox](https://crates.io/crates/audiobox) MPEG-1 Layer III
  encoder (MIT, see [`vendor/audiobox/NOTICE.md`](vendor/audiobox/NOTICE.md)). The encoder
  runs in a dedicated module worker, started on first use and precached for offline use, so
  the initial shell stays small and long exports keep the page responsive; it reports
  through the same progress panel and honours the same Cancel button as the WAV path.
  Where a browser can record MP3 itself, that native path is used and the encoder is never
  loaded.
- **Transcription** — on-device speech-to-text with a vendored
  [transformers.js](https://github.com/huggingface/transformers.js) runtime
  (Apache-2.0, see [`vendor/transformers/NOTICE.md`](vendor/transformers/NOTICE.md))
  and a quantized Whisper tiny model installed into `models/whisper-tiny` from a
  checksum-pinned release asset (see [`model-package.json`](model-package.json) and
  [The speech model](#the-speech-model)). A dedicated module worker fetches the model
  once, resamples the stored audio to 16 kHz mono, decodes it in 30 s windows and
  reports real progress; only then is the transcript written next to the recording.
  Transcripts are editable, searchable and exportable (plain text or SubRip), and a
  failure never touches the audio.
- **Live captions** — an opt-in toggle previews the transcript while you record. The
  preview decodes in 4–15 s slices, keeps at most one decode queued, stops capturing
  samples the moment the microphone stops and never writes a preview to the library:
  the saved recording still has to be transcribed explicitly.
- **Playback** — one shared `<audio>` preview player, no object-URL leaks.
- **Offline PWA** — precached shell, `manifest.webmanifest`, generated maskable icons,
  install prompt and "new version available" toast.
- **Accessibility** — semantic landmarks, labelled controls, `role="meter"` input
  level, live-region status messages, focus restoration around dialogs and re-renders,
  skip link, 44 px touch targets, visible focus rings, `prefers-reduced-motion` support.
- **Internationalisation** — English and French UI, `lang` attribute, automatic locale
  detection, localised dates/durations and an i18n key-parity test.
- **Privacy** — no network requests after load, no third-party code, no tracking.
  Audio never leaves the device; the CSP forbids anything but same-origin assets.

## Quick start

No installation and no build step — it is plain ES modules.

```bash
# 1. Clone
git clone https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-.git
cd Responsive-Working-Audio-Recorder-

# 2. Serve it (microphones require localhost or https)
npm start            # → http://127.0.0.1:4173

# 3. Open the URL and press “Start recording”
```

Opening `index.html` from `file://` mostly works, but `getUserMedia`, service workers
and ES module imports require an origin — always use the dev server or a static host.

### Browser support

| Browser           | Recording | Notes                                            |
| ----------------- | --------- | ------------------------------------------------ |
| Chrome / Edge 90+ | ✅        | WebM/Opus by default, MP4/AAC when available     |
| Firefox 90+       | ✅        | Ogg/Opus, WebM; MP3 via the bundled encoder      |
| Safari 15+        | ✅        | MP4/AAC; WAV and MP3 export via the bundled code |
| iOS Safari 15+    | ✅        | Use headphones during playback to avoid feedback |

Automated end-to-end coverage currently runs in Chromium only. The Firefox, Safari and
iOS rows describe the APIs the app targets — validate them manually before a release
(see [`RELEASES.md`](RELEASES.md) for the current verification status).

Unsupported formats are disabled in the settings panel with an explanation instead of
silently failing, and every error is mapped to a human sentence (`errors.*` keys).

Transcription needs `Worker` (module type) and WebAssembly; when either is missing the
feature hides itself and the rest of the app keeps working. The runtime (~11 MB) ships with
the app and is precached; the model (~45 MB) is fetched from this origin the first time you
transcribe and cached afterwards, so it then works offline. A fresh clone has no
`models/whisper-tiny/` yet — run `npm run models:download` once, or transcription fails with
“the speech model is not available” and the rest of the app is unaffected.

### The speech model

`models/whisper-tiny/` holds ~45 MB of quantized ONNX graphs and tokenizer data, so it is
**not** committed (see `.gitignore`). The exact bytes are pinned in
[`model-package.json`](model-package.json): the release tag, the archive name, its SHA-256
and byte size, and the size plus SHA-256 of every extracted file.

```bash
npm run models:download   # fetch → verify the archive → verify every file → install
npm run models:verify     # check an existing install against the manifest
npm run models:package    # rebuild dist/<archive> after changing models/whisper-tiny
```

- The archive is a plain `ustar` + gzip tarball published as a GitHub Release asset
  (`models-whisper-tiny-v1`). Nothing is written into `models/whisper-tiny/` until both
  the archive checksum and every extracted file match, so a truncated or tampered
  download can never be mistaken for an install.
- `models:download` is idempotent: when the installed files already match it logs that
  nothing is to do. Pass `-- --force` to reinstall from scratch.
- `models:package` writes `dist/whisper-tiny-v1-q8.tar.gz` and prints its SHA-256; upload
  that file to the release, then update `sha256`, `bytes`, `modelBytes` and `files` in the
  manifest. Bump `version`/`release`/`archive`/`url` together for a new model, and bump
  `MODEL_CACHE` in `service-worker.js` to match so browsers replace the cached copy.
- The app itself never downloads from GitHub: the model is served from this origin, and
  the service worker keeps it in a separate cache (`audio-recorder-model-whisper-tiny-v1`)
  that survives app-shell updates.

To publish (or replace) the asset:

1. `npm run models:package` writes `dist/whisper-tiny-v1-q8.tar.gz` and prints its SHA-256.
2. Create the release named in `model-package.json` (`models-whisper-tiny-v1`) and upload
   that file. A **draft** release does not serve its assets, and an unpublished asset
   answers 404, so publish it before pushing a commit that relies on it.
3. Commit the manifest together with the `sha256`, `bytes` and per-file values the command
   printed. Until the release exists, `models:download` stops with “the release asset is
   missing” and the Pages workflow fails instead of publishing a site whose transcription
   would 404.

The published asset is
[`models-whisper-tiny-v1`](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases/tag/models-whisper-tiny-v1)
(27.9 MB, SHA-256 `acd43e31b5841af5bd016616c3f3766fe85bb3f662473e20534602bbd0b90aac`).

`main` carries no ONNX blobs: the commits that introduced the model were rewritten before
their first push, so a clone is ~5 MB and `git filter-repo` is not needed. The old blobs
survive only in local backup refs (`backup/pre-model-split-018b981` and
`refs/original/refs/heads/main`); while you still want that safety net, keep them, otherwise
`git update-ref -d refs/original/refs/heads/main`, `git branch -D backup/pre-model-split-018b981`
and `git gc --prune=now` reclaim the space.

## Keyboard shortcuts

| Key            | Action                                           |
| -------------- | ------------------------------------------------ |
| `R` or `Space` | Start / stop recording                           |
| `P`            | Pause / resume                                   |
| `Enter`        | Play the focused recording                       |
| `Delete`       | Delete the focused recording (with confirmation) |
| `?`            | Open the help panel                              |

Shortcuts are ignored while you type in a text field, inside an open dialog or when a
button/link has focus, so they never steal a keystroke from an active control.

## Project structure

```text
.
├── index.html                  # Semantic shell: recorder, library, settings, dialogs
├── manifest.webmanifest        # PWA metadata (installable)
├── model-package.json          # Pinned release asset + per-file hashes for the model
├── service-worker.js           # Offline shell cache + long-lived model cache
├── icons/                      # Generated SVG + PNG icons (192/512/maskable)
├── vendor/audiobox/            # Committed MP3 encoder .wasm + digests (MIT, see NOTICE.md)
├── vendor/audiobox-0.5.1/      # audiobox crate sources the .wasm is built from (MIT)
├── encoder/                    # Rust bridge crate exposing audiobox through a tiny ABI
├── vendor/transformers/        # Vendored ASR runtime (Apache-2.0, see NOTICE.md)
├── models/whisper-tiny/        # Whisper tiny ONNX + tokenizer (downloaded, not committed)
├── styles/main.css             # Design tokens, layout, components, themes
├── scripts/
│   ├── main.js                 # Orchestrator: state, data, wiring, shortcuts, boot
│   └── modules/                # Small, single-purpose ES modules
│       ├── state.js            # State machine + observable store
│       ├── recorder.js         # MediaRecorder + Web Audio engine
│       ├── asr.js              # Whisper client: resample, window, normalise, SRT
│       ├── asr-worker.js       # Module worker that runs transformers.js off-thread
│       ├── live-transcript.js  # Opt-in live caption preview (4–15 s slices)
│       ├── mime.js             # Format capability ladder
│       ├── mp3.js              # MP3 export adapter: validation, progress, cancellation
│       ├── mp3-worker.js       # Module worker that loads the WASM encoder and encodes
│       ├── mp3-wasm.js         # WASM bridge loader + encoder wrapper (used by the worker)
│       ├── store.js            # Recording repository (cache + IndexedDB)
│       ├── db.js               # IndexedDB access, storage quota helpers
│       ├── library.js          # Pure search/sort/stats helpers
│       ├── wav.js              # PCM encoding, trimming, peak envelope
│       ├── conversion.js       # Shared progress/cancel contract for conversions
│       ├── conversion-view.js  # Progress panel view (dumb)
│       ├── audio-utils.js      # Decode, convert, download, share, clipboard
│       ├── zip.js              # Dependency-free ZIP writer (CRC32)
│       ├── zip-reader.js       # Streaming ZIP reader (central directory, CRC checks)
│       ├── sanitize.js         # File-name/tag/text sanitising
│       ├── format.js           # Duration/size/date formatting
│       ├── settings.js         # Validated localStorage preferences, themes
│       ├── i18n.js             # EN/FR dictionaries + translator
│       ├── dom.js              # DOM helpers, i18n tree walker, focus utilities
│       ├── toast.js            # Toast notifications
│       ├── dialogs.js          # Confirm + trim dialogs (promise based)
│       ├── recorder-view.js    # Recorder panel view (dumb)
│       ├── library-view.js     # Library view (dumb)
│       └── settings-view.js    # Preferences view (dumb)
├── tools/
│   ├── dev-server.mjs          # Zero-dependency static server (also used by e2e)
│   ├── build-mp3-wasm.mjs      # Builds the encoder .wasm, records/verifies its digests
│   ├── models.mjs              # Pack, verify and install the pinned speech model
│   ├── validate-html.mjs       # Markup, manifest, SW and i18n validator
│   └── generate-icons.mjs      # Draws the PNG icons with no dependencies
└── tests/
    ├── unit/                   # node:test suites for the pure modules
    └── e2e/                    # Puppeteer flow with a fake microphone
```

### Architecture in one paragraph

`main.js` is the only module that knows about _everything_. It owns the state machine,
the repository, the recorder engine, the views and the service worker. Views are
"dumb": they receive a render model and emit intents (`{ type: 'delete', id }`), never
touching IndexedDB, MediaRecorder or object URLs. Pure modules (WAV, ZIP, MIME, search)
have no DOM dependencies so they can be unit tested in Node. That split is why the e2e
test can assert real behaviour while the unit tests run in milliseconds.

## Scripts

| Command                   | What it does                                      |
| ------------------------- | ------------------------------------------------- |
| `npm start`               | Serve the app at <http://127.0.0.1:4173>          |
| `npm test`                | Unit tests (`node:test`, no framework)            |
| `npm run test:e2e`        | Real Chromium flow with a fake microphone         |
| `npm run test:e2e:asr`    | Same browser, stubbed Whisper worker, transcript  |
| `npm run lint`            | ESLint (flat config, browser + Node globals)      |
| `npm run format`          | Prettier write                                    |
| `npm run validate:html`   | Markup, manifest, service-worker and i18n checks  |
| `npm run build:wasm`      | Rebuild the MP3 encoder with `cargo` (needs Rust) |
| `npm run check:wasm`      | Verify the committed `.wasm` matches its sources  |
| `npm run models:download` | Fetch and verify the speech model (see above)     |
| `npm run models:verify`   | Check the installed model against its manifest    |
| `npm run models:package`  | Rebuild the model release archive                 |
| `npm run icons`           | Regenerate the PNG icons                          |
| `npm run verify`          | `validate` + unit tests + e2e — what CI runs      |

## Testing

```bash
npm ci
npm run verify
```

- **Unit tests** cover the pure modules: WAV encoding (cross-checked with `ffprobe`
  when available), the conversion contract (stage progress, cancellation, chunked
  encoder parity with the synchronous one), the MP3 export adapter and the WASM encoder
  (validation, progress and cancellation on a fake worker; the committed `.wasm` against
  the digest in `build-info.json`, its output parsed frame by frame and cross-checked with
  `ffprobe`/`ffmpeg` when they are installed), ZIP writing and reading (`unzip -t`, ZIP64,
  CRC failures, DEFLATE inflation), MIME fallbacks, search/sort/stats, sanitising,
  formatting, state transitions and i18n key parity — plus the static dev server (MIME
  types, `no-store`, app-shell fallback, 404s and path containment), transcription
  (downmix/resample maths, window planning, worker orchestration with an injected
  worker, progress normalisation, transcript caps, SubRip formatting and the size
  quoted for the installed model), the live-caption cadence (4–15 s slices, one queued
  decode, no previews after `stop()`), the model package tool (manifest validation,
  ustar round-trips, archive and per-file SHA-256 checks, refusing a tampered archive,
  idempotent installs and `--force`) and the service worker (cache-first assets with a
  background refresh, shell fallback on an offline navigation, a model cache that
  survives shell updates, and cache writes that never delay the response — that last one
  stalled multi-megabyte ONNX downloads when it was awaited).
- **The e2e suite** boots the real app in Chromium with
  `--use-fake-device-for-media-stream`, then records, pauses, resumes, stops, reloads
  (IndexedDB persistence), renames with tags, plays, downloads, deletes, imports a long
  library, pages through it, bulk deletes, restores a ZIP backup, rejects a damaged
  archive, watches a long trim report progress and complete, cancels a conversion from
  the panel, saves a WAV capture, saves an MP3 capture and verifies the encoded bytes and
  its decoded duration, switches language and theme, exercises the `?`
  shortcut and waits for the service worker.
  A second suite (`npm run test:e2e:asr`) swaps the real Whisper worker for a stub that
  speaks the same protocol, then transcribes a take, checks the progress panel, the
  stored transcript and the model label, reloads (IndexedDB persistence), searches by
  transcript, exports SubRip and plain text, copies, edits (which drops the timings),
  deletes the transcript without deleting the audio and records with live captions on.
  Set `PUPPETEER_EXECUTABLE_PATH` if Chrome is not in a standard location and
  `E2E_STRICT=1` to fail instead of skipping when no browser is found (CI does both).

## Deployment

The app is static files — any host works (GitHub Pages, Netlify, S3, nginx).

- **GitHub Pages**: `.github/workflows/deploy-pages.yml` publishes `index.html`,
  `manifest.webmanifest`, `service-worker.js`, `icons/`, `scripts/`, `styles/`, the
  runtime parts of `vendor/` and `models/` on every push to `main`. The encoder's crate
  sources (`vendor/audiobox-0.5.1/`, `encoder/`) are repository-only; the site ships the
  compiled `mp3-encoder.wasm`. The workflow runs `npm run models:download` before
  validating and assembling the site (restoring `models/whisper-tiny` from the Actions
  cache when the manifest has not changed), so the published site always ships a
  byte-verified model even though the blobs are not in git. The repository's Pages source
  must stay **GitHub Actions** (`build_type: workflow`, the default for this workflow):
  the legacy “deploy from a branch” source publishes the tracked files only, and since
  `models/whisper-tiny/` is gitignored it would serve a site whose transcription 404s the
  moment it finishes after an Actions deploy.
- **Your own server**: serve the repository root over **https** (or `localhost`).
  Microphone access, service workers and IndexedDB are all gated on a secure context.
  Run `npm run models:download` once before uploading, or copy a verified
  `models/whisper-tiny/` directory; without it the app records and edits normally but
  transcription reports that the model is unavailable.
- After changing any precached file, bump `VERSION` in `service-worker.js` so browsers
  pick up the new shell and show the "new version available" toast. Model files are
  cached separately: bump `MODEL_CACHE` (and `version` in `model-package.json`) only when
  the model bytes change, so routine app updates never re-download ~45 MB.

## Privacy

- No backend, no third-party requests, no fonts, no telemetry. The only third-party
  code is the MP3 encoder and the speech-to-text runtime, both vendored and served from
  this origin (never a CDN).
- The Content-Security-Policy allows only same-origin resources (`script-src 'self'`,
  `connect-src 'self'`), so an injected tracker could not phone home either.
- Recordings live in IndexedDB on your device; object URLs are revoked after use.
- Transcription runs entirely in a module worker on your device — Whisper is downloaded
  once from this origin, and neither the audio nor the text is ever uploaded.
- The app asks the browser for _persistent_ storage so recordings are not evicted
  under storage pressure, and warns when the quota is nearly full.
- The only outbound links are the GitHub repository and the sponsor credit, and the
  credit can be hidden in Preferences.

## Contributing

Issues and pull requests are welcome — please read
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first. `npm run verify` must pass.

## Credits

- Built by [Imoro Abubakari](https://github.com/ghana-gpt).
- Sponsored by [Ghana-GPT.com](https://ghana-gpt.com) — a static footer credit that you
  can turn off in Preferences.
- Icons are drawn by `tools/generate-icons.mjs`; no icon library is bundled.
- MP3 encoding: the [audiobox](https://crates.io/crates/audiobox) 0.5.1 MPEG-1 Layer III
  encoder (MIT), compiled to WebAssembly by `tools/build-mp3-wasm.mjs` — see
  [`vendor/audiobox/NOTICE.md`](vendor/audiobox/NOTICE.md) for provenance, the bridge ABI
  and rebuild instructions.
- Speech-to-text: [transformers.js](https://github.com/huggingface/transformers.js) and
  [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (Apache-2.0) vendored under
  `vendor/transformers/`, plus the quantized
  [Whisper tiny](https://huggingface.co/Xenova/whisper-tiny) model (MIT), installed into
  `models/whisper-tiny/` from the release asset pinned in `model-package.json` — see
  [`vendor/transformers/NOTICE.md`](vendor/transformers/NOTICE.md) and
  [`models/whisper-tiny/LICENSE`](models/whisper-tiny/LICENSE).

## Licence

This application's own code is [MIT](LICENSE) © 2026 Imoro Abubakari.

Third-party components keep their own licences: the bundled MP3 encoder is audiobox 0.5.1
(**MIT**, compiled to WebAssembly from the sources in `vendor/audiobox-0.5.1/` with the
bridge in `encoder/`) and the speech-to-text runtime is **Apache-2.0**. Both ship with a
`NOTICE.md` that records provenance and attribution —
[`vendor/audiobox/NOTICE.md`](vendor/audiobox/NOTICE.md),
[`vendor/transformers/NOTICE.md`](vendor/transformers/NOTICE.md).
