// 上に階を追加して最上階が入れ替わったときの主屋根の引き継ぎ（mainRoofFloorSync.js）のテスト。ステップ B3。
// peek は本番同型（保存バイト列から PlanGraph を復元する makeStorePeek。生きたグラフは返さない）、
// 保存は makeStoreSave（呼ばれた planeId を記録する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, RoofSpec, isDefaultRoofSpec } from '@core';
import { serializeGraph } from '../../graphSnapshot.js';
import { carryMainRoofToNewTop } from './mainRoofFloorSync.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from '../../floorOrderChange.js';
import { applyPlaneMetas, collectPlaneMetas, diffFloorOpSnapshot } from '../../floorOps.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../equipment/equipmentTestFixtures.js';
import { NON_DEFAULT_ROOF_SPEC } from '../roofTestFixtures.js';

/** 階を count 個持つ project。1階がアクティブ。 */
function makeProject(count) {
  const project = new Project('p', 'test');
  for (let i = 1; i <= count; i++) project.addPlane((i - 1) * 3000, `${i}階`, `f${i}`, i);
  return project;
}

const setNonDefault = (graph, data = NON_DEFAULT_ROOF_SPEC) => graph.setMainRoofSpec(RoofSpec.fromData(data));

test('【B3】上に階を追加（旧最上階がアクティブ）: 新しい最上階の主屋根＝旧最上階の値（保存バイト列を復号して確認）。旧最上階の値は残る', async () => {
  const project = makeProject(1);
  const g1 = project.graphMap.get('f1');
  setNonDefault(g1);
  const newPlane = project.addPlane(3000, '2階', 'f2', 2).plane; // 追加した新しい最上階（IDB には何も無い）
  const store = new Map();
  const log = [];
  const result = await carryMainRoofToNewTop(project, newPlane, makeStorePeek(project, store), makeStoreSave(store, log));

  assert.equal(result, 'carried');
  assert.deepEqual(log, ['f2'], '保存は新しい最上階へ1回だけ');
  const decoded = decodeFloor(project, newPlane, store.get('f2'));
  assert.deepEqual(decoded.mainRoofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC }, '全9項目が写る');
  assert.deepEqual(g1.mainRoofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC }, '旧最上階の値は残る（消さない）');
  assert.equal(store.has('f1'), false, '旧最上階には何も書かない');
  assert.notEqual(decoded.mainRoofSpec, g1.mainRoofSpec, '同じオブジェクトを共有しない（別の RoofSpec）');
});

test('【B3】旧最上階が既定値のままなら何も書かない（保存の発火回数 0・peek もしない新階は触らない）', async () => {
  const project = makeProject(1);
  const newPlane = project.addPlane(3000, '2階', 'f2', 2).plane;
  const store = new Map();
  const log = [];
  const peeked = [];
  const peek = makeStorePeek(project, store);
  const result = await carryMainRoofToNewTop(project, newPlane, (p) => { peeked.push(p.id); return peek(p); }, makeStoreSave(store, log));
  assert.equal(result, 'default');
  assert.equal(log.length, 0);
  assert.equal(store.size, 0);
  assert.deepEqual(peeked, [], 'アクティブな旧最上階は生きたグラフを読む（peek しない）。新階も peek しない');
});

test('【B3】旧最上階が非アクティブでも引き継ぐ（旧最上階は保存バイト列から peek で読む）', async () => {
  const project = makeProject(2); // 1階がアクティブ。2階（旧最上階）は非アクティブ
  const g2 = project.graphMap.get('f2');
  setNonDefault(g2, { ...NON_DEFAULT_ROOF_SPEC, note: '2階の主屋根' });
  const store = new Map([['f2', serializeGraph(g2)]]);
  const newPlane = project.addPlane(6000, '3階', 'f3', 3).plane;
  const log = [];
  const result = await carryMainRoofToNewTop(project, newPlane, makeStorePeek(project, store), makeStoreSave(store, log));
  assert.equal(result, 'carried');
  assert.deepEqual(log, ['f3']);
  assert.equal(decodeFloor(project, newPlane, store.get('f3')).mainRoofSpec.note, '2階の主屋根');
});

test('【B3】新階に先に書かれた内容（階段の上階同期など）は保たれる: 保存バイト列から読み直して主屋根だけを足す', async () => {
  const project = makeProject(1);
  setNonDefault(project.graphMap.get('f1'));
  const newPlane = project.addPlane(3000, '2階', 'f2', 2).plane;
  // 先行する follower が新階へ部屋を書いて保存済みの状態
  const pre = decodeFloor(project, newPlane, undefined);
  pre.addRoom(new Set(['a:b:c:d']), '2階の部屋');
  const store = new Map([['f2', serializeGraph(pre)]]);
  await carryMainRoofToNewTop(project, newPlane, makeStorePeek(project, store), makeStoreSave(store));
  const decoded = decodeFloor(project, newPlane, store.get('f2'));
  assert.equal(decoded.rooms.length, 1, '先に書かれた部屋は残る');
  assert.equal(decoded.mainRoofSpec.note, NON_DEFAULT_ROOF_SPEC.note);
});

