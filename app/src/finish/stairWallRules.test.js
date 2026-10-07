// 階段まわりの壁の3規則（ユーザー指示2026-10-06）を、本番と同じ経路（runFinishEntryBoundary → runFinishExitBoundary。
// resolveStairContext → regenerateWalls → 2a → 隣室壁 → 外壁）で固定する。
//  規則1: 階段設置階Nの上り口の辺に壁を建てない。
//  規則2: 設置階の上階N+1の下り口（直下階の階段の到達辺）に壁を建てない（吹抜け・続きの階段のペア部屋のどちらでも）。
//  規則3: N+1の外壁判定に直下階の階段の足元（STAIR_VOID／ペア部屋）を屋内として参加させる。
// 世界座標は全階共通。壁は線分（軸・始終点）で比べる。peek は階id→graph のスタブ（本番同型）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StairType, StairPortSide, RoomFeature, RoomKind } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from './finishBoundary.js';
import { loadMaterialMap } from './wallRegeneration.js';
import { stairPortEdges } from './stair/stairGeometry.js';
import { refreshCells, cellBoundsFromKey } from './gridCells.js';
import { stairPartitionLines, isStairPartitionWall } from './stair/stairPartition.js';
import { selfWallSegments } from '../structural/wallBeamAxes.js';
import { isEligibleWallSpan } from './kneeDropWall.js';

const X = [-3000, 0, 1000, 4000];
const Y = [-3000, 0, 1500, 3000, 6000];
const STAIR_CELLS = [[1, 1], [1, 2]]; // 階段の足元（x 0..1000, y 0..3000。側面の口は先頭／末尾の行が要るので2行）

// 階ごとの通り芯グリッド（per-floor CL。値は全階同一）と、格子セルの鍵を返す。
// yExtents: Y の添字 → 中心線の区間 { extentLo, extentHi }（省略は全長。moku1-2 の2階のように区間が足元に届かない形）
// beamYs: 梁芯（分割線ではない）にする Y の添字（moku1-2 の2階の Y=-4550 のように、同座標に梁芯しか無く格子が割れない）
function addFloor(project, elevation, id, { yExtents = {}, xExtents = {}, beamYs = [] } = {}) {
  const { graph } = project.addPlane(elevation, id, id);
  const xs = X.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH, ...(xExtents[i] ?? {}) }));
  const ys = Y.map((v, i) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: beamYs.includes(i) ? Discipline.FUSE : Discipline.ARCH, ...(yExtents[i] ?? {}) }));
  const key = (c, r) => `${xs[c].id}:${ys[r].id}:${xs[c + 1].id}:${ys[r + 1].id}`;
  return { graph, key };
}

// 3列4行の格子のうち、階段の足元（STAIR_CELLS）と skip 以外へ部屋を置く。skip は部屋を置かない格子。
function addRooms(f, skip = []) {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      if (STAIR_CELLS.some(([sc, sr]) => sc === c && sr === r)) continue;
      if (skip.some(([sc, sr]) => sc === c && sr === r)) continue;
      f.graph.addRoom(new Set([f.key(c, r)]), `部屋${c}${r}`);
    }
  }
}

function addStair(f, opts = {}) {
  const { cells = STAIR_CELLS, kind = null, ...rest } = opts;
  const keys = new Set(cells.map(([c, r]) => f.key(c, r)));
  const pair = f.graph.addRoom(new Set(keys), '階段');
  pair.setFeature(RoomFeature.STAIR);
  if (kind) pair.setKind(kind);
  return f.graph.addStair({
    type: StairType.STRAIGHT, cells: keys, roomId: pair.id,
    upDirection: 'up', flip: false, totalSteps: 12, tread: 250, ...rest,
  });
}

function addVoid(f, cells = STAIR_CELLS) {
  const room = f.graph.addRoom(new Set(cells.map(([c, r]) => f.key(c, r))), '吹抜け');
  room.setFeature(RoomFeature.STAIR_VOID);
  return room;
}

// 本番の脱出境界を回す。突入側の reconcileOnFinishEntry（直下階の階段の吹抜けを足す）も本番どおり走る。
async function exitWalls(project, graph) {
  const materialMap = await loadMaterialMap();
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  try {
    project.activePlaneId = graph.plane.id;
    await runFinishEntryBoundary(graph, project);
    await runFinishExitBoundary(graph, project, { materialMap, stairUnderRooms: () => [] }, { goingToStructure: false });
  } finally {
    floorSwapManager.peek = original;
  }
}

