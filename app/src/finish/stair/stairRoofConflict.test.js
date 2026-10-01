// finish/stair/stairRoofConflict.js（階段の指定の事前チェックの純関数）と、その呼び出し口
// finish/stair/stairFloorSync.js findStairUpperRoofRejection の単体テスト。
//
// 規約: peek のスタブは本番同型（保存バイト列から PlanGraph を復元する makeStorePeek。生きたグラフを
// 返さない）。他階へ書かない・変更が1つも起きないことは、保存データを復号して比べる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Project, CenterLineType, Discipline, RoomFeature, RoomKind } from '../../core.js';
import { worldToCell, refreshCells, cellBoundsFromKey } from '../gridCells.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { undoManager } from '../../undoManager.js';
import { FinishModeState } from '../../modes/FinishModeState.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../equipment/equipmentTestFixtures.js';
import { floorHeightAbove } from './stairDimensions.js';
import { findStairUpperRoofConflicts } from './stairRoofConflict.js';
import { findStairUpperRoofRejection, syncUpperFloors } from './stairFloorSync.js';
import { ERR_STAIR_UPPER_ROOF } from '../../error.js';

// X:[0,1000,2000] Y:[0,1000]（全階共通の通り芯）。left=[0,1000]x[0,1000]・right=[1000,2000]x[0,1000]。
function setupProject(floorCount) {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   1000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   2000, grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1000, grid);
  const graphs = [];
  for (let i = 0; i < floorCount; i++) {
    const { graph } = project.addPlane(i * 3000, `${i + 1}階`, `p${i + 1}`);
    graphs.push(graph);
  }
  return { project, graphs };
}
const leftKey  = (g) => worldToCell(500, 500, g).key;
const rightKey = (g) => worldToCell(1500, 500, g).key;
const addPerFloorV = (g, x) => g.addCenterLine(CenterLineType.VERTICAL, x, { labeled: false, discipline: Discipline.ARCH });

function addRoof(graph, key) {
  const roof = graph.addRoom(new Set([key]), '屋根');
  roof.setKind(RoomKind.EXTERIOR);
  roof.setFeature(RoomFeature.ROOF);
  return roof;
}
function addPlain(graph, key, kind = RoomKind.INTERIOR, name = '部屋') {
  const room = graph.addRoom(new Set([key]), name);
  room.setKind(kind);
  return room;
}

function makeStore(graphs) {
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  return store;
}
function makePeek(project, store, log) {
  const inner = makeStorePeek(project, store);
  return (plane) => { log.push(plane.id); return Promise.resolve(inner(plane)); };
}
// peek 済みの一時グラフ群で衝突検出を直接呼ぶ（純関数の単体テスト用）。
function conflictsFor(project, graphs, { cells, indoor = true }) {
  const store = makeStore(graphs);
  const peek = makeStorePeek(project, store);
  const floors = graphs.map((g, i) => (i === 0 ? { plane: g.plane, graph: g } : { plane: g.plane, graph: peek(g.plane) }));
  return findStairUpperRoofConflicts({ structGraph: project.structGraph, floors, activeIndex: 0, cells, indoor });
}

// ================================================================
// 純関数: 衝突検出
// ================================================================

test('中間階（2階）の屋根セルが階段の上階展開と重なる→衝突（expands:stair）', () => {
  const { project, graphs } = setupProject(3);
  const [g1, , g3] = graphs;
  addRoof(graphs[1], leftKey(graphs[1]));
  const conflicts = conflictsFor(project, graphs, { cells: new Set([leftKey(g1)]) });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].floorLabel, '2階');
  assert.equal(conflicts[0].expands, 'stair');
  assert.equal(conflicts[0].planeId, 'p2');
  assert.ok(g3, '前提: 3階建て');
});

test('最上階の屋根セルは、屋内階段なら階段吹抜けの展開と重なる（stairVoid）／屋外階段は何も展開されないので衝突しない', () => {
  const { project, graphs } = setupProject(3);
  addRoof(graphs[2], leftKey(graphs[2]));
  const indoor = conflictsFor(project, graphs, { cells: new Set([leftKey(graphs[0])]), indoor: true });
  assert.deepEqual(indoor.map(c => [c.floorLabel, c.expands]), [['3階', 'stairVoid']]);
  const outdoor = conflictsFor(project, graphs, { cells: new Set([leftKey(graphs[0])]), indoor: false });
  assert.equal(outdoor.length, 0, '最上階の屋外階段は展開されない');
  // 中間階の屋根は屋外階段でも衝突する（階段そのものが展開されるため）
  const { project: p2, graphs: gs2 } = setupProject(3);
  addRoof(gs2[1], leftKey(gs2[1]));
  const outdoorMid = conflictsFor(p2, gs2, { cells: new Set([leftKey(gs2[0])]), indoor: false });
  assert.deepEqual(outdoorMid.map(c => c.floorLabel), ['2階']);
});

