// woodRoofFraming.js（在来木造の小屋梁の自動生成。ステップC2b。主屋根の切妻・片流れ）の単体＋統合テスト。
// 設計意図: .claude/structural-model.md「小屋梁」の節。実 core.js（Plane/PlanGraph）を使う。
// 位置の幾何の純関数（roofFramingGeometry.js）は別テスト。ここは graph の読み書き（host・区切り・冪等・撤去・除外集合）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, StructuralMaterialType, RoofSpec, RoofShape, RoofHighSide,
  spanKey, beamExclusionKey, findHostPrimaryBeam,
} from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { autoFillWoodRoofFraming } from './woodRoofFraming.js';
import { autoFillWoodWallBeams } from './woodAutoFill.js';
import { roofFramingLines, roofStrutPoints } from './roofFramingGeometry.js';
import { roofFramingHostMembers } from './framingDrawing.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';

const WOOD = StructuralMaterialType.WOOD;
const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const F = rulesFor(TRADITIONAL_WOOD_STRUCTURE).framing;

// 屋根専用平面の合成 graph。範囲 x 0..3640 × y 0..7280（縦長）。大梁（軒桁）は4辺（mid=true なら中央 x=1820 にも縦の1本）。
// 通り芯: x 0/3640(/1820)、y 0/3640/7280。
function makeRoof({ mid = false, sides = { x0: true, x1: true, y0: true, y2: true } } = {}) {
  const graph = new PlanGraph(new Plane('roof1', 6000, '小屋伏図', 1, 1, false, null, 0, true, 'p_top'));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const cl = {
    x0: graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT),
    x1: graph.addCenterLine(CenterLineType.VERTICAL, 3640, STRUCT),
    y0: graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT),
    y1: graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, STRUCT),
    y2: graph.addCenterLine(CenterLineType.HORIZONTAL, 7280, STRUCT),
  };
  if (mid) cl.xm = graph.addCenterLine(CenterLineType.VERTICAL, 1820, STRUCT);
  const add = (axisCL, isVertical, a, b) =>
    graph.addBeam(WOOD, 'WOOD-120x120', axisCL, isVertical, a, b, { role: 'primary', beamType: '軒桁' });
  const beams = {};
  if (sides.x0) beams.x0 = add(cl.x0, true, cl.y0, cl.y2);
  if (sides.x1) beams.x1 = add(cl.x1, true, cl.y0, cl.y2);
  if (mid) beams.xm = add(cl.xm, true, cl.y0, cl.y2);
  if (sides.y0) beams.y0 = add(cl.y0, false, cl.x0, cl.x1);
  if (sides.y2) beams.y2 = add(cl.y2, false, cl.x0, cl.x1);
  return { graph, cl, beams };
}

// region（roofFramingRegions.js の戻り値と同じ形）。矩形 x 0..3640 × y 0..7280（縦長）。
const rect = { x1: 0, y1: 0, x2: 3640, y2: 7280 };
const GABLE = { key: 'main', rect, shape: RoofShape.GABLE, ridgeIsVertical: true, highSide: null };
const MONO_LEFT = { key: 'main', rect, shape: RoofShape.MONO, ridgeIsVertical: true, highSide: RoofHighSide.LEFT };
const MONO_TOP = { key: 'main', rect, shape: RoofShape.MONO, ridgeIsVertical: true, highSide: RoofHighSide.TOP };
const HIP = { key: 'main', rect, shape: RoofShape.HIP, ridgeIsVertical: true, highSide: null };

const roofBeams = graph => graph.beams.filter(b => b.role === 'roofBeam');
// 小屋梁1本の記述（向き・軸の座標・区間）。比較しやすい文字列。
const desc = b => `${b.isVertical ? 'x' : 'y'}=${b.axisValue}:${Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue)}..${Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)}`;
const descs = graph => roofBeams(graph).map(desc).sort();

