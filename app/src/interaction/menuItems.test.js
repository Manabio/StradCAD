import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT, buildMenuState } from './menuItems.js';

// ---- buildMenuState（長押しメニューの context 判定＋items 生成） ----

test('buildMenuState: 建具モード（appMode=opening）で壁・開口以外（中心線）の長押しは null', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('opening', { snap: null, cl, clEndpoint: null, opening: null, wall: null, canMove: true });
  assert.equal(state, null);
});

test('buildMenuState: 建具モードでも壁上の長押しは null にならず items が非空', () => {
  const wall = { id: 'w1' };
  const state = buildMenuState('opening', {
    snap: null, cl: null, clEndpoint: null, opening: null, wall, wallEligible: true,
  });
  assert.notEqual(state, null);
  assert.equal(state.context, CONTEXT.WALL);
  assert.ok(state.items.length > 0, '壁上メニューは常に建具・窓の項目を持つ');
});

test('buildMenuState: 建具モードでも開口上の長押しは null にならない', () => {
  const opening = { id: 'o1' };
  const state = buildMenuState('opening', { snap: null, cl: null, clEndpoint: null, opening, wall: null });
  assert.notEqual(state, null);
  assert.equal(state.context, CONTEXT.OPENING);
});

// ---- 構造モード（壁・開口は snap.js が候補解決の段階で落とすため、ここには WALL/OPENING が来ない） ----

test('buildMenuState: 構造モードでも壁以外（梁芯の中心線上）の長押しは従来どおりメニューを出す', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('structure', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null, canMove: true,
  });
  assert.notEqual(state, null);
  assert.equal(state.context, CONTEXT.CENTER_LINE);
  assert.ok(state.items.some(i => i.id === 'cl-move'));
});

test('buildMenuState: 平面モードの壁上メニューは建具・窓・三方枠・腰/垂壁を持つ', () => {
  const wall = { id: 'w1' };
  const state = buildMenuState('floorplan', {
    snap: null, cl: null, clEndpoint: null, opening: null, wall, wallEligible: true,
  });
  assert.equal(state.context, CONTEXT.WALL);
  assert.deepEqual(state.items.map(i => i.id), ['add-fitting', 'add-window', 'add-frame', 'knee-drop-wall']);
});

test('buildMenuState: 非建具モードの中心線上は null にならず、canMove/hasInteriorWall を反映する', () => {
  const cl = { id: 'cl1', centerLineType: 'Y' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null, canMove: true, hasInteriorWall: true,
  });
  assert.equal(state.context, CONTEXT.CENTER_LINE);
  assert.equal(state.clState.isVertical, false); // 'Y' = CenterLineType.HORIZONTAL
  assert.ok(state.items.some(i => i.id === 'cl-ecc'), 'hasInteriorWall=true なら偏芯項目が出る');
});

// ---- 中心⇔通り芯の入替え（平面モード限定） ----

test('buildMenuState: canToGrid=true なら CL端点メニューに「通り芯に」が出る', () => {
  const clEndpoint = { cl: { id: 'cl1', centerLineType: 'X' }, side: 'lo' };
  const state = buildMenuState('floorplan', {
    snap: null, cl: null, clEndpoint, opening: null, wall: null,
    canExtend: true, canShorten: true, canToGrid: true,
  });
  assert.equal(state.context, CONTEXT.CENTER_LINE_ENDPOINT);
  assert.ok(state.items.some(i => i.id === 'cl-to-grid'), 'canToGrid=true なら通り芯化項目が出る');
});

test('buildMenuState: canToGrid=false なら CL端点メニューに「通り芯に」が出ない', () => {
  const clEndpoint = { cl: { id: 'cl1', centerLineType: 'X' }, side: 'lo' };
  const state = buildMenuState('floorplan', {
    snap: null, cl: null, clEndpoint, opening: null, wall: null,
    canExtend: true, canShorten: true, canToGrid: false,
  });
  assert.equal(state.items.some(i => i.id === 'cl-to-grid'), false);
});

test('buildMenuState: canToCenter=true なら中心線上メニューに「中心に」が出る', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null, canMove: true, canToCenter: true,
  });
  assert.equal(state.context, CONTEXT.CENTER_LINE);
  assert.ok(state.items.some(i => i.id === 'cl-to-center'), 'canToCenter=true なら中心化項目が出る');
});

test('buildMenuState: canToCenter=false なら中心線上メニューに「中心に」が出ない（既存項目は維持）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null, canMove: true, canToCenter: false,
  });
  assert.equal(state.items.some(i => i.id === 'cl-to-center'), false);
  assert.ok(state.items.some(i => i.id === 'cl-move'));
  assert.ok(state.items.some(i => i.id === 'cl-del'));
});