test('屋根が階段の足跡と重ならない→衝突なし／複数階に屋根があれば階の順に全部', () => {
  const { project, graphs } = setupProject(3);
  addRoof(graphs[1], rightKey(graphs[1]));
  assert.equal(conflictsFor(project, graphs, { cells: new Set([leftKey(graphs[0])]) }).length, 0, '右セルの屋根と左セルの階段は重ならない');

  const { project: p2, graphs: gs2 } = setupProject(3);
  addRoof(gs2[1], leftKey(gs2[1]));
  addRoof(gs2[2], leftKey(gs2[2]));
  const both = conflictsFor(p2, gs2, { cells: new Set([leftKey(gs2[0])]) });
  assert.deepEqual(both.map(c => c.floorLabel), ['2階', '3階']);
});

test('上の階の屋外部屋（非屋根）・通常の部屋・未指定は従来どおり衝突にしない（今回変えない）', () => {
  const { project, graphs } = setupProject(3);
  addPlain(graphs[1], leftKey(graphs[1]), RoomKind.EXTERIOR, 'バルコニー');
  addPlain(graphs[2], leftKey(graphs[2]), RoomKind.INTERIOR, '寝室');
  assert.equal(conflictsFor(project, graphs, { cells: new Set([leftKey(graphs[0])]) }).length, 0);
});

test('上の階の格子が細かい: 階段の足跡の一部だけに屋根があっても衝突／辺で接するだけなら衝突なし', () => {
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs[1], 500);
  const right = worldToCell(750, 500, graphs[1]).key; // 2階 [500,1000]
  addRoof(graphs[1], right);
  const hit = conflictsFor(project, graphs, { cells: new Set([leftKey(graphs[0])]) }); // 1階 [0,1000]
  assert.equal(hit.length, 1);
  assert.equal(hit[0].expands, 'stairVoid', '2階建ての2階は最上階＝屋内階段なら階段吹抜け');

  const { project: p2, graphs: gs2 } = setupProject(2);
  addPerFloorV(gs2[0], 500);
  addPerFloorV(gs2[1], 500);
  addRoof(gs2[1], worldToCell(750, 500, gs2[1]).key);          // 2階 [500,1000]
  const stairCell = worldToCell(250, 500, gs2[0]).key;          // 1階 [0,500]
  assert.equal(conflictsFor(p2, gs2, { cells: new Set([stairCell]) }).length, 0, '[0,500] と [500,1000] は接するだけ');
});

test('階段の足跡が設置階だけの per-floor 中心線で区切られていても、上の階へ写して（不足CLを一時グラフへ足して）屋根と照合する', () => {
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs[0], 500); // 1階だけ x=500 で割る。階段は [0,500]
  const stairCell = worldToCell(250, 500, graphs[0]).key;
  addRoof(graphs[1], leftKey(graphs[1])); // 2階は粗いまま [0,1000] が屋根
  const hit = conflictsFor(project, graphs, { cells: new Set([stairCell]) });
  assert.equal(hit.length, 1, '上の階に x=500 が無くても CL を写して重なりを見つける');

  const { project: p2, graphs: gs2 } = setupProject(2);
  addPerFloorV(gs2[0], 500);
  addRoof(gs2[1], rightKey(gs2[1])); // 屋根は右セル。階段 [0,500] とは重ならない
  assert.equal(conflictsFor(p2, gs2, { cells: new Set([worldToCell(250, 500, gs2[0]).key]) }).length, 0);
});

// ================================================================
// 呼び出し口: findStairUpperRoofRejection（peek→衝突検出→メッセージ）
// ================================================================

