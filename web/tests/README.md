# Background reply completion regression

Run `node --test tests/background-session-stream.test.mjs` to exercise the SessionService queue and stream-state machine without a browser: stale queued stream events are dropped after completion, error, or history truncation, still-running background replies replay their queue, and subsequent turns stream normally. Vite's SSR module loader compiles the real TypeScript service, so no Chromium is required.

# Sidebar menu regression

Run `node --test tests/sidebar-menu.e2e.test.mjs` to exercise the actual FileTree at desktop and mobile sizes: the eight main entries, exclusive category expansion, existing toggles and nested preferences, menu scrolling on short screens, and the configuration panel remaining inside the sidebar. All backend requests are mocked.

# Configuration transfer regression

Configuration migration checks: `node --test tests/config-transfer.test.mjs tests/config-transfer.e2e.test.mjs` verifies archive validation, category defaults, node persistence, failed-import rollback, exclusion of project registrations and preferences, restart reminders, and the import/export dialog at desktop and mobile sizes. The browser fixture uses isolated mocked endpoints; it never imports into a running user's MindFS instance. Android/Harmony file saving and native node synchronization still need physical-device verification.

# Mobile drawer gesture regression

Run `node --test tests/drawer-gesture.e2e.test.mjs` to drive the real AppShell drawer engine with CDP touch input at a phone viewport. The `drawer-gesture.html` fixture mounts AppShell with scrollable columns, a horizontally scrollable code block, and chips. Covered: tapped-open drawers close from the dimmed area and from a body swipe, edge swipes open from the natural screen edge on both sides, vertical scrolls starting at the edge stay native, an interrupted gesture (`pagehide` without `touchend`) does not wedge later swipes or overlay taps, and horizontal scrollers keep panning only while they can still move in the finger direction. Pure zone/direction helpers are unit-tested in `session-extras.test.mjs`; real-device iOS QA is still required.

# Session virtualization browser regression

Start `npm run dev` in `web`, then open `/tests/session-virtualization.html` for
the manual checks below.

Run `node --test tests/session-viewer.e2e.test.mjs` for the automated browser
regressions. One Vite server and browser run all 15 SessionViewer checks at a
390px phone viewport and a 1280px desktop viewport; target one with
`--test-name-pattern="fling"` (or another test name). Covered areas:

- Tail following and recovery: returning to the visible tail, tap drift plus
  streamed growth, iOS fling momentum, nested scrollers, composer/keyboard
  resizes, paused readers across streamed appends, the user-summary popup,
  editing a message and resending, and collapsed/merged expanded cards.
- Content growth after render, and the completion re-sync's reading anchor.
- Tail clearance for the floating user-message-summary control.
- Virtualizer row/text estimates at phone width (iPhone UA, touch enabled).
- Expanded tool cards across streamed updates and turn completion, and duplicate
  callIds recorded in two exchanges.

The regression rationale for each check lives next to its entry in
`tests/session-viewer.e2e.test.mjs`. The fixture registers each check function
on window in `tests/session-virtualization.tsx`; `tests/sessionViewerHarness.mjs`
owns the shared server/browser lifecycle. Physical-device QA is still required
for real touch and keyboard behavior.

Four fixture checks stay manual because they are slower or replay long drags.
On a fresh page in the browser console:

- `await window.runVirtualizationChecks()` — 3,000 tool calls: bounded mounting,
  initial tail positioning, search jumps, lazy detail loading,
  expansion/detail retention across unmounts, reading position during append,
  reopening, tail following, short sessions, large diff expansion, pending
  question retention, and default user-shell expansion.
- `await window.runVirtualizationSwitchChecks()` — a paused reader keeps their
  offset when tools push the timeline across the 100-item virtualization
  threshold.
- `await window.runStreamingTextChecks()` — 16 content/timestamp updates in
  short and virtualized histories; the row, Markdown wrapper, unchanged
  paragraph, and code block keep their DOM identity.
- `await window.runScrollIntentChecks()` — slow upward wheel/touch scrolling,
  reading-position retention across append/viewport changes, return-to-bottom
  following, and lateral swipe/jitter/stray-wheel behavior at the tail.

Run them at desktop and mobile sizes; synthetic touch events do not replace
real-device QA. The fixture is not a production build entry point and needs no
live agent.

# Lexical IME regression

`node --test tests/lexical-ime.e2e.test.mjs` boots the real `TokenEditor` from
`tests/lexical-ime/` in a system Chromium via `playwright-core` and replays the
iFlytek-style empty-`compositionend` commit sequence over CDP. It guards the
Lexical 0.46.0 upgrade (upstream facebook/lexical#8701): committed English text

# Viewport rotation regression

`node --test tests/viewport-metrics.test.mjs tests/viewport-rotation.e2e.test.mjs`
checks that the visual-viewport offset is only consumed by the mobile fixed
layout, and that an orientation change drops an offset measured in the previous
layout before re-measuring. The Playwright case replays the offset lifecycle
with a controllable visual viewport; physical-device Safari rotation still
needs device QA.

# Drawer inline edit viewport regression

Run `node --test tests/drawer-edit-viewport.e2e.test.mjs`. It mounts the real
AppShell, BottomSheet, and SessionViewer and edits the last user message. It
checks native IME overlay height changes with an unchanged layout viewport,
keyboard dismissal, layout viewport resizing, draft/focus retention, and desktop
drawer height. It replays viewport geometry; physical-device IME behavior still
requires device verification.

# Markdown autolink regression

Run `node --test tests/markdown-autolink.test.mjs` to verify that GFM
autolinks stop at a raw quote instead of swallowing the rest of an inline JSON
document. A URL inside `{"url":"https://…","prompt":"…"}` used to become one
link spanning `","prompt":"…` until the next whitespace, so the tool card showed
an `<a>` whose text and href included the following JSON fields.
