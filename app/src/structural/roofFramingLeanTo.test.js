// L字（矩形でない）の下屋＝翼ごとの片流れ（ステップ E1a。roofFramingGeometry.js の leanToWingsOf・leanToOwnerAt・
// leanToMonoLines・leanToMonoPlanes（E2a）・leanToSeams、roofOutline の kindZones、extendDiagonalsToOutline の辺の途中の分岐、roofFramingLines・
// roofHipDiagonals の leanToDrains）のテスト。期待値は手計算（y は下向き正）。leanToMonoLines・leanToMonoPlanes・leanToSeams・leanToOwnerAt は
// 翼ごとの母屋（割付は下屋全体で1つ＝最大奥行きの翼の割付）で、小屋梁がまだ使う（ステップ2で水下の場へ切り替えて削除）。
// 描画の母屋・継ぎ目は水下への距離の場（leanToDrainFraming。roofFramingLeanToDrain.test.js が形ごとに全数）。
// 割付（ピッチ910・1本目の候補 [455,910]）: 奥行き1820→[910]、3000→[455,1365,2275]、3640→[910,1820,2730]、4000→[455,1365,2275,3185]。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leanToWingsOf, leanToOwnerAt, leanToMonoLines, leanToMonoPlanes, leanToSeams, roofOutline, roofFramingLines, roofHipDiagonals,
  extendLinesToOutline, extendDiagonalsToOutline as extendDiagonalsRaw, leanToDrainFraming, purlinLayoutFromRidge,
} from './roofFramingGeometry.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const ct = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const D = (x1, y1, x2, y2, entry) => ({ x1, y1, x2, y2, entry });
const WE = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const KZ = (isVertical, coord, lo, hi, outward, kind) => ({ isVertical, coord, lo, hi, outward, kind });
const PL = (isVertical, coord, lo, hi, offsetMm) => ({ isVertical, coord, lo, hi, offsetMm });
const DG = (kind, x1, y1, x2, y2) => ({ kind, x1, y1, x2, y2 });
/** 翼。domain の最初は直接（rect そのもの）、ext は延長の部分。 */
const W = (highSide, wallCoord, wallEdge, depthMm, rect, ext = []) => ({
  highSide, wallCoord, wallEdge, depthMm, rect, domain: [{ ...rect, entry: 'direct' }, ...ext],
});
const wingsOf = ({ rects, contacts }) => leanToWingsOf({ rects, contacts, tolMm: TOL });
const monoLines = wings => leanToMonoLines({ wings, pitchMm: 910, startOffsetsMm: [455, 910], tolMm: TOL });
const seamsOf = wings => leanToSeams({ wings, tolMm: TOL });
const outlineOf = (form, kindZones, eaveOverhangMm = 455, gableOverhangMm = 455) => roofOutline({
  rects: form.rects, shape: RoofShape.MONO, highSide: 'top', eaveOverhangMm, gableOverhangMm, zeroZones: form.contacts, kindZones, tolMm: TOL,
});
const Lx = (isVertical, coord, lo, hi) => ({ isVertical, coord, lo, hi });
/** L字の下屋の継ぎ目の延長（midEdge あり。旧い継ぎ目 leanToSeams は軒側の端が辺の途中にある。新しい隅木・谷木は valleys: true を足して渡す）。 */
const extendDiagonalsToOutline = args => extendDiagonalsRaw({ midEdge: true, ...args });
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

// ---- leanToWingsOf・leanToMonoLines・leanToSeams・roofOutline（形ごとに全数） ----

