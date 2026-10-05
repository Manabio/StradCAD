// serializeGraphCanonicalWalls（壁 id の付け替えに左右されない比較用の直列化）のテスト。
// 仕上げ脱出は壁を全削除→再生成するため内容が同じでも壁 id が毎回変わる。その差だけを無視し、
// 壁の内容・壁以外の内容・壁 id の参照先の取り違えは見逃さないことを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, OpeningCategory, StairType, StructuralMaterialType,
} from './core.js';
import { serializeGraph, serializeGraphCanonicalWalls, canonicalizeFloorBytes, decodeFloorSnapshot } from './graphSnapshot.js';
import { findLineIdOccurrences } from './lineIdRemap.js';
import { floorBytesEqual } from './floorOps.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from './finish/finishBoundary.js';
import { loadMaterialMap } from './finish/wallRegeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structural/structureRules.js';
import { cellsBeyondBreak } from './finish/stair/stairGeometry.js';

// ---- 合成フィクスチャ ----
// CL: 垂直 x0/x1/x2、水平 y0/y1。壁は spec で与える（id は省略で既定の UUID）。
const BASE_WALL = Object.freeze({
  axis: 'y0', axisOffset: 60, isVertical: false, start: 'x0', startOffset: 10, end: 'x1', endOffset: -10,
  props: Object.freeze({
    discipline: Discipline.ARCH, lineWeight: 0.35, lineType: 'solid', color: '#000000',
    isRoomWall: true, isExteriorWall: false, wallFinish: 12, backingOffset: 5, backingDepth: 90,
    finishSide: 1, bandOffset: 3,
  }),
});
const OTHER_WALL = Object.freeze({
  axis: 'y1', axisOffset: -60, isVertical: false, start: 'x0', startOffset: 0, end: 'x1', endOffset: 0,
  props: Object.freeze({ isRoomWall: false, isExteriorWall: true, wallFinish: 20, backingDepth: 105 }),
});

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

function addCLs(graph) {
  const mk = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  return {
    x0: mk(CenterLineType.VERTICAL, 0), x1: mk(CenterLineType.VERTICAL, 3000), x2: mk(CenterLineType.VERTICAL, 6000),
    y0: mk(CenterLineType.HORIZONTAL, 0), y1: mk(CenterLineType.HORIZONTAL, 3000),
  };
}

function addWallBySpec(graph, cls, spec, id) {
  return graph.addWall(cls[spec.axis], spec.axisOffset, spec.isVertical, cls[spec.start], spec.startOffset,
    cls[spec.end], spec.endOffset, { ...spec.props }, id);
}

// specs の順に壁を足した graph と、追加した壁・CL を返す。ids を渡すと壁 id を指定できる。
function makeWallGraph(specs, ids = []) {
  const graph = makeGraph();
  const cls = addCLs(graph);
  const walls = specs.map((s, i) => addWallBySpec(graph, cls, s, ids[i]));
  return { graph, cls, walls };
}

// ---- 壁 id の参照箇所（A）の列挙。壁・部屋・CL の extent 参照を全部持つ graph ----
function makeReferencingGraph({ swapRooms = false, extentTarget = 0 } = {}) {
  const { graph, cls, walls } = makeWallGraph([BASE_WALL, OTHER_WALL]);
  const roomA = graph.addRoom(new Set([`${cls.x0.id}:${cls.y0.id}:${cls.x1.id}:${cls.y1.id}`]), '部屋A');
  const roomB = graph.addRoom(new Set([`${cls.x1.id}:${cls.y0.id}:${cls.x2.id}:${cls.y1.id}`]), '部屋B');
  roomA.generatedWallIds.add(walls[swapRooms ? 1 : 0].id);
  roomB.generatedWallIds.add(walls[swapRooms ? 0 : 1].id);
  // 壁を端の参照にした補助線（centerLines[].extentLoRef.wallId）
  const aux = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  runInAction(() => graph.setCenterLineExtentRef(aux, 'lo', { wallId: walls[extentTarget].id, offset: 0 }));
  return { graph, cls, walls, roomA, roomB, aux };
}

