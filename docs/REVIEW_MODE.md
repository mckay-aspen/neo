# Review mode

Review is a separate view of the original chapter. The manuscript is not editable in this view; annotations are stored alongside it. Return to Write to edit the draft intentionally.

## Workflow

1. Open a manuscript and choose **Review** in the toolbar.
2. Select text, then choose **Comment**, **Highlight**, **Strike** or **Suggest**.
3. Format the comment and post it. A suggestion can contain replacement wording; an empty replacement proposes removing the selection. Neither action changes the manuscript.
4. Open a thread to reply, edit a comment, remove a comment, resolve or reopen it. Removed comments remain available in the activity history.
5. Use the status and chapter filters to revisit discussions. **Activity** shows the action history for one thread or the whole manuscript. Expand an event to inspect its original text.

Rich comments support bold, italic, underline, strikethrough, highlighting, three heading levels, bullet and numbered lists, block quotations, inline code, code blocks, links, and undo/redo. A rich comment uses structured TipTap JSON rather than stored HTML. Saved comments render through React's text escaping and an allowlist. Links support HTTP, HTTPS and mailto; executable, file and data URLs are rejected.

## Text anchors

Each thread stores its original quoted passage, UTF-16 offsets and surrounding context. The overlay locates unchanged passages after surrounding text moves. When a passage has changed or a repeated match is ambiguous, it shows the preserved quote in the thread rather than highlighting an uncertain location. Select a new passage and choose **Attach to selected passage** to reconnect the thread; the reattachment becomes another audit event.

Overlapping annotations coexist. Clicking a shared marked range cycles through its threads, and each thread can also be opened from the conversation panel. Resolved threads remain in the audit and can be reopened. Selecting a resolved thread reveals its anchor for inspection.

## Saving and audit

Posted review actions enter `book.review.events`, an append-only stream with event IDs, timestamps and reviewer labels. The displayed threads are derived from that stream. Edits add a new event with the replacement comment body; removals add a marker; earlier bodies are retained. Both frontend and Rust reject rewriting, shortening or dropping an existing stored event history.

Review-only changes participate in acknowledged saves, recovery journals, revision conflicts and version snapshots. Recovering an earlier manuscript creates a separate book with that snapshot's reviews and chapter IDs, leaving the current book untouched. This is application-level history, not a signed, tamper-resistant or legally certified audit log. Someone with access to the local files can change them outside the app.

Unposted composer text stays in memory and is labeled as an unposted draft. Normal navigation away and native window close/Quit are blocked until it is posted/saved or cancelled. Crash or force-quit recovery covers posted actions that have reached the journal, not unposted composer text. A visible save failure still needs Retry; adding a comment is not itself proof of a successful disk save.

## Boundaries

- Reviews are local to the manuscript library. There are no accounts, authenticated reviewers, remote sharing, simultaneous editing or notifications.
- Resolving a suggestion changes discussion status only. There is no action that silently applies proposed text to the manuscript.
- Markdown export contains manuscript prose only. Back up the app data folder to preserve review threads and history; do not use manuscript-only export as the sole review backup.
- Comments support up to 100,000 UTF-8 bytes of text, 5,000 nodes and 20 levels of structure. Selections and replacements support up to 20,000 UTF-16 units. One manuscript supports 10,000 audit events and 8 MiB of serialized review data, within the overall manuscript limit.

The composer uses [TipTap for React](https://tiptap.dev/docs/editor/getting-started/install/react) with [StarterKit](https://tiptap.dev/docs/editor/extensions/functionality/starterkit) and [Highlight](https://tiptap.dev/docs/editor/extensions/marks/highlight). Its dependency notices are bundled in `minimal/licenses/editor-dependencies.txt`.
