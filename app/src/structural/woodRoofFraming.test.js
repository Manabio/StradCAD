// woodRoofFraming.js（在来木造の小屋梁の自動生成。ステップC2b・C2d-2。主屋根・下屋の切妻・片流れ）の単体＋統合テスト。
// 下屋（実体階へ載せる小屋梁）の統合テストは leanToRoofBeams.test.js。
// 設計意図: .claude/structural-model.md「小屋梁」の節。実 core.js（Plane/PlanGraph）を使う。
// 位置の幾何の純関数（roofFramingGeometry.js）は別テスト。ここは graph の読み書き（host・区切り・冪等・撤去・除外集合）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, StructuralMaterialType, RoofSpec, RoofShape, RoofHighSide,
  spanKey, beamExclusionKey, findHostPrimaryBeam, findHostBeam,
} from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { autoFillWoodRoofFraming } from './woodRoofFraming.js';
import { autoFillWoodWallBeams, autoFillWoodBeamDepths } from './woodAutoFill.js';
import { roofFramingLines, roofStrutPoints, leanToWingsOf, leanToMonoLines } from './roofFramingGeometry.js';
import { roofFramingHostMembers } from './framingDrawing.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { mainRoofFramingRegion } from './roofFramingRegions.js';

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
const tobibari = graph => graph.beams.filter(b => b.role === 'roofBeam' && b.beamType === '飛び梁');
const koyaOnly = graph => graph.beams.filter(b => b.role === 'roofBeam' && b.beamType === '小屋梁');

// 母屋・棟木の各線の束（線×横架材の交点）の最大間隔。端（線の両端）は束扱い。
// region が矩形でない寄棟（rect:null・rects）なら、線は rects から導く（C2e-3b）。
// L字の下屋（leanToWings）の小屋梁は、今のところ翼ごとの面（leanToMonoPlanes）の母屋＝旧い母屋（leanToMonoLines）を支えるように作る。
// 描画の母屋は水下への距離の場（roofFramingLines の leanToDrains）に替わったので、L字だけ旧い母屋で検査する
// （小屋梁も水下の面へ切り替えるステップ2で roofFramingLines へ戻す）。
function maxStrutGaps(graph, region) {
  const tolMm = CL_OVERLAP_TOL_MM;
  const { ridges, purlins } = !region.rect && region.leanToWings
    ? leanToMonoLines({ wings: region.leanToWings, pitchMm: F.purlinPitchMm, startOffsetsMm: F.purlinStartOffsetsMm, tolMm })
    : roofFramingLines({
      rect: region.rect ?? null, rects: region.rects ?? null, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
      purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm,
    });
  const members = roofFramingHostMembers(graph.beams, WOOD);
  return [...ridges, ...purlins].map(line => {
    const alongs = [line.lo, line.hi, ...roofStrutPoints([line], members, CL_OVERLAP_TOL_MM).map(p => (line.isVertical ? p.y : p.x))]
      .sort((a, b) => a - b);
    let max = 0;
    for (let i = 0; i + 1 < alongs.length; i++) max = Math.max(max, alongs[i + 1] - alongs[i]);
    return { coord: line.coord, lo: line.lo, hi: line.hi, max };
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

test('【C2e-1c】切妻の棟木が横（ridgeIsVertical=false。縦長の屋根）: 母屋は横線なので小屋梁は縦で、横の軒桁（y=0,7280）から横の軒桁へ。束の間隔は1820以下', () => {
  const { graph, cl } = makeRoof();
  const GABLE_H = { ...GABLE, ridgeIsVertical: false };
  assert.ok(maxStrutGaps(graph, GABLE_H).some(g => g.max > F.strutMaxPitchMm), '前提: 小屋梁の前は束の間隔が1820を超える線がある');
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE_H]);
  const koya = roofBeams(graph);
  assert.ok(koya.length >= 1, '小屋梁ができる');
  assert.ok(koya.every(b => b.isVertical === true), '母屋・棟木（横）と直交＝縦');
  assert.ok(koya.every(b => b.clStart === cl.y0 && b.clEnd === cl.y2), '横の軒桁（y=0・y=7280）の間に架かる');
  for (const g of maxStrutGaps(graph, GABLE_H)) assert.ok(g.max <= F.strutMaxPitchMm, `線 y=${g.coord} の束の最大間隔 ${g.max} が1820以下`);
  // 対照: 同じ屋根でも棟木が縦（既定の長手）なら小屋梁は横
  const ref = makeRoof();
  autoFillWoodRoofFraming(ref.graph, PROJECT, [GABLE]);
  assert.ok(roofBeams(ref.graph).every(b => b.isVertical === false), '対照: 棟木縦なら小屋梁は横');
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

// 【C2e-1b で書き換え】以前は「寄棟の region は小屋梁を作らない＝既存の auto は撤去」を固定していた（寄棟は後続）。寄棟も
// 小屋梁を作るようになったので、撤去される側は陸屋根（region 無し）で固定し直し、寄棟は「切妻の小屋梁が寄棟の小屋梁に置き換わる」へ。

test('regions===undefined は何もしない（I-C3）。[] ・非在来の region は auto の小屋梁を撤去する（寄棟は小屋梁を作る＝撤去しない）', () => {
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  const before = descs(graph);
  assert.equal(before.length, 3);

  assert.deepEqual(autoFillWoodRoofFraming(graph, PROJECT, undefined), { created: [], removed: [] });
  assert.deepEqual(descs(graph), before, 'undefined では撤去も生成もしない');

  const hip = autoFillWoodRoofFraming(graph, PROJECT, [HIP]);
  // この大きさ（3640×7280）の寄棟は seed（棟木の両端 y=1820・5460）が切妻の位置と一致し、妻側の線が1820で飛び梁も無い。
  assert.deepEqual(descs(graph), before, '寄棟も小屋梁を作る（C2e-1b。この大きさでは切妻と同じ位置）');
  assert.deepEqual([hip.created.length, hip.removed.length], [0, 0], '既存の小屋梁は使い回す');
  assert.equal(tobibari(graph).length, 0);

  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.deepEqual(descs(graph), before, '切妻へ戻せば元の小屋梁');
  const empty = autoFillWoodRoofFraming(graph, PROJECT, []);
  assert.equal(empty.removed.length, 3, '[]（陸屋根・棟違い・矩形でない・非在来など region なし）は全撤去');

  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  graph.structureOverride = 'RC造(ラーメン)'; // 在来でなくなった
  const nonWood = autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(nonWood.removed.length, 3, '在来でなければ region があっても全撤去');
  assert.equal(nonWood.created.length, 0);
  assert.equal(roofBeams(graph).length, 0);
});

// 【C2e-1b で書き換え】以前は「母屋が無く棟木1本だけの小さな寄棟（x 0..1820 × y 0..7280）は小屋梁を作らない（形状で止める）」を
// 固定していた。寄棟も小屋梁を作るので、同じ入力で「棟木の両端（seed）を含めて梁間方向の小屋梁ができ、飛び梁は妻側の線が無いので0」を固定する。
test('寄棟の小さな屋根（母屋が無く棟木1本だけ。x 0..1820 × y 0..7280）: 棟木の両端（y=910・6370）に必ず小屋梁が置かれ、束の間隔が1820以下になる。妻側の線が無いので飛び梁は0', () => {
  const { graph } = makeRoof({ mid: true });
  const smallHip = { key: 'main', rect: { x1: 0, y1: 0, x2: 1820, y2: 7280 }, shape: RoofShape.HIP, ridgeIsVertical: true, highSide: null };
  const lines = roofFramingLines({
    rect: smallHip.rect, shape: smallHip.shape, ridgeIsVertical: true, highSide: null,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: CL_OVERLAP_TOL_MM,
  });
  assert.equal(lines.purlins.length, 0, '前提: 母屋は無い');
  assert.equal(lines.ridges.length, 1, '前提: 棟木が縦に1本');
  autoFillWoodRoofFraming(graph, PROJECT, [smallHip]);
  const ds = descs(graph);
  assert.ok(ds.includes('y=910:0..1820') && ds.includes('y=6370:0..1820'), `seed（棟木の両端）: ${ds}`);
  assert.equal(tobibari(graph).length, 0);
  for (const g of maxStrutGaps(graph, smallHip)) assert.ok(g.max <= F.strutMaxPitchMm, `棟木の束の最大間隔 ${g.max}`);
});

test('【C2d-2】小屋梁は region の範囲の中の host の間にだけ作る（範囲の外の大梁へ延びない＝隣の部屋・別の下屋へはみ出さない）', () => {
  // 縦の大梁が x=0・1820・3640 にある屋根で、region は左半分（x 0..1820）だけ。片流れ（高い側＝左）＝母屋は縦線。
  const { graph } = makeRoof({ mid: true });
  const half = { key: 'lean:half', rect: { x1: 0, y1: 0, x2: 1820, y2: 7280 }, shape: RoofShape.MONO, ridgeIsVertical: true, highSide: RoofHighSide.LEFT };
  autoFillWoodRoofFraming(graph, PROJECT, [half]);
  assert.deepEqual(descs(graph), ['y=1820:0..1820', 'y=3640:0..1820', 'y=5460:0..1820'], '範囲の外（x 1820..3640）には作らない');
});

test('【失敗系・C2d-2】region の rect が退化（幅0・高さ0）・NaN・欠落でも例外を投げず、小屋梁を作らない（既存の auto の小屋梁は region 無しと同じく撤去）', () => {
  const bad = {
    '幅0': { x1: 1820, y1: 0, x2: 1820, y2: 7280 },
    '高さ0': { x1: 0, y1: 3640, x2: 3640, y2: 3640 },
    NaN: { x1: NaN, y1: 0, x2: 3640, y2: 7280 },
    '欠落': undefined,
  };
  for (const [name, badRect] of Object.entries(bad)) {
    for (const shape of [RoofShape.GABLE, RoofShape.MONO]) {
      const { graph } = makeRoof();
      const region = { key: 'lean:bad', rect: badRect, shape, ridgeIsVertical: true, highSide: shape === RoofShape.MONO ? RoofHighSide.LEFT : null };
      let result;
      assert.doesNotThrow(() => { result = autoFillWoodRoofFraming(graph, PROJECT, [region]); }, `${name}・${shape}`);
      assert.deepEqual(result, { created: [], removed: [] }, `${name}・${shape}: 作らない`);
      assert.equal(roofBeams(graph).length, 0);
    }
  }
  const { graph } = makeRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [GABLE]);
  assert.equal(roofBeams(graph).length, 3, '前提: 正常な region なら作る');
  const res = autoFillWoodRoofFraming(graph, PROJECT, [{ ...GABLE, rect: { x1: NaN, y1: 0, x2: 3640, y2: 7280 } }]);
  assert.equal(res.removed.length, 3, '不正な region は region 無しと同じ＝既存の auto を撤去');
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

// 矩形でない寄棟（rect:null・rects）の小屋梁は C2e-3b の節（「矩形でない寄棟」）。C2e-2 時点の「作らない」を固定していた
// テストは、C2e-3b で書き換えた（作られること・不正な rects は作らないこと・撤去と locked はその節）。

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

// ---------------- 寄棟（C2e-1b。第1段＝梁間方向の小屋梁、第2段＝飛び梁） ----------------

// 屋根専用平面の合成 graph（寄棟用）。範囲 x 0..w × y 0..h。通り芯は x が 0・xMid…・w、y が 0・yMid…・h。
// 大梁（軒桁）は外周4辺（sides で欠かせる。extra は追加の大梁 {horizontal, coord, from, to}）。
function makeHipRoof({ w = 5460, h = 9100, xMid = [2730], yMid = [4550], sides = {}, extra = [] } = {}) {
  const on = { x0: true, x1: true, y0: true, y1: true, ...sides };
  const graph = new PlanGraph(new Plane('roof1', 6000, '小屋伏図', 1, 1, false, null, 0, true, 'p_top'));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const xs = [0, ...xMid, w].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, STRUCT));
  const ys = [0, ...yMid, h].map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, STRUCT));
  const X = v => xs.find(c => c.value === v);
  const Y = v => ys.find(c => c.value === v);
  const add = (axisCL, isVertical, a, b) =>
    graph.addBeam(WOOD, 'WOOD-120x120', axisCL, isVertical, a, b, { role: 'primary', beamType: '軒桁' });
  const beams = {};
  if (on.x0) beams.x0 = add(X(0), true, Y(0), Y(h));
  if (on.x1) beams.x1 = add(X(w), true, Y(0), Y(h));
  if (on.y0) beams.y0 = add(Y(0), false, X(0), X(w));
  if (on.y1) beams.y1 = add(Y(h), false, X(0), X(w));
  for (const e of extra) beams[`${e.horizontal ? 'y' : 'x'}${e.coord}`] = e.horizontal
    ? add(Y(e.coord), false, X(e.from), X(e.to)) : add(X(e.coord), true, Y(e.from), Y(e.to));
  return { graph, X, Y, beams, region: { key: 'main', rect: { x1: 0, y1: 0, x2: w, y2: h }, shape: RoofShape.HIP, ridgeIsVertical: h > w, highSide: null } };
}
const tobibariDescs = graph => tobibari(graph).map(desc).sort();
const koyaDescs = graph => koyaOnly(graph).map(desc).sort();

