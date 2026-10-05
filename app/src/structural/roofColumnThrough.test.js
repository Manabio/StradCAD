// 下屋の「柱貫通」（変更B）のテスト。設計意図: .claude/roof-model.md「柱貫通」・.claude/structural-model.md「柱の生成」。
// 通り芯の交点に柱が立つ構造（S造・RC造・SRC造）で、その階の屋根セルにしか接しない交点の柱を、下屋ごとの
// columnThrough（既定 false）で作らない（持ち越された auto の柱は撤去）／立てる、を切り替える。
// 構成: (1) roofColumnFilter の分類 (2) wallGate.intersectionInBuildingWithRoof と autoFillColumns
// (3) recomputeStructuralForGraph の統合（オフ→撤去・オン→生成・オフ→撤去・冪等） (4) 表示判断（view 関数） (5) 配線（1行まるごと一致）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, RoomKind, RoomFeature } from '../core.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { buildRoofColumnFilter, ROOF_COLUMN_CLASS } from './roofColumnFilter.js';
import { buildSelfFootprintGate, buildStructuralWallGate } from './wallGate.js';
import { autoFillColumns, autoFillColumnsForStructure } from './structuralAutoFill.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { roofColumnThroughView } from '../finish/roof/roofGeometry.js';
import { roofColumnThroughViewOfRoom } from '../finish/roof/roofOrientation.js';
import { isValidRoofFieldValue } from '../finish/roof/roofInput.js';

const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const SPACING = 4000;
const PROJECT_S = { planes: [], structuralInfo: { mainStructure: 'S造', foundationType: 'ベタ基礎' } };
const NONE = ROOF_COLUMN_CLASS.NONE;
const BLOCKED = ROOF_COLUMN_CLASS.BLOCKED;
const THROUGH = ROOF_COLUMN_CLASS.THROUGH;

/**
 * 4×4 本の通り芯（0..12000。間隔 4000）の 3×3 セルへ部屋を置く。roofGroups の各要素 { cells:[[i,j],…], through } は屋根の部屋
 * （i＝列・j＝行。x=i*4000..、y=j*4000..）。interiorCells 省略時は屋根以外の全セルが屋内（1部屋）。
 * 戻り値の roofRooms は roofGroups と同じ順。
 */
function layoutOn(graph, { roofGroups = [], interiorCells = null } = {}) {
  const xs = [0, 1, 2, 3].map(i => graph.addCenterLine(CenterLineType.VERTICAL, i * SPACING, STRUCT));
  const ys = [0, 1, 2, 3].map(j => graph.addCenterLine(CenterLineType.HORIZONTAL, j * SPACING, STRUCT));
  const key = ([i, j]) => `${xs[i].id}:${ys[j].id}:${xs[i + 1].id}:${ys[j + 1].id}`;
  const roofSet = new Set(roofGroups.flatMap(g => g.cells.map(c => c.join(','))));
  const all = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) all.push([i, j]);
  const interior = interiorCells ?? all.filter(([i, j]) => !roofSet.has(`${i},${j}`));
  const interiorRoom = interior.length > 0 ? graph.addRoom(new Set(interior.map(key)), '居間') : null;
  const roofRooms = roofGroups.map(g => {
    const room = graph.addRoom(new Set(g.cells.map(key)), '屋根');
    room.setKind(RoomKind.EXTERIOR);
    room.setFeature(RoomFeature.ROOF);
    room.setRoofSpec(createLeanToRoofSpec());
    if (g.through) room.roofSpec.setField('columnThrough', true);
    return room;
  });
  return { xs, ys, roofRooms, interiorRoom };
}

function makeGraph(layout, { structure = 'S造', planeId = 'p1', elevation = 0, name = '1階' } = {}) {
  const graph = new PlanGraph(new Plane(planeId, elevation, name, 1, 1));
  graph.structureOverride = structure;
  const placed = layoutOn(graph, layout);
  return { graph, ...placed };
}