// 母屋・棟木の各線の束（線×横架材の交点）の最大間隔。端（線の両端）は束扱い。
function maxStrutGaps(graph, region) {
  const { ridges, purlins } = roofFramingLines({
    rect: region.rect, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: CL_OVERLAP_TOL_MM,
  });
  const members = roofFramingHostMembers(graph.beams, WOOD);
  return [...ridges, ...purlins].map(line => {
    const alongs = [line.lo, line.hi, ...roofStrutPoints([line], members, CL_OVERLAP_TOL_MM).map(p => (line.isVertical ? p.y : p.x))]
      .sort((a, b) => a - b);
    let max = 0;
    for (let i = 0; i + 1 < alongs.length; i++) max = Math.max(max, alongs[i + 1] - alongs[i]);
    return { coord: line.coord, max };
  });
}

// ---------------- 正常系 ----------------

test('切妻: 束の間隔が1820以下になる位置（通り芯y=3640＋910グリッドy=1820,5460）に、host（縦の軒桁）から host へ区切られた小屋梁ができ、端のCLは host の axisCL そのもの', () => {
  const { graph, cl, beams } = makeRoof({ mid: true });
  assert.ok(maxStrutGaps(graph, GABLE).some(g => g.max > F.strutMaxPitchMm), '前提: 小屋梁の前は束の間隔が1820を超える線がある');

  const { created, removed } = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(removed.length, 0);
  assert.deepEqual(descs(graph), [
    'y=1820:0..1820', 'y=1820:1820..3640',
    'y=3640:0..1820', 'y=3640:1820..3640',
    'y=5460:0..1820', 'y=5460:1820..3640',
  ], '3本の位置×host（x0・xm・x1）で区切られた2区間＝6本');
  assert.equal(created.length, 6);

  for (const b of roofBeams(graph)) {
    assert.equal(b.role, 'roofBeam');
    assert.equal(b.beamType, '小屋梁');
    assert.equal(b.dimensionStatus, 'auto');
    assert.equal(b.materialType, WOOD);
    assert.equal(b.isVertical, false, '母屋・棟木（縦）と直交＝横');
    assert.equal(b.isPinJoint, true, 'PIN_ROLES: host の面で止める');
    // 端の CL は載る大梁の axisCL そのもの（座標が同じ別の CL ではない）＝findHostPrimaryBeam が見つける。
    for (const end of [b.clStart, b.clEnd]) {
      assert.ok([cl.x0, cl.xm, cl.x1].includes(end), '端のCLは host の軸CLと同一インスタンス');
      assert.ok(findHostPrimaryBeam(graph.beams, end.id, true, b.axisValue), 'findHostPrimaryBeam が host を見つける');
    }
  }
  // 通り芯 y=3640 の小屋梁は、通り芯CLそのものを軸にする（梁芯CLを作らない）。
  assert.ok(roofBeams(graph).filter(b => b.axisValue === 3640).every(b => b.axisCL === cl.y1));
  // 位置に CL が無い y=1820,5460 は梁芯CL（由来 roofBeam）を作る。
  const made = graph.centerLines.filter(c => c.beamAxisOrigin === BeamAxisOrigin.ROOF_BEAM);
  assert.deepEqual(made.map(c => c.value).sort((a, b) => a - b), [1820, 5460]);
  assert.ok(made.every(c => c.discipline === Discipline.FUSE && c.labeled === false));
  assert.ok(beams.xm, '前提: 中央の縦梁がある');

  for (const g of maxStrutGaps(graph, GABLE)) assert.ok(g.max <= F.strutMaxPitchMm, `線 x=${g.coord} の束の最大間隔 ${g.max} が1820以下`);
});

test('切妻（中央の縦梁なし）: 小屋梁は屋根範囲の端から端（x 0..3640）の1本ずつ', () => {
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.deepEqual(descs(graph), ['y=1820:0..3640', 'y=3640:0..3640', 'y=5460:0..3640']);
  for (const g of maxStrutGaps(graph, GABLE)) assert.ok(g.max <= F.strutMaxPitchMm);
});

test('片流れ（高い側＝左）: 母屋は縦線なので小屋梁は横。位置は切妻と同じ規則で決まる', () => {
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [MONO_LEFT]);
  assert.deepEqual(descs(graph), ['y=1820:0..3640', 'y=3640:0..3640', 'y=5460:0..3640']);
  for (const g of maxStrutGaps(graph, MONO_LEFT)) assert.ok(g.max <= F.strutMaxPitchMm);
});

