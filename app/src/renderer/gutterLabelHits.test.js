// CENTER寸法（中心線寸法）の「足」(引出線) 上での端点ラジアル拡張（findCenterDimensionLegEndpoint /
// centerDimensionLegHits）の単体テスト。描画（GutterLayer.jsx CenterDimensions）と同じジオメトリ
// （centerBoundary + nonLabeledClExtent到達判定、centerLineCoordのクランプ式）を使うことを前提に、
// 実PlanGraphでその実ジオメトリ上の点をヒットテストする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, CenterLineType, DimensionKind, DimensionSide, HDimensionLine, VDimensionLine,
} from '../core.js';
import { findCenterDimensionLegEndpoint, centerDimensionLegHits } from './gutterLabelHits.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function addCenterDimensionRows(graph) {
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT });
}

// screenToWorld のみ実装した最小viewportモック（snapGeometry.test.js の { scaleDenominator } モックを
// 拡張したもの——findCenterDimensionLegEndpoint は drawingAreaBounds/centerLineCoord 経由で
// screenToWorld も呼ぶため）。offsetX/Y=0・scaleX/Y=1 とし、スクリーンpx=ワールドmmで揃えて
// 手計算しやすくする。
function makeViewport({ scaleDenominator = 10 } = {}) {
  const scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0;
  return {
    scaleX, scaleY, offsetX, offsetY, scaleDenominator,
    screenToWorld(sx, sy) { return { x: (sx - offsetX) / scaleX, y: (sy - offsetY) / scaleY }; },
  };
}

const WIDTH  = 2000;
const HEIGHT = 2000;
const VIEWPORT = makeViewport(); // scaleDenominator=10 → offsetMm=500mm, overhang≈120mm, minGapMm=100mm
const THRESHOLD_PX = 8; // snap.js CL_THRESHOLD_PX と同値

// 通り芯（X1=700,X2=1300 / Y1=700,Y2=1300、正方形）+ 各行1本ずつ到達するCL4本
// （TOP/BOTTOM・LEFT/RIGHTを別々のCLにすることで、GutterLayer.jsx の suppressKeys
//   （TOP→BOTTOM, LEFT→RIGHTの重複区間抑制）が同一区間を誤って消さないことも併せて確認する）。
// clNone は追加時extentがどちらの境界（700/1300）にもオーバーハングを含めて届かない対照群。
function setupFourLegsGraph() {
  const graph = makeGraph();
  addCenterDimensionRows(graph);
  graph.addCenterLine(CenterLineType.VERTICAL,   700,  { labeled: true });
  graph.addCenterLine(CenterLineType.VERTICAL,   1300, { labeled: true });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 700,  { labeled: true });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1300, { labeled: true });

  const clTop    = graph.addCenterLine(CenterLineType.VERTICAL,   500, { labeled: false, extentLo: 700,  extentHi: 1000 });
  const clBottom = graph.addCenterLine(CenterLineType.VERTICAL,   900, { labeled: false, extentLo: 1000, extentHi: 1300 });
  const clLeft   = graph.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, extentLo: 700,  extentHi: 1000 });
  const clRight  = graph.addCenterLine(CenterLineType.HORIZONTAL, 900, { labeled: false, extentLo: 1000, extentHi: 1300 });
  const clNone   = graph.addCenterLine(CenterLineType.VERTICAL,   1100, { labeled: false, extentLo: 900, extentHi: 1100 });

  return { graph, clTop, clBottom, clLeft, clRight, clNone };
}

function hit(graph, wx, wy, columnAxisMode = false) {
  return findCenterDimensionLegEndpoint(graph, wx, wy, THRESHOLD_PX, 1, 1, VIEWPORT, WIDTH, HEIGHT, undefined, columnAxisMode);
}

test('centerDimensionLegHits: TOP/BOTTOM/LEFT/RIGHT各行が独立に到達CLの足を返す（suppressKeysの誤爆でBOTTOM/RIGHTが消えない）', () => {
  const { graph, clTop, clBottom, clLeft, clRight } = setupFourLegsGraph();
  const legs = centerDimensionLegHits(graph, VIEWPORT, WIDTH, HEIGHT, undefined);
  const bySide = id => legs.find(l => l.cl.id === id)?.side;
  assert.equal(bySide(clTop.id),    'lo');
  assert.equal(bySide(clBottom.id), 'hi');
  assert.equal(bySide(clLeft.id),   'lo');
  assert.equal(bySide(clRight.id),  'hi');
  assert.equal(legs.length, 4, '到達していないclNoneは含まれないはず');
});

test('findCenterDimensionLegEndpoint: TOP行の足線上→{cl,side:lo}', () => {
  const { graph, clTop } = setupFourLegsGraph();
  // TOP: boundary=700(X1=700がTOP境界の由来ではなくY1=700。以下のalong範囲は
  // [lineCoord=200, boundary=700] のY区間、perp=clTop.value(500)のX)
  const h = hit(graph, 500, 450);
  assert.ok(h, '足線上は端点ヒットが返るはず');
  assert.equal(h.cl.id, clTop.id);
  assert.equal(h.side, 'lo');
});

test('findCenterDimensionLegEndpoint: BOTTOM行の足線上→{cl,side:hi}', () => {
  const { graph, clBottom } = setupFourLegsGraph();
  const h = hit(graph, 900, 1500);
  assert.ok(h);
  assert.equal(h.cl.id, clBottom.id);
  assert.equal(h.side, 'hi');
});

test('findCenterDimensionLegEndpoint: LEFT行の足線上→{cl,side:lo}', () => {
  const { graph, clLeft } = setupFourLegsGraph();
  const h = hit(graph, 450, 500);
  assert.ok(h);
  assert.equal(h.cl.id, clLeft.id);
  assert.equal(h.side, 'lo');
});

test('findCenterDimensionLegEndpoint: RIGHT行の足線上→{cl,side:hi}', () => {
  const { graph, clRight } = setupFourLegsGraph();
  const h = hit(graph, 1500, 900);
  assert.ok(h);
  assert.equal(h.cl.id, clRight.id);
  assert.equal(h.side, 'hi');
});

test('findCenterDimensionLegEndpoint: 足線から垂直距離が閾値(8px)を超えればヒットしない', () => {
  const { graph } = setupFourLegsGraph();
  const h = hit(graph, 520, 450); // TOPの足(x=500)から20px（閾値8pxを超える）
  assert.equal(h, null);
});

test('findCenterDimensionLegEndpoint: 到達していない中心線（その行にアンカーされない）の位置→null', () => {
  const { graph } = setupFourLegsGraph();
  // clNone(x=1100)はTOP/BOTTOMどちらにも到達しないため、TOPの足線位置(y=200付近)に置いても足自体が無い
  const h = hit(graph, 1100, 200);
  assert.equal(h, null);
});

test('findCenterDimensionLegEndpoint: columnAxisMode中はCENTER行が柱芯表示に専有され足が存在しないため常にnull', () => {
  const { graph } = setupFourLegsGraph();
  const h = hit(graph, 500, 450, true); // 通常なら{cl:clTop, side:'lo'}が返る位置
  assert.equal(h, null);
});
