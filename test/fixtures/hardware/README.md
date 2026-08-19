# Hardware fixtures

Flash dumps from devices provisioned by `tools/fixture-device/`.

These are the only fixtures in this repository that were not produced by the
code under test, which makes them the only ones that can catch a parser and a
builder agreeing on the same mistake. See
[tools/fixture-device/README.md](../../../tools/fixture-device/README.md).

One directory per chip, each with a `MANIFEST.txt` recording where it came from.

`esp32s3-worn/` is the exception: a single region rather than a chip, kept
because of one specific thing it can prove. Its wear-levelling layer had moved
the spare sector on, and a detector that judges the mapping by the root
directory alone reads that volume as complete while silently dropping a
subdirectory. Its `MANIFEST.txt` says the rest.
