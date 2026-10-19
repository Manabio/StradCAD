// 描画エリアの押下ジェスチャーの見分け（クリック／ロングタップ／ドラッグ＝パン。2026-10-19）。
// 純判定 holdGesture.js の単体テストと、本番配線（usePointerInteraction.js の仕上げ・天伏・敷地の分岐）の
// ソース走査不変条件（team-lessons「テストはヘルパーではなく本番の呼び出し経路を守る」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  TAP_MOVE_PX, isTapDistance, releaseGesture, CEILING_PAN_PX, CEILING_DECIDE_MS, ceilingDragStart,
} from './holdGesture.js';

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

test('ceilingDragStart: なぞりができない点は即パン。できる点は CEILING_PAN_PX 超でパン、以下は判定窓（wait）', () => {
  assert.equal(CEILING_PAN_PX, 16);
  assert.equal(CEILING_DECIDE_MS, 80);
  assert.equal(ceilingDragStart({ canTrace: false, dist: 9 }), 'pan');
  assert.equal(ceilingDragStart({ canTrace: true,  dist: 9 }), 'wait');
  assert.equal(ceilingDragStart({ canTrace: true,  dist: 16 }), 'wait');
  assert.equal(ceilingDragStart({ canTrace: true,  dist: 16.1 }), 'pan');
});

test('【失敗系】ceilingDragStart: 距離が NaN・undefined なら判定窓（wait）に倒す（誤ってパンへ入らない）。canTrace 省略は即パン', () => {
  assert.equal(ceilingDragStart({ canTrace: true, dist: NaN }), 'wait');
  assert.equal(ceilingDragStart({ canTrace: true, dist: undefined }), 'wait');
  assert.equal(ceilingDragStart({ dist: 100 }), 'pan');
});

test('【不変条件】usePointerInteraction: 仕上げ・天伏の pointerDown は押下を記録して longPress.begin する。天伏は「なぞりができる点か」だけ判定して dragState はすぐ捨てる（パンのつもりの押下でプレビューを出さない）', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  assert.ok(/import \{[^}]*\bisTapDistance\b[^}]*\breleaseGesture\b[^}]*\bceilingDragStart\b[^}]*\} from '\.\/holdGesture\.js'/.test(src), 'holdGesture.js を import していない');
  const downStart = src.indexOf('const handlePointerDown = (e) => {');
  const downEnd = src.indexOf('const handlePointerMove = (e) => {');
  const down = src.slice(downStart, downEnd);
  const finish = branch(down, "if (appMode === 'finish') {");
  assert.match(finish, /^\s*finishDragDownRef\.current = \{ x: clientX, y: clientY \};\s*$/m);
  assert.match(finish, /^\s*longPress\.begin\(clientX, clientY\);\s*$/m);
  assert.ok(!/startDrag\(/.test(finish), '仕上げの pointerDown で startDrag している');
  const ceiling = branch(down, "if (appMode === 'ceiling') {");
  assert.match(ceiling, /^\s*modeRef\.current\?\.startDrag\(graph, world\.x, world\.y\);\s*\n\s*const canTrace = modeRef\.current\?\.dragState\?\.intent === 'create';\s*\n\s*modeRef\.current\?\.cancelDrag\(\);\s*$/m, '天伏の pointerDown は startDrag→intent 判定→cancelDrag の順');
  assert.match(ceiling, /^\s*ceilingDragDownRef\.current = \{ x: clientX, y: clientY, canTrace, deciding: false \};\s*$/m);
  assert.match(ceiling, /^\s*updateSnap\(clientX, clientY\);/m, '長押しメニューの対象は押下点で解決する');
  assert.match(ceiling, /^\s*longPress\.begin\(clientX, clientY\);\s*$/m);
  // 敷地: 描画エリアはサブモードによらず drag.current を立てる（配置サブモードでもパンできる）
  const site = branch(down, "if (appMode === 'site') {");
  assert.match(site, /^\s*if \(sm === 'sansha' \|\| sm === 'other'\) siteDrawDownRef\.current = \{ x: clientX, y: clientY \};\s*$/m);
  assert.match(site, /^\s*drag\.current = \{ lastX: clientX, lastY: clientY \};\s*$/m);
  assert.ok(!/if \(sm === 'sansha' \|\| sm === 'other'\) \{/.test(site), 'drag.current の設定がサブモードの条件の中にある');
});