const dump = (graph) => graph.walls.map(w => ({
  v: w.isVertical, axis: Math.round(w.axisValue),
  lo: Math.round(Math.min(w.coord1, w.coord2)), hi: Math.round(Math.max(w.coord1, w.coord2)), ext: w.isExteriorWall,
}));
// 壁は辺（グリッド線）から壁厚の半分ほどずれて建つ（隣の平行なグリッド線は1000mm以上先なので許容200mm）。
// 壁の端は隣の壁の厚みぶん辺の端からはみ出す（約60mm）ので、実質の重なりは100mm超で数える。
const wallsNear = (graph, e, { extOnly = false } = {}) => dump(graph).filter(w =>
  w.v === e.isVertical && Math.abs(w.axis - e.value) < 200 && Math.min(w.hi, e.hi) - Math.max(w.lo, e.lo) > 100
  && (!extOnly || w.ext));
const show = (ws) => ws.map(w => `${w.v ? 'V' : 'H'}${w.axis}[${w.lo},${w.hi}]${w.ext ? 'E' : ''}`).join(' ');

const edge = (isVertical, value, lo, hi) => ({ isVertical, value, lo, hi });
const NORTH = edge(false, 0, 0, 1000);     // 階段足元の北辺（up の到達辺）
const SOUTH = edge(false, 3000, 0, 1000);  // 南辺（up の上り口）
const EAST = edge(true, 1000, 0, 3000);
const WEST = edge(true, 0, 0, 3000);

function assertOpen(graph, e, msg) {
  assert.equal(show(wallsNear(graph, e)), '', `${msg}: 辺 ${JSON.stringify(e)} に壁がない`);
}
function assertWalled(graph, e, msg) {
  assert.notEqual(show(wallsNear(graph, e)), '', `${msg}: 辺 ${JSON.stringify(e)} に壁がある（前提）`);
}

// 下階 p1（階段あり）と上階 p2 を組み、上階を脱出して壁を得る。upper(project, lower) が上階の { graph, key } を作る。
async function twoFloors({ lowerStair = {}, upper, withLowerStair = true, third = false, upperYExtents = {}, upperXExtents = {}, upperBeamYs = [] }) {
  const project = new Project('proj', 'test');
  const l = addFloor(project, 0, 'p1');
  addRooms(l);
  const stair = withLowerStair ? addStair(l, lowerStair) : null;
  const u = addFloor(project, 3000, 'p2', { yExtents: upperYExtents, xExtents: upperXExtents, beamYs: upperBeamYs });
  upper(u);
  if (third) { const t = addFloor(project, 6000, 'p3'); addRooms(t, STAIR_CELLS); }
  await exitWalls(project, u.graph);
  return { project, lower: l, upper: u, stair };
}

// 辺 e と同じ向き・同じ線上（許容200mm）の壁が、区間 [lo,hi] に重なる長さの合計
function coverLen(graph, e, lo, hi) {
  return dump(graph)
    .filter(w => w.v === e.isVertical && Math.abs(w.axis - e.value) < 200)
    .reduce((s, w) => s + Math.max(0, Math.min(w.hi, hi) - Math.max(w.lo, lo)), 0);
}

// ---- 開口が隣室の辺の一部（開口の端が格子に乗らない）のとき: 開口の区間だけ壁を建てず、残りには建てる ----
// 階段の両隣（西の列・東の列）の隣室は、生キーで y 0..3000 を1セルで持つ。Y=1500 は梁芯（分割線ではない。
// moku1-2 の2階の Y=-4550 と同じ形）なので、辺は y=1500 で切れない。階段の側面の口（LEFT）は y 0..1500 か
// 1500..3000 の半分だけ＝隣室の辺（y 0..3000）の一部。
const tallSideRooms = (f) => [0, 2].map(c => {
  const top = f.key(c, 1).split(':'), bottom = f.key(c, 2).split(':');
  return f.graph.addRoom(new Set([`${top[0]}:${top[1]}:${top[2]}:${bottom[3]}`]), `隣室${c}`);
});

