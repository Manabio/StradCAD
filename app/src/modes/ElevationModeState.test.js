// ElevationModeState.init() の失敗系（QA F4）。mobx以外はDOM/IndexedDBに依存しないため
// node:testから直接importできる（storage/FloorSwapManager.js のIndexedDB呼び出しはopenDB()内部の
// 遅延実行のため、project=null経由でpeekへ到達しない本テストでは発火しない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { ElevationModeState } from './ElevationModeState.js';
import { buildRoomBand } from '../elevation/elevationBand.js';
import { chooseElevationScale, screenMmToModelMm } from '../elevation/elevationLayout.js';
import {
  NAME_GAP_BELOW_SCREEN_MM, DEFAULT_OPENING_TAG_ROW_MM, OPENING_TAG_ROW_SCREEN_MM,
  DEFAULT_DIM_ROW_GAP_MM, DIM_ROW_GAP_SCREEN_MM, DEFAULT_GRID_ROW_GAP_MM, GRID_ROW_GAP_SCREEN_MM,
} from '../elevation/elevationStyle.js';

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
// ここではElevationModeState.init()が実際にこの換算式を使って配線していることをE2Eで確認する）。
// ElevationModeState.init()と同じ2パス（1パス目=既定値で帯を組み倍率確定、2パス目=その倍率で
// screenMmToModelMm換算）をテスト側でも独立に再現し、実際のstate.bands[0]と突き合わせる
// （state.scaleゲッターはpass2後の帯高さから再計算されるため、pass1で使った倍率とズレうる
// ——nameGapModelMmが大きく効いてNICE_SCALESの桁が変わるケースがあるため、cross-check時は
// pass1と同じ計算経路を使うこと）----
test('【QA G5】ElevationModeState.init: 部屋名枠の上余白は実際にscreenMmToModelMm(scale連動)で換算した値が使われる', async () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const screenPxPerMm = 5.5; // 96dpi相当や倍値と衝突しない値
  const room = graph.rooms.find(r => r.name === 'LDK');

  // ElevationModeState.init()のパス1相当（既定値で帯を組み倍率を決める）を独立に再現する。
  // QA C1→D1/D2: openingTagRowModelMm/dimRowGapModelMm/gridRowGapModelMmは全て独立したスクリーン
  // mm予算から2パス方式で換算されるため（機械的な倍数導出はQA D2で撤回済み）、パス1の仮値も
  // 対応するDEFAULT_*_MMに揃えないとbounds.maxYがズレる（ROW1以降の段=ROW2・通り芯丸行・
  // 部屋名枠は全てdimRowGapModelMm/gridRowGapModelMm起点で積み上がるため）。
  const pass1Band = buildRoomBand(room, graph, {
    openingTagRowModelMm: DEFAULT_OPENING_TAG_ROW_MM, dimRowGapModelMm: DEFAULT_DIM_ROW_GAP_MM,
    gridRowGapModelMm: DEFAULT_GRID_ROW_GAP_MM,
  });
  const pass1Scale = chooseElevationScale([pass1Band], { width: 1000, height: 800 });
  const expectedNameGapModelMm = screenMmToModelMm(NAME_GAP_BELOW_SCREEN_MM, screenPxPerMm, pass1Scale);
  const expectedOpeningTagRowModelMm = screenMmToModelMm(OPENING_TAG_ROW_SCREEN_MM, screenPxPerMm, pass1Scale);
  const expectedDimRowGapModelMm = screenMmToModelMm(DIM_ROW_GAP_SCREEN_MM, screenPxPerMm, pass1Scale);
  const expectedGridRowGapModelMm = screenMmToModelMm(GRID_ROW_GAP_SCREEN_MM, screenPxPerMm, pass1Scale);
  const reference = buildRoomBand(room, graph, {
    nameGapModelMm: expectedNameGapModelMm,
    openingTagRowModelMm: expectedOpeningTagRowModelMm, dimRowGapModelMm: expectedDimRowGapModelMm,
    gridRowGapModelMm: expectedGridRowGapModelMm,
  });

  const state = new ElevationModeState(graph, null, { width: 1000, height: 800 }, screenPxPerMm);
  await state.init();

  assert.ok(Math.abs(state.bands[0].bounds.maxY - reference.bounds.maxY) < 1e-6,
    `実際の帯のbounds.maxY(${state.bands[0].bounds.maxY})は、パス1と同じ倍率決定を経て` +
    `screenMmToModelMmで計算したnameGapModelMmを使って独立に再構築した帯(${reference.bounds.maxY})` +
    `と一致するはず`);
});

