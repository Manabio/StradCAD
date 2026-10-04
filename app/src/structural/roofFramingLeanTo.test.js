// L字（矩形でない）の下屋＝翼ごとの片流れ（ステップ E1a。roofFramingGeometry.js の leanToWingsOf、roofOutline の kindZones、
// extendDiagonalsToOutline の辺の途中の分岐、roofFramingLines・roofHipDiagonals の leanToDrains）のテスト。期待値は手計算（y は下向き正）。
// 翼は流れの向きと辺の種別・水下（drains）・長手方向の翼の奥行き（longDepthMm）を決めるためだけに使う。母屋・継ぎ目・面は水下への
// 距離の場（leanToDrainFraming。roofFramingLeanToDrain.test.js が形ごとに全数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leanToWingsOf, roofOutline, roofFramingLines, roofHipDiagonals,
  extendLinesToOutline, extendDiagonalsToOutline as extendDiagonalsRaw, leanToDrainFraming, purlinLayoutFromRidge,
} from './roofFramingGeometry.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const ct = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const D = (x1, y1, x2, y2, entry) => ({ x1, y1, x2, y2, entry });
const WE = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const KZ = (isVertical, coord, lo, hi, outward, kind) => ({ isVertical, coord, lo, hi, outward, kind });
const DG = (kind, x1, y1, x2, y2) => ({ kind, x1, y1, x2, y2 });
/** 翼。domain の最初は直接（rect そのもの）、ext は延長の部分。 */
const W = (highSide, wallCoord, wallEdge, depthMm, rect, ext = []) => ({
  highSide, wallCoord, wallEdge, depthMm, rect, domain: [{ ...rect, entry: 'direct' }, ...ext],
});
const wingsOf = ({ rects, contacts }) => leanToWingsOf({ rects, contacts, tolMm: TOL });
const outlineOf = (form, kindZones, eaveOverhangMm = 455, gableOverhangMm = 455) => roofOutline({
  rects: form.rects, shape: RoofShape.MONO, highSide: 'top', eaveOverhangMm, gableOverhangMm, zeroZones: form.contacts, kindZones, tolMm: TOL,
});
const Lx = (isVertical, coord, lo, hi) => ({ isVertical, coord, lo, hi });
/** 水下への距離の場（leanToDrainFraming）の結果。母屋の段の始まりは長手方向の翼の奥行きの purlinLayoutFromRidge。 */
const framingOf = ({ rects, contacts }) => {
  const w = wingsOf({ rects, contacts });
  const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: w.longDepthMm, pitchMm: 910, startOffsetsMm: [455, 910], tolMm: TOL });
  return leanToDrainFraming({ rects, drains: w.drains, pitchMm: 910, firstLevelMm: eaveGapMm, tolMm: TOL });
};
const plain = purlins => purlins.map(({ isVertical, coord, lo, hi }) => Lx(isVertical, coord, lo, hi));

// ---- 形（設計書 §1.6）。座標は mm ----
// 形1a: 出隅回り込み・奥行きが同じ。屋内 [0,3640]² の下と右に下屋が回り込む
const F1A = { rects: [rc(0, 3640, 3640, 5460), rc(3640, 3640, 5460, 5460), rc(3640, 0, 5460, 3640)], contacts: [ct(false, 3640, 0, 3640, -1), ct(true, 3640, 0, 3640, -1)] };
// 形1b: 出隅回り込み・奥行きが違う（下の腕が 3640）
const F1B = { rects: [rc(0, 3640, 5460, 7280), rc(3640, 0, 5460, 3640)], contacts: [ct(false, 3640, 0, 3640, -1), ct(true, 3640, 0, 3640, -1)] };
// 形2: 1つの壁・出っ張り（上辺 y=0 が全長で屋内に接する）
const F2 = { rects: [rc(0, 0, 5460, 1820), rc(3640, 1820, 5460, 3640)], contacts: [ct(false, 0, 0, 5460, -1)] };
// 形3: 入隅にはまった下屋（上辺 5460 と左辺 3640 が接する。上辺が長いので先）
const F3 = { rects: [rc(0, 0, 5460, 1820), rc(0, 1820, 1820, 3640)], contacts: [ct(false, 0, 0, 5460, -1), ct(true, 0, 0, 3640, -1)] };
// 形4: 屋内に接しない（形2と同じ範囲）
const F4 = { rects: F2.rects, contacts: [] };
// 形5: 谷木が出る（上辺 [1820,5460] と左辺 [0,3640]。同じ長さで top が先）
const F5 = { rects: F3.rects, contacts: [ct(false, 0, 1820, 5460, -1), ct(true, 0, 0, 3640, -1)] };
// 形6: 既存の L字（makeGrid [[1,1],[2,1],[1,2]]・屋内なし）。外接 4000×3000 → 横長なので top
const F6 = { rects: [rc(2000, 1500, 4000, 3000), rc(4000, 1500, 6000, 3000), rc(2000, 3000, 4000, 4500)], contacts: [] };
// 形7: 取り残し（上辺のうち [0,1820] だけが屋内に接する）
const F7 = { rects: F2.rects, contacts: [ct(false, 0, 0, 1820, -1)] };
// roof-test1.stq の2階の下屋（5セル。S0 の実測。形1b と同じ配置で、壁（左）が 6244 と長い）
const FRT1 = {
  rects: [rc(3640, -3640, 7280, 0), rc(7280, -3640, 9100, 0), rc(7280, -7280, 9100, -3640), rc(7280, -9884, 9100, -9100), rc(7280, -9100, 9100, -7280)],
  contacts: [ct(true, 7280, -9884, -9100, -1), ct(false, -3640, 3640, 7280, -1), ct(true, 7280, -7280, -3640, -1), ct(true, 7280, -9100, -7280, -1)],
};

