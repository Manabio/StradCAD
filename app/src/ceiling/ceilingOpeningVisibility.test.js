// ceilingOpeningVisibility.js（天伏＝見上げで描く建具の判定。断面線がまたぐ建具だけ描く。裁定 2026-10-22）の単体テスト。
// 判定は ceilingCutHeight.test.js と同じ fixture（実物の PlanGraph）で組み、壁の欠き取りへの配線は buildWallDrawPlan で確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory, RoomFeature } from '@core';
import { ceilingCutResolverOf } from './ceilingCutHeight.js';
import { openingCutVisible, ceilingHiddenOpeningIds } from './ceilingOpeningVisibility.js';
import { makeGrid, addBeamH } from '../plan/planTestFixtures.js';
import { buildHostWallByOpening } from '../openings/openingGeometry.js';
import { buildWallDrawPlan } from '../renderer/wallDrawPlan.js';
import { LodLevel } from '../viewport.js';

// 左端の縦の外壁（x=0）の中央に建具を足す。ceiling＝部屋の天井高（切断高はその 1 mm 下）
function oneRoom(ceiling, { floor } = {}) {
  const g = makeGrid([0, 4000], [0, 3000]);
  const room = g.interior([[0, 0]], { walls: true });
  room.setOverride('ceilingHeight', String(ceiling));
  if (floor != null) room.setFloorLevel(floor);
  return g;
}
const door = (g, props = {}, at = 1500) => g.graph.addOpening(g.cx[0], 1, true, g.cy[0], at, 900, OpeningCategory.FITTING, 'singleSwing', props);
const win = (g, sill, height, at = 1500) => g.graph.addOpening(g.cx[0], 1, true, g.cy[0], at, 900, OpeningCategory.WINDOW, 'doubleSliding', { sillHeight: sill, height });
const visible = (g, o) => openingCutVisible(o, ceilingCutResolverOf(g.graph));

test('天井 2400 の部屋の高さ 2000 のドア → 描かない（切断高 2399 が上端 2000 の上を通る）', () => {
  const g = oneRoom(2400);
  assert.equal(visible(g, door(g, { height: 2000 })), false);
});

test('高窓（下端 1800・上端 2450）→ 描く（切断高 2399 が窓をまたぐ）。腰窓（下端 900・上端 1800）は描かない', () => {
  const g = oneRoom(2400);
  assert.equal(visible(g, win(g, 1800, 650)), true);
  assert.equal(visible(g, win(g, 900, 900, 600)), false);
});

test('高さ未設定は既定（建具 2000・窓 1100）で判定し、窓台未設定は 0。例外にしない', () => {
  const g = oneRoom(2400);
  assert.equal(visible(g, door(g, {})), false, '建具の既定高さ 2000 < 2399');
  const low = oneRoom(1800);
  assert.equal(visible(low, door(low, {})), true, '切断高 1799 は 0〜2000 の間');
  assert.equal(visible(low, win(low, null, null)), false, '窓台なし・既定高さ 1100: 0〜1100 に 1799 は入らない');
});

test('下がり梁で切断高が下がった部屋のドアは描く（切断高 1439 が 0〜2000 の間）。梁が無ければ描かない', () => {
  const g = oneRoom(2400);
  const o = door(g, { height: 2000 });
  assert.equal(visible(g, o), false, '対照: 梁なし');
  addBeamH(g.graph, { axis: 1000, from: 500, to: 3500, levelOffset: 1640 }); // z 1440〜1640
  assert.equal(ceilingCutResolverOf(g.graph).wallCutAt(true, 0, 1500), 1439, '前提: 壁の切断高が梁の直下まで下がっている');
  assert.equal(visible(g, o), true);
});

test('天井の無い所に面する壁の建具は階の値（1500）で判定する', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.feature([[0, 0]], RoomFeature.VOID);
  const d = g.graph.addOpening(g.cx[1], 1, true, g.cy[0], 1500, 900, OpeningCategory.FITTING, 'singleSwing', { height: 2000 });
  const high = g.graph.addOpening(g.cx[1], 1, true, g.cy[0], 500, 900, OpeningCategory.WINDOW, 'doubleSliding', { sillHeight: 1600, height: 600 });
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.wallCutAt(true, 2000, 1500), 1500, '前提: 両側とも天井が無ければ階の値');
  assert.equal(openingCutVisible(d, r), true, '0〜2000 に 1500 が入る');
  assert.equal(openingCutVisible(high, r), false, '窓台 1600 は階の値 1500 の上');
});

test('建具の幅の中で隣室が替わる: どこか 1 点でも断面線がまたげば描く。どの点もまたがなければ描かない', () => {
  const g = makeGrid([0, 2000, 4000], [0, 1500, 3000]);
  const l0 = g.interior([[0, 0]], { walls: true });
  const l1 = g.interior([[0, 1]], { walls: true });
  const right = g.interior([[1, 0], [1, 1]], { walls: true });
  l0.setOverride('ceilingHeight', '2600');
  l1.setOverride('ceilingHeight', '1300');
  right.setOverride('ceilingHeight', '2400');
  const mk = (sill, height) => g.graph.addOpening(g.cx[1], 1, true, g.cy[0], 1500, 1000, OpeningCategory.WINDOW, 'doubleSliding', { sillHeight: sill, height });
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.wallCutAt(true, 2000, 1000), 2399, '前提: 窓（y 1000〜2000）の上半分は 2399');
  assert.equal(r.wallCutAt(true, 2000, 1900), 1299, '前提: 下半分は 1299');
  assert.equal(openingCutVisible(mk(1250, 100), r), true, '1299 だけが窓をまたぐ');
  assert.equal(openingCutVisible(mk(2300, 200), r), true, '2399 だけが窓をまたぐ');
  assert.equal(openingCutVisible(mk(1500, 500), r), false, '1299 も 2399 もまたがない');
});

