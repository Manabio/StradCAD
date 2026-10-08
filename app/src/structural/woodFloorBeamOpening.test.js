// 在来木造の床梁（autoFillWoodFloorBeams）の床開口ガード（openingComponents）のテスト。
// 開口（吹抜け・昇降路）の区画には床梁を作らない。壁の無い辺の開口は吹抜け小梁（role:'secondary'）がセルを
// 分けるため、小梁をセルの辺・端部アンカーにする。本番の autoFillStructuralGrid／recomputeStructuralForGraph を通す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, RoomFeature } from '../core.js';
import { getAllCells } from '../finish/gridCells.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { autoFillStructuralGrid } from './structuralAutoFill.js';
import { autoFillWoodFloorBeams } from './woodAutoFill.js';
import { openingEdgeComponents, edgeTarget } from './openingBeamAxes.js';
import { selfWallSegments } from './wallBeamAxes.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
const GRID = { labeled: true, discipline: Discipline.STRUCT };

function newProject(id) {
  const project = new Project(id, 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(2400, '2階', 'p2');
  g1.structureOverride = WOOD;
  g2.structureOverride = WOOD;
  return { project, g1, g2 };
}

// 4辺とも壁の開口。通り芯 X:0,5460,8190 / Y:0,3640。部屋「A」(5460×3640) と開口の部屋 (2730×3640)。
function makeWalledOpening(feature = RoomFeature.VOID) {
  const f = newProject('proj-floor-open-walled');
  for (const x of [0, 5460, 8190]) f.g2.addCenterLine(CenterLineType.VERTICAL, x, GRID);
  for (const y of [0, 3640]) f.g2.addCenterLine(CenterLineType.HORIZONTAL, y, GRID);
  const cells = getAllCells(f.g2);
  const voidKey = cells.find(c => c.x1 === 5460 && c.x2 === 8190).key;
  const roomA = f.g2.addRoom(new Set(cells.filter(c => c.key !== voidKey).map(c => c.key)), 'A');
  const voidRoom = f.g2.addRoom(new Set([voidKey]), '開口');
  voidRoom.setFeature(feature);
  generateRoomWallsFromOutline(f.g2, roomA);
  generateRoomWallsFromOutline(f.g2, voidRoom);
  return f;
}

// 壁なしの辺を持つ部分指定の開口。通り芯 X:0,3640,7280 / Y:0,3640,10920。親部屋「A」は4セル全部（外周だけ壁）。
// 開口は隅のセル(x0..3640, y0..3640)。内側の2辺（x=3640・y=3640）は壁なし＝吹抜け小梁が架かる。
function makePartialOpening(feature = RoomFeature.VOID) {
  const f = newProject('proj-floor-open-partial');
  for (const x of [0, 3640, 7280]) f.g2.addCenterLine(CenterLineType.VERTICAL, x, GRID);
  for (const y of [0, 3640, 10920]) f.g2.addCenterLine(CenterLineType.HORIZONTAL, y, GRID);
  const cells = getAllCells(f.g2);
  const parent = f.g2.addRoom(new Set(cells.map(c => c.key)), 'A');
  generateRoomWallsFromOutline(f.g2, parent);
  const voidKey = cells.find(c => c.x1 === 0 && c.x2 === 3640 && c.y1 === 0 && c.y2 === 3640).key;
  const voidRoom = f.g2.addRoom(new Set([voidKey]), '開口', crypto.randomUUID(), new Set([parent.id]));
  voidRoom.setFeature(feature);
  return f;
}

// 本番の autoFillStructuralGrid 経路（openingComponents は recompute と同じく openingEdgeComponents から）。
// withOpenings=false は openingComponents=undefined（従来の呼び出し）。
function fill(g, project, withOpenings = true) {
  const segs = selfWallSegments(g);
  const components = withOpenings ? openingEdgeComponents(g) : undefined;
  return autoFillStructuralGrid(g, project, WOOD, null, [], segs, [], [], [], undefined, undefined, undefined, [], null, undefined, undefined, null, components);
}
const selfBaseMaterial = () => rulesFor(WOOD).baseMaterial;
const selfBeamSection = () => rulesFor(WOOD).defaultSections.beam;
const floors = g => g.beams.filter(b => b.role === 'floor');
const smalls = g => g.beams.filter(b => b.role === 'secondary');
const brief = b => `${b.isVertical ? 'V' : 'H'}${Math.round(b.axisCL.effectiveValue)}:${Math.round(b.clStart.effectiveValue)}..${Math.round(b.clEnd.effectiveValue)}`;
const span = b => [Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue), Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)];
// 床梁が開口の矩形 (x1..x2, y1..y2) の内側にあるか（材軸の座標と範囲が開口の中）
const insideRect = (b, r) => {
  const [lo, hi] = span(b);
  const c = b.axisCL.effectiveValue;
  return b.isVertical
    ? c > r.x1 && c < r.x2 && lo >= r.y1 && hi <= r.y2
    : c > r.y1 && c < r.y2 && lo >= r.x1 && hi <= r.x2;
};

