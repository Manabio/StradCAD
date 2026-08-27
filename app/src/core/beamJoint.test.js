// 梁の接合方法（剛接合／ピン接合）の既定値・描画分岐・継手位置の単体テスト。
// 仕様（問題.md）: 初期値は剛接合、ただし梁芯CL追加で自動生成される小梁（role:'secondary'）はピン接合。
// 接合は鉄骨の梁でのみ意味を持ち、剛接合は構造芯から900内側に継手記号を描く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph } from './planGraph.js';
import { Plane } from './plane.js';
import { CenterLineType, Discipline, StructuralMaterialType } from './constants.js';
import { RIGID_JOINT_OFFSET_MM, SECONDARY_BEAM_CLEARANCE_MM } from './structuralEntities.js';

// X1=0 / X2=10000、Y1=0 / Y2=6000 の通り芯。梁はY方向（X1軸沿い）に張る。
function setupGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   0,     { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   10000, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000,  { labeled: true, discipline: Discipline.STRUCT });
  return { graph, x1, x2, y1, y2 };
}

const STEEL = StructuralMaterialType.STEEL;
const addBeam = (graph, x, y1, y2, props) => graph.addBeam(STEEL, 'STEEL-H200x100', x, true, y1, y2, props);

// ---- 既定値 ----

test('jointType: 既定は剛接合（RIGID）', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, {});
  assert.equal(beam.jointType, 'RIGID');
  assert.equal(beam.hasRigidJoint, true);
  assert.equal(beam.isPinJoint, false);
});

test('jointType: 中心線追加による小梁（role:secondary）はピン接合が初期値', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, { role: 'secondary', beamType: '小梁' });
  assert.equal(beam.jointType, 'PIN');
  assert.equal(beam.isPinJoint, true);
  assert.equal(beam.hasRigidJoint, false);
});

test('jointType: 明示指定は role 既定より優先される（小梁を剛接合に変更できる）', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, { role: 'secondary', jointType: 'RIGID' });
  assert.equal(beam.isPinJoint, false);
  assert.equal(beam.hasRigidJoint, true);
});

// 【回帰点】木造・RCの梁は jointType を見ない（木造梁は jointCondition 既定がピン寄りのため、
// 材種を問わず jointType で分岐させると既存の木造大梁の端部処理まで変わってしまう）。
test('isPinJoint: 鉄骨以外は jointType ではなく role（小梁のみピン）で決まる', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const woodPrimary   = graph.addBeam(StructuralMaterialType.WOOD, 'SEC-BEAM', x1, true, y1, y2, { jointType: 'PIN' });
  const woodSecondary = graph.addBeam(StructuralMaterialType.WOOD, 'SEC-BEAM', x1, true, y1, y2, { role: 'secondary', jointType: 'RIGID' });
  assert.equal(woodPrimary.isPinJoint, false, '木造の大梁は jointType=PIN でもピン扱いにしない');
  assert.equal(woodSecondary.isPinJoint, true, '木造の小梁は jointType=RIGID でも従来どおりピン扱い');
  assert.equal(woodPrimary.hasRigidJoint, false, '継手記号は鉄骨のみ');
});

// ---- 継手位置（構造芯から900内側・両端） ----

test('rigidJointCoords: 両端の構造芯から900内側の2箇所を返す', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, {});
  assert.deepEqual(beam.rigidJointCoords([]), [RIGID_JOINT_OFFSET_MM, 6000 - RIGID_JOINT_OFFSET_MM]);
});

test('rigidJointCoords: ピン接合の梁は継手記号を持たない', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, { jointType: 'PIN' });
  assert.deepEqual(beam.rigidJointCoords([]), []);
});

test('rigidJointCoords: 描画区間の内側に入らない短スパンでは継手を描かない', () => {
  const { graph, x1, y1 } = setupGraph();
  const yShort = graph.addCenterLine(CenterLineType.HORIZONTAL, 1200, { labeled: true, discipline: Discipline.STRUCT });
  const beam = addBeam(graph, x1, y1, yShort, {});
  assert.deepEqual(beam.rigidJointCoords([]), [], 'スパン1200 < 900×2 なので両方とも区間外');
});

// ---- 端部処理（ピン接合は母材から離して終える） ----

test('spanForColumns: 剛接合の梁は従来どおりCL位置まで通しで描く（柱なし）', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, {});
  assert.deepEqual(beam.spanForColumns([]), { coord1: 0, coord2: 6000 });
});

test('spanForColumns: ピン接合に指定した大梁は両端をクリアランス分だけ手前で止める', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, { jointType: 'PIN' });
  assert.deepEqual(beam.spanForColumns([]), {
    coord1: SECONDARY_BEAM_CLEARANCE_MM,
    coord2: 6000 - SECONDARY_BEAM_CLEARANCE_MM,
  });
});

// ---- 柱に接合する梁か（構造リストの接合2択のグレー化判定） ----

test('joinsColumn: 端部に柱がある梁は true（接合方法を選べる）', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, {});
  graph.addColumn(STEEL, 'STEEL-BOX-200x200x9', x1, y1);
  assert.equal(beam.joinsColumn(graph.columns), true);
});

test('joinsColumn: どちらの端部にも柱が無い梁（梁に接合する小梁）は false', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, { role: 'secondary' });
  assert.equal(beam.joinsColumn([]), false);
});
