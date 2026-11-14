import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP,
  IPHONE_USER_AGENT,
  MOBILE,
  registerSessionViewerChecks,
} from "./sessionViewerHarness.mjs";

// Browser regressions for SessionViewer, run against the fixture in
// tests/session-virtualization.tsx at phone and desktop widths.
//
//   node --test tests/session-viewer.e2e.test.mjs
//
// Target a single behavior with --test-name-pattern, for example:
//
//   node --test tests/session-viewer.e2e.test.mjs --test-name-pattern="fling"
//
// The fixture is not a production build entry point and needs no live agent.

registerSessionViewerChecks([
  // --- Tail following -------------------------------------------------------
  // The transcript reserves tall tail space below the last row for the
  // floating controls, so the newest message can be fully visible above the
  // scrollable bottom. Returning there with a downward wheel/finger gesture
  // must resume following; stopping there after scrolling up keeps the pause.
  {
    run: "runTailReturnChecks",
    label: "a downward return to the visible tail resumes following",
  },
  // A tap's 2-3px finger drift is not a reading pause. When streamed growth
  // pushed the content end out of view inside the settle window, following
  // used to latch off until the jump button was clicked. Chromium's scroll
  // anchoring hides this; the check disables it to match iOS Safari.
  {
    run: "runStrayTouchRecoveryChecks",
    label: "tap drift while streaming keeps following",
  },
  // An iOS fling keeps scrolling longer than the 600ms intent window and
  // usually decays inside the reserved tail padding, with the end marker just
  // below the fold. The return gesture must re-arm following on position.
  {
    run: "runMomentumTailChecks",
    label: "a fling back to the newest message resumes following",
  },
  // Re-arming following is a state change, not a scroll. On a virtualized
  // transcript the return gesture mounts rows and corrects heights; those
  // range changes must not pin the hard bottom by themselves, or the viewport
  // jumps out from under the gesture. The next chunk still follows.
  {
    run: "runTailArmSilentChecks",
    label: "a downward return to the tail re-arms without jumping",
  },
  // Editing a message regenerates the conversation from that point. There is
  // no optimistic pending_ack row to re-arm following, so submitting the
  // inline editor must return the viewport to the tail itself.
  {
    run: "runEditResubmitChecks",
    label: "editing and resending follows the regenerated reply",
  },
  // Expanding a tool card pauses following on purpose. If the card later
  // merges/collapses, the shrink returns the viewport to the hard bottom and
  // hides the jump button; following must be armed again with it.
  {
    run: "runExpansionRecoveryChecks",
    label: "collapsing an expanded card re-arms following at the tail",
  },
  // Expanding a card while the reply streams is a reading pause that must
  // survive the streamed growth right below it. The card is still inside the
  // reserved tail area, where streamed growth used to re-arm following and
  // snap a slow upward drag back down chunk by chunk.
  {
    run: "runExpandedStreamScrollChecks",
    label: "expanding during a stream keeps a slow upward drag",
    verify: (result) => {
      assert.ok(
        result.expandedGap > 8,
        `expanded pause left the tail slop (${result.expandedGap}px)`,
      );
      assert.ok(
        result.finalGap < 2,
        `returning to the tail stopped following (${result.finalGap}px)`,
      );
    },
  },
  // Scrolling an expanded tool result, diagram, or code block is not a
  // transcript reading gesture.
  {
    run: "runNestedScrollerChecks",
    label: "nested scroller gestures do not pause following",
  },
  // A growing composer or the iOS keyboard resizes the transcript without
  // content changes; a following reader must stay pinned to the tail.
  {
    run: "runScrollerResizeChecks",
    label: "resizing the transcript keeps the tail pinned",
  },
  // A streamed append must not drag a reader who paused inside the 8px tail
  // slop back to the bottom; returning to the tail still resumes following.
  {
    run: "runStreamingAppendChecks",
    label: "a paused reader survives a streamed append",
    verify: (result) => assert.deepEqual(result.inputs, ["wheel", "touch"]),
  },
  // A streamed append must not re-center the quick user-message popup while
  // the reader is scrolling through it.
  {
    run: "runSummaryPopupChecks",
    label: "the user-summary popup survives a streamed append",
  },
  // Markdown highlighting, images, diagrams, code blocks and late chunks grow
  // the content after its timeline render. A short first conversation has no
  // virtualizer scroll-body event to re-anchor the tail, so growth while
  // following must pin the tail and growth while paused must surface the jump
  // button without waiting for a scroll event.
  {
    run: "runContentGrowthChecks",
    label: "late content growth keeps the tail followed",
  },
  // A turn finishing re-syncs the persisted exchanges, which can drop or
  // re-key transient rows above the viewport. A paused reader's top visible
  // row must keep its screen offset, and the anchor must yield to a scroll.
  {
    run: "runCompletionAnchorChecks",
    label: "completion keeps the paused reader's anchor",
    verify: (result) => {
      assert.ok(
        Math.abs(result.anchorShift) < 6,
        `completion moved the reading anchor by ${result.anchorShift}px`,
      );
      assert.ok(result.userScrollKept > 0, "user scroll was not preserved");
    },
  },
  // Pausing by expanding a thought block and completing the turn must keep
  // the expanded block on screen. The anchor must resolve repeated short
  // content to the nearest occurrence (not the first earlier one), and must
  // not reuse a capture from a pause the reader already returned from.
  {
    run: "runCompletionThoughtAnchorChecks",
    label: "completion after expanding a thought keeps the reading position",
    verify: (result) => {
      assert.ok(
        Math.abs(result.duplicateAnchorShift) < 24,
        `completion anchored to an older duplicate (${result.duplicateAnchorShift}px)`,
      );
      assert.ok(
        result.staleScrollShift > -300,
        `completion reused a stale reading anchor (${result.staleScrollShift}px)`,
      );
    },
  },

  // --- Tail layout ----------------------------------------------------------
  // The floating user-message-summary control must stay below the last
  // transcript row at the tail instead of covering the reply's right edge.
  {
    run: "runTailClearanceChecks",
    label: "the transcript tail clears the summary control",
    waitFor: ['[data-mindfs-user-summary="1"]', "[data-session-seq]"],
    verify: (result) =>
      assert.ok(result.clearance >= 0, `expected no overlap, got ${result.clearance}px`),
  },

  // --- Virtualizer estimates ------------------------------------------------
  // Collapsed thinking rows are ~36px; the old generic 160px estimate left
  // blank bands between rows while measurements lagged and inflated the
  // scroll range, making thought-heavy sessions feel endlessly scrollable.
  {
    run: "runTimelineEstimateChecks",
    label: "the scroll range tracks real row heights",
    verify: (result) =>
      assert.ok(
        result.scrollHeight < result.thoughtCount * 60 + 500,
        `scroll range ${result.scrollHeight}px is inflated for ${result.thoughtCount} collapsed rows`,
      ),
  },
  // A 1,500-character reply on a 390px screen measures ~2,100px. The old
  // 90-characters-per-line estimate corrected by more than a screen; iOS
  // applies those scrollTop corrections after the finger lifts, sliding the
  // content under an upward drag. Estimates must track width and font metrics.
  {
    run: "runTextEstimateChecks",
    label: "long text rows estimate close to their measured height",
    viewports: [
      { ...MOBILE, hasTouch: true, userAgent: IPHONE_USER_AGENT },
      { ...DESKTOP, hasTouch: true },
    ],
    verify: (result) => {
      assert.ok(
        result.estimateError < 8,
        `estimated scroll range is ${result.estimateError}% off (${result.estimatedHeight}px vs ${result.measuredHeight}px)`,
      );
      assert.ok(
        Math.abs(result.fingerDrag) < 250,
        `content slid ${result.fingerDrag}px under an upward drag`,
      );
      assert.ok(
        Math.abs(result.flushed) < 250,
        `deferred scroll correction jumped ${result.flushed}px after the touch`,
      );
    },
  },

  // --- Tool cards and timeline identity ------------------------------------
  // An expanded card must keep its loaded remote details while the same call
  // receives streamed updates; blanking them on every meta/content identity
  // change made the transcript bounce near the tail.
  {
    run: "runExpandedToolUpdateChecks",
    label: "an expanded tool card survives streamed updates",
    verify: (result) => {
      assert.ok(result.expandedHeight > 200, `expected an expanded card, got ${result.expandedHeight}px`);
      assert.ok(result.reversals < 2, `transcript oscillated (${result.reversals} reversals)`);
    },
  },
  // On completion the transient role:"tool"/role:"thought" exchanges move into
  // the agent exchange's aux list. Timeline ids are exchange-scoped, so the
  // remount used to lose the expansion cache and close the card.
  {
    run: "runCompletionExpansionChecks",
    label: "an expanded tool card survives the turn completion re-sync",
    verify: (result) => {
      assert.ok(result.expandedHeight > 150, `expected an expanded card, got ${result.expandedHeight}px`);
      assert.ok(result.completedHeight > 150, `completed card collapsed to ${result.completedHeight}px`);
    },
  },
  // A call interrupted while running and completed in the next turn is
  // recorded twice with the same server callId. Both occurrences need their
  // own timeline identity or React keys and the virtualizer cache collide.
  {
    run: "runDuplicateCallIdChecks",
    label: "a tool call recorded in two exchanges renders two independent cards",
    verify: (result) =>
      assert.equal(result.cards, 2, "expected both recorded occurrences to render"),
  },

  // --- Markdown layout ------------------------------------------------------
  // Inline code identifiers and URLs have no spaces to wrap at, so they used
  // to extend past the message column and get clipped at the phone's right
  // edge. The transcript must not scroll horizontally, but fenced code blocks
  // must keep their own scroller.
  {
    run: "runMarkdownOverflowChecks",
    label: "long markdown tokens stay inside the transcript width",
    viewports: [
      { ...MOBILE, hasTouch: true, userAgent: IPHONE_USER_AGENT },
      { ...DESKTOP, hasTouch: true },
    ],
    verify: (result) =>
      assert.ok(result.codeBlockScrolls, "long code block lines should scroll inside their own block"),
  },
]);