test('【不変条件】usePointerInteraction: 仕上げの pointerMove は、パン中はパン、dragState（ロングタップ後のなぞり）は updateDrag、8px 超の移動（longPress.move）で startPanAt', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const move = src.slice(src.indexOf('const handlePointerMove = (e) => {'), src.indexOf('function commitCLMove('));
  const b = branch(move, "if (appMode === 'finish') {");
  assert.match(b, /^\s*if \(drag\.current\) \{ panTo\(clientX, clientY\); return; \}\s*$/m, 'パン中はパン');
  assert.match(b, /^\s*if \(!finishDragDownRef\.current\) return;\s*$/m, '押下の記録が無ければ何もしない');
  assert.match(b, /^\s*modeRef\.current\?\.updateDrag\(world\.x, world\.y\);\s*$/m, 'なぞりの更新');
  assert.match(b, /^\s*if \(longPress\.move\(clientX, clientY\)\) startPanAt\(clientX, clientY\);\s*$/m, '移動でパン開始（成立後も hasFired のガードを置かない。QA F4）');
  assert.ok(!/hasFired\(\)/.test(b));
  assert.ok(b.indexOf('panTo(clientX, clientY)') < b.indexOf('updateDrag(') && b.indexOf('updateDrag(') < b.indexOf('longPress.move('), '順序はパン→なぞり→パン開始');
});

test('【不変条件】usePointerInteraction: 天伏の pointerMove は、パン中はパン、dragState（なぞり）は updateDrag、8px 超で ceilingDragStart（即パン／判定窓）、窓の中で CEILING_PAN_PX 超ならパン、窓が閉じれば startCeilingTrace', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const move = src.slice(src.indexOf('const handlePointerMove = (e) => {'), src.indexOf('function commitCLMove('));
  const b = branch(move, "if (appMode === 'ceiling' && !modeRef.current?.moveState) {");
  assert.match(b, /^\s*if \(drag\.current\) \{ panTo\(clientX, clientY\); return; \}\s*$/m, 'パン中はパン');
  assert.match(b, /^\s*const down = ceilingDragDownRef\.current;\s*\n\s*if \(!down\) return;\s*$/m);
  assert.match(b, /^\s*modeRef\.current\?\.updateDrag\(graph, world\.x, world\.y, CEILING_DRAG_SAMPLE_PX \/ viewport\.scaleX\);\s*$/m, 'なぞりの更新');
  assert.match(b, /^\s*const dist = Math\.hypot\(clientX - down\.x, clientY - down\.y\);\s*$/m, '押下点からの距離');
  assert.match(b, /^\s*if \(!down\.deciding\) \{\s*\n\s*if \(!longPress\.move\(clientX, clientY\)\) return;\s*\n\s*if \(ceilingDragStart\(\{ canTrace: down\.canTrace, dist \}\) === 'pan'\) \{ startPanAt\(clientX, clientY\); return; \}\s*\n\s*down\.deciding = true;\s*\n\s*ceilingDecideTimerRef\.current = setTimeout\(\(\) => \{ ceilingDecideTimerRef\.current = null; startCeilingTrace\(\); \}, CEILING_DECIDE_MS\);\s*\n\s*return;/m,
    '8px 超で ceilingDragStart（即パン／判定窓を開いてタイマー）');
  assert.match(b, /^\s*if \(dist > CEILING_PAN_PX\) \{\s*\n\s*clearCeilingDecide\(\);\s*\n\s*startPanAt\(clientX, clientY\);\s*\n\s*\}/m, '判定窓の中で CEILING_PAN_PX 超ならパン');
  assert.ok(b.indexOf('updateDrag(') < b.indexOf('ceilingDragStart('), 'なぞり中の判定が見分けより後ろにある');
  // 窓が閉じたときのなぞり開始は押下点のセルから。パン中なら始めない
  const trace = src.slice(src.indexOf('function startCeilingTrace() {'), src.indexOf('function startPanAt('));
  assert.match(trace, /^\s*if \(!down \|\| drag\.current\) return;\s*$/m);
  assert.match(trace, /^\s*const world = viewport\.screenToWorld\(down\.x, down\.y\);\s*\n\s*modeRef\.current\?\.startDrag\(graph, world\.x, world\.y\);\s*$/m);
});

