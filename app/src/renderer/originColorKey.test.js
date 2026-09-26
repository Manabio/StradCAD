import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centerLineOriginColorKey, columnOriginColorKey, columnOriginMarkKey } from './originColorKey.js';
import { originColor, ORIGIN_LIGHTNESS, ORIGIN_LIGHT_LIFT, ORIGIN_NONE_COLOR } from './canvasStyle.js';
import { CenterLine, BeamAxisOrigin } from '../core/centerLine.js';
import { CenterLineType, Discipline, StructuralMaterialType } from '../core/constants.js';
import { Plane } from '../core/plane.js';
import { PlanGraph } from '../core/planGraph.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from '../structural/structureRules.js';

// centerLineKind の4種別（app/src/core/centerLine.js centerLineKind）を実物のCenterLineで再現し、
// 由来キーへの写像を確認する（app/src/core/beamJoint.test.js の CenterLine 生成方法に合わせる）。
function makeCL(props) {
  return new CenterLine('cl-1', CenterLineType.HORIZONTAL, 0, props);
}

test('centerLineOriginColorKey: 通り芯(discipline:struct)は grid', () => {
  const cl = makeCL({ discipline: Discipline.STRUCT });
  assert.equal(centerLineOriginColorKey(cl), 'grid');
});

test('centerLineOriginColorKey: 中心線(既定discipline:arch, lineType:center)は center', () => {
  const cl = makeCL({});
  assert.equal(centerLineOriginColorKey(cl), 'center');
});

test('centerLineOriginColorKey: 補助線(lineType:dashed)は aux', () => {
  const cl = makeCL({ lineType: 'dashed' });
  assert.equal(centerLineOriginColorKey(cl), 'aux');
});

// ステップ2（2026-09-26）: 梁芯(discipline:fuse)の由来色は一律 'generated' ではなく
// beamAxisOrigin で分岐する。既存データ・未設定（null）は 'none'（黒）。
test('centerLineOriginColorKey: 梁芯(discipline:fuse)でbeamAxisOrigin未設定(null)は none', () => {
  const cl = makeCL({ discipline: Discipline.FUSE });
  assert.equal(centerLineOriginColorKey(cl), 'none');
});

test('centerLineOriginColorKey: 梁芯でbeamAxisOrigin:wall/floorBeamはどちらも generated', () => {
  assert.equal(centerLineOriginColorKey(makeCL({ discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.WALL })), 'generated');
  assert.equal(centerLineOriginColorKey(makeCL({ discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.FLOOR_BEAM })), 'generated');
});

test('centerLineOriginColorKey: 梁芯でbeamAxisOrigin:centerは center（S造向け・未実装の色キー予約）', () => {
  const cl = makeCL({ discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.CENTER });
  assert.equal(centerLineOriginColorKey(cl), 'center');
});

test('centerLineOriginColorKey: 梁芯でbeamAxisOrigin:userは aux', () => {
  const cl = makeCL({ discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER });
  assert.equal(centerLineOriginColorKey(cl), 'aux');
});

// 2026-09-26 裁定: 旧データ {labeled:false, discipline:STRUCT}（本来labeled:trueのはずの通り芯が
// labeled:falseのまま残る旧データ）も centerLineKind どおり 'struct'→'grid'（赤）とする——種別ベース
// 統一の既存方針（core/centerLineKindPolicy.js 冒頭コメント）に揃え、旧見た目のグレーには戻さない。
test('centerLineOriginColorKey: 旧データ{labeled:false, discipline:STRUCT}もcenterLineKindどおりgrid（2026-09-26裁定: 種別ベースに揃える）', () => {
  const cl = makeCL({ discipline: Discipline.STRUCT, labeled: false });
  assert.equal(centerLineOriginColorKey(cl), 'grid');
});

test('centerLineOriginColorKey: lineType:dashedはdiscipline（STRUCT/FUSE）より先に aux と判定される', () => {
  const structDashed = makeCL({ discipline: Discipline.STRUCT, lineType: 'dashed' });
  assert.equal(centerLineOriginColorKey(structDashed), 'aux');
  const fuseDashed = makeCL({ discipline: Discipline.FUSE, lineType: 'dashed' });
  assert.equal(centerLineOriginColorKey(fuseDashed), 'aux');
});

test('originColor: grid/center/aux/supportSpan/above は ORIGIN_LIGHTNESS の明度でhsl文字列を返す', () => {
  assert.equal(originColor('grid'), `hsl(0, 75%, ${ORIGIN_LIGHTNESS}%)`);
  assert.equal(originColor('center'), `hsl(190, 90%, ${ORIGIN_LIGHTNESS}%)`);
  assert.equal(originColor('aux'), `hsl(0, 0%, ${ORIGIN_LIGHTNESS}%)`);
  assert.equal(originColor('above'), `hsl(28, 95%, ${ORIGIN_LIGHTNESS}%)`);
  assert.equal(originColor('supportSpan'), `hsl(120, 70%, ${ORIGIN_LIGHTNESS}%)`);
});

test('originColor: generated は ORIGIN_LIGHTNESS + ORIGIN_LIGHT_LIFT の明度（やや明るい）', () => {
  assert.equal(originColor('generated'), `hsl(217, 91%, ${ORIGIN_LIGHTNESS + ORIGIN_LIGHT_LIFT}%)`);
});