test('【寄棟】片側だけに大梁がある非対称な屋根では、妻側の母屋がその大梁で 1820 以下に支えられている側に飛び梁を作らない（片側ずつ位置を決める。反対側の都合で不要な飛び梁を作らない）', () => {
  // lo 側（y 0..2730）だけに縦の大梁 x=1820・x=3640 がある。lo 側の妻側の線（x 910..4550 等）は 1820 以下に支えられる。
  const { graph, region } = makeHipRoof({
    xMid: [1820, 2730, 3640], yMid: [2730, 4550],
    extra: [{ coord: 1820, from: 0, to: 2730 }, { coord: 3640, from: 0, to: 2730 }],
  });
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.deepEqual(tobibariDescs(graph), ['x=2730:6370..9100'], 'hi 側だけに飛び梁');
  assert.ok(maxStrutGaps(graph, region).every(g => g.max <= F.strutMaxPitchMm + CL_OVERLAP_TOL_MM), '束の間隔は全線 1820 以下');
});

test('【寄棟】計算例（x 0..5460 × y 0..9100。通り芯 x=0/2730/5460・y=0/4550/9100）: 第1段＝y=2730（seed）・4550（通り芯）・6370（seed）の梁間方向の小屋梁（x 0→5460）、第2段＝x=2730 の飛び梁 y 0→2730 と 6370→9100（lo・hi が対称）', () => {
  const { graph, region, X } = makeHipRoof();
  assert.ok(maxStrutGaps(graph, region).some(g => g.max > F.strutMaxPitchMm), '前提: 小屋梁の前は束の間隔が1820を超える線がある');
  const { created, removed } = autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(removed.length, 0);
  assert.deepEqual(koyaDescs(graph), ['y=2730:0..5460', 'y=4550:0..5460', 'y=6370:0..5460']);
  assert.deepEqual(tobibariDescs(graph), ['x=2730:0..2730', 'x=2730:6370..9100']);
  assert.equal(created.length, 5);
  for (const b of roofBeams(graph)) {
    assert.equal(b.role, 'roofBeam');
    assert.equal(b.dimensionStatus, 'auto');
    assert.equal(b.isPinJoint, true, 'PIN_ROLES: host の面で止める');
  }
  // 飛び梁の軸は通り芯 x=2730（梁芯CLを作らない）。両端のCLは host（軒桁・第1段の小屋梁）の axisCL そのもの。
  for (const b of tobibari(graph)) assert.equal(b.axisCL, X(2730));
  const hostOf = (end) => graph.beams.find(h => !h.isVertical && h.axisCL === end);
  for (const b of tobibari(graph)) for (const end of [b.clStart, b.clEnd]) assert.ok(hostOf(end), '端のCLを axisCL にする host（軒桁か第1段の小屋梁）がある');
  // 成: 第1段は支持点間 5460→270、飛び梁は 2730→210。
  autoFillWoodBeamDepths(graph, PROJECT, []);
  assert.deepEqual(koyaOnly(graph).map(b => b.sectionDefId), ['WOOD-120x270', 'WOOD-120x270', 'WOOD-120x270']);
  assert.deepEqual(tobibari(graph).map(b => b.sectionDefId), ['WOOD-120x210', 'WOOD-120x210']);
  for (const g of maxStrutGaps(graph, region)) assert.ok(g.max <= F.strutMaxPitchMm, `線 coord=${g.coord} の束の最大間隔 ${g.max} が1820以下`);
});

test('【寄棟】棟木の両端の位置（seed）の小屋梁は、棟木を跨ぐ直交の大梁が既にあれば置かない（大梁が支える）。飛び梁はその大梁で終わる', () => {
  // y=2730 に全幅の大梁を足す（棟木 x=2730 を跨ぐ）。seed の y=2730 は置かず、y=6370 の seed と通り芯 y=4550 は残る。
  const { graph, region, Y, X } = makeHipRoof({ yMid: [2730, 4550] });
  graph.addBeam(WOOD, 'WOOD-120x120', Y(2730), false, X(0), X(5460), { role: 'primary', beamType: '大梁' });
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.deepEqual(koyaDescs(graph), ['y=4550:0..5460', 'y=6370:0..5460'], 'y=2730 には小屋梁を重ねない');
  assert.deepEqual(tobibariDescs(graph), ['x=2730:0..2730', 'x=2730:6370..9100'], '飛び梁の lo 側は大梁 y=2730 で終わる');
  for (const g of maxStrutGaps(graph, region)) assert.ok(g.max <= F.strutMaxPitchMm, `束の最大間隔 ${g.max}`);
});

test('寄棟の正方形（5460角）: 中心 x=2730 の梁間方向の小屋梁が1本、その両側（x 0→2730 と 2730→5460）に y=2730 の飛び梁', () => {
  const { graph, region } = makeHipRoof({ w: 5460, h: 5460, yMid: [2730] });
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.deepEqual(koyaDescs(graph), ['x=2730:0..5460'], '方形は棟木なし。seed は中心の1点');
  assert.deepEqual(tobibariDescs(graph), ['y=2730:0..2730', 'y=2730:2730..5460']);
  for (const g of maxStrutGaps(graph, region)) assert.ok(g.max <= F.strutMaxPitchMm, `束の最大間隔 ${g.max}`);
});

test('【境界】妻側の線の長さが 1820 なら飛び梁は0（x 0..3640 × y 0..7280）。第1段の小屋梁（seed を含む）だけできる', () => {
  const { graph, region } = makeHipRoof({ w: 3640, h: 7280, xMid: [], yMid: [3640] });
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(tobibari(graph).length, 0);
  assert.deepEqual(koyaDescs(graph), ['y=1820:0..3640', 'y=3640:0..3640', 'y=5460:0..3640']);
  for (const g of maxStrutGaps(graph, region)) assert.ok(g.max <= F.strutMaxPitchMm, `束の最大間隔 ${g.max}`);
});

test('【失敗系・境界】寄棟で作れない入力は例外を投げず作らない: 母屋も棟木も無い正方形（1820角）・妻の軒桁の対が無い・横架材（直交の大梁）が無い・rect が不正', () => {
  const tiny = makeHipRoof({ w: 1820, h: 1820, xMid: [], yMid: [] });
  assert.doesNotThrow(() => autoFillWoodRoofFraming(tiny.graph, PROJECT, [tiny.region]));
  assert.equal(roofBeams(tiny.graph).length, 0, '線が1本も無い（棟木なし・母屋なし）');

  const noPurlinHost = makeHipRoof({ sides: { x0: false, x1: false } }); // 梁間方向の小屋梁の host（縦の大梁）が無い
  assert.doesNotThrow(() => autoFillWoodRoofFraming(noPurlinHost.graph, PROJECT, [noPurlinHost.region]));
  assert.equal(koyaOnly(noPurlinHost.graph).length, 0, 'host が無ければ第1段は作らない');
  assert.equal(tobibari(noPurlinHost.graph).length, 0, '第1段が無く、軒桁だけ（対が無い）なら飛び梁も作らない');
  assert.equal(noPurlinHost.graph.centerLines.filter(c => c.beamAxisOrigin === BeamAxisOrigin.ROOF_BEAM).length, 0, '梁芯CLも作らない');

  const { graph, region } = makeHipRoof();
  for (const badRect of [{ x1: NaN, y1: 0, x2: 5460, y2: 9100 }, { x1: 0, y1: 4550, x2: 5460, y2: 4550 }, undefined]) {
    let r;
    assert.doesNotThrow(() => { r = autoFillWoodRoofFraming(graph, PROJECT, [{ ...region, rect: badRect }]); }, JSON.stringify(badRect));
    assert.deepEqual(r, { created: [], removed: [] });
  }
});

