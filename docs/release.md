# Release procedure

**English** · [日本語](./release.ja.md)

Publishing to npm happens **from a local machine**, so that no token lives in
this repository.

Related: [Development guide](./development.md) / [CI](./ci.md) / [Publishing](./publishing.md)

---

## 1. Every release (copy and paste this)

With `main` clean and everything committed:

```sh
npm version patch              # patch for fixes / minor for features / major for breaking changes
npm publish --access public    # enter the 2FA code when asked
git push --follow-tags
```

That is the whole procedure. What each command does on its own:

| Command | Runs automatically |
| --- | --- |
| `npm version <ver>` | ① `preversion` = `npm run check` (tests, types, layers, locales — **a failure means no version is created**) ② `scripts/sync-version.js` syncs the `VERSION` constant in `src/index.js` ③ commits and creates the `v*` tag |
| `npm publish` | `prepack` = `npm run build` + `npm run types`, producing `dist/` and `types/` before packing |
| `git push --follow-tags` | Pushes the commit and the tag. Pages redeploys. **release.yml does not fire** — it is a manual-only spare |

Choosing the bump:

| Change | Command |
| --- | --- |
| Bug fix or documentation only | `npm version patch` |
| Backwards-compatible feature | `npm version minor` |
| Breaking change (API changed or removed) | `npm version major` |

While on `0.x`, **breaking changes may go into a minor bump** (`0.1.0` →
`0.2.0`). The API is not settled yet, and the README says so.

---

## 2. What is automatic and what is not

Pushing does not publish to npm. **A local `npm publish` is the only route.**

| Target | Trigger | Where it runs |
| --- | --- | --- |
| **npm** | `npm publish` | **Your machine** |
| **GitHub Pages** | push to `main` | GitHub Actions, automatically |
| **CI (checks)** | push / PR | GitHub Actions, automatically |

