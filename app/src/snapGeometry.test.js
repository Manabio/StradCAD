// 中心線の外寸法側はね出し線分上での端点ラジアル拡張（findNearestCenterLineEndpoint）の単体テスト。
// 「外寸法側」の到達判定（clSideReachesCenterBoundary）は renderer/gutterLabelHits.js の
// buildCenterRowAnchors が使う centerBoundary + nonLabeledClExtent 基準の再利用であることも
// 併せて検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, CenterLineType, DimensionKind, DimensionSide, HDimensionLine, VDimensionLine,
} from './core.js';
import {
  findNearestCenterLineEndpoint, findBracketingCLs, nonLabeledClExtent, clSideReachesCenterBoundary,
} from './snapGeometry.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// CENTER寸法4行（TOP/BOTTOM/LEFT/RIGHT）を追加する。store.js の初期化と同じ構成
// （centerBoundary が graph.gridXs/gridYs を参照するため、この4行が無いと常に到達なし扱いになる）。
function addCenterDimensionRows(graph) {
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT });
}

// denom=100 → overhangMm() は 300mm（snapGeometry.js の区分線形、BASE_DENOM=100, BASE_MM=300）
const VIEWPORT = { scaleDenominator: 100 };
const THRESHOLD_PX = 8; // snap.js CL_THRESHOLD_PX と同値
const SCALE = 1; // 1px = 1mm相当（テストを読みやすくするため）

// 垂直の非ラベルCL(x=1500)を、Y方向グリッド [gridYLo, gridYHi] の下で extentLo=0/extentHi=3000 として追加する。
// gridYHi を 3000 と一致させれば hi 側も到達、gridYHi を大きくすれば hi 側は非到達になる。
function setupVerticalCL(gridYHi) {
  const graph = makeGraph();
  addCenterDimensionRows(graph);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,        { labeled: true });
  graph.addCenterLine(CenterLineType.HORIZONTAL, gridYHi,  { labeled: true });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1500, {
    labeled: false, extentLo: 0, extentHi: 3000,
  });
  return { graph, cl };
}

// 垂直の非ラベルCLを、Y方向グリッド [0, gridYHi]・任意のextentLo/Hiで追加する（clSideReachesCenterBoundary検証用）。
function setupVerticalCLGeneric(gridYHi, extentLo, extentHi, props = {}) {
  const graph = makeGraph();
  addCenterDimensionRows(graph);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,       { labeled: true });
  graph.addCenterLine(CenterLineType.HORIZONTAL, gridYHi, { labeled: true });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, extentLo, extentHi, ...props });
  return { graph, cl };
}

// 水平の非ラベルCL(y=1500)を、X方向グリッド [0, gridXHi] の下で extentLo=0/extentHi=3000 として追加する
// （向き取り違え回帰用: findNearestCenterLineEndpoint のisV/isH分岐を垂直CLだけでなく水平CLでも確認する）。
function setupHorizontalCL(gridXHi) {
  const graph = makeGraph();
  addCenterDimensionRows(graph);
  graph.addCenterLine(CenterLineType.VERTICAL, 0,       { labeled: true });
  graph.addCenterLine(CenterLineType.VERTICAL, gridXHi, { labeled: true });
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, {
    labeled: false, extentLo: 0, extentHi: 3000,
  });
  return { graph, cl };
}

