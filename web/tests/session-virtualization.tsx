import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionViewer } from '../src/components/SessionViewer';
import { I18nProvider } from '../src/i18n';
import { sessionService } from '../src/services/session';
let requests = 0;
let detailDelay = 0;
sessionService.getToolCall = async (_root, _session, callId) => {
  requests++;
  if (detailDelay > 0) await new Promise((resolve) => setTimeout(resolve, detailDelay));
  return {callId, kind: 'read', title: callId, status: 'complete', content: [{type:'text',text:'REMOTE DETAIL '+callId+'\n'+('detail line\n'.repeat(80))}]};
};
// Inline message editing regenerates through this endpoint; no backend here.
sessionService.editMessage = async () => {};
const exchanges = Array.from({length: 30}, (_, i) => [
  {seq:i*2+1,role:'user',content:'User question '+i,timestamp:'2026-09-28T00:00:00Z'},
  {seq:i*2+2,role:'agent',content:'Agent answer '+i,timestamp:'2026-09-28T00:00:01Z'},
]).flat();
const exchange_aux = Object.fromEntries(Array.from({length:30},(_,i)=>[i*2+2,Array.from({length:100},(_,j)=>({seq:i*2+2,line:0,toolcall:{callId:`call-${i}-${j}`,kind:'read',status:'complete',title:`Tool ${i}-${j}`,meta:{}}}))]));
function Check() {
  const [session,setSession]=useState<any>({key:'virtual-test',exchanges,exchange_aux});
  const [target,setTarget]=useState(0);
  const [shown,setShown]=useState(true);
  Object.assign(window,{check:{requests:()=>requests,jump:(seq:number)=>setTarget(seq),toggle:()=>setShown(x=>!x),append:()=>setSession((s:any)=>({...s,exchanges:[...s.exchanges,{seq:s.exchanges.length+1,role:'agent',content:'APPENDED '+s.exchanges.length,timestamp:'2026-09-28T00:00:02Z'}]}))}});
  Object.assign((window as any).check, {
    replaceSession: (next: any) => { setTarget(0); setSession(next); },
    setDetailDelay: (ms: number) => { detailDelay = ms; },
    question: () => setSession((s: any) => ({...s, pending: true, exchanges: [...s.exchanges, {
      role: 'tool', content: '', toolCall: {
        callId: 'question', kind: 'ask_user', status: 'running',
        meta: {questions: [{question: 'Draft retention check'}]},
      },
    }]})),
    short: () => setSession({key:'short-test',exchanges:exchanges.slice(0,2),exchange_aux:{2:[
      {seq:2,line:0,toolcall:{callId:'edit',kind:'edit',status:'complete',title:'Large edit',content:[{type:'diff',path:'example.ts',oldText:'old line\n'.repeat(400),newText:'NEW DIFF LINE\n'.repeat(400)}]}},
      {seq:2,line:0,toolcall:{callId:'shell',kind:'execute',status:'complete',title:'Shell',meta:{source:'userShell',command:'echo ready'},content:[{type:'text',text:'SHELL READY'}]}},
    ]}}),
  });
  return <I18nProvider><div style={{height:'100vh',display:'flex',flexDirection:'column'}}>{shown && <SessionViewer session={session} rootId="test" targetSeq={target}/>}</div></I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<Check/>);

Object.assign(window, { runStreamingTextChecks: async () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 80));
  for (const long of [false, true]) {
    const prefix = long ? exchanges : exchanges.slice(0, 1);
    let content = 'Stable paragraph\n\n```js\nconst answer = 42;\n```\n\nStreaming';
    const update = (step: number) => (window as any).check.replaceSession({
      key: `streaming-${long}`, exchange_aux: long ? exchange_aux : {},
      exchanges: [...prefix, {seq: 999, role: 'agent', content, timestamp: `2026-09-29T00:00:${String(step).padStart(2, '0')}Z`}],
    });
    update(0);
    await settle();
    const row = document.querySelector('[data-session-seq="999"]')!;
    const markdown = row?.querySelector('.markdown-viewer');
    const paragraph = markdown?.querySelector('p');
    const code = markdown?.querySelector('pre');
    if (!row || !markdown || !paragraph || !code) throw new Error('Missing streaming fixture nodes');
    for (let step = 1; step <= 16; step++) {
      content += ` chunk ${step}`;
      update(step);
      await settle();
      if (document.querySelector('[data-session-seq="999"]') !== row) throw new Error(`Streaming row remounted (virtual=${long})`);
      if (row.querySelector('.markdown-viewer') !== markdown || markdown.querySelector('p') !== paragraph || markdown.querySelector('pre') !== code) {
        throw new Error(`Unchanged Markdown nodes remounted (virtual=${long})`);
      }
      if (!markdown.textContent?.includes(`chunk ${step}`)) throw new Error('Streaming content did not update');
    }
  }
  return {passed: true, modes: ['short', 'virtual'], updatesPerMode: 16};
}});

Object.assign(window, { runScrollIntentChecks: async () => {
  const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const el = [...document.querySelectorAll('div')].find(node => getComputedStyle(node).overflowY === 'auto')!;
  const gap = () => el.scrollHeight - el.clientHeight - el.scrollTop;
  await settle();
  for (const input of ['wheel', 'touch']) {
    el.scrollTop = el.scrollHeight;
    await settle();
    if (input === 'touch') {
      el.dispatchEvent(new TouchEvent('touchstart', {bubbles: true, touches: [new Touch({identifier: 1, target: el, clientY: 200})]}));
    }
    for (let step = 1; step <= 12; step++) {
      if (input === 'wheel') {
        el.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: -5}));
      } else {
        el.dispatchEvent(new TouchEvent('touchmove', {bubbles: true, touches: [new Touch({identifier: 1, target: el, clientY: 200 + step * 5})]}));
      }
      el.scrollTop -= 5;
      await settle(40);
      assert(gap() >= 4, `${input}: small upward scroll snapped back to bottom`);
    }
    if (input === 'touch') el.dispatchEvent(new TouchEvent('touchend', {bubbles: true, touches: []}));
    assert(gap() >= 45, `${input}: slow upward scrolling made no progress`);
    const top = el.scrollTop;
    (window as any).check.append();
    window.dispatchEvent(new Event('mindfs:safe-area-updated'));
    await settle();
    assert(Math.abs(el.scrollTop - top) < 2, `${input}: append/viewport change stole reading position`);
    el.scrollTop = el.scrollHeight;
    await settle();
    (window as any).check.append();
    await settle();
    assert(gap() < 2, `${input}: returning to bottom did not resume following`);

    // Gestures that never move the view off the tail (lateral swipe, finger
    // jitter, stray wheel tick) must not surface the jump button or leave
    // following paused.
    const jumpButton = () =>
      document.querySelector('[data-mindfs-jump-latest="1"]') ||
      [...document.querySelectorAll('button')].find((node) =>
        /回到底部最新消息|Jump to latest message/.test(node.getAttribute('aria-label') || ''),
      );
    assert(!jumpButton(), `${input}: jump button visible at the tail`);
    if (input === 'touch') {
      const fireTouch = (type: string, clientX: number, clientY: number) =>
        el.dispatchEvent(new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === 'touchend'
            ? []
            : [new Touch({identifier: 1, target: el, clientX, clientY})],
        }));
      fireTouch('touchstart', 100, 300);
      fireTouch('touchmove', 160, 300);
      fireTouch('touchmove', 220, 301); // lateral swipe with 1px downward drift
      fireTouch('touchend', 220, 301);
      await settle();
      assert(!jumpButton(), `${input}: lateral swipe at the tail surfaced the jump button`);
      fireTouch('touchstart', 100, 300);
      fireTouch('touchmove', 100, 303); // 3px finger jitter
      fireTouch('touchend', 100, 303);
    } else {
      el.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: -5}));
    }
    await settle();
    assert(!jumpButton(), `${input}: tail gesture surfaced the jump button`);
    (window as any).check.append();
    await settle();
    assert(gap() < 2, `${input}: tail gesture stopped following`);

    // The end of an overscroll bounce reads as upward movement while the
    // viewport is back at the tail. Following must stay on and the jump
    // button must hide immediately, without waiting for the settle timer.
    el.scrollTop -= 3;
    await settle(80);
    assert(!jumpButton(), `${input}: tail bounce surfaced the jump button`);
    (window as any).check.append();
    await settle(80);
    assert(gap() < 2, `${input}: tail bounce should resume following immediately`);
  }
  return {passed: true, inputs: ['wheel', 'touch'], upwardSteps: 12};
}});

// A streamed append must not re-arm tail-following while the reader has
// explicitly paused inside the tail slop. iOS touch scrolls move only a few
// pixels per event; before the pause guard, the next scroll event re-armed
// following (rawDistance <= 8px) and the following chunk dragged the viewport
// back to the tail. Returning to the bottom must still resume following.
Object.assign(window, { runStreamingAppendChecks: async () => {
  const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const el = [...document.querySelectorAll('div')].find(node => getComputedStyle(node).overflowY === 'auto')!;
  const gap = () => el.scrollHeight - el.clientHeight - el.scrollTop;
  const pressBack = (input: string) => {
    if (input === 'wheel') {
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -5 }));
    } else {
      const fire = (type: string, clientY: number) => el.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientY })],
      }));
      fire('touchstart', 300);
      fire('touchmove', 305); // finger moves down = scroll toward older messages
      fire('touchend', 305);
    }
    el.scrollTop = Math.max(0, el.scrollTop - 4); // still inside the 8px slop
  };
  (window as any).check.replaceSession({
    key: 'streaming-append', exchanges, exchange_aux: {},
  });
  await settle(300);
  assert(gap() < 2, 'fixture should start at the tail');
  for (const input of ['wheel', 'touch']) {
    el.scrollTop = el.scrollHeight;
    await settle();
    pressBack(input);
    await settle(40);
    const pausedTop = el.scrollTop;
    assert(gap() > 2, `${input}: pause should move the viewport off the tail`);
    (window as any).check.append();
    await settle(80);
    assert(Math.abs(el.scrollTop - pausedTop) < 2, `${input}: streaming append dragged the reader back to the tail`);
    assert(gap() > 2, `${input}: viewport snapped to the bottom`);
    el.scrollTop = el.scrollHeight;
    await settle();
    (window as any).check.append();
    await settle();
    assert(gap() < 2, `${input}: returning to the tail should resume following`);
  }
  return { passed: true, inputs: ['wheel', 'touch'] };
}});