test('片流れ（高い側＝上）: 母屋は横線なので小屋梁は縦（x=1820。通り芯が無いので910グリッドの梁芯CLを作る）で、横の軒桁（y=0,7280）から横の軒桁へ', () => {
  const { graph, cl } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [MONO_TOP]);
  assert.deepEqual(descs(graph), ['x=1820:0..7280']);
  const b = roofBeams(graph)[0];
  assert.equal(b.isVertical, true);
  assert.equal(b.clStart, cl.y0);
  assert.equal(b.clEnd, cl.y2);
  assert.equal(b.axisCL.beamAxisOrigin, BeamAxisOrigin.ROOF_BEAM);
  for (const g of maxStrutGaps(graph, MONO_TOP)) assert.ok(g.max <= F.strutMaxPitchMm);
});

// ---------------- 冪等・追従・撤去 ----------------

test('冪等（I-C2）: 2回目は created 0・removed 0・id 不変（自分の出力＝既存の小屋梁を支えに数えない）', () => {
  const { graph } = makeRoof({ mid: true });
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const ids = roofBeams(graph).map(b => b.id).sort();
  const clCount = graph.centerLines.length;
  assert.equal(ids.length, 6);
  for (let i = 0; i < 2; i++) {
    const r = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
    assert.equal(r.created.length, 0, `${i + 2}回目の created`);
    assert.equal(r.removed.length, 0, `${i + 2}回目の removed`);
  }
  assert.deepEqual(roofBeams(graph).map(b => b.id).sort(), ids, 'id が変わらない');
  assert.equal(graph.centerLines.length, clCount, '梁芯CLも増えない');
});

test('屋根の入力が変わったら、古い auto の小屋梁を撤去して作り直す（切妻→片流れ・上: 横の小屋梁3本→縦1本）', () => {
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const oldIds = roofBeams(graph).map(b => b.id);
  assert.equal(oldIds.length, 3);
  const { created, removed } = autoFillWoodRoofFraming(graph, PROJECT, [MONO_TOP]);
  assert.deepEqual(removed.sort(), [...oldIds].sort(), '古い3本は全て撤去');
  assert.equal(created.length, 1);
  assert.deepEqual(descs(graph), ['x=1820:0..7280']);
  assert.equal(graph.excludedBeamSlots.size, 0, '撤去は除外集合を汚さない');
});

test('regions===undefined は何もしない（I-C3）。[] ・非在来・寄棟の region は auto の小屋梁を撤去する', () => {
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const before = descs(graph);
  assert.equal(before.length, 3);

  assert.deepEqual(autoFillWoodRoofFraming(graph, PROJECT, undefined), { created: [], removed: [] });
  assert.deepEqual(descs(graph), before, 'undefined では撤去も生成もしない');

  const hip = autoFillWoodRoofFraming(graph, PROJECT, [HIP]);
  assert.equal(hip.removed.length, 3, '寄棟は小屋梁を作らない（後続C2e）＝既存の auto は撤去');
  assert.equal(roofBeams(graph).length, 0);

  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(roofBeams(graph).length, 3);
  const empty = autoFillWoodRoofFraming(graph, PROJECT, []);
  assert.equal(empty.removed.length, 3, '[]（陸屋根・棟違い・矩形でない・非在来など region なし）は全撤去');

  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  graph.structureOverride = 'RC造(ラーメン)'; // 在来でなくなった
  const nonWood = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(nonWood.removed.length, 3, '在来でなければ region があっても全撤去');
  assert.equal(nonWood.created.length, 0);
  assert.equal(roofBeams(graph).length, 0);
});

