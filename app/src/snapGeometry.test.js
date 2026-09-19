// 中心線の外寸法側はね出し線分上での端点ラジアル拡張（findNearestCenterLineEndpoint）の単体テスト。
// 「外寸法側」の到達判定（clSideReachesCenterBoundary）は renderer/gutterLabelHits.js の
// buildCenterRowAnchors が使う centerBoundary + nonLabeledClExtent 基準の再利用であることも
// 併せて検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, CenterLineType, Discipline, DimensionKind, DimensionSide, HDimensionLine, VDimensionLine,
  centerLineKind,
} from './core.js';
import {
  findNearestCenterLine, findNearestCenterLineEndpoint, findBracketingCLs, nonLabeledClExtent,
  clSideReachesCenterBoundary, findCLMoveSnap, findBeamAxisMoveSnap,
} from './snapGeometry.js';
import { CL_KINDS, APP_MODES, hitTestKinds, spansEntireAxis } from './core/centerLineKindPolicy.js';

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

// ---- 通り芯の除外は種別ベース（centerLineKindPolicy.spansEntireAxis）2026-09-20移行 ----

test('findNearestCenterLineEndpoint: 通り芯（struct）は labeled の値に関わらず種別ベースで除外される（種別ベース移行の確認）', () => {
  const graph = makeGraph();
  addCenterDimensionRows(graph);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true });
  // 通常は起き得ない構成（通り芯にextentLo/Hiは設定されない）だが、除外が cl.labeled ではなく
  // 種別（centerLineKind==='struct'）で行われていることを確認するため、labeled:falseでも
  // discipline:STRUCTならcenterLineKindは'struct'になる点を利用する（移行前のcl.labeled判定なら
  // labeled:falseなのでヒットしてしまっていたはず）。
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1500, {
    labeled: false, discipline: Discipline.STRUCT, extentLo: 0, extentHi: 3000,
  });
  assert.equal(centerLineKind(cl), 'struct', '前提: labeled:falseでもdiscipline:STRUCTならkindはstruct');
  const hit = findNearestCenterLineEndpoint(graph, 1500, 3150, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.equal(hit, null, '種別が通り芯なら labeled の値に関わらず端点ヒット対象外');
});

test('【旧データ限定・種別ベースへ統一】findNearestCenterLineEndpoint: labeled:trueでも種別が通り芯でないCL（{labeled:true, discipline:ARCH}）は端点ヒット対象になる', () => {
  const graph = makeGraph();
  addCenterDimensionRows(graph);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true });
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1500, {
    labeled: true, discipline: Discipline.ARCH, extentLo: 0, extentHi: 3000,
  });
  assert.equal(centerLineKind(legacy), 'center', '前提: discipline=ARCHなのでcenter種別（labeled:trueだが種別は通り芯でない旧データ）');
  // 移行前はcl.labeledで除外されヒットしなかったが、移行後は種別ベースのため通常のcenterと同様にヒットする。
  const hit = findNearestCenterLineEndpoint(graph, 1500, 3150, THRESHOLD_PX, SCALE, SCALE, VIEWPORT);
  assert.ok(hit, '移行後は種別ベースのため、旧データでも通常のcenterと同様に端点ヒットする');
  assert.equal(hit.cl.id, legacy.id);
  assert.equal(hit.side, 'hi');
});

// ---- ヒット可能種別の4種別×6モード突き合わせ（core/centerLineKindPolicy.js hitTestKinds）----
// snap.js resolvePointerTargets の clKindFilter は hitTestKinds(appMode) から導出する
// （k => hitTestKinds(appMode).includes(k)）。resolvePointerTargets自体はstore.js依存のため
// node:testから呼べないが、findNearestCenterLine/findNearestCenterLineEndpointはこの形の
// kindFilterをそのまま渡せる純関数のため、ここで4種別×6モードの全組合せを突き合わせる
// （centerLineKindPolicy.test.jsのisRenderTarget/isHitTestTargetテストは述語そのものの一致を
// 見るが、こちらは実際にkindFilterを渡した製品関数の戻り値が一致することを見る）。
// 期待値はリテラル表で固定する（hitTestKinds(mode)を呼んで期待値を作る自己参照にしない——
// hitTestKindsの元になるVISIBLE_KINDS_BY_MODE/HIT_EXCLUDED_KINDS_BY_MODEを壊す変異があっても、
// 期待値側が一緒に動いてしまうと変異が赤にならない。QA指摘Minor5）。
// この表は centerLineKindPolicy.test.js の『hitTestKinds: floorplan/finish/opening=...』テストが
// 別途固定している値と同じ（book-keeping: 両テストが独立に同じ値をリテラルで持つ）。
const HIT_TEST_KINDS_LITERAL = {
  floorplan: ['struct', 'center', 'aux'],
  finish:    ['struct', 'center', 'aux'],
  opening:   ['struct', 'center', 'aux'],
  structure: ['beam'],
  site:      [],
  elevation: [],
};

