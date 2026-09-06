// 階段下部屋（2a）の壁生成のうち、壁の**向き**の規約に関するテスト。
//
// 2a壁は帯（オーナー壁＋仕上げのみの薄壁）を軸CLに対して非対称に置く偏芯壁で、
// 薄壁の仕上げ面がどちら側を向くかは axisOffset の符号からは導けない場合がある
// （Wall.faceDirOr の既定は sign(axisOffset)）。向きが逆になると面線と内側線が
// 入れ替わり、取り合い（renderer/wallJunctionResolve.js パス2）が帯の外形線を
// 内側線として扱ってしまう。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { LANE_CLEARANCE, laneStairSideThinProps } from './stairUnderWalls.js';

function makeWall(axisOffset, props) {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const axisCL = g.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clA = g.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clB = g.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  return g.addWall(axisCL, axisOffset, true, clA, 0, clB, 0, { isRoomWall: true, ...props });
}

for (const sign of [1, -1]) {
  test(`ルール6の階段側仕上げ薄壁(sign=${sign}): 帯は [CL+sign*50, CL+sign*(50+f_st)]・仕上げ面は階段側(CL寄り)を向く`, () => {
    const stFinish = 12.5;
    const { axisOffset, ...props } = laneStairSideThinProps(sign, stFinish);
    const w = makeWall(axisOffset, props);

    const near = sign * LANE_CLEARANCE;               // CL寄りの端＝階段側の仕上げ面
    const far  = sign * (LANE_CLEARANCE + stFinish);  // 部屋側の端＝下地と接する内側線
    assert.deepEqual(w.materialRange,
      { lo: Math.min(near, far), hi: Math.max(near, far) },
      '材の帯は逃げ量50mmの外側に仕上げ厚ぶんだけ載るはず');
    assert.equal(w.axisValue, near, '仕上げ面は帯のCL寄りの端（階段側）にあるはず');
    assert.equal(w.faceDir, -sign, '仕上げ面は階段側（部屋と逆向き）を向くはず');
    assert.equal(w.axisValue - w.faceDir * w.wallFinish, far,
      '内側線（仕上げ／下地の境界）は帯の部屋寄りの端にあるはず');
  });
}
