// applyFloorBytes の bytes === null 分岐（IDB 未保存への巻き戻し＝レコード削除）。
// 屋根専用平面は構造モードに入るまで IDB レコードが無く、階操作の run（reflectRoofPlane）が保存した後の
// undo で、collectFloorBytes の before=null を applyFloorBytes がレコード削除として戻す。
// db.js の saveFloor／deleteFloor が使う最小限の IDB API だけを模す自前シム
// （storage/floorWriteGeneration.db.test.js と同じ方針。db.js の _dbPromise はモジュールスコープで
// キャッシュされるため、シムはこのファイルの先頭で一度だけ据える）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from './core.js';
import { serializeGraph } from './graphSnapshot.js';
import { applyFloorBytes, collectPlaneMetas, diffFloorOpSnapshot } from './floorOps.js';

const floors = new Map();
const req = () => ({ onsuccess: null, onerror: null });
const fakeStore = {
  put(v) { const r = req(); floors.set(v.planeId, v); queueMicrotask(() => r.onsuccess?.({ target: { result: undefined } })); return r; },
  delete(k) { const r = req(); floors.delete(k); queueMicrotask(() => r.onsuccess?.({ target: { result: undefined } })); return r; },
};
globalThis.indexedDB = {
  open() {
    const r = req();
    queueMicrotask(() => r.onsuccess?.({ target: { result: {
      transaction: () => ({ oncomplete: null, onerror: null, objectStore: () => fakeStore }),
      objectStoreNames: { contains: () => true },
    } } }));
    return r;
  },
};

// applyFloorBytes は投げ放し（.catch(console.error)）なので、IDB の反映を少し待つ
async function settle(cond) {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise(r => setTimeout(r, 0));
}

function setup() {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: roofGraph } = project.addPlane(3001, '小屋伏', 'roof', 1, 1, false, null, 0, true, 'p1');
  return { project, g1, roofGraph };
}

test('applyFloorBytes: 屋根の before=null（IDB 未保存）→ run が保存 → undo の適用で非アクティブな屋根のレコードが消える。after の適用で戻る', async () => {
  const { project, g1, roofGraph } = setup();
  project.activePlaneId = 'p1';
  const roofBytes = serializeGraph(roofGraph);
  // collectFloorBytes と同じ形: 未保存の屋根は null
  const before = new Map([['p1', serializeGraph(g1)], ['roof', null]]);
  floors.set('roof', { planeId: 'roof', bytes: roofBytes }); // run（reflectRoofPlane）が保存した
  const after = new Map([['p1', serializeGraph(g1)], ['roof', roofBytes]]);
  const metas = collectPlaneMetas(project);
  const diff = diffFloorOpSnapshot({ before, after, metasBefore: metas, metasAfter: metas });
  const rec = diff.changedSiblings.find(r => r.planeId === 'roof');
  assert.ok(rec, '屋根が changedSiblings に入る');
  assert.equal(rec.before, null);

  applyFloorBytes(project, rec.planeId, rec.before);
  await settle(() => !floors.has('roof'));
  assert.equal(floors.has('roof'), false, 'undo で屋根のレコードが消える');

  applyFloorBytes(project, rec.planeId, rec.after);
  await settle(() => floors.has('roof'));
  assert.deepEqual(floors.get('roof').bytes, roofBytes, 'redo で屋根のレコードが戻る');
});

test('【失敗系】applyFloorBytes: アクティブ階への null は何もしない（メモリのグラフを消さず、IDB も触らない）', async () => {
  const { project, g1 } = setup();
  project.activePlaneId = 'p1';
  floors.set('p1', { planeId: 'p1', bytes: new Uint8Array([1]) });
  const live = serializeGraph(g1);
  applyFloorBytes(project, 'p1', null);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(floors.has('p1'), true, 'アクティブ階の IDB レコードは消えない');
  assert.deepEqual(serializeGraph(g1), live, 'メモリのグラフは変わらない');
});
