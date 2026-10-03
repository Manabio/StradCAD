import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GUARD_STATE_KEY, detectBackGuardPlatform, createBackGuard } from './backGuard.js';
import { readAppSrc, stripCommentLines } from './uiBusySourceScan.js';

function makeWin() {
  const listeners = [];
  const removed = [];
  const win = {
    listeners, removed,
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn, capture) {
      removed.push({ type, fn, capture });
      const i = listeners.findIndex(l => l.type === type && l.fn === fn && l.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire(type) { for (const l of [...listeners]) if (l.type === type) l.fn({ type }); },
  };
  return win;
}

// エントリ列を模す。popstate は back()/forward() の結果として win へ発火する。
function makeHistory(win, { initialState = null, canForward = true } = {}) {
  const h = {
    entries: [initialState], idx: 0, pushCalls: 0, forwardCalls: 0, throwOnPush: false,
    get state() { return h.entries[h.idx]; },
    pushState(state) {
      h.pushCalls++;
      if (h.throwOnPush) throw new Error('push boom');
      h.entries.splice(h.idx + 1);
      h.entries.push(state);
      h.idx++;
    },
    forward() {
      h.forwardCalls++;
      if (canForward && h.idx < h.entries.length - 1) { h.idx++; win.fire('popstate'); }
    },
    back() { if (h.idx > 0) { h.idx--; win.fire('popstate'); } },
  };
  return h;
}

function makeCloseWatcherCtor() {
  const Ctor = function () {
    Ctor.created.push(this);
    this.handlers = [];
    this.destroyed = false;
    if (Ctor.throwOnNew) throw new Error('cw boom');
  };
  Ctor.created = [];
  Ctor.throwOnNew = false;
  Ctor.prototype.addEventListener = function (type, fn) { this.handlers.push({ type, fn }); };
  Ctor.prototype.destroy = function () { this.destroyed = true; };
  Ctor.prototype.fireClose = function () {
    for (const h of this.handlers) if (h.type === 'close') h.fn({ type: 'close' });
  };
  return Ctor;
}

function setup({ platform = 'android', withCW = true, historyOpts } = {}) {
  const win = makeWin();
  const history = makeHistory(win, historyOpts);
  const CloseWatcherCtor = withCW ? makeCloseWatcherCtor() : undefined;
  const guard = createBackGuard({ win, history, platform, CloseWatcherCtor });
  return { win, history, CloseWatcherCtor, guard };
}

function captureErrors() {
  const orig = console.error;
  const calls = [];
  console.error = (...a) => { calls.push(a); };
  return { calls, restore() { console.error = orig; } };
}

// ---- 判定表 ----
test('detectBackGuardPlatform: 判定表', () => {
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';
  const cases = [
    [{ userAgent: ANDROID_UA, maxTouchPoints: 5 }, 'android'],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', uaDataPlatform: 'Android', maxTouchPoints: 5 }, 'android'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5 }, 'ios'],
    [{ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', maxTouchPoints: 5 }, 'ios'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }, 'ios'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }, null],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 10 }, null],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 1 }, null],
    [{ userAgent: 'Mozilla/5.0 (iPod; CPU OS 12_0 like Mac OS X)', maxTouchPoints: 0 }, 'ios'],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', maxTouchPoints: 5 }, 'android'],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', maxTouchPoints: 0 }, null],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', maxTouchPoints: 1 }, null],
    [{ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36', maxTouchPoints: 5 }, null],
    [{ userAgent: '', maxTouchPoints: 0 }, null],
    [{ userAgent: undefined, uaDataPlatform: undefined, maxTouchPoints: undefined }, null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(detectBackGuardPlatform(input), expected, JSON.stringify(input));
  }
});

// ---- L2 ----
test('L2: start 直後は積まず、最初の pointerup で1回、2回目の操作では増えない', () => {
  const { win, history, guard } = setup({ platform: 'ios', withCW: false });
  guard.start();
  assert.equal(history.pushCalls, 0);
  win.fire('pointerup');
  assert.equal(history.pushCalls, 1);
  assert.equal(history.state[GUARD_STATE_KEY], true);
  win.fire('pointerup');
  win.fire('keydown');
  assert.equal(history.pushCalls, 1);
});

test('登録: ジェスチャー3種は capture=true、popstate は false', () => {
  const { win, guard } = setup({ platform: 'ios', withCW: false });
  guard.start();
  for (const type of ['pointerup', 'touchend', 'keydown']) {
    const l = win.listeners.filter(x => x.type === type);
    assert.equal(l.length, 1, type);
    assert.equal(l[0].capture, true, type);
  }
  const p = win.listeners.filter(x => x.type === 'popstate');
  assert.equal(p.length, 1);
  assert.equal(p[0].capture, false);
});

test('start を dispose なしで2回呼んでも登録は4件・CloseWatcher は1個', () => {
  const { win, CloseWatcherCtor, guard } = setup();
  guard.start();
  guard.start();
  assert.equal(win.listeners.length, 4);
  assert.equal(CloseWatcherCtor.created.length, 1);
});

test('hasGuard は厳密: state が { KEY: "yes" } や文字列でも最初の pointerup で1回積む', () => {
  for (const initialState of [{ [GUARD_STATE_KEY]: 'yes' }, 'x']) {
    const { win, history, guard } = setup({ platform: 'ios', withCW: false, historyOpts: { initialState } });
    guard.start();
    win.fire('pointerup');
    assert.equal(history.pushCalls, 1, JSON.stringify(initialState));
  }
});

test('L2: touchend・keydown でも番兵を積める', () => {
  for (const type of ['touchend', 'keydown']) {
    const { win, history, guard } = setup({ platform: 'ios', withCW: false });
    guard.start();
    win.fire(type);
    assert.equal(history.pushCalls, 1, type);
  }
});

test('L2: 番兵のある history.state で start（reload の模擬）→ 操作しても積まない', () => {
  const { win, history, guard } = setup({ historyOpts: { initialState: { [GUARD_STATE_KEY]: true } } });
  guard.start();
  win.fire('pointerup');
  win.fire('touchend');
  assert.equal(history.pushCalls, 0);
});

test('L2: popstate で番兵なしのエントリへ → pushState 0回・forward 1回、結果の popstate では何も呼ばれない', () => {
  const { win, history, guard } = setup({ platform: 'ios', withCW: false });
  guard.start();
  win.fire('pointerup');
  assert.equal(history.pushCalls, 1);
  history.back(); // 番兵なしのエントリへ降りる → forward → 番兵へ戻る（popstate 再入）
  assert.equal(history.pushCalls, 1, 'popstate 中に pushState していない');
  assert.equal(history.forwardCalls, 1);
  assert.equal(history.idx, 1);
  assert.equal(history.state[GUARD_STATE_KEY], true);
});

test('L2: forward が効かない（前方なし）→ 次のユーザー操作で積み直す', () => {
  const { win, history, guard } = setup({ platform: 'ios', withCW: false, historyOpts: { canForward: false } });
  guard.start();
  win.fire('pointerup');
  history.back();
  assert.equal(history.forwardCalls, 1);
  assert.equal(history.state, null);
  assert.equal(history.pushCalls, 1);
  win.fire('pointerup');
  assert.equal(history.pushCalls, 2);
  assert.equal(history.state[GUARD_STATE_KEY], true);
});

// ---- L1 ----
test('L1: android で CloseWatcher が1個作られ、close のたびに作り直される', () => {
  const { CloseWatcherCtor, guard } = setup();
  guard.start();
  assert.equal(CloseWatcherCtor.created.length, 1);
  CloseWatcherCtor.created[0].fireClose();
  assert.equal(CloseWatcherCtor.created.length, 2);
  CloseWatcherCtor.created[1].fireClose();
  assert.equal(CloseWatcherCtor.created.length, 3);
});

test('L1: ios では作られない／CloseWatcherCtor が undefined でも例外なし', () => {
  const ios = setup({ platform: 'ios' });
  ios.guard.start();
  assert.equal(ios.CloseWatcherCtor.created.length, 0);
  const none = setup({ withCW: false });
  const cap = captureErrors();
  try {
    assert.doesNotThrow(() => none.guard.start());
    assert.equal(cap.calls.length, 0);
  } finally { cap.restore(); }
  none.win.fire('pointerup');
  assert.equal(none.history.pushCalls, 1);
});

// ---- 失敗系 ----
test('失敗系: pushState が throw → console.error・以後再試行せず、L1 の作り直しは生きている', () => {
  const { win, history, CloseWatcherCtor, guard } = setup();
  const cap = captureErrors();
  try {
    history.throwOnPush = true;
    guard.start();
    assert.doesNotThrow(() => win.fire('pointerup'));
    assert.equal(history.pushCalls, 1);
    assert.equal(cap.calls.length, 1);
    win.fire('pointerup');
    win.fire('keydown');
    assert.equal(history.pushCalls, 1, '再試行しない');
    CloseWatcherCtor.created[0].fireClose();
    assert.equal(CloseWatcherCtor.created.length, 2);
  } finally { cap.restore(); }
});

test('失敗系: forward が throw → console.error・L2 だけ止まる', () => {
  const { win, history, guard } = setup({ platform: 'ios', withCW: false });
  const cap = captureErrors();
  try {
    guard.start();
    win.fire('pointerup');
    history.forward = () => { history.forwardCalls++; throw new Error('fwd boom'); };
    assert.doesNotThrow(() => history.back());
    assert.equal(history.forwardCalls, 1);
    assert.equal(cap.calls.length, 1);
    win.fire('pointerup');
    assert.equal(history.pushCalls, 1, '止まった後は積まない');
  } finally { cap.restore(); }
});

test('失敗系: CloseWatcher のコンストラクタが throw → console.error・L2 は動く', () => {
  const { win, history, CloseWatcherCtor, guard } = setup();
  const cap = captureErrors();
  try {
    CloseWatcherCtor.throwOnNew = true;
    assert.doesNotThrow(() => guard.start());
    assert.equal(CloseWatcherCtor.created.length, 1);
    assert.equal(cap.calls.length, 1);
    win.fire('pointerup');
    assert.equal(history.pushCalls, 1);
  } finally { cap.restore(); }
});

test('platform null → リスナー登録0件・CloseWatcher 生成0件・操作しても何も起きない', () => {
  const { win, history, CloseWatcherCtor, guard } = setup({ platform: null });
  guard.start();
  assert.equal(win.listeners.length, 0);
  assert.equal(CloseWatcherCtor.created.length, 0);
  win.fire('pointerup');
  assert.equal(history.pushCalls, 0);
});

// ---- dispose ----
test('dispose: 登録と同数・同引数で remove され、watcher が destroy される', () => {
  const { win, CloseWatcherCtor, guard } = setup();
  guard.start();
  const added = [...win.listeners];
  assert.equal(added.length, 4);
  guard.dispose();
  assert.equal(win.removed.length, added.length);
  for (const a of added) {
    assert.ok(win.removed.some(r => r.type === a.type && r.fn === a.fn && r.capture === a.capture),
      `${a.type} が同じ引数で外れていない`);
  }
  assert.equal(win.listeners.length, 0);
  assert.equal(CloseWatcherCtor.created[0].destroyed, true);
});

test('dispose 後の close・イベントでは何も起きない', () => {
  const { win, history, CloseWatcherCtor, guard } = setup();
  guard.start();
  const w = CloseWatcherCtor.created[0];
  guard.dispose();
  w.fireClose();
  assert.equal(CloseWatcherCtor.created.length, 1);
  win.fire('pointerup');
  win.fire('popstate');
  assert.equal(history.pushCalls, 0);
  assert.equal(history.forwardCalls, 0);
});

test('start → dispose → start → 操作で pushState は1回（StrictMode 二重実行）', () => {
  const { win, history, CloseWatcherCtor, guard } = setup();
  guard.start();
  guard.dispose();
  guard.start();
  assert.equal(win.listeners.length, 4);
  assert.equal(CloseWatcherCtor.created.length, 2);
  win.fire('pointerup');
  win.fire('pointerup');
  assert.equal(history.pushCalls, 1);
});

// ---- 配線 ----
test('配線: App.jsx が createBackGuard を呼び start()／dispose() している', () => {
  const body = stripCommentLines(readAppSrc());
  assert.ok(/^\s*import \{ createBackGuard, detectBackGuardPlatform \} from '\.\/backGuard\.js';$/m.test(body),
    'backGuard.js の import が見つからない');
  assert.ok(/^\s*const guard = createBackGuard\(\{$/m.test(body), 'createBackGuard( の呼び出しが見つからない');
  assert.ok(/^\s*win: window, history: window\.history, platform, CloseWatcherCtor: window\.CloseWatcher,$/m.test(body),
    'createBackGuard の引数が見つからない');
  assert.ok(/^\s*guard\.start\(\);$/m.test(body), 'guard.start(); が見つからない');
  assert.ok(/^\s*return \(\) => guard\.dispose\(\);$/m.test(body), 'guard.dispose() のクリーンアップが見つからない');
});

test('配線: クリーンアップの dispose 行と依存配列 }, []); が連続している', () => {
  const body = stripCommentLines(readAppSrc());
  assert.ok(/^\s*return \(\) => guard\.dispose\(\);\r?\n\s*\}, \[\]\);$/m.test(body),
    'guard.dispose() の直後が依存配列 [] になっていない');
});

test('配線: index.css の html, body, #root に overscroll-behavior: none がある', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, 'index.css'), 'utf8');
  const block = css.match(/^html, body, #root \{[\s\S]*?^\}/m);
  assert.ok(block, 'html, body, #root ルールが見つからない');
  assert.ok(/^\s*overscroll-behavior: none;(\s*\/\*[^*]*\*\/)?\s*$/m.test(block[0]), 'overscroll-behavior: none; が無い');
});
