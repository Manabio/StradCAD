// finish/finishExitStamp.js（仕上げ脱出の省略の印）のテスト。
// 入出力（loadFloorFn・generationOf）はメモリ上のスタブ。graph・project は本番のクラスで作り、
// バイト列は本番の serializeGraph で作る。モジュールスコープの状態（カタログ世代・読み替え表）を変える行は
// afterEach で必ず元へ戻す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import {
  Project, CenterLineType, Discipline, OpeningCategory, StairType, StructuralMaterialType,
  HDimensionLine, RoofSpec, RoofShape, ElevatorEquipmentCategory, EvUsage, RoomKind, RoomFeature,
} from '../core.js';
import { serializeGraph, decodeFloorSnapshot } from '../graphSnapshot.js';
import { floorBytesEqual } from '../floorOps.js';
import { overlayGeneration, clearOverlays } from '../catalog/catalogRegistry.js';
import { setDocumentAliases, clearDocumentAliases } from '../catalog/codeNormalization.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { TOKEN_ITEMS, createFinishExitStamps, memberNumberIndexSignature } from './finishExitStamp.js';

test.afterEach(() => { clearOverlays(); clearDocumentAliases(); });

// ---- フィクスチャ ----
const ARCH = { labeled: false, discipline: Discipline.ARCH };

// 1平面ぶんの中身。壁2本・部屋・壁 id を参照する補助線。tag で座標をずらし、平面ごとに内容を変える。
function populate(graph, tag, shift) {
  const mk = (k, type, v, props = ARCH) => graph.addCenterLine(type, v, props, `${tag}-${k}`);
  const x0 = mk('x0', CenterLineType.VERTICAL, shift);
  const x1 = mk('x1', CenterLineType.VERTICAL, shift + 3000);
  const x2 = mk('x2', CenterLineType.VERTICAL, shift + 6000);
  const y0 = mk('y0', CenterLineType.HORIZONTAL, 0);
  const y1 = mk('y1', CenterLineType.HORIZONTAL, 3000);
  const w1 = graph.addWall(y0, 60, false, x0, 10, x1, -10, { isRoomWall: true, wallFinish: 12 }, `${tag}-w1`);
  const w2 = graph.addWall(y1, -60, false, x0, 0, x1, 0, { isExteriorWall: true, wallFinish: 20 }, `${tag}-w2`);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), `${tag}室`, `${tag}-room`);
  room.generatedWallIds.add(w1.id);
  room.generatedWallIds.add(w2.id);
  const aux = mk('aux', CenterLineType.VERTICAL, shift + 1500);
  runInAction(() => graph.setCenterLineExtentRef(aux, 'lo', { wallId: w1.id, offset: 0 }));
  return { x0, x1, x2, y0, y1, w1, w2, room, aux, key };
}

// 脱出が壁を作り直す動きの模倣: 壁を全部、同じ内容・別 id で作り直し、参照（部屋・補助線）も張り替える。
function renewWallIds(graph) {
  runInAction(() => {
    for (const w of [...graph.walls]) {
      const props = {
        discipline: w.discipline, lineWeight: w.lineWeight, lineType: w.lineType, color: w.color,
        isRoomWall: w.isRoomWall, isExteriorWall: w.isExteriorWall, wallFinish: w.wallFinish,
        backingOffset: w.backingOffset, backingDepth: w.backingDepth, finishSide: w.finishSide, bandOffset: w.bandOffset,
      };
      const spec = [w.axisCL, w.axisOffset, w.isVertical, w.clStart, w.startOffset, w.clEnd, w.endOffset];
      graph.removeShape(w.id);
      const nw = graph.addWall(...spec, props, crypto.randomUUID());
      for (const r of graph.rooms) if (r.generatedWallIds.delete(w.id)) r.generatedWallIds.add(nw.id);
      for (const cl of graph.centerLines) {
        for (const side of ['lo', 'hi']) {
          const ref = side === 'lo' ? cl.extentLoRef : cl.extentHiRef;
          if (ref?.wallId === w.id) graph.setCenterLineExtentRef(cl, side, { wallId: nw.id, offset: ref.offset }, null);
        }
      }
    }
  });
}

