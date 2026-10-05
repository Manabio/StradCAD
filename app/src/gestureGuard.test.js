import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGestureGuard, shouldBlockContextMenu } from './gestureGuard.js';
import { readAppSrc, stripCommentLines } from './uiBusySourceScan.js';

function makeDoc({ throwOnAdd = null } = {}) {
  const listeners = [];
  const removed = [];
  const doc = {
    listeners, removed,
    addEventListener(type, fn, options) {
      if (throwOnAdd && throwOnAdd(type, options)) throw new Error('add boom');
      listeners.push({ type, fn, options });
    },
    removeEventListener(type, fn, options) {
      removed.push({ type, fn, options });
      const i = listeners.findIndex(l => l.type === type && l.fn === fn && !!l.options?.capture === !!options?.capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    // 発火して、呼ばれたリスナーの数を返す（空振りで緑にならないよう、呼び出し側が件数を assert する）
    fire(type, e) {
      let n = 0;
      for (const l of [...listeners]) if (l.type === type) { l.fn(e); n++; }
      return n;
    },
  };
  return doc;
}

function makeEvent(props = {}) {
  const e = { cancelable: true, prevented: 0, ...props };
  e.preventDefault = () => { e.prevented++; };
  return e;
}

function captureErrors() {
  const orig = console.error;
  const calls = [];
  console.error = (...a) => { calls.push(a); };
  return { calls, restore() { console.error = orig; } };
}

function setup(opts) {
  const doc = makeDoc(opts);
  const guard = createGestureGuard({ doc });
  guard.start();
  return { doc, guard };
}

const inEditable = { closest: sel => (/input/.test(sel) ? {} : null) };
const notEditable = { closest: () => null };

// ---- 止める／止めない ----
test('touchmove: 2本指は止める・3本指も止める・1本指と0本は止めない', () => {
  const { doc } = setup();
  const cases = [[2, 1], [3, 1], [1, 0], [0, 0]];
  assert.ok(cases.length > 0);
  for (const [n, expected] of cases) {
    const e = makeEvent({ touches: Array.from({ length: n }, () => ({})) });
    assert.equal(doc.fire('touchmove', e), 1);
    assert.equal(e.prevented, expected, `${n}本指`);
  }
});

test('touchmove: cancelable=false なら 2本指でも preventDefault を呼ばない', () => {
  const { doc } = setup();
  const e = makeEvent({ cancelable: false, touches: [{}, {}] });
  assert.equal(doc.fire('touchmove', e), 1);
  assert.equal(e.prevented, 0);
});

test('touchmove: stopPropagation を呼ばない（Konva 側のハンドラを妨げない）', () => {
  const { doc } = setup();
  let stopped = 0;
  const e = makeEvent({ touches: [{}, {}], stopPropagation() { stopped++; }, stopImmediatePropagation() { stopped++; } });
  assert.equal(doc.fire('touchmove', e), 1);
  assert.equal(e.prevented, 1);
  assert.equal(stopped, 0);
});

test('gesturestart / gesturechange / gestureend は止める（cancelable=false は止めない）', () => {
  const { doc } = setup();
  const types = ['gesturestart', 'gesturechange', 'gestureend'];
  assert.ok(types.length > 0);
  for (const type of types) {
    const e = makeEvent();
    assert.equal(doc.fire(type, e), 1, type);
    assert.equal(e.prevented, 1, type);
    const e2 = makeEvent({ cancelable: false });
    assert.equal(doc.fire(type, e2), 1, type);
    assert.equal(e2.prevented, 0, type);
  }
});

test('contextmenu: 由来と対象の判定表（イベントの pointerType）', () => {
  const cases = [
    [{ pointerType: 'touch', target: notEditable }, 1],
    [{ pointerType: 'pen', target: notEditable }, 1],
    [{ pointerType: 'mouse', target: notEditable }, 0],
    [{ target: notEditable }, 0], // 由来不明
    [{ pointerType: 'touch', target: inEditable }, 0], // 入力欄の内側
  ];
  for (const [props, expected] of cases) {
    const { doc } = setup();
    const e = makeEvent(props);
    assert.equal(doc.fire('contextmenu', e), 1);
    assert.equal(e.prevented, expected, JSON.stringify({ ...props, target: undefined }));
  }
});

test('contextmenu: イベントに pointerType が無ければ直近の pointerdown で判定する', () => {
  for (const [downType, expected] of [['touch', 1], ['pen', 1], ['mouse', 0]]) {
    const { doc } = setup();
    assert.equal(doc.fire('pointerdown', { pointerType: downType }), 1);
    const e = makeEvent({ target: notEditable });
    assert.equal(doc.fire('contextmenu', e), 1);
    assert.equal(e.prevented, expected, downType);
  }
});

test('contextmenu: イベントの pointerType が直近の pointerdown より優先される', () => {
  const { doc } = setup();
  doc.fire('pointerdown', { pointerType: 'touch' });
  const e = makeEvent({ pointerType: 'mouse', target: notEditable });
  assert.equal(doc.fire('contextmenu', e), 1);
  assert.equal(e.prevented, 0);
});

test('contextmenu: stopPropagation を呼ばない', () => {
  const { doc } = setup();
  let stopped = 0;
  const e = makeEvent({ pointerType: 'touch', target: notEditable, stopPropagation() { stopped++; } });
  assert.equal(doc.fire('contextmenu', e), 1);
  assert.equal(e.prevented, 1);
  assert.equal(stopped, 0);
});

test('shouldBlockContextMenu: 純関数の判定表', () => {
  const cases = [
    [{ eventPointerType: 'touch' }, true],
    [{ eventPointerType: 'pen' }, true],
    [{ eventPointerType: 'mouse' }, false],
    [{}, false],
    [undefined, false],
    [{ eventPointerType: '', lastPointerType: 'touch' }, true],
    [{ lastPointerType: 'touch' }, true],
    [{ lastPointerType: 'mouse' }, false],
    [{ eventPointerType: 'touch', targetEditable: true }, false],
    [{ lastPointerType: 'touch', targetEditable: true }, false],
    [{ eventPointerType: 'mouse', lastPointerType: 'touch' }, false],
  ];
  for (const [input, expected] of cases) {
    assert.equal(shouldBlockContextMenu(input), expected, JSON.stringify(input));
  }
});

// ---- 失敗系（機能の無いデバイスでも例外を出さない） ----
test('失敗系: doc が undefined / addEventListener が無い → start・dispose とも例外なし', () => {
  for (const doc of [undefined, null, {}, { addEventListener: 1 }]) {
    const guard = createGestureGuard({ doc });
    assert.doesNotThrow(() => guard.start());
    assert.doesNotThrow(() => guard.dispose());
  }
  assert.doesNotThrow(() => createGestureGuard());
  assert.doesNotThrow(() => createGestureGuard().start());
});

test('失敗系: addEventListener が throw → console.error・その層だけ止まり他は生きる', () => {
  const cap = captureErrors();
  try {
    const doc = makeDoc({ throwOnAdd: type => type === 'touchmove' });
    const guard = createGestureGuard({ doc });
    assert.doesNotThrow(() => guard.start());
    assert.equal(cap.calls.length, 1);
    assert.equal(doc.listeners.filter(l => l.type === 'touchmove').length, 0);
    const e = makeEvent();
    assert.equal(doc.fire('gesturestart', e), 1);
    assert.equal(e.prevented, 1);
    assert.doesNotThrow(() => guard.dispose());
    assert.equal(doc.listeners.length, 0);
  } finally { cap.restore(); }
});

test('失敗系: options オブジェクトを受けない古い実装（例外）でも start は例外を出さない', () => {
  const cap = captureErrors();
  try {
    const doc = makeDoc({ throwOnAdd: (type, options) => typeof options === 'object' });
    const guard = createGestureGuard({ doc });
    assert.doesNotThrow(() => guard.start());
    assert.ok(cap.calls.length > 0);
    assert.doesNotThrow(() => guard.dispose());
  } finally { cap.restore(); }
});

test('失敗系: removeEventListener が throw しても dispose は例外を出さない', () => {
  const cap = captureErrors();
  try {
    const doc = makeDoc();
    doc.removeEventListener = () => { throw new Error('rm boom'); };
    const guard = createGestureGuard({ doc });
    guard.start();
    assert.doesNotThrow(() => guard.dispose());
    assert.ok(cap.calls.length > 0);
  } finally { cap.restore(); }
});

test('失敗系: イベントに touches・cancelable・preventDefault・target が無い／closest を持たない', () => {
  const { doc } = setup();
  const bad = [undefined, null, {}, { touches: null }, { touches: [{}, {}] }, { touches: [{}, {}], cancelable: true }];
  for (const e of bad) {
    assert.doesNotThrow(() => doc.fire('touchmove', e), JSON.stringify(e));
    assert.doesNotThrow(() => doc.fire('gesturestart', e), JSON.stringify(e));
  }
  const ctxBad = [
    undefined, null, {},
    { pointerType: 'touch', target: null },
    { pointerType: 'touch', target: {} },
    { pointerType: 'touch', target: { closest() { throw new Error('closest boom'); } } },
    { pointerType: 'touch', cancelable: true, target: null },
    { pointerType: 'touch', target: { parentElement: notEditable } },
    { pointerType: 'touch', target: { parentElement: inEditable } },
  ];
  for (const e of ctxBad) {
    assert.doesNotThrow(() => doc.fire('contextmenu', e));
    assert.doesNotThrow(() => doc.fire('pointerdown', e));
  }
  // preventDefault が throw しても握る
  const cap = captureErrors();
  try {
    const e = { cancelable: true, touches: [{}, {}], preventDefault() { throw new Error('pd boom'); } };
    assert.doesNotThrow(() => doc.fire('touchmove', e));
    assert.equal(cap.calls.length, 1);
  } finally { cap.restore(); }
});

test('contextmenu: 対象がテキストノード相当（closest 無し・parentElement が入力欄）なら止めない', () => {
  const { doc } = setup();
  const e = makeEvent({ pointerType: 'touch', target: { parentElement: inEditable } });
  assert.equal(doc.fire('contextmenu', e), 1);
  assert.equal(e.prevented, 0);
});

// ---- 登録・解除 ----
test('登録: 種別・passive:false の指定', () => {
  const { doc } = setup();
  const types = doc.listeners.map(l => l.type).sort();
  assert.deepEqual(types, ['contextmenu', 'gestureend', 'gesturechange', 'gesturestart', 'pointerdown', 'touchmove'].sort());
  for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'touchmove', 'contextmenu']) {
    const l = doc.listeners.find(x => x.type === type);
    assert.equal(l.options.passive, false, type);
  }
  assert.equal(doc.listeners.find(x => x.type === 'pointerdown').options.capture, true);
});

