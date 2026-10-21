// 階追加の follower（実物の elevatorCopy・stairCopy・exteriorRoom・stairVoidReconcile・switchToAddedFloor）が
// 本番の peek／saveFloor（fake IndexedDB 経由・バイト列から restoreGraph）で、当該階の階段を新しい階へ写すことを確かめる。
// なぜ別ファイルか: storage/db.js の openDB() は接続をモジュールスコープにキャッシュし、以後の globalThis.indexedDB の
// 差し替えを無視する（前例: stairVoidFollower.productionIo.test.js）。fake IDB はこのファイルのモジュールレベルで1個だけ作る。
// 構造反映（structuralReflect）・主屋根（mainRoofCarry）は階段と無関係なので除く。S4（2026-10-21）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CenterLineType, RoomFeature } from '@core';
import { PlanGraph } from '../../core.js';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';
import { saveFloor, loadFloor } from '../../storage/db.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from '../../floorOrderChange.js';
import { computeFloorInsert } from '../../floorOps.js';
import { refreshCells } from '../gridCells.js';
import { ERR_STAIR_COPY_SKIPPED } from '../../error.js';
import { makeStorePeek, makeStoreSave } from '../equipment/equipmentTestFixtures.js';
import { syncUpperFloors } from './stairFloorSync.js';
import { COPIED_STAIR_FIELDS } from './stairFloorCopy.js';
import { setupProject, addPerFloorV, placeStair, keyAt } from './stairRemovalTestFixtures.js';

// ---- module-level fake IndexedDB（このファイルで1個だけ）----
class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
class FakeStore {
  constructor() { this.data = new Map(); }
  put(value) {
    const req = new FakeRequest();
    this.data.set(value.planeId ?? value.projectId, value);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
  get(key) {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } }));
    return req;
  }
  delete(key) {
    const req = new FakeRequest();
    this.data.delete(key);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
}
const fakeStores = { floors: new FakeStore(), projects: new FakeStore(), savedFloors: new FakeStore() };
const fakeDb = {
  objectStoreNames: { contains: (n) => n in fakeStores },
  transaction(name) { const store = fakeStores[name]; return { objectStore: () => store }; },
};
globalThis.indexedDB = {
  open() {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } }));
    return req;
  },
};

const NAMES = ['roofPlaneHeight', 'elevatorCopy', 'stairCopy', 'exteriorRoom', 'stairVoidReconcile', 'switchToAddedFloor'];
const followersFor = (...omit) => floorOrderFollowers.filter(f => NAMES.includes(f.name) && !omit.includes(f.name));
const makeUi = () => ({ notified: [], switched: [], notify(m) { this.notified.push(m); }, switchFloor(id) { this.switched.push(id); return Promise.resolve(true); }, onFloorSyncChanged() {} });

async function loadGraph(project, id) {
  const g = new PlanGraph(project.planeMap.get(id));
  g._structGraph = project.structGraph;
  restoreGraph(g, await loadFloor(id));
  return g;
}

// 床 floorCount 階。1階に階段（実経路 applyNaming）＋外壁＋右側の部屋。syncUpperFloors で2階に吹抜け。全階を IDB へ保存。
// 階段を置く階は stairFloor（既定 p1）。アクティブはその階。
async function build(floorCount, { stairFloor = 'p1', stairOver = {} } = {}) {
  const { project, graphs } = setupProject(floorCount);
  addPerFloorV(graphs);
  const g = graphs[Number(stairFloor.slice(1)) - 1];
  const { stair } = placeStair(project, g);
  for (const [k, v] of Object.entries(stairOver)) stair.setField(k, v);
  const sg = project.structGraph;
  const cl = (type, value) => [...sg.centerLines].find(c => c.centerLineType === type && c.value === value);
  g.addWall(cl(CenterLineType.VERTICAL, 0).id, 0, true, cl(CenterLineType.HORIZONTAL, 0).id, 0, cl(CenterLineType.HORIZONTAL, 1000).id, 0,
    { isRoomWall: true, isExteriorWall: true });
  g.addRoom(new Set([keyAt(g, [750, 500]), keyAt(g, [1500, 500])]), '居室');
  for (const gr of graphs) await saveFloor(gr.plane.id, serializeGraph(gr));
  await syncUpperFloors(project, g); // 直上階に STAIR_VOID（既定の peek／saveFloor）
  project.activePlaneId = stairFloor;
  return { project, graphs, g, stair };
}