test('形1a: 翼2枚（top と left が壁の角で回り込む）。回り込みの部分は入り口が近い翼が持ち、母屋は途中まで・隅木が出る', () => {
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
  const lines = monoLines(r.wings);
  assert.deepEqual(lines.ridges, []);
  assert.deepEqual(lines.purlins, [PL(false, 4550, 0, 4550, 910), PL(true, 4550, 0, 4550, 910)]);
  assert.deepEqual(seamsOf(r.wings), { diagonals: [DG('hip', 5460, 5460, 3640, 3640)], mismatches: [] });
  const o = outlineOf(F1A, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [5915, -455, 5915, 5915, -455, 5915, -455, 3640, 3640, 3640, 3640, -455] }]);
  assert.deepEqual(extendLinesToOutline({ lines: lines.purlins, edges: o.edges, tolMm: TOL }).map(l => [l.coord, l.lo, l.hi]),
    [[4550, -455, 4550], [4550, -455, 4550]]);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: seamsOf(r.wings).diagonals, edges: o.edges, tolMm: TOL }), [DG('hip', 5915, 5915, 3640, 3640)]);
});

test('形1b: 奥行きが違う（下の腕 3640・右の腕 1820）。母屋は下屋全体の割付 [910,1820,2730] のうち奥行き未満だけ。隅木の軒側は辺の途中で、辺の出幅ぶん延びる', () => {
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
  const lines = monoLines(r.wings);
  assert.deepEqual(lines.purlins, [
    PL(false, 4550, 0, 4550, 910), PL(false, 5460, 0, 5460, 1820), PL(false, 6370, 0, 5460, 2730), PL(true, 4550, 0, 4550, 910),
  ]);
  const seams = seamsOf(r.wings);
  assert.deepEqual(seams, { diagonals: [DG('hip', 5460, 5460, 3640, 3640)], mismatches: [] });
  const o = outlineOf(F1B, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [5915, -455, 5915, 7735, -455, 7735, -455, 3640, 3640, 3640, 3640, -455] }]);
  assert.deepEqual(extendLinesToOutline({ lines: lines.purlins, edges: o.edges, tolMm: TOL }).map(l => [l.isVertical, l.coord, l.lo, l.hi]),
    [[false, 4550, -455, 4550], [false, 5460, -455, 5915], [false, 6370, -455, 5915], [true, 4550, -455, 4550]]);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: seams.diagonals, edges: o.edges, tolMm: TOL }), [DG('hip', 5915, 5915, 3640, 3640)]);
});

test('形1b（軒の出 600・妻側 300）: 右辺は全部軒（600）になり段差が無い（旧規則は右辺の下の腕の部分がけらば 300 で、辺の途中で段差があった）。水下と水下の外の角の隅木は軒の出 600 だけ延び、母屋の延長はけらば側が妻側の出幅 300', () => {
  const r = wingsOf(F1B);
  const o = outlineOf(F1B, r.kindZones, 600, 300);
  assert.deepEqual(o.outline, [{ points: [6060, -300, 6060, 7880, -300, 7880, -300, 3640, 3640, 3640, 3640, -300] }]);
  const fr = framingOf(F1B);
  assert.deepEqual(extendLinesToOutline({ lines: fr.purlins, edges: o.edges, tolMm: TOL }).map(l => [l.isVertical, l.coord, l.lo, l.hi]), [
    [false, 4550, -300, 2730], [false, 5460, -300, 3640], [false, 6370, -300, 4550], [true, 2730, 3640, 4550], [true, 3640, 3640, 5460], [true, 4550, -300, 6370],
  ], '左端が x=0（けらば・300）の横線は -300、上端が y=0（けらば・300）の縦線 x=4550 は -300');
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: fr.diagonals, edges: o.edges, valleys: true, tolMm: TOL }), [DG('hip', 6060, 7880, 1820, 3640)]);
});

test('形2: 1つの壁・奥行きが違う2枚（同じ壁の top）。母屋 y=910 は2枚をまたいで1本につながる（割付1つ）。入隅の点でけらばに載る母屋は延びる', () => {
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
  const lines = monoLines(r.wings);
  assert.deepEqual(lines.purlins, [PL(false, 910, 0, 5460, 910), PL(false, 1820, 3640, 5460, 1820), PL(false, 2730, 3640, 5460, 2730)]);
  assert.deepEqual(seamsOf(r.wings), { diagonals: [], mismatches: [] });
  const o = outlineOf(F2, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [5915, 0, 5915, 4095, 3185, 4095, 3185, 2275, -455, 2275, -455, 0] }]);
  assert.deepEqual(extendLinesToOutline({ lines: lines.purlins, edges: o.edges, tolMm: TOL }).map(l => [l.coord, l.lo, l.hi]),
    [[910, -455, 5915], [1820, 3185, 5915], [2730, 3185, 5915]]);
});