// ---- leanToWingsOf・roofOutline（形ごとに全数） ----

test('形1a: 翼2枚（top と left が壁の角で回り込む）。回り込みの部分は入り口が近い翼が持つ。水下は外の2辺', () => {
  const r = wingsOf(F1A);
  assert.deepEqual(r.wings, [
    W('top', 3640, WE(false, 3640, 0, 3640, -1), 1820, rc(0, 3640, 3640, 5460), [D(3640, 3640, 5460, 5460, 'left')]),
    W('left', 3640, WE(true, 3640, 0, 3640, -1), 1820, rc(3640, 0, 5460, 3640), [D(3640, 3640, 5460, 5460, 'top')]),
  ]);
  assert.deepEqual(r.unassigned, []);
  assert.deepEqual(r.kindZones, [
    KZ(false, 0, 3640, 5460, -1, 'gable'), KZ(true, 5460, 0, 5460, 1, 'eave'), KZ(false, 5460, 0, 5460, 1, 'eave'),
    KZ(true, 0, 3640, 5460, -1, 'gable'), KZ(false, 3640, 0, 3640, -1, 'eave'), KZ(true, 3640, 0, 3640, -1, 'eave'),
  ]);
  const o = outlineOf(F1A, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [5915, -455, 5915, 5915, -455, 5915, -455, 3640, 3640, 3640, 3640, -455] }]);
  const fr = framingOf(F1A);
  assert.deepEqual(plain(fr.purlins), [Lx(false, 4550, 0, 4550), Lx(true, 4550, 0, 4550)]);
  assert.deepEqual(extendDiagonalsRaw({ diagonals: fr.diagonals, edges: o.edges, tolMm: TOL }), [DG('hip', 5915, 5915, 3640, 3640)], '普通の角の規則（midEdge 不要）');
});

test('形1b: 奥行きが違う（下の腕 3640・右の腕 1820）。辺の種別は新規則、水下は右辺・下辺の全長', () => {
  const r = wingsOf(F1B);
  assert.deepEqual(r.wings, [
    W('top', 3640, WE(false, 3640, 0, 3640, -1), 3640, rc(0, 3640, 3640, 7280), [D(3640, 3640, 5460, 7280, 'left')]),
    W('left', 3640, WE(true, 3640, 0, 3640, -1), 1820, rc(3640, 0, 5460, 3640), [D(3640, 3640, 5460, 7280, 'top')]),
  ]);
  assert.deepEqual(r.unassigned, []);
  // 辺の種別は「内側のセルを含むどれかの翼の壁と平行なら軒」（新規則）。右辺 x=5460 の下の腕の部分（y 5460..7280）は、下の腕（top の翼。流れは
  // +y で右辺と平行）だけでなく右の腕の延長（left の翼。流れは +x で右辺と直交）も含むので軒になる（旧規則は所有者の流れだけで「けらば」だった）
  assert.deepEqual(r.kindZones, [
    KZ(false, 0, 3640, 5460, -1, 'gable'), KZ(true, 5460, 0, 7280, 1, 'eave'),
    KZ(false, 7280, 0, 5460, 1, 'eave'), KZ(true, 0, 3640, 7280, -1, 'gable'), KZ(false, 3640, 0, 3640, -1, 'eave'), KZ(true, 3640, 0, 3640, -1, 'eave'),
  ]);
  assert.deepEqual(r.drains, [WE(true, 5460, 0, 7280, 1), WE(false, 7280, 0, 5460, 1)], '水下＝右辺の全長と下辺の全長');
  assert.equal(r.longDepthMm, 1820, '最も長い水下（右辺 7280）へ流れる翼＝右の腕（奥行き 1820）');
  const o = outlineOf(F1B, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [5915, -455, 5915, 7735, -455, 7735, -455, 3640, 3640, 3640, 3640, -455] }]);
  const fr = framingOf(F1B);
  assert.deepEqual(extendDiagonalsRaw({ diagonals: fr.diagonals, edges: o.edges, tolMm: TOL }), [DG('hip', 5915, 7735, 1820, 3640)]);
});