test('【失敗系】寄棟は、母屋が無く棟木1本だけで線の向きが混在しない小さな屋根（x 0..1820 × y 0..7280）でも小屋梁を作らない（形状で止める。寄棟の小屋梁はC2e）', () => {
  const { graph } = makeRoof({ mid: true });
  const smallHip = { key: 'main', rect: { x1: 0, y1: 0, x2: 1820, y2: 7280 }, shape: RoofShape.HIP, ridgeIsVertical: true, highSide: null };
  const lines = roofFramingLines({
    rect: smallHip.rect, shape: smallHip.shape, ridgeIsVertical: true, highSide: null,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: CL_OVERLAP_TOL_MM,
  });
  assert.equal(lines.purlins.length, 0, '前提: 母屋は無い');
  assert.equal(lines.ridges.length, 1, '前提: 棟木が縦に1本（向きが混在しない）');
  const r = autoFillWoodRoofFraming(graph, PROJECT, [smallHip]);
  assert.equal(r.created.length, 0);
  assert.equal(roofBeams(graph).length, 0);
  // 対照: 同じ範囲を切妻にすれば、棟木（縦）を支えるために小屋梁ができる。
  const gable = { ...smallHip, shape: RoofShape.GABLE };
  assert.ok(autoFillWoodRoofFraming(graph, PROJECT, [gable]).created.length >= 1, '対照: 切妻なら小屋梁ができる（寄棟だから止まっている）');
});

test('regions===undefined は、小屋梁でない梁（軒桁）にも一切触れない', () => {
  const { graph } = makeRoof();
  const ids = graph.beams.map(b => b.id).sort();
  autoFillWoodRoofFraming(graph, PROJECT, undefined);
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.deepEqual(graph.beams.filter(b => b.role !== 'roofBeam').map(b => b.id).sort(), ids, '大梁は増減しない');
});

// ---------------- 除外集合・locked ----------------

test('除外集合: ユーザーが削除した小屋梁は再生成しない／同じ区間の大梁の生成は抑止されない（名前空間つきの鍵）', () => {
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const victim = roofBeams(graph).find(b => b.axisValue === 1820);
  const key = spanKey(victim.axisCL, victim.clStart, victim.clEnd);
  graph.removeBeam(victim.id);
  assert.ok(graph.excludedBeamSlots.has(`roofBeam:${key}`), '小屋梁の除外キーは roofBeam: 名前空間つき');
  assert.equal(graph.excludedBeamSlots.has(key), false, '素の spanKey は積まない（同じ区間の大梁の生成を抑止しない）');
  assert.equal(beamExclusionKey('roofBeam', victim.axisCL, victim.clStart, victim.clEnd), `roofBeam:${key}`);

  const r = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(r.created.length, 0, '削除した小屋梁は復活しない');
  assert.deepEqual(descs(graph), ['y=3640:0..3640', 'y=5460:0..3640']);

  // 同じ区間に大梁（壁線の通し梁）の候補が来ても、小屋梁の削除は大梁の生成を抑止しない（除外集合の鍵が別）。
  const wallSegs = [
    { isVertical: false, coord: 1820, lo: 0, hi: 3640 },
    { isVertical: true, coord: 0, lo: 0, hi: 7280 }, { isVertical: true, coord: 3640, lo: 0, hi: 7280 },
    { isVertical: false, coord: 0, lo: 0, hi: 3640 }, { isVertical: false, coord: 7280, lo: 0, hi: 3640 },
  ];
  const wb = autoFillWoodWallBeams(graph, PROJECT, wallSegs);
  assert.ok(wb.created.some(b => b.role === 'primary' && b.axisValue === 1820 && !b.isVertical), '同じ区間(y=1820)の大梁は生成される');
});

test('除外集合: 逆に大梁（同じ spanKey）を削除しても、小屋梁の生成は抑止されない', () => {
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const b0 = roofBeams(graph).find(b => b.axisValue === 1820);
  // 同じ spanKey の大梁を除外集合へ（大梁の removeBeam が積むのは素の spanKey）。
  graph.excludedBeamSlots.add(spanKey(b0.axisCL, b0.clStart, b0.clEnd));
  graph.beamMap.delete(b0.id);
  const r = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(r.created.length, 1, '小屋梁は再生成される');
  assert.deepEqual(descs(graph), ['y=1820:0..3640', 'y=3640:0..3640', 'y=5460:0..3640']);
});

