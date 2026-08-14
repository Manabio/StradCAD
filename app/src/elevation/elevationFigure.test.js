// buildFaceFigure の描画内容テスト（.claude/elevation-model.md §11 記載項目）。
// graph/room/opening は buildFaceFigure が実際に読むフィールドのみを持つ最小限のフェイクを使う
// （純関数のロジック検証が目的で、graph実体の生成コストを避ける）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeKey, OpeningCategory, CenterLineType } from '@core';
import {
  buildFaceFigure, kneeDropGapsOnFace, parseBaseboardHeightMm, avoidGridCollisionX,
  openingsReachingCorner,
} from './elevationFigure.js';
import {
  GRID_LINE_ABOVE_CH_MM, CANVAS_BG_COLOR, DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
  DEFAULT_OPENING_TAG_ROW_MM, OPENING_TAG_ROW_SCREEN_MM, OPENING_TAG_RADIUS_PX,
  DIM_ROW_GAP_SCREEN_MM, GRID_ROW_GAP_SCREEN_MM, GRID_TAG_RADIUS_PX,
} from './elevationStyle.js';
import { screenMmToModelMm, horizontalDimLabelBox } from './elevationLayout.js';
import { DEFAULT_PX_PER_MM } from '../viewport.js';

function makeFace(overrides = {}) {
  return {
    axisCL: { id: 'axisY0' }, isVertical: false, inward: 1, faceValue: 0,
    lo: 0, hi: 4000, run: 4000, dirSign: 1, originWorld: 0,
    startCLId: 'x0', endCLId: 'x1',
    ...overrides,
  };
}

function makeGraph({ openings = [], kneeDropWalls = new Map(), shapes = new Map() } = {}) {
  return { openings, kneeDropWalls, shapeMap: shapes };
}

function makeRoom(finishInfo = {}, finish = null) {
  return { getFinishInfo: () => finishInfo, finish };
}

function baseCtx(overrides = {}) {
  return {
    graph: makeGraph(), project: { openingNumberIndex: new Map() }, room: makeRoom(),
    ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
    ...overrides,
  };
}

// ---- CUT本数（床1天井1端2） ----
test('buildFaceFigure: 床線1・天井線1・両端縦線2の計4本のCUT(太)線が出る', () => {
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx());
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  assert.equal(cutLines.length, 4);
});

// ---- 項目4: floorSegmentsが段差を含む場合、床線は区間ごとの水平線＋段差の縦線になる ----
test('【項目4】buildFaceFigure: floorSegmentsが2区間（段差あり）なら床線は水平線2本＋段差縦線1本になり、両端の縦線もその区間の床yに追従する', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const face = makeFace();
  const ctx = baseCtx({ ceilingHeight: CH, floorSegments });
  const prims = buildFaceFigure(face, ctx);

  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  // 天井線1・床の水平線2（区間ごと）・段差縦線1・両端縦線2 = 計6本。
  assert.equal(cutLines.length, 6, `CUT線は6本のはず（実際:${cutLines.length}）`);

  const floorHorizontals = cutLines.filter(l => l.y1 === l.y2);
  assert.equal(floorHorizontals.length, 3, '天井線1本+床の水平線2本=3本の水平CUT線のはず');
  const seg0 = floorHorizontals.find(l => l.x1 === 0 && l.x2 === 2000);
  const seg1 = floorHorizontals.find(l => l.x1 === 2000 && l.x2 === 4000);
  assert.ok(seg0 && seg1, '両区間の水平線がそれぞれ見つかるはず');
  assert.equal(seg0.y1, 0, '左区間(floorDeltaMm:0)はy=0のまま');
  assert.equal(seg1.y1, -300, '右区間(floorDeltaMm:300)はy=-300へ上がるはず');

  // 段差の縦線（x=2000でy=0→y=-300）。
  const riser = cutLines.find(l => l.x1 === 2000 && l.x2 === 2000 && l.y1 === 0 && l.y2 === -300);
  assert.ok(riser, '段差の縦線(x=2000, y:0→-300)が見つかるはず');
  assert.equal(riser.weight, 'thick', '段差の縦線もCUTのはず');

  // 段差の寸法線・寸法値は描かない（明示指示）。
  assert.ok(!prims.some(p => p.type === 'dim' && p.at === 2000), '段差位置の寸法は描かないはず');

  // 両端の縦線（x=0とx=run=4000）は、その位置の区間の床yまで伸びる。
  const leftEnd  = cutLines.find(l => l.x1 === 0 && l.x2 === 0);
  const rightEnd = cutLines.find(l => l.x1 === face.run && l.x2 === face.run);
  assert.ok(leftEnd && rightEnd, '両端の縦線が見つかるはず');
  assert.equal(leftEnd.y2, 0, '左端は左区間の床y(0)まで');
  assert.equal(rightEnd.y2, -300, '右端は右区間の床y(-300)まで');
});

// ---- 失敗系: floorSegments省略時は従来どおり床線1本（フラット）になる ----
test('【失敗系・項目4】buildFaceFigure: floorSegments省略時は床線1本のフラットな床のままになる', () => {
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx());
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const floorHorizontals = cutLines.filter(l => l.y1 === l.y2 && l.y1 === 0);
  assert.equal(floorHorizontals.length, 1, '段差が無ければ床の水平線は1本のままのはず');
});