// An expanded card that still needs remote details must not collapse (or
// re-fetch its way through a loading row) when the tool call receives a
// streamed update. It used to blank loadedToolCall on every meta/content
// identity change, so the card shrank to its loading row and grew back on
// each update: near the tail the transcript bounced up and down repeatedly.
Object.assign(window, { runExpandedToolUpdateChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const scroller = () => [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto')!;
  const baseExchanges: any[] = [];
  for (let i = 0; i < 60; i += 1) {
    baseExchanges.push({ seq: i * 2 + 1, role: 'user', content: `Question ${i}\n` + 'body\n'.repeat(8), timestamp: '2026-09-28T00:00:00Z' });
    baseExchanges.push({ seq: i * 2 + 2, role: 'agent', content: `Answer ${i}\n` + 'detail\n'.repeat(8), timestamp: '2026-09-28T00:00:01Z' });
  }
  const lastSeq = baseExchanges[baseExchanges.length - 1].seq;
  const build = (step: number) => {
    const exchanges = [...baseExchanges];
    const last = exchanges[exchanges.length - 1];
    exchanges[exchanges.length - 1] = { ...last, content: `${last.content}\nstream step ${step}` };
    return {
      key: 'expanded-update',
      exchanges,
      exchange_aux: {
        [String(lastSeq)]: [{
          seq: lastSeq,
          line: 0,
          toolcall: {
            callId: 'expanded-update-tool',
            kind: 'read',
            status: 'running',
            title: 'Updating tool',
            meta: { progress: `step ${step}` },
          },
        }],
      },
    };
  };
  const api = (window as any).check;
  const el = scroller();
  api.setDetailDelay(150);
  try {
    api.replaceSession(build(-1));
    await settle(500);
    el.scrollTop = el.scrollHeight;
    await settle(400);
    el.scrollTop = el.scrollHeight;
    await settle(250);
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').includes('Updating tool'));
    assert(!!button, 'missing updating tool card');
    button!.click();
    await settle(700);
    assert(document.body.innerText.includes('REMOTE DETAIL expanded-update-tool'), 'expanding should load remote details');
    const card = button!.parentElement!;
    const expandedHeight = Math.round(card.getBoundingClientRect().height);
    assert(expandedHeight > 200, `expanded card should show details (height ${expandedHeight})`);
    const samples: { top: number; height: number; details: boolean }[] = [];
    const sample = () => samples.push({
      top: Math.round(el.scrollTop),
      height: Math.round(card.getBoundingClientRect().height),
      details: document.body.innerText.includes('REMOTE DETAIL expanded-update-tool'),
    });
    sample();
    for (let step = 0; step < 6; step += 1) {
      api.replaceSession(build(step));
      for (let i = 0; i < 4; i += 1) {
        await settle(60);
        sample();
      }
    }
    const collapsed = samples.filter((item) => item.height < expandedHeight - 40);
    assert(collapsed.length === 0, `expanded card collapsed during ${collapsed.length}/${samples.length} stream updates`);
    assert(samples.every((item) => item.details), 'remote details disappeared during a stream update');
    let reversals = 0;
    let lastDirection = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const direction = Math.sign(samples[i].top - samples[i - 1].top);
      if (direction !== 0 && lastDirection !== 0 && direction !== lastDirection) reversals += 1;
      if (direction !== 0) lastDirection = direction;
    }
    assert(reversals < 2, `transcript oscillated during expanded-card updates (${reversals} reversals)`);
    return { passed: true, expandedHeight, samples: samples.length, reversals };
  } finally {
    api.setDetailDelay(0);
  }
}});

// Row estimates must be close to the real heights. Collapsed thinking rows
// are ~36px but were estimated at 160px, so a thought-heavy session mounted
// rows 120px apart while measurements lagged: the reader saw large blank
// bands between rows and the virtual scroll range was nearly twice the real
// content, which made the transcript feel endlessly scrollable.
Object.assign(window, { runTimelineEstimateChecks: async () => {
  const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const thoughtCount = 300;
  (window as any).check.replaceSession({
    key: 'estimate-test',
    exchanges: [
      { seq: 1, role: 'user', content: 'Estimate test', timestamp: '2026-09-28T00:00:00Z' },
      { seq: 2, role: 'agent', content: '', timestamp: '2026-09-28T00:00:01Z' },
    ],
    exchange_aux: {
      2: Array.from({ length: thoughtCount }, (_, index) => ({
        seq: 2,
        line: 0,
        thought: `Reasoning step ${index} ` + 'detail '.repeat(20),
        thought_id: `thought-${index}`,
      })),
    },
  });
  await settle(900);
  const scroller = [...document.querySelectorAll('div')].find((node) =>
    getComputedStyle(node).overflowY === 'auto' && node.querySelector('[data-index]')) as HTMLElement | undefined;
  assert(!!scroller, 'thought-heavy timeline should virtualize');
  assert(scroller!.querySelectorAll('[data-index]').length > 0, 'rows should mount');
  const scrollHeight = Math.round(scroller!.scrollHeight);
  assert(scrollHeight > thoughtCount * 30, `transcript is too short for ${thoughtCount} thoughts (${scrollHeight}px)`);
  assert(
    scrollHeight < thoughtCount * 60 + 500,
    `row estimates inflate the scroll range (${scrollHeight}px for ${thoughtCount} ~40px rows)`,
  );
  return { passed: true, thoughtCount, scrollHeight };
}});

// A phone-width transcript used to estimate every text row at 90 characters
// per 22px line. A 1,500 character reply really measures ~2,100px there, so
// the virtualizer reserved ~450px and corrected by ~1,600px as the row was
// measured. On iOS those scrollTop corrections are deferred until the finger
// lifts: scrolling up through history made the content slide down under the
// gesture and jump back after the swipe. Estimates must use the real column
// width, font, line height and paragraph margins, and a touch drag must not
// accumulate a deferred correction larger than a fraction of a screen.
Object.assign(window, { runTextEstimateChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const line = "这是一个用来制造高度估算误差的中文长段落，包含标点、代码以及一些 English words 混排。";
  const body = Array.from({ length: 30 }, () => line).join("\n\n");
  const exchanges: any[] = [];
  for (let i = 0; i < 60; i += 1) {
    exchanges.push({ seq: i * 2 + 1, role: "user", content: `问题 ${i}\n` + body, timestamp: "2026-09-28T00:00:00Z" });
    exchanges.push({ seq: i * 2 + 2, role: "agent", content: `回答 ${i}\n\n` + body, timestamp: "2026-09-28T00:00:01Z" });
  }
  (window as any).check.replaceSession({ key: "text-estimates-drag", exchanges, exchange_aux: {} });
  await settle(700);
  const el = [...document.querySelectorAll("div")].find((node) => getComputedStyle(node).overflowY === "auto")!;

  // Finger-down drag = read older messages, the gesture that used to be
  // dragged back. Count how far the content moves beyond the actual scroll.
  // Run this on a freshly opened session: once every row has been measured
  // there is nothing left to correct, which would hide the regression.
  el.scrollTop = el.scrollHeight;
  await settle(500);
  const touch = (type: string, clientY: number) => el.dispatchEvent(new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === "touchend" ? [] : [new Touch({ identifier: 1, target: el, clientY })],
  }));
  let reference: HTMLElement | null = null;
  let fingerY = 400;
  let fingerDrag = 0;
  touch("touchstart", fingerY);
  const flushStart = el.scrollTop;
  for (let step = 0; step < 8; step += 1) {
    if (!reference || !reference.isConnected) {
      const rows = [...el.querySelectorAll<HTMLElement>("[data-session-seq]")];
      reference = rows[rows.length - 1] || null;
    }
    const topBefore = reference ? reference.getBoundingClientRect().top : 0;
    const scrollBefore = el.scrollTop;
    // A long fling through history, not a nudge: rows beyond the mounted
    // overscan are measured during the gesture, which is where the deferred
    // correction used to pile up.
    el.scrollTop = Math.max(0, el.scrollTop - 900);
    fingerY += 480;
    touch("touchmove", fingerY);
    await settle(140);
    if (reference) {
      fingerDrag += (reference.getBoundingClientRect().top - topBefore) - (scrollBefore - el.scrollTop);
      reference = reference.isConnected ? reference : null;
    }
  }
  const beforeRelease = el.scrollTop;
  touch("touchend", fingerY);
  await settle(700);
  const flushed = el.scrollTop - beforeRelease;
  assert(
    Math.abs(fingerDrag) < 250,
    `content slid ${Math.round(fingerDrag)}px under an upward drag`,
  );
  assert(
    Math.abs(flushed) < 250,
    `deferred scroll correction jumped ${Math.round(flushed)}px after the touch`,
  );
  assert(flushStart > beforeRelease, "the drag should move the viewport toward older messages");

  // A new session key drops the virtualizer's measurements, so the scroll
  // body is built from estimates again. Compare it with the range once every
  // row has been measured.
  (window as any).check.replaceSession({ key: "text-estimates-range", exchanges, exchange_aux: {} });
  await settle(700);
  const sizerHeight = () => {
    const sizer = [...el.querySelectorAll("div")].find((node) =>
      node.style.position === "relative" && node.style.height && node.querySelector("[data-index]"));
    return sizer ? Math.round(parseFloat(sizer.style.height)) : 0;
  };
  el.scrollTop = el.scrollHeight;
  await settle(500);
  const estimatedHeight = sizerHeight();
  assert(estimatedHeight > 0, "missing virtual scroll body");
  let guard = 0;
  while (el.scrollTop > 0 && guard < 4000) {
    el.scrollTop = Math.max(0, el.scrollTop - 600);
    await settle(20);
    guard += 1;
  }
  await settle(600);
  const measuredHeight = sizerHeight();
  const estimateError = Math.abs(estimatedHeight - measuredHeight) / measuredHeight;
  assert(
    estimateError < 0.08,
    `text row estimates are ${(estimateError * 100).toFixed(1)}% off the measured range (${estimatedHeight}px vs ${measuredHeight}px)`,
  );
  return {
    passed: true,
    estimatedHeight,
    measuredHeight,
    estimateError: Math.round(estimateError * 1000) / 10,
    fingerDrag: Math.round(fingerDrag),
    flushed: Math.round(flushed),
  };
}});