test('【失敗系】妻の軒桁が無い側（y=0 の大梁なし）には飛び梁を作らない。反対側（hi）は作る', () => {
  const { graph, region } = makeHipRoof({ sides: { y0: false } });
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.deepEqual(tobibariDescs(graph), ['x=2730:6370..9100']);
  assert.deepEqual(koyaDescs(graph), ['y=2730:0..5460', 'y=4550:0..5460', 'y=6370:0..5460'], '第1段は影響を受けない');
});

test('【寄棟】seed の小屋梁をユーザーが削除すると、飛び梁の終点は次の部材になる（x=2730 の y 0→2730 が 0→4550 へ）', () => {
  const { graph, region } = makeHipRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  const seed = koyaOnly(graph).find(b => b.axisValue === 2730);
  graph.removeBeam(seed.id);
  const r = autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.deepEqual(koyaDescs(graph), ['y=4550:0..5460', 'y=6370:0..5460']);
  assert.deepEqual(tobibariDescs(graph), ['x=2730:0..4550', 'x=2730:6370..9100']);
  assert.equal(r.removed.length, 1, '0→2730 の飛び梁が撤去され');
  assert.equal(r.created.length, 1, '0→4550 の飛び梁ができる');
  assert.equal(autoFillWoodRoofFraming(graph, PROJECT, [region]).created.length, 0, '収束');
});

test('【寄棟・冪等（I-C2）】2回目・3回目は created 0・removed 0・id 不変・梁芯CLも増えない（飛び梁の host に graph 上の既存の小屋梁を数えない）', () => {
  const { graph, region } = makeHipRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  const ids = roofBeams(graph).map(b => b.id).sort();
  const clCount = graph.centerLines.length;
  assert.equal(ids.length, 5);
  for (let i = 0; i < 2; i++) {
    const r = autoFillWoodRoofFraming(graph, PROJECT, [region]);
    assert.deepEqual([r.created.length, r.removed.length], [0, 0], `${i + 2}回目`);
  }
  assert.deepEqual(roofBeams(graph).map(b => b.id).sort(), ids);
  assert.equal(graph.centerLines.length, clCount);
});

test('【寄棟】切妻へ変えると飛び梁は撤去され、寄棟へ戻すと作り直される。小屋梁→飛び梁の beamType 違いの再利用は作り直し（locked は触らない）', () => {
  const { graph, region } = makeHipRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  const oldTobi = tobibari(graph).map(b => b.id).sort();
  assert.equal(oldTobi.length, 2);
  const toGable = autoFillWoodRoofFraming(graph, PROJECT, [{ ...region, shape: RoofShape.GABLE }]);
  assert.equal(tobibari(graph).length, 0, '切妻に飛び梁は無い');
  for (const id of oldTobi) assert.ok(toGable.removed.includes(id), '飛び梁は撤去される');
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(tobibari(graph).length, 2, '寄棟へ戻せば作り直される');

  // beamType 違い（auto）: 同じ spanKey の梁を作り直す。removed と created の両方に入る。
  const victim = tobibari(graph)[0];
  victim.beamType = '小屋梁';
  const key = spanKey(victim.axisCL, victim.clStart, victim.clEnd);
  const redo = autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.deepEqual(redo.removed, [victim.id]);
  assert.equal(redo.created.length, 1);
  assert.equal(spanKey(redo.created[0].axisCL, redo.created[0].clStart, redo.created[0].clEnd), key);
  assert.equal(redo.created[0].beamType, '飛び梁');
  assert.equal(graph.beamMap.has(victim.id), false);

  // locked: beamType が違っても触らない。
  const keep = tobibari(graph)[0];
  keep.beamType = '小屋梁';
  keep.setDimensionStatus('locked');
  const none = autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.deepEqual([none.created.length, none.removed.length], [0, 0]);
  assert.ok(graph.beamMap.has(keep.id));
});

test('【寄棟・描画】飛び梁（y 0→2730）の端は、軒桁（y=0）の面と第1段の小屋梁（y=2730）の面で止まる（host に小屋梁を許す＝C2e-1a）', () => {
  const { graph, region } = makeHipRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  const t = tobibari(graph).find(b => Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) === 0);
  assert.ok(t);
  assert.deepEqual(t.spanForHostBeams(graph.beams, 0), { coord1: 60, coord2: 2670 }, '半幅60（120角）ずつ内側で止まる');
  // 対照: 第1段の小屋梁を graph から外すと、その端は host を見つけられず CL 位置（2730）まで伸びる。
  const seed = koyaOnly(graph).find(b => b.axisValue === 2730);
  graph.beamMap.delete(seed.id);
  assert.equal(t.spanForHostBeams(graph.beams, 0).coord2, 2730);
});

test('【寄棟・配線】roofFramingHostMembers は飛び梁を束の横架材に含む（束の最大間隔の検査と描画が同じ部材を見る）', () => {
  const { graph, region } = makeHipRoof();
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  const members = roofFramingHostMembers(graph.beams, WOOD);
  assert.ok(tobibari(graph).every(t => members.some(m => m.isVertical === t.isVertical && Math.abs(m.axis - t.axisValue) < 1)));
});

// ---------------- 矩形でない寄棟（C2e-3b。翼ごとに第1段・第2段。設計意図は structural-model.md） ----------------

const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
// セル矩形（roofFramingGeometry.test.js の (a)〜(h) と同じ形）。
const L_CELLS = [rc(0, 0, 5460, 3640), rc(0, 3640, 5460, 7280), rc(5460, 3640, 9100, 7280)];
const T_CELLS = [rc(0, 0, 10920, 3640), rc(3640, 3640, 7280, 9100)];
const C_CELLS = [rc(0, 0, 3640, 8974), rc(0, 4487, 7280, 8974)];
const D_CELLS = [rc(0, 0, 7280, 7280), rc(7280, 3640, 9100, 7280)];
const E_CELLS = [rc(0, 0, 7280, 3640), rc(0, 3640, 910, 5460)];
const F_CELLS = [rc(0, 0, 9100, 3640), rc(0, 5460, 9100, 9100), rc(0, 3640, 3640, 5460), rc(5460, 3640, 9100, 5460)];
const H_CELLS = [rc(0, 0, 8645, 3640), rc(8645, 455, 9100, 3640)];
// 乱数で見つけた、先の翼の小屋梁と同じスロットの区間が後の翼から再び出てくる形（(iii) が発火する。ただし落とす区間は先の翼と
// 同一で、(iii) が無くても spanKey の使い回しで同じ梁にまとまる＝出力は変わらない。ここで固定するのは共通の不変条件だけ）。
const G_CELLS = [rc(5460, 1820, 9100, 7280), rc(3640, 3640, 5460, 9100), rc(3640, 5460, 7280, 9100)];

// 建物範囲（セル矩形の和集合）の外周の大梁（共線の連なりは1本）。[horizontal, coord, from, to] の配列。
function perimeterBeams(cells) {
  const uniq = vs => [...new Set(vs)].sort((a, b) => a - b);
  const xs = uniq(cells.flatMap(c => [c.x1, c.x2]));
  const ys = uniq(cells.flatMap(c => [c.y1, c.y2]));
  const inside = (x, y) => cells.some(c => x > c.x1 && x < c.x2 && y > c.y1 && y < c.y2);
  const mid = (a, i) => (a[i] + a[i + 1]) / 2;
  const out = [];
  const run = (horizontal, along, across) => {
    for (let j = 0; j < across.length; j++) {
      let start = null;
      for (let i = 0; i < along.length - 1; i++) {
        const side = k => (k < 0 || k >= across.length - 1 ? false
          : (horizontal ? inside(mid(along, i), mid(across, k)) : inside(mid(across, k), mid(along, i))));
        const edge = side(j - 1) !== side(j);
        if (edge && start === null) start = along[i];
        if (!edge && start !== null) { out.push([horizontal, across[j], start, along[i]]); start = null; }
      }
      if (start !== null) out.push([horizontal, across[j], start, along[along.length - 1]]);
    }
  };
  run(true, xs, ys);
  run(false, ys, xs);
  return out;
}

// 屋根専用平面の合成 graph（矩形でない寄棟用）。通り芯はセル矩形の座標の全て。beams＝大梁（軒桁）[horizontal, coord, from, to]。
function makeWingRoof({ cells, beams = perimeterBeams(cells) }) {
  const graph = new PlanGraph(new Plane('roof1', 6000, '小屋伏図', 1, 1, false, null, 0, true, 'p_top'));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const uniq = vs => [...new Set(vs)].sort((a, b) => a - b);
  const xs = uniq(cells.flatMap(c => [c.x1, c.x2])).map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, STRUCT));
  const ys = uniq(cells.flatMap(c => [c.y1, c.y2])).map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, STRUCT));
  const X = v => xs.find(c => c.value === v);
  const Y = v => ys.find(c => c.value === v);
  for (const [horizontal, coord, from, to] of beams) {
    if (horizontal) graph.addBeam(WOOD, 'WOOD-120x120', Y(coord), false, X(from), X(to), { role: 'primary', beamType: '軒桁' });
    else graph.addBeam(WOOD, 'WOOD-120x120', X(coord), true, Y(from), Y(to), { role: 'primary', beamType: '軒桁' });
  }
  return { graph, X, Y, region: { key: 'main', rect: null, rects: cells, shape: RoofShape.HIP, ridgeIsVertical: null, highSide: null } };
}

// 小屋梁・飛び梁（roofBeam）と、直交する梁（大梁を含む全部）が、互いの内部で交差していないか（交差の記述を返す）。
function interiorCrossings(graph) {
  const tol = CL_OVERLAP_TOL_MM;
  const lo = b => Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  const hi = b => Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  const out = [];
  for (const a of roofBeams(graph)) {
    for (const b of graph.beams) {
      if (a === b || a.isVertical === b.isVertical) continue;
      if (b.axisValue > lo(a) + tol && b.axisValue < hi(a) - tol && a.axisValue > lo(b) + tol && a.axisValue < hi(b) - tol) {
        out.push(`${desc(a)} × ${desc(b)}`);
      }
    }
  }
  return out;
}