// ---- 開口 y=-(sill+h) ----
test('buildFaceFigure: 窓の開口矩形はy=-(sillHeight+height)から始まる', () => {
  const opening = {
    id: 'op1', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 900, height: 1100, sillHeight: 800,
    category: OpeningCategory.WINDOW, subType: 'singleSliding', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [opening] }) });
  const prims = buildFaceFigure(face, ctx);
  const rect = prims.find(p => p.type === 'rect' && p.w === 900);
  assert.ok(rect, '開口矩形が見つからない');
  assert.equal(rect.y, -(800 + 1100));
  assert.equal(rect.h, 1100);
});

test('buildFaceFigure: 建具（窓以外）はsill=0扱いでy=-heightから始まる', () => {
  const opening = {
    id: 'op2', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 800, height: 2000, sillHeight: 500, // sillHeightは窓専用のため無視される
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [opening] }) });
  const prims = buildFaceFigure(face, ctx);
  const rect = prims.find(p => p.type === 'rect' && p.w === 800);
  assert.equal(rect.y, -2000);
});

// ---- 項目1: 開口は姿（枠・吊元表示・機構表現・レバーハンドル）を描き、寸法・動作線は出さない ----
test('【項目1】buildFaceFigure: 建具(fitting)×SWINGは吊元表示(一点鎖線V)・レバーハンドルを描くが、寸法(editable)・動作線(arrow)は出さない', () => {
  const opening = {
    id: 'op3', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 900, height: 2000, sillHeight: null, hingeSide: -1,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [opening] }) });
  const prims = buildFaceFigure(face, ctx);

  assert.ok(!prims.some(p => p.type === 'dim' && p.editable), '開口の編集用寸法(width/height/handleHeight)は出ないはず');
  assert.ok(!prims.some(p => p.type === 'arrow'), '動作線(arrow)は出ないはず');
  assert.ok(prims.some(p => p.type === 'line' && p.dash === 'center' && p.x1 !== p.x2), '吊元表示（斜めの一点鎖線V）は残るはず');
  assert.ok(prims.some(p => p.type === 'rect' && p.rx != null), 'レバーハンドル（カプセル形rect）は残るはず');
});

// ---- 項目2: 建具記号丸(tag)は建具の中心ではなく、寸法行より図寄りの専用段へ描かれる ----
test('【項目2】buildFaceFigure: 建具記号丸(tag)は開口の中心ではなく、床線と壁芯間寸法行の中間の段に描かれる', () => {
  const opening = {
    id: 'op4', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 900, height: 2000, sillHeight: 500,
    category: OpeningCategory.WINDOW, subType: 'singleSliding', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [opening] }) });
  const prims = buildFaceFigure(face, ctx);
  const tag = prims.find(p => p.type === 'tag');
  assert.ok(tag, '建具記号丸が見つからない');
  assert.equal(tag.cx, 2000, 'xは開口中心のまま');
  // ctx.openingTagRowModelMm未指定時はDEFAULT_OPENING_TAG_ROW_MMへフォールバックする（QA C1）。
  assert.equal(tag.cy, DEFAULT_OPENING_TAG_ROW_MM, 'yは開口の縦中心ではなく専用段（床線とROW1の中間）のはず');
  assert.notEqual(tag.cy, -(500 + 2000) / 2, '以前の仕様（開口の縦中心）には戻っていないはず');
});

// ---- QA C1: 建具記号丸(tag)はスクリーン固定サイズ(OPENING_TAG_RADIUS_PX)を持つため、行位置は
// 2パス機構でscreenMmToModelMm換算した値を使わないと、低倍率(縮小)側で床線・ROW1に重なる。
// ここでは1/20・1/50・1/100の3スケールで実際に換算した値をctx経由で渡し、タグ円が床線・ROW1
// いずれからも半径+余裕ぶんの実画面px以上離れていることを確認する（変異=2パス換算を外すと赤）。
// QA D2: dimRowGapModelMmはopeningTagRowModelMmの2倍として導出しない（独立したスクリーンmm
// 予算=DIM_ROW_GAP_SCREEN_MMから換算する。ElevationModeState.initと同じ配線）。----
const TAG_CLEARANCE_PX = OPENING_TAG_RADIUS_PX + 4; // 半径16px + 余裕4px
// ---- QA D1: 通り芯丸(GRID_TAG_RADIUS_PX)もスクリーン固定サイズのため、ROW2寸法線からの
// 行間（旧GRID_ROW_GAP_MM=300固定）が低倍率側で重なっていた。GRID_ROW_GAP_SCREEN_MMへ
// 2パス化し、同じ3スケールで通り芯丸がROW2から半径+余裕ぶん離れていることを確認する
// （変異=GRID_ROW_GAP_MMのモデルmm固定に戻すと赤。D1指摘の実測: 1/50で6px・1/100で8px食い込み）。
const GRID_CLEARANCE_PX = GRID_TAG_RADIUS_PX + 4; // 半径11px + 余裕4px