// リテラル表が実装（hitTestKinds）から乖離していないことの一回きりの確認（このテストだけは
// hitTestKindsを呼ぶ——下の2本は変異検出のためリテラル表を直接使う。両者の目的は別）。
test('HIT_TEST_KINDS_LITERAL: 実装（hitTestKinds）の値と一致する（このテストファイル内リテラル表のドリフト検知）', () => {
  for (const mode of APP_MODES) assert.deepEqual(HIT_TEST_KINDS_LITERAL[mode], hitTestKinds(mode), `mode=${mode}`);
});

test('findNearestCenterLine: 4種別×6モードの拾われる/拾われないがリテラル表（HIT_TEST_KINDS_LITERAL）と一致する', () => {
  const clProps = {
    struct: { labeled: true,  discipline: Discipline.STRUCT },
    center: { labeled: false, discipline: Discipline.ARCH },
    aux:    { labeled: false, lineType: 'dashed' },
    beam:   { labeled: false, discipline: Discipline.FUSE },
  };
  for (const kind of CL_KINDS) {
    const graph = makeGraph();
    const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, clProps[kind]);
    for (const mode of APP_MODES) {
      // kindFilterは実装（hitTestKinds）から作る——snap.js resolvePointerTargetsが実際に渡す形と
      // 同じにすることで、VISIBLE_KINDS_BY_MODE/HIT_EXCLUDED_KINDS_BY_MODEを壊す変異が
      // 製品関数の戻り値（hit）に反映される。期待値だけをリテラル表と突き合わせる（Minor5）。
      const kindFilter = k => hitTestKinds(mode).includes(k);
      const hit = findNearestCenterLine(graph, 1000, 0, THRESHOLD_PX, SCALE, SCALE, null, kindFilter);
      const expected = HIT_TEST_KINDS_LITERAL[mode].includes(kind);
      assert.equal(!!hit, expected, `kind=${kind} mode=${mode}`);
      if (expected) assert.equal(hit.id, cl.id, `kind=${kind} mode=${mode}`);
    }
  }
});

test('findNearestCenterLineEndpoint: 4種別×6モードの拾われる/拾われないがリテラル表（HIT_TEST_KINDS_LITERAL）∧非struct と一致する（通り芯はリテラル表に含まれてもspansEntireAxisで別途除外される）', () => {
  const clProps = {
    struct: { labeled: true,  discipline: Discipline.STRUCT, extentLo: 0, extentHi: 3000 },
    center: { labeled: false, discipline: Discipline.ARCH,   extentLo: 0, extentHi: 3000 },
    aux:    { labeled: false, lineType: 'dashed',             extentLo: 0, extentHi: 3000 },
    beam:   { labeled: false, discipline: Discipline.FUSE,    extentLo: 0, extentHi: 3000 },
  };
  for (const kind of CL_KINDS) {
    const graph = makeGraph();
    addCenterDimensionRows(graph);
    graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true });
    graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true });
    const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1500, clProps[kind]);
    for (const mode of APP_MODES) {
      // kindFilterは実装（hitTestKinds）から作る（上のfindNearestCenterLineテストと同じ理由）。
      const kindFilter = k => hitTestKinds(mode).includes(k);
      // 突端8px円（extentHi+overhang=3300ちょうど）でヒット判定する。
      const hit = findNearestCenterLineEndpoint(graph, 1500, 3300, THRESHOLD_PX, SCALE, SCALE, VIEWPORT, kindFilter);
      // 通り芯除外（spansEntireAxis）はリテラル表とは別軸の判定（種別そのものの性質）なので、
      // ここだけは実装（spansEntireAxis）を呼ぶ——`kind === 'struct'` と書いても等価だが、
      // 「通り芯は常に全軸に及ぶため端点を持たない」という実装の意図をそのまま参照するため
      // spansEntireAxis を使う（このテストの主眼はモード別可視集合のリテラル固定であり、
      // spansEntireAxis自体の正しさは centerLineKindPolicy.test.js 側で別途検証済み）。
      const expected = HIT_TEST_KINDS_LITERAL[mode].includes(kind) && !spansEntireAxis(kind);
      assert.equal(!!hit, expected, `kind=${kind} mode=${mode}`);
      if (expected) {
        assert.equal(hit.cl.id, cl.id, `kind=${kind} mode=${mode}`);
        assert.equal(hit.side, 'hi');
      }
    }
  }
});

