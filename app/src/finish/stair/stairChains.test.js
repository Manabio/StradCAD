// buildStairChains（上下に連なる階段の連鎖の導出）と isChainOpen（既定の開閉）のテスト。
// 前提は実際の経路（placeStair = 部屋を作って applyNaming）で各階へ個別に階段を指定して作る
// （各階の階段はユーザーの個別指定。上階への吹抜けの展開は行わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStairChains, isChainOpen, stairContinuesAbove, findContinuation } from './stairChains.js';
import { setupProject, addPerFloorV, placeStair } from './stairRemovalTestFixtures.js';

const LEFT = [250, 500];
const RIGHT = [750, 500];
const FAR = [1500, 500];

const floorsOf = (graphs) => graphs.map(g => ({ plane: g.plane, graph: g }));
const idsOf = (chain) => chain.members.map(m => m.planeId);

test('3階建てで 1F→2F→3F の足元が重なれば連鎖1本（先頭 key・from/to・メンバー順）', () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const stairs = graphs.map(g => placeStair(project, g, { pts: [LEFT] }).stair);
  const chains = buildStairChains(floorsOf(graphs), project.structGraph);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].members, stairs.map((s, i) => ({ planeId: `p${i + 1}`, stairId: s.id })));
  assert.equal(chains[0].key, `p1:${stairs[0].id}`);
  assert.equal(chains[0].fromPlaneId, 'p1');
  assert.equal(chains[0].toPlaneId, 'p3');
});

test('1F と 2F の階段が別位置なら単独2本（最下階から・各 from=to）', () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const s1 = placeStair(project, graphs[0], { pts: [LEFT] }).stair;
  const s2 = placeStair(project, graphs[1], { pts: [RIGHT] }).stair;
  const chains = buildStairChains(floorsOf(graphs), project.structGraph);
  assert.deepEqual(chains.map(c => c.key), [`p1:${s1.id}`, `p2:${s2.id}`]);
  assert.deepEqual(chains.map(c => [c.fromPlaneId, c.toPlaneId]), [['p1', 'p1'], ['p2', 'p2']]);
});

test('2F で足元を広げた続き階段（1F の足元と一部だけ重なる）も連鎖。広げた分の 3F の階段もつながる', () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  placeStair(project, graphs[0], { pts: [LEFT] });
  placeStair(project, graphs[1], { pts: [LEFT, RIGHT] });
  placeStair(project, graphs[2], { pts: [RIGHT] });
  const chains = buildStairChains(floorsOf(graphs), project.structGraph);
  assert.equal(chains.length, 1);
  assert.deepEqual(idsOf(chains[0]), ['p1', 'p2', 'p3']);
});

test('足元を写せない階（対応する中心線が無い）で連鎖は切れる', () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs.slice(0, 2)); // 3F には per-floor 中心線 x=500 が無い
  placeStair(project, graphs[0], { pts: [LEFT] });
  const s2 = placeStair(project, graphs[1], { pts: [LEFT] }).stair;
  const s3 = placeStair(project, graphs[2], { pts: [FAR] }).stair;
  const chains = buildStairChains(floorsOf(graphs), project.structGraph);
  assert.equal(chains.length, 2);
  assert.deepEqual(idsOf(chains[0]), ['p1', 'p2']);
  assert.deepEqual(chains[1].members, [{ planeId: 'p3', stairId: s3.id }]);
  assert.notEqual(s2.id, s3.id);
});

test('隣接でない階（間の階に階段が無い）は連鎖にしない', () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  placeStair(project, graphs[0], { pts: [LEFT] });
  placeStair(project, graphs[2], { pts: [LEFT] });
  const chains = buildStairChains(floorsOf(graphs), project.structGraph);
  assert.deepEqual(chains.map(idsOf), [['p1'], ['p3']]);
});