// 小屋梁・飛び梁どうしが同じ向き・同じ軸で、許容差を超えて重なっている組の記述（翼の間で同じ梁が二重にならない＝(iii)）。
function parallelOverlaps(graph) {
  const tol = CL_OVERLAP_TOL_MM;
  const lo = b => Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  const hi = b => Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  const bs = roofBeams(graph);
  const out = [];
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i];
      const b = bs[j];
      if (a.isVertical === b.isVertical && Math.abs(a.axisValue - b.axisValue) <= tol && Math.min(hi(a), hi(b)) - Math.max(lo(a), lo(b)) > tol) {
        out.push(`${desc(a)} と ${desc(b)}`);
      }
    }
  }
  return out;
}

// 共通の不変条件: 束の最大間隔 1820 以下（元の全棟木・母屋）／交差なし／同軸の重なりなし／2回目は created 0・removed 0・id 不変・梁芯CL不変。
function assertWingInvariants(graph, region, label) {
  const r1 = autoFillWoodRoofFraming(graph, PROJECT, [region]);
  for (const g of maxStrutGaps(graph, region)) {
    assert.ok(g.max <= F.strutMaxPitchMm + CL_OVERLAP_TOL_MM, `${label}: 線 coord=${g.coord} ${g.lo}..${g.hi} の束の最大間隔 ${g.max} が1820以下`);
  }
  assert.deepEqual(interiorCrossings(graph), [], `${label}: 小屋梁どうし・大梁と内部で交差しない`);
  assert.deepEqual(parallelOverlaps(graph), [], `${label}: 小屋梁どうしが同じ軸で重ならない`);
  const ids = roofBeams(graph).map(b => b.id).sort();
  const clCount = graph.centerLines.length;
  for (let i = 0; i < 2; i++) {
    const r = autoFillWoodRoofFraming(graph, PROJECT, [region]);
    assert.deepEqual([r.created.length, r.removed.length], [0, 0], `${label}: ${i + 2}回目は変化 0`);
  }
  assert.deepEqual(roofBeams(graph).map(b => b.id).sort(), ids, `${label}: id 不変`);
  assert.equal(graph.centerLines.length, clCount, `${label}: 梁芯CLも増えない`);
  return r1;
}

// (a) L字（接合部 x=5460・y=3640 に大梁がある）。翼は W1（棟木 x=2730・段2730）→ W2（棟木 y=5460・段1820）の順。
const L_BEAMS_JOINT = [
  [true, 0, 0, 5460], [true, 3640, 0, 5460], [true, 3640, 5460, 9100], [true, 7280, 0, 5460], [true, 7280, 5460, 9100],
  [false, 0, 0, 3640], [false, 0, 3640, 7280], [false, 5460, 0, 3640], [false, 5460, 3640, 7280], [false, 9100, 3640, 7280],
];

test('【矩形でない寄棟・L字】接合部に大梁がある: 小屋梁は翼ごとに4本（W1 の梁間 y=2730・4550、W2 の梁間 x=3640・7280）、飛び梁は W1 の妻側に2本。束の間隔・交差なし・冪等', () => {
  const { graph, region } = makeWingRoof({ cells: L_CELLS, beams: L_BEAMS_JOINT });
  const r = assertWingInvariants(graph, region, 'L字');
  assert.deepEqual(koyaDescs(graph), ['x=3640:4550..7280', 'x=7280:3640..7280', 'y=2730:0..5460', 'y=4550:0..5460']);
  assert.deepEqual(tobibariDescs(graph), ['x=2730:0..2730', 'x=2730:4550..7280']);
  assert.ok(r.created.length >= 6 && r.removed.length === 0, `created=${r.created.length}`);
});

test('【矩形でない寄棟・L字】外周の大梁だけ（接合部に大梁なし）: W2 の小屋梁は先の翼（W1）の小屋梁を host に使い、y=4550 は弦に沿って 0..9100 へ延びる。x=3640 の 2730..4550 は別の翼の中で自分の線を横切らないので作らない（ii）', () => {
  const beams = [
    [true, 0, 0, 5460], [false, 5460, 0, 3640], [true, 3640, 5460, 9100], [false, 9100, 3640, 7280], [true, 7280, 0, 9100], [false, 0, 0, 7280],
  ];
  const { graph, region } = makeWingRoof({ cells: L_CELLS, beams });
  assertWingInvariants(graph, region, 'L字・外周');
  assert.deepEqual(koyaDescs(graph), [
    'x=3640:4550..7280', 'x=5460:3640..4550', 'x=5460:4550..7280', 'x=7280:3640..4550', 'x=7280:4550..7280', 'y=2730:0..5460', 'y=4550:0..9100',
  ]);
  assert.deepEqual(tobibariDescs(graph), ['x=2730:0..2730', 'x=2730:4550..7280']);
  assert.ok(!descs(graph).includes('x=3640:2730..4550'));
});

test('【矩形でない寄棟・形の網羅】(c)C字・(d)正方形の翼・(e)幅910の翼・(f)中庭・(h)角を欠いた矩形（外周の大梁だけ）: 束の最大間隔 1820 以下・交差なし・冪等・梁を1本以上作る（(e)(h) は翼が細く host の対が無い場合を除く）', () => {
  const shapes = { c: C_CELLS, d: D_CELLS, e: E_CELLS, f: F_CELLS, h: H_CELLS, g: G_CELLS, a: L_CELLS, b: T_CELLS };
  const counts = {};
  for (const [name, cells] of Object.entries(shapes)) {
    const { graph, region } = makeWingRoof({ cells });
    assertWingInvariants(graph, region, `(${name})`);
    counts[name] = roofBeams(graph).length;
  }
  for (const name of ['a', 'b', 'c', 'd', 'f']) assert.ok(counts[name] >= 1, `(${name}) は小屋梁ができる（${JSON.stringify(counts)}）`);
});

test('【矩形でない寄棟・撤去】[] や陸屋根相当（regions に無い）で auto の小屋梁・飛び梁は全て撤去され、locked は残る。再び寄棟にすると作り直される', () => {
  const { graph, region } = makeWingRoof({ cells: L_CELLS, beams: L_BEAMS_JOINT });
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(roofBeams(graph).length, 6);
  const keep = tobibari(graph)[0];
  keep.setDimensionStatus('locked');
  const r = autoFillWoodRoofFraming(graph, PROJECT, []);
  assert.equal(r.removed.length, 5, 'auto の5本だけ撤去');
  assert.equal(r.created.length, 0);
  assert.deepEqual(roofBeams(graph).map(b => b.id), [keep.id], 'locked は残る');
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(roofBeams(graph).length, 6, '寄棟へ戻せば作り直される（locked の1本は使い回す）');
  assert.ok(graph.beamMap.has(keep.id));
});

test('【矩形でない寄棟】先の翼の seed の小屋梁（W2 の x=3640）をユーザーが削除しても再生成されず、例外も投げない。他の小屋梁は残り、収束する', () => {
  const { graph, region } = makeWingRoof({ cells: L_CELLS, beams: L_BEAMS_JOINT });
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  const seed = koyaOnly(graph).find(b => b.isVertical && b.axisValue === 3640);
  assert.ok(seed);
  graph.removeBeam(seed.id);
  let r;
  assert.doesNotThrow(() => { r = autoFillWoodRoofFraming(graph, PROJECT, [region]); });
  assert.equal(descs(graph).includes('x=3640:4550..7280'), false, '削除した小屋梁は再生成されない');
  assert.deepEqual(r.created, []);
  assert.deepEqual(koyaDescs(graph), ['x=7280:3640..7280', 'y=2730:0..5460', 'y=4550:0..5460']);
  assert.deepEqual(autoFillWoodRoofFraming(graph, PROJECT, [region]), { created: [], removed: [] }, '収束');
});

test('【矩形でない寄棟・失敗系】rects が [] ・NaN・逆順・配列でない／形状が切妻や陸屋根（rect=null）なら小屋梁を作らず、例外も投げない（既存の auto は撤去）', () => {
  const { graph, region } = makeWingRoof({ cells: L_CELLS, beams: L_BEAMS_JOINT });
  const bad = [
    { ...region, rects: [] },
    { ...region, rects: [rc(0, 0, NaN, 3640)] },
    { ...region, rects: [rc(0, 0, 5460, 3640), rc(5460, 3640, 0, 7280)] },
    { ...region, rects: null },
    { ...region, rects: 'x' },
    { ...region, shape: RoofShape.GABLE },
    { ...region, shape: RoofShape.FLAT },
  ];
  for (const b of bad) {
    let r;
    assert.doesNotThrow(() => { r = autoFillWoodRoofFraming(graph, PROJECT, [b]); }, JSON.stringify(b.shape) + JSON.stringify(b.rects));
    assert.deepEqual(r, { created: [], removed: [] });
  }
  assert.equal(roofBeams(graph).length, 0);
  // 既存の auto の小屋梁は、不正な rects の region で撤去される（region 無しと同じ）。
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(roofBeams(graph).length, 6);
  const r = autoFillWoodRoofFraming(graph, PROJECT, [{ ...region, rects: [rc(0, 0, NaN, 3640)] }]);
  assert.equal(r.removed.length, 6);
  assert.equal(roofBeams(graph).length, 0);
});

test('【矩形でない寄棟・失敗系】大梁（host）が1本も無ければ小屋梁・飛び梁は1本もできず、梁芯CLも作らない（例外なし）', () => {
  const { graph, region } = makeWingRoof({ cells: L_CELLS, beams: [] });
  const clCount = graph.centerLines.length;
  const r = autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(r.created.length, 0);
  assert.equal(graph.centerLines.length, clCount, '孤児の梁芯CLを増やさない');
});