// 平面 A(1階)・B(2階)・R(屋根専用)・ALT(Aの検討案)。通り芯1本・メモリ上のバイト列ストア・世代・読込みログつき。
function makeWorld() {
  const project = new Project('proj', 'test');
  const parts = {};
  parts.A = project.addPlane(0, '1階', 'A');
  parts.B = project.addPlane(3000, '2階', 'B', 2);
  parts.R = project.addPlane(6000, 'R', 'R', 1, 1, false, null, 0, true, 'B');
  parts.ALT = project.addPlane(0, '1階案', 'ALT', 1, 1, true, 'A', 1);
  const shifts = { A: 0, B: 100, R: 200, ALT: 300 };
  const ctx = {};
  for (const id of Object.keys(parts)) ctx[id] = populate(parts[id].graph, id, shifts[id]);
  const structCL = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT }, 'sx0');

  const store = new Map();
  const gens = new Map();
  const world = {
    project, parts, ctx, structCL, store, gens, loadLog: [], onLoad: null, loadThrows: false, stamps: null,
    graph: (id) => project.graphMap.get(id),
    save(id, bytes) { store.set(id, bytes); gens.set(id, String(Number(gens.get(id) ?? 0) + 1)); },
    savePlane(id) { this.save(id, serializeGraph(this.graph(id))); },
  };
  for (const id of Object.keys(parts)) world.savePlane(id);
  world.stamps = createFinishExitStamps({
    loadFloorFn: async (id) => {
      world.loadLog.push(id);
      if (world.loadThrows) throw new Error('読込み失敗');
      world.onLoad?.(id);
      return store.get(id) ?? null;
    },
    generationOf: (id) => gens.get(id) ?? '0',
  });
  world.takeLog = () => { const l = [...world.loadLog].sort(); world.loadLog.length = 0; return l; };
  return world;
}

const fmodeNow = () => ({ materialOverlayGeneration: overlayGeneration() });

// 全部行う脱出の模倣: begin → 壁 id の付け替え → end → swap（現階の保存）。
async function fullExit(w, id, { fmode = fmodeNow(), regenerated = true, during = null, swap = true } = {}) {
  const graph = w.graph(id);
  const probe = await w.stamps.beginFullExit(graph, w.project, fmode);
  renewWallIds(graph);
  during?.();
  w.stamps.endFullExit(graph, w.project, probe, { regenerated });
  if (swap) w.savePlane(id);
  return probe;
}

const can = (w, id) => w.stamps.canSkip(w.graph(id), w.project);

function silenceConsoleError(t) {
  return t.mock.method(console, 'error', () => {});
}

// ---- 正の場合 ----
test('全部行う脱出（壁 id を付け替える）の直後、無編集なら canSkip は match', async () => {
  const w = makeWorld();
  await fullExit(w, 'A');
  assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' });
});

test('他の平面に同じバイト列を保存して世代だけ進めても省ける（読み直すが版は変わらない）', async () => {
  const w = makeWorld();
  await fullExit(w, 'A');
  w.takeLog();
  w.save('B', w.store.get('B')); // 同じバイト列・世代だけ進む
  assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' });
  assert.deepEqual(w.takeLog(), ['B'], '世代の進んだ B だけ読み直す');
});

test('他の平面に壁 id だけを付け替えたバイト列を保存しても省ける', async () => {
  const w = makeWorld();
  await fullExit(w, 'A');
  const before = w.store.get('B');
  renewWallIds(w.graph('B'));
  w.savePlane('B');
  assert.equal(floorBytesEqual(before, w.store.get('B')), false, '前提: 素のバイト列は違う');
  assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' });
});

test('往復の筋書き: A→B→A→B と省き続け、B を編集すると A は省けない。読み直す平面は世代が進んだものだけ', async () => {
  const w = makeWorld();
  await fullExit(w, 'A');
  assert.deepEqual(w.takeLog(), ['ALT', 'B', 'R'], 'A の begin は他の3平面を読む');
  await fullExit(w, 'B'); // B の壁 id が変わる。swap で A・B を保存した状態
  assert.deepEqual(w.takeLog(), ['A'], 'B の begin: 世代の進んだ A だけ読み直す');
  assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' });
  assert.deepEqual(w.takeLog(), ['B'], 'A の canSkip: 世代の進んだ B だけ（R・ALT は読み直さない）');
  w.savePlane('A'); // A を省いたので swap は同じバイト列を保存
  assert.deepEqual(await can(w, 'B'), { skip: true, reason: 'match' });
  assert.deepEqual(w.takeLog(), ['A']);
  w.savePlane('B');
  assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' });
  assert.deepEqual(await can(w, 'B'), { skip: true, reason: 'match' });
  // B を編集して保存 → A は省けない
  runInAction(() => w.graph('B').setDefaultCeilingHeight(2500));
  w.savePlane('B');
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'otherFloor' });
});

