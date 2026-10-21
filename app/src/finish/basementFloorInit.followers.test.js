// 下階追加（ADD_LOWER）の S5c-2: 実物の follower（elevatorCopy・stairCopy・basementCenterLines・basementStructure・
// stairVoidReconcile・switchToAddedFloor）が本番の peek／saveFloor（fake IndexedDB 経由・バイト列から restoreGraph）で、
// 新しい地階へ 当該階の EV 行・外壁の階固有 CL・階段 を写し（部屋・壁は写さない）、地階構造の初期値を毎回書くことを確かめる。
// あわせて INSERT の EV 複製が今のままであること、最下階の地階に対する INSERT（即時の上階追加）の動き、undo の levels の往復。
// なぜ別ファイルか: storage/db.js の openDB() は接続をモジュールスコープにキャッシュし、以後の globalThis.indexedDB の
// 差し替えを無視する（前例: stairCopy.followers.test.js）。fake IDB はこのファイルのモジュールレベルで1個だけ作る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CenterLineType, RoomFeature } from '@core';
import { PlanGraph, Discipline } from '../core.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { saveFloor, loadFloor } from '../storage/db.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from '../floorOrderChange.js';
import {
  computeFloorInsert, collectProjectLevels, applyProjectLevels, diffFloorOpSnapshot,
} from '../floorOps.js';
import { ERR_BASEMENT_CL_COPY_FAILED } from '../error.js';
import { copyExteriorCLsToNewFloors, collectExteriorWallCLs } from './basementFloorInit.js';
import { setupProject, addPerFloorV, placeStair, keyAt } from './stair/stairRemovalTestFixtures.js';

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

const LOWER_NAMES = ['roofPlaneHeight', 'elevatorCopy', 'stairCopy', 'basementCenterLines', 'basementInit', 'stairVoidReconcile', 'switchToAddedFloor'];
const lowerFollowers = () => floorOrderFollowers.filter(f => LOWER_NAMES.includes(f.name));
const makeUi = () => ({ notified: [], switched: [], notify(m) { this.notified.push(m); }, switchFloor(id) { this.switched.push(id); return Promise.resolve(true); }, onFloorSyncChanged() {} });

async function loadGraph(project, id) {
  const g = new PlanGraph(project.planeMap.get(id));
  g._structGraph = project.structGraph;
  restoreGraph(g, await loadFloor(id));
  return g;
}
const ownCLs = (g) => [...g.shapeMap.values()].filter(s => s.constructor?.name === 'CenterLine');
const hasCL = (g, type, value) => ownCLs(g).some(c => c.centerLineType === type && c.value === value);
const features = (g, f) => g.rooms.filter(r => r.feature === f);

// 2階建て（p1=1階・p2=2階）。1階に階段（実経路 applyNaming）・昇降機の器具行 ev1(no1)・階固有の水平 CL y=500 に乗る外壁。
// 主構造は structure。アクティブは 1階。全階を IDB へ保存。
async function build({ structure = 'S造', withEv = true, withWall = true } = {}) {
  fakeStores.floors.data.clear(); // 前のテストの階（同じ id の b1 など）の残りを読まない
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs);
  project.structuralInfo.setField('mainStructure', structure);
  const g = graphs[0];
  placeStair(project, g);
  const sg = project.structGraph;
  const cl = (type, value) => [...sg.centerLines].find(c => c.centerLineType === type && c.value === value);
  if (withWall) {
    // 通り芯の外（y=1500）に置く: 昇降路の足元のセル（y 0〜1000）を割らず、EV の複製が足す CL と混ざらない
    const hWall = g.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
    g.addWall(hWall, 0, false, cl(CenterLineType.VERTICAL, 0), 0, cl(CenterLineType.VERTICAL, 2000), 0,
      { isRoomWall: true, isExteriorWall: true });
  }
  if (withEv) {
    g.addEquipmentRow({ id: 'ev1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([keyAt(g, [750, 500])]) });
  }
  for (const gr of graphs) await saveFloor(gr.plane.id, serializeGraph(gr));
  project.activePlaneId = 'p1';
  return { project, graphs, g };
}

async function addLower(project, g, { id = 'b1', followers = lowerFollowers(), ui = makeUi(), floorIo } = {}) {
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.ADD_LOWER, updates: [], sourceGraph: g, ui, ...(floorIo ? { floorIo } : {}),
    addPlane: () => {
      const b = project.addPlane(-3000, '地下1階', id, -1, 1);
      return { plane: b.plane, planes: [b.plane] };
    },
  }, followers);
  return ui;
}