// Content can grow after the timeline render that would normally scroll the
// transcript: Markdown highlighting, images, diagrams, code blocks and late
// stream chunks settle a frame or more later. For a short first conversation
// there is no virtualizer scroll-body event to re-anchor the tail, so the rest
// of the reply landed below the viewport and no jump button appeared until the
// reader scrolled. Growth while following must keep the tail pinned; growth
// while paused must surface the jump button without a scroll event.
Object.assign(window, { runContentGrowthChecks: async () => {
  const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  (window as any).check.replaceSession({
    key: "content-growth",
    exchanges: [
      { seq: 1, role: "user", content: "问题", timestamp: "2026-09-28T00:00:00Z" },
      { seq: 2, role: "agent", content: "回答\n\n" + "段落内容\n\n".repeat(5), timestamp: "2026-09-28T00:00:01Z" },
    ],
    exchange_aux: {},
  });
  await settle(600);
  const el = [...document.querySelectorAll("div")].find((node) => getComputedStyle(node).overflowY === "auto") as HTMLElement;
  const gap = () => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  const jumpButton = () => !!(document.querySelector('[data-mindfs-jump-latest="1"]') || [...document.querySelectorAll("button")].find((node) => /回到底部最新消息|Jump to latest message/.test(node.getAttribute("aria-label") || "")));
  assert(gap() < 2, "fixture should start at the tail");
  const row = el.querySelector<HTMLElement>('[data-session-seq="2"]');
  assert(!!row, "missing reply row");
  const grow = () => {
    const node = document.createElement("div");
    node.style.height = "600px";
    node.setAttribute("data-growth", "1");
    row!.appendChild(node);
  };

  // Late growth while following: no timeline change, no scroll event.
  grow();
  await settle(400);
  assert(gap() < 2, `late content growth left ${gap()}px below the viewport`);

  // Pause at the tail without moving the view, then grow the content before
  // the settle timer re-arms following. The jump button must appear.
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -5 }));
  const pausedTop = el.scrollTop;
  grow();
  await settle(400);
  assert(
    Math.abs(el.scrollTop - pausedTop) < 2,
    `content growth moved a paused reader (${Math.round(pausedTop)} -> ${Math.round(el.scrollTop)})`,
  );
  assert(!!jumpButton(), "jump-to-latest did not appear when content grew below a paused reader");
  return { passed: true, gap: gap(), pausedTop: Math.round(pausedTop) };
}});

// When a turn finishes, the App re-syncs the persisted exchanges. The
// streaming representation can contain transient rows the persisted history
// does not (for example an optimistic copy of the user message), and the
// virtualizer does not compensate for rows removed above the viewport — the
// text under a paused reader jumps. The viewer pins the top visible row across
// that completion window and must let go as soon as the reader scrolls.
Object.assign(window, { runCompletionAnchorChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const line = "这是一段用于复现回复完成时页面跳动的中文内容，包含 English words 和标点。";
  const reply = Array.from({ length: 60 }, (_, i) => `段落 ${i}：` + line).join("\n\n");
  const exchanges: any[] = [];
  for (let i = 0; i < 60; i += 1) {
    exchanges.push({ seq: i * 2 + 1, role: "user", content: `问题 ${i}\n` + line.repeat(3), timestamp: "2026-09-28T00:00:00Z" });
    exchanges.push({ seq: i * 2 + 2, role: "agent", content: `回答 ${i}\n\n` + line.repeat(6), timestamp: "2026-09-28T00:00:01Z" });
  }
  const user = { seq: 121, role: "user", content: "请详细解释", timestamp: "2026-09-28T00:01:00Z" };
  const optimisticCopy = { role: "user", content: "请详细解释", timestamp: "2026-09-28T00:01:00Z" };
  const streaming = [...exchanges, optimisticCopy, user, { role: "agent", content: reply, timestamp: "2026-09-28T00:01:01Z" }];
  const completed = [...exchanges, user, { seq: 122, role: "agent", content: reply, timestamp: "2026-09-28T00:01:01Z" }];
  const key = "completion-anchor";
  (window as any).check.replaceSession({ key, pending: true, exchanges: streaming, exchange_aux: {} });
  (sessionService as any).dispatchDecrypted("session.stream", key, {
    root_id: "test",
    event: { type: "message_chunk", data: { content: reply } },
  }, {});
  await settle(700);
  const el = [...document.querySelectorAll("div")].find((node) => getComputedStyle(node).overflowY === "auto") as HTMLElement;
  el.scrollTop = el.scrollHeight;
  await settle(500);
  el.scrollTop = el.scrollHeight;
  await settle(300);
  const replyRow = [...el.querySelectorAll<HTMLElement>("[data-index]")].find((node) =>
    node.querySelector(".markdown-viewer")?.textContent?.includes("段落 0："));
  assert(!!replyRow, "missing streaming reply row");
  const elRect = el.getBoundingClientRect();
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -5 }));
  el.scrollTop = Math.max(0, el.scrollTop + (replyRow!.getBoundingClientRect().top - elRect.top) - 40);
  await settle(400);
  const anchorMarkdown = () =>
    [...el.querySelectorAll<HTMLElement>(".markdown-viewer")].find((node) => node.textContent?.includes("段落 0："));
  const beforeTop = anchorMarkdown()!.getBoundingClientRect().top;

  (sessionService as any).dispatchDecrypted("session.done", key, { root_id: "test" }, {});
  (window as any).check.replaceSession({ key, exchanges: completed, exchange_aux: {} });
  await settle(700);
  const anchor = anchorMarkdown();
  assert(!!anchor, "reply disappeared after completion");
  const anchorShift = anchor!.getBoundingClientRect().top - beforeTop;
  assert(
    Math.abs(anchorShift) < 6,
    `completion moved the reading anchor by ${Math.round(anchorShift)}px`,
  );

  // The hold must yield to a reader gesture inside the settle window.
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 5 }));
  const userTop = Math.max(0, el.scrollTop - 240);
  el.scrollTop = userTop;
  await settle(300);
  // A few pixels of virtualizer measurement drift are fine; being dragged
  // back to the pinned offset would be hundreds of pixels.
  assert(
    Math.abs(el.scrollTop - userTop) < 16,
    `completion anchor overrode a user scroll (${Math.round(userTop)} -> ${Math.round(el.scrollTop)})`,
  );
  return {
    passed: true,
    anchorShift: Math.round(anchorShift),
    userScrollKept: Math.round(el.scrollTop),
  };
}});

// The quick user-message popup must not re-center itself on every streamed
// chunk. It used to rerun its "scroll the active row into view" effect
// whenever the timeline reader identity changed, fighting a user who was
// scrolling the popup while the reply kept generating.
Object.assign(window, { runSummaryPopupChecks: async () => {
  const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  (window as any).check.replaceSession({
    key: 'summary-popup', exchanges, exchange_aux: {},
  });
  await settle(300);
  const toggle = document.querySelector<HTMLElement>('[data-mindfs-user-summary="1"] button');
  assert(!!toggle, 'missing user-summary toggle');
  toggle!.click();
  await settle();
  const row = document.querySelector<HTMLElement>('[data-user-summary-index]');
  assert(!!row, 'user-summary popup did not open');
  const scroller = row!.parentElement!.parentElement as HTMLElement;
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  assert(maxTop > 0, 'user-summary popup should be scrollable');
  const centered = scroller.scrollTop;
  scroller.scrollTop = centered > maxTop / 2
    ? Math.max(0, centered - 80)
    : Math.min(maxTop, centered + 80);
  const manualTop = scroller.scrollTop;
  assert(Math.abs(manualTop - centered) > 2, 'could not move the summary popup away from the active row');
  (window as any).check.append();
  await settle(120);
  assert(
    Math.abs(scroller.scrollTop - manualTop) < 2,
    `streamed append re-centered the summary popup (${Math.round(manualTop)} -> ${Math.round(scroller.scrollTop)})`,
  );
  return { passed: true, manualTop: Math.round(manualTop) };
}});

// Guards the transcript tail clearance: at the bottom the floating
// user-message-summary control (and its count badge) must sit below the last
// visible message so the right edge of a reply is clear of the button.
Object.assign(window, { runTailClearanceChecks: async () => {
  const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const scroller = () => [...document.querySelectorAll('div')].find(node => getComputedStyle(node).overflowY === 'auto')!;
  const el = scroller();
  el.scrollTop = el.scrollHeight;
  await settle();

  const summary = document.querySelector('[data-mindfs-user-summary="1"]') as HTMLElement | null;
  const count = document.querySelector('[data-mindfs-user-summary-count="1"]') as HTMLElement | null;
  assert(!!summary && !!count, 'Missing user-summary control');
  const rows = [...document.querySelectorAll<HTMLElement>('[data-session-seq]')];
  assert(rows.length > 0, 'Missing transcript rows');
  const transcriptBottom = Math.max(...rows.map(node => node.getBoundingClientRect().bottom));
  const controlsTop = Math.min(
    summary!.getBoundingClientRect().top,
    count!.getBoundingClientRect().top,
  );
  assert(
    transcriptBottom <= controlsTop,
    `Transcript tail (${Math.round(transcriptBottom)}px) overlaps summary controls (top ${Math.round(controlsTop)}px)`,
  );
  return {passed: true, clearance: Math.round(controlsTop - transcriptBottom)};
}});