test('形1b（軒の出 600・妻側 300）: 右辺は全部軒（600）になり段差が無い（旧規則は右辺の下の腕の部分がけらば 300 で、辺の途中に段差があった）。水下と水下の外の角の隅木は軒の出 600 だけ延び、母屋の延長はけらば側が妻側の出幅 300', () => {
  const r = wingsOf(F1B);
  const o = outlineOf(F1B, r.kindZones, 600, 300);
  assert.deepEqual(o.outline, [{ points: [6060, -300, 6060, 7880, -300, 7880, -300, 3640, 3640, 3640, 3640, -300] }]);
  const fr = framingOf(F1B);
  assert.deepEqual(extendLinesToOutline({ lines: fr.purlins, edges: o.edges, tolMm: TOL }).map(l => [l.isVertical, l.coord, l.lo, l.hi]), [
    [false, 4550, -300, 2730], [false, 5460, -300, 3640], [false, 6370, -300, 4550], [true, 2730, 3640, 4550], [true, 3640, 3640, 5460], [true, 4550, -300, 6370],
  ], '左端が x=0（けらば・300）の横線は -300、上端が y=0（けらば・300）の縦線 x=4550 は -300');
  assert.deepEqual(extendDiagonalsRaw({ diagonals: fr.diagonals, edges: o.edges, valleys: true, tolMm: TOL }), [DG('hip', 6060, 7880, 1820, 3640)]);
});

test('形2: 1つの壁・奥行きが違う2枚（同じ壁の top）。水下は y=1820（x 0..3640）と y=3640（x 3640..5460）の段違い', () => {
  const r = wingsOf(F2);
  assert.deepEqual(r.wings, [
    W('top', 0, WE(false, 0, 0, 3640, -1), 1820, rc(0, 0, 3640, 1820)),
    W('top', 0, WE(false, 0, 3640, 5460, -1), 3640, rc(3640, 0, 5460, 3640)),
  ]);
  assert.deepEqual(r.unassigned, []);
  assert.deepEqual(r.kindZones, [
    KZ(false, 0, 0, 5460, -1, 'eave'), KZ(true, 5460, 0, 3640, 1, 'gable'), KZ(false, 3640, 3640, 5460, 1, 'eave'),
    KZ(true, 3640, 1820, 3640, -1, 'gable'), KZ(false, 1820, 0, 3640, 1, 'eave'), KZ(true, 0, 0, 1820, -1, 'gable'),
  ]);
  assert.deepEqual(r.drains, [WE(false, 3640, 3640, 5460, 1), WE(false, 1820, 0, 3640, 1)]);
  const o = outlineOf(F2, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [5915, 0, 5915, 4095, 3185, 4095, 3185, 2275, -455, 2275, -455, 0] }]);
});

test('形3: 入隅にはまった下屋。left は全行が取られて翼にならない（優先順は辺の長さ）', () => {
  const r = wingsOf(F3);
  assert.deepEqual(r.wings, [
    W('top', 0, WE(false, 0, 0, 1820, -1), 3640, rc(0, 0, 1820, 3640)),
    W('top', 0, WE(false, 0, 1820, 5460, -1), 1820, rc(1820, 0, 5460, 1820)),
  ]);
  assert.deepEqual(r.unassigned, []);
  assert.deepEqual(r.kindZones, [
    KZ(false, 0, 0, 5460, -1, 'eave'), KZ(true, 5460, 0, 1820, 1, 'gable'), KZ(false, 1820, 1820, 5460, 1, 'eave'),
    KZ(true, 1820, 1820, 3640, 1, 'gable'), KZ(false, 3640, 0, 1820, 1, 'eave'), KZ(true, 0, 0, 3640, -1, 'gable'),
  ]);
  const o = outlineOf(F3, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [5915, 0, 5915, 2275, 2275, 2275, 2275, 4095, 0, 4095, 0, 0] }]);
});