// ---- 軸最後の1本ガードのグレー化（isLastGridOnAxis。ユーザー要望で新設） ----
// 判定式は transform/centerLineConvert.js の isLastGridOnAxis を呼び出し側
// （interaction/usePointerInteraction.js）が算出して渡す共有ロジック——ここでは
// buildMenuState/getMenuItems が isLastGridOnAxis の値をそのまま disabled へ渡すことだけを検証する。

test('buildMenuState: canToCenter=true かつ isLastGridOnAxis=true なら「中心に」項目は出るがdisabled（表示条件自体は変えない）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, canToCenter: true, isLastGridOnAxis: true,
  });
  const item = state.items.find(i => i.id === 'cl-to-center');
  assert.ok(item, '軸最後の1本でも項目自体は非表示にしない（グレー化のみ）');
  assert.equal(item.disabled, true);
});

test('buildMenuState: canToCenter=true かつ isLastGridOnAxis=false なら「中心に」項目は通常どおり押せる（disabledでない）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, canToCenter: true, isLastGridOnAxis: false,
  });
  const item = state.items.find(i => i.id === 'cl-to-center');
  assert.ok(item);
  assert.equal(item.disabled, false);
});

// ---- 削除（cl-del）のグレー化（ユーザー要望で追加）。中心化ガードと同じisLastGridOnAxisを共有する ----

test('buildMenuState: isLastGridOnAxis=true（軸最後の通り芯）なら「削除」もdisabledになる（canMove=trueの通常メニュー）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, canToCenter: true, isLastGridOnAxis: true,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item, '軸最後の1本でも削除項目自体は非表示にしない（グレー化のみ）');
  assert.equal(item.disabled, true);
});

test('buildMenuState: isLastGridOnAxis=true（軸最後の通り芯）なら「削除」もdisabledになる（canMove=falseの削除のみメニュー）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: false, isLastGridOnAxis: true,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item);
  assert.equal(item.disabled, true);
});

test('buildMenuState: isLastGridOnAxis=false（同軸に他の通り芯あり）なら「削除」は通常どおり押せる', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, isLastGridOnAxis: false,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item);
  assert.equal(item.disabled, false);
});

// 【回帰点】中心線（非struct）は呼び出し側（usePointerInteraction.js）がcenterLineKind(cl)==='struct'
// のときのみisLastGridOnAxisを算出する契約——中心線に対しては常にundefinedが渡ってくるはずで、
// その場合ここ（menuItems.js）が!!undefined=falseへ変換し「削除」をdisabledにしないことを固定する
// （isLastGridOnAxis関数自体は同軸の通り芯本数だけを数えるため、非structのCLに対して誤って
// 呼んでしまうと同軸通り芯0本でtrueを返しかねない——その誤りをここではなく呼び出し側で
// 防ぐ設計になっていることの土台をこのテストで確認する）。
test('buildMenuState: 中心線（isLastGridOnAxis未算出=undefined）は「削除」がdisabledにならない', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, isLastGridOnAxis: undefined,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item);
  assert.equal(item.disabled, false);
});

// ---- 削除（cl-del）のグレー化（フットプリント境界削除ガードの多層防御。isFootprintBoundary） ----
// 判定式は transform/centerLineConvert.js の isFootprintBoundaryCL を呼び出し側
// （interaction/clMenuGating.js）が算出して渡す共有ロジック——ここでは buildMenuState/getMenuItems が
// isFootprintBoundary の値をそのまま disabled へ渡すことだけを検証する。

test('buildMenuState: isFootprintBoundary=true（外壁線を担うCL）なら「削除」もdisabledになる（canMove=trueの通常メニュー）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, isFootprintBoundary: true,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item, '外壁線を担うCLでも削除項目自体は非表示にしない（グレー化のみ）');
  assert.equal(item.disabled, true);
});

test('buildMenuState: isFootprintBoundary=true（外壁線を担うCL）なら「削除」もdisabledになる（canMove=falseの削除のみメニュー）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: false, isFootprintBoundary: true,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item);
  assert.equal(item.disabled, true);
});

test('buildMenuState: isFootprintBoundary=false（外壁線ではない）なら「削除」は通常どおり押せる', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, isFootprintBoundary: false,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item);
  assert.equal(item.disabled, false);
});

// 【回帰点】補助線・梁芯（呼び出し側clMenuGating.jsがisFinishCellDivider(cl)===falseのとき
// isFootprintBoundaryをundefinedのまま渡す契約）は「削除」がdisabledにならないことを固定する。
test('buildMenuState: isFootprintBoundary未算出=undefined（補助線・梁芯）は「削除」がdisabledにならない', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, isFootprintBoundary: undefined,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item);
  assert.equal(item.disabled, false);
});