test('locked の小屋梁は、候補から外れても保持される（auto だけ撤去）', () => {
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const keep = roofBeams(graph).find(b => b.axisValue === 3640);
  keep.setDimensionStatus('locked');
  const { removed } = autoFillWoodRoofFraming(graph, PROJECT, []);
  assert.equal(removed.length, 2, 'auto の2本だけ撤去');
  assert.ok(graph.beamMap.has(keep.id), 'locked は残る');
  assert.deepEqual(descs(graph), ['y=3640:0..3640']);
});

// ---------------- 失敗系・境界 ----------------

test('【失敗系】屋根範囲の端に host（縦の軒桁）が無い区間は生成しない（x0 側の軒桁なし＋中央あり → 中央〜x1 だけ）', () => {
  const { graph } = makeRoof({ mid: true, sides: { x0: false, x1: true, y0: true, y2: true } });
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.deepEqual(descs(graph), ['y=1820:1820..3640', 'y=3640:1820..3640', 'y=5460:1820..3640'],
    'x=0 に host が無いので x0..xm の区間は作らない');
});

test('【失敗系】途中の host（中央の縦の軒桁）がその位置を跨がない（y 0..3640 だけ）なら、y=5460 の小屋梁は host で区切らず端から端の1本', () => {
  const { graph, cl, beams } = makeRoof({ mid: true });
  graph.beamMap.delete(beams.xm.id);
  graph.addBeam(WOOD, 'WOOD-120x120', cl.xm, true, cl.y0, cl.y1, { role: 'primary', beamType: '軒桁' }); // 中央は y 0..3640 だけ
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const at = y => descs(graph).filter(d => d.startsWith(`y=${y}:`));
  assert.deepEqual(at(1820), ['y=1820:0..1820', 'y=1820:1820..3640'], 'host が跨ぐ y=1820 は区切る');
  assert.deepEqual(at(5460), ['y=5460:0..3640'], 'host が跨がない y=5460 は区切らない');
});

test('【失敗系】host が1本も無い（縦の大梁なし）なら小屋梁は1本もできず、例外も投げない', () => {
  const { graph } = makeRoof({ sides: { x0: false, x1: false, y0: true, y2: true } });
  const r = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(r.created.length, 0);
  assert.equal(roofBeams(graph).length, 0);
  assert.equal(graph.centerLines.filter(c => c.beamAxisOrigin === BeamAxisOrigin.ROOF_BEAM).length, 0,
    '小屋梁を作らないなら梁芯CLも作らない（孤児を増やさない）');
});

test('【失敗系】同じ軸の大梁（primary）が区間と重なる（spanKey は別）なら作らない（y=1820 の x0..900 に大梁 → x0..xm は見送り、xm..x1 は作る）', () => {
  const { graph, cl } = makeRoof({ mid: true });
  // y=1820 の梁芯CL＋その上の横梁（x0..x=900。端の CL は host の軸CLではない別のCL）。
  // 小屋梁の候補 x0..xm とは spanKey が違うので、spanKey の重複判定ではすり抜ける＝同軸・範囲重なりの判定だけが止める。
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 3640 });
  const x900 = graph.addCenterLine(CenterLineType.VERTICAL, 900, { labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 7280 });
  graph.addBeam(WOOD, 'WOOD-120x120', y1820, false, cl.x0, x900, { role: 'primary', beamType: '大梁' });
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const y1820beams = roofBeams(graph).filter(b => b.axisValue === 1820 && !b.isVertical).map(desc);
  assert.deepEqual(y1820beams, ['y=1820:1820..3640'], '重なる x0..xm は作らず xm..x1 だけ');
  assert.equal(graph.beams.filter(b => b.role === 'primary' && !b.isVertical && b.axisValue === 1820).length, 1, '大梁を二重にしない');
});