test('形4: 屋内に接しない下屋は外接矩形が横長なので top の仮の壁（上の端の辺）。翼は形2と同じで、外形線の上辺も出幅 455（壁に当たらない）', () => {
  const r = wingsOf(F4);
  assert.deepEqual(r.wings, wingsOf(F2).wings);
  assert.deepEqual(r.kindZones, wingsOf(F2).kindZones);
  assert.deepEqual(r.drains, wingsOf(F2).drains);
  assert.deepEqual(outlineOf(F4, r.kindZones).outline, [{ points: [5915, -455, 5915, 4095, 3185, 4095, 3185, 2275, -455, 2275, -455, -455] }]);
});

test('形5: 壁のある翼が別の翼の延長に遠い側から入られる＝谷木。延長の印で left の行0は掃けず行1だけ翼になる。谷木は軒先の入隅の角まで延ばせる', () => {
  const r = wingsOf(F5);
  assert.deepEqual(r.wings, [
    W('top', 0, WE(false, 0, 1820, 5460, -1), 1820, rc(1820, 0, 5460, 1820), [D(0, 0, 1820, 1820, 'right')]),
    W('left', 0, WE(true, 0, 1820, 3640, -1), 1820, rc(0, 1820, 1820, 3640), [D(0, 0, 1820, 1820, 'bottom')]),
  ]);
  assert.deepEqual(r.unassigned, []);
  assert.deepEqual(r.kindZones, [
    KZ(false, 0, 0, 5460, -1, 'eave'), KZ(true, 5460, 0, 1820, 1, 'gable'), KZ(false, 1820, 1820, 5460, 1, 'eave'),
    KZ(true, 1820, 1820, 3640, 1, 'eave'), KZ(false, 3640, 0, 1820, 1, 'gable'), KZ(true, 0, 0, 3640, -1, 'eave'),
  ]);
  const o = outlineOf(F5, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [1820, -455, 1820, 0, 5915, 0, 5915, 2275, 2275, 2275, 2275, 4095, 0, 4095, 0, -455] }]);
  const fr = framingOf(F5);
  assert.deepEqual(fr.diagonals, [DG('valley', 1820, 1820, 0, 0)]);
  assert.deepEqual(extendDiagonalsRaw({ diagonals: fr.diagonals, edges: o.edges, tolMm: TOL }), fr.diagonals, '既定（valleys なし）は谷木を延ばさない');
});

test('形6: 既存の L字（屋内なし）。奥行き 3000 の翼と 1500 の翼。水下は同長（2000）で、長手の奥行きは番号の小さい翼の 3000', () => {
  const r = wingsOf(F6);
  assert.deepEqual(r.wings, [
    W('top', 1500, WE(false, 1500, 2000, 4000, -1), 3000, rc(2000, 1500, 4000, 4500)),
    W('top', 1500, WE(false, 1500, 4000, 6000, -1), 1500, rc(4000, 1500, 6000, 3000)),
  ]);
  assert.deepEqual(r.unassigned, []);
  assert.deepEqual(r.kindZones, [
    KZ(false, 1500, 2000, 6000, -1, 'eave'), KZ(true, 6000, 1500, 3000, 1, 'gable'), KZ(false, 3000, 4000, 6000, 1, 'eave'),
    KZ(true, 4000, 3000, 4500, 1, 'gable'), KZ(false, 4500, 2000, 4000, 1, 'eave'), KZ(true, 2000, 1500, 4500, -1, 'gable'),
  ]);
  assert.equal(r.longDepthMm, 3000);
  const o = outlineOf(F6, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [6455, 1045, 6455, 3455, 4455, 3455, 4455, 4955, 1545, 4955, 1545, 1045] }]);
});

test('形7: 屋内に接する区間が短い。直接の翼は1枚で、延長が右へ届き、延長も届かない所は取り残し（外形線では軒）', () => {
  const r = wingsOf(F7);
  assert.deepEqual(r.wings, [W('top', 0, WE(false, 0, 0, 1820, -1), 1820, rc(0, 0, 1820, 1820), [D(1820, 0, 5460, 1820, 'left')])]);
  assert.deepEqual(r.unassigned, [rc(3640, 1820, 5460, 3640)]);
  assert.deepEqual(r.kindZones, [
    KZ(false, 0, 0, 5460, -1, 'eave'), KZ(true, 5460, 0, 1820, 1, 'gable'), KZ(true, 5460, 1820, 3640, 1, 'eave'),
    KZ(false, 3640, 3640, 5460, 1, 'eave'), KZ(true, 3640, 1820, 3640, -1, 'eave'), KZ(false, 1820, 0, 3640, 1, 'eave'), KZ(true, 0, 0, 1820, -1, 'gable'),
  ]);
  const o = outlineOf(F7, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [1820, 0, 1820, -455, 5915, -455, 5915, 4095, 3185, 4095, 3185, 2275, -455, 2275, -455, 0] }]);
});