test('endFullExit の token: indexSig は終了時の値を記録する（脱出の間に index が変わっても省ける）', async () => {
  const w = makeWorld();
  await fullExit(w, 'A', { during: () => runInAction(() => w.project.memberNumberIndex.set('g', { counts: new Map([['A', 1]]) })) });
  assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' });
});

// ---- 機械的な網羅1: token の項目 ----
const MUT = (name, reason, apply) => ({ name, reason, apply });
const ceilingChanged = (id) => (w) => {
  runInAction(() => w.graph(id).setDefaultCeilingHeight(2999));
  w.savePlane(id);
};
const TOKEN_MUTATIONS = {
  catalogGen: [MUT('カタログ世代を進める', 'catalog', () => clearOverlays())],
  codeSig: [MUT('材コードの読み替え表を変える', 'codeTable', () => setDocumentAliases('material', { '111111111111': '222222222222' }))],
  structBytes: [
    MUT('通り芯の値', 'struct', (w) => runInAction(() => { w.structCL.value = 500; })),
    MUT('mainStructure', 'struct', (w) => runInAction(() => { w.project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE; })),
    MUT('部材グループ台帳に1件', 'struct', (w) => runInAction(() => w.project.memberGroupLedger.set('grp.no:g1', 'A1'))),
  ],
  planesBytes: [
    MUT('elevation', 'planes', (w) => runInAction(() => { w.parts.B.plane.elevation = 3100; })),
    MUT('平面の追加', 'planes', (w) => w.project.addPlane(9000, '3階', 'C', 3)),
    MUT('平面の削除（検討案）', 'planes', (w) => w.project.removePlane('ALT')),
  ],
  indexSig: [MUT('採番 index の内容', 'memberIndex', (w) => runInAction(() => w.project.memberNumberIndex.set('g', { counts: new Map([['A', 2]]) })))],
  others: [
    MUT('直上階(B)の内容', 'otherFloor', ceilingChanged('B')),
    MUT('屋根専用平面(R)の内容', 'otherFloor', ceilingChanged('R')),
    MUT('検討案(ALT)の内容', 'otherFloor', ceilingChanged('ALT')),
    MUT('他の平面が古い JSON 文字列形式', 'otherFloor', (w) => w.save('B', '{"legacy":true}')),
  ],
};

test('token の表 TOKEN_MUTATIONS のキー集合は TOKEN_ITEMS と一致する（項目を足したら行も足す）', () => {
  assert.deepEqual(Object.keys(TOKEN_MUTATIONS).sort(), [...TOKEN_ITEMS].sort());
});

for (const [item, rows] of Object.entries(TOKEN_MUTATIONS)) {
  assert.ok(rows.length > 0, `${item} の行が空でない`);
  for (const row of rows) {
    test(`token ${item}: ${row.name} → ${row.reason}`, async () => {
      const w = makeWorld();
      await fullExit(w, 'A');
      assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' }, '前提: 変更前は省ける');
      await row.apply(w);
      assert.deepEqual(await can(w, 'A'), { skip: false, reason: row.reason });
    });
  }
}

test('token others: 他の平面が文字列形式（正規化できない）のまま印を取ると、毎回 otherFloor（版が毎回上がる）', async () => {
  const w = makeWorld();
  w.save('B', '{"legacy":true}');
  await fullExit(w, 'A');
  assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' }, '世代が進まなければ読み直さず版も同じ');
  for (let i = 0; i < 3; i++) {
    w.save('B', '{"legacy":true}'); // 内容は同じでも、世代が進むたびに読み直し、版が上がる
    assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'otherFloor' }, `${i}回目`);
  }
});

// ---- 機械的な網羅2: 自階のスナップショットの項目 ----
// 階のスナップショット（decode の戻り）のキーのうち、階の内容でないもの（別チャネルで保存され、graph から
// 直列化されない）。planes・activePlaneId は plane 一覧、site は敷地、structuralInfo・tagRegistryKeys・
// tagRegistryVals は通り芯グラフ（project の token の structBytes）が持つ。階の graph を変えても動かない。
const NOT_FLOOR_SNAPSHOT_KEYS = ['planes', 'activePlaneId', 'site', 'structuralInfo', 'tagRegistryKeys', 'tagRegistryVals'];

