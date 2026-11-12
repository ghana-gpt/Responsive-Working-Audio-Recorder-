# Third-party notice: lamejs 1.2.1

The only third-party code in this repository lives in this directory. It is the
MP3 encoder that the app uses when the browser cannot record MP3 natively
(`scripts/modules/mp3.js`). Everything else in the repository is MIT licensed
(see the root `LICENSE`); **this directory keeps its own licence**.

## What is here

| File                            | Purpose                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `lame.min.js`                   | Minified bundle the app serves and loads (precached by `service-worker.js`).             |
| `lame.all.js`                   | Same bundle, unminified — kept so the shipped code can be read and audited.               |
| `src/js/*.js`                   | Upstream module sources, the build inputs for the two bundles above.                      |
| `README.md`, `makeall.sh`       | Upstream documentation and build script.                                                  |
| `LICENSE`, `LICENSE.LGPL-3.0.txt`, `LICENSE.GPL-3.0.txt` | Upstream licence files: the LGPL-3.0 text plus the GPL-3.0 it incorporates. |

## Provenance

- Project: **lamejs** — "Fast mp3 encoder written in JavaScript"
- Version: **1.2.1** (see `package.json` here)
- Upstream: <https://github.com/zhuker/lamejs> — author Alex Zhukov
- Lineage: a JavaScript rewrite of `jump3r`, itself a rewrite of `libmp3lame`
  (the LAME project, <https://lame.sourceforge.net/>)

The files are copied **unmodified** from the published 1.2.1 release. No patches
are applied. `npm run format` and `npm run lint` skip this directory on purpose
(`.prettierignore`, `eslint.config.js`) so the copy stays byte-identical to
upstream.

## Licence and obligations

lamejs is distributed under the **GNU Lesser General Public License v3.0**
(LGPL-3.0), inherited from LAME. The root MIT licence of this application does
**not** extend to this directory. The obligations that matter for this
repository:

1. **Separate files, dynamically loaded.** The encoder is not linked into the
   app's modules: `scripts/modules/mp3.js` appends a `<script>` element that
   loads `lame.min.js` from this origin, and only when an MP3 export is
   requested. Nothing else in the app imports it, so it can be replaced with
   another build without touching application code.
2. **Attribution.** The LAME project is acknowledged in the app footer
   (`footer.encoderLicense` in `scripts/modules/i18n.js`, rendered by
   `index.html`), in `README.md`, and here.
3. **Source availability.** The complete corresponding source ships alongside the
   minified bundle (`src/js/`, `lame.all.js`), so no separate download is needed.
4. **Modifications.** There are none. If this copy is ever patched, the change
   must be published under the LGPL-3.0 as well and recorded here.

The upstream `LICENSE` file asks integrators to link to the LAME site — that link
is <https://lame.sourceforge.net/>.

## How the app uses it

- Loaded on demand: `scripts/modules/mp3.js` → `https://<origin>/vendor/lamejs-1.2.1/lame.min.js`
- Precached for offline use: `SHELL_ASSETS` in `service-worker.js`
- Wrapped by `encodeMp3Async()` (`scripts/modules/mp3.js`), which chunks PCM,
  reports progress and honours `AbortSignal` cancellation through the shared
  contract in `scripts/modules/conversion.js`
- Never fetched from a CDN: the Content-Security-Policy allows `script-src 'self'`
  only, and the app makes no network requests after load
