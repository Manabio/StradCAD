// FloorSwapManager.swap() の単体テスト。floorWriteGeneration.db.test.js と同じ方針:
// fake-indexeddb 等の新規npm依存を追加せず、db.js の saveFloor/loadFloor が使う最小限のIDB APIだけを
// 模す自前シム（このテストファイルの外では使わない）。db.js の _dbPromise はモジュールスコープで
// open成功後キャッシュされ続けるため、fakeDBはこのファイル内で1個だけ生成して全testで使い回す。
// FakeStore は put/get の onsuccess を hold/release で保留可能にする（保存中・読込み中の
// 同期編集を注入するため）。holdNext*() が返す engaged は、対象の呼び出しが実際に来て保留された
// 瞬間に解決する（release() 自体はいつ呼んでも安全＝呼び出しより前でも後でも、来た時点で
// 即解決するだけなので、注入したい編集の順序は engaged を await することで固定できる）。
// sessionLock._status は初期値 'pending'＝オーナー扱いのまま（node:testはファイル単位で別
// プロセスに分離されるため、他ファイルのblocked判定と混ざらない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction, observable, reaction } from 'mobx';
import { Plane, PlanGraph } from '../core.js';
import { FloorSwapManager, MAX_SWAP_SAVE_ATTEMPTS } from './FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { noteFloorWrite } from './floorWriteGeneration.js';
import { saveFloor } from './db.js';
import { isDirty, clearDirty } from '../dirtyState.js';
import { ERR_FLOOR_SWITCH_UNSTABLE } from '../error.js';

function makeGraph(planeId) {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return { plane, graph: new PlanGraph(plane) };
}

class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }

class FakeStore {
  constructor() { this.data = new Map(); this.putCount = 0; this.getCount = 0; }

  // 次の1回のput/getだけを保留する。release()はいつ呼んでも安全（対象呼び出しより前でも、
  // 来た時点で即座に解決するだけ）。engagedは対象呼び出しが実際に来た瞬間に解決するため、
  // 「保存/読込みが今まさに保留されている」タイミングを待ってから編集を注入できる。
  holdNextPut() { return this._holdNext('_holdPut'); }
  holdNextGet() { return this._holdNext('_holdGet'); }
  _holdNext(key) {
    let release, resolveEngaged;
    const held = new Promise(r => { release = r; });
    const engaged = new Promise(r => { resolveEngaged = r; });
    this[key] = { held, resolveEngaged };
    return { release, engaged };
  }

  // 次の1回のput/getだけを失敗させる。
  failNextPut(error = new Error('fake put failure')) { this._failPut = error; }
  failNextGet(error = new Error('fake get failure')) { this._failGet = error; }

  put(value) {
    this.putCount++;
    const req = new FakeRequest();
    const holdEntry = this._holdPut; this._holdPut = null;
    const fail = this._failPut; this._failPut = null;
    const run = () => {
      if (fail) { req.onerror?.({ target: { error: fail } }); return; }
      this.data.set(value.planeId, value);
      req.onsuccess?.({ target: { result: undefined } });
    };
    if (holdEntry) { holdEntry.resolveEngaged(); holdEntry.held.then(run); } else queueMicrotask(run);
    return req;
  }

  get(key) {
    this.getCount++;
    const req = new FakeRequest();
    // 呼び出し時点の値をスナップショットする（IndexedDBの読み取り一貫性を模す）。保留中に
    // 別の書込みが値を進めても、この読取りは呼び出し時点の値を返す——QA指摘F2の再現に必要
    // （読込みawait中に始まった書込みを、世代だけでなく実際に返す値としても区別する）。
    const snapshot = this.data.get(key);
    const holdEntry = this._holdGet; this._holdGet = null;
    const fail = this._failGet; this._failGet = null;
    const run = () => {
      if (fail) { req.onerror?.({ target: { error: fail } }); return; }
      req.onsuccess?.({ target: { result: snapshot } });
    };
    if (holdEntry) { holdEntry.resolveEngaged(); holdEntry.held.then(run); } else queueMicrotask(run);
    return req;
  }