test('roof-test1.stq の2階の下屋（S0 実測）: 左の壁（6244）が先・top の壁が後。形1b と同じ配置。右辺は全長が軒（旧規則は y -1820..0 がけらば）。水下は右辺と下辺', () => {
  const r = wingsOf(FRT1);
  assert.deepEqual(r.wings, [
    W('left', 7280, WE(true, 7280, -9884, -3640, -1), 1820, rc(7280, -9884, 9100, -3640), [D(7280, -3640, 9100, 0, 'top')]),
    W('top', -3640, WE(false, -3640, 3640, 7280, -1), 3640, rc(3640, -3640, 7280, 0), [D(7280, -3640, 9100, 0, 'left')]),
  ]);
  assert.deepEqual(r.unassigned, []);
  assert.deepEqual(r.kindZones, [
    KZ(false, -9884, 7280, 9100, -1, 'gable'), KZ(true, 9100, -9884, 0, 1, 'eave'),
    KZ(false, 0, 3640, 9100, 1, 'eave'), KZ(true, 3640, -3640, 0, -1, 'gable'), KZ(false, -3640, 3640, 7280, -1, 'eave'), KZ(true, 7280, -9884, -3640, -1, 'eave'),
  ]);
  assert.deepEqual(r.drains, [WE(true, 9100, -9884, 0, 1), WE(false, 0, 3640, 9100, 1)]);
  assert.equal(r.longDepthMm, 1820, '長手方向の水下＝右辺 9884。そこへ流れる翼 W1（奥行き 1820）→ 軒までの残り r=910');
  // 水下への距離の場（設計の期待値）: 隅木 (9100,0)→(5460,-3640)、母屋6本、面2つ
  const fr = framingOf(FRT1);
  assert.deepEqual(fr.ridges, []);
  assert.deepEqual(plain(fr.purlins), [
    Lx(false, -2730, 3640, 6370), Lx(false, -1820, 3640, 7280), Lx(false, -910, 3640, 8190),
    Lx(true, 6370, -3640, -2730), Lx(true, 7280, -3640, -1820), Lx(true, 8190, -9884, -910),
  ]);
  assert.deepEqual(fr.diagonals, [DG('hip', 9100, 0, 5460, -3640)]);
  assert.deepEqual(fr.faces.map(f => [f.drain, f.lineIsVertical, plain(f.lines)]), [
    [WE(true, 9100, -9884, 0, 1), true, [Lx(true, 6370, -3640, -2730), Lx(true, 7280, -3640, -1820), Lx(true, 8190, -9884, -910)]],
    [WE(false, 0, 3640, 9100, 1), false, [Lx(false, -2730, 3640, 6370), Lx(false, -1820, 3640, 7280), Lx(false, -910, 3640, 8190)]],
  ]);
  const o0 = outlineOf(FRT1, r.kindZones);
  assert.deepEqual(extendDiagonalsRaw({ diagonals: fr.diagonals, edges: o0.edges, valleys: true, tolMm: TOL }), [DG('hip', 9555, 455, 5460, -3640)], '軒先の角 (9555,455) まで');
  const o = outlineOf(FRT1, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [9555, -10339, 9555, 455, 3185, 455, 3185, -3640, 7280, -3640, 7280, -10339] }]);
});

// ---- 矩形との一致（R1〜R3）: 矩形の屋根範囲を L字の入口に通しても、矩形の式と同じになる ----

const RECT = rc(0, 0, 4000, 3000);
const viaWings = (contacts, highSide) => {
  const r = wingsOf({ rects: [RECT], contacts });
  const direct = roofFramingLines({ rect: RECT, shape: RoofShape.MONO, highSide, purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL });
  return { r, direct };
};

