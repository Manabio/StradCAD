// 階設定表 S5 の失敗時の巻き戻し（floorOps.js rollbackFloorOp）と、屋根専用平面の追従の回帰テスト。
// App.jsx の withFloorOpUndo はこの関数を呼ぶ（配線は App.wiring.floorHeights.test.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from './core.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from './floorOrderChange.js';
import { computeFloorHeightEdit, resolveTopStoryHeightMm } from './floorHeights.js';
import {
  collectPlaneMetas, applyPlaneMetas, collectProjectLevels, rollbackFloorOp,
  computeFloorInsert,
} from './floorOps.js';
import { followRoofPlaneToTop } from './structural/roofPlane.js';

function makeProject() {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  project.addPlane(6001, '小屋伏', 'roof', 3, 1, false, null, 0, true, 'p3');
  project.activePlaneId = 'p1';
  return project;
}
const ui = { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} };
const roofOnly = floorOrderFollowers.filter(f => f.name === 'roofPlaneHeight');
const state = (project) => ({
  elevations: Object.fromEntries(project.planes.map(p => [p.id, p.elevation])),
  gl: project.glBelow1FlMm,
  roof: project.roofPlane.elevation,
});
const bytes = (...v) => new Uint8Array(v);
const followRoof = (p) => followRoofPlaneToTop(p);

/** 操作前の採取 → 「p2 の階高 +200・GL 500」を書く（追従は屋根のみ）。 */
async function editLikeHeights(project) {
  const metasBefore = collectPlaneMetas(project);
  const levelsBefore = collectProjectLevels(project);
  const edit = computeFloorHeightEdit(project.planes, { heights: { p2: 3200 }, glBelow1FlMm: 500 }, resolveTopStoryHeightMm(project), 0);
  project.setGlBelow1FlMm(edit.glBelow1FlMm);
  await applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, ui }, roofOnly);
  return { metasBefore, levelsBefore };
}

function recorder() {
  const calls = { apply: [], save: [], del: [], after: 0 };
  return {
    calls,
    io: {
      applyBytes: (_p, id, b) => calls.apply.push([id, b]),
      // 書込みは遅れて完了する（await しない巻き戻しだと、rollbackFloorOp の解決時点でまだ記録されない）
      saveFloorFn: async (id, b) => { await new Promise(r => setTimeout(r, 5)); calls.save.push([id, b]); },
      deleteFloorFn: async (id) => { await new Promise(r => setTimeout(r, 5)); calls.del.push(id); },
      afterApply: () => { calls.after++; },
    },
  };
}

test('rollbackFloorOp: 例外の後、メタ・GL・屋根平面が戻り、バイト列が変わった非アクティブ階(p2)だけ IDB へ1回 await で書戻す。afterApply は1回', async () => {
  const project = makeProject();
  const s0 = state(project);
  const before = new Map([['p1', bytes(1)], ['p2', bytes(2)], ['p3', bytes(3)]]);
  const { metasBefore, levelsBefore } = await editLikeHeights(project);
  assert.equal(project.roofPlane.elevation, 6201);
  const failedAfter = new Map([['p1', bytes(1)], ['p2', bytes(9)], ['p3', bytes(3)]]); // p2 だけ変わった
  const { calls, io } = recorder();
  await rollbackFloorOp(project, { before, metasBefore, levelsBefore, collectBytes: async () => failedAfter, followRoof, ...io });
  assert.deepEqual(state(project), s0);
  assert.deepEqual(calls.save, [['p2', bytes(2)]]);
  assert.deepEqual(calls.apply, []); // p2 は非アクティブ（メモリへは戻さない）
  assert.deepEqual(calls.del, []);
  assert.equal(calls.after, 1);
});

test('rollbackFloorOp: アクティブ階はメモリ(applyBytes)と IDB(save)の両方へ操作前のバイト列を書く', async () => {
  const project = makeProject();
  project.activePlaneId = 'p1';
  const before = new Map([['p1', bytes(1)], ['p2', bytes(2)]]);
  const { metasBefore, levelsBefore } = await editLikeHeights(project);
  const { calls, io } = recorder();
  await rollbackFloorOp(project, {
    before, metasBefore, levelsBefore, followRoof,
    collectBytes: async () => new Map([['p1', bytes(7)], ['p2', bytes(2)]]), ...io,
  });
  assert.deepEqual(calls.apply, [['p1', bytes(1)]]);
  assert.deepEqual(calls.save, [['p1', bytes(1)]]);
  assert.equal(calls.after, 1);
});

test('rollbackFloorOp: 操作前に未保存(null)だった階は IDB のレコードを消す。変わっていない階には何もしない', async () => {
  const project = makeProject();
  const before = new Map([['p2', null], ['p3', bytes(3)]]);
  const { metasBefore, levelsBefore } = await editLikeHeights(project);
  const { calls, io } = recorder();
  await rollbackFloorOp(project, {
    before, metasBefore, levelsBefore, followRoof,
    collectBytes: async () => new Map([['p2', bytes(5)], ['p3', bytes(3)]]), ...io,
  });
  assert.deepEqual(calls.del, ['p2']);
  assert.deepEqual(calls.save, []);
});