test('findStairUpperRoofRejection: 衝突があれば拒否メッセージ（衝突階の名前入り）・無ければ null。上の階だけ peek する', async () => {
  const { project, graphs } = setupProject(3);
  addRoof(graphs[1], leftKey(graphs[1]));
  addRoof(graphs[2], leftKey(graphs[2]));
  const store = makeStore(graphs);
  const log = [];
  const msg = await findStairUpperRoofRejection(project, graphs[0], new Set([leftKey(graphs[0])]), true, makePeek(project, store, log));
  assert.equal(msg, ERR_STAIR_UPPER_ROOF(['2階', '3階']));
  assert.ok(msg.includes('2階') && msg.includes('3階'));
  assert.deepEqual(log, ['p2', 'p3'], '自階（1階）は peek しない');

  const { project: p2, graphs: gs2 } = setupProject(3);
  addRoof(gs2[1], rightKey(gs2[1]));
  const log2 = [];
  const ok = await findStairUpperRoofRejection(p2, gs2[0], new Set([leftKey(gs2[0])]), true, makePeek(p2, makeStore(gs2), log2));
  assert.equal(ok, null);
  assert.equal(log2.length, 2, '重ならなくても上の階2つを確かめている（空振りでない）');
});

test('findStairUpperRoofRejection: 上の階が無い（最上階・検討案）なら peek せず null', async () => {
  const { project, graphs } = setupProject(2);
  const { graph: alt } = project.addPlane(0, '1階案', 'alt1', 1, 1, true, 'p1', 1);
  const log = [];
  const peek = makePeek(project, makeStore([...graphs, alt]), log);
  assert.equal(await findStairUpperRoofRejection(project, graphs[1], new Set([leftKey(graphs[1])]), true, peek), null);
  assert.equal(await findStairUpperRoofRejection(project, alt, new Set([leftKey(alt)]), true, peek), null);
  assert.equal(log.length, 0);
});

test('【失敗系】findStairUpperRoofRejection: peek が reject・null のどちらでも握りつぶさず reject する（呼び出し側は指定しない）', async () => {
  const { project, graphs } = setupProject(2);
  let calls = 0;
  await assert.rejects(
    () => findStairUpperRoofRejection(project, graphs[0], new Set([leftKey(graphs[0])]), true, async () => { calls++; throw new Error('IDB read failed'); }),
    /IDB read failed/,
  );
  await assert.rejects(
    () => findStairUpperRoofRejection(project, graphs[0], new Set([leftKey(graphs[0])]), true, async () => { calls++; return null; }),
    /peek が階のグラフを返しませんでした/,
  );
  assert.equal(calls, 2);
});

// ================================================================
// 確定の経路（App.jsx convertStairFromNaming と同じ列: prepareStairNaming → 事前チェック → applyNaming）
// ================================================================

const STAIR_PAYLOAD = { name: '', kind: RoomKind.INTERIOR, feature: RoomFeature.STAIR };

test('FinishModeState.isStairConversionIntent / prepareStairNaming: 階段でない部屋→階段だけ真・セルは複製・屋外は indoor:false', () => {
  const { graphs } = setupProject(1);
  const g = graphs[0];
  const state = new FinishModeState(g, null);
  const room = g.addRoom(new Set([leftKey(g)]), 'ホール');
  assert.equal(state.isStairConversionIntent(room.id, STAIR_PAYLOAD), true);
  assert.equal(state.isStairConversionIntent(room.id, { name: 'x', kind: RoomKind.INTERIOR, feature: null }), false, '階段以外への確定');
  assert.equal(state.isStairConversionIntent('no-such-room', STAIR_PAYLOAD), false, '存在しない部屋');
  const prep = state.prepareStairNaming(room.id, STAIR_PAYLOAD);
  assert.deepEqual([...prep.cells], [leftKey(g)]);
  assert.notEqual(prep.cells, room.cells, 'セルは複製（以後の変更が混ざらない）');
  assert.equal(prep.indoor, true);
  assert.equal(state.prepareStairNaming(room.id, { ...STAIR_PAYLOAD, kind: RoomKind.EXTERIOR }).indoor, false);
  assert.equal(state.prepareStairNaming('no-such-room', STAIR_PAYLOAD), null);
  // 既に階段の部屋への再確定は「新規指定」ではない
  state.applyNaming(room.id, STAIR_PAYLOAD, 3000);
  assert.equal(g.stairs.length, 1, '前提: 階段になった');
  assert.equal(state.isStairConversionIntent(room.id, STAIR_PAYLOAD), false);
});

function decodedSummary(project, plane, bytes) {
  const g = decodeFloor(project, plane, bytes);
  return {
    stairs: g.stairs.length,
    rooms: g.rooms.map(r => `${r.feature ?? '-'}:${r.kind}:${[...r.cells].sort().join('|')}`).sort(),
    cls: g.centerLines.length,
  };
}

