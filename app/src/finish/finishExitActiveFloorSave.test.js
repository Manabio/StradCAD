// 仕上げ脱出境界が、他階を処理する前にアクティブ階を IDB へ書くこと（saveActiveFloorFn）の固定。
// 不良（問題.md 2026-10-07）: 1階で階段を指定して平面モードへ出ると、2階の階段の下り口に壁が残った。
// 他階の処理は自階を floorSwapManager.peek＝IDB から読むが、アクティブ階の auto-save は dirty 印だけで
// 書かないため、IDB の1階は階段指定前のまま（階段 0 件）で、2階の下り口を開ける辺（extraStairOpenings）が
// 0 本になっていた。IDB は最小の fake を globalThis に置く（node:test はファイルごとに別プロセス）。
// 他階は本番の floorSwapManager.peek（fake IDB から復元）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Project, CenterLineType, Discipline, StairType, RoomFeature } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph } from '../graphSnapshot.js';
import { saveFloor } from '../storage/db.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from './finishBoundary.js';
import { loadMaterialMap } from './wallRegeneration.js';
import { stairPortEdges } from './stair/stairGeometry.js';

const putLog = []; // floors ストアへの put の planeId
function installFakeIndexedDB() {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor(name) { this.name = name; this.data = new Map(); }
    put(value) {
      const req = new FakeRequest();
      if (this.name === 'floors') putLog.push(value.planeId);
      this.data.set(value.planeId ?? value.projectId ?? value.key, value);
      queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
      return req;
    }
    get(key) { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } })); return req; }
    getAll() { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: [...this.data.values()] } })); return req; }
  }
  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
      for (const name of ['floors', 'projects', 'savedFloors', 'catalogs']) this.stores.set(name, new FakeStore(name));
    }
    transaction(name) { const store = this.stores.get(name); return { objectStore: () => store }; }
  }
  const fakeDb = new FakeDB();
  globalThis.indexedDB = { open() { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } })); return req; } };
}
installFakeIndexedDB();

const X = [-3000, 0, 1000, 4000];
const Y = [-3000, 0, 1500, 3000, 6000];
const STAIR_CELLS = [[1, 1], [1, 2]]; // 階段の足元（x 0..1000, y 0..3000）

function addFloor(project, elevation, id) {
  const { graph } = project.addPlane(elevation, id, id);
  const xs = X.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const ys = Y.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const key = (c, r) => `${xs[c].id}:${ys[r].id}:${xs[c + 1].id}:${ys[r + 1].id}`;
  return { graph, key };
}
function addRooms(f) {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      if (STAIR_CELLS.some(([sc, sr]) => sc === c && sr === r)) continue;
      f.graph.addRoom(new Set([f.key(c, r)]), `部屋${c}${r}`);
    }
  }
}

// 1階（アクティブ・メモリ）に階段を指定した直後の状態を作る。IDB の1階は階段を指定する前、
// IDB の2階は1階の階段の足元に STAIR_VOID を持つ（階段指定時の syncUpperFloors の結果）が壁・鍵は無い。
async function makeScenario() {
  const project = new Project('proj', 'test');
  const l = addFloor(project, 0, 'p1');
  addRooms(l);
  const u = addFloor(project, 3000, 'p2');
  addRooms(u);
  u.graph.addRoom(new Set(STAIR_CELLS.map(([c, r]) => u.key(c, r))), '吹抜け').setFeature(RoomFeature.STAIR_VOID);
  project.activePlaneId = 'p1';
  await saveFloor('p1', serializeGraph(l.graph)); // 階段指定前の1階
  await saveFloor('p2', serializeGraph(u.graph));
  const keys = new Set(STAIR_CELLS.map(([c, r]) => l.key(c, r)));
  const pair = l.graph.addRoom(new Set(keys), '階段');
  pair.setFeature(RoomFeature.STAIR);
  const stair = l.graph.addStair({
    type: StairType.STRAIGHT, cells: keys, roomId: pair.id,
    upDirection: 'up', flip: false, totalSteps: 12, tread: 250,
  });
  const materialMap = await loadMaterialMap();
  return { project, l, u, stair, fmode: { materialMap, stairUnderRooms: () => [] } };
}

