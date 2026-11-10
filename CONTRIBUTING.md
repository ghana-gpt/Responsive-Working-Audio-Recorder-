# Contributing

Thanks for taking the time to improve the Audio Recorder! This project is a
dependency-light, framework-free PWA, so the bar is "small, readable, tested".

## Getting started

```bash
git clone https://github.com/ghana-gpt/Responsive-Working-Audio-Recorder-.git
cd Responsive-Working-Audio-Recorder-
npm ci                 # eslint, prettier, puppeteer-core (no browser download)
npm start              # http://127.0.0.1:4173 — microphone needs localhost/https
npm run verify         # must pass before you open a pull request
```

`npm run test:e2e` needs a Chrome/Chromium binary. Set
`PUPPETEER_EXECUTABLE_PATH=/path/to/chrome` if it is not in a standard location; the
suite prints a skip message (exit 0) when no browser is found unless `E2E_STRICT=1`.

## Ground rules

1. **No runtime dependencies.** The app must stay deployable as static files with no
   bundler. Dev dependencies are limited to lint/format/test tooling.
2. **Keep the layering.** Views render and emit intents; `scripts/main.js` owns state
   and data; pure modules (`wav.js`, `zip.js`, `mime.js`, `library.js`, `sanitize.js`,
   `format.js`, `state.js`) must not touch the DOM so they stay unit-testable.
3. **Accessibility is not optional.** New controls need a label, keyboard access,
   visible focus and a `role`/state that matches reality. Announce async status changes.
4. **Privacy first.** No network calls, no third-party assets, no telemetry. If you add
   an outbound link, make it `rel="noopener noreferrer"` and document it.
5. **Translate everything.** Any user-visible string goes through `t()` and needs both
   `en` and `fr` entries — the `diffKeys` unit test enforces parity.
6. **Keep the CSP working.** No inline scripts/styles, no `eval`, no remote fonts.

## Adding a feature

- **Pure logic** → put it in a module under `scripts/modules/`, export named functions,
  add a `tests/unit/*.test.js` suite.
- **UI** → add markup to `index.html` with `data-i18n*` attributes (the validator fails on
  unknown keys), extend the relevant view factory, and wire the new intent in
  `handleLibraryIntent`/`handleSettingsChange` inside `scripts/main.js`.
- **Precached asset** → add it to `SHELL_ASSETS` in `service-worker.js` and bump `VERSION`.
- **New icon** → draw it in `tools/generate-icons.mjs`, then run `npm run icons`.

## Commit style

Conventional Commits with a short imperative subject:

```text
feat(library): add bulk ZIP export
fix(recorder): release the microphone when the track ends
docs(readme): document the e2e browser override
test(wav): cover stereo slice clamping
```

## Pull requests

- One focused change per PR, with a short "what/why" description.
- Include screenshots or a GIF for visual changes.
- Confirm `npm run verify` passes and mention anything you could not test locally
  (e.g. Safari-only behaviour).
- Never commit recordings, credentials or `node_modules`.

## Reporting bugs

Use the issue template and include: browser + version, OS, the steps you took, what you
expected, what happened, and any console output. For microphone problems, say whether
the page is served over https/localhost and whether the permission prompt appeared.

## Security

Please report vulnerabilities privately through GitHub's "Report a vulnerability"
button rather than in a public issue.
