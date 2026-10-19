// 描画エリアの押下ジェスチャーの見分け（クリック／ロングタップ／ドラッグ＝パン。2026-10-19）。
// 純判定 holdGesture.js の単体テストと、本番配線（usePointerInteraction.js の仕上げ・天伏・敷地の分岐）の
// ソース走査不変条件（team-lessons「テストはヘルパーではなく本番の呼び出し経路を守る」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TAP_MOVE_PX, isTapDistance, releaseGesture, ceilingHoldAction } from './holdGesture.js';

const readSrc = rel => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');

// 行コメントを落とし、1つの分岐（開始文字列から最初の `return;\n    }` まで）を切り出す
function stripComments(src) { return src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'); }
function branch(src, start) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `分岐が見つからない: ${start}`);
  const end = src.indexOf('\n      return;\n    }', i);
  assert.ok(end > i, `分岐の終わりが見つからない: ${start}`);
  return src.slice(i, end);
}

test('isTapDistance: 8px 未満だけタップ。8 以上・NaN・undefined は動いた側', () => {
  assert.equal(TAP_MOVE_PX, 8);
  assert.equal(isTapDistance(0), true);
  assert.equal(isTapDistance(7.9), true);
  assert.equal(isTapDistance(8), false);
  assert.equal(isTapDistance(100), false);
});

test('【失敗系】isTapDistance: 座標欠落（NaN・undefined・null）はタップにしない', () => {
  assert.equal(isTapDistance(NaN), false);
  assert.equal(isTapDistance(undefined), false);
  assert.equal(isTapDistance(null), false);
  assert.equal(isTapDistance(Infinity), false);
});

test('releaseGesture: 長押し成立が最優先 → パン → クリック', () => {
  assert.equal(releaseGesture({ fired: true,  panned: false }), 'hold');
  assert.equal(releaseGesture({ fired: true,  panned: true  }), 'hold');
  assert.equal(releaseGesture({ fired: false, panned: true  }), 'pan');
  assert.equal(releaseGesture({ fired: false, panned: false }), 'tap');
});

test('【失敗系】releaseGesture: 省略・undefined はクリック扱い（偽値）', () => {
  assert.equal(releaseGesture({}), 'tap');
  assert.equal(releaseGesture({ fired: undefined, panned: null }), 'tap');
});

test('ceilingHoldAction: 空（EMPTY）× intent create だけなぞり。線上・端点・select・dragState なしはメニュー', () => {
  const E = 'empty';
  assert.equal(ceilingHoldAction({ menuContext: E, emptyContext: E, intent: 'create' }), 'trace');
  assert.equal(ceilingHoldAction({ menuContext: E, emptyContext: E, intent: 'select' }), 'menu');
  assert.equal(ceilingHoldAction({ menuContext: E, emptyContext: E, intent: undefined }), 'menu');
  assert.equal(ceilingHoldAction({ menuContext: 'center-line', emptyContext: E, intent: 'create' }), 'menu');
  assert.equal(ceilingHoldAction({ menuContext: 'center-line-endpoint', emptyContext: E, intent: 'create' }), 'menu');
});

