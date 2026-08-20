# Documentation

**English** · [日本語](./README.ja.md)

| Document | Contents | Audience |
| --- | --- | --- |
| [guide.md](./guide.md) | **Start here.** Every task, from opening a file to editing NVS on a board | Everyone |
| [api.md](./api.md) | Every export, grouped by purpose | Everyone |
| [troubleshooting.md](./troubleshooting.md) | Symptoms and what they usually mean | Everyone |
| [spec.md](./spec.md) | Specification: design decisions, protocol, format layouts, safety | Implementers |
| [development.md](./development.md) | Setup, how to write and run tests, manual hardware checklist | Contributors |
| [analyzers.md](./analyzers.md) | Writing a binary analyzer plugin |
| [transports.md](./transports.md) | Writing a transport (Node.js, WebUSB, …) |
| [ci.md](./ci.md) | The three GitHub Actions workflows, required setup, reading failures | Contributors, maintainers |
| [release.md](./release.md) | Versioning, the release procedure, recovering from mistakes | Maintainers |
| [publishing.md](./publishing.md) | How npm, CDN and Pages are wired up, and why | Maintainers |

Every document has a Japanese counterpart with the `.ja.md` suffix, linked from
the top of each page.

Where it is published:

| | |
| --- | --- |
| Web app | <https://tanakamasayuki.github.io/esp-flashjs/> |
| npm | <https://www.npmjs.com/package/esp-flashjs> |

## Where to start

**Using the library** — [guide.md](./guide.md), which starts from a file on
disk and works up to editing a live device. [api.md](./api.md) is the reference
to keep open beside it.

**Something does not work** — [troubleshooting.md](./troubleshooting.md) is
organised by symptom, and most entries exist because the obvious explanation
turned out to be the wrong one.

**Making changes** — [development.md](./development.md), then the relevant
chapter of [spec.md](./spec.md).

**Wondering why something is the way it is** —
[spec.md §3, "Key design decisions"](./spec.md#3-key-design-decisions) lists each
decision alongside its reason.

**Cutting a release** — [release.md](./release.md).

## Two constraints worth knowing up front

More of this codebase follows from these two than from anything else.

1. **The ROM bootloader cannot read flash.** It implements no `READ_FLASH`,
   `ERASE_FLASH` or `ERASE_REGION`, so every read path depends on the flasher
   stub being uploaded first ([spec §6.4](./spec.md#64-the-flasher-stub)).
2. **The library holds no user-facing prose.** It returns stable `code` values
   and parameters; translation belongs to `web/locales/`
   ([spec §17.8](./spec.md#178-internationalization)). That separation is what
   lets a third-party app embed the library and keep its own wording.
