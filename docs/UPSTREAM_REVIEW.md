# Upstream NEO review

Reviewed Hugh Howey’s NEO at commit [`0b992dbdca1d91294a80ca3cd696bcb8fa147ae3`](https://github.com/hughhowey/neo/tree/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3). This review informed the independent desktop implementation in `minimal/`; it does not imply that the new implementation supports every upstream feature.

The upstream application has a clear, valuable foundation: local manuscript ownership, readable on-disk files, chapter organization, an opinionated writing interface, and an MIT license. The most consequential improvements concern reliable persistence and recovery, followed by reducing the number of interactions a writer must learn.

## Findings

### P1: Chapter and notes writes replace the current file in place

[Chapter writes in `main.js:341–346`](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/main.js#L341-L346) and [auxiliary writes at lines 365–367](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/main.js#L365-L367) call `fs.writeFileSync` directly on the live file. A crash or failed write after truncation can leave partial or empty content. By comparison, [the JSON helper uses a temporary file and rename](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/main.js#L235-L238).

Use atomic replacement for manuscript data, retain recoverable prior revisions, and report a successful save only after the write succeeds. Atomic replacement reduces partial-write risk; it does not by itself provide a multi-file transaction or protection from every hardware failure.

### P1: A failed notes save clears its dirty flag

[`flushAux()` at `app.js:5327–5331`](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/app.js#L5327-L5331) calls `writeAux` without awaiting it and immediately sets `auxDirty = false`. If storage rejects the write, a subsequent flush sees a clean document and skips retrying. Leaving the notes view or closing the application can then discard edits that were never saved.

This was reproduced by evaluating the exact function extracted from the reviewed source in an isolated JavaScript context. The context supplied a book, dirty notes, and a `writeAux` mock returning a rejected promise. After calling `flushAux()` twice, the result was:

```json
{"dirtyAfterFailedWrite":false,"writeAttempts":1}
```

Keep dirty state until the relevant version is acknowledged, show save failures, and allow a retry without requiring another edit.

### P2: Daily backups only run on startup

[The startup call at `main.js:2049`](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/main.js#L2049) is the only call to `dailyBackup`. [The implementation skips an existing file for the UTC date](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/main.js#L1071-L1078). A writing session that remains open across several days therefore receives no new daily backups. [Writing the archive directly to its final name](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/main.js#L1109-L1113) can also leave an incomplete file that prevents a later retry for that date.

Create recovery points during long sessions, commit backup files atomically, and expose when recovery data was last saved. Backups held on the same disk are revision recovery, not protection against losing that disk.

### P2: Window shutdown has no acknowledged save barrier

[`flushAllSaves()`](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/app.js#L5612-L5639) starts writes without awaiting them. [The `beforeunload` handler](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/app.js#L5873-L5876) invokes that function, while [the main-process close handler](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/main.js#L1176-L1182) only remembers window bounds. [Changing the library folder exits directly](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/main.js#L163-L168).

There is no explicit handshake proving outstanding writes completed before shutdown. This is a source-level reliability risk, not a claim that every close loses text. Await the save queue and keep the window open with a clear error if persistence fails.

### P2: General modal dialogs do not contain keyboard focus

[The common dialog helper](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/app.js#L8890-L8905) adds dialog semantics and initial focus, but does not make the background inert or trap focus. [Input dialogs](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/app.js#L278-L302) and [choice dialogs](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/app.js#L307-L331) lack Tab handling. The separate shortcut dialog does have [its own focus trap](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/app.js#L7366-L7375).

Use a consistent native dialog or accessible dialog component. Verify initial focus, Tab containment, Escape, and focus restoration with keyboard-only interaction.

## Test coverage and verification

[The package scripts](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/package.json#L8-L15) provide dash and spellcheck suites. [The release workflow](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/.github/workflows/build.yml) builds packages and includes a Windows startup smoke check, but does not run those suites. No persistence, failed-write, recovery, or import round-trip tests were found in the reviewed source. Tests currently extract pieces of the monolithic renderer by substring, for example [the dash suite](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/scripts/dashes.test.js#L9-L14).

Actual checks performed against the source checkout:

- `node --test scripts/dashes.test.js`: **7 passed**.
- `node --test scripts/spellcheck.test.js`: **1 passed; 6 could not run successfully because the checkout lacked the upstream dictionary and Hunspell dependencies**. These environment failures are not evidence of spellcheck defects.
- The isolated failed-notes-save reproduction described above: **confirmed**.

The review did not run the full upstream Electron application or perform an exhaustive accessibility, security, or performance audit. Prioritize meaningful tests for rejected writes, interrupted replacement, malformed data, stale revisions, restored history, and import fidelity.

## Existing library format

[Book creation](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/main.js#L257-L285) defines a folder per book:

```text
NEO Library/
  library.json
  book-<slug>-<id>/
    book.json
    chapters/<chapterId>.html
    notes.html
    outline.html
    darlings.json
    stickies.json
```

`book.json` includes `id`, `title`, `author`, `chapterOrder`, timestamps and `wordGoal`. Optional fields include `chapterTitles`, `chapterKinds`, `chapterNotes`, `sectionNotes`, `subtitle`, `series`, `tabNames`, and cover settings. A future dedicated library importer should honor `chapterOrder`, preserve chapter titles, validate identifiers, convert HTML as untrusted data, and import into a new destination while leaving the source intact.

Plain-text conversion cannot preserve every upstream feature: rich formatting, sticky anchors, cover art, and structured outlines need separate migration decisions. The initial fork supports the import formats documented in its own interface and README; it does not claim lossless NEO-library migration.

## Simplification opportunities

The [initial setup](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/index.html#L27-L69) asks about author identity, planning style, typeface, and drop caps before writing. Sensible defaults can defer these decisions. [Hover-driven navigation](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/index.html#L76-L98) keeps the page quiet but adds discovery cost; an explicit focus mode and stable sidebar offer a simpler alternative. Normal paragraph editing plus explicit chapter actions reduces the special editing behavior associated with [double/triple Enter](https://github.com/hughhowey/neo/blob/0b992dbdca1d91294a80ca3cd696bcb8fa147ae3/README.md#L34-L38).

The first release can concentrate on writing, organization, persistence and export. Cover generation, omnibus binding, email snapshots, detailed typography and sprint dashboards can remain separate future choices. The intent is a smaller product scope, with no unmeasured claims about memory, speed, or package size.
