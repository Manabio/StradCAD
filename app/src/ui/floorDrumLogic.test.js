import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITEM_H, clampIndex, resolveDisplayId, nextIndexFromDrag, nextIndexFromWheel,
  canRequestSwitch, requestFloorSwitch,
} from './floorDrumLogic.js';

// FloorDrum が実際に受け取る形（[{ id, name }]。構造モードの id は slotType:planeId のスロットキー文字列）。
const SLOT_FLOORS = [
  { id: 'plan:p1', name: '1F' },
  { id: 'plan:p2', name: '2F' },
  { id: 'frame:p2', name: '2F伏図' },
];
const FLOORS = [{ id: 'p1', name: '1F' }, { id: 'p2', name: '2F' }, { id: 'p3', name: '3F' }];

test('resolveDisplayId: pending が floors に在ればそれを返す（スロットキーの id もそのまま）', () => {
  assert.equal(resolveDisplayId(SLOT_FLOORS, 'plan:p1', 'frame:p2'), 'frame:p2');
  assert.equal(resolveDisplayId(FLOORS, 'p1', 'p3'), 'p3');
});

test('resolveDisplayId: pending が無ければ activeFloorId', () => {
  assert.equal(resolveDisplayId(FLOORS, 'p2', null), 'p2');
  assert.equal(resolveDisplayId(FLOORS, 'p2', undefined), 'p2');
});

test('【失敗系】resolveDisplayId: pending の id が floors に無ければ activeFloorId へ落ちる', () => {
  assert.equal(resolveDisplayId(SLOT_FLOORS, 'plan:p1', 'frame:gone'), 'plan:p1');
  assert.equal(resolveDisplayId(FLOORS, 'p2', 'zzz'), 'p2');
});

test('clampIndex: 範囲内はそのまま・範囲外は端へ', () => {
  assert.equal(clampIndex(1, 3), 1);
  assert.equal(clampIndex(-4, 3), 0);
  assert.equal(clampIndex(9, 3), 2);
});

test('nextIndexFromDrag: 下方向ドラッグ(正)は上の階（インデックス小）へ。1階ぶん未満は動かない', () => {
  assert.equal(nextIndexFromDrag(2, ITEM_H, 5), 1);
  assert.equal(nextIndexFromDrag(2, -ITEM_H * 2, 5), 4);
  assert.equal(nextIndexFromDrag(2, ITEM_H * 0.4, 5), 2);
  assert.equal(nextIndexFromDrag(2, ITEM_H * 0.6, 5), 1);
});

test('【失敗系】nextIndexFromDrag: 端を越えるドラッグは端に収める', () => {
  assert.equal(nextIndexFromDrag(0, ITEM_H * 5, 3), 0);
  assert.equal(nextIndexFromDrag(2, -ITEM_H * 5, 3), 2);
});

test('nextIndexFromWheel: 下回し(deltaY>0)はインデックス大・上回しは小。端では動かない', () => {
  assert.equal(nextIndexFromWheel(1, 100, 3), 2);
  assert.equal(nextIndexFromWheel(1, -100, 3), 0);
  assert.equal(nextIndexFromWheel(2, 100, 3), 2);
  assert.equal(nextIndexFromWheel(0, -100, 3), 0);
});

test('canRequestSwitch: pending が無く対象が表示基準と違えば可', () => {
  assert.equal(canRequestSwitch(null, 'plan:p1', 'frame:p2'), true);
});

test('【失敗系】canRequestSwitch: pending 中は不可・対象が表示基準と同じなら不可・対象なしは不可', () => {
  assert.equal(canRequestSwitch('p2', 'p2', 'p3'), false);
  assert.equal(canRequestSwitch(null, 'p1', 'p1'), false);
  assert.equal(canRequestSwitch(null, 'p1', null), false);
});

// setPending の呼び出し履歴と、onSwitch の呼び出し時点の pending を記録する道具。
function makeHarness() {
  const history = [];
  let pending = null;
  const setPending = id => { pending = id; history.push(id); };
  return { history, setPending, getPending: () => pending };
}

test('requestFloorSwitch: resolve で pending が外れる。決着前は pending が立っている', async () => {
  const h = makeHarness();
  let seenPendingInCall = 'unset';
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const onSwitch = id => { calls.push(id); seenPendingInCall = h.getPending(); return gate; };

  const p = requestFloorSwitch('frame:p2', onSwitch, h.setPending);
  assert.equal(h.getPending(), 'frame:p2', '決着前は pending が立っている');
  assert.equal(seenPendingInCall, 'frame:p2', 'onSwitch が呼ばれた時点で pending は立っている');
  release();
  await p;
  assert.equal(h.getPending(), null);
  assert.deepEqual(h.history, ['frame:p2', null]);
  assert.deepEqual(calls, ['frame:p2']);
});

test('【失敗系】requestFloorSwitch: reject でも pending が外れ、Promise は resolve する', async () => {
  const h = makeHarness();
  const orig = console.error; const logged = [];
  console.error = (...a) => { logged.push(a); };
  try {
    const p = requestFloorSwitch('p2', () => Promise.reject(new Error('boom')), h.setPending);
    assert.equal(h.getPending(), 'p2');
    await p;
  } finally { console.error = orig; }
  assert.equal(h.getPending(), null);
  assert.equal(logged.length, 1);
});

test('【失敗系】requestFloorSwitch: onSwitch が undefined（関門に無視）を返しても pending が外れる', async () => {
  const h = makeHarness();
  const p = requestFloorSwitch('p2', () => undefined, h.setPending);
  assert.equal(h.getPending(), 'p2', '同期の間は pending が立っている');
  await p;
  assert.equal(h.getPending(), null);
  assert.deepEqual(h.history, ['p2', null]);
});

test('【失敗系】requestFloorSwitch: onSwitch が同期 throw しても pending が外れる', async () => {
  const h = makeHarness();
  const orig = console.error; const logged = [];
  console.error = (...a) => { logged.push(a); };
  try {
    await requestFloorSwitch('p2', () => { throw new Error('sync boom'); }, h.setPending);
  } finally { console.error = orig; }
  assert.equal(h.getPending(), null);
  assert.deepEqual(h.history, ['p2', null]);
  assert.equal(logged.length, 1);
});

test('FloorDrum の実入力: pending 中の再要求は onSwitch を呼ばない（呼び出し回数を確認）', async () => {
  const h = makeHarness();
  let release;
  const gate = new Promise(r => { release = r; });
  let count = 0;
  const onSwitch = () => { count++; return gate; };
  // FloorDrum.requestSwitch と同じ組み立て: canRequestSwitch で弾いてから requestFloorSwitch。
  const request = id => {
    const displayId = resolveDisplayId(SLOT_FLOORS, 'plan:p1', h.getPending());
    if (!canRequestSwitch(h.getPending(), displayId, id)) return null;
    return requestFloorSwitch(id, onSwitch, h.setPending);
  };

  const first = request('frame:p2');
  assert.ok(first, '1つ目は通る');
  assert.equal(request('plan:p2'), null, 'pending 中の2つ目は通らない');
  assert.equal(request('frame:p2'), null, 'pending 中の同じ対象も通らない');
  assert.equal(count, 1, 'onSwitch は1回だけ呼ばれる');
  release();
  await first;
  assert.equal(h.getPending(), null);
  assert.ok(request('plan:p2'), '決着後は再び要求できる');
  assert.equal(count, 2);
  release();
});