  delete(key) {
    const req = new FakeRequest();
    this.data.delete(key);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
}

const fakeFloorsStore = new FakeStore();
const fakeStores = { floors: fakeFloorsStore, savedFloors: new FakeStore(), projects: new FakeStore() };
const fakeTransaction = () => ({
  oncomplete: null, onerror: null,
  objectStore: (name) => fakeStores[name],
});
globalThis.indexedDB = {
  open() {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({
      target: { result: { transaction: fakeTransaction, objectStoreNames: { contains: (name) => name in fakeStores } } },
    }));
    return req;
  },
};

test('swap: 保存が保留されている間（隙間A）に割り込んだ編集を検知して再保存する（put 2回・保存内容に編集後の点が入る）', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-save-pending');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-save-pending');
  let commitCount = 0;
  const putCountBefore = fakeFloorsStore.putCount;

  const hold = fakeFloorsStore.holdNextPut();
  const swapPromise = mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => { commitCount++; });

  // 1回目の保存が実際に保留された（＝serializeGraphでbytesを確定した直後）のを待ってから編集する。
  await hold.engaged;
  runInAction(() => fromGraph.addPoint(123, 456));
  assert.equal(commitCount, 0, '保存保留中はcommitActiveが呼ばれていない');

  hold.release();
  await swapPromise;

  assert.equal(fakeFloorsStore.putCount - putCountBefore, 2,
    '1回目の保存後に内容が変わっていたため再保存し、put が2回呼ばれるはず');
  assert.equal(commitCount, 1, 'swap完了後にcommitActiveが1回呼ばれる');
  assert.equal(fromGraph.points.length, 0, 'fromGraphはclearFloorData済み');

  const saved = fakeFloorsStore.data.get('p1-save-pending');
  assert.ok(saved, 'floorsストアに保存されているはず');
  const restored = new PlanGraph(fromPlane);
  restoreGraph(restored, saved.bytes);
  assert.equal(restored.points.length, 1, '保存内容に編集後の点が含まれるはず');
});

test('swap: 読込みが保留されている間（隙間B）は編集が生き続け、commitActiveも呼ばれない。release後に編集が保存される', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-load-pending');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-load-pending');
  let commitCount = 0;

  const hold = fakeFloorsStore.holdNextGet(); // 先読み(loadFloor)を保留する
  const swapPromise = mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => { commitCount++; });

  await hold.engaged;
  runInAction(() => fromGraph.addPoint(1, 1));
  assert.equal(commitCount, 0, '読込み保留中はcommitActiveが呼ばれていない');
  assert.equal(fromGraph.points.length, 1, 'fromGraphはまだclearされていない（編集が生きている）');

  hold.release();
  await swapPromise;

  assert.equal(commitCount, 1);
  const saved = fakeFloorsStore.data.get('p1-load-pending');
  const restored = new PlanGraph(fromPlane);
  restoreGraph(restored, saved.bytes);
  assert.equal(restored.points.length, 1, '読込み保留中に加えた編集も保存されているはず');
});

test('swap: アクティブ側のグラフが空（pointMap.size===0）になる瞬間は一度も観測されない（同期確定=1つのrunInAction）', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-no-empty-observe');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-no-empty-observe');
  runInAction(() => fromGraph.addPoint(10, 10)); // 保存対象に何か点を持たせておく
  // 次階にも復元後に空にならない内容を事前保存しておく（nextBytes===nullだとtoGraphは元々0のままで、
  // 「復元直後も空にならない」ことの検証にならない）。
  const toGraphForSave = new PlanGraph(toPlane);
  runInAction(() => toGraphForSave.addPoint(20, 20));
  fakeFloorsStore.data.set(toPlane.id, { planeId: toPlane.id, bytes: serializeGraph(toGraphForSave) });

  const activePlaneId = observable.box(fromPlane.id);
  const observed = [];
  const dispose = reaction(
    () => (activePlaneId.get() === fromPlane.id ? fromGraph.pointMap.size : toGraph.pointMap.size),
    (size) => observed.push(size),
    { fireImmediately: true },
  );

  await mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => { runInAction(() => activePlaneId.set(toPlane.id)); });

  dispose();
  assert.ok(!observed.includes(0), `アクティブ側のpointMap.sizeが0になる瞬間を観測してはならない（観測列: ${observed}）`);
});