for (const scale of [1 / 20, 1 / 50, 1 / 100]) {
  test(`【QA C1】buildFaceFigure: scale=${scale}でも建具記号丸は床線・ROW1のどちらからも半径+余裕ぶん実画面pxで離れる`, () => {
    const screenPxPerMm = 5.5;
    const openingTagRowModelMm = screenMmToModelMm(OPENING_TAG_ROW_SCREEN_MM, screenPxPerMm, scale);
    const dimRowGapModelMm = screenMmToModelMm(DIM_ROW_GAP_SCREEN_MM, screenPxPerMm, scale);

    const opening = {
      id: 'op5', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
      centerCoord: 2000, width: 900, height: 2000, sillHeight: 500,
      category: OpeningCategory.WINDOW, subType: 'singleSliding', fixtureType: null,
    };
    const face = makeFace();
    const ctx = baseCtx({
      graph: makeGraph({ openings: [opening] }), openingTagRowModelMm, dimRowGapModelMm,
    });
    const prims = buildFaceFigure(face, ctx);
    const tag = prims.find(p => p.type === 'tag');
    const wallDim = prims.find(p => p.type === 'dim' && p.dir === 'h' && p.from === 0 && p.to === 4000);
    assert.ok(tag && wallDim, 'タグ・ROW1寸法の両方が見つかるはず');

    const floorClearancePx = tag.cy * scale; // 床線(y=0)からタグ行までの実画面px
    const row1ClearancePx  = (wallDim.at - tag.cy) * scale; // タグ行からROW1までの実画面px
    assert.ok(floorClearancePx >= TAG_CLEARANCE_PX,
      `床線からのクリアランス(${floorClearancePx}px)は${TAG_CLEARANCE_PX}px以上のはず`);
    assert.ok(row1ClearancePx >= TAG_CLEARANCE_PX,
      `ROW1までのクリアランス(${row1ClearancePx}px)は${TAG_CLEARANCE_PX}px以上のはず`);
  });

  test(`【QA D1】buildFaceFigure: scale=${scale}でも通り芯丸はROW2寸法線から半径+余裕ぶん実画面pxで離れる`, () => {
    const screenPxPerMm = 5.5;
    const dimRowGapModelMm  = screenMmToModelMm(DIM_ROW_GAP_SCREEN_MM, screenPxPerMm, scale);
    const gridRowGapModelMm = screenMmToModelMm(GRID_ROW_GAP_SCREEN_MM, screenPxPerMm, scale);

    const shapes = new Map([['x0', { effectiveValue: 0 }], ['x1', { effectiveValue: 4000 }]]);
    const gridCLs = [
      { centerLineType: CenterLineType.VERTICAL, effectiveValue: 1000, label: '1' },
      { centerLineType: CenterLineType.VERTICAL, effectiveValue: 3000, label: '2' },
    ];
    const face = makeFace();
    const ctx = baseCtx({ graph: makeGraph({ shapes }), gridCLs, dimRowGapModelMm, gridRowGapModelMm });
    const prims = buildFaceFigure(face, ctx);

    const row2Dim = prims.find(p => p.type === 'dim' && p.dir === 'h' && p.from === 1000 && p.to === 3000);
    const circle  = prims.find(p => p.type === 'circle');
    assert.ok(row2Dim && circle, 'ROW2寸法・通り芯丸の両方が見つかるはず');

    const clearancePx = (circle.cy - row2Dim.at) * scale;
    assert.ok(clearancePx >= GRID_CLEARANCE_PX,
      `ROW2から通り芯丸までのクリアランス(${clearancePx}px)は${GRID_CLEARANCE_PX}px以上のはず`);
  });

  // ---- 項目2: タグ丸の縁とROW1寸法値テキスト上端が重ならない（線の上に値が乗る分も含めて判定）----
  // screenPxPerMmは既定校正値(DEFAULT_PX_PER_MM)を使う——他のテスト(QA C1/D1)が使う5.5では
  // 旧値(16mm)でも偶然クリアランスが正になってしまい、項目2で修正した不具合（既定校正値付近で
  // 実際に発生していた重なり）を再現できない。
  test(`【項目2】buildFaceFigure: scale=${scale}でも建具記号丸の縁とROW1寸法値テキスト上端が重ならない`, () => {
    const screenPxPerMm = DEFAULT_PX_PER_MM;
    const openingTagRowModelMm = screenMmToModelMm(OPENING_TAG_ROW_SCREEN_MM, screenPxPerMm, scale);
    const dimRowGapModelMm     = screenMmToModelMm(DIM_ROW_GAP_SCREEN_MM, screenPxPerMm, scale);

    const opening = {
      id: 'op6', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
      centerCoord: 2000, width: 900, height: 2000, sillHeight: 500,
      category: OpeningCategory.WINDOW, subType: 'singleSliding', fixtureType: null,
    };
    const face = makeFace();
    const ctx = baseCtx({
      graph: makeGraph({ openings: [opening] }), openingTagRowModelMm, dimRowGapModelMm,
    });
    const prims = buildFaceFigure(face, ctx);
    const tag = prims.find(p => p.type === 'tag');
    const wallDim = prims.find(p => p.type === 'dim' && p.dir === 'h' && p.from === 0 && p.to === 4000);
    assert.ok(tag && wallDim, 'タグ・ROW1寸法の両方が見つかるはず');

    // レンダラ(figurePrimitivesKonva.jsx)と同じ計算: dim.atをpx換算した位置がhorizontalDimLabelBox
    // のmidYになり、テキスト上端はbox.y（線からgapPx+thicknessPxぶん上）。
    const tagBottomPx  = tag.cy * scale + OPENING_TAG_RADIUS_PX;
    const row1LabelBox = horizontalDimLabelBox(0, wallDim.at * scale);
    const textTopPx    = row1LabelBox.y;
    assert.ok(textTopPx >= tagBottomPx,
      `ROW1寸法値テキスト上端(${textTopPx}px)はタグ丸の下端(${tagBottomPx}px)より下（重ならない）はず`);
  });
}

