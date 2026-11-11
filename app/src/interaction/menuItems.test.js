import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT, buildMenuState, detectContext } from './menuItems.js';
import { ColumnMenuItemId, CL_OVERLAP_TOL_MM } from '../core/constants.js';

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

// ---- 柱の長クリック（平面・構造）: 優先順 柱 > 柱追加位置 > 交点 > 端点 > CL > 建具 > 壁 > 空 ----
const COL = { id: 'col1' };
const SLOT = { vCL: { id: 'v' }, hCL: { id: 'h' }, x: 1, y: 2, occupied: false };

test('detectContext: 優先順（柱 > 柱追加位置 > 交点 > 端点 > CL > 建具 > 壁 > 空）。柱と追加位置が同時なら柱', () => {
  const all = [{ id: 'n' }, { id: 'cl' }, { id: 'o' }, { id: 'w' }, { cl: { id: 'e' }, side: 'lo' }];
  assert.equal(detectContext(...all, COL, SLOT), CONTEXT.COLUMN);
  assert.equal(detectContext(...all, null, SLOT), CONTEXT.COLUMN_SLOT);
  assert.equal(detectContext(...all, null, null), CONTEXT.INTERSECTION);
  assert.equal(detectContext(null, { id: 'cl' }, null, null, { cl: { id: 'e' }, side: 'lo' }), CONTEXT.CENTER_LINE_ENDPOINT);
  assert.equal(detectContext(null, { id: 'cl' }, { id: 'o' }, { id: 'w' }), CONTEXT.CENTER_LINE);
  assert.equal(detectContext(null, null, { id: 'o' }, { id: 'w' }), CONTEXT.OPENING);
  assert.equal(detectContext(null, null, null, { id: 'w' }), CONTEXT.WALL);
  assert.equal(detectContext(null, null, null, null), CONTEXT.EMPTY);
  assert.equal(detectContext(null, null, null, null, null, null, SLOT), CONTEXT.COLUMN_SLOT, '柱が無ければ追加位置は snap・CL・壁・空より先');
});

test('buildMenuState: 柱の断面内→[柱削除]（平面・構造とも）', () => {
  for (const appMode of ['floorplan', 'structure']) {
    const state = buildMenuState(appMode, { snap: { id: 'n' }, cl: { id: 'cl', centerLineType: 'X' }, clEndpoint: null, opening: null, wall: null, column: COL, columnSlot: null });
    assert.equal(state.context, CONTEXT.COLUMN);
    assert.deepEqual(state.items.map(i => i.id), [ColumnMenuItemId.DEL]);
    assert.equal(state.items[0].label, '柱削除');
    assert.equal(state.clState, null);
  }
});

test('buildMenuState: 平面で交点 snap があれば 柱追加 の後ろに既存の斜線・円弧・削除（INTERSECTION と同じ定義）。snap が無ければ 1 項目', () => {
  const snap = { id: 'n', x: SLOT.x, y: SLOT.y }; // 押した交点と同じ交点の snap
  const withSnap = buildMenuState('floorplan', { snap, cl: null, clEndpoint: null, opening: null, wall: null, columnSlot: SLOT, columnSlotAddable: true });
  const inter = buildMenuState('floorplan', { snap, cl: null, clEndpoint: null, opening: null, wall: null });
  assert.equal(withSnap.context, CONTEXT.COLUMN_SLOT);
  assert.deepEqual(withSnap.items.map(i => i.id), [ColumnMenuItemId.ADD, 'diag', 'arc', 'del']);
  assert.equal(withSnap.items[0].label, '柱追加');
  assert.deepEqual(withSnap.items.slice(1), inter.items, '既存 3 項目は INTERSECTION と同じ定義');
  const only = buildMenuState('floorplan', { snap: null, cl: null, clEndpoint: null, opening: null, wall: null, columnSlot: SLOT, columnSlotAddable: true });
  assert.deepEqual(only.items.map(i => i.id), [ColumnMenuItemId.ADD]);
});