// 屋根の 2×2 ブロック（x 0..8000 × y 0..8000）。屋内は右列と下段。屋根セルにしか接しない交点は (0,0)・(4000,0)・(0,4000)・(4000,4000) の4つ
// （(0,0)＝屋根の外側の角、(4000,0)・(0,4000)＝屋根の辺の途中、(4000,4000)＝屋根の内部＝屋根セル同士の境）。
const BLOCK = (through = false) => ({ roofGroups: [{ cells: [[0, 0], [1, 0], [0, 1], [1, 1]], through }] });
const ROOF_ONLY_POINTS = [[0, 0], [4000, 0], [0, 4000], [4000, 4000]];

const colAt = (graph, x, y) => graph.columns.find(c => c.verticalCL.value === x && c.horizontalCL.value === y);
const posOf = graph => new Set(graph.columns.map(c => `${c.verticalCL.value},${c.horizontalCL.value}`));

// ================================================================
// (1) roofColumnFilter の分類
// ================================================================

test('【フィルタ】オフ: 屋根セルにしか接しない交点（外側の角・辺の途中・内部）は roofOnlyBlocked、屋内に触れる点・遠い点は none', () => {
  const { graph, roofRooms } = makeGraph(BLOCK(false));
  assert.equal(roofRooms.length, 1, '前提: 屋根の部屋がある');
  assert.equal(roofRooms[0].roofSpec.columnThrough, false, '前提: オフ');
  const f = buildRoofColumnFilter(graph);
  assert.equal(f.empty, false, '前提: 屋根セルも屋内もある');
  for (const [x, y] of ROOF_ONLY_POINTS) assert.equal(f.classify(x, y), BLOCKED, `(${x},${y})`);
  assert.equal(f.classify(8000, 4000), NONE, '屋根の右の辺の途中: 右の屋内セルに触れる（建物の壁の線上）');
  assert.equal(f.classify(0, 8000), NONE, '屋根の下の辺の端: 下の屋内セルに触れる');
  assert.equal(f.classify(4000, 8000), NONE, '屋根の下の辺の途中: 屋内セルに触れる');
  assert.equal(f.classify(8000, 8000), NONE, '屋根の角で屋内に3方向から触れる');
  assert.equal(f.classify(12000, 12000), NONE, '屋内の外側の角');
  assert.equal(f.classify(12000, 0), NONE, '屋内の角（屋根に触れない）');
  assert.equal(f.classify(-50000, -50000), NONE, 'どのセルにも触れない点');
});

test('【フィルタ】オン: 屋根セルにしか接しない交点は roofOnlyThrough。屋内に触れる点は none のまま', () => {
  const { graph } = makeGraph(BLOCK(true));
  const f = buildRoofColumnFilter(graph);
  for (const [x, y] of ROOF_ONLY_POINTS) assert.equal(f.classify(x, y), THROUGH, `(${x},${y})`);
  for (const [x, y] of [[8000, 4000], [0, 8000], [4000, 8000], [8000, 8000], [12000, 12000]]) assert.equal(f.classify(x, y), NONE, `(${x},${y})`);
});

test('【フィルタ】複数の屋根（片方だけオン）: それぞれの屋根の角が自分の設定に従う。2つの屋根に触れる点は1つでもオンなら through', () => {
  // 左上と右上の角に別々の屋根セル。間（4000..8000 × 0..4000）は屋内なので、(4000,0)・(8000,0) は屋内に触れて none
  const { graph, roofRooms } = makeGraph({ roofGroups: [{ cells: [[0, 0]], through: true }, { cells: [[2, 0]], through: false }] });
  assert.equal(roofRooms.length, 2);
  const f = buildRoofColumnFilter(graph);
  assert.equal(f.classify(0, 0), THROUGH, '左の屋根（オン）の外側の角');
  assert.equal(f.classify(12000, 0), BLOCKED, '右の屋根（オフ）の外側の角');
  assert.equal(f.classify(4000, 0), NONE, '左の屋根と屋内の境（屋内に触れる）');
  // 隣り合う2つの屋根（左オン・右オフ）の境の点 (4000,0) は、触れる屋根のどれかがオンなら through
  const adj = makeGraph({ roofGroups: [{ cells: [[0, 0]], through: true }, { cells: [[1, 0]], through: false }] });
  const fa = buildRoofColumnFilter(adj.graph);
  assert.equal(fa.classify(4000, 0), THROUGH, '触れる屋根の一方がオン');
  assert.equal(fa.classify(8000, 0), NONE, '右の屋内セルに触れる点は屋根の設定に関わらず none');
  const adj2 = makeGraph({ roofGroups: [{ cells: [[0, 0]], through: false }, { cells: [[1, 0]], through: false }] });
  assert.equal(buildRoofColumnFilter(adj2.graph).classify(4000, 0), BLOCKED, 'どちらもオフ');
});

