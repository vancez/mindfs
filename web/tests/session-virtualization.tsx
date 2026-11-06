import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionViewer } from '../src/components/SessionViewer';
import { I18nProvider } from '../src/i18n';
import { sessionService } from '../src/services/session';
let requests = 0;
sessionService.getToolCall = async (_root, _session, callId) => {
  requests++;
  return {callId, kind: 'read', title: callId, status: 'complete', content: [{type:'text',text:'REMOTE DETAIL '+callId+'\n'+('detail line\n'.repeat(80))}]};
};
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