test('【矩形でない寄棟・T字】棟木の端が別の翼の棟木の上にあるとき、その位置の小屋梁は相手の翼に置く（縦の翼の端 (5460,1820) → 横の翼の x=5460）。飛び梁なし', () => {
  const beams = [
    [true, 0, 0, 3640], [true, 0, 3640, 7280], [true, 0, 7280, 10920],
    [true, 3640, 0, 3640], [true, 3640, 3640, 7280], [true, 3640, 7280, 10920],
    [true, 9100, 3640, 7280],
    [false, 0, 0, 3640], [false, 10920, 0, 3640],
    [false, 3640, 0, 3640], [false, 3640, 3640, 9100], [false, 7280, 0, 3640], [false, 7280, 3640, 9100],
  ];
  const { graph, region } = makeWingRoof({ cells: T_CELLS, beams });
  assertWingInvariants(graph, region, 'T字');
  assert.deepEqual(koyaDescs(graph), ['x=1820:0..3640', 'x=5460:0..3640', 'x=9100:0..3640', 'y=5460:3640..7280', 'y=7280:3640..7280']);
  assert.deepEqual(tobibariDescs(graph), []);
});


// ---------------- L字（矩形でない）の片流れの下屋（E2b。面ごとに母屋を支える小屋梁。設計意図は structural-model.md） ----------------

const ct = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
// 形（roofFramingLeanTo.test.js の F1A・F1B・F2・F5・FRT1 と同じ。roof-test1.stq の2階の下屋は FRT1）。
const LF1A = { cells: [rc(0, 3640, 3640, 5460), rc(3640, 3640, 5460, 5460), rc(3640, 0, 5460, 3640)], contacts: [ct(false, 3640, 0, 3640, -1), ct(true, 3640, 0, 3640, -1)] };
const LF1B = { cells: [rc(0, 3640, 5460, 7280), rc(3640, 0, 5460, 3640)], contacts: [ct(false, 3640, 0, 3640, -1), ct(true, 3640, 0, 3640, -1)] };
const LF2 = { cells: [rc(0, 0, 5460, 1820), rc(3640, 1820, 5460, 3640)], contacts: [ct(false, 0, 0, 5460, -1)] };
const LF5 = { cells: [rc(0, 0, 5460, 1820), rc(0, 1820, 1820, 3640)], contacts: [ct(false, 0, 1820, 5460, -1), ct(true, 0, 0, 3640, -1)] };
const LFR = {
  cells: [rc(3640, -3640, 7280, 0), rc(7280, -3640, 9100, 0), rc(7280, -7280, 9100, -3640), rc(7280, -9884, 9100, -9100), rc(7280, -9100, 9100, -7280)],
  contacts: [ct(true, 7280, -9884, -9100, -1), ct(false, -3640, 3640, 7280, -1), ct(true, 7280, -7280, -3640, -1), ct(true, 7280, -9100, -7280, -1)],
};

// L字の下屋の region（roofFramingRegions.js の L字の region と同じ形）。屋根専用平面の合成 graph に外周の大梁（軒桁）を置く。
// centerLines＝通り芯以外の中心線の座標（横線 y）。実データの既存の中心線の候補を再現する用。
function makeLeanRoof({ cells, contacts, centerLinesY = [], beams }) {
  const { graph, X, Y } = makeWingRoof({ cells, ...(beams ? { beams } : {}) });
  for (const y of centerLinesY) graph.addCenterLine(CenterLineType.HORIZONTAL, y, { labeled: false, discipline: Discipline.ARCH });
  const { wings } = leanToWingsOf({ rects: cells, contacts, tolMm: CL_OVERLAP_TOL_MM });
  const region = { key: 'lean:t', rect: null, rects: cells, shape: RoofShape.MONO, ridgeIsVertical: null, highSide: null, leanToWings: wings };
  return { graph, X, Y, region };
}

test('【L字の下屋・形1a】出隅の回り込み（面は top → left）: 小屋梁は縦 x=1820・3640（top の面）と横 y=1820・3640（left の面）。左の面の host に先の面の x=3640 を数える。束の間隔・交差なし・冪等', () => {
  const { graph, region } = makeLeanRoof(LF1A);
  assert.ok(maxStrutGaps(graph, region).some(g => g.max > F.strutMaxPitchMm), '前提: 小屋梁の前は束の間隔が1820を超える線がある');
  const r = assertWingInvariants(graph, region, 'L字1a');
  assert.deepEqual(koyaDescs(graph), ['x=1820:3640..5460', 'x=3640:3640..5460', 'y=1820:3640..5460', 'y=3640:3640..5460']);
  assert.deepEqual(tobibariDescs(graph), [], '片流れに飛び梁は無い');
  assert.equal(r.created.length, 4);
  for (const b of roofBeams(graph)) assert.equal(b.dimensionStatus, 'auto');
});

test('【L字の下屋・形1b】奥行きの違う回り込み: top の面は x=1820・3640（3640..7280）、left の面は y=1820・3640（3640..5460）', () => {
  const { graph, region } = makeLeanRoof(LF1B);
  assertWingInvariants(graph, region, 'L字1b');
  assert.deepEqual(koyaDescs(graph), ['x=1820:3640..7280', 'x=3640:3640..7280', 'y=1820:3640..5460', 'y=3640:3640..5460']);
});

test('【L字の下屋・(i′)】弦が自分の母屋を横切らない区間は作らない: 形1b で屋内との境界の大梁 x=3640（y0..3640）が無くても、x=3640 の 0..3640（どの母屋の内部も横切らない）は作らず、3640..7280 だけが残る', () => {
  const beams = perimeterBeams(LF1B.cells).filter(([horizontal, coord, from, to]) => !(!horizontal && coord === 3640 && from === 0 && to === 3640));
  const { graph, region } = makeLeanRoof({ ...LF1B, beams });
  assert.equal(beams.length, perimeterBeams(LF1B.cells).length - 1, '前提: 1本だけ外した');
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.ok(koyaDescs(graph).includes('x=3640:3640..7280'));
  assert.equal(koyaDescs(graph).includes('x=3640:0..3640'), false, '母屋の内部を横切らない区間は作らない');
  assert.deepEqual(interiorCrossings(graph), []);
});

test('【L字の下屋・形2】同じ壁の出っ張り（面1つ）: 母屋 y=910 の途中だけ x=1820・3640 に 0..1820。出っ張り側の x=3640 の 1820..3640 は外周の大梁が既に占める', () => {
  const { graph, region } = makeLeanRoof(LF2);
  assertWingInvariants(graph, region, 'L字2');
  assert.deepEqual(koyaDescs(graph), ['x=1820:0..1820', 'x=3640:0..1820']);
});

test('【L字の下屋・形5】谷木の形（面は top → left）: 母屋は面ごとに1本。x=1820・3640 の 0..1820 と y=1820 の 0..1820', () => {
  const { graph, region } = makeLeanRoof(LF5);
  assertWingInvariants(graph, region, 'L字5');
  assert.deepEqual(koyaDescs(graph), ['x=1820:0..1820', 'x=3640:0..1820', 'y=1820:0..1820']);
});

test('【L字の下屋・形R】roof-test1 の2階の下屋（中心線なし）: left の面の横 y=-3640・-5460・-7280・-9100（x7280..9100）、top の面の縦 x=5460・7280（y-3640..0。x=7280 は弦が -9884..0 でも自分の線を横切る -3640..0 だけ）', () => {
  const { graph, region } = makeLeanRoof(LFR);
  assertWingInvariants(graph, region, 'L字R');
  assert.deepEqual(koyaDescs(graph), ['x=5460:-3640..0', 'x=7280:-3640..0', 'y=-3640:7280..9100', 'y=-5460:7280..9100', 'y=-7280:7280..9100', 'y=-9100:7280..9100']);
  assert.ok(koyaOnly(graph).filter(b => !b.isVertical).every(b => b.clStart.effectiveValue === 7280 && b.clEnd.effectiveValue === 9100));
});

test('【L字の下屋・形R・中心線あり】既存の中心線の候補（y=-6370）があると、通り芯の次の優先でそれが選ばれ、横の小屋梁は y=-6370・-4550（910グリッド）になる（実データ roof-test1 の2階と同じ）', () => {
  const { graph, region } = makeLeanRoof({ ...LFR, centerLinesY: [-6370] });
  assertWingInvariants(graph, region, 'L字R・中心線');
  assert.deepEqual(koyaDescs(graph), ['x=5460:-3640..0', 'x=7280:-3640..0', 'y=-4550:7280..9100', 'y=-6370:7280..9100', 'y=-7280:7280..9100', 'y=-9100:7280..9100']);
});

test('【L字の下屋・先の面の小屋梁を host に数える】形R で壁の大梁 y=-3640（x3640..7280）が無いと、top の面の x=7280 は先の面（left）の小屋梁 y=-3640（x7280..9100）の端に載って -3640..0 になる。先の面の小屋梁を数えなければ作られない', () => {
  const beams = perimeterBeams(LFR.cells).filter(([horizontal, coord, from, to]) => !(horizontal && coord === -3640 && from === 3640 && to === 7280));
  const { graph, region } = makeLeanRoof({ ...LFR, beams });
  assert.equal(beams.length, perimeterBeams(LFR.cells).length - 1, '前提: 壁の大梁を1本外した');
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.ok(koyaDescs(graph).includes('y=-3640:7280..9100'), '前提: 先の面の小屋梁 y=-3640');
  assert.ok(koyaDescs(graph).includes('x=7280:-3640..0'), '先の面の小屋梁が host');
  assert.deepEqual(interiorCrossings(graph), []);
  assert.deepEqual(parallelOverlaps(graph), []);
});

test('【L字の下屋・host の優先】x=7280 の小屋梁（top の面）の y=-3640 側の端は、同じ座標の先の面の小屋梁（y=-3640 の横）ではなく大梁（primary）に載る', () => {
  const { graph, region } = makeLeanRoof(LFR);
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  const b = koyaOnly(graph).find(k => k.isVertical && k.axisValue === 7280);
  assert.ok(b, '前提: x=7280 の小屋梁がある');
  assert.ok(koyaOnly(graph).some(k => !k.isVertical && k.axisValue === -3640), '前提: 先の面の小屋梁 y=-3640 がある');
  for (const cl of [b.clStart, b.clEnd]) {
    const host = findHostBeam(graph.beams, cl.id, false, b.axisValue, { allowRoofBeamHost: true });
    assert.equal(host?.role, 'primary', `端 ${cl.effectiveValue} の host は大梁`);
  }
});