// 自階 A に追加する中身（変更行が足したり並べ替えたりできるように、各種を入れておく）。
function enrichSelf(w) {
  const g = w.graph('A');
  const c = w.ctx.A;
  const extra = {};
  extra.room2 = g.addRoom(new Set(['p:q:r:s']), '室2', 'A-room2');
  extra.stairs = [
    g.addStair({ type: StairType.STRAIGHT, cells: new Set([c.key]), upDirection: 'up', flip: false, totalSteps: 12, tread: 250 }, 'A-st1'),
    g.addStair({ type: StairType.STRAIGHT, cells: new Set(['u:v:w:x']), upDirection: 'up', flip: false, totalSteps: 10, tread: 250 }, 'A-st2'),
  ];
  extra.bearing = g.addBearingWall(StructuralMaterialType.RC, 'SEC', c.y0, false, c.x0, c.x1, {});
  extra.slab = g.addSlab(StructuralMaterialType.RC, 'SEC', new Set([c.key]), {});
  g.setColumnAxisOffset(c.x0.id, 15);
  g.addEdge('A-edge');
  return extra;
}

const SELF_MUTATIONS = {
  centerLines: (g) => g.addCenterLine(CenterLineType.VERTICAL, 777, ARCH),
  points: (g) => g.addPoint(1, 2),
  walls: (g, c) => g.addWall(c.y0, 61, false, c.x1, 0, c.x2, 0, {}),
  diagonals: (g) => g.addDiagonalLine(g.addPoint(0, 0), g.addPoint(5, 5), {}),
  verticalLines: (g, c) => g.addVerticalLine(c.x0, c.y0, c.y1, {}),
  horizontalLines: (g, c) => g.addHorizontalLine(c.y0, c.x0, c.x1, {}),
  arcs: (g) => g.addArc(g.addPoint(0, 0), 100, 0, 90, {}),
  circles: (g) => g.addCircle(g.addPoint(0, 0), 100, {}),
  dimensionLines: (g, c) => g.addDimensionLine(HDimensionLine, { anchors: [{ cl: c.x0, offset: 0, coord: 0 }, { cl: c.x1, offset: 0, coord: 3000 }] }),
  rooms: (g) => g.addRoom(new Set(['k:l:m:n']), '新室'),
  roomOrder: (g) => runInAction(() => g.roomOrder.reverse()),
  exteriorWallBacking: (g) => g.setExteriorWallBacking('999999999991'),
  interiorWallBacking: (g) => g.setInteriorWallBacking('999999999992'),
  ceilingBacking: (g) => g.setCeilingBacking('999999999993'),
  floorBacking: (g) => g.setFloorBacking('999999999994'),
  defaultFloorLevel: (g) => g.setDefaultFloorLevel(g.defaultFloorLevel + 5),
  defaultCeilingHeight: (g) => g.setDefaultCeilingHeight(g.defaultCeilingHeight + 5),
  floorDatum: (g) => g.setFloorDatum((g.floorDatum ?? 0) + 5),
  edges: (g) => g.addEdge('A-edge2'),
  openings: (g, c) => g.addOpening(c.y0, 1, false, c.x0, 1000, 900, OpeningCategory.WINDOW, 'doubleSliding', {}),
  structureOverride: (g) => g.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE),
  columns: (g, c) => g.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', c.x0, c.y0, {}),
  beams: (g, c) => g.addBeam(StructuralMaterialType.WOOD, 'SEC-BEAM', c.y0, false, c.x0, c.x1, { role: 'primary' }),
  structuralWalls: (g, c) => g.addBearingWall(StructuralMaterialType.RC, 'SEC2', c.y1, false, c.x0, c.x1, {}),
  wallOpenings: (g, c, e) => g.addWallOpening(e.bearing, 100, 900, {}),
  slabs: (g) => g.addSlab(StructuralMaterialType.RC, 'SEC3', new Set(['a:b:c:d']), {}),
  footings: (g, c) => g.addFooting('independent', 'SEC-F', c.x0, c.y0, {}),
  sleeves: (g, c, e) => g.addSleeve('slab', { hostSlabId: e.slab.id, hostCellKey: c.key, localX: 10, localY: 20 }),
  excludedColumnSlots: (g) => g.excludedColumnSlots.add('slot-a'),
  excludedBeamSlots: (g) => g.excludedBeamSlots.add('slot-b'),
  excludedFootingSlots: (g) => g.excludedFootingSlots.add('slot-c'),
  excludedWallBeamAxes: (g) => g.excludedWallBeamAxes.add('axis-d'),
  columnAxisOffsetKeys: (g, c) => g.setColumnAxisOffset(c.y0.id, 7),
  columnAxisOffsetVals: (g, c) => g.setColumnAxisOffset(c.x0.id, 16),
  stairs: (g) => g.addStair({ type: StairType.STRAIGHT, cells: new Set(['i:j:k:l']), upDirection: 'up', flip: false, totalSteps: 8, tread: 250 }),
  stairOrder: (g) => runInAction(() => g.stairOrder.reverse()),
  exteriorRows: (g) => g.addExteriorRow('exteriorRows', '外壁'),
  exteriorFittingRows: (g) => g.addExteriorRow('exteriorFittingRows', '建具'),
  structureRows: (g) => g.addExteriorRow('structureRows', '構造'),
  clEccentricities: (g, c) => g.setCLEccentricity(c.y0.id, { mode: 'value', value: 30, side: 1, backing: '' }),
  kneeDropWalls: (g) => g.setKneeDropWall('kd1', { knee: { topHeight: 1500 }, drop: null }),
  wallFreshnessKey: (g) => g.setWallFreshnessKey('fk-changed'),
  woodColumnWidthMm: (g) => g.setWoodColumnWidthMm(120),
  shaftWallMaterial: (g) => g.setShaftWallMaterial('999999999995'),
  shaftSoundproof: (g) => g.setShaftSoundproof('insulation'),
  equipmentRows: (g) => g.addEquipmentRow({ id: 'eq1', category: ElevatorEquipmentCategory.EV, usage: EvUsage.PASSENGER_FREIGHT, no: 1, cellKeys: new Set(['a:b:c:d']) }),
  mainRoofSpec: (g) => g.setMainRoofSpec(new RoofSpec({ shape: RoofShape.GABLE, slope: 6 })),
};