test('分岐: 1つの続きを2つの下階の階段が取り合うときは先頭だけが取り、もう一方は単独の連鎖', () => {
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs);
  const a = placeStair(project, graphs[0], { pts: [LEFT] }).stair;
  const b = placeStair(project, graphs[0], { pts: [RIGHT] }).stair;
  placeStair(project, graphs[1], { pts: [LEFT, RIGHT] });
  const chains = buildStairChains(floorsOf(graphs), project.structGraph);
  assert.equal(chains.length, 2);
  assert.deepEqual(chains.map(c => c.key), [`p1:${a.id}`, `p1:${b.id}`]);
  assert.deepEqual(idsOf(chains[0]), ['p1', 'p2']);
  assert.deepEqual(idsOf(chains[1]), ['p1']);
});

test('【失敗系】floors が空なら []・undefined でも []', () => {
  assert.deepEqual(buildStairChains([], {}), []);
  assert.deepEqual(buildStairChains(undefined, {}), []);
});

test('【失敗系】plane が無い階があれば throw', () => {
  const { project, graphs } = setupProject(2);
  const floors = [{ plane: graphs[0].plane, graph: graphs[0] }, { plane: null, graph: graphs[1] }];
  assert.throws(() => buildStairChains(floors, project.structGraph), /plane/);
});

test('【失敗系】読めなかった階（graph が null）はその位置で連鎖を切る（throw しない。階段なしの階として扱う）', () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  graphs.forEach(g => placeStair(project, g, { pts: [LEFT] }));
  const floors = floorsOf(graphs);
  floors[1] = { plane: graphs[1].plane, graph: null };
  assert.deepEqual(buildStairChains(floors, project.structGraph).map(idsOf), [['p1'], ['p3']]);
});

test('階段が1つも無ければ []', () => {
  const { project, graphs } = setupProject(2);
  assert.deepEqual(buildStairChains(floorsOf(graphs), project.structGraph), []);
});

const chainOf = { key: 'k', members: [{ planeId: 'p1', stairId: 's1' }, { planeId: 'p2', stairId: 's2' }] };

test('isChainOpen: 既定は閉・選択中の階段を含むグループは開く', () => {
  assert.equal(isChainOpen(chainOf, null, new Map()), false);
  assert.equal(isChainOpen(chainOf, 'zzz', new Map()), false);
  assert.equal(isChainOpen(chainOf, 's2', new Map()), true);
  assert.equal(isChainOpen(chainOf, 's1', undefined), true);
});

test('isChainOpen: ユーザーの開閉の操作（overrides）が既定より優先される', () => {
  assert.equal(isChainOpen(chainOf, null, new Map([['k', true]])), true);
  assert.equal(isChainOpen(chainOf, 's1', new Map([['k', false]])), false);
});

test('stairContinuesAbove: 上階に足元が重なる階段があれば true・別位置なら false・上階の graph が無ければ null', () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const s1 = placeStair(project, graphs[0], { pts: [LEFT] }).stair;
  const s2 = placeStair(project, graphs[1], { pts: [LEFT] }).stair;
  assert.equal(stairContinuesAbove(s1, graphs[0], graphs[1], project.structGraph), true);
  assert.equal(stairContinuesAbove(s2, graphs[1], graphs[2], project.structGraph), false, '3F に階段なし');
  assert.equal(stairContinuesAbove(s2, graphs[1], null, project.structGraph), null);
  assert.equal(stairContinuesAbove(s2, graphs[1], undefined, project.structGraph), null);
});

test('stairContinuesAbove: 上階の階段が別位置なら false（足元が重ならない）', () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const s1 = placeStair(project, graphs[0], { pts: [LEFT] }).stair;
  placeStair(project, graphs[1], { pts: [RIGHT] });
  assert.equal(stairContinuesAbove(s1, graphs[0], graphs[1], project.structGraph), false);
});

test('findContinuation: isClaimed が真の階段は選ばない', () => {
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs);
  const s1 = placeStair(project, graphs[0], { pts: [LEFT] }).stair;
  const s2 = placeStair(project, graphs[1], { pts: [LEFT] }).stair;
  assert.equal(findContinuation(s1, graphs[0], graphs[1], project.structGraph)?.id, s2.id);
  assert.equal(findContinuation(s1, graphs[0], graphs[1], project.structGraph, t => t.id === s2.id), null);
});