test('【L字の下屋・撤去】[] で auto の小屋梁は全て撤去され、locked は残る。L字の region へ戻せば作り直される（locked は使い回す）', () => {
  const { graph, region } = makeLeanRoof(LF1A);
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(roofBeams(graph).length, 4);
  const keep = roofBeams(graph)[0];
  keep.setDimensionStatus('locked');
  const r = autoFillWoodRoofFraming(graph, PROJECT, []);
  assert.equal(r.removed.length, 3, 'auto の3本だけ撤去');
  assert.deepEqual(roofBeams(graph).map(b => b.id), [keep.id], 'locked は残る');
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(roofBeams(graph).length, 4);
  assert.ok(graph.beamMap.has(keep.id));
});

test('【L字の下屋・失敗系】rects が [] ・NaN・配列でない／leanToWings が無い・[]・配列でない／片流れ以外（rect=null）は小屋梁を作らず例外も投げない。既存の auto は撤去', () => {
  const { graph, region } = makeLeanRoof(LF1A);
  const bad = [
    { ...region, rects: [] },
    { ...region, rects: [rc(0, 0, NaN, 3640)] },
    { ...region, rects: 'x' },
    { ...region, leanToWings: undefined },
    { ...region, leanToWings: [] },
    { ...region, leanToWings: 'x' },
    { ...region, shape: RoofShape.GABLE },
    { ...region, shape: RoofShape.FLAT },
  ];
  for (const b of bad) {
    let r;
    assert.doesNotThrow(() => { r = autoFillWoodRoofFraming(graph, PROJECT, [b]); }, JSON.stringify(b.shape) + JSON.stringify(b.rects) + JSON.stringify(b.leanToWings));
    assert.deepEqual(r, { created: [], removed: [] });
  }
  assert.equal(roofBeams(graph).length, 0);
  autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(roofBeams(graph).length, 4);
  const r = autoFillWoodRoofFraming(graph, PROJECT, [{ ...region, leanToWings: [] }]);
  assert.equal(r.removed.length, 4, 'auto の小屋梁は region が不正になると撤去される');
  assert.equal(roofBeams(graph).length, 0);
});

test('【L字の下屋・失敗系】大梁（host）が1本も無ければ小屋梁は1本もできず、梁芯CLも作らない（例外なし）', () => {
  const { graph, region } = makeLeanRoof(LF1A);
  for (const b of [...graph.beams]) graph.removeBeam(b.id);
  const clCount = graph.centerLines.length;
  const r = autoFillWoodRoofFraming(graph, PROJECT, [region]);
  assert.equal(r.created.length, 0);
  assert.equal(graph.centerLines.length, clCount, '孤児の梁芯CLを増やさない');
});

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

// ---------------- 小屋梁の成（C2c。autoFillWoodBeamDepths） ----------------

// 小さな合成 graph。縦の大梁(primary) host を x=0 と x=span に y -hostHalf..hostHalf で置き、その間に y=0 の小屋梁を
// x0→x1 で渡す。host の長さ 2×hostHalf が短いほど、host 自身の梁成表の値は小さい（伝播・中間荷重の効きが見える）。
function makeKoyaSpan(span, { hostHalf = 910, koyaProps = {}, koyaSection = 'WOOD-120x120' } = {}) {
  const graph = new PlanGraph(new Plane('roof1', 6000, '小屋伏図', 1, 1, false, null, 0, true, 'p_top'));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, span, STRUCT);
  const ya = graph.addCenterLine(CenterLineType.HORIZONTAL, -hostHalf, STRUCT);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const yb = graph.addCenterLine(CenterLineType.HORIZONTAL, hostHalf, STRUCT);
  const hostL = graph.addBeam(WOOD, 'WOOD-120x120', x0, true, ya, yb, { role: 'primary', beamType: '軒桁' });
  const hostR = graph.addBeam(WOOD, 'WOOD-120x120', x1, true, ya, yb, { role: 'primary', beamType: '軒桁' });
  const koya = graph.addBeam(WOOD, koyaSection, y0, false, x0, x1, { role: 'roofBeam', beamType: '小屋梁', ...koyaProps });
  return { graph, koya, hostL, hostR, cl: { x0, x1, y0 } };
}
const belowCol = (x, y) => ({ x, y, axisX: x, axisY: y, role: 'standard' });

test('【C2c】小屋梁の成: スパン（両端の間）が 1820/1821/2730/2731/3640/3641/7280 のとき、表の 120/210/210/270/270/270/270', () => {
  const expected = new Map([[1820, 120], [1821, 210], [2730, 210], [2731, 270], [3640, 270], [3641, 270], [7280, 270]]);
  for (const [span, depth] of expected) {
    // 初期断面は 120x240（auto）。成が 120 なら 120x120 へ下がる＝「表の値で書く」ことを見る（既定のまま据え置きと区別）。
    const { graph, koya } = makeKoyaSpan(span, { koyaSection: 'WOOD-120x240' });
    autoFillWoodBeamDepths(graph, PROJECT, []);
    assert.equal(koya.sectionDefId, `WOOD-120x${depth}`, `span ${span}`);
  }
});

test('【C2c】小屋梁の成: 軸上・区間内の下階柱で支持点が区切られ（最大距離で引く）、軸から外れた柱・区間外の柱は区切らない', () => {
  const cut = makeKoyaSpan(3640);
  autoFillWoodBeamDepths(cut.graph, PROJECT, [belowCol(1820, 0)]);
  assert.equal(cut.koya.sectionDefId, 'WOOD-120x120', '1820＋1820 に区切られる');

  const off = makeKoyaSpan(3640);
  autoFillWoodBeamDepths(off.graph, PROJECT, [belowCol(1820, 500), belowCol(5000, 0), belowCol(-100, 0)]);
  assert.equal(off.koya.sectionDefId, 'WOOD-120x270', '軸（y=0）から500ずれた柱・区間外の柱は支持点に数えない');

  const uneven = makeKoyaSpan(3640);
  autoFillWoodBeamDepths(uneven.graph, PROJECT, [belowCol(1000, 0)]);
  assert.equal(uneven.koya.sectionDefId, 'WOOD-120x210', '最大距離 2640 で引く（1000 と 2640 の大きい方）');
});

test('【C2c】小屋梁の成: locked の小屋梁は触らず（成が表と違っても据え置き）、auto の小屋梁だけ書く。表示用の値は付けない', () => {
  const { graph, koya } = makeKoyaSpan(3640, { koyaProps: { dimensionStatus: 'locked' } });
  const updated = autoFillWoodBeamDepths(graph, PROJECT, []);
  assert.equal(koya.sectionDefId, 'WOOD-120x120', 'locked は不変');
  assert.equal(updated.includes(koya.id), false);

  const auto = makeKoyaSpan(3640);
  const updatedAuto = autoFillWoodBeamDepths(auto.graph, PROJECT, []);
  assert.deepEqual(updatedAuto.filter(id => id === auto.koya.id), [auto.koya.id], '対照: auto は書かれる（検出力）');
  assert.equal(auto.koya.woodAutoDepthMm, null);
  assert.equal(auto.koya.woodDepthFollowsManual, null);
});

test('【C2c】成の伝播: 端に下階柱が無く、小屋梁の成＞host の成なら host（受ける梁）が小屋梁と同じ成になる。host の追従印・表示用の値は付かない', () => {
  const { graph, koya, hostL, hostR } = makeKoyaSpan(3640);
  autoFillWoodBeamDepths(graph, PROJECT, []);
  assert.equal(koya.sectionDefId, 'WOOD-120x270');
  assert.equal(hostL.sectionDefId, 'WOOD-120x270', '左の host が 270 へ');
  assert.equal(hostR.sectionDefId, 'WOOD-120x270', '右の host が 270 へ');
  assert.equal(hostL.woodDepthFollowsManual, null, '伝播は手入力の追従印ではない');
  assert.equal(hostL.woodAutoDepthMm, null);
});

test('【C2c】成の伝播: 端が下階柱の位置ならその端の host へは伝播しない（F1）。片端だけ下階柱なら他端だけ伝播する', () => {
  const both = makeKoyaSpan(3640);
  autoFillWoodBeamDepths(both.graph, PROJECT, [belowCol(0, 0), belowCol(3640, 0)]);
  // 柱が (1820,…) に無いので小屋梁自身は 3640 のまま 270。端が柱の位置なので host は 120 のまま。
  assert.equal(both.koya.sectionDefId, 'WOOD-120x270');
  assert.equal(both.hostL.sectionDefId, 'WOOD-120x120');
  assert.equal(both.hostR.sectionDefId, 'WOOD-120x120');

  const one = makeKoyaSpan(3640);
  autoFillWoodBeamDepths(one.graph, PROJECT, [belowCol(0, 0)]);
  assert.equal(one.hostL.sectionDefId, 'WOOD-120x120', '柱がある端は伝播しない');
  assert.equal(one.hostR.sectionDefId, 'WOOD-120x270', '柱が無い端は伝播する');
});

test('【C2c】host の梁成表の「中間荷重」に小屋梁を数えない（U5）。同じ位置の小梁（secondary）なら荷重として数えて host が上がる（対照）', () => {
  // host は x=0 の縦の梁（y -1000..1000＝スパン2000。荷重0なら 240、荷重1なら 270）。短い（910）梁を y=0 で取りつかせる。
  const build = role => {
    const graph = new PlanGraph(new Plane('roof1', 6000, '小屋伏図', 1, 1, false, null, 0, true, 'p_top'));
    graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
    const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 910, STRUCT);
    const ya = graph.addCenterLine(CenterLineType.HORIZONTAL, -1000, STRUCT);
    const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
    const yb = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, STRUCT);
    const host = graph.addBeam(WOOD, 'WOOD-120x120', x0, true, ya, yb, { role: 'primary', beamType: '軒桁' });
    graph.addBeam(WOOD, 'WOOD-120x120', y0, false, x0, x1, { role, beamType: role === 'roofBeam' ? '小屋梁' : '小梁' });
    return { graph, host };
  };
  const koya = build('roofBeam');
  autoFillWoodBeamDepths(koya.graph, PROJECT, []);
  assert.equal(koya.host.sectionDefId, 'WOOD-120x240', '小屋梁（910・成120）は荷重に数えない＝荷重0の表値240。成は host 以下なので伝播もしない');
  const secondary = build('secondary');
  autoFillWoodBeamDepths(secondary.graph, PROJECT, []);
  assert.equal(secondary.host.sectionDefId, 'WOOD-120x270', '対照: 小梁なら中間荷重1か所＝270（この構成で荷重が効くことの検出力）');
});

