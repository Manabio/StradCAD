// 矩形の下屋（実体階の屋根セル）への小屋梁の自動生成（ステップ C2d-2）の統合テスト。
// 設計意図: .claude/structural-model.md「小屋梁」「下屋の外周の梁」。実体階の再計算は、下屋の region（roofFramingRegions.js
// leanToFramingRegions）を autoFillWoodRoofFraming へ渡す。region に無い auto の小屋梁は撤去され、locked は残る。
// 比べるのは位置由来のキー（軸・座標・区間）で、エンティティ配列は deepEqual しない。
// 単体（region の rect が不正・退化）は woodRoofFraming.test.js、屋根専用平面の主屋根は woodRoofFraming.test.js【統合】。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Project, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape, RoofHighSide, beamExclusionKey,
} from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { leanToFraming, leanToFramingRegions, leanToFramingCellKeys } from './roofFramingRegions.js';
import { roofFramingLines, roofStrutPoints } from './roofFramingGeometry.js';
import { roofFramingHostMembers } from './framingDrawing.js';

const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const SQ = 3640;
const F = rulesFor(TRADITIONAL_WOOD_STRUCTURE).framing;

// 4列×3行（各3640角）の格子。1階: 左列の2セル＋下屋の範囲の1部屋（外周に壁）。2階: 左列の2セルが屋内（外周に壁）、
// lean の各グループ（セル (i,j) の配列）が1つずつの下屋（屋根セル。壁なし）。leanOpts.highSide で片流れの高い側を明示。
function buildTwoFloors(leanGroups, { highSide = RoofHighSide.TOP } = {}) {
  const project = new Project('proj-lean-koya', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const grid = (g) => {
    const xs = [0, 1, 2, 3].map(i => g.addCenterLine(CenterLineType.VERTICAL, i * SQ, STRUCT));
    const ys = [0, 1, 2, 3].map(j => g.addCenterLine(CenterLineType.HORIZONTAL, j * SQ, STRUCT));
    return (i, j) => `${xs[i].id}:${ys[j].id}:${xs[i + 1].id}:${ys[j + 1].id}`;
  };
  const c1 = grid(g1);
  // 1階は下屋ごとに1部屋（最初の下屋だけ左列と同じ部屋）。下屋どうしの境界にも1階の壁線を置く。
  leanGroups.forEach((cells, n) => {
    const own = cells.map(([i, j]) => c1(i, j));
    generateRoomWallsFromOutline(g1, g1.addRoom(new Set(n === 0 ? [c1(0, 0), c1(0, 1), ...own] : own), `A${n}`));
  });
  const c2 = grid(g2);
  generateRoomWallsFromOutline(g2, g2.addRoom(new Set([c2(0, 0), c2(0, 1)]), '居間'));
  const roofs = leanGroups.map((cells, n) => {
    const roof = g2.addRoom(new Set(cells.map(([i, j]) => c2(i, j))), `屋根${n}`);
    roof.setKind(RoomKind.EXTERIOR);
    roof.setFeature(RoomFeature.ROOF);
    roof.setRoofSpec(createLeanToRoofSpec());
    roof.roofSpec.setField('highSide', highSide);
    return roof;
  });
  return { project, g1, g2, roofs };
}

async function withPeek(graphs, fn) {
  const peekMap = Object.fromEntries(graphs.map(g => [g.plane.id, g]));
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try { return await fn(); } finally { floorSwapManager.peek = original; }
}

// 本番の反映パスと同じ降順（上階→下階）を、2階・1階とも changed=false になるまで回す（上限8周）。
async function converge({ project, g1, g2 }) {
  return withPeek([g1, g2], async () => {
    const history = [];
    for (let i = 0; i < 8; i++) {
      const a = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
      const b = await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
      history.push([!!a.changed, !!b.changed]);
      if (!a.changed && !b.changed) return history;
    }
    return history;
  });
}
const recompute2F = ({ project, g1, g2 }) => withPeek([g1, g2], () => recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE));

const r = v => Math.round(v * 100) / 100;
const lo = b => Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
const hi = b => Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
const key = b => [b.isVertical ? 'V' : 'H', r(b.axisValue), r(lo(b)), r(hi(b))].join('|');
const koya = g => g.beams.filter(b => b.role === 'roofBeam');
const koyaKeys = g => koya(g).map(key).sort();
const colSig = g => g.columns.map(c => `${r(c.axisX)},${r(c.axisY)},${c.role},${c.sectionDefId}`).sort();
const beamSig = (g, role) => g.beams.filter(b => b.role === role).map(key).sort();
// 軸ごとの被覆区間（隣接・重なりを併合）。梁が小屋梁の梁芯CLで分割されても被覆は同じ、を比べる署名。
function coverage(graph, filter) {
  const byAxis = new Map();
  for (const b of graph.beams.filter(filter)) {
    const k = `${b.isVertical ? 'x' : 'y'}=${r(b.axisValue)}`;
    if (!byAxis.has(k)) byAxis.set(k, []);
    byAxis.get(k).push([lo(b), hi(b)]);
  }
  return [...byAxis].map(([k, iv]) => {
    iv.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [l, h] of iv) {
      if (merged.length && l <= merged[merged.length - 1][1] + 1) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], h);
      else merged.push([l, h]);
    }
    return `${k}:${merged.map(m => m.join('..')).join(',')}`;
  }).sort();
}
const withoutKoya = b => b.role !== 'roofBeam';