test('【失敗系】同じ区間（同じ spanKey）に大梁・床梁以外の梁（小梁）が既にあれば、その区間の小屋梁は作らない（二重にしない。他の位置は作る）', () => {
  const { graph, cl } = makeRoof();
  // y=1820 の梁芯CL＋その上の小梁（x0..x1。端の CL は host の軸CL＝小屋梁の候補と同じ spanKey）。
  // role が primary・floor でないので同軸・範囲重なりの判定（axisSpanOccupied）は通り抜ける＝spanKey の占有判定だけが止める。
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 3640 });
  const secondary = graph.addBeam(WOOD, 'WOOD-120x120', y1820, false, cl.x0, cl.x1, { role: 'secondary', beamType: '小梁' });
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.deepEqual(descs(graph), ['y=3640:0..3640', 'y=5460:0..3640']);
  assert.ok(graph.beamMap.has(secondary.id), '既にある小梁は撤去しない');
  assert.equal(graph.beams.filter(b => !b.isVertical && b.axisValue === 1820).length, 1, 'y=1820 の横梁は小梁の1本だけ');
});

test('支えが既に足りていれば（全幅の大梁が y=1820,3640,5460 にある）小屋梁は1本も作らない', () => {
  const { graph, cl } = makeRoof();
  for (const y of [1820, 3640, 5460]) {
    const c = y === 3640 ? cl.y1 : graph.addCenterLine(CenterLineType.HORIZONTAL, y, STRUCT);
    graph.addBeam(WOOD, 'WOOD-120x120', c, false, cl.x0, cl.x1, { role: 'primary', beamType: '大梁' });
  }
  const r = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(r.created.length, 0);
  assert.equal(roofBeams(graph).length, 0);
});

test('位置の梁芯CL（y=1820）が手動削除の座標（excludedWallBeamAxes）なら、その位置の小屋梁は作らない（他の位置は作る）', () => {
  const { graph } = makeRoof();
  graph.excludedWallBeamAxes.add('Y:1820');
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.deepEqual(descs(graph), ['y=3640:0..3640', 'y=5460:0..3640']);
  assert.equal(graph.centerLines.some(c => c.beamAxisOrigin === BeamAxisOrigin.ROOF_BEAM && c.value === 1820), false);
});

test('既存の梁芯CL（壁由来）が小屋梁の位置にあれば、それを軸に使う（新しく作らない）', () => {
  const { graph } = makeRoof();
  const existing = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 3640, beamAxisOrigin: BeamAxisOrigin.WALL,
  });
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const b = roofBeams(graph).find(x => x.axisValue === 1820);
  assert.equal(b.axisCL, existing);
  assert.equal(existing.beamAxisOrigin, BeamAxisOrigin.WALL, '既にある由来は上書きしない');
});

// ---------------- 壁線の候補との関係（既知の挙動の固定） ----------------

test('壁線の通し梁の候補が後から同じ区間に現れると、auto の小屋梁が大梁へ置き換わる（既存の占有物判定。小屋梁は二重に残らない）', () => {
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const koya1820 = roofBeams(graph).find(b => b.axisValue === 1820);
  assert.ok(koya1820);
  const wallSegs = [
    { isVertical: false, coord: 1820, lo: 0, hi: 3640 },
    { isVertical: true, coord: 0, lo: 0, hi: 7280 }, { isVertical: true, coord: 3640, lo: 0, hi: 7280 },
    { isVertical: false, coord: 0, lo: 0, hi: 3640 }, { isVertical: false, coord: 7280, lo: 0, hi: 3640 },
  ];
  const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, wallSegs);
  assert.ok(removed.includes(koya1820.id), '同じ spanKey の auto 小屋梁は占有物として撤去される');
  assert.ok(created.some(b => b.role === 'primary' && b.axisValue === 1820), '大梁が置き換わる');
  assert.equal(graph.beams.filter(b => b.axisValue === 1820 && !b.isVertical).length, 1, 'y=1820 の横梁は1本だけ');

  // その後の小屋梁の再生成: 大梁が支えになるので小屋梁は y=1820 には戻らず、他は変化なし（収束する）。
  const r1 = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(roofBeams(graph).some(b => b.axisValue === 1820), false);
  const r2 = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(r2.created.length + r2.removed.length, 0, `収束（1回目 created=${r1.created.length} removed=${r1.removed.length}）`);
});