test('開口が隣室の辺の一部【N+1・下り口】下り口が上階の原子セルの辺の一部でも、隣室側の壁は下り口の区間に建たず、残りの区間には建つ', async () => {
  const { lower, upper, stair } = await twoFloors({
    lowerStair: { arrivalSide: StairPortSide.LEFT },
    upperBeamYs: [2],
    upper: (u) => { addRooms(u, [[0, 1], [0, 2], [2, 1], [2, 2]]); tallSideRooms(u); },
  });
  const [e] = stairPortEdges(stair, lower.graph, ['arrival']);
  assert.equal(e.isVertical, true, '前提: 側面の口（縦の辺 x=0）');
  assert.ok(e.hi - e.lo < 3000, '前提: 口は隣室の辺（y 0..3000）の一部');
  assert.equal(coverLen(upper.graph, e, e.lo + 150, e.hi - 150), 0, '下り口の区間（端の取り合い分を除く）に壁がない');
  const restLo = e.lo === 0 ? e.hi + 150 : 150, restHi = e.lo === 0 ? 2850 : e.lo - 150;
  assert.ok(coverLen(upper.graph, e, restLo, restHi) > restHi - restLo - 200, '残りの区間には壁が建つ');
});

test('開口が隣室の辺の一部【N・上り口】上り口が隣室の辺の一部でも、隣室側の壁は上り口の区間に建たず、残りの区間には建つ（規則1）', async () => {
  const project = new Project('proj', 'test');
  const f = addFloor(project, 0, 'p1', { beamYs: [2] });
  addRooms(f, [[0, 1], [0, 2], [2, 1], [2, 2]]);
  tallSideRooms(f);
  const stair = addStair(f, { entrySide: StairPortSide.LEFT });
  await exitWalls(project, f.graph);
  const [e] = stairPortEdges(stair, f.graph, ['entry']);
  assert.equal(e.isVertical, true, '前提: 側面の口（縦の辺 x=0）');
  assert.ok(e.hi - e.lo < 3000, '前提: 口は隣室の辺（y 0..3000）の一部');
  assert.equal(coverLen(f.graph, e, e.lo + 150, e.hi - 150), 0, '上り口の区間に壁がない');
  const restLo = e.lo === 0 ? e.hi + 150 : 150, restHi = e.lo === 0 ? 2850 : e.lo - 150;
  assert.ok(coverLen(f.graph, e, restLo, restHi) > restHi - restLo - 200, '残りの区間には壁が建つ');
});

// ---- 規則1: 設置階Nの上り口（と到達辺）に壁を建てない ----
for (const entrySide of [null, StairPortSide.LEFT, StairPortSide.RIGHT]) {
  test(`規則1【N】直進 entrySide=${entrySide}: 上り口の辺に壁がなく、口でなくなった走行端には壁がある`, async () => {
    const project = new Project('proj', 'test');
    const f = addFloor(project, 0, 'p1');
    addRooms(f);
    const stair = addStair(f, { entrySide });
    await exitWalls(project, f.graph);
    const entries = stairPortEdges(stair, f.graph, ['entry']);
    assert.equal(entries.length, 1, '前提: 上り口は1辺');
    assertOpen(f.graph, entries[0], '上り口');
    assertOpen(f.graph, NORTH, '到達辺');
    assert.equal(entries[0].isVertical, entrySide != null, '前提: 側面指定なら縦の辺（走行端は横の辺）');
    if (entrySide != null) assertWalled(f.graph, SOUTH, '側面の口にしたとき走行端');
    assertWalled(f.graph, edge(true, 0, 0, 1500), '階段の西側面の北半分（口にかからない部分）');
  });
}

// ---- 規則2: N+1 の下り口（直下階の階段の到達辺）に壁を建てない ----
for (const arrivalSide of [null, StairPortSide.LEFT, StairPortSide.RIGHT]) {
  test(`規則2(b)【N+1・吹抜け】arrivalSide=${arrivalSide}: 下り口の辺に壁がない（上り口側の南辺には壁がある）`, async () => {
    const { lower, upper, stair } = await twoFloors({
      lowerStair: { arrivalSide }, upper: (u) => { addRooms(u); addVoid(u); },
    });
    const arrivals = stairPortEdges(stair, lower.graph, ['arrival']);
    assert.equal(arrivals.length, 1, '前提: 下り口は1辺');
    assertOpen(upper.graph, arrivals[0], '下り口');
    assertWalled(upper.graph, SOUTH, '上り口側の南辺（N+1では開口でない）');
  });
}

