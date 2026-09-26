// structural/syncFloorRecorder.js（createSyncFloorRecorder）の単体テスト（段階(g)・2026-09-26）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncFloorRecorder } from './syncFloorRecorder.js';

const enc = (s) => new TextEncoder().encode(s);

function makeStore(initial = {}) {
  const store = new Map(Object.entries(initial));
  const loadBytes = async (planeId) => store.get(planeId) ?? null;
  const save = async (planeId, bytes) => { store.set(planeId, bytes); };
  return { store, loadBytes, save };
}

test('createSyncFloorRecorder: 変化した階だけを記録する', async () => {
  const { loadBytes, save } = makeStore({ p1: enc('a1'), p2: enc('a2') });
  const recorder = createSyncFloorRecorder({ loadBytes });
  await recorder.captureBefore(['p1', 'p2']);
  const wrapped = recorder.wrapSave(save);

  await wrapped('p1', enc('b1')); // 変化した
  await wrapped('p2', enc('a2')); // 内容は同じ（変化なし）

  const recs = recorder.records();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].planeId, 'p1');
  assert.deepEqual([...recs[0].before], [...enc('a1')]);
  assert.deepEqual([...recs[0].after], [...enc('b1')]);
});

test('createSyncFloorRecorder: 同じバイト（floorBytesEqual）は記録しない', async () => {
  const { loadBytes, save } = makeStore({ p1: enc('same') });
  const recorder = createSyncFloorRecorder({ loadBytes });
  await recorder.captureBefore(['p1']);
  const wrapped = recorder.wrapSave(save);

  await wrapped('p1', enc('same')); // 同じバイト列（別インスタンスでも内容が同じ）
  assert.deepEqual(recorder.records(), []);
});

test('createSyncFloorRecorder: 複数回保存された階はbeforeが最初・afterが最後になる（1件だけ記録）', async () => {
  const { loadBytes, save } = makeStore({ p1: enc('v0') });
  const recorder = createSyncFloorRecorder({ loadBytes });
  await recorder.captureBefore(['p1']);
  const wrapped = recorder.wrapSave(save);

  await wrapped('p1', enc('v1'));
  await wrapped('p1', enc('v2'));
  await wrapped('p1', enc('v3'));

  const recs = recorder.records();
  assert.equal(recs.length, 1, '同じ階は1件だけ');
  assert.deepEqual([...recs[0].before], [...enc('v0')], 'beforeは最初のcaptureBefore時点の値');
  assert.deepEqual([...recs[0].after], [...enc('v3')], 'afterは最後に保存された値');
});

test('【失敗系】createSyncFloorRecorder: excludePlaneIdへの保存は記録しない', async () => {
  const { loadBytes, save } = makeStore({ active: enc('a'), p2: enc('b') });
  const recorder = createSyncFloorRecorder({ loadBytes, excludePlaneId: 'active' });
  await recorder.captureBefore(['p2']); // excludePlaneId自体はcaptureBeforeの対象にも含めない運用
  const wrapped = recorder.wrapSave(save);

  await wrapped('active', enc('a2')); // 除外階（下位saveは実行されるが記録はしない）
  await wrapped('p2', enc('b2'));

  const recs = recorder.records();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].planeId, 'p2');
});

test('【失敗系】createSyncFloorRecorder: save()がrejectしたらafterは更新されず記録もされない', async () => {
  const { loadBytes } = makeStore({ p1: enc('v0') });
  const recorder = createSyncFloorRecorder({ loadBytes });
  await recorder.captureBefore(['p1']);
  const failingSave = async () => { throw new Error('save boom'); };
  const wrapped = recorder.wrapSave(failingSave);

  await assert.rejects(() => wrapped('p1', enc('v1')), /save boom/);
  assert.deepEqual(recorder.records(), [], 'save失敗ではafterが更新されないため記録されない');
});

test('【失敗系】createSyncFloorRecorder: captureBeforeしていないplaneIdへの保存は記録せずconsole.warnを1回だけ出す', async () => {
  const { loadBytes, save } = makeStore({});
  const recorder = createSyncFloorRecorder({ loadBytes });
  await recorder.captureBefore([]); // p1をcaptureしない
  const wrapped = recorder.wrapSave(save);

  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    await wrapped('p1', enc('x1'));
    await wrapped('p1', enc('x2')); // 同じplaneIdへの2回目でも警告は増えない
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnCalls.length, 1, '同じplaneIdの警告は1回だけ');
  assert.deepEqual(recorder.records(), [], '未captureのplaneIdは記録されない');
});

test('【失敗系】createSyncFloorRecorder: captureBefore時点のbytesがnull（未保存階）の階は記録しない', async () => {
  const { loadBytes, save } = makeStore({}); // p1は未保存（loadBytesはnullを返す）
  const recorder = createSyncFloorRecorder({ loadBytes });
  await recorder.captureBefore(['p1']);
  const wrapped = recorder.wrapSave(save);

  await wrapped('p1', enc('new-content'));
  assert.deepEqual(recorder.records(), [], 'beforeがnullの階は記録しない');
});

test('createSyncFloorRecorder: wrapSaveは下位のsaveを同期区間でそのまま呼ぶ（awaitを挟まない）', async () => {
  const { loadBytes } = makeStore({ p1: enc('v0') });
  const recorder = createSyncFloorRecorder({ loadBytes });
  await recorder.captureBefore(['p1']);

  // スパイ: 呼び出された「瞬間」に同期的にフラグを立てるsave（await前に呼ばれたことを確認する）。
  let calledSynchronously = false;
  const spySave = () => {
    calledSynchronously = true;
    return Promise.resolve();
  };
  const wrapped = recorder.wrapSave(spySave);

  const p = wrapped('p1', enc('v1'));
  // wrapSaveの呼び出し直後（pをawaitする前）に、既にspySaveが同期的に呼ばれているはず
  // （wrapSave自身がPromiseチェーン越しに間接呼び出ししていないことの確認）。
  assert.equal(calledSynchronously, true, 'wrapSaveは下位のsaveを呼び出しの同期区間で直接呼ぶはず');
  await p;
});
