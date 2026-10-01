# Midnight interface

The interface uses shadcn/ui source components (Radix primitives), Tailwind CSS 4, and Motion for React. Components were obtained from the official shadcn new-york-v4 registry and are checked into `minimal/src/components/ui/`; `components.json` configures future additions. The `cn` imports use the local clsx/tailwind-merge helper. The progress component passes its numeric value to the accessible Radix root.

## Color roles

| Role | Midnight color | Purpose |
| --- | --- | --- |
| Background | `#090f1e` | Low-glare navy canvas |
| Sidebar | `#0c1425` | Gentle separation of navigation |
| Surface / elevated surface | `#111d32` / `#172640` | Dialogs, menus and layered content |
| Text | `#e6edf7` | Soft white manuscript and labels |
| Secondary text | `#97a8c2` | Legible, quieter metadata |
| Primary | `#9bb7ff` | Periwinkle actions and focus indicators |
| Success | `#83cbbf` | Teal save state and progress |
| Warm accent | `#ddb97b` | Restrained amber ornaments, complementary to blue |

Midnight is the only theme, including the native window background and page before React starts. The interface has no theme toggle and does not read or write theme preferences. Previously stored preferences are left untouched and have no effect.

Palette contrast calculations give body text 16.22:1 against the background, secondary text at least 6.27:1 against the elevated surface, and primary button text 8.78:1. These are color-pair checks, not a claim of a complete accessibility audit.

## Components and behavior

Shadcn components handle primary/secondary buttons, icon-button tooltips, form fields, dialogs, sorting, draft badges, separators and progress. The manuscript stays a native textarea so editing and undo behavior are not coupled to animation.

Motion provides short route entrances, a shared chapter-selection highlight, book hover feedback, notes-panel transitions and notification transitions. The library sidebar cycles through four writing quotes with a typewriter reveal, punctuation pauses, an amber cursor and a gentle exit. Each completed quote stays visible for seven seconds. Pause and next controls keep the sequence optional; hidden windows suspend its timer. The text area reserves space for the longest quote so typing does not move the surrounding controls.

`MotionConfig` and `useReducedMotion` respect the system's reduced-motion preference; CSS transitions and shadcn animations also honor that preference. With reduced motion, quotes are shown in full and only change through the Next quote button. Screen readers receive a complete quote rather than per-character announcements. Animation state stays inside the quote component and cannot rerender the manuscript editor.

Quote excerpts and attribution were checked against [Virginia Woolf, A Room of One's Own](https://www.gutenberg.ca/ebooks/woolfv-aroomofonesown/woolfv-aroomofonesown-00-h.html), [George Orwell, Why I Write](https://www.orwellfoundation.com/the-orwell-foundation/orwell/essays-and-other-works/why-i-write/), [Emily Dickinson, I dwell in Possibility](https://poets.org/poem/i-dwell-possibility-30) and [Mary Shelley, Frankenstein's 1831 introduction](https://www.gutenberg.org/files/42324/42324-h/42324-h.htm). Source links are retained alongside the quote data.

Dialogs include accessible titles/descriptions, trap focus through Radix and restore focus on dismissal. Native close/quit closes portal controls before the save barrier runs. The editor remeasures when its available width changes, preventing long paragraphs from being clipped as notes or the sidebar change layout.

## Development

Run `bun install --frozen-lockfile`, then `bun run desktop` in `minimal/`. `bun run dev` remains a separate browser preview with browser-only data. Shared shadcn theme mappings are in `src/theme.css`; app layout and palette tokens are in `src/styles.css`. To add a component, run `bunx shadcn@latest add <component>` from `minimal/`, review the source change and retain its license.

Sources: [shadcn/ui Vite setup](https://ui.shadcn.com/docs/installation/vite), [Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog), [Motion for React](https://motion.dev/docs/react), [MotionConfig](https://motion.dev/docs/react-motion-config).
