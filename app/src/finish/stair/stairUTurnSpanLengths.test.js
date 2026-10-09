// resolveUTurnSpanLengths（U字系＝SWITCHBACK/WINDING の区間長・段数の単一情報源。型判定は内部に1か所）と
// uTurnTurnRect（回転部の世界矩形。型判定なしの幾何）の単体テスト。展開図が回り階段を「段付きの踊り場」として
// 折返しのエンジンに通すための入口で、構造側（resolveSwitchbackSpanLengths・landingRect・landingZ）は
// SWITCHBACK 専用のまま閉じていること（回り階段に踊り場受け梁を作らない）も固定する。
// フィクスチャは elevation/section/sectionStair.test.js の makeSwitchbackFixture と同一構成
// （踊り場 x:0-2000,y:0-1500／往路・復路 y:1500-4500）で、型と sections だけ差し替える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType } from '@core';
import { resolveSwitchbackSpanLengths, resolveUTurnSpanLengths } from './stairClassify.js';
import { landingRect, landingZ, uTurnTurnRect } from './stairLanding.js';
import { generateRoomWallsFromOutline } from '../wallGeneration.js';

function makeFixture(type, sections) {
  const graph = new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
  const V = v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), xm = V(1000), x1 = V(2000);
  const y0 = H(0), ym = H(1500), y1 = H(4500);
  const cells = new Set([
    `${x0.id}:${y0.id}:${x1.id}:${ym.id}`,
    `${x0.id}:${ym.id}:${xm.id}:${y1.id}`,
    `${xm.id}:${ym.id}:${x1.id}:${y1.id}`,
  ]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({ type, cells, roomId: room.id, sections, riser: null, upDirection: 'up', flip: false });
  return { graph, stair };
}

test('resolveUTurnSpanLengths: SWITCHBACK は resolveSwitchbackSpanLengths の値に turnCells:1 を足しただけ', () => {
  const { graph, stair } = makeFixture(StairType.SWITCHBACK, [6, 1, 6]);
  const base = resolveSwitchbackSpanLengths(stair, graph);
  assert.ok(base);
  assert.deepEqual(resolveUTurnSpanLengths(stair, graph), { ...base, turnCells: 1 });
  assert.deepEqual(base, { totalSteps: 12, n1: 6, n2: 6, len1: 3000, landingLen: 1500, len2: 3000 });
});

test('resolveUTurnSpanLengths: WINDING [5,6,5] は n1=5・n2=5・turnCells=6・総蹴上15、区間長は実測 [往路, 回転部の深さ, 復路]', () => {
  const { graph, stair } = makeFixture(StairType.WINDING, [5, 6, 5]);
  assert.deepEqual(resolveUTurnSpanLengths(stair, graph), {
    totalSteps: 15, n1: 5, n2: 5, turnCells: 6, len1: 3000, landingLen: 1500, len2: 3000,
  });
});

test('resolveUTurnSpanLengths: WINDING で sections が未設定なら defaultSections（[7,3,6]）から取る', () => {
  const { graph, stair } = makeFixture(StairType.WINDING, null);
  const u = resolveUTurnSpanLengths(stair, graph);
  assert.ok(u);
  assert.equal(u.n1, 7);
  assert.equal(u.turnCells, 3);
  assert.equal(u.n2, 6);
});

test('【失敗系】resolveUTurnSpanLengths: U字系以外・stair 未指定・sections が数でなければ null', () => {
  assert.equal(resolveUTurnSpanLengths(null, null), null);
  const lturn = makeFixture(StairType.L_TURN, [5, 3, 5]);
  assert.equal(resolveUTurnSpanLengths(lturn.stair, lturn.graph), null);
  const straight = makeFixture(StairType.STRAIGHT, null);
  assert.equal(resolveUTurnSpanLengths(straight.stair, straight.graph), null);
  const bad = makeFixture(StairType.WINDING, [5, 6, 5]);
  bad.stair.setField('sections', [5, NaN, 5]);
  assert.equal(resolveUTurnSpanLengths(bad.stair, bad.graph), null);
});

test('【回帰】構造側は閉じたまま: resolveSwitchbackSpanLengths・landingRect・landingZ は WINDING で null', () => {
  const { graph, stair } = makeFixture(StairType.WINDING, [5, 6, 5]);
  assert.equal(resolveSwitchbackSpanLengths(stair, graph), null);
  assert.equal(landingRect(stair, graph), null);
  assert.equal(landingZ(stair, graph, 3000), null);
});

test('uTurnTurnRect: SWITCHBACK では landingRect と同じ矩形、WINDING では回転部（y:0-1500）の矩形', () => {
  const sb = makeFixture(StairType.SWITCHBACK, [6, 1, 6]);
  const frame = uTurnTurnRect(sb.stair, sb.graph, resolveSwitchbackSpanLengths(sb.stair, sb.graph));
  assert.deepEqual(frame.rect, landingRect(sb.stair, sb.graph));
  assert.equal(frame.vertical, true);
  const wd = makeFixture(StairType.WINDING, [5, 6, 5]);
  const wframe = uTurnTurnRect(wd.stair, wd.graph, resolveUTurnSpanLengths(wd.stair, wd.graph));
  assert.deepEqual(wframe.rect, { x1: 0, y1: 0, x2: 2000, y2: 1500 });
});

test('【失敗系】uTurnTurnRect: 区間長が無ければ null', () => {
  const { graph, stair } = makeFixture(StairType.WINDING, [5, 6, 5]);
  assert.equal(uTurnTurnRect(stair, graph, null), null);
});