test('【follower 順序】ADD_LOWER: elevatorCopy → stairCopy → basementCenterLines → basementInit → stairVoidReconcile → … → structuralReflect', () => {
  const order = floorOrderFollowers.filter(f => f.appliesTo.includes(FLOOR_ORDER_KIND.ADD_LOWER)).map(f => f.name);
  assert.deepEqual(order, [
    'roofPlaneHeight', 'elevatorCopy', 'stairCopy', 'basementCenterLines', 'basementInit',
    'stairVoidReconcile', 'switchToAddedFloor', 'structuralReflect',
  ]);
  const ins = floorOrderFollowers.filter(f => f.appliesTo.includes(FLOOR_ORDER_KIND.INSERT)).map(f => f.name);
  assert.ok(!ins.includes('basementCenterLines') && !ins.includes('basementInit'), '地階の初期化は INSERT に効かせない');
});

test('【下階追加 1階→地下1階・S造】EV 行（id・番号とも当該階と同じ）・外壁の階固有 CL・階段が写り、部屋・壁は無い。地階構造はラーメン', async () => {
  const { project, g } = await build({ structure: 'S造' });
  assert.equal(project.structuralInfo.basementStructure, null, '前提: 未設定');
  assert.equal(hasCL(g, CenterLineType.HORIZONTAL, 1500), true, '前提: 1階に階固有 CL y=1500');

  const ui = await addLower(project, g);

  const b = await loadGraph(project, 'b1');
  // EV（Q7）: id・番号が当該階と同じ
  assert.deepEqual(b.equipmentRows.map(r => [r.id, r.no, r.category, r.usage]), [['ev1', 1, 'ev', 'passenger']]);
  assert.equal(features(b, RoomFeature.ELEVATOR_EQUIPMENT).length, 1, '昇降路の部屋ができている');
  // 外壁の CL（Q15）: 階固有の y=1500 が写る（壁は写さない）
  assert.equal(hasCL(b, CenterLineType.HORIZONTAL, 1500), true, '外壁の軸の CL が写る');
  assert.equal(b.walls.length, 0, '壁は写さない');
  // 階段（S4）
  assert.equal(b.stairs.length, 1);
  // 部屋は写さない: 階段のペア部屋と昇降路の部屋だけ
  const other = b.rooms.filter(r => r.feature !== RoomFeature.STAIR && r.feature !== RoomFeature.ELEVATOR_EQUIPMENT);
  assert.deepEqual(other.map(r => r.name), [], '屋内の通常の部屋は写さない');
  // 地階構造（Q17・Q19）
  assert.equal(project.structuralInfo.basementStructure, 'RC造(ラーメン)');
  assert.deepEqual(ui.switched, ['b1']);
  // 当該階は変わらない
  assert.equal(g.equipmentRows.length, 1);
  assert.equal(g.walls.length, 1);
});

test('【地階構造の初期値】木造（在来）→壁式 / RC造(壁式)→壁式 / SRC造→ラーメン / RC造(ラーメン)→ラーメン', async () => {
  const expected = [['木造（在来）', 'RC造(壁式)'], ['RC造(壁式)', 'RC造(壁式)'], ['SRC造', 'RC造(ラーメン)'], ['RC造(ラーメン)', 'RC造(ラーメン)']];
  for (const [structure, want] of expected) {
    const { project, g } = await build({ structure });
    await addLower(project, g);
    assert.equal(project.structuralInfo.basementStructure, want, `${structure} → ${want}`);
  }
});