test('形3: 入隅にはまった下屋。left は全行が取られて翼にならない（優先順は辺の長さ）。母屋は割付1つで浅い翼は 910 だけ', () => {
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
  assert.deepEqual(monoLines(r.wings).purlins, [PL(false, 910, 0, 5460, 910), PL(false, 1820, 0, 1820, 1820), PL(false, 2730, 0, 1820, 2730)]);
  const o = outlineOf(F3, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [5915, 0, 5915, 2275, 2275, 2275, 2275, 4095, 0, 4095, 0, 0] }]);
  assert.deepEqual(extendLinesToOutline({ lines: monoLines(r.wings).purlins, edges: o.edges, tolMm: TOL }).map(l => [l.coord, l.lo, l.hi]),
    [[910, 0, 5915], [1820, 0, 2275], [2730, 0, 2275]]);
});

test('形4: 屋内に接しない下屋は外接矩形が横長なので top の仮の壁（上の端の辺）。翼・母屋は形2と同じで、外形線の上辺も出幅 455（壁に当たらない）', () => {
  const r = wingsOf(F4);
  assert.deepEqual(r.wings, wingsOf(F2).wings);
  assert.deepEqual(r.kindZones, wingsOf(F2).kindZones);
  assert.deepEqual(monoLines(r.wings).purlins, monoLines(wingsOf(F2).wings).purlins);
  assert.deepEqual(outlineOf(F4, r.kindZones).outline, [{ points: [5915, -455, 5915, 4095, 3185, 4095, 3185, 2275, -455, 2275, -455, -455] }]);
});

test('形5: 壁のある翼が別の翼の延長に遠い側から入られる＝谷木。延長の印で left の行0は掃けず行1だけ翼になる。谷木は延ばさない', () => {
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
  const lines = monoLines(r.wings);
  assert.deepEqual(lines.purlins, [PL(false, 910, 910, 5460, 910), PL(true, 910, 910, 3640, 910)]);
  const seams = seamsOf(r.wings);
  assert.deepEqual(seams, { diagonals: [DG('valley', 1820, 1820, 0, 0)], mismatches: [] });
  const o = outlineOf(F5, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [1820, -455, 1820, 0, 5915, 0, 5915, 2275, 2275, 2275, 2275, 4095, 0, 4095, 0, -455] }]);
  assert.deepEqual(extendLinesToOutline({ lines: lines.purlins, edges: o.edges, tolMm: TOL }).map(l => [l.isVertical, l.coord, l.lo, l.hi]),
    [[false, 910, 910, 5915], [true, 910, 910, 4095]]);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: seams.diagonals, edges: o.edges, tolMm: TOL }), seams.diagonals, '谷木は延ばさない');
});

test('形6: 既存の L字（屋内なし）。奥行き 3000 の翼と 1500 の翼。割付は 3000 の [455,1365,2275]、浅い翼は 1500 未満の 455・1365 だけ', () => {
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
  const lines = monoLines(r.wings);
  assert.deepEqual(lines.purlins, [PL(false, 1955, 2000, 6000, 455), PL(false, 2865, 2000, 6000, 1365), PL(false, 3775, 2000, 4000, 2275)]);
  const o = outlineOf(F6, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [6455, 1045, 6455, 3455, 4455, 3455, 4455, 4955, 1545, 4955, 1545, 1045] }]);
  assert.deepEqual(extendLinesToOutline({ lines: lines.purlins, edges: o.edges, tolMm: TOL }).map(l => [l.coord, l.lo, l.hi]),
    [[1955, 1545, 6455], [2865, 1545, 6455], [3775, 1545, 4455]]);
});