test('【フィルタ】許容差: 閉区間（±tol）で触れる。既定 0.5mm の内側は触れる・外側は触れない。tolMm で広げられる', () => {
  const { graph } = makeGraph(BLOCK(false));
  const f = buildRoofColumnFilter(graph);
  assert.equal(f.classify(-0.4, 0), BLOCKED, '0.4mm 外側は触れる');
  assert.equal(f.classify(-0.5, 0), BLOCKED, '境界ちょうど（閉区間）');
  assert.equal(f.classify(-0.6, 0), NONE, '0.6mm 外側は触れない');
  assert.equal(buildRoofColumnFilter(graph, { tolMm: 2 }).classify(-1.5, 0), BLOCKED, 'tolMm=2 なら 1.5mm 外側も触れる');
  // 屋内側の許容差: (8000,4000) より 0.4mm 屋根の内側へ寄った点は屋内セル（x≥8000）に触れる
  assert.equal(f.classify(7999.6, 4000), NONE);
  assert.equal(f.classify(7999.4, 4000), BLOCKED, '屋内セルの縁から 0.6mm 離れると屋内に触れない');
});

test('【フィルタ】屋根の無い graph・屋内の無い graph は常に none（empty）。屋根の部屋が roofSpec を持たなければ数えない', () => {
  const noRoof = makeGraph({ roofGroups: [] });
  const f0 = buildRoofColumnFilter(noRoof.graph);
  assert.equal(f0.empty, true);
  for (const [x, y] of [[0, 0], [4000, 4000], [12000, 12000]]) assert.equal(f0.classify(x, y), NONE);
  // 屋内の無い階（建物範囲が未定義＝wallGate が null の階）は従来どおり何も絞らない
  const onlyRoof = makeGraph({ roofGroups: [{ cells: [[0, 0], [1, 0], [0, 1], [1, 1]], through: false }], interiorCells: [] });
  assert.equal(onlyRoof.graph.rooms.length, 1, '前提: 屋根の部屋だけがある');
  const f1 = buildRoofColumnFilter(onlyRoof.graph);
  assert.equal(f1.empty, true);
  assert.equal(f1.classify(0, 0), NONE);
  assert.equal(buildRoofColumnFilter(null).empty, true, 'graph が無くても落ちない');
  assert.equal(buildRoofColumnFilter(undefined).classify(0, 0), NONE);
});

test('【フィルタ】throughCellAt: オンの屋根セルの中（境界を含む）だけ true。オフの屋根・屋内・屋外は false', () => {
  const { graph } = makeGraph({ roofGroups: [{ cells: [[0, 0]], through: true }, { cells: [[2, 0]], through: false }] });
  const f = buildRoofColumnFilter(graph);
  assert.equal(f.throughCellAt(2000, 2000), true, 'オンの屋根セルの中');
  assert.equal(f.throughCellAt(0, 0), true, '境界を含む');
  assert.equal(f.throughCellAt(10000, 2000), false, 'オフの屋根セルの中');
  assert.equal(f.throughCellAt(6000, 2000), false, '屋内');
  assert.equal(f.throughCellAt(-100, -100), false, '建物の外');
});

// ================================================================
// (2) wallGate.intersectionInBuildingWithRoof と autoFillColumns
// ================================================================