// ---------------- 構造再計算の統合（本番と同じ順: 小屋伏図→最上階） ----------------

// 最上階: 3640×7280 の実壁の部屋（矩形）。主屋根の形状は引数。小屋伏図: 最上階の peek で解決。
function buildProject(shape) {
  const project = new Project('proj-roof-framing', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1'); // 唯一の実体階＝最上階
  project.activePlaneId = 'p1';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, STRUCT);
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 7280, STRUCT);
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.setMainRoofSpec(new RoofSpec({ shape }));
  const { graph: roofGraph } = project.addPlane(3000, '小屋伏図', 'roof1', 1, 1, false, null, 0, true, 'p1');
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  return { project, g1, roofGraph };
}

// 屋根→最上階の順に収束まで回す（sweepOrder.mjs の本番順と同じ。収束したスイープ数を返す）。
async function converge(project, g1, roofGraph, maxSweeps = 8) {
  for (let i = 1; i <= maxSweeps; i++) {
    const r = await recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE);
    const t = await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    if (!r.changed && !t.changed) return i;
  }
  return null;
}

// 軸ごとの被覆区間（隣接・重なりを併合）。梁が分割されても被覆は同じ、を比べるための署名。
function coverage(graph, filter) {
  const byAxis = new Map();
  for (const b of graph.beams.filter(filter)) {
    const k = `${b.isVertical ? 'x' : 'y'}=${b.axisValue}`;
    if (!byAxis.has(k)) byAxis.set(k, []);
    byAxis.get(k).push([Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue), Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)]);
  }
  return [...byAxis].map(([k, iv]) => {
    iv.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [lo, hi] of iv) {
      if (merged.length && lo <= merged[merged.length - 1][1] + 1) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], hi);
      else merged.push([lo, hi]);
    }
    return `${k}:${merged.map(m => m.join('..')).join(',')}`;
  }).sort();
}
const colSig = g => g.columns.map(c => `${c.axisX},${c.axisY},${c.role},${c.sectionDefId}`).sort();

test('【統合】recomputeStructuralForGraph: 切妻の主屋根で、小屋伏図に小屋梁ができ、収束し、柱・既存の大梁の被覆は小屋梁なしと同じ（小屋梁の端は柱の点源にならない）', async () => {
  const withKoya = buildProject(RoofShape.GABLE);
  const baseline = buildProject(RoofShape.FLAT); // 陸屋根＝region なし＝小屋梁なし（対照）
  const peekWith = { p1: withKoya.g1, roof1: withKoya.roofGraph };
  const peekBase = { p1: baseline.g1, roof1: baseline.roofGraph };
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => peekWith[plane.id] ?? null;
    const sweeps = await converge(withKoya.project, withKoya.g1, withKoya.roofGraph);
    floorSwapManager.peek = async (plane) => peekBase[plane.id] ?? null;
    const sweepsBase = await converge(baseline.project, baseline.g1, baseline.roofGraph);

    assert.ok(sweeps !== null && sweeps <= 5, `収束する（${sweeps}回）`);
    assert.equal(sweeps, sweepsBase, '小屋梁が入ってもスイープ数は増えない');
    const koya = roofBeams(withKoya.roofGraph);
    assert.ok(koya.length >= 1, '小屋伏図に小屋梁ができる');
    assert.equal(roofBeams(baseline.roofGraph).length, 0, '対照（陸屋根）は小屋梁なし');
    assert.equal(withKoya.roofGraph.columns.length, 0, '屋根に柱は立たない（小屋梁の端が柱を生まない）');
    // 柱: 最上階の柱は小屋梁の有無で同じ（位置・断面）。
    assert.deepEqual(colSig(withKoya.g1), colSig(baseline.g1), '最上階の柱は不変');
    // 既存の大梁（軒桁など）: 被覆区間は同じ（小屋梁の梁芯CLが下階柱位置と重なると分割されうるが、被覆は不変）。
    const notKoya = b => b.role !== 'roofBeam';
    assert.deepEqual(coverage(withKoya.roofGraph, notKoya), coverage(baseline.roofGraph, notKoya), '軒桁などの被覆は不変');
    // 小屋梁自身は梁成表・個別採番の対象外（断面は既定の幅×成のまま。成の表は次のステップ）。
    assert.ok(koya.every(b => b.dimensionStatus === 'auto'));
    // 3周目（もう一度回しても）変化 0。
    floorSwapManager.peek = async (plane) => peekWith[plane.id] ?? null;
    const again = await recomputeStructuralForGraph(withKoya.roofGraph, withKoya.project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(again.changed, false, '収束後の再計算は変化 0（冪等）');
  } finally {
    floorSwapManager.peek = original;
  }
});