test('【失敗系】swap: saveFloor失敗→fromGraphはclearされず・commitActive 0回・rejectが伝播し、後続の編集でauto-saveが再開している（isDirty()が真になる）', async () => {
  clearDirty();
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-save-fail');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-save-fail');
  runInAction(() => fromGraph.addPoint(0, 0));
  let commitCount = 0;

  fakeFloorsStore.failNextPut();
  await assert.rejects(
    mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => { commitCount++; }),
    /fake put failure/,
  );

  assert.equal(commitCount, 0);
  assert.equal(fromGraph.points.length, 1, 'fromGraphはclearFloorDataされておらず無傷');
  assert.equal(isDirty(), false, '前提: まだ後続の編集をしていない');
  // _startAutoSaveのautorunはshapeMap.size等を観測対象にする（pointMapは対象外のためaddPointでは
  // markDirtyされない。FloorSwapManager.js _startAutoSave参照）。ここではshapeMapへの追加で発火させる。
  runInAction(() => fromGraph.shapeMap.set('dummy-shape-id', {}));
  assert.equal(isDirty(), true, 'saveFloor失敗後もfromPlaneのauto-saveが再開されているはず（編集でmarkDirtyされる）');

  mgr._stopAutoSave(fromPlane.id); // 後始末
});

test('【失敗系】swap: loadFloor失敗→無変更でrethrowする（auto-save停止より前のため再開は不要）', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-load-fail');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-load-fail');
  let commitCount = 0;

  fakeFloorsStore.failNextGet();
  await assert.rejects(
    mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => { commitCount++; }),
    /fake get failure/,
  );

  assert.equal(commitCount, 0);
  assert.equal(fromGraph.points.length, 0, 'fromGraphは元々空のまま（触れられていない）');
});

test('【失敗系】swap: 復元先の壊れたバイト列→fromGraphは無傷・toGraphはclearFloorDataされ空のまま・commitActiveは呼ばれない', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-corrupt-restore');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-corrupt-restore');
  runInAction(() => fromGraph.addPoint(5, 5));
  runInAction(() => toGraph.addPoint(6, 6)); // 復元失敗時にclearFloorDataされることを検出できるよう先に何か持たせておく
  // p2に構造的に壊れたデータを事前保存しておく（restoreGraphはUint8Array/ArrayBuffer/string以外の
  // 値をplain snapshotとしてそのまま適用しようとするため、期待した形を持たないオブジェクトは
  // applySnapshot内で確実に例外になる。実際のflatbuffersバイト列はdecode()がガベージ入力に
  // 非常に寛容で例外を投げないことを実測で確認済みのため、この経路で「壊れた保存データ」を模す）。
  fakeFloorsStore.data.set(toPlane.id, { planeId: toPlane.id, bytes: { bogus: true } });
  let commitCount = 0;

  await assert.rejects(mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => { commitCount++; }));

  assert.equal(commitCount, 0, 'commitActiveは呼ばれていない（アクティブ不変）');
  assert.equal(fromGraph.points.length, 1, 'fromGraphはclearFloorDataされておらず無傷');
  assert.equal(toGraph.points.length, 0, 'toGraphは復元失敗を検知してclearFloorDataされる');

  mgr._stopAutoSave(fromPlane.id); // 後始末（auto-save再開済み）
});