test('登録: contextmenu は capture で登録する（子孫が stopPropagation しても届く）', () => {
  const { doc } = setup();
  assert.equal(doc.listeners.find(x => x.type === 'contextmenu').options.capture, true);
});

test('dispose → start で直近の pointerdown の由来を持ち越さない', () => {
  const { doc, guard } = setup();
  assert.equal(doc.fire('pointerdown', { pointerType: 'touch' }), 1);
  guard.dispose();
  guard.start();
  const e = makeEvent({ target: notEditable });
  assert.equal(doc.fire('contextmenu', e), 1);
  assert.equal(e.prevented, 0);
});

test('dispose: 登録したリスナーと解除したリスナーが型・関数・options まで一致する', () => {
  const { doc, guard } = setup();
  const added = [...doc.listeners];
  assert.equal(added.length, 6);
  guard.dispose();
  assert.equal(doc.removed.length, added.length);
  for (const a of added) {
    assert.ok(doc.removed.some(r => r.type === a.type && r.fn === a.fn && r.options === a.options),
      `${a.type} が同じ引数で外れていない`);
  }
  assert.equal(doc.listeners.length, 0);
});

test('dispose 後はイベントが来ても何もしない（リスナーも残らない）', () => {
  const { doc, guard } = setup();
  guard.dispose();
  const e = makeEvent({ touches: [{}, {}] });
  assert.equal(doc.fire('touchmove', e), 0);
  assert.equal(e.prevented, 0);
});

