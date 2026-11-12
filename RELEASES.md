# Releases and version checkpoints

[![Version baseline: v1.0](https://img.shields.io/badge/baseline-v1.0-blue)](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/tree/v1.0)

This page tracks the repository's version checkpoints. Branch links are source snapshots; GitHub Releases and tags are the preferred way to publish immutable downloadable versions. The `v1.0` branch is a snapshot of the repository state at commit `248b39907aab07830810388006d707d1a05d5c08`. The current `main` line is version **1.1.0** (referred to as v1.1 below).

## v2.1.0 — planned scope

**Status:** Planned; not started. The current code reports **1.1.0**, so confirm whether this feature line ships as 1.2.0 (incremental) or 2.1.0 before tagging — the scope below is unaffected by that choice. Agreed focus: local MP3 export, trustworthy microphone-processing feedback with a mic check, and progress/cancel for long conversions. MP4/AAC transcoding is deliberately excluded.

### Goals

| #   | Goal                                               | Current state                                                                                                                                                                                                              |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Local in-browser MP3 encoding                      | `mime.js` lists MP3 with `requiresEncoder`; Preferences disables it with "no browser records MP3 directly". No encoder module exists.                                                                                      |
| 2   | Microphone-processing transparency and a mic check | `recorder.start()` returns `track.getSettings()`, but `recorderView.setMicrophoneHint()` only shows sample rate/channels. Nothing reports whether echo cancellation, noise suppression or auto gain were actually applied. |
| 3   | Progress and cancellation for long conversions     | The WAV save path (`plan.conversion === 'wav'`) and `trimToWav()` decode/encode whole recordings with no progress or cancel.                                                                                               |

Details:

1. **MP3** — add an opt-in encoder behind a capability check, loaded on demand so the initial shell stays small. Show conversion progress, allow cancellation, and map failures to an existing error code.
2. **Processing status** — compare the requested constraints with `track.getSettings()` (and `getCapabilities()` where available) and show applied / not applied / unknown per toggle instead of implying success. Add a short microphone test (record, then play it back through the existing preview player) so users can verify their setup before a real take.
3. **Conversion feedback** — introduce one progress/cancel contract shared by WAV today and MP3 later, without leaking object URLs or leaving the microphone open.

### Out of scope

- AAC/MP4 transcoding where the browser cannot record MP4 natively: this needs an AAC encoder plus an MP4 muxer and adds significant size and compatibility risk. Native MP4/AAC recording stays as it is.
- Software noise suppression / echo cancellation DSP: consider it only after measuring CPU, latency, quality and licensing. Browser/OS processing remains authoritative.
- Any promise of a specific audio quality result: the UI must describe what was applied, not guarantee an outcome.

### Implementation constraints

- The app is dependency-free today and the CSP allows only `script-src 'self'`. Any encoder must be vendored, served from this origin, and either precached or fetched on first use; a CDN import would break both the CSP and the "no network requests after load" claim.
- Review the encoder licence before committing to one (LAME-based builds are typically LGPL and carry attribution/source obligations; WASM builds inflate the shell and need a precache entry). Record the choice and version in the repository.
- Keep `mime.js` pure: extend `resolveFormat()`/`formatAvailability()` with encoder capability instead of branching in the views.
- Every new string needs English **and** French entries; the i18n parity test enforces this.
- Bump `VERSION` in `service-worker.js` whenever precached files change.

### Exit criteria

- MP3 can be selected where the browser cannot record it natively, produces a valid file (verified with `ffprobe` when available), shows progress and can be cancelled.
- Preferences and the recorder show applied vs unsupported processing states from `getSettings()`/`getCapabilities()`, and claim nothing when the browser reports nothing.
- WAV conversion and trimming expose progress and cancellation without leaking object URLs or holding the microphone open.
- `npm run verify` is green with new unit tests for the encoder/progress logic and an e2e step for progress/cancel; target browsers and devices are checked manually before the release is called done.
- `README.md` and this page are updated, and this section is marked shipped once the above is verified.

## v1.1 — current code (release pending)

**Status:** The current code is version **1.1.0** in `package.json` and `service-worker.js`. The implemented v1.1 upgrades below are included, but this version has not yet been tagged or published as a GitHub Release. Open limitations are listed separately and should not be mistaken for completed work.

### Included in v1.1

- **Backup and restore** — bulk ZIP export plus re-import of an archive this app produced. Every entry is CRC-verified against the central directory before it is stored; damaged entries are skipped and reported instead of aborting the restore. ZIP64 and DEFLATE archives are supported, with per-entry size limits and decompression-bomb protection.
- **Storage visibility** — a preferences panel shows usage against the browser quota, the largest recordings and the persistent-storage state. The app requests persistent storage, warns once when the quota is low or critical, and asks for confirmation before exporting more than 512 MB.
- **Repository rewrite** — IndexedDB schema v2 with metadata-only caching; audio payloads are fetched on demand, so the library never holds every blob in memory. Restore is atomic: a failed import leaves the cache and database untouched.
- **Editing and playback** — 12-format capability ladder, WAV re-encoding, trim-to-a-new-recording (the original is preserved), and one shared preview player with no object-URL leaks.
- **Interface** — English/French i18n with key-parity tests, light/dark/system themes, keyboard shortcuts, focus restoration, and the PWA install/update flow.
- **Verification** — `npm run verify` passes: 118 unit tests, a 15-step Chromium e2e flow, and markup/manifest/service-worker/i18n validation. This is automated Chromium coverage, not verification on every browser in the support table.

### Known limitations and follow-up work

1. Long-audio feedback: WAV conversion and trimming still decode whole recordings, with no progress indicator or cancel action.
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
| 4   | Long-audio processing feedback and resilience           | ⬜ Not shipped — WAV conversion and trimming still decode whole recordings without progress or cancellation                                                                                      |
| 5   | Validation beyond Chromium plus documented limitations  | ⬜ Not shipped — e2e is Chromium only; Firefox/Safari/iOS checks are still manual                                                                                                                |

### Suggested workflow for publishing v1.1

1. Keep `package.json`, `package-lock.json`, `service-worker.js` and these notes in sync at version 1.1.0.
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
