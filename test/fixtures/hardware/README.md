# Hardware fixtures

Flash dumps from devices provisioned by `tools/fixture-device/`.

These are the only fixtures in this repository that were not produced by the
code under test, which makes them the only ones that can catch a parser and a
builder agreeing on the same mistake. See
[tools/fixture-device/README.md](../../../tools/fixture-device/README.md).

One directory per chip, each with a `MANIFEST.txt` recording where it came from.
