# NEO Minimal product decisions

NEO Minimal is an independent desktop application in `minimal/`, developed from Hugh Howey’s MIT-licensed NEO repository. It retains upstream attribution and the original implementation for reference. It is a focused alternative, not a feature-complete port or an official upstream release.

## Purpose

Help a novelist open a project, write, organize chapters, keep notes, and recover previous work with very little interface to manage. The writer owns the local files. No account is needed for the core writing flow.

## Technology

- Tauri 2 provides the desktop shell.
- Rust owns filesystem operations, validation, persistence, revisions and history.
- React and TypeScript provide the interface.
- Bun manages frontend dependencies and runs the development and build scripts.

Browser preview and packaged desktop behavior must be identified accurately. A preview cannot be treated as proof that native filesystem, close handling or platform packaging works. Package size, startup time, memory usage and performance improvements require measurement before being claimed.

## Initial scope

The intended first-version scope is:

- A quiet library for creating and reopening local projects.
- A stable chapter list with explicit add, rename, reorder and delete actions.
- A plain-text editor with ordinary paragraph and undo behavior.
- An explicit focus mode that hides optional navigation and can be exited predictably.
- Project notes and a simple writing goal with word counts.
- Debounced autosave with visible saving, saved and failed states.
- Atomic persistence, revision checks and recoverable history, with clear restoration actions.
- Local text and Markdown import; Markdown export.
- An optional local review overlay with anchored annotations, rich comment threads and an append-only audit history.

This document records the product boundary, not a substitute for tested implementation status. The application README and verification results describe which behaviors are implemented and verified.

## Persistence principles

A save is complete only when the backend acknowledges it. Unsaved edits remain dirty after a failure. Saving an older revision must not silently overwrite a newer one. Writes should replace data atomically. The initial history interface recovers an earlier draft as a separate manuscript, preserving the current manuscript and its history.

Changing projects and closing the desktop window must respect pending edits. A failure should give the writer a clear way to retry or preserve the text. Recovery history stored on the same disk helps recover edits but is not an independent backup against device failure.

## Interface principles

Start with useful defaults and let the writer begin immediately. Keep primary actions labeled, keyboard reachable and visible. Use an explicit focus toggle instead of making hover the only route to controls. Use standard dialog behavior and preserve focus when an action finishes.

Plain text is an intentional constraint. Keep chapter creation and deletion explicit; repeated Enter should produce normal text editing behavior. Keep notes separate from the manuscript and make export predictable. A small, accurate save indicator is more useful than decorative activity.

## Import and export

Import copies content into a new local project and leaves the selected source unchanged. Plain text and Markdown are the initial interoperability formats. Markdown syntax in a plain-text editor is text; it is not a promise of a rich-text rendering or complete Markdown round-trip implementation.

A dedicated upstream-library importer is a separate extension. Upstream stores HTML chapters and additional metadata; a lossless migration cannot be claimed without preserving and testing those fields. See `UPSTREAM_REVIEW.md` for the reviewed format.

## Deferred scope

The current release does not aim to include EPUB or DOCX production, rich manuscript formatting, page-layout controls, cover generation, omnibus binding, mobile apps, cloud synchronization, remote collaboration, AI features, or an account system. Local review threads support formatted comments, but the underlying manuscript stays plain text. These boundaries can be revisited through concrete writer needs rather than parity with upstream.

## Verification priorities

Prioritize Rust tests around atomic persistence, revision conflicts, malformed data, recoverable history and safe identifiers. Verify frontend edit-to-save behavior, rejected saves, project changes and keyboard actions. Exercise import/export with realistic multi-chapter and Unicode text. Test native window close and packaged desktop behavior separately from the browser preview.

Retain the upstream MIT license and attribution. Distinguish the independent fork from Hugh Howey’s original NEO in the product name and documentation.