test('【不変条件】usePointerInteraction: 仕上げの pointerUp は releaseGesture で見分け、hold はなぞりの確定（tap は isTapDistance）、tap は押下点で startDrag→commitDrag({ tap: true })', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const up = src.slice(src.indexOf('const handlePointerUp = (e) => {'), src.indexOf('const handlePointerLeave = () => {'));
  const finish = branch(up, "if (appMode === 'finish') {");
  assert.match(finish, /^\s*const gesture = releaseGesture\(\{ fired: longPress\.hasFired\(\), panned: !!drag\.current \}\);\s*$/m);
  assert.match(finish, /^\s*if \(modeRef\.current\?\.dragState\) modeRef\.current\.commitDrag\(\{ tap: isTapDistance\(tapDist\) \}\);\s*$/m);
  assert.match(finish, /^\s*const world = viewport\.screenToWorld\(down\.x, down\.y\);\s*$/m, 'クリックは押下点のセル');
  assert.match(finish, /^\s*modeRef\.current\?\.startDrag\(world\.x, world\.y\);\s*$/m);
  assert.match(finish, /^\s*if \(modeRef\.current\?\.dragState\) modeRef\.current\.commitDrag\(\{ tap: true \}\);\s*$/m);
});

test('【不変条件】usePointerInteraction: 天伏の pointerUp は判定窓を捨て、dragState（なぞり）があれば commitDrag（tap は isTapDistance）、無ければ tap かつ 8px 未満のときだけ押下点で startDrag→commitDrag({ tap: true, ctx })', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const up = src.slice(src.indexOf('const handlePointerUp = (e) => {'), src.indexOf('const handlePointerLeave = () => {'));
  const ceiling = branch(up, "if (appMode === 'ceiling' && !modeRef.current?.moveState) {");
  assert.match(ceiling, /^\s*clearCeilingDecide\(\);\s*$/m, '判定窓のタイマーを捨てる');
  assert.match(ceiling, /^\s*if \(modeRef\.current\?\.dragState\) \{\s*\n\s*modeRef\.current\.commitDrag\(\{ tap: isTapDistance\(tapDist\), ctx: \{ graph, project \} \}\);\s*$/m, 'なぞりの確定');
  assert.match(ceiling, /^\s*\} else if \(releaseGesture\(\{ fired: longPress\.hasFired\(\), panned: !!drag\.current \}\) === 'tap' && isTapDistance\(tapDist\)\) \{\s*$/m, 'クリックは tap かつ 8px 未満（判定窓が閉じる前に離したら何もしない）');
  assert.match(ceiling, /^\s*modeRef\.current\?\.startDrag\(graph, world\.x, world\.y\);\s*$/m);
  assert.match(ceiling, /^\s*modeRef\.current\?\.commitDrag\(\{ tap: true, ctx: \{ graph, project \} \}\);\s*$/m, '天伏のクリックは dragState が無くても commitDrag（空白のタップで選択解除）');
});

test('【不変条件】usePointerInteraction: longPress.onFire は仕上げでは押下点から startDrag（メニューなし）、天伏では判定窓と dragState と記録を捨ててメニュー（なぞりは onFire で始めない）', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const start = src.indexOf('const longPress = useLongPress({');
  const fire = src.slice(start, src.indexOf('onCancel: () => setPressPos(null),', start));
  const finish = fire.slice(fire.indexOf("if (appMode === 'finish') {"), fire.indexOf('const snap         = snapRef.current;'));
  assert.match(finish, /^\s*if \(!finishDragDownRef\.current\) return;\s*$/m);
  assert.match(finish, /^\s*const world = viewport\.screenToWorld\(sx, sy\);\s*$/m);
  assert.match(finish, /^\s*modeRef\.current\?\.startDrag\(world\.x, world\.y\);\s*$/m);
  assert.match(finish, /^\s*return;\s*$/m);
  const ceiling = fire.slice(fire.indexOf("if (appMode === 'ceiling') {"), fire.indexOf('const state = buildMenuState('));
  assert.match(ceiling, /^\s*clearCeilingDecide\(\);\s*\n\s*modeRef\.current\?\.cancelDrag\(\);\s*\n\s*ceilingDragDownRef\.current = null;\s*$/m);
  assert.ok(!/startDrag\(/.test(ceiling), '天伏の onFire で startDrag している（ロングタップは全部メニュー）');
});