// 母屋・棟木の各線の束の最大間隔（線の両端を含む）。
function maxStrutGaps(graph, region) {
  const { ridges, purlins } = roofFramingLines({
    rect: region.rect, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: CL_OVERLAP_TOL_MM,
  });
  const members = roofFramingHostMembers(graph.beams, rulesFor(TRADITIONAL_WOOD_STRUCTURE).baseMaterial);
  return [...ridges, ...purlins].map(line => {
    const alongs = [line.lo, line.hi, ...roofStrutPoints([line], members, CL_OVERLAP_TOL_MM).map(p => (line.isVertical ? p.y : p.x))]
      .sort((a, b) => a - b);
    let max = 0;
    for (let i = 0; i + 1 < alongs.length; i++) max = Math.max(max, alongs[i + 1] - alongs[i]);
    return { coord: line.coord, max };
  });
}

const ONE_LEAN = [[[1, 0], [2, 0]]]; // 2階 x3640..10920 × y0..3640（短手3640＝片流れ。高い側は上）
// 母屋は横線（y=910・1820・2730）。小屋梁は縦で、上下の軒（y=0・y=3640）の大梁から大梁へ。
const EXPECTED_KOYA = ['V|5460|0|3640', 'V|7280|0|3640', 'V|9100|0|3640'];

test('【統合】矩形の下屋（片流れ・高い側＝上）: 2階の伏図に、母屋と直交する縦の小屋梁が束の間隔1820以下になる位置（x=5460・7280・9100）に軒から軒まで出る。成は表どおり270・auto・梁芯CLは由来 roofBeam', async () => {
  const doc = buildTwoFloors(ONE_LEAN);
  const region = leanToFramingRegions(doc.g2, doc.project)[0];
  assert.deepEqual([region.shape, region.highSide], [RoofShape.MONO, RoofHighSide.TOP], '前提: 片流れ・高い側は上');
  const history = await converge(doc);
  assert.deepEqual(history.at(-1), [false, false], `収束: ${JSON.stringify(history)}`);
  assert.ok(history.length <= 5, `スイープ数は上限5以内: ${history.length}`);

  assert.deepEqual(koyaKeys(doc.g2), EXPECTED_KOYA);
  const hostCL = (v) => doc.g2.centerLines.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.value === v);
  for (const b of koya(doc.g2)) {
    assert.equal(b.beamType, '小屋梁');
    assert.equal(b.dimensionStatus, 'auto');
    assert.equal(b.sectionDefId, 'WOOD-120x270', 'スパン3640（軸上に下階の柱なし）は小屋梁の成の表で270');
    assert.deepEqual([b.clStart, b.clEnd].sort((p, q) => p.effectiveValue - q.effectiveValue), [hostCL(0), hostCL(SQ)], '端の host は上下の軒の大梁の axisCL そのもの');
  }
  // 位置が通り芯（x=7280）なら通り芯を軸にし、無い位置（5460・9100）には梁芯CL（由来 roofBeam）ができる。
  const axisOf = v => koya(doc.g2).find(b => b.axisValue === v).axisCL;
  assert.equal(axisOf(7280).labeled, true);
  assert.deepEqual([5460, 9100].map(v => axisOf(v).beamAxisOrigin), [BeamAxisOrigin.ROOF_BEAM, BeamAxisOrigin.ROOF_BEAM]);
  // 束の間隔: 全ての母屋で1820以下（小屋梁の前は 5460 など1820超）
  for (const g of maxStrutGaps(doc.g2, region)) assert.ok(g.max <= F.strutMaxPitchMm, `母屋 y=${g.coord} の束の最大間隔 ${g.max}`);
  // 1階には小屋梁は出ない（実体階ごとの自階の梁）。
  assert.equal(koya(doc.g1).length, 0);
});