for (const arrivalSide of [null, StairPortSide.LEFT, StairPortSide.RIGHT]) {
  test(`規則2(c1)【N+1・同footprintの続きの階段（ペア部屋・吹抜け無し）】下階 arrivalSide=${arrivalSide}: 下り口の辺に壁がない`, async () => {
    const { lower, upper, stair } = await twoFloors({
      lowerStair: { arrivalSide }, upper: (u) => { addRooms(u); addStair(u); },
    });
    assert.equal(upper.graph.rooms.some(r => r.feature === RoomFeature.STAIR_VOID), false, '前提: 吹抜けは無い');
    assertOpen(upper.graph, stairPortEdges(stair, lower.graph, ['arrival'])[0], '下り口');
  });
}

test('規則2(c2)【N+1・別形の続きの階段（横向き・吸収で吹抜け無し）】下階の到達辺（北辺）に壁がない', async () => {
  const { lower, upper, stair } = await twoFloors({
    upper: (u) => {
      addRooms(u, [[2, 1], [2, 2]]);
      addStair(u, { cells: [[1, 1], [1, 2], [2, 1], [2, 2]], upDirection: 'right' });
    },
  });
  assert.equal(upper.graph.rooms.some(r => r.feature === RoomFeature.STAIR_VOID), false, '前提: 吹抜けは無い');
  const [arrival] = stairPortEdges(stair, lower.graph, ['arrival']);
  assert.deepEqual(arrival, NORTH, '前提: 到達辺は北辺');
  assertOpen(upper.graph, arrival, '下り口');
});

test('規則2(c3)【N+1・吹抜けが残り別セルに続きの階段】下り口の辺に壁がない', async () => {
  const { lower, upper, stair } = await twoFloors({
    upper: (u) => {
      addRooms(u, [[2, 1], [2, 2]]);
      addVoid(u);
      addStair(u, { cells: [[2, 1], [2, 2]], upDirection: 'right' });
    },
  });
  assertOpen(upper.graph, stairPortEdges(stair, lower.graph, ['arrival'])[0], '下り口');
});

test('規則2【対照】直下階の階段が屋外階段なら、N+1 の足元（居室）は吹抜けにならず、下階の到達辺は開口にしない（屋外階段の誤開口防止）', async () => {
  const { lower, upper, stair } = await twoFloors({
    lowerStair: { kind: RoomKind.EXTERIOR },
    upper: (u) => {
      addRooms(u, [[2, 1], [2, 2]]);
      u.graph.addRoom(new Set(STAIR_CELLS.map(([c, r]) => u.key(c, r))), '居室');
    },
  });
  assert.equal(upper.graph.rooms.some(r => r.feature === RoomFeature.STAIR_VOID), false, '前提: 屋外階段は吹抜けを置かない（足元は居室のまま）');
  assertWalled(upper.graph, stairPortEdges(stair, lower.graph, ['arrival'])[0], '下階の到達辺（居室の北壁）');
});

// ---- 足元を2階の既存部屋から引き抜く（moku1-2.stq の条件。2階が部屋で覆われていても1階の階段の上は開く） ----
test('規則3【N+1・2階の既存部屋が足元を覆う（moku1-2）】足元を居室から引き抜いて吹抜けを置く: 西が部屋なしなら足元の西辺は外壁、既存部屋との境は外壁でなく、下り口は開口', async () => {
  // 足元（列1・行1〜2）を2階の居室が覆い、足元の西（列0・行1〜2）は部屋なし＝屋外
  const { lower, upper, stair } = await twoFloors({
    upper: (u) => {
      addRooms(u, [[0, 1], [0, 2]]);
      u.graph.addRoom(new Set(STAIR_CELLS.map(([c, r]) => u.key(c, r))), '居室');
    },
  });
  const voids = upper.graph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);
  assert.equal(voids.length, 1, '足元に吹抜けが置かれた');
  assert.equal(upper.graph.rooms.some(r => r.name === '居室'), false, '居室は足元だけだったので空になり除去');
  assert.notEqual(show(wallsNear(upper.graph, WEST, { extOnly: true })), '', '足元の西辺は外壁（階段が2階の外壁判定に含まれる）');
  for (const [name, e] of [['北', NORTH], ['南', SOUTH], ['東', EAST]]) {
    assert.equal(show(wallsNear(upper.graph, e, { extOnly: true })), '', `${name}辺は屋内どうしの境なので外壁なし`);
  }
  assertOpen(upper.graph, stairPortEdges(stair, lower.graph, ['arrival'])[0], '下り口');
});

