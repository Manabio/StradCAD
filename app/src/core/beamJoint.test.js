// 梁の接合方法（剛接合／ピン接合）の既定値・描画分岐・継手位置の単体テスト。
// 仕様: 初期値は剛接合、ただし梁芯CL追加で自動生成される小梁（role:'secondary'）はピン接合。
// 接合は鉄骨の梁でのみ意味を持ち、剛接合は構造芯から900内側に継手記号を描く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph } from './planGraph.js';
import { Plane } from './plane.js';
import { CenterLineType, Discipline, StructuralMaterialType } from './constants.js';
import { RIGID_JOINT_OFFSET_MM, SECONDARY_BEAM_CLEARANCE_MM, PIN_ROLES } from './structuralEntities.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { CenterLine } from './centerLine.js';

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

// 【ステップ3e-2・床梁／C2a・小屋梁】PIN_ROLES=new Set(['secondary','floor','roofBeam']) が「母材から離して終える」
// role集合の単一の定義（isPinJoint・jointType既定・spanForColumnsの早期returnの3か所が読む）。
test('PIN_ROLES: secondary/floor/roofBeamの3値を持つ（C2aで小屋梁を追加。大梁・軒桁・土台などは含まない）', () => {
  assert.deepEqual([...PIN_ROLES].sort(), ['floor', 'roofBeam', 'secondary']);
  for (const role of ['primary', 'foundation', 'sill', 'eaves', 'roof', 'landing']) assert.equal(PIN_ROLES.has(role), false, role);
});

test('【C2a】isPinJoint/jointType: 木造の小屋梁(role:roofBeam)も小梁・床梁と同じくピン扱い。鉄骨の小屋梁はjointTypeが権威', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const roofBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x210', x1, true, y1, y2, { role: 'roofBeam', beamType: '小屋梁' });
  assert.equal(roofBeam.jointType, 'PIN');
  assert.equal(roofBeam.isPinJoint, true);
  assert.equal(roofBeam.hasRigidJoint, false);
  const steel = addBeam(graph, x1, y1, y2, { role: 'roofBeam', jointType: 'RIGID' });
  assert.equal(steel.isPinJoint, false, '鉄骨はjointType=RIGIDならPIN_ROLESに関わらず剛接合扱い（材種で権威を分ける）');
});

test('【C2a】spanForColumns: 小屋梁(role:roofBeam)は床梁と同じくhost（大梁）の縁で止まり、hostが無い端はCL位置まで。既存の小梁・床梁の結果は不変', () => {
  const { graph, x1, x2, y1, y2 } = setupGraph();
  graph.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE);
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'primary' });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const roofBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x210', xMid, true, y1, y2, { role: 'roofBeam' });
  const floorBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y1, y2, { role: 'floor' });
  const secondary = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y1, y2, { role: 'secondary' });
  const expected = { coord1: 120 / 2, coord2: 6000 };
  assert.deepEqual(roofBeam.spanForColumns(graph.columns), expected, '始端(y1)はhostの面まで、終端(y2)はhostが無いのでCL位置まで');
  assert.deepEqual(floorBeam.spanForColumns(graph.columns), expected, '床梁は不変');
  assert.deepEqual(secondary.spanForColumns(graph.columns), expected, '小梁は不変');
  // 【C2e-1a 仕様変更】子が小屋梁・飛び梁（role:roofBeam）のときだけ、直交する小屋梁も host になれる
  // （寄棟の飛び梁が第1段の小屋梁の面で止まるため）。旧表明「小屋梁は小屋梁の面で止まらない」は
  // 「子が小屋梁なら止まる」へ書き換え。床梁・小梁・大梁の子は従来どおり小屋梁の面で止まらない（対照）。
  const other = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x210', y2, false, x1, x2, { role: 'roofBeam' });
  assert.deepEqual(roofBeam.spanForColumns(graph.columns), { coord1: 120 / 2, coord2: 6000 - 120 / 2 }, '終端側の直交する小屋梁(120幅)の面で止まる');
  assert.deepEqual(floorBeam.spanForColumns(graph.columns), expected, '対照: 床梁は小屋梁の面で止まらない');
  assert.deepEqual(secondary.spanForColumns(graph.columns), expected, '対照: 小梁は小屋梁の面で止まらない');
  assert.ok(other);
});