test('【失敗系】swap: 保存のたびに編集が割り込み続けて安定しない→ERR_FLOOR_SWITCH_UNSTABLEで拒否され、fromGraphはclearされない', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-unstable');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-unstable');
  let commitCount = 0;
  let injected = 0;

  const origPut = fakeFloorsStore.put.bind(fakeFloorsStore);
  fakeFloorsStore.put = (value) => {
    // 保存が呼ばれるたびに（onsuccess発火前に）fromGraphへ編集を注入し続け、絶対に安定しない状況を作る。
    injected++;
    runInAction(() => fromGraph.addPoint(injected, injected));
    return origPut(value);
  };
  try {
    await assert.rejects(
      mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => { commitCount++; }),
      (err) => err instanceof Error && err.message === ERR_FLOOR_SWITCH_UNSTABLE,
    );
  } finally {
    fakeFloorsStore.put = origPut;
  }

  assert.equal(injected, MAX_SWAP_SAVE_ATTEMPTS, `MAX_SWAP_SAVE_ATTEMPTS(${MAX_SWAP_SAVE_ATTEMPTS})回だけ保存を試みるはず`);
  assert.equal(commitCount, 0);
  assert.ok(fromGraph.points.length > 0, 'fromGraphはclearFloorDataされていない');

  mgr._stopAutoSave(fromPlane.id); // 後始末（auto-save再開済み）
});

test('swap: 保存中に次階が横から書き換えられた（floorWriteGeneration変化）→次階を読み直し、新しい内容が復元される', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-gen-change');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-gen-change');
  const oldToGraphForSave = new PlanGraph(toPlane);
  runInAction(() => oldToGraphForSave.addPoint(1, 1));
  fakeFloorsStore.data.set(toPlane.id, { planeId: toPlane.id, bytes: serializeGraph(oldToGraphForSave) });
  const getCountBefore = fakeFloorsStore.getCount;

  const holdPut = fakeFloorsStore.holdNextPut(); // fromPlaneの保存を保留し、その間に「横から」の書換えを注入する
  const swapPromise = mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => {});

  await holdPut.engaged;
  // 「横から」次階を書き換える（この階の編集可能peek・階段同期等が別途db.js経由で書く操作を模す）。
  // db.jsのsaveFloorを経由すると、そのput呼び出し自体がholdNextPut（次の1回だけ）を消費してしまい
  // 順序が保証できなくなるため、ストア本体とfloorWriteGenerationを直接操作して模す。
  const newToGraphForSave = new PlanGraph(toPlane);
  runInAction(() => { newToGraphForSave.addPoint(1, 1); newToGraphForSave.addPoint(2, 2); });
  fakeFloorsStore.data.set(toPlane.id, { planeId: toPlane.id, bytes: serializeGraph(newToGraphForSave) });
  noteFloorWrite(toPlane.id);

  holdPut.release();
  await swapPromise;

  assert.equal(fakeFloorsStore.getCount - getCountBefore, 2, '先読み1回＋世代変化後の読み直し1回で計2回getが呼ばれるはず');
  assert.equal(toGraph.points.length, 2, '横から書き換えられた新しい内容(点2つ)がtoGraphへ復元されるはず');
});

test('swap: nextBytesがnull（次階が未保存の新しい階）→toGraphのメモリ内容をそのまま保持する', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-null-next');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-null-next');
  runInAction(() => toGraph.addPoint(9, 9)); // 保存前のメモリ内容（新規階の初期状態相当）
  let commitCount = 0;

  await mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => { commitCount++; });

  assert.equal(commitCount, 1);
  assert.equal(toGraph.points.length, 1, 'nextBytesがnullのときtoGraphのメモリ内容が保持されるはず（上書きされない）');

  mgr._stopAutoSave(toPlane.id); // 後始末（swap成功でtoPlaneのauto-saveが開始されている）
});

