// 小屋梁（role:'roofBeam'）の種別配線（ステップC2a）の統合テスト。
// 設計意図: .claude/structural-model.md「小屋組」の節の表「小屋梁が入る集合・外れる集合」。
// 生成処理（C2b）はまだ無い——合成graphに小屋梁を1本置いて各処理を通し、表どおり
// 「ホワイトリスト方式の集合には入らない（＝巻き込まれない）」「既定で入る集合には入る」を固定する。
// 構造再計算（recomputeStructuralForGraph）を通しても、手で置いた auto の小屋梁が
// 撤去されず・成を書き換えられず・柱を生まず・他の梁を分割しないこと、が主題。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, StructuralMaterialType,
} from '../core.js';
import { findHostBeam, findHostPrimaryBeam } from '../core/structuralEntities.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { autoFillBeamEccentricity } from './structuralAutoFill.js';
import {
  autoFillWoodBeamDepths, autoFillWoodFloorBeams, conformWoodSections,
} from './woodAutoFill.js';
import { columnSeedBeamSegments } from './wallBeamAxes.js';
import { mergePrimaryBeamRuns } from './woodFraming.js';
import { resolveBeamJunctionSpans } from './beamJunction.js';
import { fixedMembersReferencing } from './fixedMemberRefs.js';
import { showsWoodBeamDepthFields } from './woodBeamDepthInput.js';
import { WOOD_DEPTH_BEAM_ROLES } from './structureRules.js';

const WOOD = StructuralMaterialType.WOOD;
const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);

function makeGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  return graph;
}

// ---- 2階建ての合成文書（woodAutoFill.test.js【統合・3b×3d】と同じ構成）----
// 1階: 3640×1820 の実壁の部屋＋通り芯 x=910（壁なし）。2階: 通り芯 x0/x1/xm(910)/y0/y1(1820)。
// extra(g2, cls) が2階へ足す梁（小屋梁・対照の梁）を置く。
function buildTwoFloors(extra) {
  const project = new Project('proj-roofbeam', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, STRUCT);
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, STRUCT);
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.addCenterLine(CenterLineType.VERTICAL, 910, STRUCT); // 走行方向アンカー（壁なし）
  const cls = {
    x0: g2.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT),
    x1: g2.addCenterLine(CenterLineType.VERTICAL, 3640, STRUCT),
    xm: g2.addCenterLine(CenterLineType.VERTICAL, 910, STRUCT),
    y0: g2.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT),
    y1: g2.addCenterLine(CenterLineType.HORIZONTAL, 1820, STRUCT),
  };
  const placed = extra ? extra(g2, cls) : [];
  return { project, g1, g2, placed };
}

async function withPeek(project, graphs, fn) {
  const peekMap = Object.fromEntries(graphs.map(g => [g.plane.id, g]));
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try { return await fn(); } finally { floorSwapManager.peek = original; }
}

// 本番の反映パスと同じ降順（上階→下階）を3周回す。
async function sweep(project, g1, g2, times = 3) {
  const changes = [];
  for (let i = 0; i < times; i++) {
    const a = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    const b = await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    changes.push([!!a.changed, !!b.changed]);
  }
  return changes;
}

const r = v => Math.round(v * 100) / 100;
function beamLines(graph, excludeRole = 'roofBeam') {
  return graph.beams.filter(b => b.role !== excludeRole).map(b => [
    b.role, b.isVertical ? 'V' : 'H', r(b.axisValue),
    r(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue)), r(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)), b.sectionDefId,
  ].join('|')).sort();
}
function columnLines(graph) {
  return graph.columns.map(c => [c.role, r(c.axisX), r(c.axisY), c.sectionDefId].join('|')).sort();
}

// 小屋梁を x=910 の縦軸に y0→y1 で置く（1階の壁の y=0 と y=1820 を端で結ぶ位置——大梁(primary)なら
// 3h-2の点源になって1階に柱を生む配置。対照の primary 版で検出力を示す）。
const putRoofBeam = (role, status = 'auto', section = 'WOOD-120x210') => (g2, { xm, y0, y1 }) => {
  const b = g2.addBeam(WOOD, section, xm, true, y0, y1, { role, beamType: role === 'roofBeam' ? '小屋梁' : '大梁' });
  if (status !== 'auto') b.setDimensionStatus(status);
  return [b];
};