test('【失敗系】rollbackFloorOp: バイト列の採取が失敗しても、メタ・GL・屋根平面は先に戻り、afterApply も呼ばれ、例外は伝わる', async () => {
  const project = makeProject();
  const s0 = state(project);
  const { metasBefore, levelsBefore } = await editLikeHeights(project);
  const { calls, io } = recorder();
  await assert.rejects(
    rollbackFloorOp(project, {
      before: new Map(), metasBefore, levelsBefore, followRoof,
      collectBytes: async () => { throw new Error('collect failed'); }, ...io,
    }),
    /collect failed/,
  );
  assert.deepEqual(state(project), s0);
  assert.equal(calls.after, 1);
});

test('【失敗系】追従が途中で失敗（roofPlaneHeight の後に必ず例外を投げる追従）しても、巻き戻しでメタと屋根平面の elevation が元に戻る', async () => {
  const project = makeProject();
  const s0 = state(project);
  const metasBefore = collectPlaneMetas(project);
  const levelsBefore = collectProjectLevels(project);
  const edit = computeFloorHeightEdit(project.planes, { heights: { p2: 3200 }, glBelow1FlMm: 500 }, resolveTopStoryHeightMm(project), 0);
  project.setGlBelow1FlMm(edit.glBelow1FlMm);
  const failing = { name: 'boom', appliesTo: [FLOOR_ORDER_KIND.HEIGHTS], run() { throw new Error('follower failed'); } };
  await assert.rejects(
    applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, ui }, [...roofOnly, failing]),
    /follower failed/,
  );
  assert.equal(project.planeMap.get('p3').elevation, 6200); // 失敗時点では書かれたまま
  assert.equal(project.roofPlane.elevation, 6201);
  const { io } = recorder();
  await rollbackFloorOp(project, { before: new Map(), metasBefore, levelsBefore, followRoof, collectBytes: async () => new Map(), ...io });
  assert.deepEqual(state(project), s0);
});

// ---- 屋根専用平面の追従（階操作の undo/redo の回帰。App.jsx の undoFloorOp/redoFloorOp と同じ順）----

async function insertAbove(project, currentId) {
  const metasBefore = collectPlaneMetas(project);
  const { newPlane, updates } = computeFloorInsert(project.planes, currentId, 1, { topHeightMm: resolveTopStoryHeightMm(project) });
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT, updates, ui, newStartFloor: newPlane.startFloor,
    addPlane: () => project.addPlane(newPlane.elevation, newPlane.name, 'new', newPlane.startFloor, newPlane.stories,
      false, null, 0, false, null, newPlane.planCutHeightMm, newPlane.ceilingCutHeightMm, newPlane.topStoryHeightMm),
  }, roofOnly);
  return { metasBefore, metasAfter: collectPlaneMetas(project), added: collectPlaneMetas(project).find(m => m.id === 'new') };
}
function undoInsert(project, { metasBefore }) {
  project.removePlane('new');
  applyPlaneMetas(project, metasBefore);
  followRoofPlaneToTop(project);
}
function redoInsert(project, { metasAfter, added }) {
  applyPlaneMetas(project, metasAfter);
  project.addPlane(added.elevation, added.name, added.id, added.startFloor, added.stories, false, null, 0, false, null,
    added.planCutHeightMm, added.ceilingCutHeightMm, added.topStoryHeightMm);
  followRoofPlaneToTop(project);
}

test('回帰: 屋根平面が p3 に乗った状態で途中階(1階の上)へ挿入 → undo → redo で屋根平面の elevation は 6001 → 9001 → 6001 → 9001', async () => {
  const project = makeProject();
  assert.equal(project.roofPlane.elevation, 6001);
  const c = await insertAbove(project, 'p1');
  assert.equal(project.planeMap.get('p3').elevation, 9000);
  assert.equal(project.roofPlane.elevation, 9001);
  undoInsert(project, c);
  assert.equal(project.roofPlane.elevation, 6001);
  redoInsert(project, c);
  assert.equal(project.roofPlane.elevation, 9001);
});

test('回帰: 最上階(p3)の上への挿入 → undo → redo で屋根平面は p3 に乗ったまま 6001 から動かない（誤った階へ動かない）', async () => {
  const project = makeProject();
  const c = await insertAbove(project, 'p3');
  assert.equal(project.roofPlane.roofForPlaneId, 'p3');
  assert.equal(project.roofPlane.elevation, 6001);
  undoInsert(project, c);
  assert.equal(project.roofPlane.roofForPlaneId, 'p3');
  assert.equal(project.roofPlane.elevation, 6001);
  redoInsert(project, c);
  assert.equal(project.roofPlane.roofForPlaneId, 'p3');
  assert.equal(project.roofPlane.elevation, 6001);
});