// ---- B-1: 並び順と id だけが違う ----
test('壁の並び順と id だけが違う2つの graph はバイト列が一致する（素の serializeGraph は一致しない）', () => {
  const g1 = makeFixedCLGraph([BASE_WALL, OTHER_WALL]);
  const g2 = makeFixedCLGraph([OTHER_WALL, BASE_WALL]);
  assert.equal(g1.walls.length, 2);
  assert.equal(floorBytesEqual(serializeGraph(g1), serializeGraph(g2)), false, '前提: 素の直列化は壁の順・id で食い違う');
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(g1), serializeGraphCanonicalWalls(g2)), true, '比較用は一致する');
});

// ---- B-2: 壁の内容が1箇所違えば不一致（表駆動。表は壁のフィールド全部を網羅する） ----
// CL の id は graph ごとに異なるため、CL id を固定した2つの graph を作って比べる。
function makeFixedCLGraph(specs) {
  const ids = { x0: 'cl-x0', x1: 'cl-x1', x2: 'cl-x2', y0: 'cl-y0', y1: 'cl-y1' };
  const graph = makeGraph();
  const mk = (k, type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH }, ids[k]);
  const cls = {
    x0: mk('x0', CenterLineType.VERTICAL, 0), x1: mk('x1', CenterLineType.VERTICAL, 3000), x2: mk('x2', CenterLineType.VERTICAL, 6000),
    y0: mk('y0', CenterLineType.HORIZONTAL, 0), y1: mk('y1', CenterLineType.HORIZONTAL, 3000),
  };
  specs.forEach(s => addWallBySpec(graph, cls, s));
  return graph;
}

const WALL_FIELD_ROWS = {
  axisCLId:       { axis: 'y1' },
  axisOffset:     { axisOffset: 61 },
  isVertical:     { isVertical: true, axis: 'x0', start: 'y0', end: 'y1' },
  clStartId:      { start: 'x2' },
  startOffset:    { startOffset: 11 },
  clEndId:        { end: 'x2' },
  endOffset:      { endOffset: -11 },
  isRoomWall:     { props: { isRoomWall: false } },
  isExteriorWall: { props: { isExteriorWall: true } },
  wallFinish:     { props: { wallFinish: 13 } },
  backingOffset:  { props: { backingOffset: 6 } },
  backingDepth:   { props: { backingDepth: 91 } },
  finishSide:     { props: { finishSide: -1 } },
  bandOffset:     { props: { bandOffset: 4 } },
  discipline:     { props: { discipline: Discipline.FUSE } },
  lineWeight:     { props: { lineWeight: 0.5 } },
  lineType:       { props: { lineType: 'dashed' } },
  color:          { props: { color: '#ff0000' } },
};

test('壁のフィールド表は decode した壁のキー集合（id を除く）と突き合う（フィールドを足したら行も足す）', () => {
  const graph = makeFixedCLGraph([BASE_WALL]);
  const decoded = decodeFloorSnapshot(serializeGraph(graph)).walls[0];
  const keys = Object.keys(decoded).filter(k => k !== 'id').sort();
  assert.deepEqual(Object.keys(WALL_FIELD_ROWS).sort(), keys);
});

for (const [field, patch] of Object.entries(WALL_FIELD_ROWS)) {
  test(`壁の内容が1フィールド違えば不一致: ${field}`, () => {
    const base = makeFixedCLGraph([BASE_WALL, OTHER_WALL]);
    const changed = { ...BASE_WALL, ...patch, props: { ...BASE_WALL.props, ...(patch.props ?? {}) } };
    const other = makeFixedCLGraph([changed, OTHER_WALL]);
    assert.equal(floorBytesEqual(serializeGraph(base), serializeGraph(other)), false, '前提: 素の直列化も違う');
    assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(base), serializeGraphCanonicalWalls(other)), false);
  });
}