test('【ゲート】intersectionInBuildingWithRoof: 自階の屋根セルを建物とみなす。屋内に触れない屋根の角も true。屋根セルでない屋外の角は false', () => {
  const { graph, xs, ys } = makeGraph(BLOCK(true));
  const gate = buildSelfFootprintGate(graph);
  const filter = buildRoofColumnFilter(graph);
  assert.equal(gate.intersectionInBuilding(xs[0], ys[0]), false, '前提: 従来の判定では屋根の外側の角は建物外');
  assert.equal(gate.intersectionInBuildingWithRoof(xs[0], ys[0], filter.throughCellAt), true, '屋根を建物とみなすと建物内');
  assert.equal(gate.intersectionInBuildingWithRoof(xs[1], ys[1], filter.throughCellAt), true, '屋根の内部');
  // 屋根セルが無い側（建物の外）の角は、屋根を建物とみなしても false
  const out = makeGraph({ roofGroups: [{ cells: [[0, 0]], through: true }], interiorCells: [[2, 2]] });
  const og = buildSelfFootprintGate(out.graph);
  const of = buildRoofColumnFilter(out.graph);
  assert.equal(og.intersectionInBuildingWithRoof(out.xs[0], out.ys[3], of.throughCellAt), false, 'セルの無い角');
  assert.equal(og.intersectionInBuildingWithRoof(out.xs[0], out.ys[0], () => false), og.intersectionInBuilding(out.xs[0], out.ys[0]), '屋根を何も建物とみなさなければ従来と同じ');
});

test('【柱】フィルタ省略・null・empty は今までと完全に同じ（屋根セルにしか接しない交点はゲートが落とす）', () => {
  const run = (filter) => {
    const { graph } = makeGraph(BLOCK(false));
    const gate = buildSelfFootprintGate(graph);
    const res = filter === undefined ? autoFillColumns(graph, PROJECT_S, gate) : autoFillColumns(graph, PROJECT_S, gate, filter);
    return { pos: [...posOf(graph)].sort(), created: res.created.length, removed: res.removed.length };
  };
  const base = run(undefined);
  assert.equal(base.created, 12, '前提: 16 交点のうち屋根にしか接しない4つはゲートで落ちる');
  assert.deepEqual(run(null), base);
  assert.deepEqual(run(buildRoofColumnFilter(makeGraph({ roofGroups: [] }).graph)), base, 'empty のフィルタ');
});

test('【柱】オフ: 屋根セルにしか接しない交点を作らず、持ち越された auto の柱だけ撤去する。locked・杭・屋内の柱は残り、除外スロットに触れない', () => {
  const { graph } = makeGraph(BLOCK(false));
  autoFillColumns(graph, PROJECT_S, null); // 屋根にする前＝全交点に柱が立っていた状態
  assert.equal(graph.columns.length, 16, '前提: 全交点に柱');
  const col00 = colAt(graph, 0, 0);
  graph.removeColumn(col00.id); // 手動削除＝除外スロット
  const excludedBefore = [...graph.excludedColumnSlots];
  assert.equal(excludedBefore.length, 1, '前提: 除外スロットが1つ');
  const locked = colAt(graph, 4000, 4000);
  runInAction(() => { locked.dimensionStatus = 'locked'; });
  const pile = colAt(graph, 0, 4000);
  runInAction(() => { pile.role = 'foundation'; });
  const victim = colAt(graph, 4000, 0);
  const keepInterior = colAt(graph, 8000, 4000);

  const gate = buildSelfFootprintGate(graph);
  const res = autoFillColumns(graph, PROJECT_S, gate, buildRoofColumnFilter(graph));
  assert.deepEqual(res.removed, [victim.id], '撤去されたのは auto の (4000,0) の柱だけ');
  assert.equal(res.created.length, 0);
  assert.equal(graph.columnMap.has(locked.id), true, 'locked は残る');
  assert.equal(graph.columnMap.has(pile.id), true, '杭は残る');
  assert.equal(graph.columnMap.has(keepInterior.id), true, '屋内に触れる交点の柱は残る');
  assert.equal(graph.columns.length, 16 - 1 - 1, '手動削除1＋撤去1');
  assert.deepEqual([...graph.excludedColumnSlots], excludedBefore, '除外スロットは変わらない（撤去は除外に記録しない）');
  // 冪等
  const again = autoFillColumns(graph, PROJECT_S, gate, buildRoofColumnFilter(graph));
  assert.equal(again.created.length + again.removed.length, 0);
});