async function insertAbove(project, g, newId, { stories = 1, followers = followersFor(), ui = makeUi() } = {}) {
  const ins = computeFloorInsert(project.planes, g.plane.id, stories);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT, updates: ins.updates, sourceGraph: g, newStartFloor: ins.newPlane.startFloor,
    addPlane: () => project.addPlane(ins.newPlane.elevation, ins.newPlane.name, newId, ins.newPlane.startFloor, ins.newPlane.stories),
    ui,
  }, followers);
  return { ui, ins };
}

const features = (g, f) => g.rooms.filter(r => r.feature === f);

test('【途中階の上階追加・3階建て】新しい階に階段とペア部屋が写り、STAIR_VOID は付かず、上の階の吹抜けは残る。値は当該階と同じ', async () => {
  const { project, g, stair } = await build(3, { stairOver: { tread: 270, riser: 180, upDirection: 'down', flip: true } });
  const before2 = await loadGraph(project, 'p2');
  assert.equal(features(before2, RoomFeature.STAIR_VOID).length, 1, '前提: 2階に吹抜けがある');

  await insertAbove(project, g, 'pM');

  const m = await loadGraph(project, 'pM');
  assert.equal(m.stairs.length, 1, '新しい階に階段');
  const c = m.stairs[0];
  for (const f of COPIED_STAIR_FIELDS) assert.deepEqual(c[f], stair[f], `${f} が当該階と同じ`);
  assert.equal(c.upDirection, 'down');
  assert.equal(c.flip, true);
  assert.equal(features(m, RoomFeature.STAIR).length, 1, 'ペア部屋');
  assert.equal(m.roomMap.get(c.roomId).feature, RoomFeature.STAIR);
  assert.equal(features(m, RoomFeature.STAIR_VOID).length, 0, '新しい階の足元に STAIR_VOID を重ねない');
  // 外壁内側の部屋（exteriorRoom）は写した階段の足元のセルを持たない（二重所有なし）
  const pair = refreshCells(m.roomMap.get(c.roomId).cells, m);
  for (const r of m.rooms.filter(x => x.id !== c.roomId)) {
    assert.equal([...refreshCells(r.cells, m)].some(k => pair.has(k)), false, `${r.name} が階段の足元と重なる`);
  }
  assert.ok(m.rooms.some(r => r.name.endsWith('階') && r.feature == null), '前提: exteriorRoom の部屋ができている（発火している）');
  // 上の階（元の2階）の吹抜けは孤児として未定義化されず残る
  const p2 = await loadGraph(project, 'p2');
  assert.equal(features(p2, RoomFeature.STAIR_VOID).length, 1, '上の階の吹抜けが残る');
  assert.equal(features(p2, RoomFeature.UNDEFINED).length, 0, '未定義化されていない');
  // 当該階は変わらない
  assert.equal(g.stairs.length, 1);
});

test('【最上階の上へ追加】新しい最上階にも階段が写る（蹴上は当該階と同じ null＝自動のまま）', async () => {
  const { project, g } = await build(2, { stairFloor: 'p2' });
  assert.equal(g.stairs[0].riser, null, '前提: 蹴上は自動');
  await insertAbove(project, g, 'pTop');
  const top = await loadGraph(project, 'pTop');
  assert.equal(top.stairs.length, 1);
  assert.equal(top.stairs[0].riser, null);
  assert.equal(features(top, RoomFeature.STAIR_VOID).length, 0);
});

test('【stories=2】複層階の新しい階にも階段が写る', async () => {
  const { project, g } = await build(3);
  const { ins } = await insertAbove(project, g, 'pM2', { stories: 2 });
  assert.equal(ins.newPlane.stories, 2, '前提: 複層階');
  const m = await loadGraph(project, 'pM2');
  assert.equal(m.stairs.length, 1);
});