// 1階を脱出し、IDB から復元した2階で、1階の階段の到達辺の線上に壁があるかを数える
// （壁は辺から壁厚の半分ほどずれて建つ。隣の平行なグリッド線は 1000mm 以上先なので許容 200mm）。
async function exitAndCountArrivalWalls(s, opts) {
  await runFinishEntryBoundary(s.l.graph, s.project);
  await runFinishExitBoundary(s.l.graph, s.project, s.fmode, { goingToStructure: false, ...opts });
  const upper = await floorSwapManager.peek(s.project.planeMap.get('p2'), s.project.structGraph);
  const edges = stairPortEdges(s.stair, s.l.graph, ['arrival']);
  assert.ok(edges.length >= 1, '前提: 到達辺がある');
  assert.ok(upper.walls.length > 0, '前提: 2階に壁が生成されている');
  return edges.flatMap(e => upper.walls.filter(w => {
    if (w.isVertical !== e.isVertical || Math.abs(w.axisValue - e.value) >= 200) return false;
    const a = Math.min(w.coord1, w.coord2), b = Math.max(w.coord1, w.coord2);
    return Math.min(b, e.hi) - Math.max(a, e.lo) > 100;
  })).length;
}

test('saveActiveFloorFn を渡すと、1階脱出直後の2階の下り口（1階の階段の到達辺）に壁が立たない', async () => {
  const s = await makeScenario();
  assert.equal(await exitAndCountArrivalWalls(s, { saveActiveFloorFn: saveFloor }), 0);
});

test('【対照】saveActiveFloorFn を渡さないと（IDB の1階が古いまま）2階の下り口に壁が立つ＝上のテストの検出力', async () => {
  const s = await makeScenario();
  assert.ok(await exitAndCountArrivalWalls(s, {}) > 0);
});

test('saveActiveFloorFn が reject したら例外は呼び出し元へ伝わり、2階は書かれない', async () => {
  const s = await makeScenario();
  await runFinishEntryBoundary(s.l.graph, s.project);
  putLog.length = 0;
  const boom = async () => { throw new Error('保存失敗'); };
  await assert.rejects(
    () => runFinishExitBoundary(s.l.graph, s.project, s.fmode, { goingToStructure: false, saveActiveFloorFn: boom }),
    /保存失敗/,
  );
  assert.deepEqual(putLog.filter(id => id !== 'p1'), [], '2階（他階）へは書かない');
});

test('saveActiveFloorFn は脱出1回につき1回、自階の planeId とバイト列で呼ばれる', async () => {
  const s = await makeScenario();
  await runFinishEntryBoundary(s.l.graph, s.project);
  const calls = [];
  await runFinishExitBoundary(s.l.graph, s.project, s.fmode, {
    goingToStructure: false,
    saveActiveFloorFn: async (id, bytes) => { calls.push([id, bytes]); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'p1');
  assert.ok(calls[0][1] != null);
});

test('saveActiveFloorFn は stamps で省いた脱出では呼ばれない', async () => {
  const s = await makeScenario();
  await runFinishEntryBoundary(s.l.graph, s.project);
  const calls = [];
  const saveActiveFloorFn = async (id) => { calls.push(id); };
  const full = await runFinishExitBoundary(s.l.graph, s.project, s.fmode, { goingToStructure: false, saveActiveFloorFn });
  assert.deepEqual(full, { skipped: false });
  assert.equal(calls.length, 1, '前提: 全部行う脱出では保存する（空振り防止）');
  const stamps = { canSkip: async () => ({ skip: true }) };
  const skipped = await runFinishExitBoundary(s.l.graph, s.project, s.fmode, { goingToStructure: false, stamps, saveActiveFloorFn });
  assert.deepEqual(skipped, { skipped: true });
  assert.equal(calls.length, 1, '省いた脱出は保存しない（呼び出しは増えない）');
});

// ---- 配線（ソース走査。コメント行・/* */ は除いて検査） ----
const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

test('【配線】App.jsx: finish.exit は saveActiveFloorFn: saveFloor を渡す（App.jsx 内で runFinishExitBoundary を呼ぶのは1箇所）', () => {
  const code = stripComments(readSrc('App.jsx'));
  const calls = code.split(/\r?\n/).filter(l => /runFinishExitBoundary\(/.test(l));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /saveActiveFloorFn: saveFloor/);
});

test('【配線】finishBoundary.js: 自階の保存は自階の undo push の後、他階の処理（上階の階段内装同期・構造反映・全階 sweep）より前、早期 return の後', () => {
  const src = readSrc('finish/finishBoundary.js');
  const s = src.indexOf('export async function runFinishExitBoundary');
  const code = stripComments(src.slice(s));
  const idx = (t) => { const i = code.indexOf(t); assert.ok(i >= 0, t); return i; };
  const save = idx('await saveActiveFloorFn(graph.plane.id, serializeGraph(graph))');
  assert.ok(save > idx('stamps.canSkip('));
  assert.ok(save > idx('undoManager.push('));
  assert.ok(save < idx('await syncUpperStairInteriors('));
  assert.ok(save < idx('await reflectStructuralAfterFinishExit('));
  assert.ok(save < idx('await refreshWallsAllFloors('));
});
