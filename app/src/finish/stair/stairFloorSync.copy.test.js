// finish/stair/stairFloorSync.js copyStairsToNewFloors（階追加で当該階の階段を新しい各階へ写す I/O ラッパー）。
// peek は本番同型（バイト列から restoreGraph。生きたグラフを返さない）。S4（2026-10-21）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType, RoomFeature } from '../../core.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { ensureStairRooms } from '../roomReinterpret.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../equipment/equipmentTestFixtures.js';
import { ERR_STAIR_COPY_FAILED, floorTransitionErrorMessage } from '../../error.js';
import { copyStairsToNewFloors } from './stairFloorSync.js';
import { setupProject, addPerFloorV, keyAt, LEFT_HALF } from './stairRemovalTestFixtures.js';

// p1（階段あり・アクティブ）の上に新しい階 p2・p3（空）。新しい階は IDB（store）に未保存。
function setup({ withStair = true } = {}) {
  const { project, graphs } = setupProject(3);
  const [g1] = graphs;
  addPerFloorV([g1]);
  if (withStair) {
    g1.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(g1, LEFT_HALF[0])]), upDirection: 'up', totalSteps: 12, tread: 250 });
    ensureStairRooms(g1);
  }
  project.activePlaneId = 'p1';
  const store = new Map();
  const peekLog = [];
  const savedLog = [];
  const realPeek = makeStorePeek(project, store);
  const peekFn = (p) => { peekLog.push(p.id); return realPeek(p); };
  const saveFloorFn = makeStoreSave(store, savedLog);
  return { project, g1, store, peekLog, savedLog, peekFn, saveFloorFn, planes: [project.planeMap.get('p2'), project.planeMap.get('p3')] };
}

test('当該階に階段が無い: noop で、新しい階を peek も保存もしない', async () => {
  const s = setup({ withStair: false });
  const r = await copyStairsToNewFloors({ project: s.project, sourceGraph: s.g1, newPlanes: s.planes, peekFn: s.peekFn, saveFloorFn: s.saveFloorFn });
  assert.deepEqual(r, { status: 'noop' });
  assert.deepEqual(s.peekLog, []);
  assert.deepEqual(s.savedLog, []);
});

test('新しい階が2つ: 各階で peek 1回・保存1回（値ごとに peek しない）、どちらにも階段が入る', async () => {
  const s = setup();
  const r = await copyStairsToNewFloors({ project: s.project, sourceGraph: s.g1, newPlanes: s.planes, peekFn: s.peekFn, saveFloorFn: s.saveFloorFn });
  assert.equal(r.status, 'copied');
  assert.deepEqual(s.peekLog, ['p2', 'p3']);
  assert.deepEqual(s.savedLog, ['p2', 'p3']);
  for (const p of s.planes) {
    const g = decodeFloor(s.project, p, s.store.get(p.id));
    assert.equal(g.stairs.length, 1, `${p.id} に階段`);
    assert.equal(g.rooms.filter(x => x.feature === RoomFeature.STAIR).length, 1, `${p.id} にペア部屋`);
  }
  assert.equal(r.perPlane.length, 2);
  assert.ok(r.perPlane.every(x => x.copied.length === 1 && x.skipped.length === 0));
});

test('【失敗系】peek が reject: ERR_STAIR_COPY_FAILED のコード付きで再スロー（利用者向け文言になる）', async () => {
  const s = setup();
  const peekFn = async () => { throw new Error('IDB が読めない'); };
  await assert.rejects(
    () => copyStairsToNewFloors({ project: s.project, sourceGraph: s.g1, newPlanes: s.planes, peekFn, saveFloorFn: s.saveFloorFn }),
    (err) => err.code === ERR_STAIR_COPY_FAILED && floorTransitionErrorMessage(err) === '階段の複製に失敗しました。',
  );
  assert.deepEqual(s.savedLog, []);
});

test('【失敗系】保存が reject: ERR_STAIR_COPY_FAILED のコード付きで再スロー', async () => {
  const s = setup();
  const saveFloorFn = makeStoreSave(s.store, s.savedLog, { failOn: 'p3' });
  await assert.rejects(
    () => copyStairsToNewFloors({ project: s.project, sourceGraph: s.g1, newPlanes: s.planes, peekFn: s.peekFn, saveFloorFn }),
    (err) => err.code === ERR_STAIR_COPY_FAILED,
  );
  assert.deepEqual(s.savedLog, ['p2'], '失敗した階の手前までは保存済み（巻き戻しは階追加の undo に任せる）');
});

test('【失敗系】写し先がアクティブ階: 素の例外（peek→保存が auto-save に上書きされるため）。peek も保存もしない', async () => {
  const s = setup();
  s.project.activePlaneId = 'p2';
  await assert.rejects(
    () => copyStairsToNewFloors({ project: s.project, sourceGraph: s.g1, newPlanes: s.planes, peekFn: s.peekFn, saveFloorFn: s.saveFloorFn }),
    (err) => err.code === undefined && /アクティブ階/.test(err.message),
  );
  assert.deepEqual(s.peekLog, []);
});

test('【失敗系】sourceGraph が無ければ例外', async () => {
  const s = setup();
  await assert.rejects(
    () => copyStairsToNewFloors({ project: s.project, sourceGraph: null, newPlanes: s.planes, peekFn: s.peekFn, saveFloorFn: s.saveFloorFn }),
    /sourceGraph/,
  );
});

test('置けない階段だけの階: skipped に積み、CL が増えなければ保存しない', async () => {
  const s = setup();
  // p2 の足元を屋根で塞ぐ（保存済み）。p3 は空
  const g2 = s.project.graphMap.get('p2');
  const roof = g2.addRoom(new Set([keyAt(g2, [500, 500])]), '屋根');
  roof.setFeature(RoomFeature.ROOF);
  s.store.set('p2', serializeGraph(g2));
  const r = await copyStairsToNewFloors({ project: s.project, sourceGraph: s.g1, newPlanes: s.planes, peekFn: s.peekFn, saveFloorFn: s.saveFloorFn });
  assert.deepEqual(r.perPlane.map(x => x.skipped.length), [1, 0]);
  assert.deepEqual(s.savedLog, ['p3'], '飛んだ p2 は何も変わらないので保存しない');
});