test('【C2c】autoFillWoodBeamDepths: 冪等（2回目は更新なし）。onlyIds が空（手動追加の経路）なら小屋梁も触らない', () => {
  const { graph, koya } = makeKoyaSpan(3640);
  const none = autoFillWoodBeamDepths(graph, PROJECT, [], { onlyIds: [], propagate: false });
  assert.deepEqual(none, []);
  assert.equal(koya.sectionDefId, 'WOOD-120x120', 'onlyIds が空なら何も書かない');
  const first = autoFillWoodBeamDepths(graph, PROJECT, []);
  assert.ok(first.includes(koya.id));
  assert.deepEqual(autoFillWoodBeamDepths(graph, PROJECT, []), [], '2回目は更新0');
});

test('【C2c・失敗系】手動追加の経路（onlyIds＝追加した大梁・propagate:false）では、小屋梁から追加した大梁へ成を伝播しない（対照: 通常の経路は伝播して270）', () => {
  // koya（スパン3640→270）が下階柱の無い位置で hostL に載る。hostL を「いま手動追加した大梁」とみなす。
  const manual = makeKoyaSpan(3640);
  autoFillWoodBeamDepths(manual.graph, PROJECT, [], { onlyIds: [manual.hostL.id], propagate: false });
  assert.equal(manual.hostL.sectionDefId, 'WOOD-120x120', '追加した梁は自分の表値のまま（既存の小屋梁の成を受け取らない）');
  assert.equal(manual.koya.sectionDefId, 'WOOD-120x120', 'onlyIds に無い小屋梁は書かない');

  const normal = makeKoyaSpan(3640);
  autoFillWoodBeamDepths(normal.graph, PROJECT, []);
  assert.equal(normal.hostL.sectionDefId, 'WOOD-120x270', '対照: 通常の経路は小屋梁の成が host へ伝播する（検出力）');
});

test('【C2c・失敗系】長さ0の小屋梁（支持点が1点）は成を引けず据え置き、例外を投げない。非在来の graph は何もしない', () => {
  const { graph, cl } = makeKoyaSpan(3640);
  const degenerate = graph.addBeam(WOOD, 'WOOD-120x120', cl.y0, false, cl.x0, cl.x0, { role: 'roofBeam', beamType: '小屋梁' });
  assert.doesNotThrow(() => autoFillWoodBeamDepths(graph, PROJECT, []));
  assert.equal(degenerate.sectionDefId, 'WOOD-120x120');

  const steel = makeKoyaSpan(3640);
  steel.graph.structureOverride = null;
  assert.deepEqual(autoFillWoodBeamDepths(steel.graph, PROJECT, []), []);
  assert.equal(steel.koya.sectionDefId, 'WOOD-120x120');
});

// ---------------- 構造再計算の統合（本番と同じ順: 小屋伏図→最上階） ----------------

// 最上階: 既定 3640×7280 の実壁の部屋（矩形）。主屋根の形状は引数。小屋伏図: 最上階の peek で解決。
function buildProject(shape, { w = 3640, h = 7280 } = {}) {
  const project = new Project('proj-roof-framing', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1'); // 唯一の実体階＝最上階
  project.activePlaneId = 'p1';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, w, STRUCT);
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, h, STRUCT);
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
    // 小屋梁自身は梁成表・個別採番の対象外（成は専用の表。C2c。値は下の【統合】C2c のテストで固定）。
    assert.ok(koya.every(b => b.dimensionStatus === 'auto'));
    // 3周目（もう一度回しても）変化 0。
    floorSwapManager.peek = async (plane) => peekWith[plane.id] ?? null;
    const again = await recomputeStructuralForGraph(withKoya.roofGraph, withKoya.project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(again.changed, false, '収束後の再計算は変化 0（冪等）');
  } finally {
    floorSwapManager.peek = original;
  }
});

test('【統合】recomputeStructuralForGraph（C2c）: 小屋梁の断面だけが変わる再計算でも changed=true（保存・undo の判定に乗る）。収束後は false', async () => {
  const { project, g1, roofGraph } = buildProject(RoofShape.GABLE);
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => ({ p1: g1, roof1: roofGraph })[plane.id] ?? null;
    assert.ok(await converge(project, g1, roofGraph) !== null);
    const koya = roofBeams(roofGraph);
    assert.deepEqual(koya.map(b => `${desc(b)} ${b.sectionDefId}`).sort(),
      ['y=1820:0..3640 WOOD-120x270', 'y=3640:0..3640 WOOD-120x270', 'y=5460:0..3640 WOOD-120x270'],
      '3640 の小屋梁3本はスパン3640（下階柱で区切られない）＝表の270');
    // 断面だけを既定へ戻す（梁の入れ替え・柱・CL は変えない）。次の再計算の変化は成の書き戻しだけ。
    const target = koya.find(b => b.axisValue === 3640);
    const idsBefore = roofGraph.beams.map(b => b.id).sort();
    target.setField('sectionDefId', 'WOOD-120x120');
    const r = await recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(target.sectionDefId, 'WOOD-120x270', '成が表の値へ戻る');
    assert.deepEqual(roofGraph.beams.map(b => b.id).sort(), idsBefore, '前提: 梁の増減は無い＝changed の源は成の書き戻しだけ');
    assert.equal(r.changed, true);
    const again = await recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(again.changed, false, '収束後は変化 0（冪等）');
  } finally {
    floorSwapManager.peek = original;
  }
});

test('【統合・C2e-1c】mainRoofSpec.ridgeDirection を横にして再計算すると、棟木が x 方向の中央に変わり、小屋梁は縦へ作り直される。柱は不変・収束。縦（既定）へ戻す（null）と元の3本に戻る。寄棟では指定を無視する', async () => {
  const { project, g1, roofGraph } = buildProject(RoofShape.GABLE); // 3640×7280（縦長＝自動は棟木が縦）
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => ({ p1: g1, roof1: roofGraph })[plane.id] ?? null;
    assert.ok(await converge(project, g1, roofGraph) !== null);
    const autoDescs = descs(roofGraph);
    assert.deepEqual(autoDescs, ['y=1820:0..3640', 'y=3640:0..3640', 'y=5460:0..3640'], '前提: 自動（長手＝縦棟）の小屋梁は横3本');
    const colsAuto = colSig(g1);

    g1.mainRoofSpec.setField('ridgeDirection', 'horizontal');
    const region = mainRoofFramingRegion(g1, project);
    assert.equal(region.ridgeIsVertical, false, '前提: region の棟木が横');
    const sweeps = await converge(project, g1, roofGraph);
    assert.ok(sweeps !== null, `収束する（${sweeps}回）`);
    const koya = roofBeams(roofGraph);
    assert.ok(koya.length >= 1 && koya.every(b => b.isVertical === true), `小屋梁は縦に作り直される: ${descs(roofGraph).join(' ')}`);
    assert.ok(descs(roofGraph).every(d => d.startsWith('x=')), '横の小屋梁は撤去されている');
    for (const g of maxStrutGaps(roofGraph, region)) assert.ok(g.max <= F.strutMaxPitchMm, `線 y=${g.coord} の束の最大間隔 ${g.max} が1820以下`);
    assert.equal(roofGraph.columns.length, 0, '屋根に柱は立たない');
    assert.deepEqual(colSig(g1), colsAuto, '最上階の柱は棟木の向きに依らない');

    g1.mainRoofSpec.setField('ridgeDirection', null);
    assert.ok(await converge(project, g1, roofGraph) !== null);
    assert.deepEqual(descs(roofGraph), autoDescs, '自動へ戻すと元の小屋梁に戻る');

    // 寄棟では指定を無視する（棟木は長手に沿う）。指定の有無で region・小屋梁・柱が変わらない
    g1.setMainRoofSpec(new RoofSpec({ shape: RoofShape.HIP }));
    assert.ok(await converge(project, g1, roofGraph) !== null);
    const hipDescs = descs(roofGraph);
    const hipCols = colSig(g1);
    g1.mainRoofSpec.setField('ridgeDirection', 'horizontal');
    assert.equal(mainRoofFramingRegion(g1, project).ridgeIsVertical, true, '寄棟は指定を無視（縦長＝縦）');
    assert.ok(await converge(project, g1, roofGraph) !== null);
    assert.deepEqual(descs(roofGraph), hipDescs, '寄棟の小屋梁・飛び梁は指定で変わらない');
    assert.deepEqual(colSig(g1), hipCols);
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

// 【C2d-2 で書き換え・2026-10-03】C2b〜C2c 時点は「実体階の再計算は小屋梁に触れない（regions を渡さない＝I-C3）」を
// 固定していた（手で置いた auto の小屋梁が実体階の再計算で撤去されない）。C2d-2 で実体階も下屋の region（下屋が無ければ
// []）を渡すようになったため、region に無い auto の小屋梁は実体階でも撤去される。元の主題（実体階の再計算は屋根専用平面の
// 小屋梁へ書かない・実体階に新しく小屋梁を作らない・小屋梁が柱を生まない）は保ち、撤去されない側は locked に置き換えた。
test('【統合】実体階（最上階）の再計算は、下屋の無い階では auto の小屋梁を撤去し（region []）、locked は残す。屋根専用平面の小屋梁には触れず、新しく作らない', async () => {
  const { project, g1, roofGraph } = buildProject(RoofShape.GABLE);
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => ({ p1: g1, roof1: roofGraph })[plane.id] ?? null;
    await converge(project, g1, roofGraph);
    const before = descs(roofGraph);
    assert.ok(before.length >= 1);
    const colsBefore = colSig(g1);
    const cl = (type, v) => g1.centerLines.find(c => c.centerLineType === type && c.value === v);
    const put = (status) => {
      const b = g1.addBeam(WOOD, 'WOOD-120x120', cl(CenterLineType.HORIZONTAL, 7280), false,
        cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 3640), { role: 'roofBeam', beamType: '小屋梁' });
      if (status !== 'auto') b.setDimensionStatus(status);
      return b;
    };
    // 実体階（下屋なし）に置いた auto の小屋梁は、実体階の再計算で撤去され、changed に乗る。
    const planted = put('auto');
    const r1 = await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g1.beamMap.has(planted.id), false, 'region 無し（下屋なし）の実体階では auto の小屋梁は撤去される');
    assert.equal(r1.changed, true, '撤去が changed に乗る');
    // locked は残る。実体階に新しく小屋梁は作らない（置いた1本だけ）。
    const locked = put('locked');
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.ok(g1.beamMap.has(locked.id), 'locked の小屋梁は残る（作りも撤去もしない）');
    assert.equal(roofBeams(g1).length, 1, '実体階に新しく小屋梁は作らない');
    // 最上階を単独で再計算しても、屋根専用平面の小屋梁は増減しない（最上階は屋根の graph に書かない）。柱も生まない。
    assert.deepEqual(descs(roofGraph), before);
    assert.deepEqual(colSig(g1), colsBefore, '小屋梁（auto・locked とも）は柱を生まない');
  } finally {
    floorSwapManager.peek = original;
  }
});

