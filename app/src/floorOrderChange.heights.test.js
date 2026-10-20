// 階設定表の確定（FLOOR_ORDER_KIND.HEIGHTS。階設定表 S4）の追従処理の不変条件。
// 3階建て以上の fixture で、変更階が最下階・中間・最上階の各場合に、
//   - 追従の順序と回数（roofPlaneHeight → wallRefresh → structuralReflect。構造反映が二重にならない）
//   - 壁の再生成は鍵（fh＝階高）が変わった階だけ・自階は他階の前に IDB へ書く
// を確かめる。他階の peek／保存は本番同型（new PlanGraph(plane)→_structGraph→restoreGraph、保存は Map ストア）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlanGraph, CenterLineType, Discipline } from './core.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from './floorOrderChange.js';
import { computeFloorHeightEdit } from './floorHeights.js';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import { regenerateWalls, loadMaterialMap } from './finish/wallRegeneration.js';
import { wallFreshnessKey } from './finish/wallFreshnessKey.js';
import { serializeGraph, restoreGraph } from './graphSnapshot.js';

function addRectRoom(graph, name) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  return graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
}

async function seedWalls(graph, project) {
  const materialMap = await loadMaterialMap();
  await regenerateWalls(graph, { materialMap, project, stairUnderEntries: [], extraStairOpenings: [] });
  graph.setWallFreshnessKey(wallFreshnessKey(graph, project));
}

/** p1(0)・p2(3000)・p3(6000)の3階。p1 がアクティブ。各階に部屋と壁（鍵は一致）。非アクティブ階は Map ストアに保存。 */
async function makeThreeFloors() {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0,    '1階', 'p1', 1, 1);
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2', 2, 1);
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3', 3, 1);
  project.activePlaneId = 'p1';
  for (const [g, n] of [[g1, '1F'], [g2, '2F'], [g3, '3F']]) { addRectRoom(g, n); await seedWalls(g, project); }
  const store = new Map([['p2', serializeGraph(g2)], ['p3', serializeGraph(g3)]]);
  return { project, g1, store };
}

function makeIo(project, store, log) {
  const peekFn = async (plane) => {
    const g = new PlanGraph(plane);
    g._structGraph = project.structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
  return {
    peekFn,
    saveFloorFn: async (planeId, bytes) => { store.set(planeId, bytes); log.push(planeId); },
  };
}

function decode(project, store, id) {
  const g = new PlanGraph(project.planeMap.get(id));
  g._structGraph = project.structGraph;
  restoreGraph(g, store.get(id));
  return g;
}

const ui = { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} };

// 本番の floorSwapManager.peek（構造反映が使う）も同じ Map ストアへ向ける。
async function withStubbedSwap(io, fn) {
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => io.peekFn(plane);
  try { return await fn(); } finally { floorSwapManager.peek = original; }
}

/** 階高編集 → 確定（applyFloorOrderChange HEIGHTS）。呼ばれた追従の名前と構造反映（clearMemberNumberIndex）の回数を返す。 */
async function confirm(project, store, heights) {
  const edit = computeFloorHeightEdit(project.planes, { heights: new Map(Object.entries(heights)) }, 2900, 0);
  assert.ok(edit.ok);
  const log = [];
  const io = makeIo(project, store, log);
  const calls = [];
  const followers = floorOrderFollowers.map(f => ({
    ...f, run: async (ctx) => { calls.push(f.name); return f.run(ctx); },
  }));
  let reflects = 0;
  const orig = project.clearMemberNumberIndex.bind(project);
  project.clearMemberNumberIndex = () => { reflects++; return orig(); };
  await withStubbedSwap(io, () => applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, ui, floorIo: io,
  }, followers));
  return { edit, log, calls, reflects };
}

test('HEIGHTS に適用される追従は roofPlaneHeight → stairRiserFollow → wallRefresh → structuralReflect の順だけ', () => {
  const names = floorOrderFollowers.filter(f => f.appliesTo.includes(FLOOR_ORDER_KIND.HEIGHTS)).map(f => f.name);
  assert.deepEqual(names, ['roofPlaneHeight', 'stairRiserFollow', 'wallRefresh', 'structuralReflect']);
});