test('形7: 屋内に接する区間が短い。直接の翼は1枚で、延長が右へ届き、延長も届かない所は取り残し（外形線では軒）', () => {
  const r = wingsOf(F7);
  assert.deepEqual(r.wings, [W('top', 0, WE(false, 0, 0, 1820, -1), 1820, rc(0, 0, 1820, 1820), [D(1820, 0, 5460, 1820, 'left')])]);
  assert.deepEqual(r.unassigned, [rc(3640, 1820, 5460, 3640)]);
  assert.deepEqual(r.kindZones, [
    KZ(false, 0, 0, 5460, -1, 'eave'), KZ(true, 5460, 0, 1820, 1, 'gable'), KZ(true, 5460, 1820, 3640, 1, 'eave'),
    KZ(false, 3640, 3640, 5460, 1, 'eave'), KZ(true, 3640, 1820, 3640, -1, 'eave'), KZ(false, 1820, 0, 3640, 1, 'eave'), KZ(true, 0, 0, 1820, -1, 'gable'),
  ]);
  const lines = monoLines(r.wings);
  assert.deepEqual(lines.purlins, [PL(false, 910, 0, 5460, 910)]);
  const o = outlineOf(F7, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [1820, 0, 1820, -455, 5915, -455, 5915, 4095, 3185, 4095, 3185, 2275, -455, 2275, -455, 0] }]);
  assert.deepEqual(extendLinesToOutline({ lines: lines.purlins, edges: o.edges, tolMm: TOL }).map(l => [l.coord, l.lo, l.hi]), [[910, -455, 5915]]);
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
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: fr.diagonals, edges: o0.edges, valleys: true, tolMm: TOL }), [DG('hip', 9555, 455, 5460, -3640)], '軒先の角 (9555,455) まで');
  assert.deepEqual(extendLinesToOutline({ lines: fr.purlins, edges: o0.edges, tolMm: TOL }).map(l => [l.coord, l.lo, l.hi]), [
    [-2730, 3185, 6370], [-1820, 3185, 7280], [-910, 3185, 8190], [6370, -3640, -2730], [7280, -3640, -1820], [8190, -10339, -910],
  ], 'けらば側（左の辺 x=3640・上の辺 y=-9884）だけ出幅ぶん延びる');
  // 以下は小屋梁がまだ使う旧い母屋・継ぎ目（leanToMonoLines・leanToSeams。ステップ2で小屋梁を水下の面へ切り替えるまで残す）
  const lines = monoLines(r.wings);
  assert.deepEqual(lines.purlins, [
    PL(false, -2730, 3640, 8190, 910), PL(false, -1820, 3640, 9100, 1820), PL(false, -910, 3640, 9100, 2730), PL(true, 8190, -9884, -2730, 910),
  ]);
  const seams = seamsOf(r.wings);
  assert.deepEqual(seams, { diagonals: [DG('hip', 9100, -1820, 7280, -3640)], mismatches: [] });
  const o = outlineOf(FRT1, r.kindZones);
  assert.deepEqual(o.outline, [{ points: [9555, -10339, 9555, 455, 3185, 455, 3185, -3640, 7280, -3640, 7280, -10339] }]);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: seams.diagonals, edges: o.edges, tolMm: TOL }), [DG('hip', 9555, -1365, 7280, -3640)]);
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
  assert.deepEqual(plain(monoLines(r.wings).purlins), direct.purlins);
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
  assert.deepEqual(plain(monoLines(r.wings).purlins), direct.purlins);
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
  assert.deepEqual(plain(monoLines(r.wings).purlins), direct.purlins);
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

// ---- leanToOwnerAt ----