test('isPinJoint/jointType: 木造の床梁(role:floor)も小梁と同じくピン扱い（PIN_ROLES）', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const woodFloor = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, true, y1, y2, { role: 'floor' });
  assert.equal(woodFloor.jointType, 'PIN', '床梁もjointTypeの既定はPIN（コンストラクタがPIN_ROLESを読む）');
  assert.equal(woodFloor.isPinJoint, true);
  assert.equal(woodFloor.hasRigidJoint, false, '継手記号は鉄骨のみ（対象外role以前に材種で除外）');
});

test('【失敗系】isPinJoint: 鉄骨の床梁(role:floor)はjointTypeが権威（PIN_ROLESではなく材種で分岐）', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const steelFloor = addBeam(graph, x1, y1, y2, { role: 'floor', jointType: 'RIGID' });
  assert.equal(steelFloor.isPinJoint, false, '鉄骨はjointType=RIGIDならPIN_ROLESに関わらず剛接合扱い');
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

test('spanForColumns: 床梁(role:floor)も小梁と同じくhost（大梁）の縁+クリアランスで止まる（PIN_ROLES拡張。host解決＝端CLがhostのaxisCL）', () => {
  const { graph, x1, x2, y1, y2 } = setupGraph();
  // host: y1軸沿いの横大梁（x1..x2をカバーし、床梁の始端(y1)に取りつく）。
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'primary' });
  // 床梁: x=5000の縦CLからy1..y2へ架ける（始端y1はhostに取りつき、終端y2はhostが無い）。
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const floorBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y1, y2, { role: 'floor' });
  const halfHost = 120 / 2 + SECONDARY_BEAM_CLEARANCE_MM; // host（幅120）の縁+クリアランス
  assert.deepEqual(floorBeam.spanForColumns(graph.columns), { coord1: halfHost, coord2: 6000 },
    '始端(y1)はhostの縁+クリアランス、終端(y2)はhostが無いのでCL位置まで');
});

test('spanForColumns: 在来木造の階（structureOverride）では小梁・床梁がhost（大梁）の面まで伸びる（クリアランス0。ユーザー裁定2026-09-16）。ピン指定した鉄骨大梁の柱基準経路も同じ0', () => {
  const { graph, x1, x2, y1, y2 } = setupGraph();
  graph.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE);
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'primary' });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const floorBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y1, y2, { role: 'floor' });
  assert.equal(floorBeam.pinEndClearanceMm, 0);
  assert.deepEqual(floorBeam.spanForColumns(graph.columns), { coord1: 120 / 2, coord2: 6000 },
    '始端(y1)はhostの面（縁）まで、終端(y2)はhostが無いのでCL位置まで');
  const secondary = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y1, y2, { role: 'secondary' });
  assert.deepEqual(secondary.spanForColumns(graph.columns), { coord1: 120 / 2, coord2: 6000 }, '小梁も同じ');
  // 在来の階に置いたピン指定の鉄骨大梁（柱基準経路）もクリアランス0（ルール値は材種によらず階の主構造で決まる）。
  const pinSteel = addBeam(graph, x1, y1, y2, { jointType: 'PIN' });
  assert.deepEqual(pinSteel.spanForColumns([]), { coord1: 0, coord2: 6000 });
  // 上書きを外す（未指定主構造）と既定50に戻る＝クリアランスがルール駆動であることの検査。
  graph.setStructureOverride(null);
  assert.equal(floorBeam.pinEndClearanceMm, SECONDARY_BEAM_CLEARANCE_MM);
  assert.deepEqual(floorBeam.spanForColumns(graph.columns), { coord1: 120 / 2 + SECONDARY_BEAM_CLEARANCE_MM, coord2: 6000 });
});