test('規則3【N+1・2階の中心線の区間が足元に届かない（moku1-2）】区間を足元の辺まで延ばして格子を割り、足元ちょうどに吹抜けを置く: 足元の外の部屋は削られず、足元の西辺は外壁', async () => {
  // 2階の Y=0（足元の上辺。x 0..1000）の中心線が x 1000..4000 しか持たない＝足元の上辺で格子が割れない
  const { lower, upper, stair } = await twoFloors({
    upperYExtents: { 1: { extentLo: 1000, extentHi: 4000 } },
    upper: (u) => {
      addRooms(u, [[0, 1], [0, 2]]);
      u.graph.addRoom(new Set(STAIR_CELLS.map(([c, r]) => u.key(c, r))), '居室');
    },
  });
  const voids = upper.graph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);
  assert.equal(voids.length, 1, '足元に吹抜けが置かれた（粗い格子でも skipped にならない）');
  const area = [...refreshCells(voids[0].cells, upper.graph)].reduce((s, k) => {
    const b = cellBoundsFromKey(k, upper.graph); return s + (b.x2 - b.x1) * (b.y2 - b.y1);
  }, 0);
  assert.equal(area, 1000 * 3000, '吹抜けは足元ちょうど（x 0..1000 × y 0..3000）。足元の外へ広がらない');
  const north = upper.graph.rooms.find(r => r.name === '部屋10');
  assert.ok(north, '足元の北の部屋（部屋10）は削られず残る');
  assert.equal(refreshCells(north.cells, upper.graph).size, 1);
  assert.notEqual(show(wallsNear(upper.graph, WEST, { extOnly: true })), '', '足元の西辺は外壁');
  assertOpen(upper.graph, stairPortEdges(stair, lower.graph, ['arrival'])[0], '下り口');
});

test('規則3【N+1・同座標に区間の違う中心線が2本（moku1-2 の X=5460）】足元の西辺の軸には辺を覆う方を選び、西辺の外壁が辺の全長に建つ', async () => {
  // 2階の X=0（足元の西辺。y 0..3000）に、先に作る1本（y 3000..6000＝辺と無関係）と、辺を丸ごと覆う1本がある。
  // 変換は最初の1本を選ぶので、付け替えないと壁の軸の区間が辺を覆わず西辺の壁が欠ける
  const { upper } = await twoFloors({
    upperXExtents: { 1: { extentLo: 3000, extentHi: 6000 } },
    upper: (u) => {
      u.graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH, extentLo: -3000, extentHi: 3000 });
      addRooms(u, [[0, 1], [0, 2]]);
      u.graph.addRoom(new Set(STAIR_CELLS.map(([c, r]) => u.key(c, r))), '居室');
    },
  });
  assert.equal(upper.graph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).length, 1, '前提: 吹抜けが置かれた');
  const covered = wallsNear(upper.graph, WEST, { extOnly: true })
    .reduce((s, w) => s + Math.max(0, Math.min(w.hi, 3000) - Math.max(w.lo, 0)), 0);
  assert.ok(covered >= 2900, `西辺（y 0..3000）の外壁が全長に建つ（実測 ${covered}）`);
});

test('規則3【N+1・既存部屋が足元の外へ続く】引き抜き後も部屋は残りのセルを持ち、その壁が足元の辺に建つ（吹抜けの上り口側＝南辺は壁）', async () => {
  // 足元（列1・行1〜2）と、その東（列2・行1〜2）を同じ居室が覆う。足元だけ引き抜かれ、東が居室に残る
  const { upper } = await twoFloors({
    upper: (u) => {
      addRooms(u, [[0, 1], [0, 2], [2, 1], [2, 2]]);
      u.graph.addRoom(new Set([...STAIR_CELLS, [2, 1], [2, 2]].map(([c, r]) => u.key(c, r))), '居室');
    },
  });
  const living = upper.graph.rooms.find(r => r.name === '居室');
  assert.ok(living, '居室は残りのセルを持って残る');
  assert.equal(living.cells.size, 2, '東の2セルだけ');
  assertWalled(upper.graph, EAST, '足元と居室の境（足元の東辺）に居室の壁がある');
  assertWalled(upper.graph, SOUTH, '上り口側の南辺');
});