// ---- 既存関数（findBracketingCLs）の再エクスポートが壊れていないことの最小回帰 ----
test('findBracketingCLs: 座標を挟むCLペアを返す（回帰）', () => {
  const cls = [{ value: 0 }, { value: 1000 }, { value: 2000 }];
  const [lo, hi] = findBracketingCLs(cls, 1500);
  assert.equal(lo.value, 1000);
  assert.equal(hi.value, 2000);
});

// ================================================================
// findCLMoveSnap / findBeamAxisMoveSnap
// snap.js から centerLineKindPolicy 経由へ移行（ステップ4、2026-09-19）。
// spatialIndex/store に依存しない純関数のため snapGeometry.js へ分離済み。
// ================================================================

test('findCLMoveSnap: moving=struct/center/aux いずれでも梁芯へは吸着せず、通り芯・中心線・補助線へは吸着する', () => {
  const movingProps = {
    struct: { labeled: true,  discipline: Discipline.STRUCT },
    center: { labeled: false, discipline: Discipline.ARCH },
    aux:    { labeled: false, lineType: 'dashed' },
  };
  for (const movingKind of ['struct', 'center', 'aux']) {
    const graph = makeGraph();
    const moving = graph.addCenterLine(CenterLineType.VERTICAL, 0, movingProps[movingKind]);
    graph.addCenterLine(CenterLineType.VERTICAL, 3, { labeled: false, discipline: Discipline.FUSE }); // 梁芯（最も近いが吸着対象外）
    const struct = graph.addCenterLine(CenterLineType.VERTICAL, 6, { labeled: true, discipline: Discipline.STRUCT });

    const snap = findCLMoveSnap(graph, moving, 0, 0, THRESHOLD_PX, SCALE, SCALE);
    assert.equal(snap, struct.value, `moving=${movingKind}: 梁芯(3)ではなく通り芯(6)へ吸着するはず`);
  }
});

test('【失敗系】findCLMoveSnap: 候補が梁芯のみ（吸着対象外種別のみ）で閾値内の場合はnullを返す', () => {
  const graph = makeGraph();
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 3, { labeled: false, discipline: Discipline.FUSE }); // 梁芯のみ閾値内
  const snap = findCLMoveSnap(graph, moving, 0, 0, THRESHOLD_PX, SCALE, SCALE);
  assert.equal(snap, null);
});

test('findBeamAxisMoveSnap: 障害物は通り芯・他の梁芯のみ（中心線・補助線は中点計算に影響しない）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  // 中心線・補助線が誤って障害物に混入すると lo/hi がここへ引き寄せられ、中点が変わってしまう。
  graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 8000, { labeled: false, lineType: 'dashed' });
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.FUSE });

  // 正しい障害物（struct 0・10000）による中点は5000。中心線・補助線混入なら中点は5500になるはず。
  const snap = findBeamAxisMoveSnap(graph, moving, 5000, 0, 50, SCALE, SCALE);
  assert.equal(snap, 5000, '中心線(3000)・補助線(8000)は障害物にならず、通り芯0・10000の中点(5000)へ吸着するはず');
});

test('【失敗系】findBeamAxisMoveSnap: 片側に障害物（通り芯・梁芯）が無ければnullを返す', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: false, discipline: Discipline.FUSE });
  // hi側に通り芯・梁芯が無い
  const snap = findBeamAxisMoveSnap(graph, moving, 6000, 0, 50, SCALE, SCALE);
  assert.equal(snap, null);
});