test('拒否されたとき: 設置階のグラフ・他階の保存データ（復号して比較）・undo スタックが1つも変わらない', async () => {
  const { project, graphs } = setupProject(3);
  const [g1] = graphs;
  const room = g1.addRoom(new Set([leftKey(g1)]), 'ホール');
  addRoof(graphs[1], leftKey(graphs[1]));
  const state = new FinishModeState(g1, null);
  const store = makeStore(graphs);
  const beforeBytes = new Map([...store].map(([k, v]) => [k, Buffer.from(v)]));
  const beforeSummary = new Map(project.planes.map(p => [p.id, decodedSummary(project, p, store.get(p.id))]));
  const g1Before = Buffer.from(serializeGraph(g1));
  const undoBefore = undoManager._undoStack.length;
  const log = [];

  const prep = state.prepareStairNaming(room.id, STAIR_PAYLOAD);
  const msg = await findStairUpperRoofRejection(project, g1, prep.cells, prep.indoor, makePeek(project, store, log));
  // App.jsx と同じ分岐: メッセージがあれば applyNaming を呼ばない
  if (!msg) state.applyNaming(room.id, STAIR_PAYLOAD, 3000);

  assert.ok(msg, '拒否メッセージが出る');
  assert.equal(log.length, 2, '上の階2つを peek した（事前チェックが実際に走った）');
  assert.equal(g1.stairs.length, 0, '階段は作られない');
  assert.equal(g1.roomMap.get(room.id).feature, null, '部屋の属性は変わらない');
  assert.ok(Buffer.from(serializeGraph(g1)).equals(g1Before), '設置階のバイト列が変わらない');
  assert.equal(undoManager._undoStack.length, undoBefore, 'undo スタックが変わらない');
  for (const p of project.planes) {
    assert.ok(Buffer.from(store.get(p.id)).equals(beforeBytes.get(p.id)), `${p.name}: 保存データのバイト列が変わらない`);
    assert.deepEqual(decodedSummary(project, p, store.get(p.id)), beforeSummary.get(p.id), `${p.name}: 復号した内容が変わらない`);
  }
});

test('拒否されないとき（屋根が無い／重ならない）: 従来どおり階段が指定され undo が1件積まれる', async () => {
  for (const withRoofElsewhere of [false, true]) {
    const { project, graphs } = setupProject(3);
    const [g1] = graphs;
    const room = g1.addRoom(new Set([leftKey(g1)]), 'ホール');
    if (withRoofElsewhere) addRoof(graphs[1], rightKey(graphs[1]));
    const state = new FinishModeState(g1, null);
    const log = [];
    const undoBefore = undoManager._undoStack.length;

    const prep = state.prepareStairNaming(room.id, STAIR_PAYLOAD);
    const msg = await findStairUpperRoofRejection(project, g1, prep.cells, prep.indoor, makePeek(project, makeStore(graphs), log));
    assert.equal(msg, null);
    assert.equal(log.length, 2, '事前チェックは走っている');
    const converted = state.applyNaming(room.id, STAIR_PAYLOAD, 3000);

    assert.ok(converted, '階段が作られる');
    assert.equal(g1.stairs.length, 1);
    assert.equal(undoManager._undoStack.length, undoBefore + 1);
  }
});

// ================================================================
// 事前チェックの予測と、実際の syncUpperFloors（階段の上階展開）の一致（QA Minor-5）。
// 上のテストのフィクスチャは設置階の足跡が通り芯だけで、syncUpperFloors が何もしない形だった（実際の同期と
// 一致するかを何も保証しない）。ここでは設置階の足跡が per-floor 中心線（x=500）を含む構成で、
// peek は本番同型（保存バイト列から復元）・save は Map へ記録する注入で、本物の syncUpperFloors を走らせる。
// ================================================================

const overlapPos = (a, b) => Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 1e-6 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 1e-6;
const L = [[250, 500]]; // 全階 x=500 を足したときの左半分 [0,500]
const allV500 = (graphs) => graphs.forEach(g => addPerFloorV(g, 500));
const keyAt = (g, [x, y]) => worldToCell(x, y, g).key;