// ---- 削除（cl-del）のグレー化（復元不能セル削除ガードの多層防御。isUnresolvable。D・QA指摘） ----
// 判定式は finish/roomReinterpret.js の findUnresolvableCells を呼び出し側（interaction/
// clMenuGating.js）が算出して渡す共有ロジック——ここでは buildMenuState/getMenuItems が
// isUnresolvable の値をそのまま disabled へ渡すことだけを検証する。

test('buildMenuState: isUnresolvable=true（削除すると復元不能）なら「削除」もdisabledになる（canMove=trueの通常メニュー）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, isUnresolvable: true,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item, '復元不能なCLでも削除項目自体は非表示にしない（グレー化のみ）');
  assert.equal(item.disabled, true);
});

test('buildMenuState: isUnresolvable=true（削除すると復元不能）なら「削除」もdisabledになる（canMove=falseの削除のみメニュー）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: false, isUnresolvable: true,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item);
  assert.equal(item.disabled, true);
});

test('buildMenuState: isUnresolvable=false（復元可能）なら「削除」は通常どおり押せる', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, isUnresolvable: false,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item);
  assert.equal(item.disabled, false);
});

// 【回帰点】補助線・梁芯（呼び出し側clMenuGating.jsがisFinishCellDivider(cl)===falseのとき
// isUnresolvableをundefinedのまま渡す契約）は「削除」がdisabledにならないことを固定する。
test('buildMenuState: isUnresolvable未算出=undefined（補助線・梁芯）は「削除」がdisabledにならない', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('floorplan', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, isUnresolvable: undefined,
  });
  const item = state.items.find(i => i.id === 'cl-del');
  assert.ok(item);
  assert.equal(item.disabled, false);
});

// ---- 天伏モード（S8b）: 天井芯の追加・移動・削除・延長/短縮だけ。交点・壁・開口は null ----

test('buildMenuState: 天伏の空白の長押しは 垂直線・水平線（天井芯の追加）を出す', () => {
  const state = buildMenuState('ceiling', { snap: null, cl: null, clEndpoint: null, opening: null, wall: null });
  assert.equal(state.context, CONTEXT.EMPTY);
  assert.deepEqual(state.items.map(i => i.id), ['cl-v', 'cl-h']);
});

test('buildMenuState: 天伏の天井芯の線上は 移動・削除（偏芯・中心/通り芯入替えは出ない）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  const state = buildMenuState('ceiling', {
    snap: null, cl, clEndpoint: null, opening: null, wall: null,
    canMove: true, hasInteriorWall: false, canToCenter: false, // 呼び出し側（interiorWallSpans 空・convertMenuFlags が floorplan 限定）の算出値
  });
  assert.equal(state.context, CONTEXT.CENTER_LINE);
  assert.deepEqual(state.items.map(i => i.id), ['cl-move', 'cl-del']);
  assert.ok(state.items.every(i => i.disabled !== true));
});

test('buildMenuState: 天伏の天井芯の端点は 延長＋短縮|削除（通り芯化は出ない）', () => {
  const cl = { id: 'cl1', centerLineType: 'Y' };
  const state = buildMenuState('ceiling', {
    snap: null, cl: null, clEndpoint: { cl, side: 'hi' }, opening: null, wall: null,
    canExtend: true, canShorten: false, canToGrid: false,
  });
  assert.equal(state.context, CONTEXT.CENTER_LINE_ENDPOINT);
  assert.deepEqual(state.items.map(i => i.id), ['cl-extend', 'cl-del']);
});

test('buildMenuState: 天伏の交点・壁・開口の長押しは null（メニューを出さない。多層防御）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  assert.equal(buildMenuState('ceiling', { snap: { id: 'n1' }, cl: null, clEndpoint: null, opening: null, wall: null }), null, 'INTERSECTION');
  assert.equal(buildMenuState('ceiling', { snap: null, cl: null, clEndpoint: null, opening: null, wall: { id: 'w1' }, wallEligible: true }), null, 'WALL');
  assert.equal(buildMenuState('ceiling', { snap: null, cl: null, clEndpoint: null, opening: { id: 'o1' }, wall: null }), null, 'OPENING');
  // 他モードの同じ入力は null にならない（天伏だけのガードであること）
  assert.notEqual(buildMenuState('floorplan', { snap: { id: 'n1' }, cl, clEndpoint: null, opening: null, wall: null }), null);
});