// Guards the layout-mode swap: when tools push the timeline across the
// 100-item virtualization threshold while the reader is paused, the reading
// offset must survive. The virtualizer rebuilds its scroll body from size
// estimates; without recording the regular list's measured heights the
// transcript resets to the first message.
Object.assign(window, { runVirtualizationSwitchChecks: async () => {
  const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const scroller = () => [...document.querySelectorAll('div')].find(node => getComputedStyle(node).overflowY === 'auto')!;
  const el = scroller();
  const tall = (i: number, role: string) =>
    `${role} ${i}\n` + Array.from({ length: 24 }, (_, line) => `Line ${line} of a fairly tall message for ${role} ${i}`).join('\n\n');
  const exchanges: any[] = [];
  for (let i = 0; i < 48; i += 1) {
    exchanges.push({ seq: i * 2 + 1, role: 'user', content: tall(i, 'user'), timestamp: '2026-09-28T00:00:00Z' });
    exchanges.push({ seq: i * 2 + 2, role: 'agent', content: tall(i, 'agent'), timestamp: '2026-09-28T00:00:01Z' });
  }
  (window as any).check.replaceSession({ key: 'switch-test', exchanges, exchange_aux: {} });
  await settle();
  assert(document.querySelectorAll('[data-index]').length === 0, 'Fixture should start in the regular list');
  el.scrollTop = el.scrollHeight;
  await settle();
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 4000);
  await settle();
  const readingTop = el.scrollTop;

  const busy = [...exchanges, { seq: 97, role: 'user', content: 'Cross the virtualization threshold', timestamp: '2026-09-28T00:01:00Z' }];
  for (let i = 0; i < 4; i += 1) {
    busy.push({ role: 'tool', content: '', toolCall: { callId: `switch-${i}`, kind: 'read', status: 'complete', title: `Tool ${i}`, meta: {} }, timestamp: `2026-09-28T00:01:0${i + 2}Z` });
  }
  (window as any).check.replaceSession({ key: 'switch-test', exchanges: busy, exchange_aux: {} });
  await settle(900);
  assert(document.querySelectorAll('[data-index]').length > 0, 'Timeline should now be virtualized');
  const after = el.scrollTop;
  assert(
    Math.abs(after - readingTop) < 80,
    `Reading offset moved across the virtualization switch: ${Math.round(readingTop)} -> ${Math.round(after)}`,
  );
  return { passed: true, before: Math.round(readingTop), after: Math.round(after) };
}});

// Run via a browser console or agent-browser eval. No server/agent data is used.
Object.assign(window, { runVirtualizationChecks: async () => {
  const api = () => (window as any).check;
  const settle = () => new Promise(resolve => setTimeout(resolve, 400));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const scroller = () => [...document.querySelectorAll('div')].find(node => getComputedStyle(node).overflowY === 'auto')!;
  const rows = () => document.querySelectorAll('[data-index]').length;
  await settle();
  assert(rows() > 0 && rows() < 80, 'Only viewport rows should mount');
  const initialRows = rows();
  assert(scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight < 2, 'Initial view should be at bottom');
  assert(requests === 0, 'Collapsed cards should not load remote details');
  api().jump(21);
  await settle();
  const target = document.querySelector('[data-session-seq="21"]')!;
  assert(!!target && target.getBoundingClientRect().top > 0 && target.getBoundingClientRect().bottom < innerHeight, 'Search target should be visible');
  const tool = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Tool 10-0')!;
  tool.click();
  await settle();
  assert(requests === 1 && document.body.innerText.includes('REMOTE DETAIL call-10-0'), 'Expanding should load details');
  api().jump(41);
  await settle();
  assert(!document.body.innerText.includes('REMOTE DETAIL call-10-0'), 'Offscreen details should unmount');
  api().jump(21);
  await settle();
  assert(requests === 1 && document.body.innerText.includes('REMOTE DETAIL call-10-0'), 'Expansion and cached details should survive remount');
  const readingTop = scroller().scrollTop;
  api().append();
  await settle();
  assert(Math.abs(scroller().scrollTop - readingTop) < 2, 'Appending should preserve reading position');
  // Re-entering constructs a new viewer without mounting the full history.
  api().toggle();
  await settle();
  api().jump(0);
  api().toggle();
  await settle();
  assert(rows() > 0 && rows() < 80, 'Re-entry should remain virtualized');
  api().append();
  await settle();
  assert(scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight < 2, 'Appending at bottom should follow the tail');
  const finalRows = rows();
  api().question();
  await settle();
  const draft = document.querySelector('textarea');
  assert(!!draft, 'Pending question should display its input');
  api().jump(21);
  await settle();
  assert(draft === document.querySelector('textarea') && draft!.isConnected, 'Pending question input should survive scrolling out of view');
  api().jump(0);
  api().short();
  await settle();
  assert(rows() === 0, 'Short sessions should use the regular layout');
  assert(!document.body.innerText.includes('NEW DIFF LINE'), 'Folded diff should not render');
  assert(document.body.innerText.includes('SHELL READY'), 'User shell should still expand by default');
  [...document.querySelectorAll('button')].find(node => node.textContent?.includes('Large edit'))!.click();
  await settle();
  assert(document.body.innerText.includes('NEW DIFF LINE'), 'Expanded diff should render');
  assert(requests === 1, 'Local diff and shell output should not request remote details');
  return {passed: true, toolCalls: 3000, initialRows, finalRows, detailRequests: requests};
}});

// A tool call can be persisted twice: a turn that is interrupted while the call
// is still running records the start, and the completion lands in the next
// turn's exchange. Both occurrences share a server callId. Using that id as the
// timeline identity gave React two children with the same key, so expanding one
// card could reuse the other card's state, and the virtualizer's size cache
// (keyed by the same id) positioned the rows on top of each other. Each
// occurrence must keep a distinct timeline/render identity.
Object.assign(window, { runDuplicateCallIdChecks: async () => {
  const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const scroller = () => [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto')!;
  const filler = Array.from({ length: 110 }, (_, index) => ({
    seq: 2,
    line: 0,
    toolcall: {
      callId: `filler-${index}`,
      kind: 'execute',
      status: 'complete',
      title: `Filler ${index}`,
      meta: { command: 'echo filler', output: '' },
    },
  }));
  const fixture = (withFiller: boolean) => ({
    key: withFiller ? 'duplicate-call-virtual' : 'duplicate-call-short',
    exchanges: [
      { seq: 1, role: 'user', content: 'Start the long call', timestamp: '2026-10-01T00:00:00Z' },
      { seq: 2, role: 'agent', content: '', timestamp: '2026-10-01T00:00:01Z' },
      { seq: 3, role: 'user', content: 'Interrupt while it runs', timestamp: '2026-10-01T00:00:02Z' },
      { seq: 4, role: 'agent', content: '', timestamp: '2026-10-01T00:00:03Z' },
    ],
    exchange_aux: {
      2: [
        ...(withFiller ? filler : []),
        { seq: 2, line: 0, toolcall: { callId: 'dup-call', kind: 'execute', status: 'running', title: 'Duplicate call', meta: { command: 'echo dup' } } },
      ],
      4: [{ seq: 4, line: 0, toolcall: { callId: 'dup-call', kind: 'execute', status: 'complete', title: 'Duplicate call', meta: { command: 'echo dup' } } }],
    },
  });
  const duplicateButtons = () => [...document.querySelectorAll<HTMLElement>('button')]
    .filter((node) => node.textContent?.trim() === 'Duplicate call')
    .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
  const originalError = console.error;
  const consoleErrors: string[] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((value) => String(value)).join(' '));
    originalError(...args);
  };
  try {
    (window as any).check.replaceSession(fixture(true));
    await settle(600);
    const el = scroller();
    el.scrollTop = el.scrollHeight;
    await settle(600);
    let buttons = duplicateButtons();
    assert(buttons.length === 2, `duplicated call should render two cards, got ${buttons.length}`);
    const [first, second] = buttons.map((node) => node.parentElement!.getBoundingClientRect());
    assert(
      first.bottom <= second.top + 2,
      `duplicated cards overlap (${Math.round(first.bottom)} > ${Math.round(second.top)})`,
    );
    const cards = buttons.map((node) => node.parentElement as HTMLElement);
    const before = cards.map((card) => Math.round(card.getBoundingClientRect().height));
    // Expand the first occurrence: its rows sit between the two cards, so a
    // shared virtualizer measurement (key collision) pushes the following row
    // over the expanded content instead of below it.
    buttons[0].click();
    await settle(700);
    const after = cards.map((card) => Math.round(card.getBoundingClientRect().height));
    assert(after[0] > before[0] + 100, `clicked duplicate card did not expand (${before[0]} -> ${after[0]})`);
    assert(
      Math.abs(after[1] - before[1]) <= 2,
      `expanding one duplicate expanded the other (${before[1]} -> ${after[1]})`,
    );
    const [expandedRect, collapsedRect] = cards.map((card) => card.getBoundingClientRect());
    assert(
      expandedRect.bottom <= collapsedRect.top + 2,
      `expanded card overlaps the next occurrence (${Math.round(expandedRect.bottom)} > ${Math.round(collapsedRect.top)})`,
    );
    assert(
      cards[0].innerText.includes('REMOTE DETAIL dup-call'),
      'expanded card should render its own loaded output',
    );
    assert(
      !cards[1].innerText.includes('REMOTE DETAIL dup-call'),
      'the expanded output leaked into the other occurrence of the call',
    );

    // The regular (non-virtualized) list keyed the cards the same way.
    (window as any).check.replaceSession(fixture(false));
    await settle(400);
    buttons = duplicateButtons();
    assert(buttons.length === 2, `short list should render two cards, got ${buttons.length}`);
    buttons[0].click();
    await settle(600);
    const shortCards = buttons.map((node) => node.parentElement as HTMLElement);
    const shortHeights = shortCards.map((card) => Math.round(card.getBoundingClientRect().height));
    assert(shortHeights[0] > shortHeights[1] + 100, 'expanding one card in the short list must not touch its duplicate');
    assert(
      shortCards[0].innerText.includes('REMOTE DETAIL dup-call') &&
        !shortCards[1].innerText.includes('REMOTE DETAIL dup-call'),
      'short list expanded details landed on the wrong card',
    );

    assert(
      !consoleErrors.some((message) => message.includes('same key')),
      `duplicate timeline keys rendered: ${consoleErrors.join(' | ')}`,
    );
    return {passed: true, cards: buttons.length, heights: after};
  } finally {
    console.error = originalError;
  }
}});