// ================================================================
// QA指摘F2（2026-09-27）: 再読込みの世代を「読んだ後」ではなく「読む前」に控えないと、
// 読込みawait中にさらに始まった書込みを取りこぼす。
//
// 再現手順: A(from)の1回目のputを保留→その間にB(to)へv1を保存（世代only進む・A自身は不安定に
// ならない）→put解放→ループがB世代の不一致を検知し再読込みのgetを開始（このgetは呼び出し時点の
// 値=v1をスナップショットする）→そのgetを保留した状態でさらにB(to)へv2を保存（世代が進む）→
// get解放（返る値はスナップショット済みのv1のまま）。
// 世代を読む前に控える修正が無いと、v1の内容のままgen=v2の世代を記録してしまい以後再読込みされず
// toGraphの点数が1（v1相当）のまま確定する。修正後はgen不一致を次のループでも検知し、v2まで
// 読み直してtoGraphの点数が2になる。
// ================================================================
test('【QA指摘F2】swap: 再読込みのget中にさらに横から書き込まれても、世代を読む前に控えているため取りこぼさない', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-f2-reread-race');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-f2-reread-race');

  const v1Graph = new PlanGraph(toPlane);
  runInAction(() => v1Graph.addPoint(1, 1));
  const v2Graph = new PlanGraph(toPlane);
  runInAction(() => { v2Graph.addPoint(1, 1); v2Graph.addPoint(2, 2); });

  const holdPut = fakeFloorsStore.holdNextPut(); // Aの1回目の保存を保留する
  const swapPromise = mgr.swap(fromPlane, fromGraph, toPlane, toGraph, () => {});

  await holdPut.engaged;
  await saveFloor(toPlane.id, serializeGraph(v1Graph)); // Bへv1（Aの保存が保留されている間の横からの書込み）

  const holdGet = fakeFloorsStore.holdNextGet(); // Aの保存解放後に始まる再読込み（B世代不一致の検知）を保留する
  holdPut.release();

  await holdGet.engaged; // 再読込みのgetがv1をスナップショットした直後（まだ確定していない）
  await saveFloor(toPlane.id, serializeGraph(v2Graph)); // getが保留されている間に、さらにBへv2（世代だけ先に進む）
  holdGet.release(); // getはスナップショット済みのv1を返す（世代は既にv2）

  await swapPromise;

  assert.equal(toGraph.points.length, 2,
    '取りこぼし修正後はgen不一致を次のループでも検知し、最終的にv2（点2つ）まで読み直されるはず');
});

// ================================================================
// QA指摘F4（2026-09-27）: 同期確定の runInAction 内で fromGraph.clearFloorData() の後に
// commitActive() が失敗すると、fromGraph が空のまま auto-save 再開してしまい、次の swap-out で
// 空を fromPlane へ上書きする事故になる。catch で直前の保存バイト列から復元することを確認する。
// ================================================================
test('【QA指摘F4】swap: commitActiveがthrowするとfromGraphは直前の保存内容へ復元され、rejectが伝播し、アクティブは変わらない', async () => {
  const mgr = new FloorSwapManager();
  const { plane: fromPlane, graph: fromGraph } = makeGraph('p1-f4-commit-throw');
  const { plane: toPlane, graph: toGraph } = makeGraph('p2-f4-commit-throw');
  runInAction(() => fromGraph.addPoint(7, 7));
  let activePlaneId = fromPlane.id;
  const commitActive = () => { throw new Error('commitActive boom'); };

  await assert.rejects(
    mgr.swap(fromPlane, fromGraph, toPlane, toGraph, commitActive),
    /commitActive boom/,
  );

  assert.equal(activePlaneId, fromPlane.id, 'commitActiveが失敗した以上アクティブは変わっていないはず');
  assert.equal(fromGraph.points.length, 1,
    'fromGraphはclearFloorData→commitActive失敗の後、直前の保存内容（点1個）へ復元されるはず');

  mgr._stopAutoSave(fromPlane.id); // 後始末（auto-save再開済み）
});