test('leanToOwnerAt: 形1a で入り口に近い翼が持つ。直接の部分はその翼、どの翼にも無い点は null', () => {
  const { wings } = wingsOf(F1A);
  assert.equal(leanToOwnerAt(wings, 5000, 4000, TOL), 1, '回り込みの部分で上の入り口（W1）に近い');
  assert.equal(leanToOwnerAt(wings, 4000, 5000, TOL), 0, '左の入り口（W0）に近い');
  assert.equal(leanToOwnerAt(wings, 0, 0, TOL), null);
  assert.equal(leanToOwnerAt(wings, 1000, 4500, TOL), 0, 'W0 の直接の部分');
  assert.equal(leanToOwnerAt(wings, 4500, 1000, TOL), 1, 'W1 の直接の部分');
  assert.equal(leanToOwnerAt(wings, 4550, 4550, TOL), 0, '入り口までの距離が同じ（対角線上）なら番号の小さい翼');
});

// ---- 継ぎ目（手で組んだ翼） ----

const WA = (extra = []) => W('top', 0, WE(false, 0, 0, 1000, -1), 2000, rc(0, 0, 1000, 2000), extra);
const WB = (wallCoord, extra = []) => W('left', wallCoord, WE(true, wallCoord, -1000, 0, -1), 2000, rc(wallCoord, -1000, 2000, 0), extra);

test('leanToSeams: 壁の座標が合わない（段違いの壁）組は描かず mismatches に返す', () => {
  const wings = [WA([D(1000, 0, 2000, 2000, 'left')]), WB(900, [D(1000, 0, 2000, 2000, 'top')])];
  const r = seamsOf(wings);
  assert.deepEqual(r.diagonals, []);
  assert.deepEqual(r.mismatches, [{ wingA: 0, wingB: 1, x1: 1000, y1: 0, x2: 2000, y2: 1000 }]);
  assert.deepEqual(seamsOf([WA([D(1000, 0, 2000, 2000, 'left')]), WB(1000, [D(1000, 0, 2000, 2000, 'top')])]).diagonals, [DG('hip', 2000, 1000, 1000, 0)], '壁が合えば描く');
});

test('leanToSeams: 入り口が平行（向かい合う壁）の組と、翼が1枚の延長は継ぎ目なし。同じ翼の延長どうしは組にならない', () => {
  const opposite = [
    WA([D(1000, 0, 3000, 2000, 'left')]),
    W('top', 0, WE(false, 0, 3000, 4000, -1), 2000, rc(3000, 0, 4000, 2000), [D(1000, 0, 3000, 2000, 'right')]),
  ];
  assert.deepEqual(seamsOf(opposite), { diagonals: [], mismatches: [] });
  assert.deepEqual(seamsOf([WA([D(1000, 0, 2000, 2000, 'left'), D(2000, 0, 3000, 2000, 'left')])]), { diagonals: [], mismatches: [] });
  assert.deepEqual(seamsOf([]), { diagonals: [], mismatches: [] });
});

test('leanToSeams: 同種別・同直線で接する線分は1本にまとめる（相手の翼の延長が2つに分かれていても）', () => {
  const wings = [
    WA([D(1000, 0, 3000, 2000, 'left')]),
    WB(1000, [D(1000, 0, 2000, 2000, 'top'), D(2000, 0, 3000, 2000, 'top')]),
  ];
  assert.deepEqual(seamsOf(wings).diagonals, [DG('hip', 3000, 2000, 1000, 0)]);
});

test('leanToSeams: 第3の翼の延長が自分たちより入り口に近い区間は継ぎ目から除く（C の入り口までの距離 ≥ s の区間だけ残る）', () => {
  const wings = [
    WA([D(1000, 0, 3000, 2000, 'left')]),
    WB(1000, [D(1000, 0, 3000, 2000, 'top')]),
    W('right', 2000, WE(true, 2000, 0, 2000, 1), 500, rc(1500, 0, 2000, 2000), [D(1500, 0, 2000, 2000, 'right')]),
  ];
  // C の延長は x:1500..2000（s:500..1000）だけにある。そこでは C の入り口（右）までの距離 = 2000 − x = 1000 − s ≥ s の s ≤ 500
  // しか継ぎ目でない（s:500..1000 は除かれる）。C の無い s:1000..2000（x:2000..3000）は残る
  assert.deepEqual(seamsOf(wings).diagonals, [DG('hip', 1500, 500, 1000, 0), DG('hip', 3000, 2000, 2000, 1000)]);
});

