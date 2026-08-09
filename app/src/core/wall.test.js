// Wall.faceDir/faceDirOr（core.jsリファクタ: 仕上げ面が向く側導出の統合）の回帰テスト。
// materialRange 内の dir 導出は Wall.faceDir に集約されているが、finishSide が axisOffset の
// naive な符号と食い違うケース（CL偏芯）で dir の向きを取り違えても270件全緑で通過してしまう
// 穴があった（QA指摘）。この穴を塞ぐ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph } from './planGraph.js';
import { Plane } from './plane.js';
import { CenterLineType, Discipline } from './constants.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

test('Wall.materialRange: finishSide明示指定がaxisOffsetのnaiveな符号より優先される（CL偏芯で符号が食い違うケース）', () => {
  const graph = graphWithWall();
  const { wall } = graph;

  const { lo, hi } = wall.materialRange;
  // axisOffset=-50(負) → naiveなsign(axisOffset)=-1 だが finishSide=1 明示のため dir=+1。
  // finBoundary = faceV(-50) - dir(+1)*wallFinish(12.5) = -62.5 → 仕上げ帯は[-62.5, -50]。
  assert.equal(lo, -62.5, 'finishSide=1優先ならfaceV(-50)からさらにマイナス側へ伸びるはず');
  assert.equal(hi, -50);
  // dirが反転（naiveなsign(axisOffset)=-1）した場合は[-50, -37.5]になり、上のlo/hiとは一致しない
  // ——faceDirOrの符号をどちらへ反転させても本テストは必ず落ちる。
  assert.notEqual(lo, -50, 'naiveなsign(axisOffset)方向の結果(-50)とは一致しないはず');
  assert.notEqual(hi, -37.5, 'naiveなsign(axisOffset)方向の結果(-37.5)とは一致しないはず');
});

function graphWithWall() {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  // backingDepth:0（下地なし＝仕上げのみの薄壁）にして、materialRange の結果が finLo/finHi
  // （dirに依存する項）に直結し、backingCenterV側の項に埋もれないようにする。
  const wall = graph.addWall(axisCL, -50, false, clStart, 0, clEnd, 0, {
    finishSide: 1, wallFinish: 12.5, backingOffset: 0, backingDepth: 0,
  });
  return { graph, wall };
}
