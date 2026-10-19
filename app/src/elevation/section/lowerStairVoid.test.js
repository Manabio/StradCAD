// lowerStairVoid.js（下階の階段の吹抜けの上の列）の単体テスト。
// フィクスチャは sectionStair.test.js の折返し階段（踊り場 y:0..1500 全幅、往路 x:0..1000・復路 x:1000..2000、
// y:1500..4500、upDirection 'up'・flip=false）。破れ線先セルは復路レーン（x:1000..2000）の 1 セル。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomKind } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { cellsBeyondBreak } from '../../finish/stair/stairGeometry.js';
import { lowerStairVoidRanges, mergeRanges, inRanges } from './lowerStairVoid.js';

function makeGraph(name = 'p1') {
  return new PlanGraph(new Plane(name, 0, `${name}階`, 1, 1));
}

function makeSwitchbackFixture(graph, { flip = false } = {}) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const cells = new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`, `${x0.id}:${ym.id}:${xm.id}:${y1.id}`, `${xm.id}:${ym.id}:${x1.id}:${y1.id}`]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], riser: null, upDirection: 'up', flip });
  return { room, stair, cls: { x0, xm, x1, y0, ym, y1 } };
}

// seq1 相当: 踊り場の前縁 y=1500 に立ち、上り口（+y）を見る全幅の切断。ローカル x＝世界 x（dirSign 1・原点 lo=0）
const seq1Cut = () => ({ line: { isVertical: false, axisValue: 1500, lo: 0, hi: 2000 }, viewSign: 1, dirSign: 1 });

test('【前提】フィクスチャの破れ線先セルは復路レーン（x:1000..2000）の 1 セル', () => {
  const lower = makeGraph('p1');
  const { stair } = makeSwitchbackFixture(lower);
  assert.equal(cellsBeyondBreak(stair, lower, null).size, 1);
});

test('【指示2026-10-19】lowerStairVoidRanges: 踊り場の前縁の切断は、下階の階段の破れ線先セル（復路レーン）の幅だけが吹抜けの区間', () => {
  const lower = makeGraph('p1');
  makeSwitchbackFixture(lower);
  assert.deepEqual(lowerStairVoidRanges(seq1Cut(), lower), [{ lo: 1000, hi: 2000 }]);
});

test('【指示2026-10-19】lowerStairVoidRanges: 回転が逆（flip）なら往路側のレーンが吹抜け。dirSign=-1 はローカル x を反転', () => {
  const lower = makeGraph('p1');
  makeSwitchbackFixture(lower, { flip: true });
  assert.deepEqual(lowerStairVoidRanges(seq1Cut(), lower), [{ lo: 0, hi: 1000 }]);
  // 原点が hi 側（x=2000）で左右が逆: 世界 0..1000 → ローカル 1000..2000
  assert.deepEqual(lowerStairVoidRanges({ ...seq1Cut(), dirSign: -1 }, lower), [{ lo: 1000, hi: 2000 }]);
});

test('【指示2026-10-19】lowerStairVoidRanges: 切断線の範囲（lo/hi）で切り詰める。縦断する切断（復路レーンの中）は切断線の全長', () => {
  const lower = makeGraph('p1');
  makeSwitchbackFixture(lower);
  assert.deepEqual(lowerStairVoidRanges({ ...seq1Cut(), line: { isVertical: false, axisValue: 1500, lo: 500, hi: 1500 } }, lower), [{ lo: 500, hi: 1000 }]);
  const along = { line: { isVertical: true, axisValue: 1500, lo: 1500, hi: 4500 }, viewSign: 1, dirSign: 1 };
  assert.deepEqual(lowerStairVoidRanges(along, lower), [{ lo: 0, hi: 3000 }]);
});

test('【裁定2026-10-19】lowerStairVoidRanges: 区間の境界が自階の切断壁（隔て板）の材の中なら、壁の吹抜け側の面へ寄せる。隣り合う壁は続けて寄せる', () => {
  const lower = makeGraph('p1');
  makeSwitchbackFixture(lower);
  const self = makeGraph('p2');
  const { cls } = makeSwitchbackFixture(self);
  // 往復間の壁（材 980..1020。境界 1000 を含む）とそれに接する薄壁（1020..1050）。境界 1000 → 1020 → 1050
  const xa = self.addCenterLine(CenterLineType.VERTICAL, 980,  { labeled: false, discipline: Discipline.ARCH });
  const xb = self.addCenterLine(CenterLineType.VERTICAL, 1020, { labeled: false, discipline: Discipline.ARCH });
  const a = self.addWall(xa, 40, true, cls.ym, 0, cls.y1, 0, {});
  const b = self.addWall(xb, 30, true, cls.ym, 0, cls.y1, 0, {});
  assert.deepEqual([a.materialRange, b.materialRange], [{ lo: 980, hi: 1020 }, { lo: 1020, hi: 1050 }], '前提: 壁の材の範囲');
  // 切断線の枠は本番と同じく面＝壁の仕上げ面（57.5..1942.5。ローカル x の原点は lo=57.5）。右の外壁（材 1942.5..2000）は
  // hi 端がその手前の面にあり寄せない。世界 1050..1942.5 → ローカル 992.5..1885
  const faceCut = { ...seq1Cut(), line: { isVertical: false, axisValue: 1500, lo: 57.5, hi: 1942.5 } };
  assert.deepEqual(lowerStairVoidRanges(faceCut, lower, self), [{ lo: 992.5, hi: 1885 }]);
  // 枠が外壁の外側の面（CL 2000）まであれば、hi 端は外壁の材の中＝壁の吹抜け側（室内側）の面 1942.5 へ寄る
  assert.deepEqual(lowerStairVoidRanges(seq1Cut(), lower, self), [{ lo: 1050, hi: 1942.5 }]);
  // 壁が区間の中に無い（境界が材の外）なら寄せない。自階を渡さなければ寄せない
  assert.deepEqual(lowerStairVoidRanges({ ...faceCut, line: { ...faceCut.line, lo: 1200 } }, lower, self), [{ lo: 0, hi: 742.5 }]);
  assert.deepEqual(lowerStairVoidRanges(seq1Cut(), lower, null), [{ lo: 1000, hi: 2000 }]);
});

test('【失敗系】lowerStairVoidRanges: 直下階なし・切断線なし・セルを通らない深さ・屋外の階段・破れ線先セルなしは []', () => {
  const lower = makeGraph('p1');
  const { stair, room } = makeSwitchbackFixture(lower);
  assert.deepEqual(lowerStairVoidRanges(seq1Cut(), null), []);
  assert.deepEqual(lowerStairVoidRanges({ viewSign: 1, dirSign: 1 }, lower), []);
  // 踊り場の奥（y=500）はセルの外
  assert.deepEqual(lowerStairVoidRanges({ ...seq1Cut(), line: { isVertical: false, axisValue: 500, lo: 0, hi: 2000 } }, lower), []);
  // 視線が踊り場側（-y）なら PROBE_EPS だけ戻った点は踊り場のセル＝吹抜けではない
  assert.deepEqual(lowerStairVoidRanges({ ...seq1Cut(), viewSign: -1 }, lower), []);
  room.kind = RoomKind.EXTERIOR;
  assert.deepEqual(lowerStairVoidRanges(seq1Cut(), lower), []);
  room.kind = RoomKind.INTERIOR;
  stair.type = StairType.STRAIGHT; // 直進系は riser 無しで破れが決まらない構成もある。ここでは型を壊して空を確かめる
  stair.sections = [];
  assert.deepEqual(lowerStairVoidRanges(seq1Cut(), lower), []);
});

test('mergeRanges / inRanges: 重なる・接する区間を結合し昇順。退化した区間は捨てる。端を含む', () => {
  assert.deepEqual(mergeRanges([{ lo: 5, hi: 10 }, { lo: 0, hi: 5 }, { lo: 20, hi: 30 }, { lo: 25, hi: 26 }, { lo: 40, hi: 40 }]),
    [{ lo: 0, hi: 10 }, { lo: 20, hi: 30 }]);
  assert.equal(inRanges([{ lo: 0, hi: 10 }], 10), true);
  assert.equal(inRanges([{ lo: 0, hi: 10 }], 10.5), false);
  assert.equal(inRanges(null, 1), false);
});