// ---- 項目3: 直交壁の建具が切断位置（面端）にかかる場合、その断面（枠2断面＋扉）を描く ----
function makePerpFace(overrides = {}) {
  return {
    axisCL: { id: 'axisX_left' }, isVertical: true, inward: 1, faceValue: 0,
    lo: 0, hi: 2000, run: 2000, dirSign: 1, originWorld: 0,
    startCLId: 'py0', endCLId: 'py1',
    ...overrides,
  };
}
test('【項目3】buildFaceFigure: prevFace上の開口が隅(perpFace.run)まで届いていれば、面のx=0側に枠2断面＋扉1枚の断面が出る', () => {
  const perpOpening = {
    id: 'perp1', isVertical: true, axisCL: { id: 'axisX_left' }, wallSide: 1,
    centerCoord: 1900, width: 800, height: 2000, sillHeight: null, // local span [1500,2300]。hi=2300>=run(2000)
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeFace(); // run=4000
  const prevFace = makePerpFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [perpOpening] }), prevFace, nextFace: null });
  const prims = buildFaceFigure(face, ctx);

  const strip = prims.filter(p => p.type === 'rect' && p.x >= 0 && p.x + p.w <= 120 && p.y === -2000 && p.h === 2000);
  assert.equal(strip.length, 3, '枠2断面＋扉1枚＝3本のrectが面のx=0側の帯に出るはず');
  const weights = strip.map(r => r.weight).sort();
  assert.deepEqual(weights, ['medium', 'thick', 'thick'].sort(), '枠2本=CUT(thick)・扉1本=SILHOUETTE(medium)のはず');
});

test('【失敗系・項目3】buildFaceFigure: prevFace上の開口が隅から離れていれば断面を描かない', () => {
  const perpOpening = {
    id: 'perp2', isVertical: true, axisCL: { id: 'axisX_left' }, wallSide: 1,
    centerCoord: 500, width: 800, height: 2000, sillHeight: null, // local span [100,900]。隅(2000)まで届かない
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeFace();
  const prevFace = makePerpFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [perpOpening] }), prevFace, nextFace: null });
  const prims = buildFaceFigure(face, ctx);

  const strip = prims.filter(p => p.type === 'rect' && p.x >= 0 && p.x + p.w <= 120 && p.y === -2000 && p.h === 2000);
  assert.equal(strip.length, 0, '隅から離れた開口は断面を描かないはず');
});

test('【失敗系・項目3】buildFaceFigure: prevFace/nextFaceが未指定（省略）なら断面ロジックごと素通りし例外にならない', () => {
  const face = makeFace();
  assert.doesNotThrow(() => buildFaceFigure(face, baseCtx()));
});

test('openingsReachingCorner: 開口スパンが隅(0またはrun)に届いているものだけを返す', () => {
  const perpFace = makePerpFace();
  const reaching = { id: 'a', isVertical: true, axisCL: { id: 'axisX_left' }, wallSide: 1, centerCoord: 1900, width: 800, height: 2000, category: OpeningCategory.FITTING, subType: 'singleSwing' };
  const notReaching = { id: 'b', isVertical: true, axisCL: { id: 'axisX_left' }, wallSide: 1, centerCoord: 500, width: 800, height: 2000, category: OpeningCategory.FITTING, subType: 'singleSwing' };
  const graph = makeGraph({ openings: [reaching, notReaching] });

  assert.deepEqual(openingsReachingCorner(perpFace, graph, 'end').map(o => o.id), ['a']);
  assert.deepEqual(openingsReachingCorner(perpFace, graph, 'start').map(o => o.id), []);
});

// ---- アキ矩形高さ = CH - drop.bottomHeight - knee.topHeight ----
test('kneeDropGapsOnFace: アキの矩形高さはCH-drop.bottomHeight-knee.topHeight', () => {
  const shapes = new Map([
    ['s', { value: 1000 }],
    ['e', { value: 3000 }],
  ]);
  const key = edgeKey('axisY0', 's', 'e');
  const kneeDropWalls = new Map([[key, { knee: { topHeight: 600 }, drop: { bottomHeight: 400 } }]]);
  const graph = makeGraph({ kneeDropWalls, shapes });
  const face = makeFace();
  const CH = 2400;

  const gaps = kneeDropGapsOnFace(face, graph, CH);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].h, CH - 400 - 600);
  assert.equal(gaps[0].y, -(CH - 400));
  assert.equal(gaps[0].x, 1000);
  assert.equal(gaps[0].w, 2000);
});

test('buildFaceFigure: アキは矩形＋対角2本(一点鎖線)＋「ア キ」テキストを出す', () => {
  const shapes = new Map([['s', { value: 1000 }], ['e', { value: 3000 }]]);
  const key = edgeKey('axisY0', 's', 'e');
  const kneeDropWalls = new Map([[key, { knee: { topHeight: 600 }, drop: { bottomHeight: 400 } }]]);
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ kneeDropWalls, shapes }) });
  const prims = buildFaceFigure(face, ctx);

  assert.equal(prims.filter(p => p.type === 'rect').length, 1);
  // アキの対角線は斜め(x1!==x2)。項目2で追加した壁中心線の落し線(縦線・x1===x2)と区別する。
  const diagonalCenterLines = prims.filter(p =>
    p.type === 'line' && p.dash === 'center' && p.weight === 'thin' && p.x1 !== p.x2);
  assert.equal(diagonalCenterLines.length, 2);
  assert.ok(prims.some(p => p.type === 'text' && p.text === 'ア キ'));
});