test('dispose 後に残ったリスナー参照を直接呼んでも何もしない', () => {
  const { doc, guard } = setup();
  const held = doc.listeners.map(l => l.fn);
  assert.ok(held.length > 0);
  guard.dispose();
  const e = makeEvent({ touches: [{}, {}], pointerType: 'touch', target: notEditable });
  for (const fn of held) fn(e);
  assert.equal(e.prevented, 0);
});

test('start → dispose → start でリスナーが二重にならない（StrictMode）', () => {
  const { doc, guard } = setup();
  guard.dispose();
  guard.start();
  assert.equal(doc.listeners.length, 6);
  const e = makeEvent({ touches: [{}, {}] });
  assert.equal(doc.fire('touchmove', e), 1);
  assert.equal(e.prevented, 1);
  guard.start(); // dispose なしの二重 start でも増えない
  assert.equal(doc.listeners.length, 6);
});

// ---- 配線 ----
test('配線: App.jsx が createGestureGuard を start()／dispose() している', () => {
  const body = stripCommentLines(readAppSrc());
  assert.ok(/^\s*import \{ createGestureGuard \} from '\.\/gestureGuard\.js';$/m.test(body), 'import が見つからない');
  assert.ok(/^\s*const gestureGuard = createGestureGuard\(\{ doc: document \}\);$/m.test(body), 'createGestureGuard の呼び出しが見つからない');
  assert.ok(/^\s*gestureGuard\.start\(\);$/m.test(body), 'gestureGuard.start(); が見つからない');
  assert.ok(/^\s*return \(\) => gestureGuard\.dispose\(\);\r?\n\s*\}, \[\]\);$/m.test(body),
    'dispose のクリーンアップと依存配列 [] が連続していない');
});