test('壁の内容が1フィールドだけ違う2本は、追加順を逆にしても比較用が一致する（フィールド表の全行）', () => {
  let ran = 0;
  for (const [field, patch] of Object.entries(WALL_FIELD_ROWS)) {
    const changed = { ...BASE_WALL, ...patch, props: { ...BASE_WALL.props, ...(patch.props ?? {}) } };
    const g1 = makeFixedCLGraph([BASE_WALL, changed]);
    const g2 = makeFixedCLGraph([changed, BASE_WALL]);
    assert.equal(g1.walls.length, 2, field);
    assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(g1), serializeGraphCanonicalWalls(g2)), true, `追加順を逆にしても一致: ${field}`);
    ran++;
  }
  assert.equal(ran, Object.keys(WALL_FIELD_ROWS).length, '表の全行を回した');
});

test('generatedWallIds に存在しない壁 id が残っていても例外にならず、決定的（2回の直列化が一致）', () => {
  const graph = makeFixedCLGraph([BASE_WALL, OTHER_WALL]);
  const room = graph.addRoom(new Set(['c']), 'R', 'room-r');
  room.generatedWallIds.add(graph.walls[0].id);
  room.generatedWallIds.add('stale-wall-id-not-in-graph');
  let a; let b;
  assert.doesNotThrow(() => { a = serializeGraphCanonicalWalls(graph); b = serializeGraphCanonicalWalls(graph); });
  assert.equal(floorBytesEqual(a, b), true);
});

// ---- B-3: 壁 id の参照箇所 ----
test('壁 id の出現箇所は walls[].id・rooms[].generatedWallIds・centerLines[].extentLoRef.wallId だけ（建具 wallOpenings.wallId は構造壁）', () => {
  const { graph, cls, walls } = makeReferencingGraph();
  // 構造壁とその開口（wallOpenings.wallId は StructuralWall の id。仕上げの壁 id ではない）
  const sw = graph.addBearingWall(StructuralMaterialType.RC, 'sec', cls.y0, false, cls.x0, cls.x1, {});
  graph.addWallOpening(sw, 100, 900, {});
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  const occ = findLineIdOccurrences(snap, walls.map(w => w.id));
  const paths = occ.map(o => o.path.replace(/\[\d+\]/g, '[]')).sort();
  assert.deepEqual([...new Set(paths)].sort(), [
    'centerLines[].extentLoRef.wallId', 'rooms[].generatedWallIds[]', 'walls[].id',
  ]);
  assert.equal(findLineIdOccurrences(snap, [sw.id]).some(o => o.path.startsWith('wallOpenings')), true, '前提: 構造壁の id は wallOpenings に出る');
  assert.equal(occ.some(o => o.path.startsWith('wallOpenings')), false, '仕上げの壁 id は wallOpenings に出ない');
});

test('同じ参照関係なら壁 id が違っても一致する（generatedWallIds・extentLoRef.wallId を含む）', () => {
  const a = makeReferencingGraph();
  // 同一 graph の壁を別 id で作り直し（参照も張り替え）、前後の比較用バイト列を比べる
  const ids = new Map();
  for (const w of a.walls) ids.set(w.id, crypto.randomUUID());
  const before = serializeGraphCanonicalWalls(a.graph);
  assert.equal(a.aux.extentLoRef.wallId, a.walls[0].id, '前提: 補助線は壁を端の参照にしている');
  runInAction(() => {
    for (const w of [...a.walls]) {
      const snapW = { axisCL: w.axisCL, axisOffset: w.axisOffset, isVertical: w.isVertical, clStart: w.clStart,
        startOffset: w.startOffset, clEnd: w.clEnd, endOffset: w.endOffset };
      const props = { discipline: w.discipline, lineWeight: w.lineWeight, lineType: w.lineType, color: w.color,
        isRoomWall: w.isRoomWall, isExteriorWall: w.isExteriorWall, wallFinish: w.wallFinish,
        backingOffset: w.backingOffset, backingDepth: w.backingDepth, finishSide: w.finishSide, bandOffset: w.bandOffset };
      a.graph.removeShape(w.id);
      const nw = a.graph.addWall(snapW.axisCL, snapW.axisOffset, snapW.isVertical, snapW.clStart, snapW.startOffset,
        snapW.clEnd, snapW.endOffset, props, ids.get(w.id));
      for (const r of [a.roomA, a.roomB]) {
        if (r.generatedWallIds.delete(w.id)) r.generatedWallIds.add(nw.id);
      }
      for (const side of ['lo', 'hi']) {
        const ref = side === 'lo' ? a.aux.extentLoRef : a.aux.extentHiRef;
        if (ref?.wallId === w.id) a.graph.setCenterLineExtentRef(a.aux, side, { wallId: nw.id, offset: ref.offset }, null);
      }
    }
  });
  const after = serializeGraphCanonicalWalls(a.graph);
  assert.equal(a.walls.every(w => !a.graph.shapeMap.has(w.id)), true, '前提: 旧 id の壁は消えた');
  assert.equal(a.aux.extentLoRef.wallId, ids.get(a.walls[0].id), '前提: 補助線の参照は新 id へ張り替わった');
  assert.equal(floorBytesEqual(before, after), true);
});

