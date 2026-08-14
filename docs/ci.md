# GitHub Actions

**English** · [日本語](./ci.ja.md)

Three workflows run on this repository. This page covers what each one protects,
how to read a failure, and the one-time repository settings they depend on.

Related: [Development guide](./development.md) / [Release](./release.md)

---

## 1. Overview

| Workflow | File | Trigger | Purpose |
| --- | --- | --- | --- |
| **CI** | `.github/workflows/ci.yml` | push to `main`, every PR | Verify the checks and the build pass |
| **Pages** | `.github/workflows/pages.yml` | push to `main`, manual | Check → build → deploy to GitHub Pages |
| **Release** | `.github/workflows/release.yml` | push of a `v*` tag | Check → build → publish to npm |

```text
open a PR ─────────────► CI (checks only)
                            │
merge to main ─────────► CI + Pages (site updated)
                            │
push tag v0.2.0 ───────► Release (published to npm)
```

All three run the same checks up front. The duplication is deliberate: the point
is **never to publish something broken**.

---

## 2. CI

`.github/workflows/ci.yml`

```yaml
on:
  push:
    branches: [main]
  pull_request
```

Node 22 on `ubuntu-latest`, `npm ci`, then in order:

| Step | Command | What to suspect when it fails |
| --- | --- | --- |
| Unit tests | `npm test` | A logic regression. Reproduce with `npm test` locally |
| Type check (JSDoc) | `npm run typecheck` | JSDoc drifting from the implementation: unchecked `null`, swapped arguments |
| Layer boundaries | `npm run lint:layers` | A reversed dependency, a missing file extension, a DOM global sneaking in |
| Locale key coverage | `npm run lint:locales` | A missing translation or a dropped placeholder |
| Build | `npm run build` | An import esbuild cannot resolve |
| Assemble site | `npm run build:site` | An absolute path, or a reference bypassing `web/esp-flashjs.js` |

### 2.1 Reproducing CI locally

```sh
npm run check                                          # the four checks
npm run check && npm run build && npm run build:site   # identical to CI
```

`npm ci` installs strictly from `package-lock.json`. If you ran `npm install`
locally, updated the lock file and forgot to commit it, CI is running on
different dependencies than you are. Always commit lock file changes.

### 2.2 Caching

`actions/setup-node` with `cache: npm`. With three dependencies the saving is
small, but it costs nothing.

---

## 3. Pages

`.github/workflows/pages.yml`

### 3.1 Why not "deploy from a branch"

With "Deploy from a branch", the publishing directory can only be the repository
root or `/docs`. But `dist/` is gitignored and does not exist in the repository,
so serving a site that includes build output requires Actions.

There is a second benefit: **only what passes CI gets published.** Branch-based
publishing ships on every push, failing tests and all.

### 3.2 Permissions and concurrency

```yaml
permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true
```

`id-token: write` is required for OIDC-based deployment. The `concurrency` group
stops an older deployment from landing on top of a newer one after rapid pushes.

### 3.3 Steps

`npm ci` → `npm test` → `npm run typecheck` → `npm run lint:layers` →
`npm run lint:locales` → `npm run build` → `npm run build:site` → upload `site/`
→ deploy.

The result is served at `https://tanakamasayuki.github.io/esp-flashjs/`.

### 3.4 Propagation delay

A successful deployment can take a few minutes to become visible. Pages sets a
`Cache-Control` of roughly 10 minutes, so try a hard reload (Ctrl+Shift+R).

### 3.5 Manual runs

Actions tab → Deploy to GitHub Pages → Run workflow. `workflow_dispatch` is
enabled, so you can redeploy without a code change.

---

## 4. Release

`.github/workflows/release.yml`

A tag push is the only trigger. The procedure is in
[release.md](./release.md); this section covers the mechanism.

```yaml
on:
  push:
    tags: ['v*']

permissions:
  contents: write
  id-token: write   # required for npm provenance
```