// A live turn keeps tool calls in transient role:"tool" exchanges. When the
// turn finishes, the viewer re-syncs the persisted session and the same call
// moves into its agent exchange's aux list. The timeline id is exchange-scoped,
// so that move changed the card's key and remounted it: the expansion cache was
// also keyed by the old id, so an expanded tool card collapsed the moment the
// reply completed. Expansion state must survive the live -> persisted re-key.
Object.assign(window, { runCompletionExpansionChecks: async () => {
  const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const contentText = 'EXPANDED DETAIL ' + 'detail line\n'.repeat(40);
  const thoughtText = 'EXPANDED THOUGHT ' + 'thought line\n'.repeat(40);
  const thoughtId = 'completion-expand-thought';
  const toolCall = {
    callId: 'completion-expand-tool',
    kind: 'read',
    status: 'running',
    title: 'Completion tool',
    meta: {},
    content: [{ type: 'text', text: contentText }],
  };
  const streaming = {
    key: 'completion-expand',
    exchanges: [
      { seq: 1, role: 'user', content: 'Start the call', timestamp: '2026-10-02T00:00:00Z' },
      { seq: 2, role: 'agent', content: 'Working on it', timestamp: '2026-10-02T00:00:01Z' },
      { role: 'thought', content: thoughtText, thought_id: thoughtId, timestamp: '2026-10-02T00:00:01Z' },
      { role: 'tool', content: '', timestamp: '2026-10-02T00:00:01Z', toolCall },
    ],
    exchange_aux: {},
  };
  const completed = {
    key: 'completion-expand',
    exchanges: [
      { seq: 1, role: 'user', content: 'Start the call', timestamp: '2026-10-02T00:00:00Z' },
      { seq: 2, role: 'agent', content: 'Working on it', timestamp: '2026-10-02T00:00:02Z' },
    ],
    exchange_aux: {
      2: [
        { seq: 2, line: 0, thought: thoughtText, thought_id: thoughtId },
        { seq: 2, line: 0, toolcall: { ...toolCall, status: 'complete' } },
      ],
    },
  };
  const toolButton = () => [...document.querySelectorAll('button')]
    .find((node) => (node.textContent || '').includes('Completion tool'));
  const thoughtButton = () => [...document.querySelectorAll('button')]
    .find((node) => /Thinking process|思考过程/.test(node.textContent || ''));
  const api = (window as any).check;
  api.replaceSession(streaming);
  await settle(500);
  const button = toolButton();
  assert(!!button, 'missing live tool card');
  const thinkingButton = thoughtButton();
  assert(!!thinkingButton, 'missing live thought block');
  thinkingButton!.click();
  button!.click();
  await settle(500);
  const card = button!.parentElement as HTMLElement;
  const expandedHeight = Math.round(card.getBoundingClientRect().height);
  assert(card.innerText.includes('EXPANDED DETAIL'), 'clicking should expand the live card');
  assert(expandedHeight > 150, `live card should show details (height ${expandedHeight})`);
  assert(document.body.innerText.includes('EXPANDED THOUGHT'), 'clicking should expand the live thought');

  api.replaceSession(completed);
  await settle(700);
  const completedButton = toolButton();
  assert(!!completedButton, 'missing completed tool card');
  const completedCard = completedButton!.parentElement as HTMLElement;
  const completedHeight = Math.round(completedCard.getBoundingClientRect().height);
  assert(
    completedCard.innerText.includes('EXPANDED DETAIL'),
    'an expanded tool card collapsed when the finished turn was re-synced',
  );
  assert(
    completedHeight > 150,
    `completed card lost its details (height ${completedHeight}, was ${expandedHeight})`,
  );
  assert(
    document.body.innerText.includes('EXPANDED THOUGHT'),
    'an expanded thought block collapsed when the finished turn was re-synced',
  );
  return { passed: true, expandedHeight, completedHeight };
}});

// A paused reader who expands a thought block while the reply streams must
// still be looking at it when the turn completes. The completion re-sync
// re-keys transient thought rows and drops the optimistic user copy, so the
// completion anchor resolves by content. Two ways that used to land the
// viewport screens above the reader:
//  - the first content match wins, and short repeated messages ("继续") exist
//    many turns earlier in the session;
//  - the live capture survives a return to the tail, so the next pause (the
//    expansion) pins the abandoned position.
// Both made the transcript jump back to a previous conversation as soon as
// the persisted exchanges and their stats replaced the live turn.
Object.assign(window, { runCompletionThoughtAnchorChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-13T00:00:00Z';
  const scroller = () => [...document.querySelectorAll('div')]
    .find((node) => getComputedStyle(node).overflowY === 'auto') as HTMLElement;
  const lastUserRow = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>('[data-user-message-index]')].pop();
  const thoughtButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => /Thinking process|思考过程/.test(node.textContent || ''));
  const history: any[] = [];
  for (let i = 0; i < 12; i += 1) {
    history.push({ seq: i * 2 + 1, role: 'user', content: '继续', timestamp: stamp });
    history.push({
      seq: i * 2 + 2,
      role: 'agent',
      content: `回答 ${i}\n\n` + '这是一段用于把历史撑高的回复内容。\n'.repeat(8),
      timestamp: stamp,
    });
  }
  const latestUser = { seq: 25, role: 'user', content: '继续', timestamp: stamp };
  const thoughtText = 'THOUGHT ANCHOR ' + '思考内容\n'.repeat(30);
  // Tall enough that the latest user row can sit at the top of the viewport
  // while the streaming thought block below it stays reachable.
  const reply = '最后一条回复开始输出。\n\n' + '流式正文。\n\n'.repeat(14);
  const streamingFixture = (key: string) => ({
    key,
    pending: true,
    exchanges: [
      ...history,
      { role: 'user', content: '继续', timestamp: stamp },
      latestUser,
      { role: 'agent', content: reply, timestamp: stamp },
      { role: 'thought', content: thoughtText, thought_id: 'anchor-thought', timestamp: stamp },
    ],
    exchange_aux: {},
  });
  const completedFixture = (key: string) => ({
    key,
    exchanges: [
      ...history,
      latestUser,
      { seq: 26, role: 'agent', content: reply, timestamp: stamp },
    ],
    exchange_aux: {
      26: [{ seq: 26, line: 0, thought: thoughtText, thought_id: 'anchor-thought' }],
    },
  });
  const startStreaming = async (fixture: any) => {
    (window as any).check.replaceSession(fixture);
    (sessionService as any).dispatchDecrypted('session.stream', fixture.key, {
      root_id: 'test',
      event: { type: 'message_chunk', data: { content: 'x' } },
    }, {});
    await settle(600);
    const el = scroller();
    el.scrollTop = el.scrollHeight;
    await settle(300);
    return el;
  };
  const complete = async (fixture: any) => {
    (sessionService as any).dispatchDecrypted('session.done', fixture.key, { root_id: 'test' }, {});
    (window as any).check.replaceSession(fixture);
    await settle(700);
  };

  // (1) Content-prefix collisions: the anchor sits on the latest of many
  // identical "继续" messages. Completion must keep that row in place, not
  // resolve the first earlier duplicate.
  const keyA = 'completion-thought-duplicate';
  const elA = await startStreaming(streamingFixture(keyA));
  const elARect = elA.getBoundingClientRect();
  elA.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -5 }));
  const latestUserRow = lastUserRow(elA);
  assert(!!latestUserRow, 'missing latest user row');
  // Align the latest "继续" row with the top of the viewport. The tall reply
  // below it leaves the thought header on screen, so this is the row the
  // completion anchor must resolve.
  elA.scrollTop += latestUserRow!.getBoundingClientRect().top - elARect.top;
  await settle(350);
  const anchor = lastUserRow(elA);
  const anchorTop = anchor!.getBoundingClientRect().top;
  assert(
    Math.abs(anchorTop - elARect.top) < 40,
    `fixture did not place the latest user row at the top (${Math.round(anchorTop - elARect.top)}px)`,
  );
  const beforeTop = anchorTop;
  const thought = thoughtButton();
  assert(!!thought, 'missing streaming thought block');
  assert(
    thought!.getBoundingClientRect().top < elARect.bottom,
    `fixture hid the thought block below the fold (thought ${Math.round(thought!.getBoundingClientRect().top - elARect.top)}, viewport ${Math.round(elARect.height)}, user ${Math.round(anchorTop - elARect.top)})`,
  );
  thought!.click();
  await settle(300);
  const preScrollTop = elA.scrollTop;
  await complete(completedFixture(keyA));
  const afterAnchor = lastUserRow(elA);
  assert(!!afterAnchor, 'latest user row disappeared after completion');
  const anchorShift = afterAnchor!.getBoundingClientRect().top - beforeTop;
  assert(
    Math.abs(anchorShift) < 24,
    `completion anchored to an older duplicate (moved ${Math.round(anchorShift)}px, scrollTop ${Math.round(preScrollTop)} -> ${Math.round(elA.scrollTop)})`,
  );

  // (2) Stale live capture: read an earlier answer, return to the tail, then
  // pause by expanding the thought block. Completion must use the expansion
  // position, not the abandoned reading position.
  const keyB = 'completion-thought-stale';
  const elB = await startStreaming(streamingFixture(keyB));
  const elBRect = elB.getBoundingClientRect();
  elB.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -5 }));
  const oldRow = [...elB.querySelectorAll<HTMLElement>('[data-user-message-index]')][3];
  assert(!!oldRow, 'missing early history row');
  elB.scrollTop += oldRow.getBoundingClientRect().top - elBRect.top;
  await settle(400);
  elB.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
  elB.scrollTop = elB.scrollHeight;
  await settle(400);
  const thoughtBefore = thoughtButton();
  assert(!!thoughtBefore, 'missing streaming thought block');
  thoughtBefore!.click();
  await settle(250);
  const preStaleScrollTop = elB.scrollTop;
  await complete(completedFixture(keyB));
  assert(!!thoughtButton(), 'thought block disappeared after completion');
  // Pinning the abandoned reading position would land the transcript on that
  // old answer, far above the tail. A fresh capture keeps the viewport where
  // the expansion happened; only rows that actually changed above it shift.
  assert(
    elB.scrollTop >= preStaleScrollTop - 300,
    `completion reused a stale reading anchor (scrollTop ${Math.round(preStaleScrollTop)} -> ${Math.round(elB.scrollTop)})`,
  );
  return {
    passed: true,
    duplicateAnchorShift: Math.round(anchorShift),
    staleScrollShift: Math.round(elB.scrollTop - preStaleScrollTop),
  };
}});

