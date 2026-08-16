# Distribution and publishing

**English** · [日本語](./publishing.ja.md)

This document records the **decisions and their reasons**. The hands-on steps
live in [release.md](./release.md), and the workflows are explained in
[ci.md](./ci.md). The specification itself is [spec.md](./spec.md).

---

## 1. Conclusion

Three channels.

| Channel | Audience | URL / specifier |
| --- | --- | --- |
| **GitHub Pages** | People who want to try the web app | `https://tanakamasayuki.github.io/esp-flashjs/` |
| **npm** | People integrating it into a project | `npm i esp-flashjs` |
| **CDN** | People who want it without a build step | `https://cdn.jsdelivr.net/npm/esp-flashjs@0.1.0/dist/esp-flashjs.min.js` |

### 1.1 Library distribution follows plainbind

The distribution setup matches [plainbind](https://github.com/tanakamasayuki/plainbind),
an existing JavaScript project by the same author.

| Aspect | plainbind | ESP FlashJS |
| --- | --- | --- |
| npm package name | `plainbind` (unscoped) | `esp-flashjs` (unscoped) |
| CDN | jsDelivr serving `dist/*.min.js` | same |
| Build | `scripts/build.js` (esbuild) → `dist/`, gitignored | same |
| `package.json` | `main` / `module` / `browser` / `unpkg` / `jsdelivr` / `exports` together | same |
| `files` | ships both `dist` and the sources | same |
| README | `README.md` + `README.ja.md` | same |
| License / author | MIT / TANAKA Masayuki | same |

The sources under `src/` can be imported directly with no build, and
`dist/esp-flashjs.min.js` exists for people who prefer a `<script src>`. **The
build is a convenience for distribution, not a prerequisite for using the
library.**

---

## 2. GitHub Pages

The web app is itself a primary deliverable, and **Web Serial only works in a
secure context (HTTPS)** — so an HTTPS demo page is what makes the project
trialable at all.

### 2.1 Delivery: GitHub Actions

"Deploy from a branch" limits the publishing directory to the repository root or
`/docs`, and `dist/` is gitignored so it is not in the repository. Delivering
through Actions allows any layout, including build output, and **keeps the
repository root as tidy as plainbind's**.

Secondary benefit: publication can be gated on CI passing. Branch publishing
ships on push regardless of whether the tests pass.

Set **Settings → Pages → Source** to **"GitHub Actions"**.

### 2.2 How `site/` is assembled

`scripts/build-site.js` produces:

```text
site/
├── index.html            ← web/index.html
├── app.js                ← web/app.js
├── store.js / actions.js / i18n.js
├── components/           ← web/components/
├── locales/              ← web/locales/
├── styles/               ← web/styles/
├── esp-flashjs.js        ★ rewritten (below)
│
├── src/                  ← copied verbatim
├── examples/             ← copied verbatim
├── dist/                 ← output of npm run build
└── docs/                 ← copied verbatim
```

That is: **the contents of `web/` move to the site root; everything else keeps
its repository-relative position.**

Only `web/` changes depth, so its relative references into `src/` shift by one
level. That is absorbed by funnelling every such reference through a single
file, `web/esp-flashjs.js` ([spec §4.4](./spec.md#44-module-resolution-and-paths)).

```js
// web/esp-flashjs.js in the repository
export * from '../src/index.js';

// what build-site.js writes to site/esp-flashjs.js
export * from './src/index.js';
```

**That one file is the only thing rewritten.** Everything else inside `web/`
refers to siblings, so moving the directory cannot break it. `examples/` lands at
its repository depth, so `../src/index.js` still resolves and needs no rewrite.

The result: **the same sources behave identically** whether served from the
repository during development or from the published site.

### 2.3 The workflow

`.github/workflows/pages.yml`. Checks → build → upload `site/` → deploy, with
the same checks CI runs placed first.

The judgement is that **publishing late beats publishing something broken**, so a
failing check blocks the deployment.

Permissions, concurrency and the one-time repository setup are covered in
[ci.md](./ci.md).

### 2.4 Things to watch

| Item | Detail |
| --- | --- |
| No absolute paths | The site lives under `/esp-flashjs/`, so `/src/...` always breaks. Every path in HTML, JS and CSS must be relative. CI greps for violations |
| `.nojekyll` | **Not needed.** Actions-based delivery does not run Jekyll. Do not add one |
| HTTPS | Web Serial requires a secure context. Pages is HTTPS. Locally use `http://localhost`; a LAN address (`http://192.168.x.x`) will not work |
| MIME types | `.js` is served as `text/javascript` and `.json` correctly. No configuration needed |
| Custom headers | None required. `SharedArrayBuffer` is not used, so no COOP/COEP. Pages cannot set headers anyway, which makes this a deliberate design constraint |
| Caching | Pages sets roughly a 10-minute `Cache-Control`; updates are not instant |
| Size | 1 GB limit, under 100 MB recommended. All the stub JSON together is a few hundred KB |
| Custom domain | Have `build-site.js` emit `site/CNAME` |

### 2.5 Local development

Under `file://`, ESM imports and `fetch` fail on CORS, so an HTTP server is
required. In keeping with the zero-dependency stance, the dev server is a
self-contained `scripts/serve.js` built on `node:http`.

```sh
npm run dev
```

It serves the repository root, so `http://localhost:8080/web/` is the app and
`http://localhost:8080/examples/` the samples — no build involved. **Local and
Pages behave the same** thanks to the layout in 2.2.

The full script list is in [development.md](./development.md).

---

## 3. npm

### 3.1 A single package

**Published as `esp-flashjs`, unscoped.**

- Given the build setup, splitting into several packages gains consumers
  nothing; `exports` subpaths and the split `dist` achieve the same effect.
- An unscoped name keeps `npm i esp-flashjs` and the CDN URLs short.
- If a split becomes necessary later, `@esp-flashjs/*` can be added while the
  `exports` subpaths stay in place.

Check availability with `npm view esp-flashjs` before publishing.

### 3.2 What `dist/` contains

Two variants, so people who only analyze files offline do not carry the serial
code.

```text
dist/
├── esp-flashjs.js            full  ESM, unminified   107 KB
├── esp-flashjs.min.js        full  ESM, minified      52 KB
├── esp-flashjs.core.js       core  ESM, unminified    53 KB
├── esp-flashjs.core.min.js   core  ESM, minified      28 KB
└── stub/*.json               fetched at runtime      132 KB (never inlined)
```

(Sizes measured on v0.1.0.)

| | full | core |
| --- | --- | --- |
| Entry point | `src/index.js` | `src/core.js` |
| Includes | everything | `format/` `binary/` `util/` |
| Excludes | — | `transport/` `protocol/` `device/` `stub/` |
| For | operations against a device | offline file analysis, Node.js |

**Stub JSON is never inlined into the bundle.** Base64-encoding every chip would
add a few hundred KB to the main file and charge it to people who only ever
parse files. They ship as individual files under `dist/stub/`, fetched at runtime
via `new URL('./stub/<chip>.json', import.meta.url)`, which resolves correctly
through a CDN as well.

`scripts/build.js` uses esbuild for `bundle` and `minify` only; **no target
transform**. The sources are already syntax browsers and Node.js accept
natively.

### 3.3 `package.json`

```jsonc
{
  "name": "esp-flashjs",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "author": "TANAKA Masayuki",
  "sideEffects": false,

  "main": "dist/esp-flashjs.js",
  "module": "dist/esp-flashjs.js",
  "browser": "dist/esp-flashjs.min.js",
  "unpkg": "dist/esp-flashjs.min.js",
  "jsdelivr": "dist/esp-flashjs.min.js",
  "types": "types/index.d.ts",

  "exports": {
    ".":        { "types": "./types/index.d.ts", "default": "./dist/esp-flashjs.js" },
    "./core":   { "types": "./types/core.d.ts",  "default": "./dist/esp-flashjs.core.js" },
    "./src/*":  "./src/*",
    "./package.json": "./package.json"
  },

  "files": ["dist", "src", "types", "README.md", "README.ja.md", "LICENSE", "NOTICE"]
}
```

- `files` includes `src`, so the **unbundled sources ship too**. That serves
  people who want to import individual modules, and people reading the source
  straight off jsDelivr.
- `web/`, `examples/` and `test/` are excluded. npm consumers do not need the
  reference app.
- `homepage` points at the Pages URL so the npm page links to a live demo.

### 3.4 Type definitions

Sources are not written in TypeScript, but `.d.ts` files are generated from the
JSDoc and shipped. No type files are maintained by hand.

```jsonc
// tsconfig.json — type checking and .d.ts emission only. Never transpilation.
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowJs": true,
    "checkJs": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.js", "web/**/*.js"]
}
```

- CI runs `tsc --noEmit` over the JSDoc. In binary handling, a swapped argument
  or a forgotten `await` does not raise — it quietly writes a corrupted image.
  That is what makes this check worth its cost.
- `types/` is emitted through `tsconfig.types.json` (`rootDir: src`). The
  checking config also covers `web/`, so using it directly would emit to
  `types/src/index.d.ts` and never produce the `types/index.d.ts` that
  `package.json` points at.
- `prepack` emits it automatically during `npm publish`. **The output is not
  committed.**

### 3.5 Publishing flow

**Publishing to npm happens from a local machine**, so no token lives in the
repository.

```sh
npm version patch              # preversion runs the checks; VERSION is synced
npm publish --access public    # prepack runs build + types
git push --follow-tags
```

`.github/workflows/release.yml` still exists but is `workflow_dispatch` only; a
tag push does not fire it, because it would race the local publish and fail
every time. To publish from CI instead, configure Trusted Publishing (OIDC) and
run it by hand.

- When publishing from Actions, **use `--provenance`.** For a library that
  rewrites device firmware, a verifiable origin is worth having.
- Semver, with breaking changes allowed in a minor bump while on `0.x` — stated
  in the README.

The step-by-step procedure is in [release.md](./release.md).

---

## 4. CDN

Publishing to npm is all that is required; the following then works.

```html
<!-- Preferred: jsDelivr -->
<script type="module">
  import { parsePartitionTable } from 'https://cdn.jsdelivr.net/npm/esp-flashjs@0.1.0/dist/esp-flashjs.core.min.js';
</script>
```

| CDN | Use |
| --- | --- |
| **jsDelivr** | Primary. Serves `dist/*.min.js` as-is, same as plainbind |
| unpkg | Backup, same shape |
| esm.sh | When bare specifiers need resolving, or for `?bundle` |

Because the library has zero runtime dependencies and contains no bare
specifiers, **plain pass-through delivery just works**. You can even bypass
`dist/` and read `src/` directly:

```html
<script type="module">
  import { parseNvs } from 'https://cdn.jsdelivr.net/npm/esp-flashjs@0.1.0/src/format/nvs/parse.js';
</script>
```

**Always pin the version** in documented examples. An unpinned URL in a README
breaks other people's pages the moment a breaking change lands.

---

## 5. Not published

| Item | Reason |
| --- | --- |
| A CommonJS build | Node.js 20+ handles ESM natively. Not worth maintaining twice |
| IIFE / UMD builds | `<script type="module">` suffices. No global namespace pollution offered |
| Docker images, desktop apps | Out of scope |
| Flash dumps from real devices | Fixtures are anonymized only. Never commit a dump containing MAC addresses, Wi-Fi credentials or certificates |

---

## 6. Licensing and attribution

- The project: **MIT** (`LICENSE`).
- Bundled flasher stubs: release JSON from
  [espressif/esp-flasher-stub](https://github.com/espressif/esp-flasher-stub),
  **dual licensed Apache-2.0 OR MIT**, which makes it includable in an MIT
  project. Attribution goes in `NOTICE`, and the source release tag is recorded
  in `src/protocol/stub/README.md`.
- The older [espressif/esptool-legacy-flasher-stub](https://github.com/espressif/esptool-legacy-flasher-stub)
  is **GPL-2.0 and deliberately not used.** `scripts/fetch-stub.js` pins the
  release URL so it cannot arrive by accident.
- The protocol was implemented against the
  [published esptool documentation](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html).
  No code was copied; the implementation is original to this repository.
- Both READMEs state that this is not an official Espressif Systems project.

---

## 7. Pre-publication checklist

- [ ] `npm view esp-flashjs` confirms the name is available
- [ ] No absolute paths anywhere (`src="/`, `from '/`) — verified by grep
- [ ] Settings → Pages → Source = GitHub Actions
- [ ] `npm login` done, with 2FA enabled on the npm account
- [ ] The output of `npm run build:site` opens and works
- [ ] Verified by hand on Pages, through to a real device connection in Chrome
- [ ] Opened in Firefox or Safari: binary mode works, the connect UI says "not supported"
- [ ] All four locales (en / ja / zh-Hans / zh-Hant) render without breakage
- [ ] `NOTICE` carries the stub attribution
- [ ] No secrets from real hardware in the fixtures
- [ ] READMEs state the disclaimer, browser support and per-chip verification status
- [ ] `npm pack --dry-run` shows the right files (no `web/`, `examples/`, `test/`)
- [ ] CDN examples pin their version