test('【B3】途中階への追加（追加した階が最上階にならない）では写さない。最下階の下への追加でも写さない', async () => {
  // 途中階: 1階・追加階（elevation 3000）・旧2階（最上階。elevation 6000）
  const project = makeProject(1);
  const top = project.addPlane(6000, '3階', 'f3', 3).plane;
  setNonDefault(project.graphMap.get('f3'));
  const mid = project.addPlane(3000, '2階', 'f2', 2).plane;
  const store = new Map();
  const log = [];
  const peeked = [];
  const peek = makeStorePeek(project, store);
  const counting = (p) => { peeked.push(p.id); return peek(p); };
  assert.equal(await carryMainRoofToNewTop(project, mid, counting, makeStoreSave(store, log)), 'notTop');
  assert.ok(top);

  // 最下階の下への追加: 新しい階の elevation が最小
  const lower = project.addPlane(-3000, '地階', 'f0', -1).plane;
  assert.equal(await carryMainRoofToNewTop(project, lower, counting, makeStoreSave(store, log)), 'notTop');
  assert.equal(log.length, 0);
  assert.deepEqual(peeked, []);
  assert.equal(isDefaultRoofSpec(project.graphMap.get('f2').mainRoofSpec), true);
});

test('【B3・失敗系】追加階が無い（null）・階が1つだけ（旧最上階が無い）なら何もしない（例外にならない）', async () => {
  const project = makeProject(1);
  const store = new Map();
  const log = [];
  const save = makeStoreSave(store, log);
  const peek = makeStorePeek(project, store);
  assert.equal(await carryMainRoofToNewTop(project, null, peek, save), 'notTop');
  assert.equal(await carryMainRoofToNewTop(project, project.planeMap.get('f1'), peek, save), 'notTop', '階が1つだけ');
  assert.equal(log.length, 0);
});

test('【B3・失敗系】新階への保存が失敗したら例外がそのまま伝わる（黙って握りつぶさない）。旧最上階は変わらない', async () => {
  const project = makeProject(1);
  const g1 = project.graphMap.get('f1');
  setNonDefault(g1);
  const newPlane = project.addPlane(3000, '2階', 'f2', 2).plane;
  const store = new Map();
  await assert.rejects(
    carryMainRoofToNewTop(project, newPlane, makeStorePeek(project, store), makeStoreSave(store, [], { failOn: 'f2' })),
    /意図した失敗/,
  );
  assert.deepEqual(g1.mainRoofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
  assert.equal(store.size, 0);
});

test('【B3】階の並べ替え（REORDER）では写さない: 並べ替えで最上階が入れ替わっても、新しい最上階は自分の値のまま', async () => {
  const project = makeProject(3);
  setNonDefault(project.graphMap.get('f2'), { ...NON_DEFAULT_ROOF_SPEC, note: '2階の値' });
  const carryOnly = floorOrderFollowers.filter(f => f.name === 'mainRoofCarry');
  assert.equal(carryOnly.length, 1);
  // 2階と3階を入れ替える（f2 が最上階になる）
  const updates = [
    { id: 'f3', name: '2階', startFloor: 2, elevation: 3000 },
    { id: 'f2', name: '3階', startFloor: 3, elevation: 6000 },
  ];
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.REORDER, updates, sourceGraph: project.activeGraph,
    ui: { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} },
  }, carryOnly);
  assert.equal(project.planes[project.planes.length - 1].id, 'f2');
  assert.equal(project.graphMap.get('f2').mainRoofSpec.note, '2階の値', '最上階になった f2 は自分の値のまま');
  assert.equal(isDefaultRoofSpec(project.graphMap.get('f3').mainRoofSpec), true, '旧最上階 f3 の値（既定）も写らない');
});

test('【B3・V4】階追加の undo 記録（diffFloorOpSnapshot の before/after）に、新しい最上階の書込み（主屋根を含むバイト列）が追加階として含まれる', async () => {
  const project = makeProject(1);
  const g1 = project.graphMap.get('f1');
  setNonDefault(g1);
  const before = new Map([['f1', serializeGraph(g1)]]);
  const metasBefore = collectPlaneMetas(project);

  const newPlane = project.addPlane(3000, '2階', 'f2', 2).plane;
  const store = new Map([['f1', before.get('f1')]]);
  await carryMainRoofToNewTop(project, newPlane, makeStorePeek(project, store), makeStoreSave(store));
  const after = new Map([['f1', serializeGraph(g1)], ['f2', store.get('f2')]]);
  const metasAfter = collectPlaneMetas(project);

  const diff = diffFloorOpSnapshot({ before, after, metasBefore, metasAfter });
  assert.deepEqual(diff.addedPlanes.map(p => p.id), ['f2']);
  assert.equal(diff.changedSiblings.length, 0, '旧最上階 f1 のバイト列は変わらない（undo で戻すものが無い）');
  assert.equal(diff.hasChanges, true);
  // redo が saveFloor する追加階のバイト列（addedBytes）に主屋根が入っている
  const addedBytes = after.get('f2');
  assert.equal(decodeFloor(project, newPlane, addedBytes).mainRoofSpec.note, NON_DEFAULT_ROOF_SPEC.note);

  // undo で追加階が消えれば、旧最上階の値だけが残る（新階の値は新階ごと消える）
  project.removePlane('f2');
  applyPlaneMetas(project, metasBefore);
  assert.deepEqual(project.graphMap.get('f1').mainRoofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
  assert.equal(project.planeMap.has('f2'), false);
});