async function recompute(f) {
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => f.project.graphMap.get(plane.id) ?? null;
  try {
    return await recomputeStructuralForGraph(f.g2, f.project, WOOD, f.g1);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
}

const VOID_RECT = { x1: 5460, x2: 8190, y1: 0, y2: 3640 };

test('【床開口ガード】4辺とも壁の吹抜け: 開口の区画(2730×3640)に床梁は出ない。隣の部屋(5460×3640)には出る', () => {
  const { project, g2 } = makeWalledOpening();
  assert.equal(openingEdgeComponents(g2).length, 1, '前提: 矩形の吹抜け1成分');
  fill(g2, project);
  const fb = floors(g2);
  assert.ok(fb.length > 0, `前提: 開口の外の部屋には床梁が出る。実際: ${fb.map(brief)}`);
  assert.ok(!fb.some(b => insideRect(b, VOID_RECT)), `開口の中に床梁なし。実際: ${fb.map(brief)}`);
});

test('【床開口ガード・対照】openingComponents が undefined なら従来どおり開口の区画にも床梁が出る', () => {
  const { project, g2 } = makeWalledOpening();
  fill(g2, project, false);
  const fb = floors(g2);
  assert.ok(fb.some(b => insideRect(b, VOID_RECT)), `対照: ガード無しでは開口の区画に出る。実際: ${fb.map(brief)}`);
});

test('【床梁撤去】既に開口の区画にある auto の床梁は、開口を渡した再計算で撤去される。開口の外の床梁は残る', async () => {
  const f = makeWalledOpening();
  fill(f.g2, f.project, false); // 旧データ相当（開口に床梁がある）
  const before = floors(f.g2);
  const inVoid = before.filter(b => insideRect(b, VOID_RECT));
  assert.ok(inVoid.length > 0, '前提: 開口の区画に床梁');
  const outsideIds = before.filter(b => !insideRect(b, VOID_RECT)).map(b => b.id).sort();
  assert.ok(outsideIds.length > 0, '前提: 開口の外にも床梁');

  await recompute(f);
  const after = floors(f.g2);
  assert.ok(!after.some(b => insideRect(b, VOID_RECT)), `開口の床梁は消える。実際: ${after.map(brief)}`);
  assert.deepEqual(after.map(b => b.id).sort(), outsideIds, '開口の外の床梁は変わらない');
});

test('【床開口ガード】昇降路（EV）も吹抜けと同じ扱い: 開口の区画に床梁は出ない', () => {
  const { project, g2 } = makeWalledOpening(RoomFeature.ELEVATOR_EQUIPMENT);
  assert.equal(openingEdgeComponents(g2).length, 1, '前提: 昇降路が開口成分になる');
  fill(g2, project);
  const fb = floors(g2);
  assert.ok(fb.length > 0, '前提: 開口の外の部屋には床梁が出る');
  assert.ok(!fb.some(b => insideRect(b, VOID_RECT)), `実際: ${fb.map(brief)}`);
});

test('【床開口ガード】壁なしの部分開口: 小梁が区画を分け、開口の中に床梁は出ず、開口の外の床梁は小梁に取りつく', () => {
  const { project, g2 } = makePartialOpening();
  fill(g2, project);
  const sm = smalls(g2);
  assert.deepEqual(sm.map(brief).sort(), ['H3640:0..7280', 'V3640:0..3640'], `前提: 吹抜け小梁。実際: ${sm.map(brief)}`);
  const fb = floors(g2);
  const rect = { x1: 0, x2: 3640, y1: 0, y2: 3640 };
  assert.ok(fb.length > 0, '前提: 開口の外には床梁が出る');
  assert.ok(!fb.some(b => insideRect(b, rect)), `開口の中に床梁なし。実際: ${fb.map(brief)}`);
  // 開口の右隣の区画(x3640..7280 × y0..3640): 横梁が y=1820 に、始端は小梁 V3640 の梁芯、終端は x=7280 の壁線の梁。
  const right = fb.find(b => !b.isVertical && Math.abs(b.axisCL.effectiveValue - 1820) < 1);
  assert.ok(right, `右隣の区画の床梁。実際: ${fb.map(brief)}`);
  const v = sm.find(b => b.isVertical);
  assert.equal(right.clStart.id, v.axisCL.id, '始端は開口の小梁の梁芯');
  assert.equal(Math.round(right.clEnd.effectiveValue), 7280);
  assert.deepEqual(span(right).map(Math.round), [3640, 7280]);
});

test('【床開口ガード・対照】壁なしの部分開口で openingComponents が undefined なら開口の中にも床梁が出る', () => {
  const { project, g2 } = makePartialOpening();
  fill(g2, project, false);
  const fb = floors(g2);
  // 小梁が無いので区画が割れず、開口を横切る長い床梁(0..7280)になる。
  assert.ok(fb.some(b => !b.isVertical && b.axisCL.effectiveValue > 0 && b.axisCL.effectiveValue < 3640), `実際: ${fb.map(brief)}`);
});

test('【床開口ガード】冪等: 2回目の再生成は床梁を作らず撤去もしない（壁あり・壁なしとも）', () => {
  for (const make of [makeWalledOpening, makePartialOpening]) {
    const { project, g2 } = make();
    fill(g2, project);
    const ids = floors(g2).map(b => b.id).sort();
    const smallIds = smalls(g2).map(b => b.id).sort();
    const r = fill(g2, project);
    assert.deepEqual(floors(g2).map(b => b.id).sort(), ids, `${make.name}: 床梁の id が不変`);
    assert.deepEqual(smalls(g2).map(b => b.id).sort(), smallIds, `${make.name}: 小梁の id が不変`);
    assert.equal(r.newBeams.filter(b => b.role === 'floor').length, 0);
    assert.equal(r.removedBeams.length, 0);
  }
});

test('【床開口ガード】単体: 開口成分に矩形でないものが混じっても例外にならず、その成分は無視する', () => {
  const { project, g2 } = makeWalledOpening();
  fill(g2, project, false);
  const n = floors(g2).length;
  const res = autoFillWoodFloorBeams(g2, project, undefined, [[{ isVertical: true, coord: 0, lo: 0, hi: 1 }]]);
  assert.equal(res.removed.length, 0);
  assert.equal(floors(g2).length, n, '矩形でない成分ではガードしない');
});

test('【T1・回帰防止】開口なしの5460×3640の部屋に無関係な手動固定の小梁があっても、床梁 V1820・V3640 は残る', () => {
  const f = newProject('proj-floor-open-manual-small');
  const { project, g2 } = f;
  for (const x of [0, 5460]) g2.addCenterLine(CenterLineType.VERTICAL, x, GRID);
  for (const y of [0, 3640]) g2.addCenterLine(CenterLineType.HORIZONTAL, y, GRID);
  const room = g2.addRoom(new Set(getAllCells(g2).map(c => c.key)), 'A');
  generateRoomWallsFromOutline(g2, room);
  fill(g2, project);
  assert.deepEqual(floors(g2).map(brief).sort(), ['V1820:0..3640', 'V3640:0..3640'], '前提: 床梁2本');

  // 部屋の内部に突き出す手動固定の小梁 V2730:0..1500（開口とは無関係）
  const ax = g2.addCenterLine(CenterLineType.VERTICAL, 2730, { labeled: false, discipline: Discipline.FUSE });
  const yTop = g2.centerLines.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.value === 0);
  const yEnd = g2.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.FUSE });
  g2.addBeam(selfBaseMaterial(g2), selfBeamSection(g2), ax, true, yTop, yEnd, { role: 'secondary', dimensionStatus: 'locked' });
  fill(g2, project);
  assert.deepEqual(floors(g2).map(brief).sort(), ['V1820:0..3640', 'V3640:0..3640'], '手動小梁で床梁は消えない');
});