// ---- 失敗系: knee/dropのどちらか片方だけの指定はアキにならない ----
test('【失敗系】kneeDropGapsOnFace: 腰壁のみ・垂れ壁のみの片側指定はアキを作らない', () => {
  const shapes = new Map([['s', { value: 1000 }], ['e', { value: 3000 }]]);
  const graph1 = makeGraph({ shapes, kneeDropWalls: new Map([[edgeKey('axisY0', 's', 'e'), { knee: { topHeight: 600 }, drop: null }]]) });
  const graph2 = makeGraph({ shapes, kneeDropWalls: new Map([[edgeKey('axisY0', 's', 'e'), { knee: null, drop: { bottomHeight: 400 } }]]) });
  const face = makeFace();
  assert.deepEqual(kneeDropGapsOnFace(face, graph1, 2400), []);
  assert.deepEqual(kneeDropGapsOnFace(face, graph2, 2400), []);
});

// ---- QA F6: labeled STRUCT RADIAL CL（角度がface.lo..hi内）は通り芯として描かれない ----
test('【QA F6】buildFaceFigure: RADIAL CL（放射CL。value=角度deg）は通り芯として描かれない', () => {
  // isVertical=trueの面（B/D相当）。旧実装は `(cl.centerLineType==='X')===wantVertical` の
  // 真偽値比較でRADIAL('R')がwantVertical=false側にマッチしてしまっていた。
  const face = makeFace({ isVertical: true, axisCL: { id: 'axisX0' }, faceValue: 0, lo: 0, hi: 4000 });
  const radialCL = { centerLineType: CenterLineType.RADIAL, effectiveValue: 45, label: 'R1' };
  const ctx = baseCtx({ gridCLs: [radialCL] });

  const prims = buildFaceFigure(face, ctx);
  assert.ok(!prims.some(p => p.type === 'text' && p.text === 'R1'), 'RADIAL CLのラベルが描かれてはいけない');
  assert.ok(!prims.some(p => p.type === 'circle'), '通り芯丸番号(circle)が描かれてはいけない');
});

// ---- 失敗系: faceの範囲外の区間は無視する ----
test('【失敗系】kneeDropGapsOnFace: faceのlo..hi範囲外の区間は無視する', () => {
  const shapes = new Map([['s', { value: 5000 }], ['e', { value: 6000 }]]);
  const kneeDropWalls = new Map([[edgeKey('axisY0', 's', 'e'), { knee: { topHeight: 600 }, drop: { bottomHeight: 400 } }]]);
  const graph = makeGraph({ shapes, kneeDropWalls });
  const face = makeFace({ lo: 0, hi: 4000 });
  assert.deepEqual(kneeDropGapsOnFace(face, graph, 2400), []);
});

// ---- parseBaseboardHeightMm: "h=<数値>" 表記のみ解釈する ----
test('parseBaseboardHeightMm: "h=60"/"H=60mm"は60を返す', () => {
  assert.equal(parseBaseboardHeightMm('h=60'), 60);
  assert.equal(parseBaseboardHeightMm('H=60mm'), 60);
  assert.equal(parseBaseboardHeightMm('木製出幅木 h=60'), 60);
});

// ---- 失敗系: 解釈できない巾木文字列はnull（非描画） ----
test('【失敗系】parseBaseboardHeightMm: "h="を含まない・非文字列は解釈できずnullを返す', () => {
  assert.equal(parseBaseboardHeightMm('60'), null, '"h="が無い素の数値は対象外');
  assert.equal(parseBaseboardHeightMm(''), null);
  assert.equal(parseBaseboardHeightMm(null), null);
  assert.equal(parseBaseboardHeightMm(undefined), null);
});

// ---- 巾木線: room.finish.baseboardHeightが解釈できる場合のみ、床上その高さに引かれる ----
test('buildFaceFigure: 巾木(h=60)は床上60mmに引かれ、床まで達する開口の区間は途切れる', () => {
  const doorOpening = {
    id: 'op1', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 800, height: 2000, sillHeight: 0,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({
    graph: makeGraph({ openings: [doorOpening] }),
    room: makeRoom({}, { baseboardHeight: 'h=60' }),
  });
  const prims = buildFaceFigure(face, ctx);
  const baseboardLines = prims.filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === -60 && p.y2 === -60);
  // 開口(1600..2400)の左右2区間に分かれるはず（[0,1600], [2400,4000]）。
  assert.equal(baseboardLines.length, 2, `巾木線は開口区間で途切れて2本になるはず（実際:${baseboardLines.length}）`);
  assert.ok(baseboardLines.some(p => p.x1 === 0 && p.x2 === 1600));
  assert.ok(baseboardLines.some(p => p.x1 === 2400 && p.x2 === 4000));
});