const css = () => fs.readFileSync(path.resolve(import.meta.dirname, 'index.css'), 'utf8');

test('配線: index.css の html, body, #root に touch-action: pan-x pan-y がある', () => {
  const block = css().match(/^html, body, #root \{[\s\S]*?^\}/m);
  assert.ok(block, 'html, body, #root ルールが見つからない');
  assert.ok(/^\s*touch-action: pan-x pan-y;(\s*\/\*[^*]*\*\/)?\s*$/m.test(block[0]), 'touch-action: pan-x pan-y; が無い');
});

test('配線: index.css の @media (any-pointer: coarse) に user-select 3行と入力欄の戻しがある', () => {
  const media = css().match(/^@media \(any-pointer: coarse\) \{[\s\S]*?^\}/m);
  assert.ok(media, '@media (any-pointer: coarse) ブロックが見つからない');
  const m = media[0];
  assert.ok(/^\s*html, body, #root \{\r?\n\s*-webkit-user-select: none;\r?\n\s*user-select: none;\r?\n\s*-webkit-touch-callout: none;\r?\n\s*\}$/m.test(m),
    'user-select / touch-callout の3行が無い');
  assert.ok(/^\s*input, textarea, \[contenteditable\] \{\r?\n\s*-webkit-user-select: text;\r?\n\s*user-select: text;\r?\n\s*\}$/m.test(m),
    '入力欄の user-select: text の戻しが無い');
  // media の外（無条件）に user-select: none を置いていない
  const outside = css().replace(media[0], '');
  assert.ok(!/user-select: none/.test(outside), 'media の外に user-select: none がある');
});

test('配線: index.html の viewport に maximum-scale=1.0, user-scalable=no がある', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
  assert.ok(/^\s*<meta name="viewport" content="width=device-width, initial-scale=1\.0, maximum-scale=1\.0, user-scalable=no" \/>$/m.test(html),
    'viewport の meta 行が見つからない');
});