const clAt = (g, type, value) => g.centerLines.find(c => c.centerLineType === type && c.value === value);

test('【T3】開口辺と同じ軸上でも区間が重ならない手動固定の小梁は、区画の辺にしない（床梁は置く前と同じ）', () => {
  const { project, g2 } = makePartialOpening();
  fill(g2, project);
  const before = floors(g2).map(brief).sort();
  assert.ok(before.length > 0, '前提: 床梁がある');
  assert.ok(smalls(g2).some(b => b.isVertical && brief(b) === 'V3640:0..3640'), '前提: 開口の辺 x=3640 (y0..3640) に小梁');
  // x=3640（開口の辺と同軸）の y5000..6000。辺とは重ならず、下の部屋の大きな区画の内部に突き出す手動固定の小梁。
  const yA = g2.addCenterLine(CenterLineType.HORIZONTAL, 5000, { labeled: false, discipline: Discipline.FUSE });
  const yB = g2.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.FUSE });
  g2.addBeam(selfBaseMaterial(), selfBeamSection(), clAt(g2, CenterLineType.VERTICAL, 3640), true, yA, yB, { role: 'secondary', dimensionStatus: 'locked' });
  fill(g2, project);
  assert.deepEqual(floors(g2).map(brief).sort(), before);
});

test('【T4】辺に壁がある開口で、小梁が逃げ後座標（edgeTarget）の近傍にあれば区画の辺になる（辺座標とは別値）', () => {
  const { project, g2 } = makeWalledOpening();
  const edge = openingEdgeComponents(g2)[0].find(e => e.isVertical && e.coord === 5460);
  const target = edgeTarget(g2, edge, rulesFor(WOOD)).coord;
  const axisX = Math.round(target) + 30; // 逃げ後座標から30ずらす（許容 梁幅/2 以内・0.5 超）
  assert.ok(Math.abs(axisX - 5460) > 60 && Math.abs(axisX - target) > 0.5 && Math.abs(axisX - target) < 60,
    `前提: 辺座標とは別の枝で一致する。target=${target}`);
  fill(g2, project);
  const ax = g2.addCenterLine(CenterLineType.VERTICAL, axisX, { labeled: false, discipline: Discipline.FUSE });
  g2.addBeam(selfBaseMaterial(), selfBeamSection(), ax, true, clAt(g2, CenterLineType.HORIZONTAL, 0), clAt(g2, CenterLineType.HORIZONTAL, 3640), { role: 'secondary', dimensionStatus: 'locked' });
  fill(g2, project);
  // 小梁が辺になり、部屋の区画は x0..axisX に変わる（短辺3640超・材軸は縦）。床梁は等分位置に置き直される。
  const n = Math.ceil(axisX / 1820);
  const expected = Array.from({ length: n - 1 }, (_, i) => `V${Math.round((i + 1) * axisX / n)}:0..3640`).sort();
  assert.deepEqual(floors(g2).map(brief).sort(), expected);
});