test('【不変条件】usePointerInteraction: 仕上げ・天伏の pointerLeave と resetGestureRefs は longPress.abort し、天伏は判定窓も捨てる', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const start = src.indexOf('const handlePointerLeave = () => {');
  const leave = src.slice(start, src.indexOf('const handleTouchStart = (e) => {', start));
  const finish = branch(leave, "if (appMode === 'finish') {");
  assert.match(finish, /^\s*modeRef\.current\?\.cancelDrag\(\);\s*$/m);
  assert.match(finish, /^\s*longPress\.abort\(\);\s*$/m);
  const ceiling = branch(leave, "if (appMode === 'ceiling') {");
  assert.match(ceiling, /^\s*clearCeilingDecide\(\);\s*\n\s*modeRef\.current\?\.cancelDrag\(\);\s*$/m);
  const reset = src.slice(src.indexOf('function resetGestureRefs() {'), src.indexOf('function didOpeningDragEnd()'));
  assert.match(reset, /^\s*clearCeilingDecide\(\);\s*\n\s*ceilingDragDownRef\.current = null;\s*$/m);
});

test('【不変条件】usePointerInteraction: パンは panTo に一本化（移動量を panDistRef に積む）、パン開始は startPanAt（積算を TAP_MOVE_PX から）、pointerDown で 0 に戻し、pointerUp で TAP_MOVE_PX 以上なら didPanEnd が真。SceneLayers の階段・敷地線の click はそれを見て無視する', () => {
  const src = stripComments(readSrc('./usePointerInteraction.js'));
  const panTo = src.slice(src.indexOf('function panTo(clientX, clientY) {'), src.indexOf('function clearCeilingDecide() {'));
  assert.match(panTo, /^\s*panDistRef\.current \+= Math\.hypot\(dx, dy\);\s*$/m);
  assert.match(panTo, /^\s*viewport\.pan\(dx, dy\);\s*$/m);
  // ポインタ由来の viewport.pan は panTo の1箇所だけ（ピンチの viewport.pan(midX - …) は別）
  assert.equal((src.match(/viewport\.pan\(dx, dy\)/g) ?? []).length, 1, 'viewport.pan(dx, dy) が panTo の外にある');
  assert.equal((src.match(/panTo\(clientX, clientY\);/g) ?? []).length, 4, '仕上げ・天伏・敷地・汎用の4経路が panTo を使う（呼び出しの4箇所。定義は除く）');
  // 積算は閾値分（TAP_MOVE_PX）から始める——押下点から既に 8px 超動いているので、9〜15px で離しても didPanEnd が真になる（QA N1）
  const startPan = src.slice(src.indexOf('function startPanAt(clientX, clientY) {'), src.indexOf('const handlePointerDown = (e) => {'));
  assert.match(startPan, /^\s*drag\.current = \{ lastX: clientX, lastY: clientY \};\s*\n\s*panDistRef\.current = TAP_MOVE_PX;.*\n\s*setIsPanning\(true\);\s*$/m);
  assert.equal((src.match(/startPanAt\(clientX, clientY\);/g) ?? []).length, 4, '仕上げ1・天伏2・汎用1 のパン開始が startPanAt を使う');
  assert.match(src, /^\s*if \(shouldPan\) \{\s*\n\s*startPanAt\(clientX, clientY\);\s*\n\s*return;/m, '汎用経路のパン開始が startPanAt でない');
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