test('【C2a統合】構造再計算を通しても、auto の小屋梁は撤去されず・断面を書き換えられず・柱を生まず・他の梁を分割せず、変化0件に収束する', async () => {
  const base = buildTwoFloors(null);
  const withRoof = buildTwoFloors(putRoofBeam('roofBeam'));
  const [roofBeam] = withRoof.placed;
  assert.equal(roofBeam.dimensionStatus, 'auto', '前提: 生成物と同じ auto');

  await withPeek(base.project, [base.g1, base.g2], () => sweep(base.project, base.g1, base.g2));
  const changes = await withPeek(withRoof.project, [withRoof.g1, withRoof.g2], () => sweep(withRoof.project, withRoof.g1, withRoof.g2));

  // 誰にも触られない
  assert.equal(withRoof.g2.beamMap.get(roofBeam.id), roofBeam, '撤去も作り直しもされない（同一インスタンスのまま）');
  assert.equal(roofBeam.sectionDefId, 'WOOD-120x210', '断面は書き換えられない（梁成表の対象外・幅は柱寸と同値）');
  assert.equal(roofBeam.woodAutoDepthMm, null, '梁成表の表示用の値も書かれない');
  assert.equal(roofBeam.woodDepthFollowsManual, null);
  assert.deepEqual([roofBeam.clStart.id, roofBeam.clEnd.id], [withRoof.g2.centerLines.find(c => c.value === 0 && c.centerLineType === CenterLineType.HORIZONTAL).id, withRoof.g2.centerLines.find(c => c.value === 1820 && c.centerLineType === CenterLineType.HORIZONTAL).id], '端のCLも不変（他の梁を分割する再割付けもない）');

  // 他の部材は小屋梁の有無で一致する（柱を生まない・他の梁を分割しない・他の梁の成に影響しない）
  assert.deepEqual(columnLines(withRoof.g1), columnLines(base.g1), '1階の柱は小屋梁の有無で同じ');
  assert.deepEqual(columnLines(withRoof.g2), columnLines(base.g2), '2階の柱も同じ');
  assert.deepEqual(beamLines(withRoof.g1), beamLines(base.g1), '1階の梁は同じ');
  assert.deepEqual(beamLines(withRoof.g2), beamLines(base.g2), '2階の他の梁（分割・成）は同じ');
  assert.equal(withRoof.g2.beams.filter(b => b.role === 'roofBeam').length, 1, '小屋梁は増えも減りもしない');

  // 収束: 3周目は両階とも changed=false
  assert.deepEqual(changes[2], [false, false], `3周目で変化0件に収束: ${JSON.stringify(changes)}`);
});

test('【C2a統合・検出力】対照: 同じ位置・同じ端の梁を locked の大梁(primary)にすると1階の柱が増える＝小屋梁の「柱を生まない」は役割の違いによる', async () => {
  const base = buildTwoFloors(null);
  const primary = buildTwoFloors(putRoofBeam('primary', 'locked'));
  const roofLocked = buildTwoFloors(putRoofBeam('roofBeam', 'locked'));
  for (const d of [base, primary, roofLocked]) await withPeek(d.project, [d.g1, d.g2], () => sweep(d.project, d.g1, d.g2));
  assert.notDeepEqual(columnLines(primary.g1), columnLines(base.g1), '対照(primary)では1階の柱が増える（この配置が3h-2の点源になる前提の成立）');
  assert.deepEqual(columnLines(roofLocked.g1), columnLines(base.g1), 'locked の小屋梁でも柱は増えない');
  assert.equal(roofLocked.g2.beams.filter(b => b.role === 'roofBeam').length, 1, 'locked の小屋梁は保持される');
});

test('【C2a統合】auto の小屋梁は、主構造を木造から変えても材種変換されず断面も不変（撤去は生成ステップC2bの責務）', async () => {
  const d = buildTwoFloors(putRoofBeam('roofBeam'));
  const [roofBeam] = d.placed;
  d.g2.structureOverride = 'S造';
  await withPeek(d.project, [d.g1, d.g2], async () => { await recomputeStructuralForGraph(d.g2, d.project, 'S造'); });
  const after = d.g2.beamMap.get(roofBeam.id);
  assert.ok(after, 'S造へ切替えても小屋梁は消えない（C2a時点。表Aの対象外）');
  assert.equal(after.materialType, WOOD);
  assert.equal(after.sectionDefId, 'WOOD-120x210');
});

test('【C2a】conformWoodSections: 小屋梁は「既定で入る」集合——幅は梁を支える柱寸（120）へそろい、成は保たれる。基礎梁・土台と違い除外されない', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, STRUCT);
  const wide = graph.addBeam(WOOD, 'WOOD-105x210', x0, true, y0, y1, { role: 'roofBeam', beamType: '小屋梁' });
  const same = graph.addBeam(WOOD, 'WOOD-120x210', x0, true, y0, y1, { role: 'roofBeam', beamType: '小屋梁' });
  const updated = conformWoodSections(graph, PROJECT);
  assert.deepEqual(updated, [wide.id], '幅が柱寸と違う小屋梁だけが更新される');
  assert.equal(wide.sectionDefId, 'WOOD-120x210', '幅は柱寸へ・成は保つ');
  assert.equal(same.sectionDefId, 'WOOD-120x210');
});