test('【柱】オン: 屋根セルにしか接しない交点にも立つ。除外スロットの交点は作らない。オフへ戻すと再び撤去され、もう一度オンで立つ（冪等）', () => {
  const { graph, roofRooms } = makeGraph(BLOCK(true));
  const gate = buildSelfFootprintGate(graph);
  const on1 = autoFillColumns(graph, PROJECT_S, gate, buildRoofColumnFilter(graph));
  assert.equal(on1.created.length, 16, '屋根セルにしか接しない4つも含めて全交点');
  for (const [x, y] of ROOF_ONLY_POINTS) assert.ok(colAt(graph, x, y), `(${x},${y}) に柱`);
  graph.removeColumn(colAt(graph, 4000, 0).id); // 除外スロット
  const excluded = [...graph.excludedColumnSlots];

  runInAction(() => roofRooms[0].roofSpec.setField('columnThrough', false));
  const off = autoFillColumns(graph, PROJECT_S, gate, buildRoofColumnFilter(graph));
  assert.equal(off.removed.length, 3, 'オフで残りの3つ（(0,0)・(0,4000)・(4000,4000)）を撤去');
  for (const [x, y] of ROOF_ONLY_POINTS) assert.equal(colAt(graph, x, y) === undefined, true, `(${x},${y}) の柱は無い`);

  runInAction(() => roofRooms[0].roofSpec.setField('columnThrough', true));
  const on2 = autoFillColumns(graph, PROJECT_S, gate, buildRoofColumnFilter(graph));
  assert.equal(on2.created.length, 3, '除外スロット (4000,0) 以外の3つが立つ');
  assert.equal(colAt(graph, 4000, 0) === undefined, true, '除外スロットの交点は作らない');
  assert.deepEqual([...graph.excludedColumnSlots], excluded, '除外スロットは変わらない');
  const on3 = autoFillColumns(graph, PROJECT_S, gate, buildRoofColumnFilter(graph));
  assert.equal(on3.created.length + on3.removed.length, 0, '冪等');
});

test('【柱】オンでも直下の階に建物が無い交点には立たない（鉛直連続性は今までどおり）', async () => {
  const top = makeGraph(BLOCK(true), { planeId: 'p2', elevation: 3000, name: '2階' });
  // 1階は (0,0) のセルだけ屋内が無い（その他は全セル屋内）
  const below = makeGraph({ roofGroups: [], interiorCells: [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] }, { planeId: 'p1', elevation: 0, name: '1階' });
  const project = { planes: [below.graph.plane, top.graph.plane], structuralInfo: PROJECT_S.structuralInfo };
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === below.graph.plane.id ? below.graph : null);
  try {
    const gate = await buildStructuralWallGate(top.graph.plane, project, top.graph);
    const res = autoFillColumns(top.graph, project, gate, buildRoofColumnFilter(top.graph));
    assert.equal(colAt(top.graph, 0, 0) === undefined, true, '(0,0): 直下の1階に屋内が無い→立たない');
    assert.ok(colAt(top.graph, 4000, 0), '(4000,0): 直下の1階に屋内がある→オンなら立つ');
    assert.ok(colAt(top.graph, 4000, 4000), '(4000,4000): 同上');
    assert.equal(res.created.length, 15, '16 交点のうち (0,0) だけ立たない');
  } finally {
    floorSwapManager.peek = original;
  }
});

test('【柱】autoFillColumnsForStructure: 通り芯交点方式（S造）へフィルタが渡る。省略時は従来と同じ（在来木造が対象外なのは統合テストで確認）', () => {
  const s = makeGraph(BLOCK(false));
  autoFillColumns(s.graph, PROJECT_S, null);
  const gate = buildSelfFootprintGate(s.graph);
  const res = autoFillColumnsForStructure(s.graph, PROJECT_S, gate, [], [], [], [], undefined, buildRoofColumnFilter(s.graph));
  assert.equal(res.removed.length, 4, 'S造: 屋根のみの4交点の auto の柱を撤去');
  const omitted = makeGraph(BLOCK(false));
  autoFillColumns(omitted.graph, PROJECT_S, null);
  const res2 = autoFillColumnsForStructure(omitted.graph, PROJECT_S, buildSelfFootprintGate(omitted.graph));
  assert.equal(res2.removed.length, 0, '省略時は撤去しない（今までと同じ）');
});

