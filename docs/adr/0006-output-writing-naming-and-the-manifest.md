# 6. Output writing, naming and the manifest

**Status:** accepted
**Date:** 2026-08-26

## Context

`core/output.ts` is the only thing in the codebase that turns bytes into a file
(ADR 0003). Its inputs — a prompt, a filename template and a directory — all come
from outside: the prompt from a calling model, the template and the directory from
config or from a tool argument. Several choices in how it treats them were not
obvious.

## Decision

**`writeImage(request, result, config)` takes an `OutputConfig`, not the whole
config.** It needs `dir`, `filename` and `manifest`, which is exactly the `output`
section of PLAN.md §7. Passing that section keeps the writer testable without a
config file and keeps it usable unchanged when the phase 3 sink is Blob Storage.

**The filename template names a file, never a path.** `{slug}`, `{hash}` and
`{ext}` are the only placeholders; an unknown one is an `invalid_request`
`ImagineError` that lists the known ones. The rendered name is rejected if it
holds a path separator (either POSIX or Windows), a control character, one of the
characters Windows forbids, or is `.`/`..`. This is where traversal is stopped:
`{slug}` derives from an attacker-influenced prompt, so the slug alphabet is
`[a-z0-9-]` and nothing else, and a prompt of `../../etc/passwd` yields the flat
name `etc-passwd-<hash>.png`.

The output *directory* is not jailed. PLAN.md §5 says `output_dir` is "respected
exactly when given", and the config default is the relative `./imagine-output`, so
both are simply resolved against the working directory. A directory is only
rejected when it is empty or holds a null byte; anything else that goes wrong
(a path that names a file, a permission failure) surfaces as an `invalid_request`
`ImagineError` naming the directory and carrying the OS error as its `cause`.

**Collisions are resolved by an atomic open, not by a stat-then-write.** Each
candidate is opened `wx`; `EEXIST` moves on to `<stem>-2<suffix>`, `-3`, and so on.
A check-then-write would leave a window in which two concurrent generations pick
the same name, and the issue's requirement is never to overwrite. Note that the
default template collides precisely when the same prompt produces byte-identical
output, so suffixes are rare in practice.

**The hash is 8 hex characters of the SHA-256 of the bytes.** PLAN.md's example
shows four; eight costs three characters of filename and makes an accidental
collision between different images effectively impossible, which matters because
the manifest is the gallery's index.

**An unrecognised mime type yields the extension `bin`, and never an error.** The
bytes have already been paid for by the time the writer runs; refusing to write a
generated image because its provider reported an odd content type would be a worse
outcome than an oddly named file. `image/jpeg` maps to `jpg`, a `+suffix` subtype
uses its base (`image/svg+xml` → `svg`), and anything not `image/*` is `bin`.

**A configured manifest path wins over `output_dir`.** With no `manifest` in
config the manifest lives beside the images as `<dir>/manifest.jsonl`, but once it
is configured a one-off `output_dir` writes its images elsewhere and still records
them in the one manifest. The phase 2 gallery reads a single file; a per-directory
manifest would fragment the library exactly when someone points a single
generation at a deck folder.

**A failed manifest append throws, and names the file that was written.** The
image is on disk and is not deleted — deleting a paid-for image to keep a log
consistent is the wrong trade. The `ImagineError` message carries the image path so
nothing is lost silently.

## Consequences

The manifest is append-only JSONL with one record per image: path, prompt,
provider, model, `cost_usd`, width, height, `mime_type`, `duration_ms` and an ISO
`created_at`. It is written with `appendFile`, which is atomic enough for the
single-process case but is not a guarantee across processes; if concurrent servers
ever share a manifest, that becomes a real lock or the SQLite migration PLAN.md §9
already anticipates.