test('【毎回書く】既に壁式でも S造の当該階からの下階追加ならラーメンへ上書き。木造からならラーメン設定済みでも壁式へ', async () => {
  const a = await build({ structure: 'S造' });
  a.project.structuralInfo.setBasementStructure('RC造(壁式)');
  await addLower(a.project, a.g);
  assert.equal(a.project.structuralInfo.basementStructure, 'RC造(ラーメン)', '壁式→ラーメンへ上書き');

  const b = await build({ structure: '木造（在来）' });
  b.project.structuralInfo.setBasementStructure('RC造(ラーメン)');
  await addLower(b.project, b.g);
  assert.equal(b.project.structuralInfo.basementStructure, 'RC造(壁式)', 'ラーメン→壁式へ上書き');
});

test('【階ごとの上書き】当該階の structureOverride が実効の構造として使われる（主構造は木造でも、上書きが S造ならラーメン）', async () => {
  const { project, g } = await build({ structure: '木造（在来）' });
  g.setStructureOverride('S造');
  await addLower(project, g);
  assert.equal(project.structuralInfo.basementStructure, 'RC造(ラーメン)');
});

test('【新しい階が地上階】最下階が2階のとき: 外壁 CL・地階構造は書かない。EV は写す（Q7 は階種別によらない）', async () => {
  const { project } = setupProject(0);
  project.structuralInfo.setField('mainStructure', 'S造');
  const q2 = project.addPlane(0, '2階', 'q2', 2, 1);
  project.addPlane(3000, '3階', 'q3', 3, 1);
  const g = q2.graph;
  const sg = project.structGraph;
  const cl = (type, value) => [...sg.centerLines].find(c => c.centerLineType === type && c.value === value);
  const hWall = g.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  g.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  g.addWall(hWall, 0, false, cl(CenterLineType.VERTICAL, 0), 0, cl(CenterLineType.VERTICAL, 2000), 0, { isRoomWall: true, isExteriorWall: true });
  g.addEquipmentRow({ id: 'evq', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([keyAt(g, [750, 500])]) });
  for (const p of project.planes) await saveFloor(p.id, serializeGraph(project.graphMap.get(p.id)));
  project.activePlaneId = 'q2';

  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.ADD_LOWER, updates: [], sourceGraph: g, ui: makeUi(),
    addPlane: () => { const b = project.addPlane(-3000, '1階', 'q1', 1, 1); return { plane: b.plane, planes: [b.plane] }; },
  }, lowerFollowers());

  const q1 = await loadGraph(project, 'q1');
  assert.equal(project.planeMap.get('q1').startFloor, 1, '前提: 新しい階は地上階');
  assert.equal(project.structuralInfo.basementStructure, null, '地階構造は書かない');
  assert.equal(hasCL(q1, CenterLineType.HORIZONTAL, 1500), false, '外壁の CL は写さない');
  assert.deepEqual(q1.equipmentRows.map(r => r.id), ['evq'], 'EV は写す');
});

test('【当該階に外壁・EV が無い】CL も EV も写さないが、地階構造は書く', async () => {
  const { project, g } = await build({ structure: 'S造', withEv: false, withWall: false });
  await addLower(project, g);
  const b = await loadGraph(project, 'b1');
  assert.equal(b.equipmentRows.length, 0, 'EV 行なし');
  assert.equal(hasCL(b, CenterLineType.HORIZONTAL, 1500), false, '外壁の CL なし');
  assert.equal(project.structuralInfo.basementStructure, 'RC造(ラーメン)');
});