// ---- 規則3: N+1 の外壁判定に階段の足元を屋内として参加させる ----
test('規則3(d)【N+1・吹抜け】足元の西が部屋なし: 足元の西辺に外壁が建ち、足元の北・南・東の内側の辺には外壁が建たない', async () => {
  const { upper } = await twoFloors({ upper: (u) => { addRooms(u, [[0, 1], [0, 2]]); addVoid(u); } });
  assertWalled(upper.graph, { ...WEST, lo: 100, hi: 2900 }, '西辺');
  assert.notEqual(show(wallsNear(upper.graph, WEST, { extOnly: true })), '', '西辺は外壁');
  for (const [name, e] of [['北', NORTH], ['南', SOUTH], ['東', EAST]]) {
    assert.equal(show(wallsNear(upper.graph, e, { extOnly: true })), '', `${name}辺は屋内どうしの境なので外壁なし`);
  }
});

test('規則3(d)【N+1・続きの階段のペア部屋（同footprint）】足元の西が部屋なし: 外壁は吹抜けのときと同じ', async () => {
  const a = await twoFloors({ upper: (u) => { addRooms(u, [[0, 1], [0, 2]]); addVoid(u); } });
  const b = await twoFloors({ upper: (u) => { addRooms(u, [[0, 1], [0, 2]]); addStair(u); } });
  const ext = (r) => show(dump(r.upper.graph).filter(w => w.ext).sort((p, q) => show([p]).localeCompare(show([q]))));
  assert.equal(ext(b), ext(a), '外壁の線分が一致');
  assert.notEqual(show(wallsNear(b.upper.graph, WEST, { extOnly: true })), '', '西辺は外壁');
});

test('規則3【対照】直下階に階段が無く足元が未割当なら、足元は屋外扱いで北辺に外壁が建つ（STAIR_VOID／ペア部屋が屋内参加している証拠）', async () => {
  const { upper } = await twoFloors({
    withLowerStair: false, upper: (u) => { addRooms(u, [[0, 1], [0, 2]]); },
  });
  assert.notEqual(show(wallsNear(upper.graph, NORTH, { extOnly: true })), '', '足元が空きなら北辺に外壁');
});

// ---- (e) 3階建て（N+1 が最上階でない）でも同じ ----
test('規則2・3(e)【3階建て・N+1が中間階】吹抜け／別形のペア部屋とも、下り口に壁がなく、足元の西辺は外壁', async () => {
  const v = await twoFloors({
    third: true, lowerStair: { arrivalSide: StairPortSide.LEFT },
    upper: (u) => { addRooms(u, [[0, 1], [0, 2]]); addVoid(u); },
  });
  assertOpen(v.upper.graph, stairPortEdges(v.stair, v.lower.graph, ['arrival'])[0], '吹抜けの下り口');
  assert.notEqual(show(wallsNear(v.upper.graph, WEST, { extOnly: true })), '', '西辺は外壁（吹抜け）');

  const c = await twoFloors({
    third: true,
    upper: (u) => {
      addRooms(u, [[0, 1], [0, 2], [2, 1], [2, 2]]);
      addStair(u, { cells: [[1, 1], [1, 2], [2, 1], [2, 2]], upDirection: 'right' });
    },
  });
  assertOpen(c.upper.graph, stairPortEdges(c.stair, c.lower.graph, ['arrival'])[0], '別形ペア部屋の下り口');
  assert.notEqual(show(wallsNear(c.upper.graph, WEST, { extOnly: true })), '', '西辺は外壁（ペア部屋）');
});

