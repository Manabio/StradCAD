// 階段まわりの壁の3規則（ユーザー指示2026-10-06）を、本番と同じ経路（runFinishEntryBoundary → runFinishExitBoundary。
// resolveStairContext → regenerateWalls → 2a → 隣室壁 → 外壁）で固定する。
//  規則1: 階段設置階Nの上り口の辺に壁を建てない。
//  規則2: 設置階の上階N+1の下り口（直下階の階段の到達辺）に壁を建てない（吹抜け・続きの階段のペア部屋のどちらでも）。
//  規則3: N+1の外壁判定に直下階の階段の足元（STAIR_VOID／ペア部屋）を屋内として参加させる。
// 世界座標は全階共通。壁は線分（軸・始終点）で比べる。peek は階id→graph のスタブ（本番同型）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StairType, StairPortSide, RoomFeature } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from './finishBoundary.js';
import { loadMaterialMap } from './wallRegeneration.js';
import { stairPortEdges } from './stair/stairGeometry.js';

const X = [-3000, 0, 1000, 4000];
const Y = [-3000, 0, 1500, 3000, 6000];
const STAIR_CELLS = [[1, 1], [1, 2]]; // 階段の足元（x 0..1000, y 0..3000。側面の口は先頭／末尾の行が要るので2行）

// 階ごとの通り芯グリッド（per-floor CL。値は全階同一）と、格子セルの鍵を返す。
function addFloor(project, elevation, id) {
  const { graph } = project.addPlane(elevation, id, id);
  const xs = X.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const ys = Y.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH }));
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
  const { cells = STAIR_CELLS, ...rest } = opts;
  const keys = new Set(cells.map(([c, r]) => f.key(c, r)));
  const pair = f.graph.addRoom(new Set(keys), '階段');
  pair.setFeature(RoomFeature.STAIR);
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
async function twoFloors({ lowerStair = {}, upper, withLowerStair = true, third = false }) {
  const project = new Project('proj', 'test');
  const l = addFloor(project, 0, 'p1');
  addRooms(l);
  const stair = withLowerStair ? addStair(l, lowerStair) : null;
  const u = addFloor(project, 3000, 'p2');
  upper(u);
  if (third) { const t = addFloor(project, 6000, 'p3'); addRooms(t, STAIR_CELLS); }
  await exitWalls(project, u.graph);
  return { project, lower: l, upper: u, stair };
}

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

test('規則2【対照】N+1 の自階の階段空間が直下階の足元と重ならないなら、下階の到達辺は開口にしない（屋外階段・無関係の階段の誤開口防止）', async () => {
  // 直下階の足元（x 0..1000）と無関係な位置（east 列）に自階の階段があるだけで、足元は通常の部屋
  const { lower, upper, stair } = await twoFloors({
    upper: (u) => {
      addRooms(u, [[2, 1], [2, 2]]);
      u.graph.addRoom(new Set(STAIR_CELLS.map(([c, r]) => u.key(c, r))), '居室');
      addStair(u, { cells: [[2, 1], [2, 2]], upDirection: 'right' });
    },
  });
  assert.equal(upper.graph.rooms.some(r => r.feature === RoomFeature.STAIR_VOID), false, '前提: 足元は居室（吹抜けにならない）');
  assertWalled(upper.graph, stairPortEdges(stair, lower.graph, ['arrival'])[0], '下階の到達辺（居室の北壁）');
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