test('【失敗系】copyExteriorCLsToNewFloors: peek の失敗は ERR_BASEMENT_CL_COPY_FAILED で包んで再スロー（地階構造はまだ書かれない）', async () => {
  const { project, g } = await build();
  const boom = new Error('peek 失敗');
  // follower 経由（EV・階段の follower は除き、外壁 CL と地階構造だけ）。CL の写しが先に失敗し、地階構造は書かれない
  await assert.rejects(
    () => addLower(project, g, {
      followers: floorOrderFollowers.filter(f => f.name === 'basementCenterLines' || f.name === 'basementInit'),
      floorIo: { peekFn: async () => { throw boom; } },
    }),
    (e) => e.code === ERR_BASEMENT_CL_COPY_FAILED && e.cause === boom,
  );
  // 直接呼び: 外壁 CL の写しの失敗
  const plane = project.planeMap.get('b1');
  await assert.rejects(
    () => copyExteriorCLsToNewFloors({ project, sourceGraph: g, newPlanes: [plane], peekFn: async () => { throw boom; } }),
    (e) => e.code === ERR_BASEMENT_CL_COPY_FAILED && e.cause === boom,
  );
  assert.equal(project.structuralInfo.basementStructure, null, '失敗した追従より後ろの basementStructure は動かない');
});

test('【失敗系】写し先がアクティブ階なら throw（peek→保存が auto-save に上書きされる）／sourceGraph なしは throw', async () => {
  const { project, g } = await build();
  const active = project.planeMap.get('p1');
  active.startFloor = -1; // 地階扱いにしてアクティブ階を写し先に渡す
  await assert.rejects(() => copyExteriorCLsToNewFloors({ project, sourceGraph: g, newPlanes: [active] }), /写し先がアクティブ階です/);
  active.startFloor = 1;
  await assert.rejects(() => copyExteriorCLsToNewFloors({ project, sourceGraph: null, newPlanes: [] }), /sourceGraph がありません/);
  await assert.rejects(
    () => applyFloorOrderChange(project, {
      kind: FLOOR_ORDER_KIND.ADD_LOWER, updates: [], ui: makeUi(),
      addPlane: () => { const b = project.addPlane(-3000, '地下1階', 'bx', -1, 1); return { plane: b.plane, planes: [b.plane] }; },
    }, floorOrderFollowers.filter(f => f.name === 'basementInit')),
    /basementInit: sourceGraph がありません/,
  );
});

test('collectExteriorWallCLs: 外壁の軸・両端のうち階固有 CL だけを type:value で集める（通り芯・内壁は含めない）', async () => {
  const { g } = await build();
  const inner = g.addCenterLine(CenterLineType.HORIZONTAL, 1700, { labeled: false, discipline: Discipline.ARCH });
  const v0 = [...g.shapeMap.values()].find(s => s.centerLineType === CenterLineType.VERTICAL && s.value === 500);
  g.addWall(inner, 0, false, v0, 0, v0, 0, { isRoomWall: true, isExteriorWall: false });
  assert.deepEqual([...collectExteriorWallCLs(g).keys()], [`${CenterLineType.HORIZONTAL}:1500`]);
});

// ---- INSERT の EV 複製は今のまま ----
test('【INSERT は変えない】1階の上へ挿入: 新しい階へ 1階の EV 行が id・番号ごと写る。elevatorCopy は floorIo を使わない（従来どおり）', async () => {
  const { project, g } = await build({ withWall: false });
  const ins = computeFloorInsert(project.planes, 'p1', 1);
  const ui = makeUi();
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT, updates: ins.updates, sourceGraph: g, newStartFloor: ins.newPlane.startFloor, ui,
    // INSERT の elevatorCopy はこの注入を見ない（見たら peek が throw して落ちる）
    floorIo: { peekFn: async () => { throw new Error('INSERT の elevatorCopy が floorIo を使った'); } },
    addPlane: () => project.addPlane(ins.newPlane.elevation, ins.newPlane.name, 'pIns', ins.newPlane.startFloor, ins.newPlane.stories),
  }, floorOrderFollowers.filter(f => f.name === 'elevatorCopy'));
  const m = await loadGraph(project, 'pIns');
  assert.deepEqual(m.equipmentRows.map(r => [r.id, r.no]), [['ev1', 1]]);
  assert.equal(project.structuralInfo.basementStructure, null, 'INSERT は地階構造を書かない');
});