test('【不変条件】usePointerInteraction: 仕上げ・天伏の pointerDown は startDrag せず、押下を記録して longPress.begin する（パンのつもりの押下で選択や副作用を起こさない）', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  assert.ok(/import \{[^}]*\bisTapDistance\b[^}]*\breleaseGesture\b[^}]*\bceilingHoldAction\b[^}]*\} from '\.\/holdGesture\.js'/.test(src), 'holdGesture.js を import していない');
  const downStart = src.indexOf('const handlePointerDown = (e) => {');
  const downEnd = src.indexOf('const handlePointerMove = (e) => {');
  const down = src.slice(downStart, downEnd);
  const finish = branch(down, "if (appMode === 'finish') {");
  assert.match(finish, /^\s*finishDragDownRef\.current = \{ x: clientX, y: clientY \};\s*$/m);
  assert.match(finish, /^\s*longPress\.begin\(clientX, clientY\);\s*$/m);
  assert.ok(!/startDrag\(/.test(finish), '仕上げの pointerDown で startDrag している');
  const ceiling = branch(down, "if (appMode === 'ceiling') {");
  assert.match(ceiling, /^\s*ceilingDragDownRef\.current = \{ x: clientX, y: clientY \};\s*$/m);
  assert.match(ceiling, /^\s*updateSnap\(clientX, clientY\);/m, '長押しメニューの対象は押下点で解決する');
  assert.match(ceiling, /^\s*longPress\.begin\(clientX, clientY\);\s*$/m);
  assert.ok(!/startDrag\(/.test(ceiling), '天伏の pointerDown で startDrag している');
  // 敷地: 描画エリアはサブモードによらず drag.current を立てる（配置サブモードでもパンできる）
  const site = branch(down, "if (appMode === 'site') {");
  assert.match(site, /^\s*if \(sm === 'sansha' \|\| sm === 'other'\) siteDrawDownRef\.current = \{ x: clientX, y: clientY \};\s*$/m);
  assert.match(site, /^\s*drag\.current = \{ lastX: clientX, lastY: clientY \};\s*$/m);
  assert.ok(!/if \(sm === 'sansha' \|\| sm === 'other'\) \{/.test(site), 'drag.current の設定がサブモードの条件の中にある');
});

test('【不変条件】usePointerInteraction: 仕上げ・天伏の pointerMove は、パン中はパン、dragState（ロングタップ後のなぞり）は updateDrag、成立前の 8px 超の移動（longPress.move）でパン開始', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const moveStart = src.indexOf('const handlePointerMove = (e) => {');
  const moveEnd = src.indexOf('function commitCLMove(');
  const move = src.slice(moveStart, moveEnd);
  for (const [label, start, ref] of [
    ['仕上げ', "if (appMode === 'finish') {", 'finishDragDownRef'],
    ['天伏',   "if (appMode === 'ceiling' && !modeRef.current?.moveState) {", 'ceilingDragDownRef'],
  ]) {
    const b = branch(move, start);
    assert.match(b, /^\s*if \(drag\.current\) \{ panTo\(clientX, clientY\); return; \}\s*$/m, `${label}: パン中はパン`);
    assert.match(b, new RegExp(`^\\s*if \\(!${ref}\\.current\\) return;\\s*$`, 'm'), `${label}: 押下の記録が無ければ何もしない`);
    assert.match(b, /^\s*modeRef\.current\?\.updateDrag\(/m, `${label}: なぞりの更新`);
    // 成立前の 8px 超の移動（longPress.move）でパン開始＝drag.current を立てて isPanning（QA F2: 本体まで固定する）
    // 積算は閾値分（TAP_MOVE_PX）から始める——押下点から既に 8px 超動いているので、9〜15px で離しても didPanEnd が真になる（QA N1）
    assert.match(b, /^\s*if \(longPress\.move\(clientX, clientY\)\) \{\s*\n\s*drag\.current = \{ lastX: clientX, lastY: clientY \};\s*\n\s*panDistRef\.current = TAP_MOVE_PX;.*\n\s*setIsPanning\(true\);\s*\n\s*\}/m, `${label}: 移動でパン開始（drag.current・panDistRef=TAP_MOVE_PX・setIsPanning）`);
    assert.ok(!/hasFired\(\)/.test(b), `${label}: 成立後の移動もパンにする（hasFired のガードを置かない。QA F4）`);
    assert.ok(b.indexOf('panTo(clientX, clientY)') < b.indexOf('updateDrag(') && b.indexOf('updateDrag(') < b.indexOf('longPress.move('), `${label}: 順序はパン→なぞり→パン開始`);
  }
});

test('【不変条件】usePointerInteraction: パンは panTo に一本化（移動量を panDistRef に積む）、pointerDown で 0 に戻し、pointerUp で TAP_MOVE_PX 以上なら didPanEnd が真。SceneLayers の階段・敷地線の click はそれを見て無視する', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const panTo = src.slice(src.indexOf('function panTo(clientX, clientY) {'), src.indexOf('const handlePointerDown = (e) => {'));
  assert.match(panTo, /^\s*panDistRef\.current \+= Math\.hypot\(dx, dy\);\s*$/m);
  assert.match(panTo, /^\s*viewport\.pan\(dx, dy\);\s*$/m);
  // ポインタ由来の viewport.pan は panTo の1箇所だけ（ピンチの viewport.pan(midX - …) は別）
  assert.equal((src.match(/viewport\.pan\(dx, dy\)/g) ?? []).length, 1, 'viewport.pan(dx, dy) が panTo の外にある');
  assert.equal((src.match(/panTo\(clientX, clientY\);/g) ?? []).length, 4, '仕上げ・天伏・敷地・汎用の4経路が panTo を使う（呼び出しの4箇所。定義は除く）');
  // 平面・建具・構造の汎用経路（longPress.move → shouldPan）も積算を閾値分から始める（QA N1）
  assert.match(src, /^\s*if \(shouldPan\) \{\s*\n\s*drag\.current = \{ lastX: clientX, lastY: clientY \};\s*\n\s*panDistRef\.current = TAP_MOVE_PX;\s*\n\s*setIsPanning\(true\);\s*\n\s*return;/m, '汎用経路のパン開始で panDistRef を TAP_MOVE_PX にしていない');
  const down = src.slice(src.indexOf('const handlePointerDown = (e) => {'), src.indexOf('const handlePointerMove = (e) => {'));
  assert.match(down, /^\s*panDistRef\.current = 0;\s*$/m);
  assert.match(down, /^\s*panEndedRef\.current = false;\s*$/m);
  const up = src.slice(src.indexOf('const handlePointerUp = (e) => {'), src.indexOf('const handlePointerLeave = () => {'));
  assert.ok(up.indexOf('panEndedRef.current = !!drag.current && panDistRef.current >= TAP_MOVE_PX;') < up.indexOf("if (appMode === 'elevation') {"), 'pointerUp の先頭（モード分岐の前）でパンの終了を決める');
  assert.match(src, /^\s*function didPanEnd\(\) \{ return panEndedRef\.current; \}\s*$/m);
  assert.match(src, /^\s*resetGestureRefs, didOpeningDragEnd, didPanEnd,\s*$/m, 'didPanEnd を返していない');
  const scene = readSrc('../renderer/SceneLayers.jsx');
  assert.match(scene, /^\s*onSelectStair=\{appMode === 'finish' \? \(id => \{ if \(!didPanEnd\?\.\(\)\) modeRef\.current\?\.selectStair\(id\); \}\) : null\}\s*$/m, '仕上げの階段の click がパンの終了を見ていない');
  assert.match(scene, /^\s*onSelectLine=\{id => \{ if \(!didPanEnd\?\.\(\)\) modeRef\.current\?\.selectLine\(id\); \}\}\s*$/m, '敷地線の click がパンの終了を見ていない');
  const app = readSrc('../App.jsx');
  assert.match(app, /^\s*resetGestureRefs, didOpeningDragEnd, didPanEnd,\s*$/m, 'App.jsx が didPanEnd を受けていない');
  assert.match(app, /^\s*didPanEnd=\{didPanEnd\}\s*$/m, 'App.jsx が SceneLayers へ didPanEnd を渡していない');
});

test('【不変条件】usePointerInteraction: 仕上げ・天伏の pointerUp は releaseGesture で見分け、hold はなぞりの確定（tap は isTapDistance）、tap は押下点で startDrag→commitDrag({ tap: true })', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const upStart = src.indexOf('const handlePointerUp = (e) => {');
  const upEnd = src.indexOf('const handlePointerLeave = () => {');
  const up = src.slice(upStart, upEnd);
  const finish = branch(up, "if (appMode === 'finish') {");
  assert.match(finish, /^\s*const gesture = releaseGesture\(\{ fired: longPress\.hasFired\(\), panned: !!drag\.current \}\);\s*$/m);
  assert.match(finish, /^\s*if \(modeRef\.current\?\.dragState\) modeRef\.current\.commitDrag\(\{ tap: isTapDistance\(tapDist\) \}\);\s*$/m);
  assert.match(finish, /^\s*const world = viewport\.screenToWorld\(down\.x, down\.y\);\s*$/m, 'クリックは押下点のセル');
  assert.match(finish, /^\s*modeRef\.current\?\.startDrag\(world\.x, world\.y\);\s*$/m);
  assert.match(finish, /^\s*if \(modeRef\.current\?\.dragState\) modeRef\.current\.commitDrag\(\{ tap: true \}\);\s*$/m);
  const ceiling = branch(up, "if (appMode === 'ceiling' && !modeRef.current?.moveState) {");
  assert.match(ceiling, /^\s*const gesture = releaseGesture\(\{ fired: longPress\.hasFired\(\), panned: !!drag\.current \}\);\s*$/m);
  assert.match(ceiling, /^\s*if \(modeRef\.current\?\.dragState\) modeRef\.current\.commitDrag\(\{ tap: isTapDistance\(tapDist\), ctx: \{ graph, project \} \}\);\s*$/m);
  assert.match(ceiling, /^\s*modeRef\.current\?\.startDrag\(graph, world\.x, world\.y\);\s*$/m);
  assert.match(ceiling, /^\s*modeRef\.current\?\.commitDrag\(\{ tap: true, ctx: \{ graph, project \} \}\);\s*$/m, '天伏のクリックは dragState が無くても commitDrag（空白のタップで選択解除）');
});

