// FinishModeState.stairChains / _loadStairChains / stairOfMember（階段の連鎖。仕上げモード階段タブのグループ表示用）と、
// 突入時の peek を1系統にまとめた配線（採用階の数−1回。_loadLowerStairs・_loadUpperVoids はその結果を使い回す）。
// 他階は floorSwapManager.peek の差し替え。本番の peek と同じく、保存バイト列（serializeGraph）から復元した別インスタンスを
// 返す（自階はライブのグラフ）。3階建て。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FinishModeState } from './FinishModeState.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph } from '../graphSnapshot.js';
import { RoomFeature } from '@core';
import { makeStorePeek } from '../finish/equipment/equipmentTestFixtures.js';
import { setupProject, addPerFloorV, placeStair } from '../finish/stair/stairRemovalTestFixtures.js';

const LEFT = [250, 500];

async function withPeek(peek, fn) {
  const original = floorSwapManager.peek;
  floorSwapManager.peek = peek;
  try { await fn(); } finally { floorSwapManager.peek = original; }
}

// 3階建て。stairsOn に挙げた階（0 始まり）へ同位置の階段を指定し、activeIndex の階をアクティブにした状態を返す。
// peek はバイト列から復元した別インスタンスを返し、呼ばれた planeId を calls へ積む。
function setup({ stairsOn = [0, 1, 2], activeIndex = 1 } = {}) {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const stairs = graphs.map((g, i) => (stairsOn.includes(i) ? placeStair(project, g, { pts: [LEFT] }).stair : null));
  project.activePlaneId = graphs[activeIndex].plane.id;
  const store = new Map(graphs.map(g => [g.plane.id, serializeGraph(g)]));
  const restore = makeStorePeek(project, store);
  const calls = [];
  const peek = async (plane) => { calls.push(plane.id); return restore(plane); };
  return { project, graphs, stairs, state: new FinishModeState(graphs[activeIndex], project), peek, calls };
}

const planeIdsOf = (state) => state.stairChains.map(c => c.members.map(m => m.planeId));

test('_loadStairChains: アクティブ階以外の採用階を peek し、3階の連鎖が1本導出される（自階は peek しない）', async () => {
  const { state, stairs, peek, calls } = setup();
  await withPeek(peek, () => state._loadStairChains());
  assert.deepEqual([...calls].sort(), ['p1', 'p3']);
  const chains = state.stairChains;
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].members.map(m => m.stairId), stairs.map(s => s.id));
});

test('T1: 自階＝最下階 p1 で連鎖 p1〜p3。peek は p2・p3 だけ', async () => {
  const { state, peek, calls } = setup({ activeIndex: 0 });
  await withPeek(peek, () => state._loadStairChains());
  assert.deepEqual(calls, ['p2', 'p3']);
  assert.deepEqual(planeIdsOf(state), [['p1', 'p2', 'p3']]);
});

test('T2: 自階＝最上階 p3 で階段が p1 だけ→[[p1]]／階段が p3 だけで自階 p1→[[p3]]', async () => {
  const top = setup({ stairsOn: [0], activeIndex: 2 });
  await withPeek(top.peek, () => top.state._loadStairChains());
  assert.deepEqual(planeIdsOf(top.state), [['p1']]);
  const bottom = setup({ stairsOn: [2], activeIndex: 0 });
  await withPeek(bottom.peek, () => bottom.state._loadStairChains());
  assert.deepEqual(planeIdsOf(bottom.state), [['p3']]);
});

test('T3: 検討案の平面がアクティブなら peek せず、自階の階段だけの連鎖（採用階は混ぜない）', async () => {
  const { project, peek, calls } = setup();
  const { graph: alt } = project.addPlane(3000, '検討', 'alt', 2, 1, true, 'p2', 1);
  const altStair = placeStair(project, alt, { pts: [LEFT] }).stair;
  project.activePlaneId = 'alt';
  const state = new FinishModeState(alt, project);
  await withPeek(peek, () => state._loadStairChains());
  assert.deepEqual(calls, [], '採用階を peek しない');
  assert.deepEqual(state.stairChains.map(c => c.members), [[{ planeId: 'alt', stairId: altStair.id }]]);
});

