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

| Problem in the naive version                     | What this version does                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Impossible UI states (stop clickable while idle) | A typed state machine (`scripts/modules/state.js`) validates every transition |
| Microphone stays open after stop                 | The stream and `AudioContext` are released on stop, cancel **and** `pagehide` |
| Hard-coded `audio/webm`                          | Capability detection picks the best supported container; WAV is encoded in JS |
| Recordings vanish on reload                      | IndexedDB repository with an in-memory cache in front                         |
| Recording duration includes pauses               | Elapsed time excludes paused intervals                                        |
| One download at a time                           | Bulk selection, ZIP export, Web Share API                                     |
| English-only, light-only                         | Two locales (EN/FR), system/light/dark themes, no FOUC                        |
| Untested                                         | 60+ unit tests, HTML/service-worker validation and a real-browser e2e suite   |

## Features

- **Recording** — start / pause / resume / stop, live input meter, elapsed timer,
  12-format fallback ladder (`webm/opus` → `ogg/opus` → `mp4/aac` → …), selectable
  bitrate, microphone processing toggles (echo cancellation, noise suppression,
  auto gain), and a WAV path that captures compressed audio then re-encodes 16-bit PCM.
- **Library** — every take is stored in IndexedDB with a name, tags, duration and size;
  search, sort (newest / oldest / name / longest), inline rename, multi-select,
  bulk delete, "download all as ZIP", per-item download and share.
- **Trimming** — canvas waveform preview with draggable handles; the trimmed copy is
  saved as a **new** WAV recording (the original is never destroyed).
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
| Firefox 90+       | ✅        | Ogg/Opus, WebM                                   |
| Safari 15+        | ✅        | MP4/AAC; WAV export via the JS encoder           |
| iOS Safari 15+    | ✅        | Use headphones during playback to avoid feedback |

Unsupported formats are disabled in the settings panel with an explanation instead of
silently failing, and every error is mapped to a human sentence (`errors.*` keys).

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
├── service-worker.js           # Offline shell cache (network-first navigations)
├── icons/                      # Generated SVG + PNG icons (192/512/maskable)
├── styles/main.css             # Design tokens, layout, components, themes
├── scripts/
│   ├── main.js                 # Orchestrator: state, data, wiring, shortcuts, boot
│   └── modules/                # Small, single-purpose ES modules
│       ├── state.js            # State machine + observable store
│       ├── recorder.js         # MediaRecorder + Web Audio engine
│       ├── mime.js             # Format capability ladder
│       ├── store.js            # Recording repository (cache + IndexedDB)
│       ├── db.js               # IndexedDB access, storage quota helpers
│       ├── library.js          # Pure search/sort/stats helpers
│       ├── wav.js              # PCM encoding, trimming, peak envelope
│       ├── audio-utils.js      # Decode, convert, download, share, clipboard
│       ├── zip.js              # Dependency-free ZIP writer (CRC32)
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

| Command                 | What it does                                     |
| ----------------------- | ------------------------------------------------ |
| `npm start`             | Serve the app at <http://127.0.0.1:4173>         |
| `npm test`              | Unit tests (`node:test`, no framework)           |
| `npm run test:e2e`      | Real Chromium flow with a fake microphone        |
| `npm run lint`          | ESLint (flat config, browser + Node globals)     |
| `npm run format`        | Prettier write                                   |
| `npm run validate:html` | Markup, manifest, service-worker and i18n checks |
| `npm run icons`         | Regenerate the PNG icons                         |
| `npm run verify`        | `validate` + unit tests + e2e — what CI runs     |

## Testing

```bash
npm ci
npm run verify
```

- **Unit tests** cover the pure modules: WAV encoding (cross-checked with `ffprobe`
  when available), ZIP integrity (`unzip -t`), MIME fallbacks, search/sort/stats,
  sanitising, formatting, state transitions and i18n key parity — plus the static dev
  server (MIME types, `no-store`, app-shell fallback, 404s and path containment).
- **The e2e suite** boots the real app in Chromium with
  `--use-fake-device-for-media-stream`, then records, pauses, resumes, stops, reloads
  (IndexedDB persistence), renames with tags, plays, downloads, deletes, switches
  language and theme, exercises the `?` shortcut and waits for the service worker.
  Set `PUPPETEER_EXECUTABLE_PATH` if Chrome is not in a standard location and
  `E2E_STRICT=1` to fail instead of skipping when no browser is found (CI does both).

## Deployment

The app is static files — any host works (GitHub Pages, Netlify, S3, nginx).

- **GitHub Pages**: `.github/workflows/deploy-pages.yml` publishes `index.html`,
  `manifest.webmanifest`, `service-worker.js`, `icons/`, `scripts/` and `styles/` on
  every push to `main`.
- **Your own server**: serve the repository root over **https** (or `localhost`).
  Microphone access, service workers and IndexedDB are all gated on a secure context.
- After changing any precached file, bump `VERSION` in `service-worker.js` so browsers
  pick up the new shell and show the "new version available" toast.

## Privacy

- No backend, no third-party scripts, no fonts, no telemetry.
- The Content-Security-Policy allows only same-origin resources (`script-src 'self'`,
  `connect-src 'self'`), so an injected tracker could not phone home either.
- Recordings live in IndexedDB on your device; object URLs are revoked after use.
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

## Licence

[MIT](LICENSE) © 2026 Imoro Abubakari.
