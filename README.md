# NEO Minimal

A quiet, local-first desktop writing app. An independent fork of [NEO by Hugh Howey](https://github.com/hughhowey/neo), rebuilt with **Rust + Tauri 2** and **Bun + React + TypeScript**, with **shadcn/ui** components and **Motion** animation.

The new application is in [`minimal/`](minimal). The original Electron source and Git history remain intact; its documentation is preserved in [README.upstream.md](README.upstream.md). This is an independent edition, not an official NEO release or a feature-complete replacement.

## Start the desktop app

Install [Bun](https://bun.sh), Rust 1.89 or newer, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). On macOS this includes Xcode Command Line Tools.

```sh
cd minimal
bun install --frozen-lockfile
bun run desktop
```

To make a macOS application bundle:

```sh
bun run tauri build --bundles app
```

The bundle is written to `minimal/src-tauri/target/release/bundle/macos/`. Local builds are not notarized releases. Other desktop targets need their own platform toolchains and testing.

`bun run dev` runs a browser preview. The preview clearly identifies itself and saves to browser storage; the actual desktop application saves through Rust to files. These are separate libraries. Browser storage has size limits and may be cleared by your browser; use Export to keep a copy.

## A smaller writing experience

- A midnight-blue library with search, sorting and simple typographic covers.
- Rotating writing quotes with a typewriter animation, pause/next controls and a static reduced-motion experience.
- A plain-text writing page with explicit chapters, chapter reordering and live word counts.
- Focus mode, a permanent midnight-blue theme, story notes and optional manuscript word goals.
- Automatic local saves, visible save status and a retry action when saving fails.
- Version history that recovers an earlier draft as a **separate manuscript**.
- Plain text and Markdown import, and Markdown export through a native Save dialog.
- Keyboard shortcuts, shadcn/Radix dialogs, sorting controls, tooltips and progress indicators.
- Subtle Motion transitions that respect reduced-motion preferences.
- A separate Review mode with anchored comments, threaded replies, highlights, strikethroughs and proposed wording, without editing manuscript text.
- Rich comment formatting, resolution/reopening, safe reattachment after text changes, and an append-only activity history.

No account, cloud service, telemetry, AI API key, or subscription is required. Fonts and icons ship with the application. The sample manuscript is optional and can be edited freely.

## What changed, and why

The [upstream review](docs/UPSTREAM_REVIEW.md) documents concrete findings at upstream commit `0b992dbdca1d91294a80ca3cd696bcb8fa147ae3`, including direct-overwrite chapter saves, prematurely acknowledged notes saves, and missing persistence tests. The [product decisions](docs/PRODUCT_DECISIONS.md) explain the smaller interface and the limits of this first version.

The new persistence layer uses atomic file replacement, synchronized writes, a recovery journal, acknowledged save revisions and an exclusive library lock. The frontend keeps edits made during an in-flight save, retains dirty state after failure, and waits for its save queue before window close or native Quit. Failure leaves the window open with a retry/export path. Unexpected termination can still lose keystrokes that have not reached the recovery journal; no application can guarantee against all filesystem or hardware failures.

## Your files and recovery

The macOS data folder is `~/Library/Application Support/com.neominimal.desktop`. Tauri uses the platform application-data folder on Windows and Linux. `NEO_MINIMAL_DATA_DIR` overrides it for development and testing.

- `books/<id>/book.json`: readable JSON containing metadata, chapter text, notes and posted review events.
- `books/<id>/previous.json`: the immediately previous committed draft.
- `books/<id>/versions/`: periodic checkpoints for earlier drafts.
- `books/<id>/archive/`: older checkpoints retained on disk.
- `draft-journal.json`: pending edits used for recovery after restart.
- `trash/`: retained manuscripts moved by the backend trash command; no delete/trash control is exposed in the first UI.

The previous draft is refreshed on saves; history checkpoints are spaced five minutes apart, with up to 30 distinct drafts shown, including the immediate previous save. Older checkpoints are archived. Archives grow over time. Back up this folder with your normal backup system. Recovery copies on the same disk are not an off-device backup. Never edit or move library files while the application is running. The app does **not** modify or migrate the original `NEO Library` folder.

To bring writing from original NEO, export Markdown or plain text there, then import that file into NEO Minimal. Import creates a new manuscript and leaves the source file alone. Full-library migration, rich manuscript formatting, anchored placeholders, EPUB/Word/PDF export, multilingual spellcheck, omnibus binding, cover generation and Pocket/mobile synchronization are outside this first version.

## Review without rewriting

Open a manuscript and choose **Review**. Select a passage, then choose Comment, Highlight, Strike or Suggest. Comments and replies support bold, italic, underline, strikethrough, highlighting, headings, lists, quotations, code and safe links. Suggested replacement wording is displayed beside the unchanged original; resolving a thread does not apply it to the manuscript.

The Activity panel retains creation, replies, previous comment text, removals, resolution, reopening and reattachment. Posted reviews use the same Rust save, journal and recovery path as writing. Unposted composers are explicitly marked as drafts; post or save the comment before leaving or quitting. Forced termination can lose unposted composer text.

Reviews are local. Reviewer names are labels rather than authenticated identities, and the audit is application history rather than a tamper-proof log. Markdown export contains only the manuscript; keep a backup of the data folder to preserve comments and their history. See [the review guide](docs/REVIEW_MODE.md).

## Check the code

```sh
cd minimal
bun run check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features desktop -- -D warnings
```

Tests exercise save races, rejected writes, journal recovery, corrupt data, stale revisions, unsafe identifiers, atomic persistence, library locking and manuscript conversion. Native compilation requires the platform prerequisites. See [validation notes](docs/VALIDATION.md) for checks performed for this implementation.

## License and attribution

MIT, with Hugh Howey’s original [copyright and license](LICENSE) retained. NEO Minimal is independently developed and is not endorsed by Hugh Howey. The bundled Lora font includes its license in `minimal/public/fonts/`. The original NEO application icon is retained from the MIT-licensed project. Shadcn/ui source and UI dependency notices are preserved in `minimal/licenses/` and bundled with the desktop app. See [the interface guide](docs/INTERFACE.md) for palette and component details.