After the same checks as CI: `npm run build` → `npm run types` (emit `.d.ts`) →
`npm publish --provenance --access public`.

### 4.1 What provenance does

`--provenance` attaches a verifiable statement to the npm package saying it was
published from this GitHub Actions workflow run. A badge appears on the package
page.

For a library that rewrites device firmware, being able to trace where a release
came from has real value. It requires `id-token: write`.

---

## 5. One-time repository setup

The workflow files alone are not enough. These are set once in the GitHub UI.

### 5.1 Pages

**Settings → Pages → Build and deployment → Source** must be **"GitHub
Actions"**.

The default is "Deploy from a branch". Leave it there and `pages.yml` succeeds
while publishing nothing.

### 5.2 Publishing to npm

Pick one.

**A. Trusted Publishing (recommended)**

On npmjs.com, register the GitHub repository and the workflow filename
(`release.yml`) in the package settings. No long-lived token lives in the
repository.

The package has to exist first, so the very first release is published by hand
from a local machine.

**B. Token**

Create an npm Automation token and add it under **Settings → Secrets and
variables → Actions** as `NPM_TOKEN`. That is the name `release.yml` reads.

### 5.3 Environment (optional)

`pages.yml` uses a `github-pages` environment, created automatically on first
deploy. Nothing to do unless you want an approval gate, which you can add under
**Settings → Environments**.

---

## 6. Reading a failure

### 6.1 Find the step

Actions tab → the run → open the red step. The step names are the diagnosis.

### 6.2 By symptom

| Symptom | Cause and fix |
| --- | --- |
| `npm ci` fails | `package-lock.json` disagrees with `package.json`. Run `npm install` locally and commit the lock |
| Only the tests fail | Reproduce locally. Nothing in the suite depends on time, locale, hardware or concurrency, so it should reproduce |
| Only the type check fails | Run `npx tsc --noEmit`. Editors sometimes serve a stale cache; trust the command |
| `lint:layers`: "must not import from" | A dependency violation. Usually the responsibility is in the wrong place, so move the file rather than reaching for an escape hatch |
| `lint:layers`: "missing a file extension" | Add `.js` to the import |
| `lint:locales`: missing | Add the translation, or remove the key from `en.json` |
| `build:site`: "Absolute paths found" | Something wrote `/src/...`. The site is served from a subdirectory, so this always breaks |
| Pages succeeds but nothing changes | Check that Source is "GitHub Actions". Then suspect caching |
| Release: 403 / E404 | npm permissions. An expired token, or Trusted Publishing not configured |
| Release: provenance error | Check `id-token: write`. It does not work for tags pushed from a fork |

### 6.3 Re-running

Transient network failures clear with "Re-run failed jobs". But **do not expect
a failing test to pass on a retry**. Nothing in this suite touches hardware or
the network, so a failure is a real one.

---

## 7. Changing a workflow

A PR that edits `.github/workflows/*.yml` runs CI **using the definition on that
branch** (for `pull_request` triggers). `pages.yml` and `release.yml`, by
contrast, only take effect once merged to `main`.

`pages.yml` has `workflow_dispatch`, so you can verify it manually after
merging. `release.yml` is less forgiving — a failure means re-tagging. Test
changes with a throwaway version such as `v0.0.1-test`.

---

## 8. Deliberately not done

| Not done | Reason |
| --- | --- |
| Linting (ESLint / Prettier) | Type checking and layer checking already catch what causes harm. Enforcing formatting preferences is not worth it at this size |
| Browser E2E | Playwright would multiply the devDependency count. The UI is covered by the [manual checklist](./development.md#9-manual-testing-against-hardware) instead |
| Hardware tests | Possible with a self-hosted runner and a board attached, but not worth it yet |
| A coverage threshold | Enforcing a number invites tests written to satisfy it. `npm run test:coverage` is there to look at |
| Automated dependency updates | Three devDependencies. Checking by hand is faster |

Every one of these is worth revisiting if the project grows.