test('2つの部屋の generatedWallIds の参照先を取り違えると不一致', () => {
  // CL id を揃えるため同一 graph の部屋の中身だけ入れ替える
  const { graph, walls, roomA, roomB } = makeReferencingGraph();
  const before = serializeGraphCanonicalWalls(graph);
  const plainBefore = serializeGraph(graph);
  runInAction(() => {
    roomA.generatedWallIds.clear(); roomA.generatedWallIds.add(walls[1].id);
    roomB.generatedWallIds.clear(); roomB.generatedWallIds.add(walls[0].id);
  });
  assert.equal(floorBytesEqual(serializeGraph(graph), plainBefore), false, '前提: 素の直列化も変わる');
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(graph), before), false);
});

test('CL の extentLoRef.wallId の参照先が別の壁へ変わると不一致', () => {
  const { graph, walls, aux } = makeReferencingGraph({ extentTarget: 0 });
  const before = serializeGraphCanonicalWalls(graph);
  runInAction(() => graph.setCenterLineExtentRef(aux, 'lo', { wallId: walls[1].id, offset: 0 }));
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(graph), before), false);
});

// ---- B-4: 壁以外の変更は素の直列化と同じ感度で不一致になる ----
function makeRichGraph(o = {}) {
  const graph = makeGraph();
  const ids = { x0: 'cl-x0', x1: 'cl-x1', y0: 'cl-y0', y1: 'cl-y1' };
  const mk = (k, type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH }, ids[k]);
  const cls = {
    x0: mk('x0', CenterLineType.VERTICAL, 0), x1: mk('x1', CenterLineType.VERTICAL, o.clValue ?? 3000),
    y0: mk('y0', CenterLineType.HORIZONTAL, 0), y1: mk('y1', CenterLineType.HORIZONTAL, 3000),
  };
  const cellKey = `${cls.x0.id}:${cls.y0.id}:${cls.x1.id}:${cls.y1.id}`;
  const room = graph.addRoom(new Set([cellKey]), o.roomName ?? '部屋', 'room-1');
  if (o.floorMaterial) room.finish.setField('floorMaterial', o.floorMaterial);
  graph.addWall(cls.y0, 60, false, cls.x0, 0, cls.x1, 0, { isRoomWall: true }, 'wall-fixed');
  room.generatedWallIds.add('wall-fixed');
  graph.addOpening(cls.y0, 1, false, cls.x0, 1000, o.openingWidth ?? 1690, OpeningCategory.WINDOW, 'doubleSliding', {}, 'op-1');
  if (o.edge) graph.addEdge(o.edge, null, null);
  if (o.ecc != null) graph.setCLEccentricity(cls.y0.id, { mode: 'value', value: o.ecc, side: 1, backing: '' });
  if (o.knee != null) graph.setKneeDropWall('k1', { knee: { topHeight: o.knee }, drop: null });
  graph.addStair({
    type: StairType.STRAIGHT, cells: new Set([cellKey]), upDirection: 'up', flip: false,
    totalSteps: o.totalSteps ?? 12, tread: 250,
  }, 'stair-1');
  graph.setDefaultCeilingHeight(o.ceiling ?? 2400);
  return graph;
}