test('findNearestCenterLineEndpoint: 外寸法側（到達している側）のはね出し線分上は端点ヒット{cl,side}を返す', () => {
  // gridYHi=3000 → extentHi(3000) がそのままBOTTOM境界(3000)に到達している
  const { graph, cl } = setupVerticalCL(3000);
  // hi側はね出し線分: along∈[3000, 3300]。along=3150（突端3300からは150px離れており、突端8px円には掛からない）
  const hit = findNearestCenterLineEndpoint(graph, 1500, 3150, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.ok(hit, 'はね出し線分上でも端点ヒットが返るはず');
  assert.equal(hit.cl.id, cl.id);
  assert.equal(hit.side, 'hi');
});

test('findNearestCenterLineEndpoint: 到達していない端のはね出し線分上は端点ヒットを返さない（突端8px円のみ維持）', () => {
  // gridYHi=5000 → extentHi(3000) はBOTTOM境界(5000)に届いていない（lo側=TOP(0)は到達）
  const { graph } = setupVerticalCL(5000);

  // 非到達側(hi)のはね出し線分上・突端から離れた点 → ヒットなし
  const missOnSegment = findNearestCenterLineEndpoint(graph, 1500, 3150, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.equal(missOnSegment, null, '到達していない側は線分上ではヒットしないはず');

  // 同じ非到達側でも、従来どおり突端8px円は維持される（extentHi+overhang=3300ちょうど）
  const tip = findNearestCenterLineEndpoint(graph, 1500, 3300, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.ok(tip, '突端8px円は到達可否に関わらず維持されるはず');
  assert.equal(tip.side, 'hi');
});

test('findNearestCenterLineEndpoint: extent内側の線上は従来どおり端点ヒットを返さない', () => {
  const { graph } = setupVerticalCL(3000);
  // extentLo(0)〜extentHi(3000)の内側
  const hit = findNearestCenterLineEndpoint(graph, 1500, 1500, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.equal(hit, null, 'extent内側は端点ヒット対象外のまま（線上ヒットに委ねる）');
});

test('findNearestCenterLineEndpoint: 到達している側でも垂直距離が閾値を超えれば端点ヒットしない', () => {
  const { graph } = setupVerticalCL(3000);
  // hi側はね出し線分上のalongだが、CLから20px（閾値8pxを超える）離れている
  const hit = findNearestCenterLineEndpoint(graph, 1520, 3150, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.equal(hit, null);
});

test('clSideReachesCenterBoundary: renderer/gutterLabelHits.js の buildCenterRowAnchors が使う centerBoundary + nonLabeledClExtent 基準であること', () => {
  // グリッド・extentの組合せ4通り × side(lo/hi) を、テスト内で直接組んだ
  // 「nonLabeledClExtent の ext と、graph.dimensionLines から引いた centerBoundary」による
  // ext[0] <= boundary <= ext[1] 判定と突き合わせる（clSideReachesCenterBoundary内部実装の再掲ではなく、
  // renderer/gutterLabelHits.js buildCenterRowAnchors が使う同じ2要素からテスト側で独立に再構成した
  // 期待値）。
  const cases = [
    { gridYHi: 3000, extentLo: 0,   extentHi: 3000 }, // 両側とも到達（extentがグリッドとちょうど一致）
    { gridYHi: 5000, extentLo: 0,   extentHi: 3000 }, // lo到達・hi非到達
    { gridYHi: 3000, extentLo: 500, extentHi: 2500 }, // extentがグリッド内側で止まる → 両側非到達
    { gridYHi: 5000, extentLo: 500, extentHi: 2500 }, // 同上（グリッドを広げても変わらない）
  ];
  for (const { gridYHi, extentLo, extentHi } of cases) {
    const { graph, cl } = setupVerticalCLGeneric(gridYHi, extentLo, extentHi);
    for (const side of ['lo', 'hi']) {
      const dimSide = side === 'lo' ? DimensionSide.TOP : DimensionSide.BOTTOM;
      const row      = graph.dimensionLines.find(d => d.dimensionKind === DimensionKind.CENTER && d.side === dimSide);
      const boundary = row.centerBoundary;
      const ext       = nonLabeledClExtent(cl, graph, VIEWPORT);
      const expected  = ext[0] <= boundary && boundary <= ext[1];

      const got = clSideReachesCenterBoundary(cl, side, graph, VIEWPORT);
      assert.equal(
        got, expected,
        `gridYHi=${gridYHi} extent=[${extentLo},${extentHi}] side=${side}: boundary=${boundary}, ext=[${ext}]`,
      );
    }
  }
});

test('findNearestCenterLineEndpoint: 水平CLでもLEFT/RIGHTの向きを正しく判定する（垂直CLのTOP/BOTTOMと取り違えない）', () => {
  // gridX=[0,5000], extent=[0,3000] → lo側(LEFT境界0)は到達、hi側(RIGHT境界5000)は非到達
  const { graph } = setupHorizontalCL(5000);

  const hitLo = findNearestCenterLineEndpoint(graph, -150, 1500, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.ok(hitLo, 'lo側(LEFT)は到達しているのでヒットするはず');
  assert.equal(hitLo.side, 'lo');

  const missHi = findNearestCenterLineEndpoint(graph, 3150, 1500, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.equal(missHi, null, 'hi側(RIGHT)は到達していないので線分上はヒットしないはず');
});

test('findNearestCenterLineEndpoint: trim指定CL（overhang=0）は到達側でも線分ヒットが増えない', () => {
  const { graph } = setupVerticalCLGeneric(3000, 0, 3000, { trim: true });
  // trim=trueはoverhangMmが常に0を返すため、はね出し線分自体が存在しない
  assert.equal(findNearestCenterLineEndpoint(graph, 1500, 3150, THRESHOLD_PX, SCALE, SCALE, VIEWPORT), null);
  assert.equal(findNearestCenterLineEndpoint(graph, 1500, 1500, THRESHOLD_PX, SCALE, SCALE, VIEWPORT), null);
});

test('findNearestCenterLineEndpoint: 直交通り芯が0本ならCENTER寸法のboundaryが無く線分ヒットは常になし（突端8px円のみ維持）', () => {
  const graph = makeGraph();
  addCenterDimensionRows(graph); // CENTER寸法4行は追加するが、直交グリッド(HORIZONTAL labeled)は1本も無い
  graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, extentLo: 0, extentHi: 3000 });

  const missOnSegment = findNearestCenterLineEndpoint(graph, 1500, 3150, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.equal(missOnSegment, null, '到達判定の基準(centerBoundary)が無いので線分上はヒットしないはず');

  const tip = findNearestCenterLineEndpoint(graph, 1500, 3300, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.ok(tip, '突端8px円は到達可否に関わらず維持されるはず');
  assert.equal(tip.side, 'hi');
});

// ---- 既存関数（findBracketingCLs）の再エクスポートが壊れていないことの最小回帰 ----
test('findBracketingCLs: 座標を挟むCLペアを返す（回帰）', () => {
  const cls = [{ value: 0 }, { value: 1000 }, { value: 2000 }];
  const [lo, hi] = findBracketingCLs(cls, 1500);
  assert.equal(lo.value, 1000);
  assert.equal(hi.value, 2000);
});