test('leanToMonoLines: 同じ点を2つの翼の延長が同じ距離で持つ（入り口が同じ側で距離が等しい）ときは番号の小さい翼が持つ', () => {
  const shared = D(1000, 0, 2000, 2000, 'left'); // どちらの翼も左の辺 x=1000 から延びてきた
  const wings = [
    W('top', 0, WE(false, 0, 0, 1000, -1), 2000, rc(0, 0, 1000, 2000), [shared]),
    W('bottom', 2000, WE(false, 2000, -1000, 0, 1), 2000, rc(-1000, 0, 0, 2000), [shared]),
  ];
  // 割付は奥行き 2000 で [455,1365]（start 455: 残り 635／start 910: 910,1820 の残り 180。残りが 910 に近い 455 を採る）
  // top の翼（番号 0）の線 y=455・1365 は延長も取る。bottom の翼（番号 1）の線 y=2000−1365=635・2000−455=1545 は直接の部分だけ
  assert.deepEqual(monoLines(wings).purlins, [
    PL(false, 455, 0, 2000, 455), PL(false, 635, -1000, 0, 1365), PL(false, 1365, 0, 2000, 1365), PL(false, 1545, -1000, 0, 455),
  ]);
});

// ---- 入口（roofFramingLines・roofHipDiagonals）と既存の挙動 ----

test('roofFramingLines・roofHipDiagonals: leanToDrains を渡すと rect=null の片流れだけ水下の場の母屋・継ぎ目を返す。渡さなければ今まで通り空', () => {
  const w = wingsOf(F1B);
  const base = { rect: null, rects: F1B.rects, shape: RoofShape.MONO, ridgeIsVertical: null, highSide: null, purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL };
  const viaDrains = { leanToDrains: w.drains, leanToPurlinDepthMm: w.longDepthMm };
  const fr = framingOf(F1B);
  assert.deepEqual(roofFramingLines({ ...base, ...viaDrains }), { ridges: fr.ridges, purlins: fr.purlins });
  assert.deepEqual(roofFramingLines(base), { ridges: [], purlins: [] }, '渡さなければ空（矩形でない片流れは小屋組なし）');
  assert.deepEqual(roofHipDiagonals({ rect: null, rects: F1B.rects, shape: RoofShape.MONO, leanToDrains: w.drains, tolMm: TOL }), fr.diagonals);
  assert.deepEqual(roofHipDiagonals({ rect: null, rects: F1B.rects, shape: RoofShape.MONO, tolMm: TOL }), []);
  assert.deepEqual(roofHipDiagonals({ rect: null, rects: F1B.rects, shape: RoofShape.GABLE, leanToDrains: w.drains, tolMm: TOL }), [], '片流れ以外は使わない');
  assert.deepEqual(roofFramingLines({ ...base, shape: RoofShape.GABLE, ...viaDrains }), { ridges: [], purlins: [] }, '片流れ以外は使わない');
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

test('extendDiagonalsToOutline: 軒側の端が1本の辺の途中にあるとき、その部分の出幅の最小だけ延ばす（縦の辺・横の辺とも）。出幅 0 と谷木は延ばさない', () => {
  const vEdge = overhang => [{ isVertical: true, coord: 100, lo: 0, hi: 500, outward: 1, overhangMm: overhang }];
  const hEdge = overhang => [{ isVertical: false, coord: 100, lo: 0, hi: 500, outward: 1, overhangMm: overhang }];
  const hip = DG('hip', 100, 100, 0, 0); // 外へ(+x,+y)延びる向き。x1 は x=100 の縦の辺（外側 +1）の上、y1 は y=100 の横の辺の上
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: [hip], edges: vEdge(300), tolMm: TOL }), [DG('hip', 400, 400, 0, 0)]);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: [hip], edges: hEdge(300), tolMm: TOL }), [DG('hip', 400, 400, 0, 0)]);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: [hip], edges: vEdge(0), tolMm: TOL }), [hip], '出幅 0 は延ばさない');
  const twoParts = [{ ...vEdge(600)[0], lo: 0, hi: 100 }, { ...vEdge(300)[0], lo: 100, hi: 500 }]; // 段差の境目 y=100 は小さい出幅
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: [hip], edges: twoParts, tolMm: TOL }), [DG('hip', 400, 400, 0, 0)]);
  const valley = DG('valley', 100, 100, 0, 0);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: [valley], edges: vEdge(300), tolMm: TOL }), [valley]);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: [hip], edges: [], tolMm: TOL }), [hip], '辺が無ければ延ばさない');
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