// 【寄棟・統合】5460×9100 の最上階（実壁の1部屋）に寄棟の主屋根。収束後の小屋伏図の飛び梁・柱・成の連鎖を見る。
test('【統合・寄棟】recomputeStructuralForGraph: 小屋伏図に第1段の小屋梁と飛び梁ができ、収束し（柱は切妻のときと同じ・収束後 changed=false）、飛び梁の端の受け材の成が飛び梁の成以上になる（1段の伝播。飛び梁→小屋梁→大梁の連鎖は roofBeamWiring.test.js の単体で検証）。切妻へ戻すと飛び梁が消える', async () => {
  const size = { w: 5460, h: 9100 };
  const hip = buildProject(RoofShape.HIP, size);
  const gable = buildProject(RoofShape.GABLE, size);
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => ({ p1: hip.g1, roof1: hip.roofGraph })[plane.id] ?? null;
    const sweeps = await converge(hip.project, hip.g1, hip.roofGraph);
    assert.ok(sweeps !== null && sweeps <= 5, `収束する（${sweeps}回）`);
    assert.ok(tobibari(hip.roofGraph).length >= 1, '飛び梁ができる');
    assert.ok(koyaOnly(hip.roofGraph).length >= 1, '第1段の小屋梁ができる');
    assert.equal(hip.roofGraph.columns.length, 0, '屋根に柱は立たない');
    for (const g of maxStrutGaps(hip.roofGraph, { rect: { x1: 0, y1: 0, x2: 5460, y2: 9100 }, shape: RoofShape.HIP, ridgeIsVertical: true, highSide: null })) {
      assert.ok(g.max <= F.strutMaxPitchMm, `線 coord=${g.coord} の束の最大間隔 ${g.max}`);
    }

    // 伝播の連鎖: 飛び梁の成は、端の host（第1段の小屋梁・軒桁）の成以下（下階柱の位置の端は伝播しない＝F1）。
    const depthOf = b => Number(/x(\d+)$/.exec(b.sectionDefId)[1]);
    const columnAt = (x, y) => hip.g1.columns.some(c => Math.abs(c.axisX - x) < 1 && Math.abs(c.axisY - y) < 1);
    let checkedEnds = 0;
    for (const t of tobibari(hip.roofGraph)) {
      for (const end of [t.clStart, t.clEnd]) {
        const host = hip.roofGraph.beams.find(h => h !== t && h.isVertical !== t.isVertical && h.axisCL === end &&
          Math.min(h.clStart.effectiveValue, h.clEnd.effectiveValue) <= t.axisValue + 1 && t.axisValue - 1 <= Math.max(h.clStart.effectiveValue, h.clEnd.effectiveValue));
        assert.ok(host, '端の host がある');
        const [px, py] = t.isVertical ? [t.axisValue, end.effectiveValue] : [end.effectiveValue, t.axisValue];
        if (columnAt(px, py)) continue;
        assert.ok(depthOf(host) >= depthOf(t), `飛び梁 ${desc(t)}（${t.sectionDefId}）の端の host ${desc(host)} は ${host.sectionDefId}`);
        checkedEnds++;
      }
    }
    assert.ok(checkedEnds >= 1, '下階柱の無い端が1つは検査された（空振りでない）');
    // 小屋梁・飛び梁は梁成表・個別採番の対象外だが、小屋梁の成の表は効いている（飛び梁 2730→210 以上）。
    assert.ok(tobibari(hip.roofGraph).every(t => depthOf(t) >= 210), '飛び梁の成は表の値（スパン2730以上→210以上）');

    // 柱: 切妻の主屋根と同じ（寄棟か切妻かで下階の柱は変わらない）。
    floorSwapManager.peek = async (plane) => ({ p1: gable.g1, roof1: gable.roofGraph })[plane.id] ?? null;
    await converge(gable.project, gable.g1, gable.roofGraph);
    assert.deepEqual(colSig(hip.g1), colSig(gable.g1), '最上階の柱は屋根の形状に依らない');

    floorSwapManager.peek = async (plane) => ({ p1: hip.g1, roof1: hip.roofGraph })[plane.id] ?? null;
    const again = await recomputeStructuralForGraph(hip.roofGraph, hip.project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(again.changed, false, '収束後の再計算は変化 0（冪等）');

    // 切妻へ戻すと飛び梁が撤去される（auto）。
    hip.g1.setMainRoofSpec(new RoofSpec({ shape: RoofShape.GABLE }));
    const back = await recomputeStructuralForGraph(hip.roofGraph, hip.project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(back.changed, true);
    assert.equal(tobibari(hip.roofGraph).length, 0, '切妻に飛び梁は無い');
  } finally {
    floorSwapManager.peek = original;
  }
});

// 【矩形でない寄棟・統合】最上階が L字（3セル 9100x7280 から右上 3640x3640 を欠いた形。実壁の1部屋）の主屋根に寄棟。
function buildLProject(shape) {
  const project = new Project('proj-roof-framing-l', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  project.activePlaneId = 'p1';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x = [0, 5460, 9100].map(v => g1.addCenterLine(CenterLineType.VERTICAL, v, STRUCT));
  const y = [0, 3640, 7280].map(v => g1.addCenterLine(CenterLineType.HORIZONTAL, v, STRUCT));
  const room = g1.addRoom(new Set([
    `${x[0].id}:${y[0].id}:${x[1].id}:${y[1].id}`, `${x[0].id}:${y[1].id}:${x[1].id}:${y[2].id}`, `${x[1].id}:${y[1].id}:${x[2].id}:${y[2].id}`,
  ]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.setMainRoofSpec(new RoofSpec({ shape }));
  const { graph: roofGraph } = project.addPlane(3000, '小屋伏図', 'roof1', 1, 1, false, null, 0, true, 'p1');
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  return { project, g1, roofGraph };
}

test('【統合・矩形でない寄棟】recomputeStructuralForGraph: L字の寄棟の主屋根で、小屋伏図に小屋梁ができ、収束し（柱は陸屋根の対照と全て一致・収束後 changed=false）、束の最大間隔は元の全線で 1820 以下・交差なし。陸屋根へ変えると全て撤去される', async () => {
  const hip = buildLProject(RoofShape.HIP);
  const flat = buildLProject(RoofShape.FLAT); // 陸屋根＝region なし＝小屋梁なし（対照）
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => ({ p1: hip.g1, roof1: hip.roofGraph })[plane.id] ?? null;
    const region = mainRoofFramingRegion(hip.g1, hip.project);
    assert.ok(region && region.rect === null && region.rects.length >= 1, '前提: region は矩形でない寄棟（rect=null）');
    const sweeps = await converge(hip.project, hip.g1, hip.roofGraph);
    assert.ok(sweeps !== null && sweeps <= 6, `収束する（${sweeps}回）`);
    assert.ok(koyaOnly(hip.roofGraph).length >= 1, '小屋梁ができる');
    assert.equal(hip.roofGraph.columns.length, 0, '屋根に柱は立たない');
    for (const g of maxStrutGaps(hip.roofGraph, region)) {
      assert.ok(g.max <= F.strutMaxPitchMm + CL_OVERLAP_TOL_MM, `線 coord=${g.coord} ${g.lo}..${g.hi} の束の最大間隔 ${g.max}`);
    }
    assert.deepEqual(interiorCrossings(hip.roofGraph), [], '小屋梁は大梁・他の小屋梁と内部で交差しない');

    floorSwapManager.peek = async (plane) => ({ p1: flat.g1, roof1: flat.roofGraph })[plane.id] ?? null;
    await converge(flat.project, flat.g1, flat.roofGraph);
    assert.equal(roofBeams(flat.roofGraph).length, 0, '対照（陸屋根）は小屋梁なし');
    assert.deepEqual(colSig(hip.g1), colSig(flat.g1), '最上階の柱は屋根の形状に依らない');

    floorSwapManager.peek = async (plane) => ({ p1: hip.g1, roof1: hip.roofGraph })[plane.id] ?? null;
    const again = await recomputeStructuralForGraph(hip.roofGraph, hip.project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(again.changed, false, '収束後の再計算は変化 0（冪等）');

    hip.g1.setMainRoofSpec(new RoofSpec({ shape: RoofShape.FLAT }));
    const back = await recomputeStructuralForGraph(hip.roofGraph, hip.project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(back.changed, true);
    assert.equal(roofBeams(hip.roofGraph).length, 0, '陸屋根では region が無い＝auto の小屋梁を全撤去');
  } finally {
    floorSwapManager.peek = original;
  }
});

test('【統合・失敗系・寄棟】寄棟の主屋根を陸屋根へ変えて再計算すると、小屋梁と飛び梁が全て撤去される（auto）', async () => {
  const { project, g1, roofGraph } = buildProject(RoofShape.HIP, { w: 5460, h: 9100 });
  const original = floorSwapManager.peek;
  try {
    floorSwapManager.peek = async (plane) => ({ p1: g1, roof1: roofGraph })[plane.id] ?? null;
    await converge(project, g1, roofGraph);
    assert.ok(tobibari(roofGraph).length >= 1, '前提: 寄棟では飛び梁がある');
    g1.setMainRoofSpec(new RoofSpec({ shape: RoofShape.FLAT }));
    const r = await recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(r.changed, true);
    assert.equal(roofBeams(roofGraph).length, 0);
  } finally {
    floorSwapManager.peek = original;
  }
});