test('自階の表 SELF_MUTATIONS のキー集合は、階のスナップショットのキーから階の内容でないものを除いた集合と一致する', async () => {
  const w = makeWorld();
  enrichSelf(w);
  const keys = Object.keys(decodeFloorSnapshot(serializeGraph(w.graph('A'))));
  assert.ok(keys.length > 40, '前提: キーが取れている');
  for (const k of NOT_FLOOR_SNAPSHOT_KEYS) assert.ok(keys.includes(k), `除外リストのキー ${k} はスナップショットに実在する`);
  const floorKeys = keys.filter(k => !NOT_FLOOR_SNAPSHOT_KEYS.includes(k));
  assert.deepEqual(Object.keys(SELF_MUTATIONS).sort(), floorKeys.sort());
});

for (const [key, mutate] of Object.entries(SELF_MUTATIONS)) {
  test(`自階の項目 ${key} を1つ変えると selfChanged`, async () => {
    const w = makeWorld();
    const extra = enrichSelf(w);
    await fullExit(w, 'A');
    assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' }, '前提: 変更前は省ける');
    const before = serializeGraph(w.graph('A'));
    runInAction(() => mutate(w.graph('A'), w.ctx.A, extra));
    assert.equal(floorBytesEqual(serializeGraph(w.graph('A')), before), false, '前提: 直列化に現れる変更になっている');
    assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'selfChanged' });
  });
}