test('stairOfMember: 自階はライブのグラフの階段、他階は peek したグラフの階段（別インスタンス）。無ければ null', async () => {
  const { state, graphs, stairs, peek } = setup();
  await withPeek(peek, () => state._loadStairChains());
  assert.equal(state.stairOfMember({ planeId: 'p2', stairId: stairs[1].id }), graphs[1].stairMap.get(stairs[1].id));
  const other = state.stairOfMember({ planeId: 'p3', stairId: stairs[2].id });
  assert.equal(other.id, stairs[2].id);
  assert.notEqual(other, graphs[2].stairMap.get(stairs[2].id), '本番の peek 同型（復元した別インスタンス）');
  assert.equal(state.stairOfMember({ planeId: 'p3', stairId: 'nothing' }), null);
  assert.equal(state.stairOfMember({ planeId: 'pX', stairId: stairs[0].id }), null);
});

test('自階の階段の削除は再 peek なしで連鎖に反映される（3階の連鎖が1階と3階に分かれる）', async () => {
  const { state, graphs, stairs, peek, calls } = setup();
  await withPeek(peek, () => state._loadStairChains());
  const peeked = calls.length;
  graphs[1].removeStair(stairs[1].id);
  assert.deepEqual(planeIdsOf(state), [['p1'], ['p3']]);
  assert.equal(calls.length, peeked, '再 peek していない');
});

test('自階に階段を指定すると再 peek なしで連鎖に加わる（1階と3階が2階の指定でつながる）', async () => {
  const { state, graphs, project, peek, calls } = setup({ stairsOn: [0, 2] });
  await withPeek(peek, () => state._loadStairChains());
  assert.deepEqual(planeIdsOf(state), [['p1'], ['p3']]);
  const peeked = calls.length;
  placeStair(project, graphs[1], { pts: [LEFT] });
  assert.deepEqual(planeIdsOf(state), [['p1', 'p2', 'p3']]);
  assert.equal(calls.length, peeked, '再 peek していない');
});

test('_loadStairChains 前は他階が無いので自階の階段だけの連鎖（単独）', () => {
  const { state, stairs } = setup();
  assert.deepEqual(state.stairChains.map(c => c.members), [[{ planeId: 'p2', stairId: stairs[1].id }]]);
});

test('【失敗系】peek が失敗したら _loadStairChains は reject し、他階は空のまま', async () => {
  const { state } = setup();
  await withPeek(async () => { throw new Error('peek 失敗'); }, async () => {
    await assert.rejects(() => state._loadStairChains(), /peek 失敗/);
  });
  assert.deepEqual(state.otherFloors, []);
});

test('【失敗系】peek の最中に dispose されたら書き込まない', async () => {
  const { state, peek } = setup();
  await withPeek(async (plane) => { state.dispose(); return peek(plane); }, async () => {
    await state._loadStairChains();
  });
  assert.deepEqual(state.otherFloors, []);
});

test('【失敗系】peek がグラフを返せなかった階では連鎖を切る（throw しない。p3 を外すと p1-p2 だけ）', async () => {
  const { state, peek } = setup();
  await withPeek(async (plane) => (plane.id === 'p3' ? null : peek(plane)), async () => {
    await state._loadStairChains();
  });
  assert.deepEqual(planeIdsOf(state), [['p1', 'p2']]);
});

test('【失敗系】真ん中の階を読めないと、その位置で切れる（p1・p3 は単独。隣どうしを繋がない）', async () => {
  const { state, peek } = setup({ activeIndex: 2 });
  await withPeek(async (plane) => (plane.id === 'p2' ? null : peek(plane)), async () => {
    await state._loadStairChains();
  });
  assert.deepEqual(planeIdsOf(state), [['p1'], ['p3']]);
});