// 階段の指定（1階）→ 予測（findStairUpperRoofConflicts）→ 実際の同期（syncUpperFloors）→ 上の各階を復号して
// 「屋根と重なる階段が置かれた階（中間階）／階段吹抜けが作られなかった階（最上階・屋内階段）」を集める。
async function predictAndSync({ n, build, pts, kind = RoomKind.INTERIOR }) {
  const { project, graphs } = setupProject(n);
  build?.(graphs);
  const ga = graphs[0];
  project.activePlaneId = ga.plane.id;
  const room = ga.addRoom(new Set(pts.map(p => keyAt(ga, p))), 'ホール');
  room.setKind(kind);
  const payload = { name: '', kind, feature: RoomFeature.STAIR };
  const state = new FinishModeState(ga, project);
  const prep = state.prepareStairNaming(room.id, payload);
  const sourceRects = [...prep.cells].map(k => cellBoundsFromKey(k, ga));
  const upperPlanes = project.planes.slice(1);

  // 予測: 保存バイト列から復元した上の階（実際の同期と同じ初期状態）に対して
  const predStore = new Map(graphs.slice(1).map(g => [g.plane.id, serializeGraph(g)]));
  const predPeek = makeStorePeek(project, predStore);
  const floors = [{ plane: ga.plane, graph: ga }, ...upperPlanes.map(p => ({ plane: p, graph: predPeek(p) }))];
  const pred = findStairUpperRoofConflicts({
    structGraph: project.structGraph, floors, activeIndex: 0, cells: prep.cells, indoor: prep.indoor,
  }).map(c => `${c.floorLabel}:${c.expands}`);

  // 実際: 本物の syncUpperFloors（peek・save は注入）
  const store = new Map(graphs.slice(1).map(g => [g.plane.id, serializeGraph(g)]));
  const inner = makeStorePeek(project, store);
  const peekLog = [];
  const saveLog = [];
  const peekFn = async (plane) => { peekLog.push(plane.id); return inner(plane); };
  state.applyNaming(room.id, payload, floorHeightAbove(project, project.activePlane));
  await syncUpperFloors(project, ga, { peekFn, saveFloorFn: makeStoreSave(store, saveLog) });

  const actual = [];
  const decoded = new Map();
  upperPlanes.forEach((p, i) => {
    const hasFloorAbove = i + 2 < project.planes.length;
    const g = decodeFloor(project, p, store.get(p.id));
    decoded.set(p.id, g);
    const roofRooms = g.rooms.filter(r => r.feature === RoomFeature.ROOF);
    const roofCells = new Set(roofRooms.flatMap(r => [...refreshCells(r.cells, g)]));
    if (hasFloorAbove) {
      if (g.stairs.some(s => [...refreshCells(s.cells, g)].some(k => roofCells.has(k)))) actual.push(`${p.name}:stair`);
    } else {
      const roofOnFootprint = roofRooms.some(r => [...r.cells].some(k => {
        const rb = cellBoundsFromKey(k, g);
        return rb && sourceRects.some(sr => overlapPos(rb, sr));
      }));
      if (prep.indoor && roofOnFootprint && !g.rooms.some(r => r.feature === RoomFeature.STAIR_VOID)) actual.push(`${p.name}:stairVoid`);
    }
  });
  return { pred, actual, peekLog, saveLog, decoded, upperPlanes };
}

test('【予測と実際の同期の一致】中間階（2階）の屋根: 予測=2階の階段 ／ 実際=屋根の上に階段が置かれ、ペアRoomは作られない', async () => {
  const r = await predictAndSync({ n: 3, pts: L, build: gs => { allV500(gs); addRoof(gs[1], keyAt(gs[1], L[0])); } });
  assert.deepEqual(r.pred, ['2階:stair']);
  assert.deepEqual(r.actual, r.pred, '予測と実際の同期が一致');
  assert.deepEqual(r.peekLog, ['p2', 'p3'], '同期は上の2階を peek している（空振りでない）');
  assert.ok(r.saveLog.length > 0, '同期が実際に保存している（空振りでない）');
  const stair2 = r.decoded.get('p2').stairs;
  assert.equal(stair2.length, 1);
  assert.equal(stair2[0].roomId ?? null, null, '屋根の上のStairにはペアRoomが無い（拒否の理由）');
});