test('HEIGHTS 中間階(2階)の階高変更: 3階だけ上へずれ、2階だけ壁を再生成（1・3階は鍵一致）。自階の保存が他階より先・構造反映は1回', async () => {
  const { project, store } = await makeThreeFloors();
  const keyBefore = { p2: decode(project, store, 'p2').wallFreshnessKey, p3: decode(project, store, 'p3').wallFreshnessKey };
  const { edit, log, calls, reflects } = await confirm(project, store, { p2: 3200 });

  assert.deepEqual(edit.updates.map(u => [u.id, u.elevation]), [['p3', 6200]]);
  assert.equal(project.planeMap.get('p1').elevation, 0);
  assert.equal(project.planeMap.get('p2').elevation, 3000);
  assert.equal(project.planeMap.get('p3').elevation, 6200);
  assert.deepEqual(calls, ['roofPlaneHeight', 'stairRiserFollow', 'wallRefresh', 'structuralReflect']);
  // 自階(p1)は他階の処理の前に1回、壁を作り直した p2 だけが保存される（p3 は鍵一致で保存されない）
  assert.deepEqual(log.filter(id => id === 'p1'), ['p1']);
  assert.ok(log.indexOf('p1') < log.indexOf('p2'));
  assert.equal(log.filter(id => id === 'p2').length >= 1, true);
  assert.ok(!log.includes('p3'), `p3 は保存されない: ${log}`);
  const p2 = decode(project, store, 'p2');
  assert.notEqual(p2.wallFreshnessKey, keyBefore.p2, 'p2 の鍵(fh)が更新された');
  assert.equal(p2.wallFreshnessKey, wallFreshnessKey(p2, project));
  assert.equal(decode(project, store, 'p3').wallFreshnessKey, keyBefore.p3);
  assert.equal(reflects, 1, '壁を作り直した後の構造反映は1回（structuralReflect は印で省かれる）');
});

test('HEIGHTS 最下階(1階)の階高変更: 1階（アクティブ）の壁を作り直す。2・3階は動くが鍵は一致', async () => {
  const { project, g1, store } = await makeThreeFloors();
  const keyBefore = g1.wallFreshnessKey;
  const { edit, log, reflects } = await confirm(project, store, { p1: 3300 });

  assert.deepEqual(edit.updates.map(u => [u.id, u.elevation]), [['p2', 3300], ['p3', 6300]]);
  assert.notEqual(g1.wallFreshnessKey, keyBefore);
  assert.equal(g1.wallFreshnessKey, wallFreshnessKey(g1, project));
  assert.ok(!log.includes('p3'));
  assert.equal(reflects, 1);
});

test('HEIGHTS 最上階(3階)の階高だけ変更: elevation 不変・topStoryHeightMm のみ・鍵不変で壁は再生成されず、構造反映は structuralReflect が1回', async () => {
  const { project, store } = await makeThreeFloors();
  const { edit, log, calls, reflects } = await confirm(project, store, { p3: 2600 });

  assert.deepEqual(edit.updates.map(u => [u.id, u.elevation, u.topStoryHeightMm]), [['p3', 6000, 2600]]);
  assert.equal(project.planeMap.get('p3').topStoryHeightMm, 2600);
  assert.deepEqual(log, ['p1'], '自階の書込みのみ。壁を作り直した階が無いので他階は保存されない');
  assert.deepEqual(calls, ['roofPlaneHeight', 'stairRiserFollow', 'wallRefresh', 'structuralReflect']);
  assert.equal(reflects, 1, '壁が変わらなければ structuralReflect が構造反映を1回行う');
});