// ---- 隔て壁（在来木造の折返し階段。レーン間中心線上の2枚）が規則1を崩さない ----
async function makeWoodSwitchbackFloor({ columnWidth = null } = {}) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, 'p1', 'p1');
  graph.structureOverride = '木造（在来）';
  if (columnWidth) graph.setWoodColumnWidthMm(columnWidth);
  const mk = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [-3000, 0, 1000, 2000, 5000].map(v => mk(CenterLineType.VERTICAL, v));
  const ys = [-3000, 0, 1000, 4000, 6000].map(v => mk(CenterLineType.HORIZONTAL, v));
  const key = (c, r) => `${xs[c].id}:${ys[r].id}:${xs[c + 1].id}:${ys[r + 1].id}`;
  // 階段: 踊り場（y0〜1000）＋左右レーン（y1000〜4000）。周りは居室
  const cells = new Set([key(1, 1), key(2, 1), key(1, 2), key(2, 2)]);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (!cells.has(key(c, r))) graph.addRoom(new Set([key(c, r)]), `部屋${c}${r}`);
  const pair = graph.addRoom(new Set(cells), '階段');
  pair.setFeature(RoomFeature.STAIR);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: pair.id, sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  await exitWalls(project, graph);
  return { project, graph, stair };
}

test('隔て壁【在来・折返し階段（本番経路）】脱出後にレーン間中心線上へ隔て壁2枚が建ち、上り口の辺には壁が建たない（規則1）', async () => {
  const { graph, stair } = await makeWoodSwitchbackFloor();
  const mids = graph.walls.filter(w => w.isVertical && w.axisCL.effectiveValue === 1000 && Math.abs(Math.abs(w.axisOffset) - 57.5) < 0.01 && Math.max(w.coord1, w.coord2) < 4100);
  assert.equal(mids.length, 2, `レーン間中心線 x=1000 上に隔て壁2枚（実際 ${show(dump(graph).filter(w => w.v && w.axis > 900 && w.axis < 1100))}）`);
  assert.deepEqual(mids.map(w => w.backingDepth).sort(), [0, 90]);
  for (const w of mids) {
    // 設計上の区間（端CL）は両レーンが並走する y1000〜4000。物理端は自由端の側だけ端CLから柱包み分（57.5）はね出す。
    // 踊り場側（y1000）は自由端＝−57.5。上り口側（y4000）は壁が建たない辺だが、下の部屋の境界壁（x=1000 の延長上）と
    // 同じ線上に連なるので自由端ではない＝はね出さない。
    assert.deepEqual([Math.min(w.clStart.effectiveValue, w.clEnd.effectiveValue), Math.max(w.clStart.effectiveValue, w.clEnd.effectiveValue)], [1000, 4000]);
    assert.deepEqual([Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)], [942.5, 4000], `物理端（実際 ${w.coord1}〜${w.coord2}）`);
  }
  for (const e of stairPortEdges(stair, graph, ['entry'])) assertOpen(graph, e, '上り口');
});

test('隔て壁【識別】レーン間中心線の延長上（階段の下側 y4000〜6000 を x=1000 で2室に分けた）の部屋壁は、柱包みで端がはね出しても隔て壁と識別されず、構造・腰壁の対象に残る', async () => {
  // 柱寸120（既定。境界壁は軸±72.5・下地120）と柱寸90（軸±57.5・下地90＝隔て壁と同じ形。形の照合だけでは外れない）の両方
  for (const columnWidth of [null, 90]) {
  const { graph } = await makeWoodSwitchbackFloor({ columnWidth });
  const lines = stairPartitionLines(graph);
  const ext = graph.walls.filter(w => w.isVertical && w.axisCL.effectiveValue === 1000 && Math.min(w.coord1, w.coord2) > 3900);
  assert.equal(ext.length, 2, `前提: 延長上の境界壁2枚（実際 ${show(dump(graph).filter(w => w.v && w.axis > 900 && w.axis < 1100))}）`);
  if (columnWidth === 90) assert.ok(ext.some(w => Math.abs(Math.abs(w.axisOffset) - 57.5) < 0.01 && w.backingDepth === 90), '前提: 柱寸90では延長上の壁が隔て壁と同じ形（軸±57.5・下地90）');
  for (const w of ext) {
    assert.equal(isStairPartitionWall(w, lines), false, `延長上の部屋壁は偽（off ${w.axisOffset} span ${Math.min(w.coord1, w.coord2)}〜${Math.max(w.coord1, w.coord2)}）`);
    assert.equal(isEligibleWallSpan(w, graph), true, '腰壁・垂れ壁の対象に残る');
  }
  assert.ok(selfWallSegments(graph).some(sg => sg.isVertical && Math.abs(sg.coord - 1000) < 100 && sg.lo >= 3900 && sg.hi >= 5900),
    '構造の壁区間に x=1000・y4000〜6000 の線が残る');
  }
});