// ---- 突入時の peek の一本化（Major 3） ----

test('init: peek は採用階の数−1回（p1・p3 を1回ずつ。重複なし）。見下げ・吹抜けはその結果から導出される', async () => {
  const { state, graphs, project, calls } = setup();
  // 直上階（p3）に吹抜けを足してバイト列を作り直す（_loadUpperVoids が peek 済みの結果から読むことの確認）
  const room = graphs[2].addRoom(new Set([...graphs[2].stairs[0].cells]), '吹抜');
  room.setFeature(RoomFeature.VOID);
  const store = new Map(graphs.map(g => [g.plane.id, serializeGraph(g)]));
  const restore = makeStorePeek(project, store);
  const peek2 = async (plane) => { calls.push(plane.id); return restore(plane); };
  await withPeek(peek2, async () => {
    await state.init();
    assert.deepEqual([...calls].sort(), ['p1', 'p3'], 'peek は採用階−1回で重複なし');
    assert.equal(state.lowerStairs.length, 1, '直下階（p1）の階段が見下げに入る');
    assert.equal(state._lowerGraph, state._otherFloor('p1').graph, '_lowerGraph は peek 結果そのもの');
    assert.equal(state.upperVoids.length, 1, '直上階（p3）の吹抜けが入る');
    assert.equal(state.upperFloorHeight, 3000);
    assert.equal(state.stairChains.length, 1);
    state.dispose();
  });
});

test('upperFloorGraph: 直上階の peek 済みグラフ（別インスタンス）。最上階・peek 前・読めなかった上階・検討案の平面は null', async () => {
  const mid = setup({ activeIndex: 1 });
  assert.equal(mid.state.upperFloorGraph, null, 'peek 前は引けない');
  await withPeek(mid.peek, () => mid.state._loadStairChains());
  const upper = mid.state.upperFloorGraph;
  assert.equal(upper.plane.id, 'p3');
  assert.notEqual(upper, mid.graphs[2], '本番の peek 同型（復元した別インスタンス）');
  assert.equal(upper, mid.state._otherFloor('p3').graph, '再 peek せず otherFloors から引く');

  const bottom = setup({ activeIndex: 0 });
  await withPeek(bottom.peek, () => bottom.state._loadStairChains());
  assert.equal(bottom.state.upperFloorGraph.plane.id, 'p2', '直上階は 1 つ上だけ（p3 ではない）');

  const top = setup({ activeIndex: 2 });
  await withPeek(top.peek, () => top.state._loadStairChains());
  assert.equal(top.state.upperFloorGraph, null, '最上階は上階が無い');

  const unreadable = setup({ activeIndex: 1 });
  await withPeek(async (plane) => (plane.id === 'p3' ? null : unreadable.peek(plane)), () => unreadable.state._loadStairChains());
  assert.equal(unreadable.state.upperFloorGraph, null, '上階が読めなければ null（候補は幾何だけで絞る）');

  const alt = setup();
  const { graph: altGraph } = alt.project.addPlane(3000, '検討', 'alt', 2, 1, true, 'p2', 1);
  alt.project.activePlaneId = 'alt';
  const altState = new FinishModeState(altGraph, alt.project);
  await withPeek(alt.peek, () => altState._loadStairChains());
  assert.equal(altState.upperFloorGraph, null, '検討案の平面は採用階の並びに無い');
});

test('【失敗系】init: peek の失敗は握りつぶさず reject（遠い階の失敗でも）', async () => {
  const { state, peek } = setup({ activeIndex: 0 });
  await withPeek(async (plane) => { if (plane.id === 'p3') throw new Error('p3 の読み失敗'); return peek(plane); }, async () => {
    await assert.rejects(() => state.init(), /p3 の読み失敗/);
  });
});