test('【失敗系】leanToMonoLines・leanToSeams・leanToOwnerAt: ピッチ・候補・許容差・座標・翼が不正なら RangeError。翼が空なら空', () => {
  const { wings } = wingsOf(F1A);
  const ok = { wings, pitchMm: 910, startOffsetsMm: [455, 910], tolMm: TOL };
  assert.throws(() => leanToMonoLines({ ...ok, pitchMm: 0 }), RangeError);
  assert.throws(() => leanToMonoLines({ ...ok, pitchMm: NaN }), RangeError);
  assert.throws(() => leanToMonoLines({ ...ok, startOffsetsMm: [] }), RangeError);
  assert.throws(() => leanToMonoLines({ ...ok, startOffsetsMm: [0] }), RangeError);
  assert.throws(() => leanToMonoLines({ ...ok, tolMm: -1 }), RangeError);
  assert.throws(() => leanToMonoLines({ ...ok, wings: null }), RangeError);
  assert.throws(() => leanToMonoLines({ ...ok, wings: [{ ...wings[0], highSide: 'up' }] }), RangeError);
  assert.throws(() => leanToMonoLines({ ...ok, wings: [{ ...wings[0], depthMm: 0 }] }), RangeError);
  assert.throws(() => leanToMonoLines({ ...ok, wings: [{ ...wings[0], domain: [D(0, 0, 1, 1, 'middle')] }] }), RangeError);
  assert.throws(() => leanToMonoLines({ ...ok, wings: [{ ...wings[0], domain: [D(0, 0, 1, NaN, 'direct')] }] }), RangeError);
  assert.throws(() => leanToSeams({ wings, tolMm: -1 }), RangeError);
  assert.throws(() => leanToSeams({ wings: {}, tolMm: TOL }), RangeError);
  assert.throws(() => leanToOwnerAt(wings, NaN, 0, TOL), RangeError);
  assert.throws(() => leanToOwnerAt(wings, 0, 0, -1), RangeError);
  assert.throws(() => leanToOwnerAt('x', 0, 0, TOL), RangeError);
  assert.deepEqual(leanToMonoLines({ ...ok, wings: [] }), { ridges: [], purlins: [] });
  assert.equal(leanToOwnerAt([], 0, 0, TOL), null);
});

// ---- leanToMonoPlanes（ステップ E2a。面＝同じ壁の翼の集まり） ----
const planesOf = wings => leanToMonoPlanes({ wings, pitchMm: 910, startOffsetsMm: [455, 910], tolMm: TOL });
const PN = (highSide, wallCoord, wingIndices, lineIsVertical, lines) => ({ highSide, wallCoord, wingIndices, lineIsVertical, lines });
const byLine = (a, b) => (a.isVertical === b.isVertical ? 0 : (a.isVertical ? 1 : -1)) || a.coord - b.coord || a.lo - b.lo;

test('leanToMonoPlanes 形1a: 壁の違う翼は別の面（top と left）。面の順は翼の最小番号順', () => {
  assert.deepEqual(planesOf(wingsOf(F1A).wings), [
    PN('top', 3640, [0], false, [PL(false, 4550, 0, 4550, 910)]),
    PN('left', 3640, [1], true, [PL(true, 4550, 0, 4550, 910)]),
  ]);
});