// ---- 項目10: 帯の水平初期位置(faceOffsetFor未設定時)はband.leftAnchorX（左三角の位置）基準になる ----
test('【項目10】ElevationModeState.faceOffsetFor: 未設定時はband.leftAnchorXを既定値として使う', async () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const state = new ElevationModeState(graph, null, { width: 1000, height: 800 });
  await state.init();

  // 実物のbuildRoomBand出力ではleftAnchorX===bounds.minXに一致してしまう（留め三角の引出線が
  // 常にband内で最も左に来るため）ため、既定値の参照元（leftAnchorXかbounds.minXか）を
  // 判別できない。合成バンド（leftAnchorXとbounds.minXをわざと分離）を使い、faceOffsetForが
  // 実際にband.leftAnchorXを読んでいるかどうかを切り分ける。
  const fakeBand = {
    roomId: 'fake', leftAnchorX: -9999, bounds: { minX: -20000, maxX: 100000 }, widthMm: 120000,
  };
  // 帯幅よりも十分狭いviewWidthに切り替え、clampFaceOffsetが「収まらない」分岐（offsetMmをそのまま
  // 使う）を通るようにする——「画面に収まる場合は中央寄せ」分岐だと既定値がそのまま返らないため。
  state.setViewSize({ width: 10, height: 800 });

  assert.equal(state.faceOffsetFor(fakeBand), fakeBand.leftAnchorX,
    'faceScroll未設定時はband.leftAnchorXがそのまま初期水平オフセットになるはず（bounds.minXではない）');
});

// ---- QA F1: 画面に収まる帯（トイレ等の小部屋）も収まらない帯（広いLDK等）も、
// 左三角の画面上位置が揃う（=leftAnchorXからfaceOffsetForまでの距離のpx換算が一致する）----
test('【QA F1】ElevationModeState.faceOffsetFor: 画面に収まる狭い帯・収まらない広い帯のどちらも左三角の画面位置が揃う', async () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 1500, 1200, 'トイレ');   // 画面に収まる狭い帯
  makeRectRoom(graph, 0, 5000, 8000, 10000, 'LDK'); // 画面に収まらない広い帯
  const state = new ElevationModeState(graph, null, { width: 1000, height: 800 });
  await state.init();

  const toilet = state.bands.find(b => b.roomName === 'トイレ');
  const ldk    = state.bands.find(b => b.roomName === 'LDK');
  assert.ok(toilet && ldk);

  const viewWidthMm = 1000 / state.scale;
  // 前提: 実際に「収まる帯」「収まらない帯」の両方が用意できていること。
  assert.ok(toilet.bounds.maxX - toilet.bounds.minX <= viewWidthMm, '前提: トイレは画面に収まる帯のはず');
  assert.ok(ldk.bounds.maxX - ldk.bounds.minX > viewWidthMm, '前提: LDKは画面に収まらない帯のはず');

  const toiletOffsetPx = (toilet.leftAnchorX - state.faceOffsetFor(toilet)) * state.scale;
  const ldkOffsetPx    = (ldk.leftAnchorX    - state.faceOffsetFor(ldk))    * state.scale;
  assert.ok(Math.abs(toiletOffsetPx - ldkOffsetPx) < 1e-6,
    `収まる帯・収まらない帯のどちらも左三角の画面位置(px)が揃うはず（トイレ:${toiletOffsetPx}px, LDK:${ldkOffsetPx}px）`);
});