// 【C2e-1b で書き換え】対照はこれまで「同じ下屋を寄棟にして小屋梁だけを作らない版」だったが、寄棟も小屋梁（と飛び梁）を作るように
// なった。陸屋根へ置き換えると外周の梁・床梁ガード（対象の下屋だけ）が変わり対照にならないので、同じ片流れで収束させた後に
// 小屋梁を removeBeam で除外（excludedBeamSlots）して再収束させた版を対照にする（外周の梁・床梁ガードは同じ。梁芯CLは孤児として残る）。
test('【統合】下屋の小屋梁は柱を生まず・床梁の区画を作らず・他の梁を分割しない（対照: 同じ下屋で小屋梁だけを除外した版と、両階の柱・床梁・大梁の被覆が一致）', async () => {
  const withKoya = buildTwoFloors(ONE_LEAN);
  const control = buildTwoFloors(ONE_LEAN);
  assert.equal(leanToFramingCellKeys(control.g2, control.project).size, 2, '前提: 対照も対象の下屋（外周の梁・床梁ガードは同じ）');
  await converge(withKoya);
  await converge(control);
  for (const b of koya(control.g2)) control.g2.removeBeam(b.id);
  await converge(control);
  assert.equal(koya(withKoya.g2).length, 3, '前提: 本体は小屋梁が出る');
  assert.equal(koya(control.g2).length, 0, '前提: 対照は小屋梁なし（除外されて再生成されない）');
  for (const k of ['g1', 'g2']) {
    assert.deepEqual(colSig(withKoya[k]), colSig(control[k]), `${k} の柱は小屋梁の有無で同じ`);
    assert.deepEqual(beamSig(withKoya[k], 'floor'), beamSig(control[k], 'floor'), `${k} の床梁は同じ`);
    assert.deepEqual(coverage(withKoya[k], withoutKoya), coverage(control[k], withoutKoya), `${k} の大梁の被覆は同じ`);
  }
  assert.ok(withKoya.g2.beams.every(b => b.role !== 'floor' || b.axisValue < SQ + 1 || (!b.isVertical && hi(b) < SQ + 1)), '下屋の範囲（x>3640）に床梁は出ない');
});

test('【統合】小屋梁の作成・成の変化・撤去は、他の梁が1本も変わらなくても changed=true（保存・undo の判定に乗る）。収束後は false', async () => {
  // 【C2e-1b で書き換え】小屋梁なしの収束状態は、寄棟（今は小屋梁を作る）ではなく、片流れで収束させた後に小屋梁を
  // removeBeam で除外した状態で作る。除外集合を空にして再生成させる（梁芯CLは孤児として残るので同じ区間の鍵に戻る）。
  const doc = buildTwoFloors(ONE_LEAN);
  await converge(doc);
  for (const b of koya(doc.g2)) doc.g2.removeBeam(b.id);
  await converge(doc);
  assert.equal(koya(doc.g2).length, 0);
  const primaryIds = () => doc.g2.beams.filter(b => b.role === 'primary').map(b => b.id).sort();
  const before = primaryIds();

  doc.g2.excludedBeamSlots.clear(); // 作成
  const created = await recompute2F(doc);
  assert.equal(koya(doc.g2).length, 3, '片流れで小屋梁ができる');
  assert.deepEqual(primaryIds(), before, '前提: この回は大梁が1本も入れ替わらない＝changed の源は小屋梁だけ');
  assert.equal(created.changed, true);
  await converge(doc);

  const target = koya(doc.g2).find(b => b.axisValue === 7280);
  target.setField('sectionDefId', 'WOOD-120x120'); // 成の変化
  const depth = await recompute2F(doc);
  assert.equal(target.sectionDefId, 'WOOD-120x270', '成が表の値へ戻る');
  assert.equal(depth.changed, true);
  assert.equal((await recompute2F(doc)).changed, false, '収束後は変化 0（冪等）');

  // 撤去: 形状は片流れのまま、除外の鍵だけを入れて候補から外す（陸屋根にすると下屋の外周の梁も消えて
  // 「他の梁が変わらない」前提が崩れ、changed が大梁の変化だけで真になりうるため）。
  const beforeRemoval = primaryIds();
  for (const b of koya(doc.g2)) doc.g2.excludedBeamSlots.add(beamExclusionKey('roofBeam', b.axisCL, b.clStart, b.clEnd));
  const removed = await recompute2F(doc);
  assert.equal(koya(doc.g2).length, 0, '除外した小屋梁は撤去される');
  assert.deepEqual(primaryIds(), beforeRemoval, '前提: この回も大梁は1本も入れ替わらない＝changed の源は小屋梁の撤去だけ');
  assert.equal(removed.changed, true);
});