test('【予測と実際の同期の一致】最上階（3階）の屋根: 屋内階段は階段吹抜けが作られない／屋外階段は予測も実際も衝突なし', async () => {
  const roofOnTop = gs => { allV500(gs); addRoof(gs[2], keyAt(gs[2], L[0])); };
  const indoor = await predictAndSync({ n: 3, pts: L, build: roofOnTop });
  assert.deepEqual(indoor.pred, ['3階:stairVoid']);
  assert.deepEqual(indoor.actual, indoor.pred, '屋内階段: 予測と実際が一致');
  assert.equal(indoor.peekLog.length, 2);
  assert.equal(indoor.decoded.get('p2').stairs.length, 1, '2階（中間階）には階段が置かれている');

  const outdoor = await predictAndSync({ n: 3, pts: L, build: roofOnTop, kind: RoomKind.EXTERIOR });
  assert.deepEqual(outdoor.pred, []);
  assert.deepEqual(outdoor.actual, outdoor.pred, '屋外階段: 最上階には何も展開されない');
  assert.equal(outdoor.peekLog.length, 2);
  assert.equal(outdoor.decoded.get('p2').stairs.length, 1, '2階（中間階）には階段が置かれている（空振りでない）');
});

test('【予測と実際の同期の一致】屋根なし（対照）: 予測も実際も空で、中間階に階段・最上階に階段吹抜けが実際に作られる', async () => {
  const r = await predictAndSync({ n: 3, pts: L, build: allV500 });
  assert.deepEqual(r.pred, []);
  assert.deepEqual(r.actual, []);
  assert.equal(r.decoded.get('p2').stairs.length, 1, '中間階に階段');
  assert.equal(r.decoded.get('p3').rooms.filter(x => x.feature === RoomFeature.STAIR_VOID).length, 1, '最上階に階段吹抜け');
});

test('【予測と実際の同期の一致】上の階の格子がずれている（2階だけ x=400）: 一部が重なれば衝突・重ならなければなし', async () => {
  const shifted = (roofPoint) => gs => {
    gs.forEach((g, i) => addPerFloorV(g, i === 1 ? 400 : 500)); // 1階・3階は x=500、2階だけ x=400
    addRoof(gs[1], keyAt(gs[1], roofPoint));
  };
  // 屋根 [400,1000]（2階の格子）と階段 [0,500]（1階の格子）は [400,500] で重なる
  const hit = await predictAndSync({ n: 3, pts: L, build: shifted([700, 500]) });
  assert.deepEqual(hit.pred, ['2階:stair']);
  assert.deepEqual(hit.actual, hit.pred);
  assert.ok(hit.saveLog.length > 0 && hit.peekLog.length === 2);

  // 屋根 [0,400] と階段 [0,500] も重なる（一部）
  const left = await predictAndSync({ n: 3, pts: L, build: shifted([200, 500]) });
  assert.deepEqual(left.pred, ['2階:stair']);
  assert.deepEqual(left.actual, left.pred);

  // 2階 x=600・屋根 [600,1000] と階段 [0,500] は重ならない
  const miss = await predictAndSync({
    n: 3, pts: L,
    build: gs => { gs.forEach((g, i) => addPerFloorV(g, i === 1 ? 600 : 500)); addRoof(gs[1], keyAt(gs[1], [800, 500])); },
  });
  assert.deepEqual(miss.pred, []);
  assert.deepEqual(miss.actual, []);
  assert.equal(miss.decoded.get('p2').stairs.length, 1, '階段は屋根を避けた足跡に実際に置かれている（空振りでない）');
});

// 2026-10-02 リード裁定: 設置階の階段の足跡が通り芯だけでできている（per-floor 中心線を1本も使わない）とき、
// syncUpperFloors は `needed.size === 0` で何も展開しない（この挙動は今回の差分より前から既存。別課題として
// ユーザーへ報告）。事前チェックは安全側で、屋根の真下なら通り芯だけの階段でも拒否する（誤拒否側の差）。
// 拒否漏れ（予測が空・実際は屋根の上に置く）は起きないことを、他のテストで固定している。
test('【リード裁定・安全側の拒否】通り芯だけの階段: 事前チェックは屋根の真下なら拒否するが、実際の同期は何も展開しない（同期側の挙動は既存・別課題）', async () => {
  const r = await predictAndSync({
    n: 3, pts: [[500, 500]],
    build: gs => addRoof(gs[1], keyAt(gs[1], [500, 500])),
  });
  assert.deepEqual(r.pred, ['2階:stair'], '事前チェックは拒否する（安全側）');
  assert.deepEqual(r.actual, [], '実際の同期は階段を置かない（通り芯だけの階段は上階へ展開されない既存の挙動）');
  assert.equal(r.peekLog.length, 0, '同期は needed=0 で peek の前に return する');
  assert.equal(r.saveLog.length, 0, '何も保存されない');
  assert.equal(r.decoded.get('p2').stairs.length, 0);
});
