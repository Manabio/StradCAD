// prepareCenterLineMove（平面・天伏が共有する CL 移動の準備）。範囲解決とエラー文言が、FloorplanModeState.startMove の
// 旧実装（本ファイルの oracle＝抽出前の本体そのまま）と同値であることを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { prepareCenterLineMove } from './clMove.js';
import { resolveMoveRange } from '../transform/followerGraph.js';
import { ERR_CL_MOVE_TOO_DEEP, ERR_CL_MOVE_TOO_MANY, ERR_CL_MOVE_LOAD_FAILED } from '../error.js';

// 抽出前の FloorplanModeState.startMove の本体（runBusy・runInAction を除く）をそのまま写した参照実装。
async function oracle(project, graph, cl, pending) {
  const promise = (pending?.clId === cl.id) ? pending.promise : resolveMoveRange(project, graph, cl);
  let result;
  try {
    result = await promise;
  } catch {
    return ERR_CL_MOVE_LOAD_FAILED;
  }
  if (result.exceeded) {
    const msgs = [];
    const { depth, count } = result.exceeded;
    if (depth) msgs.push(ERR_CL_MOVE_TOO_DEEP(depth.actual - depth.max, depth.max));
    if (count) msgs.push(ERR_CL_MOVE_TOO_MANY(count.actual - count.max, count.max));
    return msgs.join(' ');
  }
  return { cl, originalValue: cl.value, range: result.range };
}

const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

function setup() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const arch = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL, 0, arch);
  graph.addCenterLine(CenterLineType.VERTICAL, 4000, arch);
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 2000, arch);
  return { project: {}, graph, cl };
}

test('prepareCenterLineMove: 先読み無しは範囲を解決して moveState を返す（旧実装と同値）', async () => {
  const { project, graph, cl } = setup();
  const r = await prepareCenterLineMove(project, graph, cl, null);
  assert.equal(r.error, null);
  assert.deepEqual(r.moveState, { cl, originalValue: 2000, range: { min: 0, max: 4000 } });
  assert.deepEqual(r.moveState, await oracle(project, graph, cl, null));
});

test('prepareCenterLineMove: 同じ cl の先読み結果を使い、別 cl の先読みは捨てて解決し直す', async () => {
  const { project, graph, cl } = setup();
  const used = await prepareCenterLineMove(project, graph, cl, { clId: cl.id, promise: Promise.resolve({ range: { min: -10, max: 10 } }) });
  assert.deepEqual(used.moveState.range, { min: -10, max: 10 }, '先読みの範囲を使う');
  const ignored = await prepareCenterLineMove(project, graph, cl, { clId: 'other', promise: Promise.resolve({ range: { min: -10, max: 10 } }) });
  assert.deepEqual(ignored.moveState.range, { min: 0, max: 4000 }, '別 cl の先読みは使わない');
});

test('【失敗系】prepareCenterLineMove: 先読みが reject なら ERR_CL_MOVE_LOAD_FAILED（moveState なし）', async () => {
  const { project, graph, cl } = setup();
  const pending = { clId: cl.id, promise: Promise.reject(new Error('IDB読込失敗')) };
  const r = await quiet(() => prepareCenterLineMove(project, graph, cl, pending));
  assert.deepEqual(r, { moveState: null, error: ERR_CL_MOVE_LOAD_FAILED });
});

test('【失敗系】prepareCenterLineMove: 閾値超過の文言（深さ・本数・両方）が旧実装と一致する', async () => {
  const { project, graph, cl } = setup();
  const cases = [
    { depth: { actual: 5, max: 3 } },
    { count: { actual: 40, max: 30 } },
    { depth: { actual: 5, max: 3 }, count: { actual: 40, max: 30 } },
  ];
  for (const exceeded of cases) {
    const pending = () => ({ clId: cl.id, promise: Promise.resolve({ exceeded }) });
    const r = await prepareCenterLineMove(project, graph, cl, pending());
    assert.equal(r.moveState, null);
    assert.equal(r.error, await oracle(project, graph, cl, pending()), JSON.stringify(exceeded));
  }
  const both = await prepareCenterLineMove(project, graph, cl, { clId: cl.id, promise: Promise.resolve({ exceeded: cases[2] }) });
  assert.equal(both.error, `${ERR_CL_MOVE_TOO_DEEP(2, 3)} ${ERR_CL_MOVE_TOO_MANY(10, 30)}`, '深さ・本数の順に半角スペースで連結');
});