test('【失敗系】HEIGHTS: 階高に変化が無い確定（updates 空。GL だけの変更も同じ）は壁も構造も触らず、何も保存しない', async () => {
  const { project, store } = await makeThreeFloors();
  const { edit, log, calls, reflects } = await confirm(project, store, { p2: 3000 });
  assert.deepEqual(edit.updates, []);
  assert.deepEqual(log, []);
  assert.equal(reflects, 0);
  assert.deepEqual(calls, ['roofPlaneHeight', 'stairRiserFollow', 'wallRefresh', 'structuralReflect'], '追従は呼ばれるが中で発火しない');
});

test('skipActiveWalls: 自階の壁は作り直さず、構造反映は structuralReflect が1回行う。自階は他階の前に1回保存される', async () => {
  const { project, g1, store } = await makeThreeFloors();
  const keyBefore = g1.wallFreshnessKey;
  const edit = computeFloorHeightEdit(project.planes, { heights: new Map([['p1', 3300]]) }, 2900, 0);
  const log = [];
  const io = makeIo(project, store, log);
  let reflects = 0;
  const orig = project.clearMemberNumberIndex.bind(project);
  project.clearMemberNumberIndex = () => { reflects++; return orig(); };
  await withStubbedSwap(io, () => applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, ui, floorIo: io, skipActiveWalls: true,
  }));
  assert.equal(g1.wallFreshnessKey, keyBefore, '自階の鍵は更新されない（仕上げ脱出に任せる）');
  assert.deepEqual(log, ['p1'], '自階を1回保存しただけ（他階は鍵一致で保存されない）');
  assert.equal(reflects, 1, '印が立たないので structuralReflect が構造反映を1回行う');
});

test('skipActiveWalls: 自階と直上階を同時に変えると、直上階の再生成が peek する自階は保存済みの新しい自階', async () => {
  const { project, store } = await makeThreeFloors();
  const edit = computeFloorHeightEdit(project.planes, { heights: new Map([['p1', 3300], ['p2', 3200]]) }, 2900, 0);
  const events = [];
  const log = [];
  const base = makeIo(project, store, log);
  const io = {
    peekFn: async (plane) => { events.push('peek:' + plane.id + (plane.id === 'p1' ? ':' + (store.get('p1') ? 'saved' : 'none') : '')); return base.peekFn(plane); },
    saveFloorFn: async (id, bytes) => { events.push('save:' + id); return base.saveFloorFn(id, bytes); },
  };
  await withStubbedSwap(io, () => applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, ui, floorIo: io, skipActiveWalls: true,
  }));
  assert.equal(events.filter(e => e === 'save:p1').length, 1, '自階の保存は1回');
  assert.ok(events.indexOf('save:p1') < events.indexOf('save:p2'), events.join(' '));
  assert.ok(!events.includes('peek:p1:none'), '保存前の自階を peek していない: ' + events.join(' '));
  assert.ok(events.some(e => e === 'peek:p1:saved') || !events.some(e => e.startsWith('peek:p1')), events.join(' '));
  assert.ok(events.includes('save:p2'), 'p2 の壁は作り直されて保存された');
});

test('【失敗系】wallRefresh が reject（自階の保存が throw）: applyFloorOrderChange も reject し structuralReflect は呼ばれない。elevation は書かれたまま', async () => {
  const { project, store } = await makeThreeFloors();
  const edit = computeFloorHeightEdit(project.planes, { heights: new Map([['p2', 3200]]) }, 2900, 0);
  const log = [];
  const base = makeIo(project, store, log);
  const io = { peekFn: base.peekFn, saveFloorFn: async () => { throw new Error('保存失敗'); } };
  const calls = [];
  const followers = floorOrderFollowers.map(f => ({ ...f, run: async (ctx) => { calls.push(f.name); return f.run(ctx); } }));
  await assert.rejects(
    withStubbedSwap(io, () => applyFloorOrderChange(project, {
      kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, ui, floorIo: io,
    }, followers)),
    /保存失敗/,
  );
  assert.deepEqual(calls, ['roofPlaneHeight', 'stairRiserFollow', 'wallRefresh'], 'structuralReflect は呼ばれない');
  assert.equal(project.planeMap.get('p3').elevation, 6200, 'elevation は書かれた状態で止まる（呼び出し側が巻き戻す）');
});
