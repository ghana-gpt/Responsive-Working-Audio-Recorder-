# Releases and version checkpoints

[![Version baseline: v1.0](https://img.shields.io/badge/baseline-v1.0-blue)](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/tree/v1.0)

This page tracks the repository's version checkpoints. Branch links are source snapshots; GitHub Releases and tags are the preferred way to publish immutable downloadable versions. The `v1.0` branch is a snapshot of the repository state at commit `248b39907aab07830810388006d707d1a05d5c08`. The current `main` line is version **1.3.0** (referred to as v1.3 below), built on the v1.2 and v1.1 feature sets.

## v1.3.0 — current code (release pending)

**Status:** The current code is version **1.3.0** in `package.json`, `package-lock.json` and `service-worker.js`. Local MP3 export shipped: a vendored encoder is loaded on demand and reports through the progress/cancel contract that v1.2 introduced. Microphone-processing transparency, the second v1.3 goal, is still open and is tracked as v1.4 below. This version has not been tagged or published as a GitHub Release.

### Included in v1.3

- **Local MP3 export** — choosing MP3 where the browser cannot record it re-encodes the capture on the device through `scripts/modules/mp3.js`, an adapter over the vendored lamejs 1.2.1 build in `vendor/lamejs-1.2.1/`. Where a browser can record MP3 natively, that path is used and the encoder is never loaded.
- **On-demand, same-origin delivery** — the encoder is a separate `<script>` loaded the first time an MP3 conversion starts and precached by the service worker, so the initial shell stays small and the `script-src 'self'` policy is untouched. There is no CDN and no network request at runtime.
- **Same conversion contract as WAV** — `mp3.js` decodes through the shared `conversion.js` stages, reports encode progress in the existing panel and honours the same Cancel button. Cancelling leaves the library untouched and says that nothing was saved; failures map to existing error codes.
- **Licence hygiene** — lamejs is LGPL-3.0 (it inherits LAME). It ships byte-identical to upstream, with its sources and `LICENSE`, and `vendor/lamejs-1.2.1/NOTICE.md` records provenance, the modification policy and the attribution obligations. Because it is loaded as a separate script and never bundled into application code, the MIT licence of this project's own code is unaffected.
- **Preferences and status** — MP3 becomes selectable as soon as the encoder is available; the format hint and English/French strings explain what will happen instead of claiming the browser records MP3.
- **Verification** — `npm run verify` passes with 136 unit tests and 21 Chromium e2e steps. The MP3 step records, saves, plays the stored recording and inspects the persisted bytes (MPEG frames, `audio/mpeg` type, `mp3` extension); a second step cancels an MP3 save and asserts that nothing is stored.

### Known limitations and follow-up work

1. Decode progress remains indeterminate for both WAV and MP3: only the encode stage has measurable progress, because `decodeAudioData` reports nothing until it completes.
2. Microphone-processing transparency — showing applied/not-applied/unknown for echo cancellation, noise suppression and auto gain, plus a microphone check — is still open (v1.4 below).
3. MP3 encoding costs CPU on the main thread in chunks; long recordings take noticeably longer than a WAV save and cannot be interrupted during decode.
4. Browser coverage: automated e2e runs in Chromium only; Firefox, Safari and iOS still need manual checks per the support table in `README.md`.
5. Publishing: run the final checks on the exact commit, create the `v1.3.0` tag, and publish the GitHub Release.

### Release links

- [Create the v1.3 GitHub Release](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases/new?tag=v1.3.0&title=Audio%20Recorder%20v1.3)
- [Compare v1.2 with the current main](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/compare/v1.2...main)
- [All published GitHub Releases](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases)

## v1.2.0 — previous release line (release pending)

**Status:** This line shipped as **1.2.0** in `package.json`, `package-lock.json` and `service-worker.js`; the current code reports 1.3.0 (above). WAV conversions (saving a capture and trimming an existing recording) report real progress and can be cancelled. Local MP3 export, planned together with them, shipped in v1.3; microphone-processing transparency is now tracked as v1.4. The `v1.2.0` tag and GitHub Release still need creating.

### Included in v1.2

- **One conversion contract** — `scripts/modules/conversion.js` names the stages (`decode`, `encode`), reports progress that never moves backwards inside a stage, turns an `AbortSignal` into a prompt stop between chunks, and fails with a distinguishable `ConversionCancelledError`. It touches no DOM or Web Audio API, which is why `tests/unit/conversion.test.js` can cover it in Node.
- **Chunked WAV encoder** — `encodeWavAsync()` in `scripts/modules/wav.js` writes 16-bit PCM in 131 072-frame chunks and yields to the event loop between them, so the interface keeps painting and Cancel is honoured within one chunk. Its output is byte-identical to `encodeWav()`, which the ZIP/export helpers keep using; a unit test asserts that parity.
- **Progress panel and cancellation** — a new `#conversion-panel` next to the recorder labels the operation ("Converting to WAV…", "Trimming audio…"), shows a determinate bar once encoding starts (indeterminate while decoding, which `decodeAudioData` cannot report on) and offers Cancel. Only one conversion may run at a time; a second attempt is refused with a toast instead of queueing.
- **Cancel means cancel** — cancelling a WAV save returns the recorder to a usable state and says that nothing was saved; cancelling a trim leaves the library untouched. Decoding cannot be interrupted — the platform offers no hook — so the decoded buffer is discarded the moment it settles.
- **Accessibility** — the percentage is decorative (`aria-hidden`) and the polite live region only carries the operation label, so screen readers are not flooded with frame updates; hiding the panel returns focus to the record button rather than stranding it on a hidden control.
- **Verification** — at the v1.2 commit, `npm run verify` passed with 131 unit tests and 19 Chromium e2e steps, including steps that watch the panel with a `MutationObserver` (progress painted, then hidden), cancel a trim, and save a WAV capture. Current counts live in the v1.3 section above; automated coverage is Chromium only.

### Known limitations and follow-up work

1. Decode progress is indeterminate: only the encode stage has measurable progress, because `decodeAudioData` reports nothing until it completes.
2. MP3 export shipped in v1.3 (above); microphone-processing transparency is now tracked as v1.4.
3. Browser coverage: automated e2e runs in Chromium only; Firefox, Safari and iOS still need manual checks per the support table in `README.md`.
4. Publishing: run the final checks on the exact commit, create the `v1.2.0` tag, and publish the GitHub Release.

### Release links

- [Create the v1.2 GitHub Release](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases/new?tag=v1.2.0&title=Audio%20Recorder%20v1.2)
- [Compare v1.1 with the current main](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/compare/v1.1...main)
- [All published GitHub Releases](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases)

## v1.4.0 — planned scope

**Status:** Planned; not started. Local MP3 export shipped in v1.3 through the shared conversion contract (see above). What remains from the original v1.3 plan is trustworthy microphone-processing feedback. MP4/AAC transcoding is deliberately excluded.

### Goals

| #   | Goal                                               | Current state                                                                                                                                                                                                              |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Local in-browser MP3 encoding                      | ✅ Shipped in v1.3 — `scripts/modules/mp3.js` over the vendored lamejs 1.2.1 build, selectable wherever the browser cannot record MP3 itself.                                                                              |
| 2   | Microphone-processing transparency and a mic check | `recorder.start()` returns `track.getSettings()`, but `recorderView.setMicrophoneHint()` only shows sample rate/channels. Nothing reports whether echo cancellation, noise suppression or auto gain were actually applied. |

Details:

1. **MP3** — ✅ shipped in v1.3: the encoder is opt-in, loaded on demand so the initial shell stays small, reports through the shared contract, can be cancelled, and maps failures to existing error codes.
2. **Processing status** — compare the requested constraints with `track.getSettings()` (and `getCapabilities()` where available) and show applied / not applied / unknown per toggle instead of implying success. Add a short microphone test (record, then play it back through the existing preview player) so users can verify their setup before a real take.
3. **Conversion feedback** — ✅ shipped in v1.2: `scripts/modules/conversion.js` is the shared progress/cancel contract, and MP3 reuses it rather than growing a second mechanism.

### Out of scope

- AAC/MP4 transcoding where the browser cannot record MP4 natively: this needs an AAC encoder plus an MP4 muxer and adds significant size and compatibility risk. Native MP4/AAC recording stays as it is.
- Software noise suppression / echo cancellation DSP: consider it only after measuring CPU, latency, quality and licensing. Browser/OS processing remains authoritative.
- Any promise of a specific audio quality result: the UI must describe what was applied, not guarantee an outcome.

### Implementation constraints

- The CSP allows only `script-src 'self'`. The MP3 encoder is the one vendored exception (a separate same-origin script, loaded on demand and precached); anything else must follow the same rules — no CDN imports, no runtime third-party requests.
- The encoder licence was reviewed before adopting it (v1.3): lamejs 1.2.1 is LGPL-3.0, ships unmodified with its sources, and is documented in `vendor/lamejs-1.2.1/NOTICE.md`. Repeat that review before adding another dependency.
- Keep `mime.js` pure: extend `resolveFormat()`/`formatAvailability()` with encoder capability instead of branching in the views.
- Every new string needs English **and** French entries; the i18n parity test enforces this.
- Bump `VERSION` in `service-worker.js` whenever precached files change.

### Exit criteria

- ✅ MP3 can be selected where the browser cannot record it natively, produces a valid file, shows progress and can be cancelled (shipped in v1.3; the e2e suite inspects the stored MPEG frames, `audio/mpeg` type and `mp3` extension, and cancels a save without storing anything).
- Preferences and the recorder show applied vs unsupported processing states from `getSettings()`/`getCapabilities()`, and claim nothing when the browser reports nothing.
- ✅ WAV conversion and trimming expose progress and cancellation without leaking object URLs or holding the microphone open (shipped in v1.2); MP3 does the same (shipped in v1.3).
- `npm run verify` is green with new unit tests for the processing-status logic and an e2e step for the microphone check; target browsers and devices are checked manually before the release is called done.
- `README.md` and this page are updated, and this section is marked shipped once the above is verified.

## v1.1 — previous release line (release pending)

**Status:** The v1.1 feature set shipped as **1.1.0** in `package.json` and `service-worker.js` and is carried forward in the current 1.3.0 code. The `v1.1.0` tag and GitHub Release still need creating; open limitations are listed separately and should not be mistaken for completed work.

### Included in v1.1

- **Backup and restore** — bulk ZIP export plus re-import of an archive this app produced. Every entry is CRC-verified against the central directory before it is stored; damaged entries are skipped and reported instead of aborting the restore. ZIP64 and DEFLATE archives are supported, with per-entry size limits and decompression-bomb protection.
- **Storage visibility** — a preferences panel shows usage against the browser quota, the largest recordings and the persistent-storage state. The app requests persistent storage, warns once when the quota is low or critical, and asks for confirmation before exporting more than 512 MB.
- **Repository rewrite** — IndexedDB schema v2 with metadata-only caching; audio payloads are fetched on demand, so the library never holds every blob in memory. Restore is atomic: a failed import leaves the cache and database untouched.
- **Editing and playback** — 12-format capability ladder, WAV re-encoding, trim-to-a-new-recording (the original is preserved), and one shared preview player with no object-URL leaks.
- **Interface** — English/French i18n with key-parity tests, light/dark/system themes, keyboard shortcuts, focus restoration, and the PWA install/update flow.
- **Verification** — at the v1.1 commit, `npm run verify` passed with 118 unit tests and a 15-step Chromium e2e flow plus markup/manifest/service-worker/i18n validation. Current counts live in the v1.3 section above; automated coverage is still Chromium only.

### Known limitations and follow-up work

1. Long-audio feedback: WAV conversion and trimming still decode whole recordings, with no progress indicator or cancel action. _(Fixed in v1.2: progress panel, cancellation and a chunked encoder — see above.)_
2. Very large libraries: metadata is cached in full (payloads are not); paging metadata out of IndexedDB is still future work.
3. Browser coverage: automated e2e runs in Chromium only; Firefox, Safari and iOS need manual checks per the support table in `README.md`.
4. Publishing: run the final checks on the exact commit, create a `v1.1.0` tag, and publish the GitHub Release.

### Release links

- [Create the v1.1 GitHub Release](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases/new?tag=v1.1.0&title=Audio%20Recorder%20v1.1)
- [Compare v1.0 with the current main](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/compare/v1.0...main)
- [All published GitHub Releases](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases)

## v1.1 goals — completion status

The implemented features are part of v1.1. These status markers describe completion of the original goals, not whether the release has been published:

| #   | Goal                                                    | Status                                                                                                                                                                                           |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Recording backup/export and restore/import validation   | ✅ Shipped — ZIP export, CRC-verified restore, damaged entries reported, ZIP64/DEFLATE support                                                                                                   |
| 2   | Storage visibility and warnings                         | ✅ Shipped — usage/quota panel, persistent-storage request, low/critical quota warnings, large-export confirmation                                                                               |
| 3   | Reduce large-library and large-export performance risks | ◐ Partly shipped — payloads are never cached (metadata only) and ZIP export assembles parts instead of one contiguous buffer; metadata is still loaded in full and paging it remains future work |
| 4   | Long-audio processing feedback and resilience           | ✅ Shipped in v1.2 — progress panel, cancellation and a chunked encoder; decode progress stays indeterminate                                                                                     |
| 5   | Validation beyond Chromium plus documented limitations  | ⬜ Not shipped — e2e is Chromium only; Firefox/Safari/iOS checks are still manual                                                                                                                |

### Suggested workflow for publishing v1.1

1. Tag the commit that reported 1.1.0 — the current `main` reports 1.3.0 — and keep `package.json`, `package-lock.json`, `service-worker.js` and these notes in sync at version 1.1.0 on that commit.
2. Run `npm ci` and `npm run verify`, plus manual browser/device checks for changed audio/storage behavior.
3. Create the `v1.1.0` tag on the final verified commit and publish the GitHub Release with notes summarizing included changes and known limitations.
4. Keep `v1.0` available as the historical baseline. Prefer tags/releases over relying on a branch name alone for long-term versioning.

## v1.0 — baseline snapshot

**Status:** Source snapshot available at [`v1.0`](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/tree/v1.0). A published GitHub Release/tag still needs to be created in the Releases UI.

### Highlights

- Browser-based audio recording with start, pause, resume, stop, and microphone-level metering.
- Local recording library backed by IndexedDB, with search, sorting, rename, tags, playback, and deletion.
- Import, download, bulk ZIP export, sharing, and WAV conversion/trimming.
- Offline-capable PWA shell, install metadata, and service-worker updates.
- English/French UI, light/dark/system themes, and accessibility-focused controls.
- Unit tests, Chromium end-to-end testing, lint/validation, and GitHub Pages deployment workflows.

### Known limitations (as of the v1.0 snapshot)

These describe the v1.0 snapshot. The v1.1 section above records what changed (payloads are no longer cached, ZIP export no longer needs one contiguous buffer) and what is still open.

- The library loads all records into an in-memory cache; large libraries may consume significant memory.
- WAV conversion and trimming decode and process entire recordings, which may be slow or memory intensive for long audio.
- ZIP export assembles the archive in memory and may not suit very large exports.
- The end-to-end CI workflow exercises Chromium; broader browser/device testing is still important.
- Recordings are local to the browser profile. Users should export backups for important recordings; browser storage is not a cloud backup.

### Source

- [Browse the v1.0 source snapshot](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/tree/v1.0)
- [Inspect the exact v1.0 commit](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/commit/248b39907aab07830810388006d707d1a05d5c08)
- [Create the v1.0 GitHub Release](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases/new?tag=v1.0&title=Audio%20Recorder%20v1.0)
