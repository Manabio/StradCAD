// CENTER寸法（中心線寸法）の「足」(引出線) 上での端点ラジアル拡張（findCenterDimensionLegEndpoint /
// centerDimensionLegHits）の単体テスト。描画（GutterLayer.jsx CenterDimensions）と同じジオメトリ
// （centerBoundary + nonLabeledClExtent到達判定、centerLineCoordのクランプ式）を使うことを前提に、
// 実PlanGraphでその実ジオメトリ上の点をヒットテストする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, CenterLineType, DimensionKind, DimensionSide, HDimensionLine, VDimensionLine,
} from '../core.js';
import { findCenterDimensionLegEndpoint, centerDimensionLegHits, isClInDrawingBand, gutterClipRects } from './gutterLabelHits.js';
import { INSET } from '../layout.js';

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

// ---- isClInDrawingBand ----
test('isClInDrawingBand: 横CLは INSET.top ちょうど=true／1px上=false、下ガーター側も同様', () => {
  const vp = makeViewport(); // offset=0・scale=1 → sy=value
  const h = v => ({ centerLineType: CenterLineType.HORIZONTAL, effectiveValue: v });
  assert.equal(isClInDrawingBand(h(INSET.top), vp, WIDTH, HEIGHT), true);
  assert.equal(isClInDrawingBand(h(INSET.top - 1), vp, WIDTH, HEIGHT), false);
  assert.equal(isClInDrawingBand(h(HEIGHT - INSET.bottom), vp, WIDTH, HEIGHT), true);
  assert.equal(isClInDrawingBand(h(HEIGHT - INSET.bottom + 1), vp, WIDTH, HEIGHT), false);
});

test('isClInDrawingBand: 縦CLの左右ガーター', () => {
  const vp = makeViewport();
  const v = x => ({ centerLineType: CenterLineType.VERTICAL, effectiveValue: x });
  assert.equal(isClInDrawingBand(v(INSET.left), vp, WIDTH, HEIGHT), true);
  assert.equal(isClInDrawingBand(v(INSET.left - 1), vp, WIDTH, HEIGHT), false);
  assert.equal(isClInDrawingBand(v(WIDTH - INSET.right), vp, WIDTH, HEIGHT), true);
  assert.equal(isClInDrawingBand(v(WIDTH - INSET.right + 1), vp, WIDTH, HEIGHT), false);
});

test('isClInDrawingBand: offset/scale を反映し、種別不明は false', () => {
  const vp = { scaleX: 2, scaleY: 2, offsetX: 100, offsetY: 100 };
  // sy = 2*v + 100。v=0 → 100（INSET.top 以上なら true は INSET に依存するため境界で確認）
  const v = (INSET.top - 100) / 2;
  assert.equal(isClInDrawingBand({ centerLineType: CenterLineType.HORIZONTAL, effectiveValue: v }, vp, WIDTH, HEIGHT), true);
  assert.equal(isClInDrawingBand({ centerLineType: CenterLineType.HORIZONTAL, effectiveValue: v - 1 }, vp, WIDTH, HEIGHT), false);
  assert.equal(isClInDrawingBand({ centerLineType: 'unknown', effectiveValue: 500 }, vp, WIDTH, HEIGHT), false);
});

test('gutterClipRects: offset=0・scale=1 で area が INSET 内端と一致、gridX/gridY は片軸のみ画面全域', () => {
  const r = gutterClipRects(VIEWPORT, WIDTH, HEIGHT);
  const aw = WIDTH - INSET.left - INSET.right, ah = HEIGHT - INSET.top - INSET.bottom;
  assert.deepEqual(r.area, { x: INSET.left, y: INSET.top, width: aw, height: ah });
  assert.deepEqual(r.gridX, { x: INSET.left, y: 0, width: aw, height: HEIGHT });
  assert.deepEqual(r.gridY, { x: 0, y: INSET.top, width: WIDTH, height: ah });
});

test('gutterClipRects: offset/scale を反映し、width/height は常に正', () => {
  const vp = {
    scaleX: 2, scaleY: 2, offsetX: 100, offsetY: 100,
    screenToWorld(sx, sy) { return { x: (sx - 100) / 2, y: (sy - 100) / 2 }; },
  };
  const r = gutterClipRects(vp, WIDTH, HEIGHT);
  assert.equal(r.area.x, (INSET.left - 100) / 2);
  assert.equal(r.area.y, (INSET.top - 100) / 2);
  assert.equal(r.area.width, (WIDTH - INSET.left - INSET.right) / 2);
  assert.equal(r.gridX.y, -50);
  assert.equal(r.gridX.height, HEIGHT / 2);
  assert.equal(r.gridY.x, -50);
  assert.equal(r.gridY.width, WIDTH / 2);
  for (const k of ['area', 'gridX', 'gridY']) assert.ok(r[k].width > 0 && r[k].height > 0);
  // y 反転（scale 負）でも正になる
  const flip = { screenToWorld: (sx, sy) => ({ x: -sx, y: -sy }) };
  const f = gutterClipRects(flip, WIDTH, HEIGHT);
  for (const k of ['area', 'gridX', 'gridY']) assert.ok(f[k].width > 0 && f[k].height > 0);
});