test('【統合・失敗系】recomputeStructuralForGraph: 主屋根の形状を切妻→陸屋根へ変えて再計算すると、auto の小屋梁が撤去される（屋根の入力の変更に追従）', async () => {
  const { project, g1, roofGraph } = buildProject(RoofShape.GABLE);
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => ({ p1: g1, roof1: roofGraph })[plane.id] ?? null;
    await converge(project, g1, roofGraph);
    assert.ok(roofBeams(roofGraph).length >= 1, '前提: 切妻では小屋梁がある');
    g1.setMainRoofSpec(new RoofSpec({ shape: RoofShape.FLAT }));
    const r = await recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(r.changed, true);
    assert.equal(roofBeams(roofGraph).length, 0, '陸屋根では region が無い＝auto の小屋梁を全撤去');
  } finally {
    floorSwapManager.peek = original;
  }
});

test('【統合】recomputeStructuralForGraph: 主屋根を陸屋根→切妻へ変えた再計算は、軒桁が1本も変わらなくても changed=true（小屋梁の作成が changed に乗る＝保存・undo の判定から漏れない）', async () => {
  const { project, g1, roofGraph } = buildProject(RoofShape.FLAT);
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => ({ p1: g1, roof1: roofGraph })[plane.id] ?? null;
    await converge(project, g1, roofGraph);
    assert.equal(roofBeams(roofGraph).length, 0, '前提: 陸屋根では小屋梁なし');
    const primaryIds = () => roofGraph.beams.filter(b => b.role === 'primary').map(b => b.id).sort();
    const before = primaryIds();
    g1.setMainRoofSpec(new RoofSpec({ shape: RoofShape.GABLE }));
    const r = await recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.ok(roofBeams(roofGraph).length >= 1, '切妻で小屋梁ができる');
    assert.deepEqual(primaryIds(), before, '前提: この回は軒桁（primary）が1本も入れ替わらない＝changed の源は小屋梁だけ');
    assert.equal(r.changed, true);
  } finally {
    floorSwapManager.peek = original;
  }
});

test('【統合】実体階（最上階）の再計算は小屋梁に触れない（regions を渡さない＝I-C3）', async () => {
  const { project, g1, roofGraph } = buildProject(RoofShape.GABLE);
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => ({ p1: g1, roof1: roofGraph })[plane.id] ?? null;
    await converge(project, g1, roofGraph);
    const before = descs(roofGraph);
    assert.ok(before.length >= 1);
    // 実体階に（手で）置いた auto の小屋梁は、実体階の再計算で撤去されない（regions===undefined は触れない）。
    const cl = (type, v) => g1.centerLines.find(c => c.centerLineType === type && c.value === v);
    const planted = g1.addBeam(WOOD, 'WOOD-120x120', cl(CenterLineType.HORIZONTAL, 7280), false,
      cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 3640), { role: 'roofBeam', beamType: '小屋梁' });
    // 最上階を単独で再計算しても、屋根の小屋梁は増減しない（最上階は屋根の graph に書かない）。
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.deepEqual(descs(roofGraph), before);
    assert.ok(g1.beamMap.has(planted.id), '実体階の再計算は小屋梁に触れない（作りもせず、撤去もしない）');
    assert.equal(roofBeams(g1).length, 1, '実体階に新しく小屋梁は作らない（置いた1本だけ）');
  } finally {
    floorSwapManager.peek = original;
  }
});