test('【不変条件】usePointerInteraction: longPress.onFire は仕上げでは押下点から startDrag（メニューなし）、天伏では EMPTY のときだけ startDrag して ceilingHoldAction が trace なら戻り、menu なら cancelDrag して記録を捨てる', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const start = src.indexOf('const longPress = useLongPress({');
  const fire = src.slice(start, src.indexOf('onCancel: () => setPressPos(null),', start));
  const finish = fire.slice(fire.indexOf("if (appMode === 'finish') {"), fire.indexOf('const snap         = snapRef.current;'));
  assert.match(finish, /^\s*if \(!finishDragDownRef\.current\) return;\s*$/m);
  assert.match(finish, /^\s*const world = viewport\.screenToWorld\(sx, sy\);\s*$/m);
  assert.match(finish, /^\s*modeRef\.current\?\.startDrag\(world\.x, world\.y\);\s*$/m);
  assert.match(finish, /^\s*return;\s*$/m);
  const ceiling = fire.slice(fire.indexOf("if (appMode === 'ceiling') {"), fire.indexOf('const state = buildMenuState('));
  assert.ok(fire.indexOf('const menuContext = detectContext(') < fire.indexOf("if (appMode === 'ceiling') {"), 'menuContext の判定が天伏の分岐より前にある');
  assert.match(ceiling, /^\s*if \(!ceilingDragDownRef\.current\) return;\s*$/m);
  assert.match(ceiling, /^\s*if \(menuContext === CONTEXT\.EMPTY\) modeRef\.current\?\.startDrag\(graph, world\.x, world\.y\);\s*$/m);
  assert.match(ceiling, /^\s*const action = ceilingHoldAction\(\{ menuContext, emptyContext: CONTEXT\.EMPTY, intent: modeRef\.current\?\.dragState\?\.intent \}\);\s*$/m);
  assert.match(ceiling, /^\s*if \(action === 'trace'\) return;\s*$/m);
  assert.match(ceiling, /^\s*modeRef\.current\?\.cancelDrag\(\);\s*$/m);
  assert.match(ceiling, /^\s*ceilingDragDownRef\.current = null;\s*$/m);
});

test('【不変条件】usePointerInteraction: 仕上げの pointerLeave は longPress.abort する（キャンバス外で長押しのタイマーを残さない）', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const start = src.indexOf('const handlePointerLeave = () => {');
  const leave = src.slice(start, src.indexOf('const handleTouchStart = (e) => {', start));
  const finish = branch(leave, "if (appMode === 'finish') {");
  assert.match(finish, /^\s*modeRef\.current\?\.cancelDrag\(\);\s*$/m);
  assert.match(finish, /^\s*longPress\.abort\(\);\s*$/m);
});