test('【T2】同座標に部分区間の梁と全長の大梁（axisCL 別）が並ぶとき、床梁の端のアンカーは区間を覆う全長の大梁の axisCL', () => {
  const { project, g2 } = newProject('proj-floor-open-cover');
  const [xa, xb] = [0, 5460].map(x => g2.addCenterLine(CenterLineType.VERTICAL, x, GRID));
  const [ya, yb] = [0, 3640].map(y => g2.addCenterLine(CenterLineType.HORIZONTAL, y, GRID));
  const yDecoy = g2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.FUSE });
  const xMid = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const base = selfBaseMaterial(g2), sec = selfBeamSection(g2);
  // 先に y=0 上の部分区間の大梁（axisCL=yDecoy）、後から全長の大梁（axisCL=ya）。
  g2.addBeam(base, sec, yDecoy, false, xa, xMid, { role: 'primary' });
  g2.addBeam(base, sec, ya, false, xa, xb, { role: 'primary' });
  g2.addBeam(base, sec, yb, false, xa, xb, { role: 'primary' });
  g2.addBeam(base, sec, xa, true, ya, yb, { role: 'primary' });
  g2.addBeam(base, sec, xb, true, ya, yb, { role: 'primary' });
  const res = autoFillWoodFloorBeams(g2, project);
  assert.ok(res.created.length > 0, '前提: 床梁ができる');
  for (const b of floors(g2)) {
    assert.equal(b.clStart.id, ya.id, `${brief(b)} の始端は全長の大梁の axisCL`);
    assert.equal(b.clEnd.id, yb.id);
  }
});