test('【統合・失敗系】下屋を削除（屋根の部屋を外す）して再計算すると auto の小屋梁が撤去され changed=true。locked の小屋梁は region が無くなっても残る', async () => {
  const auto = buildTwoFloors(ONE_LEAN);
  await converge(auto);
  assert.equal(koya(auto.g2).length, 3, '前提');
  auto.g2.removeRoom(auto.roofs[0].id);
  assert.equal(leanToFramingRegions(auto.g2, auto.project).length, 0, '前提: region が無くなった');
  const res = await recompute2F(auto);
  assert.equal(res.changed, true);
  assert.equal(koya(auto.g2).length, 0, 'auto の小屋梁は撤去される');
  await converge(auto);
  assert.equal(koya(auto.g2).length, 0, '収束後も再生成されない');

  const locked = buildTwoFloors(ONE_LEAN);
  await converge(locked);
  const ids = koya(locked.g2).map(b => b.id).sort();
  for (const b of koya(locked.g2)) b.setDimensionStatus('locked');
  locked.g2.removeRoom(locked.roofs[0].id);
  await converge(locked);
  assert.deepEqual(koya(locked.g2).map(b => b.id).sort(), ids, 'locked の小屋梁は region が無くなっても残る（同じ実体のまま）');
});

test('【統合・失敗系】対象でない下屋（L字・陸屋根）・非在来では小屋梁を作らない。非在来へ変えると既存の auto の小屋梁は撤去される', async () => {
  const lShape = buildTwoFloors([[[1, 0], [2, 0], [2, 1]]]);
  assert.equal(leanToFramingRegions(lShape.g2, lShape.project).length, 0, '前提: L字は region 無し');
  await converge(lShape);
  assert.equal(koya(lShape.g2).length, 0, 'L字の下屋は作らない（従来どおり）');

  const flat = buildTwoFloors(ONE_LEAN);
  flat.roofs[0].roofSpec.setField('shape', RoofShape.FLAT);
  await converge(flat);
  assert.equal(koya(flat.g2).length, 0, '陸屋根の下屋は作らない');

  const nonWood = buildTwoFloors(ONE_LEAN);
  nonWood.g2.structureOverride = 'S造';
  await withPeek([nonWood.g1, nonWood.g2], () => recomputeStructuralForGraph(nonWood.g2, nonWood.project, 'S造'));
  assert.equal(koya(nonWood.g2).length, 0, '非在来は作らない');

  const switched = buildTwoFloors(ONE_LEAN);
  await converge(switched);
  assert.equal(koya(switched.g2).length, 3, '前提');
  switched.g2.structureOverride = 'S造';
  const res = await withPeek([switched.g1, switched.g2], () => recomputeStructuralForGraph(switched.g2, switched.project, 'S造'));
  assert.equal(koya(switched.g2).length, 0, '非在来へ変えると auto の小屋梁は撤去される');
  assert.equal(res.changed, true);
});

test('【統合】1つの階に下屋が2つあれば region ごとに小屋梁を作る（上下に隣り合う別々の下屋。境界の y=3640 の梁が両方の host）', async () => {
  const doc = buildTwoFloors([[[1, 0], [2, 0]], [[1, 1], [2, 1]]]);
  assert.equal(leanToFramingRegions(doc.g2, doc.project).length, 2, '前提: 2つの region');
  const history = await converge(doc);
  assert.deepEqual(history.at(-1), [false, false], `収束: ${JSON.stringify(history)}`);
  assert.ok(history.length <= 5, `スイープ数は上限5以内: ${history.length}`);
  assert.deepEqual(koyaKeys(doc.g2), [...EXPECTED_KOYA, 'V|5460|3640|7280', 'V|7280|3640|7280', 'V|9100|3640|7280'].sort());
});

test('【統合】leanToFraming は leanToFramingRegions・leanToFramingCellKeys と同じ結果を1回の走査で返す', () => {
  const doc = buildTwoFloors([[[1, 0], [2, 0]], [[1, 1], [2, 1]]]);
  const both = leanToFraming(doc.g2, doc.project);
  assert.deepEqual(both.regions, leanToFramingRegions(doc.g2, doc.project));
  assert.deepEqual([...both.cellKeys], [...leanToFramingCellKeys(doc.g2, doc.project)]);
  assert.equal(both.cellKeys.size, 4);
});

test('【失敗系】leanToFraming: graph 無し・非在来・下屋なしは空の regions と空のセルキー', () => {
  const doc = buildTwoFloors(ONE_LEAN);
  assert.equal(leanToFraming(doc.g2, doc.project).regions.length, 1, '前提: 正常なら下屋が1つ');
  for (const [g, p] of [[null, doc.project], [doc.g1, doc.project]]) {
    const res = leanToFraming(g, p);
    assert.deepEqual(res.regions, []);
    assert.equal(res.cellKeys.size, 0);
  }
  doc.g2.structureOverride = null; // 階の上書きを外し、project の主構造で判断させる
  doc.project.structuralInfo.mainStructure = 'S造';
  assert.deepEqual(leanToFraming(doc.g2, doc.project).regions, [], '非在来');
});