test('【C2a】autoFillWoodBeamDepths（梁成表）: 小屋梁は対象外——支持点間が長くても断面を変えず、大梁(primary)は表で成が上がる（対照）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 7280, STRUCT);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, STRUCT);
  const roofBeam = graph.addBeam(WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'roofBeam', beamType: '小屋梁' });
  const primary = graph.addBeam(WOOD, 'WOOD-120x120', y1, false, x0, x1, { role: 'primary' });
  autoFillWoodBeamDepths(graph, PROJECT, []);
  assert.equal(roofBeam.sectionDefId, 'WOOD-120x120', '小屋梁（スパン7280）は表で書き換えられない');
  assert.equal(roofBeam.woodAutoDepthMm, null);
  assert.notEqual(primary.sectionDefId, 'WOOD-120x120', '対照: 同スパンの大梁は表で成が上がる（検出力）');
});

test('【C2a】WOOD_DEPTH_BEAM_ROLES / showsWoodBeamDepthFields: 小屋梁は梁成表の対象でなく、カードに「梁成」「自動梁の対象」欄を出さない', () => {
  assert.deepEqual([...WOOD_DEPTH_BEAM_ROLES], ['primary', 'secondary', 'floor']);
  const mk = role => ({ materialType: WOOD, role });
  assert.equal(showsWoodBeamDepthFields('beamMap', mk('roofBeam'), rules), false);
  assert.equal(showsWoodBeamDepthFields('beamMap', mk('primary'), rules), true, '対照');
});

test('【C2a】columnSeedBeamSegments（柱の点源）・mergePrimaryBeamRuns・findHostBeam: 小屋梁は入らない／hostになれない', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, STRUCT);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, STRUCT);
  graph.addBeam(WOOD, 'WOOD-120x210', y0, false, x0, x1, { role: 'roofBeam', beamType: '小屋梁' });
  assert.deepEqual(columnSeedBeamSegments(graph, rules), [], '小屋梁だけの階は点源が空（柱の起点にしない）');
  graph.addBeam(WOOD, 'WOOD-120x120', y1, false, x0, x1, { role: 'primary' });
  const segs = columnSeedBeamSegments(graph, rules);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].role, 'primary');
  assert.deepEqual(mergePrimaryBeamRuns(segs).map(s => s.coord), [1820], '併合の入力は点源経由で小屋梁を含まない');
  // host: 端のCL(x0)で、y0軸の小屋梁は host にならない。y1軸の大梁は host になる
  const beams = graph.beams;
  assert.equal(findHostBeam(beams, x0.id, true, 0), null, 'x0軸上にhostになる梁は無い');
  assert.equal(findHostBeam(beams, y0.id, false, 1000), null, '小屋梁(y0軸)はhostにならない（primaryのみ）');
  assert.equal(findHostPrimaryBeam(beams, y0.id, false, 1000), null);
  assert.equal(findHostBeam(beams, y1.id, false, 1000)?.role, 'primary', '対照: 大梁はhostになる');
  assert.equal(findHostBeam(beams, y0.id, false, 1000, { allowSecondaryHost: true }), null, '小梁を許す指定でも小屋梁は対象外');
});

test('【C2a】resolveBeamJunctionSpans（交点処理・通しが勝つ）: 小屋梁は参加しない（結果は小屋梁の有無で変わらない）', () => {
  const drawing = rules.drawing;
  const beam = (id, role, isVertical, axisValue, e1, e2) => ({
    id, role, isVertical, axisValue, end1: e1, end2: e2, base1: e1, base2: e2, halfWidth: 60, sectionKey: 'WOOD-120x120',
  });
  // 大梁2本のL字の出隅（交点処理が働く配置）
  const primaries = [beam('h', 'primary', false, 0, 0, 3640), beam('v', 'primary', true, 0, 0, 3640)];
  const roof = beam('k', 'roofBeam', true, 1820, 0, 3640); // 水平の大梁の途中を通る小屋梁
  const without = resolveBeamJunctionSpans(drawing, primaries);
  const withRoof = resolveBeamJunctionSpans(drawing, [...primaries, roof]);
  assert.deepEqual([...withRoof.entries()], [...without.entries()], '小屋梁を足しても大梁の交点処理は変わらない');
  assert.equal(withRoof.has('k'), false, '小屋梁自身も勝ち負けの対象に入らない（トリムされない）');
  assert.equal(resolveBeamJunctionSpans(drawing, [roof]).size, 0, '小屋梁だけなら何もしない');
});