// ---- 失敗系: 巾木文字列が解釈できない場合は非描画 ----
test('【失敗系】buildFaceFigure: baseboardHeightが解釈不能な文字列なら巾木線を描かない', () => {
  const face = makeFace();
  const ctx = baseCtx({ room: makeRoom({}, { baseboardHeight: '既製品' }) });
  const prims = buildFaceFigure(face, ctx);
  assert.ok(!prims.some(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.y1 < 0 && p.y1 > -100),
    '解釈不能な巾木文字列では巾木線を描いてはいけない');
});

// ---- 壁芯間寸法（ROW1）: 面の両端＝壁中心線(faceBoundaryLocalX)で1本出る ----
test('buildFaceFigure: 壁芯間寸法(横dim)がface.lo/hiではなく壁中心線(CL)基準で1本出る', () => {
  const shapes = new Map([['x0', { effectiveValue: -100 }], ['x1', { effectiveValue: 4100 }]]);
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ shapes }) });
  const prims = buildFaceFigure(face, ctx);
  const wallDims = prims.filter(p => p.type === 'dim' && p.dir === 'h');
  assert.equal(wallDims.length, 1);
  assert.equal(wallDims[0].from, -100);
  assert.equal(wallDims[0].to, 4100);
  assert.equal(wallDims[0].label, 4200);
});

// ---- QA G4: 通り芯間寸法(ROW2)と通り芯丸番号は別の段（同じyに同居させない） ----
test('【QA G4】buildFaceFigure: 通り芯丸(circle)は通り芯間寸法(ROW2のdim)より、さらに下の段に分離される', () => {
  const gridCLs = [
    { centerLineType: CenterLineType.VERTICAL, effectiveValue: 1000, label: '1' },
    { centerLineType: CenterLineType.VERTICAL, effectiveValue: 3000, label: '2' },
  ];
  const face = makeFace();
  const ctx = baseCtx({ gridCLs });
  const prims = buildFaceFigure(face, ctx);

  const gridDim = prims.find(p => p.type === 'dim' && p.dir === 'h' && p.from === 1000 && p.to === 3000);
  assert.ok(gridDim, '通り芯間寸法(1000→3000)が出るはず');
  const circles = prims.filter(p => p.type === 'circle');
  assert.equal(circles.length, 2);
  for (const c of circles) {
    assert.notEqual(c.cy, gridDim.at, '通り芯丸のyは通り芯間寸法の行(at)と同じであってはいけない（別段。QA G4）');
    assert.ok(c.cy > gridDim.at, '通り芯丸は寸法行よりさらに下（yが大きい）はず');
  }
});

// ---- 項目2・6: 水平寸法（壁芯間・通り芯間）に寸法線足(dim.foot)を出さない ----
test('【項目2・6】buildFaceFigure: 水平寸法(壁芯間・通り芯間)はdim.footを持たない', () => {
  const gridCLs = [
    { centerLineType: CenterLineType.VERTICAL, effectiveValue: 1000, label: '1' },
    { centerLineType: CenterLineType.VERTICAL, effectiveValue: 3000, label: '2' },
  ];
  const face = makeFace();
  const ctx = baseCtx({ gridCLs });
  const prims = buildFaceFigure(face, ctx);
  const horizontalDims = prims.filter(p => p.type === 'dim' && p.dir === 'h');
  assert.ok(horizontalDims.length >= 2, '壁芯間・通り芯間の両方が出るはず');
  for (const d of horizontalDims) {
    assert.equal(d.foot, undefined, `水平寸法にdim.footが残っている: ${JSON.stringify(d)}`);
    assert.equal(d.dot, true, '足の代わりに交点の塗り丸(dim.dot)が立つはず');
  }
});

// ---- 項目2: 壁芯間寸法の位置に、壁中心線自体（一点鎖線）が床から下りてくる ----
test('【項目2】buildFaceFigure: 壁芯間寸法の位置(boundary.lo/hi)まで壁中心線の一点鎖線が下りる', () => {
  const shapes = new Map([['x0', { effectiveValue: -100 }], ['x1', { effectiveValue: 4100 }]]);
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ shapes }) });
  const prims = buildFaceFigure(face, ctx);
  const wallDim = prims.find(p => p.type === 'dim' && p.dir === 'h' && p.from === -100 && p.to === 4100);
  assert.ok(wallDim, '壁芯間寸法が見つからない');

  const dropLines = prims.filter(p =>
    p.type === 'line' && p.dash === 'center' && p.x1 === p.x2 && p.y2 === wallDim.at);
  assert.equal(dropLines.length, 2, '両端の壁中心線が寸法線の位置まで下りる縦の一点鎖線が2本出るはず');
  assert.ok(dropLines.some(l => l.x1 === -100));
  assert.ok(dropLines.some(l => l.x1 === 4100));
});

// ---- 項目4: 壁中心線（面両端）も通り芯線と同様、天井線より上まで突き出す ----
test('【項目4】buildFaceFigure: 壁中心線の縦一点鎖線はy1=-CH-GRID_LINE_ABOVE_CH_MMまで天井線より上に伸びる', () => {
  const CH = 2400;
  const shapes = new Map([['x0', { effectiveValue: -100 }], ['x1', { effectiveValue: 4100 }]]);
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ shapes }), ceilingHeight: CH });
  const prims = buildFaceFigure(face, ctx);

  const dropLines = prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 === p.x2 && (p.x1 === -100 || p.x1 === 4100));
  assert.equal(dropLines.length, 2);
  for (const l of dropLines) {
    assert.equal(l.y1, -CH - GRID_LINE_ABOVE_CH_MM,
      `壁中心線(x=${l.x1})のy1は-CH-GRID_LINE_ABOVE_CH_MM(${-CH - GRID_LINE_ABOVE_CH_MM})のはず（実際:${l.y1}）`);
  }
});

