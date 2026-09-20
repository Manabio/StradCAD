// interaction/beamTap.js（構造モードの梁タップ。ステップ4第3単位①・QA指摘F4）の単体テスト。
//
// 8px移動閾値・500ms長押し判定そのもの（interaction/useLongPress.js）はReactフックのため
// node:testから直接呼べない（本リポジトリはreact-test-renderer等を持たず、フックを描画レンダーの
// 外から検証する手段が無い）。ここでは usePointerInteraction.js が useLongPress.hasFired()・
// drag.current から解決した信号（panned/longPressFired）を受け取った後の「成立条件」の純判定
// （shouldFireMemberTap）だけを検証する——panned/longPressFired 自体を作る8px・500msの閾値ロジックは
// CL移動・建具ドラッグ等の既存ジェスチャーと共有する未変更のプリミティブ（drag.current・
// useLongPress.js）に委ねている（ASSUMED: 既存の共有プリミティブの正しさに依存）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beamAtKonvaTarget, shouldFireMemberTap } from './beamTap.js';

function baseSignals(overrides = {}) {
  return {
    appMode: 'structure', onMemberClick: () => {}, menu: null,
    panned: false, longPressFired: false, busy: false,
    ...overrides,
  };
}

test('【F4】shouldFireMemberTap: パン開始後（panned=true。8px超移動でdrag.currentが立った状態）は呼ばれない', () => {
  assert.equal(shouldFireMemberTap(baseSignals({ panned: true })), false);
});

test('【F4】shouldFireMemberTap: 長押し成立後（longPressFired=true。メニュー表示の有無に関わらず）は呼ばれない', () => {
  assert.equal(shouldFireMemberTap(baseSignals({ longPressFired: true })), false);
  // メニューが実際には出ない（buildMenuStateがnullを返す）文脈でも、長押し自体は成立している。
  assert.equal(shouldFireMemberTap(baseSignals({ longPressFired: true, menu: null })), false);
});

test('【F4】shouldFireMemberTap: パン未開始・長押し未成立（閾値未満のtap）だけ呼ばれる', () => {
  assert.equal(shouldFireMemberTap(baseSignals()), true);
});

test('【失敗系】shouldFireMemberTap: 構造モード以外・onMemberClick未指定・メニュー表示中・他ジェスチャー進行中は呼ばれない', () => {
  assert.equal(shouldFireMemberTap(baseSignals({ appMode: 'floorplan' })), false, '構造モード以外');
  assert.equal(shouldFireMemberTap(baseSignals({ onMemberClick: null })), false, 'onMemberClick省略時（非在来相当）');
  assert.equal(shouldFireMemberTap(baseSignals({ menu: { pos: { x: 0, y: 0 }, items: [] } })), false, 'メニュー表示中');
  assert.equal(shouldFireMemberTap(baseSignals({ busy: true })), false, '他ジェスチャー（描画/移動モード）進行中');
});

// ---- beamAtKonvaTarget ----

function fakeGraph(beams) {
  return { beamMap: new Map(beams.map(b => [b.id, b])) };
}

test('beamAtKonvaTarget: ターゲット自身がbeamId属性を持てばgraph.beamMapから解決する', () => {
  const graph = fakeGraph([{ id: 'b1' }]);
  const target = { getAttr: k => (k === 'beamId' ? 'b1' : null) };
  assert.equal(beamAtKonvaTarget(target, graph), graph.beamMap.get('b1'));
});

test('beamAtKonvaTarget: ターゲット自身に無くても祖先の<Group name="beam-symbol">のbeamIdから解決する', () => {
  const graph = fakeGraph([{ id: 'b2' }]);
  const ancestor = { getAttr: k => (k === 'beamId' ? 'b2' : null) };
  const target = { getAttr: () => null, findAncestor: sel => (sel === '.beam-symbol' ? ancestor : null) };
  assert.equal(beamAtKonvaTarget(target, graph), graph.beamMap.get('b2'));
});

test('【失敗系】beamAtKonvaTarget: beamId属性が無い・祖先も無い・未知のid・target自体が無い/getAttrを持たない場合はnull', () => {
  const graph = fakeGraph([{ id: 'b1' }]);
  const noAttr = { getAttr: () => null, findAncestor: () => null };
  assert.equal(beamAtKonvaTarget(noAttr, graph), null, 'beamId属性・祖先とも無い');
  const unknown = { getAttr: k => (k === 'beamId' ? 'no-such-id' : null) };
  assert.equal(beamAtKonvaTarget(unknown, graph), null, '未知のid');
  assert.equal(beamAtKonvaTarget(null, graph), null, 'targetがnull');
  assert.equal(beamAtKonvaTarget({}, graph), null, 'targetがgetAttrを持たない（非Konvaオブジェクト）');
  assert.equal(beamAtKonvaTarget({ getAttr: k => (k === 'beamId' ? 'b1' : null) }, null), null, 'graphがnullでも例外を投げない');
});

// ---- 配線の不変条件（usePointerInteraction.js が実際にこの2関数を使っているか）----

test('【不変条件・QA指摘F4】usePointerInteraction.js: pointerUpがshouldFireMemberTapでゲートしbeamAtKonvaTargetで解決してからonMemberClickを呼ぶ', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'usePointerInteraction.js'), 'utf8');
  // 空白タップの選択解除（isBlankTapTarget。blankTapDeselect.test.js）など同じモジュールからの追加importを許す。
  assert.ok(/import\s*\{[^}]*\bbeamAtKonvaTarget\b[^}]*\bshouldFireMemberTap\b[^}]*\}\s*from\s*'\.\/beamTap\.js'/.test(src),
    'beamTap.js からの import が見つからない');
  const callMatch = /if\s*\(\s*shouldFireMemberTap\(\{([\s\S]*?)\}\)\)\s*\{/.exec(src);
  assert.ok(callMatch, 'shouldFireMemberTap({ ... }) でのゲートが見つからない');
  const args = callMatch[1];
  // QA指摘F13: panned・longPressFiredを固定値（false等）にすり替えても検出できるよう、
  // drag.current・longPress.hasFired()由来であることまでソース走査で固定する（busyも同様）。
  assert.ok(/panned:\s*!!drag\.current/.test(args),
    'panned: !!drag.current が渡されていない（8px超移動の信号がdrag.current由来でなくなる回帰）');
  assert.ok(/longPressFired:\s*longPress\.hasFired\(\)/.test(args),
    'longPressFired: longPress.hasFired() が渡されていない（長押し成立の信号が消える回帰）');
  assert.ok(/busy:\s*/.test(args), 'busy: ... が渡されていない（他ジェスチャー進行中の信号が消える回帰）');
  assert.ok(/const beam = beamAtKonvaTarget\(e\.target,\s*graph\)/.test(src),
    'beamAtKonvaTarget(e.target, graph) の呼び出しが見つからない');
  assert.ok(/if\s*\(\s*beam\s*\)\s*onMemberClick\(beam,\s*'beamMap'\)/.test(src),
    "onMemberClick(beam, 'beamMap') の呼び出しが見つからない");
});
