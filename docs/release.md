# Release procedure

**English** · [日本語](./release.ja.md)

Publishing to npm and updating GitHub Pages.

Related: [Development guide](./development.md) / [CI](./ci.md) / [Publishing](./publishing.md)

---

## 1. Overview

There are two publishing targets, and **their triggers differ**.

| Target | Trigger | Frequency |
| --- | --- | --- |
| **GitHub Pages** | push to `main` | Automatic, every time |
| **npm** | push of a `v*` tag | Only on release |

Merging to `main` keeps the site current on its own, but publishes nothing to
npm. Reaching npm always requires the explicit act of pushing a tag.

---

## 2. Versioning

Semver.

**While on `0.x`, breaking changes may go into a minor bump** (`0.1.0` →
`0.2.0`). The API is not settled yet. The README says so too.

`1.0.0` waits until all of the following hold:

- The major chips have been verified on real hardware
- NVS editing and write-back (Phase 2) works
- No breaking API changes are still wanted

| Change | On 0.x | On 1.0+ |
| --- | --- | --- |
| Bug fix | patch | patch |
| New feature | minor | minor |
| Breaking change | minor | major |

---

## 3. First release only

One-time setup. For every subsequent release, skip to [section 4](#4-release-procedure).

### 3.1 Check the package name

```sh
npm view esp-flashjs
```

A `404` means it is free. If someone holds it, pick another name and update
`package.json`'s `name`, the import examples in both READMEs, and every CDN URL.

### 3.2 Publish the first version by hand

Trusted Publishing can only be configured on a package that already exists, so
the first publish comes from a local machine.

```sh
npm login
npm run check && npm run build && npm run types
npm publish --access public
```

### 3.3 Configure Trusted Publishing

On the npmjs.com package page → Settings → Trusted Publisher:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Repository | `tanakamasayuki/esp-flashjs` |
| Workflow filename | `release.yml` |

This keeps long-lived tokens out of the repository. If you skip it, add an npm
Automation token as the `NPM_TOKEN` secret instead
([CI §5.2](./ci.md#52-publishing-to-npm)).

### 3.4 Enable GitHub Pages

**Settings → Pages → Source** must be **"GitHub Actions"**. Left at the default,
the workflow succeeds and publishes nothing.

---

## 4. Release procedure

### 4.1 Pre-flight

```sh
git switch main && git pull
npm ci
npm run check && npm run build && npm run build:site
```

Use `npm ci`, not `npm install`: verifying against dependencies that differ from
the lock file proves nothing.

Confirm:

- [ ] `main` is current and the tree is clean (`git status`)
- [ ] `npm run check` passes
- [ ] Both READMEs reflect the changes (supported chips, phase progress, API changes)
- [ ] Any breaking change is called out in the READMEs
- [ ] The hardware-verification table is updated for anything newly tested
- [ ] `npm pack --dry-run` contains the right files ([4.2](#42-check-the-package-contents))

### 4.2 Check the package contents

```sh
npm pack --dry-run
```

**Must be present:** `dist/`, `src/`, `types/`, `README.md`, `README.ja.md`,
`LICENSE`, `NOTICE`

**Must be absent:** `web/`, `examples/`, `test/`, `site/`, `scripts/`, `docs/`

npm consumers do not need the reference app; shipping it only inflates the
tarball. The `files` field controls this.

`src/protocol/stub/*.json` and `dist/stub/*.json` **must be included** — they are
fetched at runtime, and flash reads do not work without them.

### 4.3 Bump the version and tag

```sh
npm version minor    # or patch / major
```

npm's lifecycle turns this single command into the following:

| Stage | What runs | Effect |
| --- | --- | --- |
| `preversion` | `npm run check` | The checks. **A failure stops here** and no version is bumped |
| — | npm | Updates `version` in `package.json` |
| `version` | `scripts/sync-version.js` | Syncs the `VERSION` constant in `src/index.js` and stages it |
| — | npm | Creates the commit (message `0.2.0`) and the `v0.2.0` tag |

The `VERSION` sync is automated because doing it by hand always drifts, and a
drifted constant makes the version line in an attached bug report a lie.

**Still manual:** the version numbers written into CDN URLs in both READMEs and
in `examples/`. Left stale, someone trying a new feature loads old code.

```sh
grep -rn "esp-flashjs@[0-9]" README.md README.ja.md examples/ docs/
```

### 4.4 Push

```sh
git push origin main
git push origin --tags
```

The `main` push triggers Pages; the tag push triggers Release.

### 4.5 Verify

Once **Release to npm** is green in the Actions tab:

```sh
npm view esp-flashjs version        # the new version should appear
npm view esp-flashjs dist.tarball
```

Then the CDN — jsDelivr can lag by a few minutes:

```sh
curl -sI https://cdn.jsdelivr.net/npm/esp-flashjs@0.2.0/dist/esp-flashjs.min.js | head -1
```

Check for the provenance badge on the npm package page. If it is missing, look
at `id-token: write` and the Trusted Publishing configuration.

### 4.6 Write the GitHub Release

The tag exists, so go to Releases → Draft a new release, select it, and write up
the changes. Nothing generates this automatically.

Worth including:

- New features
- **Breaking changes** — on `0.x` these arrive in a minor bump, so make them
  impossible to miss
- Bug fixes
- Chips that have newly been verified on hardware

---

## 5. After publishing

- [ ] `https://tanakamasayuki.github.io/esp-flashjs/` runs the new version
- [ ] The CDN example works (run the README snippet verbatim)
- [ ] `npm i esp-flashjs` followed by an `import` succeeds
- [ ] TypeScript consumers get types (the `.d.ts` emitted correctly)

For the last one, use a throwaway directory:

```sh
mkdir /tmp/check && cd /tmp/check && npm init -y
npm i esp-flashjs
node -e "import('esp-flashjs/core').then(m => console.log(Object.keys(m).length, 'exports'))"
```

---

## 6. When something goes wrong

### 6.1 Caught before pushing

Nothing has left the machine yet.

```sh
git tag -d v0.2.0
git reset --hard HEAD~1     # undo the npm version commit
```

### 6.2 Already published

**Treat an npm publish as irreversible.** `npm unpublish` only works within 72
hours and only if nothing depends on the package, and the version number can
never be reused.

**The rule: don't withdraw, ship the fix.**

```sh
# Flag the broken version so consumers hear about it
npm deprecate esp-flashjs@0.2.0 "Broken flash read; use 0.2.1 or later"

# Fix and release a patch
npm version patch
git push origin main --tags
```

The `latest` dist-tag moves to the new version automatically, so
`npm i esp-flashjs` gets the fix.

### 6.3 Pages is broken

Revert on `main` and push; the next deploy restores it. To move faster,
`git revert` to the last good commit and trigger the workflow manually from the
Actions tab.

---

## 7. Checklist

```text
Prepare
  [ ] main is current and clean
  [ ] npm ci
  [ ] npm run check && npm run build && npm run build:site
  [ ] npm pack --dry-run shows the right files
  [ ] READMEs: chip table and phase progress updated
  [ ] READMEs and examples: CDN version numbers updated

Release
  [ ] npm version <patch|minor|major>    ← checks and VERSION sync are automatic
  [ ] git push origin main
  [ ] git push origin --tags

Verify
  [ ] Actions: Release is green
  [ ] Actions: Pages is green
  [ ] npm view esp-flashjs version
  [ ] Provenance badge present
  [ ] The Pages site works
  [ ] The CDN URL resolves
  [ ] GitHub Release notes written
```
