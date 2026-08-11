// ElevationModeState.init() の失敗系（QA F4）。mobx以外はDOM/IndexedDBに依存しないため
// node:testから直接importできる（storage/FloorSwapManager.js のIndexedDB呼び出しはopenDB()内部の
// 遅延実行のため、project=null経由でpeekへ到達しない本テストでは発火しない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { ElevationModeState } from './ElevationModeState.js';
import { screenMmToModelMm } from '../elevation/elevationLayout.js';
import { NAME_GAP_BELOW_SCREEN_MM } from '../elevation/elevationStyle.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

test('ElevationModeState.init: project=null（直上階なし）でも帯を構築しloading=falseになる', async () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const state = new ElevationModeState(graph, null, { width: 1000, height: 800 });

  const result = await state.init();
  assert.equal(result.ok, true);
  assert.equal(state.loading, false);
  assert.equal(state.materialError, null);
  assert.equal(state.bands.length, 1);
});

// ---- 失敗系（QA F4）: 1部屋の帯構築が例外を投げても、モードはloading=falseで生成され
// materialErrorが非nullになり、他の部屋の帯は残る ----
test('【失敗系・QA F4】ElevationModeState.init: 1部屋の帯構築が失敗してもモードは生成されloading=false・materialError非null', async () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const broken = makeRectRoom(graph, 0, 5000, 4000, 8000, '故障室');
  // getFinishInfo をインスタンス側で壊し、buildFaceFigure内の呼び出しで例外を発生させる
  // （Roomクラスのプロトタイプメソッドを上書き。1部屋だけの異常をシミュレート）。
  broken.getFinishInfo = () => { throw new Error('boom'); };

  const state = new ElevationModeState(graph, null, { width: 1000, height: 800 });
  const result = await state.init();

  assert.equal(result.ok, false);
  assert.equal(state.loading, false);
  assert.ok(state.materialError, 'materialErrorが設定されるはず');
  assert.ok(state.materialError.includes('故障室'), `失敗した部屋名を含むはず（実際:${state.materialError}）`);
  assert.equal(state.bands.length, 1, '正常な部屋(LDK)の帯だけは残るはず');
  assert.equal(state.bands[0].roomName, 'LDK');
});

// ---- QA G1: scrollBy は書き込み時にクランプする（読み出し側=clampedScrollYだけでは
// 過剰ドラッグ分がscrollYへ見えないスラックとして蓄積し、逆方向ドラッグがそのスラック分
// 効かないデッドゾーンになる）----
test('【失敗系・QA G1】ElevationModeState.scrollBy: 過剰ドラッグ後もscrollYは書き込み時に既にクランプ済みで、逆方向ドラッグが即座に効く', async () => {
  const graph = makeGraph();
  // 帯を4部屋分積んでcontentHeightMmがviewHeightMmを確実に超えるようにする
  // （帯1件だとchooseElevationScaleのVISIBLE_BANDS目安により常に画面内に収まってしまうため）。
  makeRectRoom(graph, 0, 0, 4000, 3000, 'R1');
  makeRectRoom(graph, 0, 5000, 4000, 8000, 'R2');
  makeRectRoom(graph, 0, 10000, 4000, 13000, 'R3');
  makeRectRoom(graph, 0, 15000, 4000, 18000, 'R4');
  const state = new ElevationModeState(graph, null, { width: 1000, height: 800 });
  await state.init();

  const viewHeightMm = 800 / state.scale;
  const maxScroll = Math.max(0, state.layout.contentHeightMm - viewHeightMm);
  assert.ok(maxScroll > 0, `テスト前提: 4帯の高さ合計はviewHeightMmを超えるはず（実際contentHeightMm=${state.layout.contentHeightMm}, viewHeightMm=${viewHeightMm}）`);

  // 下端を大きく超えて過剰ドラッグする（下方向へ50,000mm相当）。
  state.scrollBy(0, -50000);
  assert.equal(state.scrollY, maxScroll, 'scrollYは書き込み時に既にクランプされ、スラックが残らないはず');

  // 逆方向へ100mmだけドラッグすると、スラックが無いため即座にclampedScrollYが変化するはず。
  state.scrollBy(0, 100);
  assert.equal(state.clampedScrollY, maxScroll - 100,
    '過剰ドラッグ分のスラックが無ければ、逆方向ドラッグ100mmが即座に反映されるはず');
});

// ---- QA G5: 部屋名枠の上余白（実画面NAME_GAP_BELOW_SCREEN_MM）はscreenMmToModelMmで
// モデルmmへ換算され、換算結果はscaleに連動する（elevationBand/elevationStair両方に効くことは
// elevationBand.test.js/elevationStair.test.jsのctx.nameGapModelMm直接テストで確認済み。
// ここではElevationModeState.init()が実際にこの換算式を使って配線していることをE2Eで確認する）----
test('【QA G5】ElevationModeState.init: 部屋名枠の上余白はscreenPxPerMmに比例して変わる（screenMmToModelMm経由の配線確認）', async () => {
  const pxPerMmA = 3.78; // 96dpi相当
  const pxPerMmB = 7.56; // その2倍（校正値が変わった想定）

  const makeState = async (screenPxPerMm) => {
    const graph = makeGraph();
    makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
    const state = new ElevationModeState(graph, null, { width: 1000, height: 800 }, screenPxPerMm);
    await state.init();
    return state;
  };

  const stateA = await makeState(pxPerMmA);
  const stateB = await makeState(pxPerMmB);

  // 前提: scale自体はscreenPxPerMmに依存しない（帯の高さ・viewSizeだけで決まる）ため、
  // 同一のscaleでなければ以降の単純な比例計算が成立しない。
  assert.equal(stateA.scale, stateB.scale, '前提: 同一viewSize/帯高さならscaleは一致するはず');

  const gapA = screenMmToModelMm(NAME_GAP_BELOW_SCREEN_MM, pxPerMmA, stateA.scale);
  const gapB = screenMmToModelMm(NAME_GAP_BELOW_SCREEN_MM, pxPerMmB, stateB.scale);
  assert.ok(gapB > gapA, '前提: pxPerMmが大きいほど換算後のモデルmmも大きくなるはず');

  const maxYDelta = stateB.bands[0].bounds.maxY - stateA.bands[0].bounds.maxY;
  assert.ok(Math.abs(maxYDelta - (gapB - gapA)) < 1e-6,
    `帯のbounds.maxYの差はscreenMmToModelMmで換算したnameGapModelMmの差と一致するはず` +
    `（期待:${gapB - gapA}, 実際:${maxYDelta}）`);
});