// The transcript reserves tall tail space below the last row for the floating
// jump/task controls, so a reader can stop with the newest message fully
// visible while the scrollable bottom is still ~65-85px further down. Treating
// only the hard bottom as "at the tail" kept following paused there: new
// chunks landed below the fold and only the jump button could recover. A
// downward wheel/finger gesture that brings the content end into view must
// resume following. A reader who scrolled up and stopped in that reserved
// area without downward intent keeps their pause.
Object.assign(window, { runTailReturnChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-11T00:00:00Z';
  const line = '这是一段用于测试回到底部的中文内容，带 English words 和标点。';
  const history: any[] = [];
  for (let i = 0; i < 20; i += 1) {
    history.push({ seq: i * 2 + 1, role: 'user', content: `问题 ${i}\n${line.repeat(2)}`, timestamp: stamp });
    history.push({ seq: i * 2 + 2, role: 'agent', content: `回答 ${i}\n\n${line.repeat(5)}`, timestamp: stamp });
  }
  const user = { seq: 41, role: 'user', content: '请继续', timestamp: stamp };
  const base = [...history, user];
  let content = line.repeat(6);
  const render = () => (window as any).check.replaceSession({
    key: 'tail-return',
    pending: true,
    exchanges: [...base, { role: 'agent', content, timestamp: stamp }],
    exchange_aux: {},
  });
  render();
  await settle(700);
  const el = [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto') as HTMLElement;
  const gap = () => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  const jumpButton = () => document.querySelector('[data-mindfs-jump-latest="1"]') as HTMLElement | null;
  const endMarker = () => document.querySelector('[data-session-scroll-end="1"]') as HTMLElement;
  const visibleTailTop = () => {
    const end = endMarker();
    assert(!!end, 'missing content end marker');
    return el.scrollTop + (end!.getBoundingClientRect().top - el.getBoundingClientRect().bottom);
  };
  const settleAtBottom = async () => {
    el.scrollTop = el.scrollHeight;
    await settle(300);
    el.scrollTop = el.scrollHeight;
    await settle(300);
  };
  const appendChunk = async () => {
    content += '\n\n' + line.repeat(2);
    render();
    await settle(250);
  };
  await settleAtBottom();
  assert(gap() < 2, 'fixture should start at the tail');

  // Read older messages; the pause surfaces the jump button.
  el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -5 }));
  el.scrollTop = Math.max(0, el.scrollTop - 300);
  await settle(350);
  assert(!!jumpButton(), 'jump button should appear after scrolling up');
  assert(gap() > 200, 'fixture should be reading well above the tail');

  // Stop in the reserved tail area without any downward gesture: the reader
  // scrolled up, so the pause must hold.
  el.scrollTop = visibleTailTop();
  await settle(300);
  const readingGap = gap();
  assert(readingGap > 40, `reserved tail area should be below the 40px threshold (${readingGap}px)`);
  assert(!!jumpButton(), 'stopping in the tail area after scrolling up must keep the pause');
  await appendChunk();
  assert(gap() > 40, 'a paused reader in the reserved tail area must not be dragged down');

  // Return with a downward wheel and stop where the newest message is visible.
  el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
  el.scrollTop = Math.min(el.scrollHeight, visibleTailTop() + 20);
  await settle(300);
  assert(!jumpButton(), 'a downward return to the visible tail must resume following');
  await appendChunk();
  assert(gap() < 2, `streamed output was not followed after returning to the tail (${gap()}px)`);
  return { passed: true, readingGap, finalGap: gap() };
}});

// A tap on a transcript control (tool card, ask_user option, link) carries a
// few pixels of finger drift on a phone. That drift paused tail-following even
// though the transcript never moved; when the reply appended more than the
// reserved tail area within the settle window, the pause check could no longer
// see the content end and latched following off until the jump button was
// clicked. A pause that never moved the reader up must always re-arm.
Object.assign(window, { runStrayTouchRecoveryChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-11T00:00:00Z';
  const line = '这是一段用于测试误触摸恢复的内容，带 English words 和标点。';
  const history: any[] = [];
  for (let i = 0; i < 20; i += 1) {
    history.push({ seq: i * 2 + 1, role: 'user', content: `问题 ${i}\n${line.repeat(2)}`, timestamp: stamp });
    history.push({ seq: i * 2 + 2, role: 'agent', content: `回答 ${i}\n\n${line.repeat(5)}`, timestamp: stamp });
  }
  const user = { seq: 41, role: 'user', content: '请继续', timestamp: stamp };
  let content = line.repeat(6);
  const render = () => (window as any).check.replaceSession({
    key: 'stray-touch',
    pending: true,
    exchanges: [...history, user, { role: 'agent', content, timestamp: stamp }],
    exchange_aux: {},
  });
  render();
  await settle(700);
  const el = [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto') as HTMLElement;
  const gap = () => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  const jumpButton = () => document.querySelector('[data-mindfs-jump-latest="1"]') as HTMLElement | null;
  const fireTouch = (type: string, clientY: number) =>
    el.dispatchEvent(new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientY })],
    }));
  // Chromium's scroll anchoring silently follows the content end here, which
  // hides the latch; iOS Safari has no scroll anchoring, so a paused viewport
  // stays put while the reply grows below it.
  el.style.overflowAnchor = 'none';
  el.scrollTop = el.scrollHeight;
  await settle(300);
  el.scrollTop = el.scrollHeight;
  await settle(300);
  assert(gap() < 2, 'fixture should start at the tail');

  // Tap drift: the finger moves 3px down but the transcript never scrolls.
  fireTouch('touchstart', 300);
  fireTouch('touchmove', 303);
  fireTouch('touchend', 303);

  // The reply keeps streaming before the pause settle window closes. The new
  // rows push the content end more than the reserved tail area below the fold.
  content += '\n\n' + line.repeat(10);
  render();
  await settle(400);
  assert(gap() < 2, `a stray tap while streaming latched following off (${gap()}px below)`);
  assert(!jumpButton(), 'a stray tap while streaming surfaced the jump button');

  // Following keeps holding for later chunks.
  content += '\n\n' + line.repeat(4);
  render();
  await settle(300);
  assert(gap() < 2, `following did not hold after a stray tap (${gap()}px below)`);
  return { passed: true, finalGap: gap() };
}});

// An iOS fling back toward the tail keeps scrolling for longer than the
// 600ms wheel/touch intent window, and it usually decays inside the reserved
// tail padding, with the end marker just below the fold. The return gesture
// must re-arm following on position alone; waiting for a fresh intent event
// left the reader paused with the newest message on screen.
Object.assign(window, { runMomentumTailChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-11T00:00:00Z';
  const line = '这是一段用于测试惯性回到底部的内容，带 English words 和标点。';
  const history: any[] = [];
  for (let i = 0; i < 20; i += 1) {
    history.push({ seq: i * 2 + 1, role: 'user', content: `问题 ${i}\n${line.repeat(2)}`, timestamp: stamp });
    history.push({ seq: i * 2 + 2, role: 'agent', content: `回答 ${i}\n\n${line.repeat(5)}`, timestamp: stamp });
  }
  let content = line.repeat(6);
  const render = () => (window as any).check.replaceSession({
    key: 'momentum-tail',
    exchanges: [...history, { seq: 41, role: 'user', content: '请继续', timestamp: stamp }, { role: 'agent', content, timestamp: stamp }],
    exchange_aux: {},
  });
  render();
  await settle(700);
  const el = [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto') as HTMLElement;
  const gap = () => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  const jumpButton = () => document.querySelector('[data-mindfs-jump-latest="1"]') as HTMLElement | null;
  const fireTouch = (type: string, clientY: number) =>
    el.dispatchEvent(new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientY })],
    }));
  el.scrollTop = el.scrollHeight;
  await settle(300);
  el.scrollTop = el.scrollHeight;
  await settle(300);
  assert(gap() < 2, 'fixture should start at the tail');

  // Read older messages.
  el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
  el.scrollTop = Math.max(0, el.scrollTop - 600);
  await settle(350);
  assert(!!jumpButton(), 'jump button should appear after scrolling up');

  // Fling back with the finger, then let momentum run past the intent window.
  // Five steps of 100px leave the view 100px above the hard bottom: inside
  // the reserved padding, with the end marker just below the fold.
  fireTouch('touchstart', 400);
  for (let step = 0; step < 5; step += 1) {
    fireTouch('touchmove', 400 - (step + 1) * 15);
    el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + 100);
    await settle(50);
  }
  fireTouch('touchend', 345);
  await settle(700);
  const restingGap = gap();
  assert(restingGap > 40, `fling should rest inside the reserved tail area (${restingGap}px)`);
  assert(restingGap < 110, `fling should stop near the newest message (${restingGap}px)`);
  await settle(300);
  assert(!jumpButton(), 'a fling stopping near the newest message left the jump button up');

  // The next streamed chunk follows without another gesture.
  content += '\n\n' + line.repeat(4);
  render();
  await settle(300);
  assert(gap() < 2, `streamed output was not followed after the fling (${gap()}px)`);
  return { passed: true, restingGap, finalGap: gap() };
}});

