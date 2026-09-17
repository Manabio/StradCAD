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

// ---- Wall.backingRange（柱寸法が基準より細い階の外壁下地帯シフト。structural/structureRules.js
// woodBaseColumnWidthMm 参照。finish/wallGeneration.js generateExteriorWalls）----
// backingDepth===null（対称壁の既定式）の枝が backingOffset を無視していた（帯が動いても
// backingRange は常に axisCL 中心のまま＝シフトが反映されない）バグの回帰テスト。
function graphWithSymmetricWall({ axisOffset, backingOffset, wallFinish = 0 }) {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  // backingDepth は明示しない（null＝対称フォールバック式の対象）。
  const wall = graph.addWall(axisCL, axisOffset, false, clStart, 0, clEnd, 0, {
    wallFinish, backingOffset,
  });
  return wall;
}

test('Wall.backingRange: backingDepth===null（対称壁）でも backingOffset があれば帯ごと平行移動する（柱寸105の外壁: 外面は通り芯±60に固定、帯厚は105に縮み、室内側の縁だけ後退する）', () => {
  // finish/wallGeneration.js generateExteriorWalls が実際に生成する値を再現する:
  // wallBase=105・wallFinish=12.5・bandShift=(120-105)/2=7.5、室外側(負)へ寄せた外壁。
  // axisOffset = -(wallBase/2+wallFinish) - bandShift = -(52.5+12.5)-7.5 = -72.5
  // backingOffset = e = -bandShift = -7.5
  const wall = graphWithSymmetricWall({ axisOffset: -72.5, backingOffset: -7.5, wallFinish: 12.5 });
  const { lo, hi } = wall.backingRange;
  assert.equal(hi - lo, 105, '帯厚はwallBase(105)そのもの——シフトしても厚みは変わらない');
  assert.equal(lo, -60, '外面（軸から遠い側）は柱寸120の既定と同じ通り芯±60に固定されたまま');
  assert.equal(hi, 45, '室内側の縁は(120-105)=15だけ後退する（既定の60から45へ）');
});

test('Wall.backingRange: backingOffset===null（従来の対称壁）は axisCL 中心のまま（既存挙動。柱寸120の既定に相当）', () => {
  // wallBase=120・wallFinish=12.5・シフトなし: axisOffset = -(120/2+12.5) = -72.5
  const wall = graphWithSymmetricWall({ axisOffset: -72.5, backingOffset: null, wallFinish: 12.5 });
  const { lo, hi } = wall.backingRange;
  assert.equal(lo, -60);
  assert.equal(hi, 60);
});