// ---- 項目7・QA F3: 面ラベル(A/B/C/D等)は壁中心線で挟んだ幅の中心（run/2ではない）に出る ----
test('【項目7・QA F3】buildFaceFigure: 面ラベル(face.label)は壁中心線基準の幅中心(boundary.lo/hiの中点)に描かれ、run/2とは一致しない', () => {
  // 壁中心線(x0/x1)をface.lo/hi(0/4000)から非対称にずらし、run/2とboundary中心が
  // 一致しない状況を作る（run/2に固定されていた旧実装ならこのテストで判別できる）。
  const shapes = new Map([['x0', { effectiveValue: -100 }], ['x1', { effectiveValue: 4300 }]]);
  const face = makeFace({ label: 'B1' });
  const ctx = baseCtx({ graph: makeGraph({ shapes }) });
  const prims = buildFaceFigure(face, ctx);
  const label = prims.find(p => p.type === 'text' && p.text === 'B1');
  assert.ok(label, '面ラベルのtextが出ない');
  assert.notEqual(label.x, face.run / 2, '前提: run/2(2000)とboundary中心(2100)がズレているはず');
  assert.equal(label.x, (-100 + 4300) / 2, '壁中心線で挟んだ幅の中心に配置されるはず');
  assert.equal(label.anchor, 'middle');
});

// ---- 調整項目2: 通り芯丸(circle)とA/B/C/D面ラベルは同じ高さ(y)に揃う ----
test('【調整項目2】buildFaceFigure: 通り芯丸(circle)と面ラベル(face.label)は同じyに描かれる', () => {
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 1500, label: '1' }];
  const face = makeFace({ label: 'A' });
  const prims = buildFaceFigure(face, baseCtx({ gridCLs }));

  const circle = prims.find(p => p.type === 'circle');
  const label  = prims.find(p => p.type === 'text' && p.text === 'A');
  assert.ok(circle && label, '通り芯丸・面ラベルの両方が出るはず');
  assert.equal(circle.cy, label.y, '通り芯丸と面ラベルは同じ段(同じy)に揃うはず');
  // 水平位置は従来通り別（通り芯丸=通り芯位置、面ラベル=壁芯間中心）で一致しないことも確認する。
  assert.notEqual(circle.cx, label.x, '水平位置は従来どおり別のまま（通り芯位置と壁芯間中心）のはず');
});

// ---- 調整項目3: 通り芯の一点鎖線は天井線(-CH)より上へ少し突き出す ----
test('【調整項目3】buildFaceFigure: 通り芯の一点鎖線はy1=-CH-GRID_LINE_ABOVE_CH_MMまで天井線より上に伸びる', () => {
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 1500, label: '1' }];
  const CH = 2400;
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ gridCLs, ceilingHeight: CH }));

  const gridLine = prims.find(p => p.type === 'line' && p.dash === 'center' && p.x1 === 1500 && p.x1 === p.x2);
  assert.ok(gridLine, '通り芯の一点鎖線が見つからない');
  assert.equal(gridLine.y1, -CH - GRID_LINE_ABOVE_CH_MM,
    `通り芯線の上端は-CH-GRID_LINE_ABOVE_CH_MM(${-CH - GRID_LINE_ABOVE_CH_MM})のはず（実際:${gridLine.y1}）`);
  assert.ok(gridLine.y1 < -CH, '天井線(-CH)より上（より負のy）まで突き出しているはず');
});

// ---- 調整項目5: 通り芯丸(circle)は背景色で塗り、通り芯線より後（配列順で手前）に描く ----
test('【調整項目5】buildFaceFigure: 通り芯丸(circle)はCANVAS_BG_COLORで塗りつぶされ、通り芯線より後に積まれる', () => {
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 1500, label: '1' }];
  const prims = buildFaceFigure(makeFace(), baseCtx({ gridCLs }));

  const lineIdx   = prims.findIndex(p => p.type === 'line' && p.dash === 'center' && p.x1 === 1500 && p.x1 === p.x2);
  const circleIdx = prims.findIndex(p => p.type === 'circle');
  assert.ok(lineIdx >= 0 && circleIdx >= 0);
  const circle = prims[circleIdx];
  assert.equal(circle.fill, CANVAS_BG_COLOR, '通り芯丸のfillは背景色(CANVAS_BG_COLOR)のはず（線を隠すため塗りつぶす）');
  assert.ok(circleIdx > lineIdx, '通り芯丸は通り芯線より後（Konvaの描画順で手前）に積まれるはず');
});

// ---- 失敗系: 通り芯が無い面は丸・面ラベルの段が空でも例外を投げない（面ラベル自体は出る） ----
test('【失敗系・調整項目2】buildFaceFigure: 通り芯が無い面でも面ラベルは出て例外にならない', () => {
  const face = makeFace({ label: 'C' });
  const prims = buildFaceFigure(face, baseCtx({ gridCLs: [] }));
  assert.equal(prims.filter(p => p.type === 'circle').length, 0);
  assert.ok(prims.some(p => p.type === 'text' && p.text === 'C'));
});