// Editing a user message restarts the conversation from that point and
// streams a fresh reply. Unlike a normal send there is no optimistic
// pending_ack row to re-arm following, so the edit taps or the scroll used to
// reach the message left the iOS reader paused above the new reply. Submitting
// the inline editor must return the viewport to the tail.
Object.assign(window, { runEditResubmitChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-11T00:00:00Z';
  const line = '这是一段用于测试编辑重发的中文内容，带 English words 和标点。';
  const history: any[] = [];
  for (let i = 0; i < 6; i += 1) {
    history.push({ seq: i * 2 + 1, role: 'user', content: `问题 ${i}\n${line.repeat(2)}`, timestamp: stamp });
    history.push({ seq: i * 2 + 2, role: 'agent', content: `回答 ${i}\n\n${line.repeat(5)}`, timestamp: stamp });
  }
  let reply = line.repeat(6);
  const render = (edited: boolean) => (window as any).check.replaceSession({
    key: 'edit-resubmit',
    type: 'chat',
    exchanges: [
      ...history,
      { seq: 13, role: 'user', content: edited ? '编辑后的第一条问题' : '请继续', timestamp: stamp },
      { role: 'agent', content: reply, timestamp: stamp },
    ],
    exchange_aux: {},
  });
  render(false);
  await settle(700);
  const el = [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto') as HTMLElement;
  const gap = () => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  const jumpButton = () => document.querySelector('[data-mindfs-jump-latest="1"]') as HTMLElement | null;
  el.scrollTop = el.scrollHeight;
  await settle(300);
  assert(gap() < 2, 'fixture should start at the tail');

  // Read up to the latest user message and open its inline editor.
  el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
  el.scrollTop = Math.max(0, el.scrollTop - 250);
  await settle(350);
  assert(gap() > 40, `fixture should be reading above the tail (${gap()}px)`);
  const row = el.querySelector<HTMLElement>('[data-session-seq="13"]');
  assert(!!row, 'missing latest user row');
  const editButton = [...row!.querySelectorAll('button')].find((node) =>
    /编辑消息|Edit message/.test(node.getAttribute('aria-label') || ''),
  );
  assert(!!editButton, 'missing inline edit button');
  editButton!.click();
  await settle(150);
  const textarea = row!.querySelector('textarea');
  assert(!!textarea, 'missing inline editor');
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  valueSetter.call(textarea, '编辑后的第一条问题');
  textarea!.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(50);
  const sendButton = [...row!.querySelectorAll('button')].find((node) =>
    /^(发送|Send)$/.test((node.textContent || '').trim()),
  );
  assert(!!sendButton, 'missing edit submit button');
  sendButton!.click();
  await settle(400);

  // The regenerated reply streams at the tail.
  reply = line.repeat(10);
  render(true);
  await settle(400);
  assert(gap() < 2, `editing and resending did not follow the reply (${gap()}px)`);
  assert(!jumpButton(), 'editing and resending left the jump button up');
  return { passed: true, finalGap: gap() };
}});

// Expanding a card is a deliberate pause. When the expanded rows later merge
// or collapse, the content shrinks and the browser clamps the viewport back to
// the hard bottom, which hides the jump button. The pause must end there too:
// keeping it made following silently off even though the button was gone, and
// later streamed output was not followed.
Object.assign(window, { runExpansionRecoveryChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-11T00:00:00Z';
  const line = '这是一段用于测试展开后恢复跟随的中文内容，带 English words 和标点。';
  const history: any[] = [];
  for (let i = 0; i < 8; i += 1) {
    history.push({ seq: i * 2 + 1, role: 'user', content: `问题 ${i}\n${line.repeat(2)}`, timestamp: stamp });
    history.push({ seq: i * 2 + 2, role: 'agent', content: `回答 ${i}\n\n${line.repeat(4)}`, timestamp: stamp });
  }
  const toolSeq = 18;
  const user = { seq: 17, role: 'user', content: '最后的问题\n' + line.repeat(2), timestamp: stamp };
  const render = (withTool: boolean, reply: string) => (window as any).check.replaceSession({
    key: 'expansion-recovery',
    exchanges: [...history, user, { seq: toolSeq, role: 'agent', content: reply, timestamp: stamp }],
    exchange_aux: withTool
      ? {
          [String(toolSeq)]: [{
            seq: toolSeq,
            line: 0,
            toolcall: {
              callId: 'merge-tool',
              kind: 'read',
              status: 'complete',
              title: 'Mergeable tool',
              meta: {},
            },
          }],
        }
      : {},
  });
  render(true, line.repeat(4));
  await settle(700);
  const el = [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto') as HTMLElement;
  // Chromium's scroll anchoring follows the growing card by itself, which
  // hides the pause; iOS Safari has no scroll anchoring, so the viewport
  // stays put and the jump button surfaces.
  el.style.overflowAnchor = 'none';
  const gap = () => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  const jumpButton = () => document.querySelector('[data-mindfs-jump-latest="1"]') as HTMLElement | null;
  el.scrollTop = el.scrollHeight;
  await settle(300);
  el.scrollTop = el.scrollHeight;
  await settle(300);
  assert(gap() < 2, 'fixture should start at the tail');

  // Expand the last tool call: the details grow below the viewport and the
  // deliberate pause surfaces the jump button.
  const toolButton = [...document.querySelectorAll('button')].find((node) =>
    (node.textContent || '').includes('Mergeable tool'),
  ) as HTMLElement | undefined;
  assert(!!toolButton, 'missing tool card');
  toolButton!.click();
  await settle(700);
  assert(gap() > 40, `expanding should push the tail below the fold (${gap()}px)`);
  assert(!!jumpButton(), 'expanding should surface the jump button');

  // Merging/collapsing the call shrinks the content back under the viewport.
  // No scroll event is produced (scrollTop stays where it was), so the content
  // observer must end the intentional pause. The jump button hides at the same
  // time; keeping the pause would make it invisible and later output would not
  // be followed.
  toolButton!.click();
  await settle(500);
  assert(gap() < 2, `collapsing should return to the hard bottom (${gap()}px)`);
  assert(!jumpButton(), 'collapsing should hide the jump button');
  render(false, line.repeat(10));
  await settle(400);
  assert(gap() < 2, `output after a collapsed expansion was not followed (${gap()}px)`);
  return { passed: true, finalGap: gap() };
}});

// Expanding a card is a deliberate pause, including while the reply streams.
// A short tool detail keeps the pause inside the reserved tail area, and the
// streamed growth there used to end the pause on the next content resize or
// scroll event: every new chunk re-armed tail-following and snapped the
// viewport back down. A slow upward drag inside the zone was pulled down chunk
// by chunk (a fast drag escaped before the next chunk landed). Only a layout
// shrink that brings the tail back into view may end the pause on its own.
Object.assign(window, { runExpandedStreamScrollChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-13T00:00:00Z';
  const line = '这是一段用于测试流式生成时展开工具卡后向上滚动的中文内容，带 English words 和标点。';
  const history: any[] = [];
  for (let i = 0; i < 8; i += 1) {
    history.push({ seq: i * 2 + 1, role: 'user', content: `问题 ${i}\n${line.repeat(2)}`, timestamp: stamp });
    history.push({ seq: i * 2 + 2, role: 'agent', content: `回答 ${i}\n\n${line.repeat(4)}`, timestamp: stamp });
  }
  let reply = '正在生成回复。\n\n' + line.repeat(3);
  const key = 'expanded-stream-scroll';
  // The expanded details stay short on purpose (a few locations, no body):
  // the pause must keep working even when the card ends up inside the reserved
  // tail padding, where the tail-slop rules used to re-arm following to the
  // still-growing reply.
  const toolCall = {
    callId: 'stream-expand-tool',
    kind: 'read',
    status: 'running',
    title: 'Streaming tool',
    meta: {},
    content: [{ type: 'text', text: '' }],
    locations: [{ path: 'src/app.ts', line: 12 }],
  };
  const render = () => (window as any).check.replaceSession({
    key,
    pending: true,
    exchanges: [
      ...history,
      { seq: 17, role: 'user', content: '最后的问题', timestamp: stamp },
      { seq: 18, role: 'agent', content: reply, timestamp: stamp },
      { role: 'tool', content: '', timestamp: stamp, toolCall },
    ],
    exchange_aux: {},
  });
  render();
  await settle(700);
  (sessionService as any).dispatchDecrypted('session.stream', key, {
    root_id: 'test',
    event: { type: 'message_chunk', data: { content: 'x' } },
  }, {});
  await settle(200);
  const el = [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto') as HTMLElement;
  // iOS Safari has no scroll anchoring; disable Chromium's so growth moves the
  // reader exactly like the reported PWA behavior.
  el.style.overflowAnchor = 'none';
  const gap = () => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  const scrollToTail = async () => {
    el.scrollTop = el.scrollHeight;
    await settle(300);
    el.scrollTop = el.scrollHeight;
    await settle(300);
  };
  const chunk = async () => {
    reply += '\n\n' + '新增片段';
    render();
    await settle(220);
  };
  const fireTouch = (type: string, clientY: number) => el.dispatchEvent(new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientY })],
  }));
  await scrollToTail();
  assert(gap() < 2, `fixture should start at the tail (${gap()}px below)`);

  const toolButton = [...document.querySelectorAll('button')].find((node) =>
    (node.textContent || '').includes('Streaming tool'),
  ) as HTMLElement | undefined;
  assert(!!toolButton, 'missing streaming tool card');
  toolButton!.click();
  await settle(400);
  const pauseTop = el.scrollTop;
  const expandedGap = gap();
  assert(expandedGap > 8 && expandedGap < 140, `fixture should pause inside the tail area (${expandedGap}px below)`);

  // Streamed growth alone must not re-arm following and snap to the bottom.
  await chunk();
  await chunk();
  assert(el.scrollTop <= pauseTop + 2, `streamed growth dragged the paused reader down (${pauseTop} -> ${el.scrollTop})`);
  assert(gap() > 40, `streamed growth snapped the paused reader to the bottom (${gap()}px below)`);

  // A slow upward drag with chunks landing between steps must make progress.
  const dragStart = el.scrollTop;
  fireTouch('touchstart', 420);
  for (let step = 1; step <= 8; step += 1) {
    fireTouch('touchmove', 420 + step * 5);
    el.scrollTop = Math.max(0, el.scrollTop - 5);
    await settle(40);
    if (step % 2 === 0) {
      await chunk();
    }
    assert(el.scrollTop <= dragStart + 2, `chunk ${step} pulled the dragging reader back down (${dragStart} -> ${el.scrollTop})`);
  }
  fireTouch('touchend', 460);
  await settle(300);
  assert(el.scrollTop <= pauseTop + 2, `slow upward scrolling was dragged back down (${pauseTop} -> ${el.scrollTop})`);

  // Returning to the tail still resumes following.
  await scrollToTail();
  await chunk();
  assert(gap() < 2, `returning to the tail did not resume following (${gap()}px below)`);
  return { passed: true, expandedGap, pauseTop, finalGap: gap() };
}});