// 実際の編集操作（本番の setter・モデル操作）。
const EDIT_ROWS = {
  '部屋の仕上げ（床材）': (g, c) => c.room.finish.setField('floorMaterial', '000000000001'),
  '部屋の名前': (g, c) => c.room.setName('別名'),
  '部屋の種類': (g, c) => c.room.setKind(RoomKind.EXTERIOR),
  '部屋の特徴': (g, c) => c.room.setFeature(RoomFeature.VOID),
  'CL 偏芯': (g, c) => g.setCLEccentricity(c.y0.id, { mode: 'value', value: 10, side: 1, backing: '' }),
  '腰壁': (g) => g.setKneeDropWall('kd9', { knee: { topHeight: 900 }, drop: null }),
  '垂れ壁': (g) => g.setKneeDropWall('kd9', { knee: null, drop: { bottomHeight: 2000 } }),
  'エッジの上書き': (g) => g.addEdge('e-ov').setOverride('wallMaterial', '000000000002'),
  '外部の行': (g) => g.addExteriorRow('exteriorRows', '外構'),
  '内壁下地材': (g) => g.setInteriorWallBacking('101400000009'),
  '柱寸法': (g) => g.setWoodColumnWidthMm(105),
  '昇降路壁材': (g) => g.setShaftWallMaterial('301000000009'),
  '構造の上書き': (g) => g.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE),
  '自階の CL の値': (g, c) => { c.x2.value = 6100; },
  '建具': (g, c) => g.addOpening(c.y0, 1, false, c.x0, 500, 800, OpeningCategory.DOOR, 'swing', {}),
  '階段': (g, c) => g.addStair({ type: StairType.STRAIGHT, cells: new Set([c.key]), upDirection: 'up', flip: false, totalSteps: 12, tread: 250 }),
};
for (const [name, edit] of Object.entries(EDIT_ROWS)) {
  test(`実際の編集操作「${name}」→ selfChanged`, async () => {
    const w = makeWorld();
    await fullExit(w, 'A');
    assert.equal((await can(w, 'A')).skip, true, '前提: 変更前は省ける');
    runInAction(() => edit(w.graph('A'), w.ctx.A));
    assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'selfChanged' });
  });
}

// ---- 失敗系 ----
test('印なし → noStamp', async () => {
  const w = makeWorld();
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
});

test('屋根専用平面 → roofPlane。begin・end を通しても記録しない', async () => {
  const w = makeWorld();
  assert.deepEqual(await can(w, 'R'), { skip: false, reason: 'roofPlane' });
  await fullExit(w, 'R');
  assert.deepEqual(await can(w, 'R'), { skip: false, reason: 'roofPlane' });
  // 記録されたかは roofPlane 判定に隠れて見えないので、屋根専用でなくして印の有無（noStamp か否か）を見る
  runInAction(() => { w.parts.R.plane.isRoofPlane = false; });
  assert.deepEqual(await can(w, 'R'), { skip: false, reason: 'noStamp' }, '屋根専用平面の脱出は印を記録しない');
});

test('loadFloorFn が throw → canSkip は error（例外は外へ出ない）', async (t) => {
  const spy = silenceConsoleError(t);
  const w = makeWorld();
  await fullExit(w, 'A');
  w.save('B', w.store.get('B')); // B を読み直させる
  w.loadThrows = true;
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'error' });
  assert.ok(spy.mock.callCount() >= 1, '握った例外は console.error に残す');
});

test('読んでいる間に世代が進む → unstable', async () => {
  const w = makeWorld();
  await fullExit(w, 'A');
  w.save('B', w.store.get('B'));
  w.onLoad = (id) => { if (id === 'B') w.gens.set('B', 'moved'); };
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'unstable' });
});

test('beginFullExit の中で例外 → ok:false を返し、投げず、印は記録されない', async (t) => {
  const spy = silenceConsoleError(t);
  const w = makeWorld();
  await fullExit(w, 'A');
  w.save('B', w.store.get('B'));
  w.loadThrows = true;
  const probe = await w.stamps.beginFullExit(w.graph('A'), w.project, fmodeNow());
  assert.deepEqual(probe, { ok: false });
  assert.ok(spy.mock.callCount() >= 1);
  w.loadThrows = false;
  w.stamps.endFullExit(w.graph('A'), w.project, probe, { regenerated: true });
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
});

test('beginFullExit を呼んだだけ（end を呼ばない）→ 以前の印が消えている', async () => {
  const w = makeWorld();
  await fullExit(w, 'A');
  assert.equal((await can(w, 'A')).skip, true, '前提');
  await w.stamps.beginFullExit(w.graph('A'), w.project, fmodeNow());
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
});

test('clear() で全部の印が消える', async () => {
  const w = makeWorld();
  await fullExit(w, 'A');
  w.stamps.clear();
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
});

