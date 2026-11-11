# Releases and version checkpoints

[![Version baseline: v1.0](https://img.shields.io/badge/baseline-v1.0-blue)](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/tree/v1.0)

This page tracks the repository's version checkpoints. Branch links are source snapshots; GitHub Releases and tags are the preferred way to publish immutable downloadable versions. The current v1.0 branch is a snapshot of the repository state at commit `248b39907aab07830810388006d707d1a05d5c08`.

## v1.0 — baseline snapshot

**Status:** Source snapshot available at [`v1.0`](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/tree/v1.0). A published GitHub Release/tag still needs to be created in the Releases UI.

### Highlights

- Browser-based audio recording with start, pause, resume, stop, and microphone-level metering.
- Local recording library backed by IndexedDB, with search, sorting, rename, tags, playback, and deletion.
- Import, download, bulk ZIP export, sharing, and WAV conversion/trimming.
- Offline-capable PWA shell, install metadata, and service-worker updates.
- English/French UI, light/dark/system themes, and accessibility-focused controls.
- Unit tests, Chromium end-to-end testing, lint/validation, and GitHub Pages deployment workflows.

### Known limitations to address before v1.1

- The library loads all records into an in-memory cache; large libraries may consume significant memory.
- WAV conversion and trimming decode and process entire recordings, which may be slow or memory intensive for long audio.
- ZIP export assembles the archive in memory and may not suit very large exports.
- The end-to-end CI workflow exercises Chromium; broader browser/device testing is still important.
- Recordings are local to the browser profile. Users should export backups for important recordings; browser storage is not a cloud backup.

### Source

- [Browse the v1.0 source snapshot](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/tree/v1.0)
- [Inspect the exact v1.0 commit](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/commit/248b39907aab07830810388006d707d1a05d5c08)
- [Create the v1.0 GitHub Release](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases/new?tag=v1.0&title=Audio%20Recorder%20v1.0)

## v1.1 — planned

**Status:** Work planned; not released. The `v1.1` branch is a working branch, not the final release artifact. Merge completed and tested work into `main`, then create an immutable `v1.1` tag and GitHub Release from the verified commit.

### Release goals

1. Add recording backup/export and restore/import validation so users can move or recover their local recordings.
2. Improve storage visibility and warnings, including clear reporting of library size and available quota where the browser exposes it.
3. Reduce large-library and large-export performance risks; prioritize loading metadata without retaining every audio blob in the in-memory cache, and assess streaming or chunked ZIP export.
4. Improve long-audio processing feedback and resilience, including progress/cancellation where feasible and testing on lower-powered devices.
5. Expand validation beyond Chromium across target browsers and mobile devices, documenting known limitations.

These are planned goals, not claims that the features are already implemented. Update this section when scope is finalized and when each goal is completed.

### Suggested workflow

1. Develop and test changes on the `v1.1` branch; keep `main` as the stable line.
2. Run `npm ci` and `npm run verify`, plus manual browser/device checks for changed audio/storage behavior.
3. Review and merge the completed work into `main`.
4. Create the `v1.1` tag on the final verified commit and publish the GitHub Release with notes summarizing shipped changes, fixes, and known limitations.
5. Keep `v1.0` available as the historical baseline. Prefer tags/releases over relying on a branch name alone for long-term versioning.

### Release links

- [Browse the v1.1 work branch](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/tree/v1.1)
- [Create the v1.1 GitHub Release after it is ready](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases/new?tag=v1.1&title=Audio%20Recorder%20v1.1)
- [All published GitHub Releases](https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-/releases)