test('R1: 上辺が全長で屋内に接する矩形は、矩形の片流れ（top）の母屋 y=455・1365・2275 と一致。外形線も roofOutline（片流れ top）と一致', () => {
  const contacts = [ct(false, 0, 0, 4000, -1)];
  const { r, direct } = viaWings(contacts, 'top');
  assert.equal(r.wings.length, 1);
  assert.deepEqual(direct.purlins.map(l => l.coord), [455, 1365, 2275], '前提: 矩形の式');
  assert.deepEqual(plain(framingOf({ rects: [RECT], contacts }).purlins), direct.purlins);
  const viaKind = roofOutline({ rects: [RECT], shape: RoofShape.MONO, highSide: 'top', eaveOverhangMm: 600, gableOverhangMm: 300, zeroZones: contacts, kindZones: r.kindZones, tolMm: TOL });
  const viaShape = roofOutline({ rects: [RECT], shape: RoofShape.MONO, highSide: 'top', eaveOverhangMm: 600, gableOverhangMm: 300, zeroZones: contacts, tolMm: TOL });
  assert.deepEqual(viaKind, viaShape);
});

test('R2: 上辺の一部（1000）と左辺の全長（3000）が接する矩形は、長い左辺が壁＝矩形の片流れ（left）の母屋 x=455・1365・2275・3185 と一致', () => {
  const contacts = [ct(false, 0, 1000, 2000, -1), ct(true, 0, 0, 3000, -1)];
  const { r } = viaWings(contacts, 'left');
  assert.equal(r.wings.length, 1);
  assert.equal(r.wings[0].highSide, 'left');
  const direct = roofFramingLines({ rect: RECT, shape: RoofShape.MONO, highSide: 'left', purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL });
  assert.deepEqual(direct.purlins.map(l => l.coord), [455, 1365, 2275, 3185], '前提: 矩形の式');
  assert.deepEqual(plain(framingOf({ rects: [RECT], contacts }).purlins), direct.purlins);
  const kind = outlineOf({ rects: [RECT], contacts }, r.kindZones);
  const shape = roofOutline({ rects: [RECT], shape: RoofShape.MONO, highSide: 'left', eaveOverhangMm: 455, gableOverhangMm: 455, zeroZones: contacts, tolMm: TOL });
  assert.deepEqual(kind, shape);
});

test('R3: 向かい合う辺（上 [0,1000]・下 [3000,4000]）が同じ長さで接する矩形は、top が先に取り、下の翼は top の延長に塞がれて翼にならない', () => {
  const contacts = [ct(false, 0, 0, 1000, -1), ct(false, 3000, 3000, 4000, 1)];
  const { r, direct } = viaWings(contacts, 'top');
  assert.equal(r.wings.length, 1);
  assert.equal(r.wings[0].highSide, 'top');
  assert.deepEqual(r.wings[0].domain.map(f => f.entry), ['direct', 'left']);
  assert.deepEqual(plain(framingOf({ rects: [RECT], contacts }).purlins), direct.purlins);
});

// ---- 優先順・仮の壁・区間の扱い ----

test('壁の区間: 隙間が許容差以下の接触は1つの壁に併合。外周の辺に載らない接触は捨てて仮の壁（外接が縦長なら left）', () => {
  const box = rc(0, 0, 4000, 3000);
  const merged = leanToWingsOf({ rects: [box], contacts: [ct(false, 0, 0, 2000, -1), ct(false, 0, 2000.3, 4000, -1)], tolMm: TOL });
  assert.equal(merged.wings.length, 1);
  assert.deepEqual(merged.wings[0].wallEdge, WE(false, 0, 0, 4000, -1));
  const inside = leanToWingsOf({ rects: [rc(0, 0, 2000, 5000)], contacts: [ct(false, 2500, 0, 2000, -1)], tolMm: TOL });
  assert.equal(inside.wings.length, 1, '外周に載らない接触は捨て、仮の壁');
  assert.equal(inside.wings[0].highSide, 'left', '縦長の外接は left');
  assert.deepEqual(inside.wings[0].wallEdge, WE(true, 0, 0, 5000, -1));
  assert.deepEqual(inside.wings[0].rect, rc(0, 0, 2000, 5000));
});

// ---- 入口（roofFramingLines・roofHipDiagonals）と既存の挙動 ----