test('leanToMonoPlanes 形1b: 母屋は割付1つ。top の面が3本、left の面が1本', () => {
  assert.deepEqual(planesOf(wingsOf(F1B).wings), [
    PN('top', 3640, [0], false, [PL(false, 4550, 0, 4550, 910), PL(false, 5460, 0, 5460, 1820), PL(false, 6370, 0, 5460, 2730)]),
    PN('left', 3640, [1], true, [PL(true, 4550, 0, 4550, 910)]),
  ]);
});

test('leanToMonoPlanes 形2: 同じ壁の2翼は1つの面（wingIndices [0,1]）で、母屋 y=910 は面の中でつながる', () => {
  assert.deepEqual(planesOf(wingsOf(F2).wings), [
    PN('top', 0, [0, 1], false, [PL(false, 910, 0, 5460, 910), PL(false, 1820, 3640, 5460, 1820), PL(false, 2730, 3640, 5460, 2730)]),
  ]);
});

test('leanToMonoPlanes 形5: 谷木の形。top の面が先（翼0）・left の面が後', () => {
  assert.deepEqual(planesOf(wingsOf(F5).wings), [
    PN('top', 0, [0], false, [PL(false, 910, 910, 5460, 910)]),
    PN('left', 0, [1], true, [PL(true, 910, 910, 3640, 910)]),
  ]);
});

test('leanToMonoPlanes: 全形で、面の lines を合わせて並べ直すと leanToMonoLines の purlins と一致（形1a〜7・roof-test1・矩形）', () => {
  const forms = { F1A, F1B, F2, F3, F4, F5, F6, F7, FRT1, 矩形: { rects: [RECT], contacts: [ct(false, 0, 0, 4000, -1)] } };
  for (const [name, form] of Object.entries(forms)) {
    const { wings } = wingsOf(form);
    const planes = planesOf(wings);
    assert.deepEqual(planes.flatMap(p => p.lines).sort(byLine), monoLines(wings).purlins, name);
    assert.deepEqual(planes.flatMap(p => p.wingIndices).sort((a, b) => a - b), wings.map((_, i) => i), `${name}: 全翼がちょうど1つの面に属する`);
    for (const p of planes) {
      assert.ok(p.lines.every(l => l.isVertical === p.lineIsVertical), `${name}: 面の線の向きは面で一定`);
      assert.deepEqual(p.lines, [...p.lines].sort(byLine), `${name}: lines は sortLines 済み`);
    }
  }
});

test('leanToMonoPlanes roof-test1: 面は left（壁 7280）→ top（壁 -3640）の順', () => {
  const planes = planesOf(wingsOf(FRT1).wings);
  assert.deepEqual(planes, [
    PN('left', 7280, [0], true, [PL(true, 8190, -9884, -2730, 910)]),
    PN('top', -3640, [1], false, [PL(false, -2730, 3640, 8190, 910), PL(false, -1820, 3640, 9100, 1820), PL(false, -910, 3640, 9100, 2730)]),
  ]);
});

test('【失敗系】leanToMonoPlanes: ピッチ・候補・許容差・翼が不正なら RangeError。翼が空なら []', () => {
  const { wings } = wingsOf(F1A);
  const ok = { wings, pitchMm: 910, startOffsetsMm: [455, 910], tolMm: TOL };
  assert.throws(() => leanToMonoPlanes({ ...ok, pitchMm: 0 }), RangeError);
  assert.throws(() => leanToMonoPlanes({ ...ok, startOffsetsMm: [] }), RangeError);
  assert.throws(() => leanToMonoPlanes({ ...ok, startOffsetsMm: [0] }), RangeError);
  assert.throws(() => leanToMonoPlanes({ ...ok, tolMm: -1 }), RangeError);
  assert.throws(() => leanToMonoPlanes({ ...ok, wings: null }), RangeError);
  assert.throws(() => leanToMonoPlanes({ ...ok, wings: [{ ...wings[0], highSide: 'up' }] }), RangeError);
  assert.deepEqual(leanToMonoPlanes({ ...ok, wings: [] }), []);
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