// endFullExit が記録しない条件（1つずつ）。begin と end の間に起きることを during で与える。
const NO_RECORD_ROWS = {
  'regenerated:false': { opts: { regenerated: false } },
  '脱出の途中で他の平面の世代が進む': { during: (w) => w.save('B', w.store.get('B')) },
  '自階の正規形が前後で違う（部屋名）': { during: (w) => runInAction(() => w.ctx.A.room.setName('変わった')) },
  'fmode の材マスタ世代が今のカタログ世代と違う': { opts: { fmode: () => ({ materialOverlayGeneration: overlayGeneration() - 1 }) } },
  'fmode が null': { opts: { fmode: () => null } },
  '脱出の間にカタログ世代が進む': { during: () => clearOverlays() },
  '脱出の間に structBytes が変わる': { during: (w) => runInAction(() => { w.structCL.value = 123; }) },
  '脱出の間に planesBytes が変わる': { during: (w) => runInAction(() => { w.parts.B.plane.name = '改名'; }) },
  '脱出の間に codeSig が変わる': { during: () => setDocumentAliases('material', { '111111111111': '222222222222' }) },
};
for (const [name, row] of Object.entries(NO_RECORD_ROWS)) {
  test(`記録しない: ${name}`, async () => {
    const w = makeWorld();
    const opts = { ...(row.opts ?? {}) };
    if (typeof opts.fmode === 'function') opts.fmode = opts.fmode();
    await fullExit(w, 'A', { ...opts, during: row.during ? () => row.during(w) : null });
    assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
  });
}

// 直下階キャッシュ（fmode._lowerGraph・lowerGraphGeneration）の新鮮さ
const fmodeWithLower = (w, gen) => ({ materialOverlayGeneration: overlayGeneration(), _lowerGraph: { plane: { id: 'B' } }, lowerGraphGeneration: gen });

test('直下階キャッシュ(a): 突入後（peek 後）に直下階へ書込み（世代が進む）→ 全部行う脱出を無編集で行っても印が付かない', async () => {
  const w = makeWorld();
  const fmode = fmodeWithLower(w, w.gens.get('B'));
  w.save('B', w.store.get('B')); // 直下階の世代だけ進む（内容は同じでも、キャッシュは「古い」）
  await fullExit(w, 'A', { fmode });
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
});

test('直下階キャッシュ(b): 直下階へ書込みが無ければ印が付く', async () => {
  const w = makeWorld();
  await fullExit(w, 'A', { fmode: fmodeWithLower(w, w.gens.get('B')) });
  assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' });
});

test('直下階キャッシュ(c): _lowerGraph が null の fmode（脱出が実 peek する）→ 印が付く', async () => {
  const w = makeWorld();
  await fullExit(w, 'A', { fmode: { materialOverlayGeneration: overlayGeneration(), _lowerGraph: null, lowerGraphGeneration: null } });
  assert.deepEqual(await can(w, 'A'), { skip: true, reason: 'match' });
});

test('直下階キャッシュ(d): lowerGraphGeneration が null（peek 中に書込みがあった）→ 印が付かない', async () => {
  const w = makeWorld();
  await fullExit(w, 'A', { fmode: fmodeWithLower(w, null) });
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
});

test('記録しない: begin の時点で他の平面の版が不安定（others が null）', async () => {
  const w = makeWorld();
  w.save('B', w.store.get('B'));
  const orig = w.gens.get('B');
  w.onLoad = (id) => { if (id === 'B') w.gens.set('B', 'moved'); };
  // 脱出の間に世代を元へ戻す（end の世代比較では見つからない状況にして、others===null の条件だけを効かせる）
  const probe = await fullExit(w, 'A', { during: () => w.gens.set('B', orig) });
  assert.equal(probe.ok, true);
  assert.equal(probe.others, null);
  w.onLoad = null;
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
});

test('記録しない: probe が undefined・ok:false でも例外にならない', async () => {
  const w = makeWorld();
  w.stamps.endFullExit(w.graph('A'), w.project, undefined, { regenerated: true });
  w.stamps.endFullExit(w.graph('A'), w.project, { ok: false }, { regenerated: true });
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
});