// Scrolling inside a nested transcript scroller (expanded tool result, code
// block, diagram) is not a transcript reading gesture. The scroll-event
// handler already ignores those events, but the wheel/touch intent handlers
// paused tail-following anyway, so the next streamed chunk landed off screen
// until the jump button was clicked.
Object.assign(window, { runNestedScrollerChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-11T00:00:00Z';
  const line = '这是一段用于测试嵌套滚动区域的中文内容，带 English words 和标点。';
  const history: any[] = [];
  for (let i = 0; i < 20; i += 1) {
    history.push({ seq: i * 2 + 1, role: 'user', content: `问题 ${i}\n${line.repeat(2)}`, timestamp: stamp });
    history.push({ seq: i * 2 + 2, role: 'agent', content: `回答 ${i}\n\n${line.repeat(5)}`, timestamp: stamp });
  }
  const user = { seq: 41, role: 'user', content: '请继续', timestamp: stamp };
  const base = [...history, user];
  let content = line.repeat(6);
  const render = () => (window as any).check.replaceSession({
    key: 'nested-scroller',
    pending: true,
    exchanges: [...base, { role: 'agent', content, timestamp: stamp }],
    exchange_aux: {},
  });
  render();
  await settle(700);
  const el = [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto') as HTMLElement;
  const gap = () => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  const jumpButton = () => document.querySelector('[data-mindfs-jump-latest="1"]') as HTMLElement | null;
  const appendChunk = async () => {
    content += '\n\n' + line.repeat(2);
    render();
    await settle(250);
  };
  const scrollToTail = async () => {
    el.scrollTop = el.scrollHeight;
    await settle(300);
    el.scrollTop = el.scrollHeight;
    await settle(300);
  };
  const fireTouch = (node: EventTarget, type: string, clientY: number) =>
    node.dispatchEvent(new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: node as EventTarget, clientY })],
    }));
  await scrollToTail();
  assert(gap() < 2, 'fixture should start at the tail');

  // Inject a tall vertical scroller inside the last message row.
  const row = [...el.querySelectorAll('[data-session-seq]')].pop() as HTMLElement;
  assert(!!row, 'missing last transcript row');
  const nested = document.createElement('div');
  nested.setAttribute('data-nested-scroller', '1');
  nested.style.cssText = 'height:120px;overflow-y:auto;border:1px solid transparent';
  nested.innerHTML = '<div style="height:600px">nested content</div>';
  row.appendChild(nested);
  await settle(350);
  await scrollToTail();
  nested.scrollTop = 200;

  // Wheel inside the nested scroller must not pause the transcript.
  nested.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -50 }));
  await settle(120);
  nested.scrollTop = 200;
  await appendChunk();
  assert(gap() < 2, `wheel inside a nested scroller paused following (${gap()}px below)`);
  assert(!jumpButton(), 'wheel inside a nested scroller surfaced the jump button');

  // Same for a finger drag inside the nested scroller.
  fireTouch(nested, 'touchstart', 300);
  fireTouch(nested, 'touchmove', 340);
  fireTouch(nested, 'touchend', 340);
  await appendChunk();
  assert(gap() < 2, `touch drag inside a nested scroller paused following (${gap()}px below)`);

  // A wheel on the transcript itself is still a reading gesture.
  nested.remove();
  await settle(150);
  el.scrollTop = el.scrollHeight;
  await settle(200);
  el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
  el.scrollTop = Math.max(0, el.scrollTop - 250);
  await settle(300);
  await appendChunk();
  assert(gap() > 40, 'scrolling the transcript should still pause following');
  const jump = jumpButton();
  assert(!!jump, 'pausing following should surface the jump button');
  jump!.click();
  await settle(200);
  await appendChunk();
  assert(gap() < 2, 'the jump button should resume following');
  return { passed: true, finalGap: gap() };
}});

// The composer growing (multi-line draft) and the iOS keyboard both resize
// the transcript without changing its content. While the reader follows the
// tail, the scroll position must stay pinned instead of leaving the newest
// lines hidden below the new viewport until the next streamed chunk.
Object.assign(window, { runScrollerResizeChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-11T00:00:00Z';
  const line = '这是一段用于测试容器尺寸变化的中文内容，带 English words 和标点。';
  const exchanges: any[] = [];
  for (let i = 0; i < 20; i += 1) {
    exchanges.push({ seq: i * 2 + 1, role: 'user', content: `问题 ${i}\n${line.repeat(2)}`, timestamp: stamp });
    exchanges.push({ seq: i * 2 + 2, role: 'agent', content: `回答 ${i}\n\n${line.repeat(5)}`, timestamp: stamp });
  }
  (window as any).check.replaceSession({ key: 'scroller-resize', exchanges, exchange_aux: {} });
  await settle(700);
  const el = [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto') as HTMLElement;
  const shell = document.querySelector('#root > div') as HTMLElement;
  assert(!!shell, 'missing harness shell');
  const gap = () => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  const check = async (height: string, label: string) => {
    shell.style.height = height;
    await settle(350);
    assert(gap() < 2, `${label}: tail was not re-anchored (${gap()}px below)`);
  };
  assert(!el.querySelector('[data-index]'), 'resize check should use the non-virtualized timeline');
  el.scrollTop = el.scrollHeight;
  await settle(300);
  el.scrollTop = el.scrollHeight;
  await settle(300);
  assert(gap() < 2, 'fixture should start at the tail');
  await check('55vh', 'transcript shrunk');
  await check('100vh', 'transcript grown');
  await check('60vh', 'transcript shrunk again');
  shell.style.height = '100vh';
  await settle(250);
  return { passed: true, finalGap: gap() };
}});

// Long markdown tokens without spaces (inline code identifiers, URLs) used to
// run past the message column and get clipped at the phone's right edge.
// They must wrap in place, while fenced code blocks keep their own horizontal
// scroller.
Object.assign(window, { runMarkdownOverflowChecks: async () => {
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const content = [
    '如果想让子会话显示 token,最小改动是：在',
    '',
    '`handleTaskProgressMessage`/`handleTaskNotification`',
    '把 `msg.Usage` 塞进 `ToolCall.Meta`,并在',
    '`attachBackgroundSessionUpdates.finish()` 里用',
    '`WithExchangeTokenUsage` 持久化——claude 路径可行；ACP 路径没有数据源，做不了。',
    '',
    'https://example.com/' + 'segment/'.repeat(40),
    '',
    '```ts',
    'const veryLongIdentifier = "' + 'x'.repeat(260) + '";',
    '```',
  ].join('\n');
  (window as any).check.replaceSession({
    key: 'markdown-overflow',
    exchanges: [{ seq: 1, role: 'agent', content, timestamp: '2026-11-12T00:00:00Z' }],
    exchange_aux: {},
  });
  await settle(400);
  const viewer = document.querySelector('[data-session-seq="1"] .markdown-viewer') as HTMLElement | null;
  assert(!!viewer, 'missing markdown viewer');
  let scroller: HTMLElement | null = null;
  for (let node = viewer.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === 'auto') { scroller = node; break; }
  }
  assert(!!scroller, 'missing transcript scroller');
  const limit = scroller.getBoundingClientRect().right;
  const offenders = [...viewer.querySelectorAll('p, p code, p a')]
    .filter((node) => node.getBoundingClientRect().right > limit + 0.5)
    .map((node) => `${node.tagName.toLowerCase()}: ${(node.textContent || '').slice(0, 32)}`);
  const overflowX = Math.round(scroller.scrollWidth - scroller.clientWidth);
  const pre = viewer.querySelector('pre') as HTMLElement | null;
  assert(!!pre, 'missing fenced code block');
  return {
    passed: offenders.length === 0 && overflowX <= 1,
    overflowX,
    offenders,
    codeBlockScrolls: pre.scrollWidth > pre.clientWidth,
  };
}});