test('originColor: lightness引数を明示すると既定のORIGIN_LIGHTNESSではなくその値を使う', () => {
  assert.equal(originColor('grid', 50), 'hsl(0, 75%, 50%)');
});

test('originColor: \'none\'・未知キー・null はいずれも黒(ORIGIN_NONE_COLOR)', () => {
  assert.equal(originColor('none'), ORIGIN_NONE_COLOR);
  assert.equal(originColor('unknown-key'), ORIGIN_NONE_COLOR);
  assert.equal(originColor(null), ORIGIN_NONE_COLOR);
});

// ---- columnOriginColorKey / columnOriginMarkKey（柱の由来別色分け ステップ3）----
// 入力は PlanGraph で作った実オブジェクト（structural/woodAutoFill.test.js の柱の作り方に合わせる）。
function makeColumnGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  return graph;
}
const STRUCT_PROPS = { labeled: true, discipline: Discipline.STRUCT };
const CENTER_PROPS = { labeled: false, discipline: Discipline.ARCH };
const WOOD_DRAWING = rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing;

test('columnOriginColorKey: 手動固定（dimensionStatus!=="auto"）は none（黒）', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h,
    { dimensionStatus: 'locked', woodColumnOrigins: 'wall' });
  assert.equal(columnOriginColorKey(column), 'none', '両アンカーが通り芯でも手動固定が最優先でnone');
});

test('columnOriginColorKey: 建具の袖柱（woodJambRef非null）は aux（濃いグレー）', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, CENTER_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, CENTER_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h,
    { woodJambRef: { openingId: 'o1', side: -1, isVertical: true } });
  assert.equal(columnOriginColorKey(column), 'aux');
});

test('columnOriginColorKey: 両アンカーが通り芯（struct）でwoodAxisOffsetがnullなら grid（濃い赤）', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h, {});
  assert.equal(columnOriginColorKey(column), 'grid');
});

test('columnOriginColorKey: オフセット柱（woodAxisOffset非null）は仮置きアンカーが通り芯でもgridにならない', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h,
    { woodAxisOffset: { isVertical: true, offset: 910 }, woodColumnOrigins: 'supportSpan' });
  assert.equal(columnOriginColorKey(column), 'supportSpan', 'gridではなく由来集合（supportSpan）で判定される');
});

test('columnOriginColorKey: above と wall が同居すれば above が勝つ', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, CENTER_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, CENTER_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h, { woodColumnOrigins: 'above,wall' });
  assert.equal(columnOriginColorKey(column), 'above');
});

test('columnOriginColorKey: above と supportSpan が同居すれば above が勝つ', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, CENTER_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, CENTER_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h, { woodColumnOrigins: 'above,supportSpan' });
  assert.equal(columnOriginColorKey(column), 'above');
});

test('columnOriginColorKey: supportSpan と wall が同居すれば supportSpan が勝つ', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, CENTER_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, CENTER_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h, { woodColumnOrigins: 'supportSpan,wall' });
  assert.equal(columnOriginColorKey(column), 'supportSpan');
});

test('columnOriginColorKey: wallのみ（アンカーに梁芯を含む）は center（濃い水色）', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, CENTER_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, CENTER_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h, { woodColumnOrigins: 'wall' });
  assert.equal(columnOriginColorKey(column), 'center');
});

test('columnOriginColorKey: freeEndのみ（アンカーに中心線を含む）は center（濃い水色）', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, CENTER_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, CENTER_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h, { woodColumnOrigins: 'freeEnd' });
  assert.equal(columnOriginColorKey(column), 'center');
});

test('columnOriginColorKey: 由来集合が空（既存データ・由来不明）は none（黒）', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, CENTER_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, CENTER_PROPS);
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h, {});
  assert.equal(columnOriginColorKey(column), 'none');
});

function makeWoodColumnWithOrigins(graph, origins) {
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, CENTER_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, CENTER_PROPS);
  return graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h, { woodColumnOrigins: origins });
}

test('columnOriginMarkKey: LOD・drawing・enabledのいずれかが欠けるとnull（それ以外は由来色キーを返す）', () => {
  const graph = makeColumnGraph();
  const column = makeWoodColumnWithOrigins(graph, 'wall');
  assert.equal(columnOriginMarkKey(column, WOOD_DRAWING, 'detail', true), 'center', '全て揃えば由来色キーを返す');
  assert.equal(columnOriginMarkKey(column, WOOD_DRAWING, 'standard', true), null, 'LODが詳細でなければnull');
  assert.equal(columnOriginMarkKey(column, WOOD_DRAWING, 'detail', false), null, 'enabledが偽（平面モードでない）ならnull');
  assert.equal(columnOriginMarkKey(column, { planColumnOriginMark: 'none' }, 'detail', true), null,
    'drawing.planColumnOriginMarkが"cross"でなければnull（非在来）');
});

test('【失敗系】columnOriginMarkKey: RC柱・杭はnull（在来木造の柱だけが対象）', () => {
  const graph = makeColumnGraph();
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, CENTER_PROPS);
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, CENTER_PROPS);
  const rcColumn = graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', v, h, {});
  assert.equal(columnOriginMarkKey(rcColumn, WOOD_DRAWING, 'detail', true), null, 'RC柱は対象外');
  const pile = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', v, h, { role: 'foundation' });
  assert.equal(columnOriginMarkKey(pile, WOOD_DRAWING, 'detail', true), null, '杭は対象外');
});