test('【失敗系】pinEndClearanceMm: graph 未設定（_planGraph=null。生成直後の梁）でも例外を投げず既定50（未指定ルール）を返す', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  const beam = addBeam(graph, x1, y1, y2, { jointType: 'PIN' });
  beam._planGraph = null;
  assert.equal(beam.pinEndClearanceMm, SECONDARY_BEAM_CLEARANCE_MM);
  assert.deepEqual(beam.spanForColumns([]), { coord1: SECONDARY_BEAM_CLEARANCE_MM, coord2: 6000 - SECONDARY_BEAM_CLEARANCE_MM });
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

// ---- _columnAtEnd/spanForColumns: 下階柱が自階と別idのCLに乗る場合の座標一致フォールバック ----
// （ステップ1-b。structureRules.js beamEndColumnMatch: 'coordinate'は在来木造のみ）
test('_columnAtEnd/spanForColumns: 在来木造は下階柱が自階と別idの梁芯CL/中心線上でも座標一致で端の柱とみなし面まで止める（beamEndColumnMatch:coordinate）', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  graph.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE);
  // 下階柱は自階のy1とは別idだが同じ座標(y=0)の梁芯CL上（他階のgraphが持つCLを模す）。
  const perFloorY1 = new CenterLine('other-y1', CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.FUSE });
  const belowColumn = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, perFloorY1, {});
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, true, y1, y2, { role: 'primary' });
  assert.equal(beam._columnAtEnd(y1, [belowColumn]), belowColumn, 'id不一致でも座標一致で見つかる');
  assert.deepEqual(beam.spanForColumns([belowColumn]), { coord1: 60, coord2: 6000 }, '柱面(120/2=60)まで止める');
});

// 【B-1・回帰】個別柱の偏心（woodColumnOffset.js）が付いていても座標一致はAXIS（axisX/axisY。
// 偏心を含まない）で行う——ACTUAL（x/y）で判定すると偏心ぶんズレて一致しなくなる（再発防止）。
test('_columnAtEnd: 座標一致（coordinate）はAXIS（axisX/axisY）で判定するため個別柱の偏心があっても取りつく柱を見失わない', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  graph.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE);
  const perFloorY1 = new CenterLine('other-y1', CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.FUSE });
  const belowColumn = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, perFloorY1, { eccentricity: { x: 7.5, y: 0 } });
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, true, y1, y2, { role: 'primary' });
  assert.equal(belowColumn.axisX, 0, '前提: AXISは通り芯位置(0)のまま');
  assert.equal(belowColumn.x, 7.5, '前提: ACTUALは偏心ぶんズレる(7.5)');
  assert.equal(beam._columnAtEnd(y1, [belowColumn]), belowColumn, 'ACTUALがズレていてもAXISで一致し取りつく柱として見つかる');
});

test('【失敗系】_columnAtEnd/spanForColumns: id一致がルール（在来木造以外）では座標が一致しても取りつく柱とみなさない', () => {
  const { graph, x1, y1, y2 } = setupGraph();
  // structureOverride無し（未指定ルール）＝beamEndColumnMatch既定'clId'。
  const perFloorY1 = new CenterLine('other-y1', CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.FUSE });
  const belowColumn = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, perFloorY1, {});
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, true, y1, y2, { role: 'primary' });
  assert.equal(beam._columnAtEnd(y1, [belowColumn]), null, 'id不一致・座標一致でも既定ルールでは柱とみなさない');
  assert.deepEqual(beam.spanForColumns([belowColumn]), { coord1: 0, coord2: 6000 }, 'CL位置まで通し（柱なし扱い）');
});