test('【最下階の地階への即時の上階追加（INSERT の地階分岐）】B1 の上に新しい B1 ができ、元の B1 は B2 へ。EV は元の B1 から写る', async () => {
  const { project } = setupProject(0);
  const b1 = project.addPlane(-3000, '地下1階', 'b1', -1, 1);
  project.addPlane(0, '1階', 'p1', 1, 1);
  const g = b1.graph;
  addPerFloorV([g]);
  g.addEquipmentRow({ id: 'evb', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([keyAt(g, [750, 500])]) });
  for (const p of project.planes) await saveFloor(p.id, serializeGraph(project.graphMap.get(p.id)));
  project.activePlaneId = 'b1';

  const ins = computeFloorInsert(project.planes, 'b1', 1);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT, updates: ins.updates, sourceGraph: g, newStartFloor: ins.newPlane.startFloor, ui: makeUi(),
    addPlane: () => project.addPlane(ins.newPlane.elevation, ins.newPlane.name, 'bNew', ins.newPlane.startFloor, ins.newPlane.stories),
  }, floorOrderFollowers.filter(f => f.name === 'elevatorCopy'));

  assert.deepEqual(project.planes.map(p => [p.id, p.name, p.startFloor]), [
    ['b1', '地下2階', -2], ['bNew', '地下1階', -1], ['p1', '1階', 1],
  ]);
  const n = await loadGraph(project, 'bNew');
  assert.deepEqual(n.equipmentRows.map(r => [r.id, r.no]), [['evb', 1]], '新しい B1 に元の B1 の EV が写る');
});

// ---- undo/redo（withFloorOpUndo が使う levels の往復）----
test('【undo】下階追加の前後で levels を採ると basementStructure の変化が差分になり、before で null（未設定）に戻り、after で再び書かれる', async () => {
  const { project, g } = await build({ structure: 'S造' });
  const levelsBefore = collectProjectLevels(project);
  assert.equal(levelsBefore.basementStructure, null);
  await addLower(project, g);
  const levelsAfter = collectProjectLevels(project);
  assert.equal(levelsAfter.basementStructure, 'RC造(ラーメン)');

  const snap = new Map();
  const diff = diffFloorOpSnapshot({ before: snap, after: snap, metasBefore: [], metasAfter: [], levelsBefore, levelsAfter });
  assert.equal(diff.levelsChanged, true, '地階構造だけの変化でも undo を積む');
  assert.equal(diff.hasChanges, true);

  applyProjectLevels(project, levelsBefore); // undo
  assert.equal(project.structuralInfo.basementStructure, null);
  applyProjectLevels(project, levelsAfter); // redo
  assert.equal(project.structuralInfo.basementStructure, 'RC造(ラーメン)');
});

test('【undo】前の値が壁式だった場合は壁式へ戻る（null への初期化ではない）', async () => {
  const { project, g } = await build({ structure: 'S造' });
  project.structuralInfo.setBasementStructure('RC造(壁式)');
  const levelsBefore = collectProjectLevels(project);
  await addLower(project, g);
  const levelsAfter = collectProjectLevels(project);
  assert.equal(levelsAfter.basementStructure, 'RC造(ラーメン)');
  applyProjectLevels(project, levelsBefore);
  assert.equal(project.structuralInfo.basementStructure, 'RC造(壁式)');
});

test('【他の階操作の undo では初期化されない】地階構造が変わっていない操作の levels 往復は値を保ち、キーの無い旧形の levels は触らない', () => {
  const { project } = setupProject(1);
  project.structuralInfo.setBasementStructure('RC造(壁式)');
  const same = collectProjectLevels(project);
  const diff = diffFloorOpSnapshot({ before: new Map(), after: new Map(), metasBefore: [], metasAfter: [], levelsBefore: same, levelsAfter: collectProjectLevels(project) });
  assert.equal(diff.levelsChanged, false, '変化なしなら levels は差分にならない');
  applyProjectLevels(project, same);
  assert.equal(project.structuralInfo.basementStructure, 'RC造(壁式)');
  applyProjectLevels(project, { glBelow1FlMm: 0 }); // basementStructure キー無し（旧形）
  assert.equal(project.structuralInfo.basementStructure, 'RC造(壁式)', '旧形の levels は地階構造を触らない');
});