test('記録しない: ok:false の probe は、他の中身が揃っていても記録しない（例外で偶然止まるのではなく明示の条件）', async (t) => {
  const spy = silenceConsoleError(t);
  const w = makeWorld();
  const probe = await w.stamps.beginFullExit(w.graph('A'), w.project, fmodeNow());
  assert.equal(probe.ok, true);
  w.stamps.endFullExit(w.graph('A'), w.project, { ...probe, ok: false }, { regenerated: true });
  assert.deepEqual(await can(w, 'A'), { skip: false, reason: 'noStamp' });
  assert.equal(spy.mock.callCount(), 0, '例外を握って止まったのではない');
});

test('生成時に loadFloorFn・generationOf を省くと例外', () => {
  assert.throws(() => createFinishExitStamps({ generationOf: () => '0' }), /loadFloorFn/);
  assert.throws(() => createFinishExitStamps({ loadFloorFn: async () => null }), /generationOf/);
  assert.throws(() => createFinishExitStamps({ loadFloorFn: 1, generationOf: () => '0' }), /loadFloorFn/);
  assert.throws(() => createFinishExitStamps(), /loadFloorFn/);
});

// ---- memberNumberIndexSignature ----
test('memberNumberIndexSignature: 内容が同じで挿入順だけ違う index は同じ署名、内容が違えば違う署名', () => {
  const entry = (n, ranks, counts) => ({ mapName: 'columnMap', symbol: 'C', sizeKey: 's', signature: 'sig', orderKey: [1, n], individual: false, hasRoof: false, floorRanks: new Set(ranks), counts: new Map(counts) });
  const a = new Map([['k1', entry(1, [0, 1], [['A', 2], ['B', 3]])], ['k2', entry(2, [1], [['B', 1]])]]);
  const b = new Map([['k2', entry(2, [1], [['B', 1]])], ['k1', entry(1, [1, 0], [['B', 3], ['A', 2]])]]);
  assert.ok(a.size > 0);
  assert.equal(JSON.stringify([...a]) === JSON.stringify([...b]), false, '前提: 素朴な JSON 化は挿入順に左右される');
  assert.equal(memberNumberIndexSignature(a), memberNumberIndexSignature(b));
  const c = new Map(a);
  c.get('k1').counts.set('A', 9);
  assert.notEqual(memberNumberIndexSignature(c), memberNumberIndexSignature(b));
  const d = new Map(b);
  d.delete('k2');
  assert.notEqual(memberNumberIndexSignature(d), memberNumberIndexSignature(b));
});

test('memberNumberIndexSignature: MobX の observable.map（本番の project.memberNumberIndex）でも挿入順に左右されない', () => {
  const p1 = new Project('a', 'a');
  const p2 = new Project('b', 'b');
  const e = (n) => ({ mapName: 'beamMap', symbol: 'G', floorRanks: new Set([n]), counts: new Map([['A', n]]) });
  runInAction(() => { p1.memberNumberIndex.set('x', e(1)); p1.memberNumberIndex.set('y', e(2)); });
  runInAction(() => { p2.memberNumberIndex.set('y', e(2)); p2.memberNumberIndex.set('x', e(1)); });
  assert.equal(p1.memberNumberIndex.size, 2);
  assert.equal(memberNumberIndexSignature(p1.memberNumberIndex), memberNumberIndexSignature(p2.memberNumberIndex));
  runInAction(() => p2.memberNumberIndex.get('x').counts.set('A', 5));
  assert.notEqual(memberNumberIndexSignature(p1.memberNumberIndex), memberNumberIndexSignature(p2.memberNumberIndex));
});

// ---- 純モジュールの不変条件（node:test から単体 import でき、禁止のモジュールを直接は import しない。
// floorOps.js 経由で storage/db.js を引く既存の依存は在る） ----
test('【不変条件】finishExitStamp.js は react・store.js・snap.js・.jsx・modes/・storage/db.js・FloorSwapManager を直接は静的 import しない（許可した4つだけ）', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'finishExitStamp.js'), 'utf8');
  const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.ok(specs.length >= 4, '前提: import が取れている');
  assert.deepEqual([...specs].sort(), [
    '../catalog/catalogRegistry.js', '../catalog/codeNormalization.js', '../floorOps.js', '../graphSnapshot.js',
  ].sort());
  for (const s of specs) {
    assert.ok(!/react|store\.js|snap\.js|\.jsx|\/modes\/|storage\/db\.js|FloorSwapManager/.test(s), `禁止の import: ${s}`);
  }
  assert.ok(!/^\s*import\s*\(|\brequire\(/m.test(src), '動的 import・require も持たない');
});