test('【下階追加 n=2】新しい階すべて（B1・B2）に階段が写り、どちらにも STAIR_VOID は付かない', async () => {
  const { project, g } = await build(2);
  const ui = makeUi();
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.ADD_LOWER, updates: [], sourceGraph: g, ui,
    addPlane: () => {
      const b1 = project.addPlane(-3000, '地下1階', 'b1', -1, 1);
      const b2 = project.addPlane(-6000, '地下2階', 'b2', -2, 1);
      return { plane: b2.plane, planes: [b1.plane, b2.plane] };
    },
  }, followersFor());
  for (const id of ['b1', 'b2']) {
    const bg = await loadGraph(project, id);
    assert.equal(bg.stairs.length, 1, `${id} に階段`);
    assert.equal(features(bg, RoomFeature.STAIR).length, 1, `${id} にペア部屋`);
    assert.equal(features(bg, RoomFeature.STAIR_VOID).length, 0, `${id} に STAIR_VOID なし`);
  }
  assert.deepEqual(ui.switched, ['b2'], '最下の新しい階へ切替');
  // 既存の2階の吹抜け（1階の階段由来）は残る
  const p2 = await loadGraph(project, 'p2');
  assert.equal(features(p2, RoomFeature.STAIR_VOID).length, 1);
});

test('【当該階に階段が無い】新しい階に階段も階段吹抜けも作らない', async () => {
  const { project, g } = await build(2);
  for (const s of [...g.stairs]) g.removeStair(s.id);
  await insertAbove(project, g, 'pNone');
  const m = await loadGraph(project, 'pNone');
  assert.equal(m.stairs.length, 0);
});

test('【失敗系】sourceGraph を渡さない階追加（ADD_LOWER）は stairCopy が例外にする', async () => {
  const { project } = await build(2);
  await assert.rejects(
    () => applyFloorOrderChange(project, {
      kind: FLOOR_ORDER_KIND.ADD_LOWER, updates: [], ui: makeUi(),
      addPlane: () => { const b = project.addPlane(-3000, '地下1階', 'bx', -1, 1); return { plane: b.plane, planes: [b.plane] }; },
    }, followersFor()),
    /stairCopy: sourceGraph がありません/,
  );
});

test('【失敗系】置けない階があれば飛ばし、階ごとにトースト1回（件数つき）', async () => {
  const { project, g } = await build(2);
  // 新しい階の足元を屋根で塞いだ状態にして、floorIo の peek で返す（stairCopy は ctx.floorIo の peek／保存を使う）
  const store = new Map();
  const blocked = (plane) => {
    const gr = makeStorePeek(project, store)(plane);
    if (gr.rooms.length === 0) {
      const roof = gr.addRoom(new Set([keyAt(gr, [500, 500])]), '屋根');
      roof.setFeature(RoomFeature.ROOF);
    }
    return gr;
  };
  const saves = [];
  const ui = makeUi();
  const stairOnly = floorOrderFollowers.filter(f => f.name === 'stairCopy');
  const ins = computeFloorInsert(project.planes, g.plane.id, 1);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT, updates: ins.updates, sourceGraph: g, ui, newStartFloor: ins.newPlane.startFloor,
    floorIo: { peekFn: blocked, saveFloorFn: makeStoreSave(store, saves) },
    addPlane: () => project.addPlane(ins.newPlane.elevation, ins.newPlane.name, 'pBlk', ins.newPlane.startFloor, ins.newPlane.stories),
  }, stairOnly);
  assert.deepEqual(ui.notified, [ERR_STAIR_COPY_SKIPPED(ins.newPlane.name, 1)]);
  assert.deepEqual(saves, [], '何も写せなかった階は保存しない');
});

test('【途中階の上階追加】新しい階の昇降路と足元が重なる階段は飛び、トースト1回、新しい階に STAIR_VOID も付かない', async () => {
  const { project, g, stair } = await build(3);
  // 当該階に、階段と同じ足元を指す器具行を直接足す（実データ上はありえない重なり。elevatorCopy が新しい階へ昇降路を
  // 先に置き、続く stairCopy の足元と重なる状況を作る）
  g.addEquipmentRow({ id: 'ev1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(stair.cells) });
  const { ui, ins } = await insertAbove(project, g, 'pEv');
  const m = await loadGraph(project, 'pEv');
  assert.equal(features(m, RoomFeature.ELEVATOR_EQUIPMENT).length, 1, '前提: 昇降路が新しい階に複製されている');
  assert.equal(m.stairs.length, 0, '重なる階段は写さない');
  assert.deepEqual(ui.notified, [ERR_STAIR_COPY_SKIPPED(ins.newPlane.name, 1)]);
  assert.equal(features(m, RoomFeature.STAIR_VOID).length, 0, '昇降路の上に STAIR_VOID を置かない');
});