test('roofFramingLines・roofHipDiagonals: leanToDrains を渡すと rect=null の L字（片流れ・切妻）の水下の場の母屋・継ぎ目を返す。渡さなければ今まで通り空', () => {
  const w = wingsOf(F1B);
  const base = { rect: null, rects: F1B.rects, shape: RoofShape.MONO, ridgeIsVertical: null, highSide: null, purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL };
  const viaDrains = { leanToDrains: w.drains, leanToPurlinDepthMm: w.longDepthMm };
  const fr = framingOf(F1B);
  assert.deepEqual(roofFramingLines({ ...base, ...viaDrains }), { ridges: fr.ridges, purlins: fr.purlins });
  assert.ok(fr.purlins.length > 0, '前提: 線が空でない');
  assert.deepEqual(roofFramingLines(base), { ridges: [], purlins: [] }, '渡さなければ空（矩形でない片流れは小屋組なし）');
  assert.deepEqual(roofHipDiagonals({ rect: null, rects: F1B.rects, shape: RoofShape.MONO, leanToDrains: w.drains, tolMm: TOL }), fr.diagonals);
  assert.deepEqual(roofHipDiagonals({ rect: null, rects: F1B.rects, shape: RoofShape.MONO, tolMm: TOL }), []);
  // 切妻の L字（腕ごとに棟木）も同じ入口（水下を渡せば形状は問わない）。水下を渡さない切妻は空のまま
  assert.deepEqual(roofHipDiagonals({ rect: null, rects: F1B.rects, shape: RoofShape.GABLE, leanToDrains: w.drains, tolMm: TOL }), fr.diagonals, '形状は問わない');
  assert.deepEqual(roofFramingLines({ ...base, shape: RoofShape.GABLE, ...viaDrains }), { ridges: fr.ridges, purlins: fr.purlins }, '形状は問わない');
  assert.deepEqual(roofHipDiagonals({ rect: null, rects: F1B.rects, shape: RoofShape.GABLE, tolMm: TOL }), [], '水下が無い切妻は空');
  assert.deepEqual(roofFramingLines({ ...base, shape: RoofShape.GABLE }), { ridges: [], purlins: [] }, '水下が無い切妻は空');
  // rect があれば矩形の式（leanToDrains は無視）
  const rectCase = roofFramingLines({ rect: RECT, shape: RoofShape.MONO, highSide: 'top', ...viaDrains, purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL });
  assert.deepEqual(rectCase.purlins.map(l => l.coord), [455, 1365, 2275]);
  // 【失敗系】水下があるのに母屋の段の基準（奥行き）が無い・不正は RangeError
  assert.throws(() => roofFramingLines({ ...base, leanToDrains: w.drains }), RangeError, '奥行き無し');
  assert.throws(() => roofFramingLines({ ...base, leanToDrains: w.drains, leanToPurlinDepthMm: 0 }), RangeError, '奥行き 0');
  assert.throws(() => roofFramingLines({ ...base, leanToDrains: [{ isVertical: true }], leanToPurlinDepthMm: 1820 }), RangeError, '水下が不正');
  assert.throws(() => roofHipDiagonals({ rect: null, rects: F1B.rects, shape: RoofShape.MONO, leanToDrains: [{}], tolMm: TOL }), RangeError, '水下が不正');
  assert.deepEqual(roofHipDiagonals({ rect: null, rects: F1B.rects, shape: RoofShape.MONO, leanToDrains: 'x', tolMm: TOL }), [], '配列でない水下は渡さないのと同じ');
});

test('extendDiagonalsToOutline: 軒側の端が1本の辺の途中にあるとき、midEdge=true ならその部分の出幅の最小だけ延ばす（縦の辺・横の辺とも）。出幅 0 と谷木は延ばさない', () => {
  const extend = args => extendDiagonalsRaw({ midEdge: true, ...args });
  const vEdge = overhang => [{ isVertical: true, coord: 100, lo: 0, hi: 500, outward: 1, overhangMm: overhang }];
  const hEdge = overhang => [{ isVertical: false, coord: 100, lo: 0, hi: 500, outward: 1, overhangMm: overhang }];
  const hip = DG('hip', 100, 100, 0, 0); // 外へ(+x,+y)延びる向き。x1 は x=100 の縦の辺（外側 +1）の上、y1 は y=100 の横の辺の上
  assert.deepEqual(extend({ diagonals: [hip], edges: vEdge(300), tolMm: TOL }), [DG('hip', 400, 400, 0, 0)]);
  assert.deepEqual(extend({ diagonals: [hip], edges: hEdge(300), tolMm: TOL }), [DG('hip', 400, 400, 0, 0)]);
  assert.deepEqual(extend({ diagonals: [hip], edges: vEdge(0), tolMm: TOL }), [hip], '出幅 0 は延ばさない');
  const twoParts = [{ ...vEdge(600)[0], lo: 0, hi: 100 }, { ...vEdge(300)[0], lo: 100, hi: 500 }]; // 段差の境目 y=100 は小さい出幅
  assert.deepEqual(extend({ diagonals: [hip], edges: twoParts, tolMm: TOL }), [DG('hip', 400, 400, 0, 0)]);
  const valley = DG('valley', 100, 100, 0, 0);
  assert.deepEqual(extend({ diagonals: [valley], edges: vEdge(300), tolMm: TOL }), [valley]);
  assert.deepEqual(extend({ diagonals: [hip], edges: [], tolMm: TOL }), [hip], '辺が無ければ延ばさない');
  // 既定（midEdge なし）は今まで通り: 片方の辺の上だけでは延ばさない（寄棟の既存の規則）
  assert.deepEqual(extendDiagonalsRaw({ diagonals: [hip], edges: vEdge(300), tolMm: TOL }), [hip]);
  assert.deepEqual(extendDiagonalsRaw({ diagonals: [hip], edges: vEdge(300), midEdge: false, tolMm: TOL }), [hip]);
  const both = [vEdge(300)[0], hEdge(300)[0]];
  assert.deepEqual(extendDiagonalsRaw({ diagonals: [hip], edges: both, tolMm: TOL }), [DG('hip', 400, 400, 0, 0)], '両辺が揃えば既定でも延びる');
});