test('buildMenuState: 並べるのは押した交点と同じ交点の snap だけ。別の交点（隣）の snap・許容ちょうど以上のずれは柱追加だけ', () => {
  const mk = snap => buildMenuState('floorplan', { snap, cl: null, clEndpoint: null, opening: null, wall: null, columnSlot: SLOT, columnSlotAddable: true }).items.map(i => i.id);
  const four = [ColumnMenuItemId.ADD, 'diag', 'arc', 'del'];
  assert.deepEqual(mk({ id: 'a', x: SLOT.x + CL_OVERLAP_TOL_MM / 2, y: SLOT.y - CL_OVERLAP_TOL_MM / 2 }), four, '許容内のずれは同じ交点');
  assert.deepEqual(mk({ id: 'b', x: SLOT.x + 500, y: SLOT.y }), [ColumnMenuItemId.ADD], '隣の交点の snap（x が違う）');
  assert.deepEqual(mk({ id: 'c', x: SLOT.x, y: SLOT.y + 500 }), [ColumnMenuItemId.ADD], '隣の交点の snap（y が違う）');
  assert.deepEqual(mk({ id: 'd', x: SLOT.x + CL_OVERLAP_TOL_MM, y: SLOT.y }), [ColumnMenuItemId.ADD], '許容ちょうどは別の交点');
  assert.deepEqual(mk(null), [ColumnMenuItemId.ADD], 'snap なし');
});

test('buildMenuState: 構造モードでは同じ交点の snap があっても 柱追加 だけ（既存 3 項目を足さない）', () => {
  const state = buildMenuState('structure', { snap: { id: 'n', x: SLOT.x, y: SLOT.y }, cl: null, clEndpoint: null, opening: null, wall: null, columnSlot: SLOT, columnSlotAddable: true });
  assert.deepEqual(state.items.map(i => i.id), [ColumnMenuItemId.ADD]);
});

test('buildMenuState: addable 偽なら 柱追加 は disabled（グレー化）・真なら押せる', () => {
  const mk = addable => buildMenuState('floorplan', { snap: null, cl: null, clEndpoint: null, opening: null, wall: null, columnSlot: SLOT, columnSlotAddable: addable });
  assert.equal(mk(false).items[0].disabled, true);
  assert.equal(mk(true).items[0].disabled, false);
  assert.equal(buildMenuState('floorplan', { snap: null, cl: null, clEndpoint: null, opening: null, wall: null, columnSlot: SLOT }).items[0].disabled, true, '省略は偽');
});

test('buildMenuState: 建具・天伏・仕上げでは column / columnSlot を渡しても柱のメニューにならない（多層防御）', () => {
  const colIds = [ColumnMenuItemId.ADD, ColumnMenuItemId.DEL];
  for (const appMode of ['opening', 'ceiling', 'finish', 'site']) {
    const s1 = buildMenuState(appMode, { snap: null, cl: null, clEndpoint: null, opening: null, wall: null, column: COL, columnSlot: SLOT, columnSlotAddable: true });
    const s2 = buildMenuState(appMode, { snap: { id: 'n' }, cl: { id: 'cl', centerLineType: 'X' }, clEndpoint: null, opening: null, wall: null, column: COL, columnSlot: SLOT, columnSlotAddable: true, canMove: true });
    for (const s of [s1, s2]) {
      assert.ok(s === null || (s.context !== CONTEXT.COLUMN && s.context !== CONTEXT.COLUMN_SLOT), `${appMode}: 柱の文脈にならない`);
      assert.ok(s === null || !s.items.some(i => colIds.includes(i.id)), `${appMode}: 柱の項目が出ない`);
    }
  }
});

test('buildMenuState: 柱を渡さない従来の呼び出し（引数なし）は従来どおり（柱の文脈・columnSlotState は null）', () => {
  const state = buildMenuState('floorplan', { snap: { id: 'n' }, cl: null, clEndpoint: null, opening: null, wall: null });
  assert.equal(state.context, CONTEXT.INTERSECTION);
  assert.equal(state.columnSlotState, null);
});

test('buildMenuState: 天伏の交点・壁・開口の長押しは null（メニューを出さない。多層防御）', () => {
  const cl = { id: 'cl1', centerLineType: 'X' };
  assert.equal(buildMenuState('ceiling', { snap: { id: 'n1' }, cl: null, clEndpoint: null, opening: null, wall: null }), null, 'INTERSECTION');
  assert.equal(buildMenuState('ceiling', { snap: null, cl: null, clEndpoint: null, opening: null, wall: { id: 'w1' }, wallEligible: true }), null, 'WALL');
  assert.equal(buildMenuState('ceiling', { snap: null, cl: null, clEndpoint: null, opening: { id: 'o1' }, wall: null }), null, 'OPENING');
  // 他モードの同じ入力は null にならない（天伏だけのガードであること）
  assert.notEqual(buildMenuState('floorplan', { snap: { id: 'n1' }, cl, clEndpoint: null, opening: null, wall: null }), null);
});
