# Validation

Validated on macOS Apple Silicon with Bun 1.3.14 and Rust 1.98.1. Application version: 0.1.0.

## Automated checks

- TypeScript strict type checking and Vite production build passed.
- Bun: **21 tests passed, 81 assertions**. Coverage includes edits during saves, concurrent flushes, rejected writes, slow journal coalescing, crash recovery, conflict recovery, malformed storage and manuscript conversion.
- Rust: **14 tests passed**. Coverage includes atomic persistence, optimistic revisions, unsafe paths, symlinks, corrupt data, exclusive library locking, journal recovery, rolling backups, checkpoint cadence, history and trash retention.
- Desktop Clippy with warnings denied passed.
- Both native debug and optimized release macOS application bundles built.
- ZIP integrity checked. The optimized app contains an arm64 Mach-O executable; it is locally ad-hoc signed and is not Apple-notarized.

## Interactive checks

The browser preview was opened and visually inspected. Verified empty library, optional sample creation, chapter selection/editing, notes, focus mode, earlier-draft preview and recovery as a separate manuscript. Confirmed the original manuscript remained in the library.

The native macOS app was launched and verified independently of the browser preview. Confirmed local persistence and reopening, then exported Markdown using the native Save dialog and inspected the resulting text file.

A native Quit test exposed macOS's predefined Quit command bypassing the asynchronous save wait; the draft journal successfully recovered the text. The implementation was corrected to use a custom Quit menu item. In the optimized release, typing a sentence and immediately pressing Cmd+Q committed the latest text and left an empty pending-draft journal. The committed chapter was inspected on disk.

## Boundaries

Windows and Linux runtime behavior has not been manually verified. CI includes core build/tests on all three desktop platforms and a macOS desktop build, but added workflows are not evidence of a successful remote run. No full original-NEO library migration or EPUB/Word/PDF compatibility is claimed. Actual power loss, physical disk failure, and weeks-long large-manuscript sessions have not been simulated. Recovery is local to the same disk; maintain an independent backup.

Browser preview storage is separate from desktop storage and subject to browser quotas. Desktop uses Rust files and a native recovery journal.

## Midnight UI update

The shadcn/Motion update passed the production build and the same 21 Bun / 14 Rust tests. The browser preview was visually inspected in midnight mode, including the library, editor, notes panel and new-manuscript dialog. A manuscript was created through the new form; the Radix sort menu was operated with arrow keys and Enter, returning focus to its trigger. With notes open, the manuscript textarea's measured client height matched its scroll height, confirming no hidden overflow for the tested sample. Dialog/portal integration, stable editor identity and reduced-motion handling were reviewed in source.

The final optimized macOS bundle was launched in midnight mode. Opening New manuscript focused the title field; Escape dismissed the dialog and returned keyboard focus to the New manuscript button. The packaged app includes the upstream, font, shadcn and UI dependency license notices.

## Dark-only quote update

The theme toggle, light palette and theme-preference handling were removed. Browser checks confirmed the midnight background and no theme controls. The typewriter sequence advanced automatically; Pause held the exact partial text, Next showed a complete quote while paused, and the sequence wrapped from quote four to quote one. At a 900 × 598 content viewport (the minimum desktop window minus its title bar), the sidebar and its content both measured 598px with the footer fully visible. A review caught and fixed pausing during the exit transition so it cannot leave a quote invisible. Reduced-motion behavior, hidden-document suspension and unmount cleanup were reviewed in source. The 21 Bun tests still pass.

The optimized native app was rebuilt and opened with the theme control absent and the quote sequence visibly advancing. Production build, archive integrity and bundled license checks passed.