test('壁以外の1箇所の違い（部屋名・仕上げ・建具・エッジ・偏芯・腰壁・階段・CL・天井高）は不一致（素の直列化と同じ感度）', () => {
  const base = makeRichGraph();
  const rows = {
    roomName: { roomName: '別名' },
    floorMaterial: { floorMaterial: '000000000001' },
    openingWidth: { openingWidth: 1200 },
    edge: { edge: 'e1' },
    ecc: { ecc: 10 },
    knee: { knee: 900 },
    totalSteps: { totalSteps: 13 },
    clValue: { clValue: 3100 },
    ceiling: { ceiling: 2500 },
  };
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(base), serializeGraphCanonicalWalls(makeRichGraph())), true, '前提: 同じ入力は一致');
  for (const [name, o] of Object.entries(rows)) {
    const g = makeRichGraph(o);
    assert.equal(floorBytesEqual(serializeGraph(base), serializeGraph(g)), false, `前提(素): ${name}`);
    assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(base), serializeGraphCanonicalWalls(g)), false, name);
  }
});

// ---- 内容が同じ壁（同一内容の2本）の扱い ----
test('同内容の壁2本: 参照が無ければ id の入れ替えで不変。別々の部屋が1本ずつ指すと入れ替えで不一致（一意でない割当・安全側）', () => {
  const mk = (ids, refs) => {
    const graph = makeGraph();
    const cls = {};
    [['x0', CenterLineType.VERTICAL, 0], ['x1', CenterLineType.VERTICAL, 3000], ['y0', CenterLineType.HORIZONTAL, 0]]
      .forEach(([k, t, v]) => { cls[k] = graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH }, `cl-${k}`); });
    const w = ids.map(id => addWallBySpec(graph, cls, BASE_WALL, id));
    const ra = graph.addRoom(new Set(['a']), 'A', 'ra');
    const rb = graph.addRoom(new Set(['b']), 'B', 'rb');
    if (refs) { ra.generatedWallIds.add(w[refs[0]].id); rb.generatedWallIds.add(w[refs[1]].id); }
    return graph;
  };
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(mk(['aaaa-1', 'bbbb-2'], null)), serializeGraphCanonicalWalls(mk(['bbbb-2', 'aaaa-1'], null))), true);
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(mk(['aaaa-1', 'bbbb-2'], [0, 1])), serializeGraphCanonicalWalls(mk(['aaaa-1', 'bbbb-2'], [1, 0]))), false);
});

test('部屋の generatedWallIds は並び順に依存しない（同じ壁の集合なら追加順が違っても一致する）', () => {
  const mk = (order) => {
    const graph = makeFixedCLGraph([BASE_WALL, OTHER_WALL]);
    const room = graph.addRoom(new Set(['c']), 'R', 'room-r');
    const [w0, w1] = graph.walls;
    for (const i of order) room.generatedWallIds.add([w0, w1][i].id);
    return graph;
  };
  const g1 = mk([0, 1]);
  const g2 = mk([1, 0]);
  assert.equal(g1.walls.length, 2);
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(g1), serializeGraphCanonicalWalls(g2)), true);
  // 集合そのものが違えば不一致
  const g3 = makeFixedCLGraph([BASE_WALL, OTHER_WALL]);
  g3.addRoom(new Set(['c']), 'R', 'room-r').generatedWallIds.add(g3.walls[0].id);
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(g1), serializeGraphCanonicalWalls(g3)), false);
});

// ---- graph を変更しない ----
test('serializeGraphCanonicalWalls は graph を変更しない（呼び出し前後で serializeGraph が同じ・壁 id も不変）', () => {
  const { graph, walls } = makeReferencingGraph();
  const before = serializeGraph(graph);
  const idsBefore = graph.walls.map(w => w.id);
  serializeGraphCanonicalWalls(graph);
  assert.equal(floorBytesEqual(serializeGraph(graph), before), true);
  assert.deepEqual(graph.walls.map(w => w.id), idsBefore);
  assert.equal(walls.every(w => graph.shapeMap.has(w.id)), true);
});