`release.yml` does not run on a tag push. It would race the local publish and
fail red on a version npm already has. To publish from CI instead, see
[section 6](#6-if-you-want-to-publish-from-ci).

---

## 3. What to check by hand first

`npm version` runs `npm run check`, so tests, types, layers and locales are
covered. Only the things it cannot see are left.

- [ ] `git status` is clean
- [ ] The **chip support table** in both READMEs is current — mark a chip
      verified only if it actually was
- [ ] Phase progress in the READMEs matches reality
- [ ] Any breaking change is written up in the READMEs
- [ ] The **version in every CDN URL** in the READMEs and `examples/` is bumped

```sh
grep -rn "esp-flashjs@[0-9]" README.md README.ja.md examples/ docs/
```

Left stale, someone trying a new feature loads old code.

### Check the package contents

```sh
npm pack --dry-run
```

**Must be present:** `dist/`, `src/`, `types/`, `README.md`, `README.ja.md`,
`LICENSE`, `NOTICE`

**Must be absent:** `web/`, `examples/`, `test/`, `site/`, `scripts/`, `docs/`

`src/protocol/stub/*.json` and `dist/stub/*.json` **must be included** — they are
fetched at runtime, and flash reads do not work without them.

---

## 4. After publishing

```sh
npm view esp-flashjs version
```

- npm page: <https://www.npmjs.com/package/esp-flashjs>
- CDN (can lag by a few minutes): <https://cdn.jsdelivr.net/npm/esp-flashjs/dist/esp-flashjs.min.js>
- Web app: <https://tanakamasayuki.github.io/esp-flashjs/>

To confirm the type definitions arrived, use a throwaway directory:

```sh
mkdir /tmp/check && cd /tmp/check && npm init -y
npm i esp-flashjs
node -e "import('esp-flashjs/core').then(m => console.log(Object.keys(m).length, 'exports'))"
```

Write the GitHub Release by hand (Releases → Draft a new release, pick the tag).
Worth including: new features, **breaking changes** (on `0.x` they arrive in a
minor bump, so make them impossible to miss), bug fixes, and any chip newly
verified on hardware.

---

## 5. When something goes wrong

**`403 Two-factor authentication ... is required`**

The one-time code did not reach npm. `npm version` already succeeded, so only
the publish needs repeating.

```sh
npm publish --access public --otp=123456   # the current six digits from your authenticator
```

**Undo a version before publishing**

```sh
git reset --hard HEAD~1      # drop the commit npm version created
git tag -d v0.1.1            # and the tag (adjust the number)
```

**Fix a version that is already published**

Avoid `npm unpublish` — it is limited to 72 hours and the number can never be
reused. Ship the fix instead.

```sh
npm deprecate esp-flashjs@0.2.0 "Broken flash read; use 0.2.1 or later"
npm version patch
npm publish --access public
git push --follow-tags
```

The `latest` dist-tag moves automatically, so `npm i esp-flashjs` gets the fix.

**`npm version` stopped at the checks**

That is its job. No version and no tag were created, so fix the problem and run
it again.

**Pages is broken**

Revert on `main` and push; the next deploy restores it. To move faster, run
Deploy to GitHub Pages manually from the Actions tab.

---

## 6. If you want to publish from CI

`.github/workflows/release.yml` is still there. It is `workflow_dispatch` only,
so it runs **only when started by hand from the Actions tab**.

To use it, register Trusted Publishing in the package settings on npmjs.com:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Repository | `tanakamasayuki/esp-flashjs` |
| Workflow filename | `release.yml` |

That publishes without a token and attaches provenance — a verifiable statement
that the package came from this workflow run. For a library that rewrites device
firmware, being able to trace where a release came from has real value.

Without Trusted Publishing, add an npm Automation token as the `NPM_TOKEN`
secret.

---

## 7. First-time setup (already done)

**v0.1.0 was published on 2026-08-16** (<https://www.npmjs.com/package/esp-flashjs>).
What follows is a record; none of it needs doing again.

1. Confirm `npm view esp-flashjs` returns 404, meaning the name is free. If
   someone holds it, pick another name and update `package.json`'s `name`, the
   import examples in both READMEs, and every CDN URL
2. `npm login` to link this machine to the npm account
3. Enable 2FA (an authenticator app) on the npm account — npm no longer allows
   publishing without 2FA or a 2FA-bypass token
4. Set **Settings → Pages → Source** to "GitHub Actions". Left at the default,
   the workflow succeeds and publishes nothing
5. The first release went through [section 8](#8-the-first-release-is-a-special-case-record) —
   `package.json` already carried the initial version, so the usual three
   commands did not apply

---

## 8. The first release is a special case (record)

`package.json` starts life at `0.1.0`, so `npm version 0.1.0` stops with:

```text
npm error Version not changed
```

**That is not a fault.** npm is declining to create a version commit that
changes nothing.

But because `npm version` stopped, **everything attached to it was skipped**.

| What `npm version` normally does | Did it happen? |
| --- | --- |
| `preversion` = `npm run check` | **No** |
| Syncing the `VERSION` constant | No (already matching, so harmless) |
| Creating the commit and the `v0.1.0` tag | **No** |

So for the first release, add `--allow-same-version`. It keeps the version as it
is while **running the whole normal flow to completion**.

```sh
npm version 0.1.0 --allow-same-version
npm publish --access public
git push --follow-tags
```

That gives you the `preversion` checks, the `VERSION` sync, the commit and an
**annotated tag** — exactly what the usual three commands do. No manual
`git tag` needed.

When `package.json` ends up unchanged, npm creates an empty commit. It is
harmless, and useful as a marker for where the release happened.

**No flag is needed from the second release onwards**, because the version
actually changes and `npm version patch` works as documented.

### If you tag by hand anyway

Whatever the reason, **always pass `-a`**.

```sh
git tag -a v0.1.0 -m "v0.1.0"     # annotated — correct
git tag v0.1.0                    # lightweight — wrong
```

`git push --follow-tags` **does not push lightweight tags**, silently and with
no warning, leaving you with a tag locally and nothing on GitHub. Tags created
by `npm version` are annotated, so the automated flow is unaffected.

If you already made a lightweight one, push it explicitly or recreate it:

```sh
git push origin v0.1.0
# or
git tag -d v0.1.0 && git tag -a v0.1.0 -m "v0.1.0" && git push --follow-tags
```