test('【C2a】autoFillBeamEccentricity: 小屋梁の偏芯は書き換えられない（ホワイトリスト: primary/secondary/eaves）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, STRUCT);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, STRUCT);
  const roofBeam = graph.addBeam(WOOD, 'WOOD-120x210', y0, false, x0, x1, { role: 'roofBeam', beamType: '小屋梁', eccentricity: 77 });
  const primary = graph.addBeam(WOOD, 'WOOD-120x120', y1, false, x0, x1, { role: 'primary', eccentricity: 77 });
  const updated = autoFillBeamEccentricity(graph, PROJECT);
  assert.equal(roofBeam.eccentricity, 77, '小屋梁の偏芯は不変');
  assert.ok(updated.includes(primary.id) && primary.eccentricity !== 77, '対照: 大梁の偏芯は再算出される（検出力）');
  assert.equal(updated.includes(roofBeam.id), false);
});

test('【C2a】autoFillWoodFloorBeams: 小屋梁は床梁のセルを閉じる辺にならない（primary のみ）。同じ4辺が大梁なら床梁が生成される（対照）', () => {
  const build = role => {
    const graph = makeGraph();
    const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
    const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, STRUCT);
    const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
    const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 5460, STRUCT);
    const props = role === 'roofBeam' ? { role, beamType: '小屋梁' } : { role };
    for (const [axis, isV, a, b] of [[y0, false, x0, x1], [y1, false, x0, x1], [x0, true, y0, y1], [x1, true, y0, y1]]) {
      graph.addBeam(WOOD, 'WOOD-120x120', axis, isV, a, b, props).setDimensionStatus('locked');
    }
    return graph;
  };
  assert.ok(autoFillWoodFloorBeams(build('primary'), PROJECT).created.length > 0, '対照: 大梁の4辺なら床梁ができる');
  const g = build('roofBeam');
  const res = autoFillWoodFloorBeams(g, PROJECT);
  assert.deepEqual([res.created.length, res.removed.length], [0, 0], '小屋梁の4辺では床梁は生成されない');
  assert.equal(g.beams.filter(b => b.role === 'floor').length, 0);
});

test('【C2a・既知】autoFillWoodWallBeams の「占有物」判定は role を見ない——壁線の通し梁候補と同じ spanKey（同軸・同端）にある auto の小屋梁は大梁に置き換わる（表に無い巻き込み。C2b の生成は同軸のprimaryと重ねない前提）', async () => {
  // 2階の壁線 y=0（1階の壁由来）の通し梁候補は (y0軸・x0→x1)。同じ spanKey に auto の小屋梁を置く
  const d = buildTwoFloors((g2, { x0, x1, y0 }) => [g2.addBeam(WOOD, 'WOOD-120x210', y0, false, x0, x1, { role: 'roofBeam', beamType: '小屋梁' })]);
  const [roofBeam] = d.placed;
  await withPeek(d.project, [d.g1, d.g2], async () => { await recomputeStructuralForGraph(d.g2, d.project, TRADITIONAL_WOOD_STRUCTURE); });
  assert.equal(d.g2.beamMap.has(roofBeam.id), false, '占有物として撤去される（現状の挙動）');
  assert.ok(d.g2.beams.some(b => b.role === 'primary' && Math.abs(b.axisValue) < 1 && !b.isVertical), '代わりに壁線の大梁が立つ');
  // 対照: locked の小屋梁は占有物として残り、その区間の大梁は生成されない（手動固定が勝つ）
  const locked = buildTwoFloors((g2, { x0, x1, y0 }) => {
    const b = g2.addBeam(WOOD, 'WOOD-120x210', y0, false, x0, x1, { role: 'roofBeam', beamType: '小屋梁' });
    b.setDimensionStatus('locked');
    return [b];
  });
  await withPeek(locked.project, [locked.g1, locked.g2], async () => { await recomputeStructuralForGraph(locked.g2, locked.project, TRADITIONAL_WOOD_STRUCTURE); });
  assert.equal(locked.g2.beamMap.has(locked.placed[0].id), true, 'locked の小屋梁は残る');
  assert.equal(locked.g2.beams.some(b => b.role === 'primary' && Math.abs(b.axisValue) < 1 && !b.isVertical), false, '同じ区間の壁線の大梁は生成されない');
});

test('【C2a】fixedMembersReferencing（CL削除・降格の確認。構造同期の手動固定の列挙）: locked の小屋梁は固定材として数える。auto は数えない（汎用のまま＝既定で入る）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const axis = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: false, discipline: Discipline.FUSE });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, STRUCT);
  const autoB = graph.addBeam(WOOD, 'WOOD-120x210', axis, true, y0, y1, { role: 'roofBeam', beamType: '小屋梁' });
  assert.deepEqual(fixedMembersReferencing(graph, axis.id).beams.map(b => b.id), [], 'auto は数えない');
  autoB.setDimensionStatus('locked');
  assert.deepEqual(fixedMembersReferencing(graph, axis.id).beams.map(b => b.id), [autoB.id], 'locked は数える');
  assert.ok(x0);
});