// ---- 失敗系 ----

test('【失敗系】leanToWingsOf: 許容差・rects・contacts が不正なら RangeError（outward ±1 以外・非有限・lo>hi・配列でない・座標が逆順）', () => {
  const ok = { rects: [RECT], contacts: [], tolMm: TOL };
  assert.throws(() => leanToWingsOf({ ...ok, tolMm: -1 }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, tolMm: NaN }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, rects: null }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, rects: [rc(0, 0, NaN, 10)] }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, rects: [rc(10, 0, 0, 10)] }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, contacts: null }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, contacts: [ct(false, 0, 0, 100, 2)] }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, contacts: [ct(false, 0, 0, 100, 0)] }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, contacts: [ct(false, NaN, 0, 100, -1)] }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, contacts: [ct(false, 0, 100, 0, -1)] }), RangeError);
  assert.throws(() => leanToWingsOf({ ...ok, contacts: [{ coord: 0, lo: 0, hi: 100, outward: -1 }] }), RangeError, 'isVertical が無い');
});

test('【失敗系】leanToWingsOf: 使える矩形が無い（空・幅か高さが許容差以下）は空を返す（例外にしない）', () => {
  const empty = { wings: [], unassigned: [], kindZones: [], drains: [], longDepthMm: null };
  assert.deepEqual(leanToWingsOf({ rects: [], contacts: [], tolMm: TOL }), empty);
  assert.deepEqual(leanToWingsOf({ rects: [rc(0, 0, 0.2, 100)], contacts: [ct(false, 0, 0, 100, -1)], tolMm: TOL }), empty);
});

test('【失敗系】roofOutline: kindZones が辺を覆わない・kind が不正・配列でないは RangeError。null は今まで通り（省略と同じ）', () => {
  const r = wingsOf(F1A);
  assert.throws(() => outlineOf(F1A, r.kindZones.slice(1)), RangeError, '先頭の辺の部分が欠ける');
  assert.throws(() => outlineOf(F1A, []), RangeError, '全部欠ける');
  assert.throws(() => outlineOf(F1A, r.kindZones.map((z, i) => (i === 0 ? { ...z, hi: z.hi - 1000 } : z))), RangeError, '辺の途中までしか覆わない');
  assert.throws(() => outlineOf(F1A, r.kindZones.map((z, i) => (i === 0 ? { ...z, kind: 'ridge' } : z))), RangeError, 'kind 不正');
  assert.throws(() => outlineOf(F1A, 'eave'), RangeError);
  const shape = { rects: [RECT], shape: RoofShape.GABLE, ridgeIsVertical: false, eaveOverhangMm: 600, gableOverhangMm: 300, tolMm: TOL };
  assert.deepEqual(roofOutline({ ...shape, kindZones: null }), roofOutline(shape), 'null は省略と同じ（今の式）');
  // kindZones があれば shape の検査（roofEdgeKind）は呼ばない（片流れの highSide が無くても通る）
  const noHighSide = roofOutline({ rects: [RECT], shape: RoofShape.MONO, highSide: null, eaveOverhangMm: 455, gableOverhangMm: 455, kindZones: wingsOf({ rects: [RECT], contacts: [] }).kindZones, tolMm: TOL });
  assert.equal(noHighSide.outline.length, 1);
  assert.throws(() => roofOutline({ rects: [RECT], shape: RoofShape.MONO, highSide: null, eaveOverhangMm: 455, gableOverhangMm: 455, tolMm: TOL }), RangeError, 'kindZones なしは highSide 必須');
});