// ---- QA A1: 通り芯が面の壁芯間中心付近にあると、面ラベルと通り芯丸(同じ段=項目2)が重なる
// ため、面ラベルを横へ退避させる ----
test('【QA A1】buildFaceFigure: 通り芯が面中心にあるとき、面ラベルは同じ段のまま通り芯丸から閾値を超えて離れる', () => {
  // QA実測の再現: CL 0/2000/4000・run=4000（壁芯間中心=2000）に通り芯も2000で衝突させる。
  const shapes = new Map([['x0', { effectiveValue: 0 }], ['x1', { effectiveValue: 4000 }]]);
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 2000, label: '1' }];
  const face = makeFace({ label: 'A' });
  const prims = buildFaceFigure(face, baseCtx({ graph: makeGraph({ shapes }), gridCLs }));

  const circle = prims.find(p => p.type === 'circle');
  const label  = prims.find(p => p.type === 'text' && p.text === 'A');
  assert.ok(circle && label, '通り芯丸・面ラベルの両方が出るはず');
  assert.equal(label.y, circle.cy, '面ラベルは通り芯丸と同じ段(y)のまま（項目2の統合は維持する）');
  assert.ok(Math.abs(label.x - circle.cx) > DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
    `面ラベルは通り芯丸からDEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM(${DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM})を超えて` +
    `離れるはず（実際差: ${Math.abs(label.x - circle.cx)}）`);
});

// ---- 失敗系: 通り芯が面中心から十分離れていれば面ラベルは退避しない（既定の壁芯間中心のまま） ----
test('【失敗系・QA A1】buildFaceFigure: 通り芯が面中心から十分離れていれば面ラベルは退避しない', () => {
  const shapes = new Map([['x0', { effectiveValue: 0 }], ['x1', { effectiveValue: 4000 }]]);
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 3900, label: '1' }];
  const face = makeFace({ label: 'A' });
  const prims = buildFaceFigure(face, baseCtx({ graph: makeGraph({ shapes }), gridCLs }));
  const label = prims.find(p => p.type === 'text' && p.text === 'A');
  assert.equal(label.x, 2000, '衝突しなければ既定の壁芯間中心(2000)のまま退避しないはず');
});

// ---- QA B1: 910mm等間隔グリッド（住宅の標準モジュール。2間の部屋＝最頻ケース）で、旧「一段だけ
// 固定シフト」実装は退避後の位置が別の通り芯丸に再度重なっていた。最広ギャップ中点方式なら、
// 退避後のxが**全ての**通り芯丸から閾値以上離れることを確認する（1回の走査で決定的に解消）。----
test('【QA B1】buildFaceFigure: 910グリッド(CLs=0/910/1820/2730/3640・run=3640)で面ラベルは全ての通り芯丸から閾値以上離れる', () => {
  const shapes = new Map([['x0', { effectiveValue: 0 }], ['x1', { effectiveValue: 3640 }]]);
  const gridCLs = [0, 910, 1820, 2730, 3640].map((v, i) =>
    ({ centerLineType: CenterLineType.VERTICAL, effectiveValue: v, label: String(i + 1) }));
  const face = makeFace({ label: 'A', lo: 0, hi: 3640, run: 3640 });
  const prims = buildFaceFigure(face, baseCtx({ graph: makeGraph({ shapes }), gridCLs }));

  const circles = prims.filter(p => p.type === 'circle');
  const label   = prims.find(p => p.type === 'text' && p.text === 'A');
  assert.equal(circles.length, 5, '通り芯丸は5個出るはず');
  for (const c of circles) {
    assert.ok(Math.abs(label.x - c.cx) >= DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
      `面ラベル(x=${label.x})は通り芯丸(cx=${c.cx})から閾値(${DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM})以上` +
      `離れるはず（実際差: ${Math.abs(label.x - c.cx)}）`);
  }
});

// ---- avoidGridCollisionX 単体（QA B1）: 衝突時は最広ギャップの中点、非衝突時は元のxのまま ----
test('avoidGridCollisionX: 衝突時（境界含む）は最広ギャップの中点へ、超えていれば退避しない', () => {
  const boundary = { lo: 0, hi: 4000 };
  // 通り芯2400のみ・衝突（距離400=閾値ちょうど）。区間は[0,2400](幅2400)と[2400,4000](幅1600)。
  // より広い[0,2400]の中点=1200へ。
  assert.equal(avoidGridCollisionX(2000, [{ x: 2400 }], boundary, 400), 1200, '距離=閾値ちょうどでも退避し、最も広い区間の中点になる');
  // 通り芯2401のみ・非衝突（距離401>閾値400）→ 動かさない。
  assert.equal(avoidGridCollisionX(2000, [{ x: 2401 }], boundary, 400), 2000, '距離が閾値を超えていれば退避しない');
  // 通り芯2000のみ（面中心と同座標）・衝突。区間は[0,2000]と[2000,4000]で幅が等しい→先に見つかる側([0,2000])の中点=1000。
  assert.equal(avoidGridCollisionX(2000, [{ x: 2000 }], boundary, 400), 1000, '幅が同点なら先に見つかった区間の中点になる');
});

// ---- 失敗系: gridPointsが空なら常に退避しない ----
test('【失敗系】avoidGridCollisionX: gridPointsが空なら常に元のxを返す', () => {
  assert.equal(avoidGridCollisionX(2000, [], { lo: 0, hi: 4000 }, 400), 2000);
});