test('壁が0本の graph でも例外なく、同じ graph に対して決定的', () => {
  const graph = makeGraph();
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(graph), serializeGraphCanonicalWalls(graph)), true);
});

// ---- 本番経路での固定: 実際の脱出境界を無編集で続けて回す ----
function makeSinglePlaneProject() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

async function makeTwoRoomFixture() {
  const { project, graph } = makeSinglePlaneProject();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`]), '部屋A');
  graph.addRoom(new Set([`${x0.id}:${ym.id}:${x1.id}:${y1.id}`]), '部屋B');
  await runFinishEntryBoundary(graph, project);
  const materialMap = await loadMaterialMap();
  return { project, graph, fmode: { materialMap, stairUnderRooms: () => [] } };
}

async function makeStairUnder2aFixture() {
  const { project, graph } = makeSinglePlaneProject();
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([landingKey, outboundKey]), '階段');
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells: new Set([landingKey, outboundKey, returnKey]), roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  const under = graph.addRoom(new Set(cellsBeyondBreak(stair, graph, stair.riser ?? null)), '階段下');
  const materialMap = await loadMaterialMap();
  return { project, graph, fmode: { materialMap, stairUnderRooms: () => [{ stair, room: under, splitCLIds: new Set() }] } };
}

for (const [label, makeFixture] of [['2部屋', makeTwoRoomFixture], ['階段下(2a)＋階段', makeStairUnder2aFixture]]) {
  test(`【本番経路】${label}: 無編集の脱出を続けて回すと、素の直列化は壁 id で食い違い、比較用は一致する`, async () => {
    const { project, graph, fmode } = await makeFixture();
    await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
    assert.ok(graph.walls.length > 0, '前提: 壁が生成されている');
    assert.ok(graph.wallFreshnessKey, '前提: 壁再生成が走った（鮮度キーが書かれた）');
    const wallIds1 = graph.walls.map(w => w.id);
    const plain1 = serializeGraph(graph);
    const canon1 = serializeGraphCanonicalWalls(graph);

    await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
    const wallIds2 = graph.walls.map(w => w.id);
    assert.equal(wallIds2.some(id => wallIds1.includes(id)), false, '前提: 壁は全部作り直され、id は1本も残らない');
    assert.equal(graph.walls.length, wallIds1.length, '壁の本数は不変');
    assert.equal(floorBytesEqual(serializeGraph(graph), plain1), false, '素の直列化は壁 id で食い違う');
    assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(graph), canon1), true, '比較用は一致する');

    await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
    assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(graph), canon1), true, '3回目も一致する');
  });
}

// ---- canonicalizeFloorBytes（他の平面の比較用。並べ替えず、壁 id だけを位置で w0..wn へ振る） ----
test('canonicalizeFloorBytes: null・undefined・長さ0は空の Uint8Array、ArrayBuffer は Uint8Array と同じ、文字列は null（不明）', () => {
  for (const v of [null, undefined, new Uint8Array(0), new ArrayBuffer(0)]) {
    const r = canonicalizeFloorBytes(v);
    assert.ok(r instanceof Uint8Array);
    assert.equal(r.length, 0);
  }
  const bytes = serializeGraph(makeFixedCLGraph([BASE_WALL, OTHER_WALL]));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  assert.equal(floorBytesEqual(canonicalizeFloorBytes(ab), canonicalizeFloorBytes(bytes)), true);
  assert.equal(canonicalizeFloorBytes('{"legacy":"json"}'), null);
  assert.equal(canonicalizeFloorBytes(''), null);
});

test('canonicalizeFloorBytes: 壁 id だけを付け替えた2つのバイト列は一致する（素のバイト列は不一致）', () => {
  const a = serializeGraph(makeFixedCLGraph([BASE_WALL, OTHER_WALL]));
  const b = serializeGraph(makeFixedCLGraph([BASE_WALL, OTHER_WALL]));
  assert.equal(floorBytesEqual(a, b), false, '前提: 素のバイト列は壁 id で食い違う');
  assert.equal(floorBytesEqual(canonicalizeFloorBytes(a), canonicalizeFloorBytes(b)), true);
});

test('canonicalizeFloorBytes: 壁の並び順だけを入れ替えると不一致（位置で振る）。serializeGraphCanonicalWalls は一致（対照）', () => {
  const g1 = makeFixedCLGraph([BASE_WALL, OTHER_WALL]);
  const g2 = makeFixedCLGraph([OTHER_WALL, BASE_WALL]);
  assert.equal(floorBytesEqual(serializeGraphCanonicalWalls(g1), serializeGraphCanonicalWalls(g2)), true, '対照: 並べ替える方は一致');
  assert.equal(floorBytesEqual(canonicalizeFloorBytes(serializeGraph(g1)), canonicalizeFloorBytes(serializeGraph(g2))), false);
});

test('canonicalizeFloorBytes: 壁の内容を1つ変えると不一致', () => {
  const a = serializeGraph(makeFixedCLGraph([BASE_WALL, OTHER_WALL]));
  const changed = { ...BASE_WALL, props: { ...BASE_WALL.props, wallFinish: 13 } };
  const b = serializeGraph(makeFixedCLGraph([changed, OTHER_WALL]));
  assert.equal(floorBytesEqual(canonicalizeFloorBytes(a), canonicalizeFloorBytes(b)), false);
});

test('canonicalizeFloorBytes: walls[].id・generatedWallIds・extentLoRef.wallId が w0.. へ置換され、旧 id は残らない', () => {
  const { graph, walls } = makeReferencingGraph();
  const oldIds = walls.map(w => w.id);
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  assert.ok(findLineIdOccurrences(snap, oldIds).length >= 4, '前提: 旧 id が3種の箇所に出ている');
  const out = decodeFloorSnapshot(canonicalizeFloorBytes(serializeGraph(graph)));
  assert.equal(findLineIdOccurrences(out, oldIds).length, 0, '旧 id が残っていない');
  assert.deepEqual(out.walls.map(w => w.id), ['w0', 'w1']);
  const gen = out.rooms.flatMap(r => r.generatedWallIds).sort();
  assert.deepEqual(gen, ['w0', 'w1']);
  const aux = out.centerLines.find(c => c.extentLoRef?.wallId);
  assert.ok(aux, '前提: 端の参照を持つ補助線がある');
  assert.equal(aux.extentLoRef.wallId, 'w0');
});

test('canonicalizeFloorBytes: 決定的（2回同じ）で、壁 id 以外の内容は保たれ、入力のバイト列は変えない', () => {
  const graph = makeRichGraph();
  const bytes = serializeGraph(graph);
  const copy = bytes.slice();
  const c1 = canonicalizeFloorBytes(bytes);
  const c2 = canonicalizeFloorBytes(bytes);
  assert.equal(floorBytesEqual(c1, c2), true);
  assert.equal(floorBytesEqual(bytes, copy), true, '入力は不変');
  assert.equal(floorBytesEqual(canonicalizeFloorBytes(c1), c1), true, '冪等');
  const drop = new Set(['walls', 'generatedWallIds', 'extentLoRef', 'extentHiRef']);
  const strip = (b) => JSON.stringify(decodeFloorSnapshot(b), (k, v) => (drop.has(k) ? undefined : (typeof v === 'bigint' ? String(v) : v)));
  const kept = strip(bytes);
  assert.ok(kept.length > 500, '前提: 壁以外の中身がある');
  assert.equal(strip(c1), kept);
  const wallsNoId = (b) => JSON.stringify(decodeFloorSnapshot(b).walls.map(w => { const c = { ...w }; delete c.id; return c; }));
  assert.equal(wallsNoId(c1), wallsNoId(bytes), '壁の id 以外の内容・並びは同じ');
});

test('canonicalizeFloorBytes: 壁が0本のバイト列でも例外にならず決定的', () => {
  const bytes = serializeGraph(makeGraph());
  assert.equal(floorBytesEqual(canonicalizeFloorBytes(bytes), canonicalizeFloorBytes(bytes)), true);
});