test('境界ちょうど: 切断高＝上端・切断高＝下端は描く。1 mm 外れると描かない', () => {
  const g = oneRoom(2400); // 切断高 2399
  assert.equal(visible(g, door(g, { height: 2399 })), true, '上端＝切断高');
  assert.equal(visible(g, door(g, { height: 2398 })), false, '上端が 1 mm 低い');
  assert.equal(visible(g, win(g, 2399, 100, 600)), true, '下端＝切断高');
  assert.equal(visible(g, win(g, 2400, 100, 600)), false, '下端が 1 mm 高い');
});

test('床段差: 建具の下端・上端は床面（段差込み）からの高さ。床 +400・天井高 2000（天井面 2400）のドア 2000 は 400〜2400 で描く（段差を無視すると 0〜2000 で隠れる）', () => {
  const g = oneRoom(2000, { floor: 400 });
  assert.equal(ceilingCutResolverOf(g.graph).wallCutAt(true, 0, 1500), 2399, '前提');
  assert.equal(visible(g, door(g, { height: 2000 })), true);
  const flat = oneRoom(2400, { floor: 0 });
  assert.equal(visible(flat, door(flat, { height: 2000 })), false, '対照: 段差なし');
});

test('床面は天井のある側だけで決める: 天井の無い側（階段吹抜け）の床 −500 は拾わず 0。ドア 2400 は 0〜2400 で描き、ドア 2000 は描かない', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.interior([[0, 0]], { walls: true }).setOverride('ceilingHeight', '2400');
  const sv = g.feature([[1, 0]], RoomFeature.STAIR_VOID);
  sv.setFloorLevel(-500);
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.wallFloorAt(true, 2000, 1500), 0, '天井の無い側の床は拾わない');
  const mk = height => g.graph.addOpening(g.cx[1], 1, true, g.cy[0], 1500, 900, OpeningCategory.FITTING, 'singleSwing', { height });
  assert.equal(openingCutVisible(mk(2400), r), true, '床 0 基準なら 0〜2400 に切断高 2399 が入る');
  assert.equal(openingCutVisible(mk(2000), r), false);
});

test('【失敗系】位置が決まらない建具（軸・座標が不正）は隠す根拠が無いので描く。建具の無い階・graph null は空の集合', () => {
  const g = oneRoom(2400);
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(openingCutVisible({ axisCL: null, coord1: NaN, coord2: NaN, category: OpeningCategory.FITTING, height: 2000 }, r), true);
  assert.deepEqual([...ceilingHiddenOpeningIds(g.graph, r)], []);
  assert.deepEqual([...ceilingHiddenOpeningIds(null, r)], []);
});

test('集合: 描かない建具の id だけが入る', () => {
  const g = oneRoom(2400);
  const hidden = door(g, { height: 2000 }, 700);
  const shown = win(g, 1800, 650, 2300);
  const ids = ceilingHiddenOpeningIds(g.graph, ceilingCutResolverOf(g.graph));
  assert.deepEqual([...ids], [hidden.id]);
  assert.equal(ids.has(shown.id), false);
});

// ---- 壁の欠き取りへの配線（buildWallDrawPlan の hiddenOpeningIds） ----
const wallOf = (g, o) => buildHostWallByOpening(g.graph).get(o.id);

test('配線: 描かない建具の位置も連なった壁（欠き取りなし）。見下げ（集合なし）は従来どおり欠き取る。描く建具は見上げでも欠き取る', () => {
  const g = oneRoom(2400);
  const hiddenDoor = door(g, { height: 2000 }, 700);
  const shownWin = win(g, 1800, 650, 2300);
  const wall = wallOf(g, hiddenDoor);
  assert.ok(wall, '前提: 建具のホスト壁がある');
  assert.equal(wallOf(g, shownWin).id, wall.id, '前提: 同じ壁');
  const down = buildWallDrawPlan(g.graph, LodLevel.STANDARD).wallLines.get(wall.id).segments;
  assert.equal(down.length, 3, '見下げ: 2 つの建具で 3 区間');
  const hiddenIds = ceilingHiddenOpeningIds(g.graph, ceilingCutResolverOf(g.graph));
  const up = buildWallDrawPlan(g.graph, LodLevel.STANDARD, { hiddenOpeningIds: hiddenIds }).wallLines.get(wall.id).segments;
  assert.equal(up.length, 2, '見上げ: 描かないドアの位置は連なり、窓の位置だけ欠く');
  const same = buildWallDrawPlan(g.graph, LodLevel.STANDARD, { hiddenOpeningIds: new Set() }).wallLines.get(wall.id).segments;
  assert.deepEqual(same, down, '空の集合は見下げと同じ');
  const allHidden = buildWallDrawPlan(g.graph, LodLevel.STANDARD, { hiddenOpeningIds: new Set([hiddenDoor.id, shownWin.id]) }).wallLines.get(wall.id).segments;
  assert.equal(allHidden.length, 1, '全部隠せば 1 本の連なった壁');
});