test('【失敗系】autoFillColumns: 主構造が未確定（未定）の間は、フィルタがあっても何も作らず何も撤去しない', () => {
  const { graph } = makeGraph(BLOCK(false), { structure: '未定' });
  const project = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  const res = autoFillColumns(graph, project, buildSelfFootprintGate(graph), buildRoofColumnFilter(graph));
  assert.deepEqual([res.created.length, res.removed.length, graph.columns.length], [0, 0, 0]);
});

// ================================================================
// (3) 統合: recomputeStructuralForGraph（本番の再計算）でオフ→撤去・オン→生成・オフ→撤去
// ================================================================

// 2階建て。2階は屋根の 2×2 ブロック（BLOCK）＋屋内。1階は全セル屋内。屋根にする前＝全交点に柱がある状態を先に作る。
function buildTwoFloorSteel(through) {
  const project = new Project('proj-through', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  project.structuralInfo.mainStructure = 'S造';
  g1.structureOverride = 'S造';
  g2.structureOverride = 'S造';
  layoutOn(g1, { roofGroups: [] });
  const placed = layoutOn(g2, BLOCK(through));
  autoFillColumns(g1, project, null);
  autoFillColumns(g2, project, null); // 屋根にする前に立った柱の持ち越し
  return { project, g1, g2, roof: placed.roofRooms[0] };
}

async function withPeek(graphs, fn) {
  const peekMap = Object.fromEntries(graphs.map(g => [g.plane.id, g]));
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try { return await fn(); } finally { floorSwapManager.peek = original; }
}

// 本番の反映パスと同じ降順（2階→1階）を、changed が無くなるまで回す。収束したスイープ数を返す。
async function converge({ project, g1, g2 }) {
  return withPeek([g1, g2], async () => {
    for (let i = 1; i <= 8; i++) {
      const a = await recomputeStructuralForGraph(g2, project, 'S造');
      const b = await recomputeStructuralForGraph(g1, project, 'S造');
      if (!a.changed && !b.changed) return i;
    }
    return null;
  });
}

test('【統合】S造: オフ→持ち越しの柱を撤去（16→12）、オン→立つ（16）、オフ→撤去（12）。1階は不変。各段で収束し、収束後は changed=false', async () => {
  const doc = buildTwoFloorSteel(false);
  assert.equal(doc.g2.columns.length, 16, '前提: 屋根にする前に全交点へ柱がある');
  assert.equal(doc.roof.roofSpec.columnThrough, false, '前提: オフ');
  const n1 = await converge(doc);
  assert.ok(n1 !== null && n1 <= 4, `収束: ${n1}`);
  assert.equal(doc.g2.columns.length, 12, 'オフ: 屋根にしか接しない4交点の柱が撤去される');
  for (const [x, y] of ROOF_ONLY_POINTS) assert.equal(colAt(doc.g2, x, y) === undefined, true, `(${x},${y})`);
  assert.equal(doc.g1.columns.length, 16, '1階の柱は不変');

  runInAction(() => doc.roof.roofSpec.setField('columnThrough', true));
  await converge(doc);
  assert.equal(doc.g2.columns.length, 16, 'オン: 撤去した後でも立つ');
  for (const [x, y] of ROOF_ONLY_POINTS) assert.ok(colAt(doc.g2, x, y), `(${x},${y})`);
  assert.equal(doc.g1.columns.length, 16);

  runInAction(() => doc.roof.roofSpec.setField('columnThrough', false));
  await converge(doc);
  assert.equal(doc.g2.columns.length, 12, '再びオフ: 撤去');
  const again = await withPeek([doc.g1, doc.g2], () => recomputeStructuralForGraph(doc.g2, doc.project, 'S造'));
  assert.equal(again.changed, false, '冪等');
});

test('【統合・失敗系】在来木造の階は柱貫通の設定に関わらず柱が変わらない（対象外）', async () => {
  const project = new Project('proj-wood', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const lower = layoutOn(g1, { roofGroups: [] });
  const { roofRooms, interiorRoom } = layoutOn(g2, BLOCK(false));
  generateRoomWallsFromOutline(g1, lower.interiorRoom); // 在来木造の柱は壁の交点に立つ。壁が無いと柱が0本で空振りになる
  generateRoomWallsFromOutline(g2, interiorRoom);
  const run = async () => withPeek([g1, g2], async () => {
    for (let i = 0; i < 8; i++) {
      const a = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
      const b = await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
      if (!a.changed && !b.changed) break;
    }
    return [...posOf(g2)].sort();
  });
  const off = await run();
  assert.ok(off.length > 0, '前提: 在来木造でも柱が立つ');
  runInAction(() => roofRooms[0].roofSpec.setField('columnThrough', true));
  assert.deepEqual(await run(), off, '在来木造は柱貫通の対象外');
});

// ================================================================
// (4) 表示判断（view 関数）と入力検証
// ================================================================

test('roofColumnThroughView: 下屋で、通り芯の交点に柱が立つ構造のときだけ visible。在来木造・主屋根は出さない。値は真偽値で返す', () => {
  assert.deepEqual(roofColumnThroughView({ isLeanTo: true, columnPlacement: 'gridIntersections', hasColumns: true, columnThrough: true }), { visible: true, value: true });
  assert.deepEqual(roofColumnThroughView({ isLeanTo: true, columnPlacement: 'gridIntersections', hasColumns: true, columnThrough: false }), { visible: true, value: false });
  assert.equal(roofColumnThroughView({ isLeanTo: true, columnPlacement: 'wallIntersections', hasColumns: true, columnThrough: true }).visible, false, '在来木造（壁交点）は出さない');
  assert.equal(roofColumnThroughView({ isLeanTo: false, columnPlacement: 'gridIntersections', hasColumns: true, columnThrough: true }).visible, false, '主屋根は出さない');
  assert.equal(roofColumnThroughView({ isLeanTo: true, columnPlacement: 'gridIntersections', hasColumns: false, columnThrough: true }).visible, false, '柱を持たない構造は出さない');
  assert.equal(roofColumnThroughView({ isLeanTo: true, columnPlacement: 'gridIntersections', columnThrough: true }).visible, false, 'hasColumns が無ければ出さない');
  assert.equal(roofColumnThroughView({ isLeanTo: true, columnPlacement: 'gridIntersections', hasColumns: true, columnThrough: undefined }).value, false, '値が無ければ false');
  assert.equal(roofColumnThroughView({ isLeanTo: true, columnPlacement: 'gridIntersections', hasColumns: true, columnThrough: 'true' }).value, false, '真偽値以外は false');
});

test('roofColumnThroughViewOfRoom: S造・RC造・SRC造の階で visible、在来木造の階で非表示（その階の実効主構造で決まる）', () => {
  for (const structure of ['S造', 'RC造(ラーメン)', 'SRC造']) {
    const { graph, roofRooms } = makeGraph(BLOCK(true), { structure });
    assert.deepEqual(roofColumnThroughViewOfRoom(roofRooms[0], graph, null), { visible: true, value: true }, structure);
  }
  const wood = makeGraph(BLOCK(true), { structure: TRADITIONAL_WOOD_STRUCTURE });
  assert.equal(roofColumnThroughViewOfRoom(wood.roofRooms[0], wood.graph, null).visible, false, '在来木造');
  // 柱を持たない構造（RC造（壁式）・木造（2"×4"））と主構造が未定の階は、通り芯の交点方式でも出さない
  for (const structure of ['RC造(壁式)', '木造（2"×4"）', '未定']) {
    const { graph, roofRooms } = makeGraph(BLOCK(true), { structure });
    assert.equal(roofColumnThroughViewOfRoom(roofRooms[0], graph, null).visible, false, structure);
  }
  // graph の上書きが無ければ project の建物全体の主構造に従う
  const g = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const placed = layoutOn(g, BLOCK(false));
  assert.equal(roofColumnThroughViewOfRoom(placed.roofRooms[0], g, { structuralInfo: { mainStructure: 'S造' } }).visible, true);
  assert.equal(roofColumnThroughViewOfRoom(placed.roofRooms[0], g, { structuralInfo: { mainStructure: TRADITIONAL_WOOD_STRUCTURE } }).visible, false);
});

test('【失敗系】isValidRoofFieldValue(columnThrough): 真偽値だけ通る', () => {
  assert.equal(isValidRoofFieldValue('columnThrough', true), true);
  assert.equal(isValidRoofFieldValue('columnThrough', false), true);
  for (const v of ['true', 1, 0, null, undefined, {}]) assert.equal(isValidRoofFieldValue('columnThrough', v), false, String(v));
});

// ================================================================
// (5) 配線（対象の行を1行まるごと一致で固定。コメントでは一致しない）
// ================================================================

const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const codeLines = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
  .filter(l => !l.trim().startsWith('//')).map(l => l.replace(/\s\/\/.*$/, '').trim());

test('【配線】structuralRecompute.js: 通り芯交点方式の実体階だけ自階の graph から柱貫通フィルタを作り、autoFillStructuralGrid へ渡す', () => {
  const src = readSrc('structuralRecompute.js');
  const lines = codeLines(src);
  assert.ok(lines.includes("const roofColumnFilter = (!isRoof && ownRules.columnPlacement !== 'wallIntersections')"), 'フィルタの条件の行');
  assert.ok(lines.includes('? withGraphReadScope(targetGraph, () => buildRoofColumnFilter(targetGraph)) : null;'), 'フィルタの導出の行');
  assert.ok(/aboveBeamSegments, selfGate, freeEndGraph, wallSourceCache, openingSources, belowGraph, roofRegions, roofCellKeys, roofColumnFilter\)\);$/m.test(src), 'autoFillStructuralGrid へ渡す行');
  assert.equal((src.match(/buildRoofColumnFilter\(/g) ?? []).length, 1, 'フィルタの導出は1か所');
});

test('【配線】structuralOrchestration.js: 下階の柱（autoFillColumnsForStructure(belowGraph…)）にも、下階自身の graph から作ったフィルタを渡す', () => {
  const src = readSrc('structuralOrchestration.js');
  const lines = codeLines(src);
  assert.ok(lines.includes("rulesFor(belowStructure).columnPlacement !== 'wallIntersections' ? buildRoofColumnFilter(belowGraph) : null);"), '下階のフィルタを渡す行');
  assert.ok(lines.includes('autoFillColumnsForStructure(belowGraph, project, belowGate, aboveColumnsForBelow, belowWallSegments, aboveBeamSegmentsForBelow, belowBelowGraph?.columns ?? [], undefined,'), '下階の柱生成の呼び出し行');
  assert.equal((lines.join('\n').match(/autoFillColumnsForStructure\(/g) ?? []).length, 1, '柱生成の呼び出しはこの1か所だけ（増えたらフィルタの渡し漏れを確かめる）');
});

test('【配線】structuralAutoFill.js: autoFillStructuralGrid → autoFillColumnsForStructure → autoFillColumns へフィルタを素通しする', () => {
  const lines = codeLines(readSrc('structuralAutoFill.js'));
  assert.ok(lines.some(l => l.endsWith('roofRegions = undefined, roofCellKeys = undefined, roofColumnFilter = null) {')), 'autoFillStructuralGrid の引数');
  assert.ok(lines.some(l => l.endsWith('aboveBeamSegments, belowColumns, wallSourceCache, roofColumnFilter) : { created: [], removed: [], originsUpdated: [] };')), 'autoFillColumnsForStructure への受け渡し');
  assert.ok(lines.includes('return autoFillColumns(graph, project, wallGate, roofColumnFilter);'), 'autoFillColumns への受け渡し');
  assert.ok(lines.includes('export function autoFillColumns(graph, project, wallGate = null, roofColumnFilter = null) {'));
});

test('【配線】roofColumnFilter.js は純モジュール: store.js・snap.js・.jsx・react-konva を静的 import しない。wallGate.js・structuralAutoFill.js を import しない（循環の回避）', () => {
  const code = codeLines(readSrc('roofColumnFilter.js')).join('\n');
  const imports = [...code.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.ok(imports.length >= 3, `前提: import を読めている（${imports.join(', ')}）`);
  assert.ok(imports.every(p => !/(store|snap)\.js$/.test(p) && !/\.jsx$/.test(p) && p !== 'react-konva'), `禁止の import がある: ${imports.join(', ')}`);
  assert.ok(imports.every(p => p !== './wallGate.js' && p !== './structuralAutoFill.js'), './wallGate.js・./structuralAutoFill.js を import しない');
});
