// buildFaceFigure の描画内容テスト（.claude/elevation-model.md §11 記載項目）。
// graph/room/opening は buildFaceFigure が実際に読むフィールドのみを持つ最小限のフェイクを使う
// （純関数のロジック検証が目的で、graph実体の生成コストを避ける）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeKey, OpeningCategory, CenterLineType, Plane, PlanGraph, Discipline, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import {
  buildFaceFigure, kneeDropGapsOnFace, parseBaseboardHeightMm, avoidGridCollisionX,
  openingsReachingCorner, formatMaterialLabel, avoidObstacleRangesX, estimateWallLabelWidthPx,
  segEndProfile,
} from './elevationFigure.js';
import { buildRoomFaces as realBuildRoomFaces, faceBoundaryLocalX, drawnSpanRanges } from './elevationFaces.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { wallAdjacentFloorSegments } from './elevationFloorProfile.js';
import {
  GRID_LINE_ABOVE_CH_MM, CANVAS_BG_COLOR, DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
  DEFAULT_OPENING_TAG_ROW_MM, OPENING_TAG_ROW_SCREEN_MM, OPENING_TAG_RADIUS_PX,
  DIM_ROW_GAP_SCREEN_MM, GRID_ROW_GAP_SCREEN_MM, GRID_TAG_RADIUS_PX,
  DEFAULT_WALL_LESS_END_EXTEND_MM,
} from './elevationStyle.js';
import { screenMmToModelMm, horizontalDimLabelBox } from './elevationLayout.js';
import { clipContentAtHiddenEnds } from './elevationStairSequence.js';
import { DEFAULT_PX_PER_MM } from '../viewport.js';

function makeFace(overrides = {}) {
  return {
    axisCL: AXIS_Y0, isVertical: false, inward: 1, faceValue: 0,
    lo: 0, hi: 4000, run: 4000, dirSign: 1, originWorld: 0,
    startCLId: 'x0', endCLId: 'x1',
    ...overrides,
  };
}

// 面の軸CL実体。腰壁レコードの軸照合は id ではなく「通り（向き＋座標）」で行う
// （finish/kneeDropWall.js の sameAxisLine）ため、合成graphにも実体を置く必要がある。
const AXIS_Y0 = { id: 'axisY0', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 0, value: 0 };

function makeGraph({ openings = [], kneeDropWalls = new Map(), shapes = new Map() } = {}) {
  const shapeMap = new Map(shapes);
  if (!shapeMap.has(AXIS_Y0.id)) shapeMap.set(AXIS_Y0.id, AXIS_Y0);
  return { openings, kneeDropWalls, shapeMap };
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

// ---- 項目3: 材名の展開図表示用言い換え（表示専用。マスターデータは変更しない） ----
test('formatMaterialLabel: 「せっこうボード」→「PB」、「t=<数値>」→「ア)<数値>」に変換する', () => {
  // 各パターンを独立に置換するだけ（トークン間の空白はそのまま保持される）。
  assert.equal(formatMaterialLabel('せっこうボード t=12.5'), 'PB ア)12.5');
  assert.equal(formatMaterialLabel('強化せっこうボード t=15'), '強化PB ア)15');
  assert.equal(formatMaterialLabel('RC壁 t=150'), 'RC壁 ア)150');
});

// ---- 失敗系: 対象パターンを含まない材名・非文字列はそのまま（変換対象が無ければ何もしない） ----
test('【失敗系】formatMaterialLabel: t=表記もせっこうボードも含まない材名はそのまま返す', () => {
  assert.equal(formatMaterialLabel('ラワン合板'), 'ラワン合板');
  assert.equal(formatMaterialLabel(null), null);
  assert.equal(formatMaterialLabel(undefined), undefined);
});

// ---- 項目4: 障害物区間を避けた最広ギャップへの退避 ----
test('avoidObstacleRangesX: 既定xが障害物と重なれば、障害物区間を併合した最も広い空き区間の中心へ退避する', () => {
  const boundary = { lo: 0, hi: 4000 };
  // 既定x=2000(中心)が障害物[1800,2200]と重なる。空き区間は[0,1800](幅1800)と[2200,4000](幅1800)で
  // 同点——avoidGridCollisionXと同じ「先に見つかった方」規則で[0,1800]の中心=900になるはず。
  const obstacles = [{ lo: 1800, hi: 2200 }];
  assert.equal(avoidObstacleRangesX(2000, obstacles, boundary, 100), 900);
});

test('avoidObstacleRangesX: 複数の重なる障害物は併合してから空き区間を探す', () => {
  const boundary = { lo: 0, hi: 4000 };
  // 障害物[1500,2200]と[2100,2600]は重なるため併合され[1500,2600]になる。既定x=2000はこれと重なる。
  // 空き区間は[0,1500](幅1500)と[2600,4000](幅1400)——広い方[0,1500]の中心=750。
  const obstacles = [{ lo: 1500, hi: 2200 }, { lo: 2100, hi: 2600 }];
  assert.equal(avoidObstacleRangesX(2000, obstacles, boundary, 100), 750);
});

// ---- 失敗系: 既定xが障害物と重ならなければ動かさない ----
test('【失敗系】avoidObstacleRangesX: 既定xが障害物と重ならなければ既定xのまま返す', () => {
  const boundary = { lo: 0, hi: 4000 };
  const obstacles = [{ lo: 0, hi: 500 }, { lo: 3500, hi: 4000 }];
  assert.equal(avoidObstacleRangesX(2000, obstacles, boundary, 100), 2000);
});

// ---- 失敗系: 障害物が空なら常に既定xのまま ----
test('【失敗系】avoidObstacleRangesX: 障害物が空なら常に既定xを返す', () => {
  assert.equal(avoidObstacleRangesX(2000, [], { lo: 0, hi: 4000 }, 100), 2000);
});

// ---- CUT/SILHOUETTE本数（床1天井1=CUT2本、出隅の両端縦線2本=SILHOUETTE） ----
// QA修正(5a): 出隅（壁がある通常の面端）の縦線はCUT(太)ではなくSILHOUETTE(中線)で描く
// （切断面ではなく、壁が折れて隣の面へ続くだけの見えがかりの角のため）。
test('buildFaceFigure: 床線・天井線に加え、壁のある両端の縦線もCUT(太)＝壁断面で出る', () => {
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx());
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');
  assert.equal(cutLines.length, 4, '床線・天井線・両端の壁断面の縦線で4本のはず');
  assert.equal(silhouetteLines.length, 0, '仮想断面を横切る壁がある端は中線では描かないはず');
});

// ---- 項目1・2・QA修正(5a): 壁のない端部（hasWallAtLocal0/Run=false）は床線・天井線を延長し
// 端の縦線は描かない。壁がある端（出隅）は縦線をSILHOUETTE(中線)で描く ----
test('【項目1】buildFaceFigure: hasWallAtLocal0=falseの面は左端の縦線を描かず、床線・天井線がx=-extendMmまで延長される', () => {
  const face = makeFace({ hasWallAtLocal0: false, hasWallAtLocalRun: true });
  const ctx = baseCtx({ wallLessEndExtendModelMm: 200 });
  const prims = buildFaceFigure(face, ctx);
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');

  assert.equal(cutLines.length, 3, '床線・天井線・右端の壁断面の縦線で3本のはず');
  assert.equal(silhouetteLines.length, 0, '壁のある端は壁断面(太線)で描くはず');
  assert.ok(!cutLines.some(l => l.x1 === 0 && l.x2 === 0), '左端(x=0)の縦線は描かないはず');
  assert.ok(cutLines.some(l => l.x1 === face.run && l.x2 === face.run), '右端(x=run)の縦線は残るはず');
  const floorLine = cutLines.find(l => l.y1 === l.y2 && l.y1 === 0);
  const ceilLine  = cutLines.find(l => l.y1 === l.y2 && l.y1 === -2400);
  assert.equal(floorLine.x1, -200, '床線の左端はx=-extendMm(-200)まで延長されるはず');
  assert.equal(ceilLine.x1, -200, '天井線の左端はx=-extendMm(-200)まで延長されるはず');
  assert.equal(floorLine.x2, face.run, '床線の右端は壁があるためrunのまま');
  assert.equal(ceilLine.x2, face.run, '天井線の右端は壁があるためrunのまま');
});

test('【項目1】buildFaceFigure: hasWallAtLocalRun=falseの面は右端の縦線を描かず、床線・天井線がx=run+extendMmまで延長される', () => {
  const face = makeFace({ hasWallAtLocal0: true, hasWallAtLocalRun: false });
  const ctx = baseCtx({ wallLessEndExtendModelMm: 200 });
  const prims = buildFaceFigure(face, ctx);
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');

  assert.equal(cutLines.length, 3);
  assert.equal(silhouetteLines.length, 0);
  assert.ok(!cutLines.some(l => l.x1 === face.run && l.x2 === face.run), '右端の縦線は描かないはず');
  assert.ok(cutLines.some(l => l.x1 === 0 && l.x2 === 0), '左端の縦線は残るはず');
  const floorLine = cutLines.find(l => l.y1 === l.y2 && l.y1 === 0);
  assert.equal(floorLine.x2, face.run + 200, '床線の右端はx=run+extendMmまで延長されるはず');
});

test('【項目1】buildFaceFigure: 両端とも壁が無い面は縦線が0本、床線・天井線が両側とも延長される', () => {
  const face = makeFace({ hasWallAtLocal0: false, hasWallAtLocalRun: false });
  const ctx = baseCtx({ wallLessEndExtendModelMm: 200 });
  const prims = buildFaceFigure(face, ctx);
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');

  assert.equal(cutLines.length, 2, '床線・天井線の2本だけのはず');
  assert.equal(silhouetteLines.length, 0, '縦線は0本のはず');
  const floorLine = cutLines.find(l => l.y1 === l.y2 && l.y1 === 0);
  assert.equal(floorLine.x1, -200);
  assert.equal(floorLine.x2, face.run + 200);
});

// ---- WP-E7 defer D2: ctx.floorSpanXで床線・天井線の描画範囲をクランプする ----
test('【WP-E7・D2】buildFaceFigure: floorSpanX指定時は床線・天井線・端点のceilAbsAtXクランプがMath.max/minで打ち切られる', () => {
  const face = makeFace({ hasWallAtLocal0: false, hasWallAtLocalRun: false });
  const ctx = baseCtx({ wallLessEndExtendModelMm: 200, floorSpanX: { lo: -50, hi: 3900 } });
  const prims = buildFaceFigure(face, ctx);
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const floorLine = cutLines.find(l => l.y1 === l.y2 && l.y1 === 0);
  const ceilLine  = cutLines.find(l => l.y1 === l.y2 && l.y1 === -2400);
  // 壁のない端部延長は-200/+200(face.run+200=4200)まで届くはずだが、floorSpanXの
  // [-50,3900]でMath.max/minクランプされ、それより内側で打ち切られる。
  assert.equal(floorLine.x1, -50, '床線の左端はfloorSpanX.loで打ち切られるはず（延長分の-200より内側）');
  assert.equal(floorLine.x2, 3900, '床線の右端はfloorSpanX.hiで打ち切られるはず（延長分の4200より内側）');
  assert.equal(ceilLine.x1, -50);
  assert.equal(ceilLine.x2, 3900);
});

test('【失敗系・WP-E7・D2】buildFaceFigure: floorSpanX省略時は現行のdrawnX0/drawnXRun（壁のない端部延長込み）と完全一致する', () => {
  const face = makeFace({ hasWallAtLocal0: false, hasWallAtLocalRun: false });
  const ctxBase = baseCtx({ wallLessEndExtendModelMm: 200 });
  const baseline = buildFaceFigure(face, ctxBase);
  // floorSpanXが自然範囲(-200..face.run+200)を覆っていれば、指定してもMath.max/minが素通りし
  // 省略時と完全一致するはず（WP-G0ゲート＝通常部屋帯・吹抜け帯は無指定なので出力不変の担保）。
  const withWideSpan = buildFaceFigure(face, { ...ctxBase, floorSpanX: { lo: -200, hi: face.run + 200 } });
  assert.deepEqual(withWideSpan, baseline);
});

// ---- 失敗系: wallLessEndExtendModelMm省略時はDEFAULT_WALL_LESS_END_EXTEND_MMへフォールバックする ----
test('【失敗系・項目1】buildFaceFigure: wallLessEndExtendModelMm省略時はDEFAULT_WALL_LESS_END_EXTEND_MMを使う', () => {
  const face = makeFace({ hasWallAtLocal0: false });
  const prims = buildFaceFigure(face, baseCtx());
  const floorLine = prims.find(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 === 0);
  assert.equal(floorLine.x1, -DEFAULT_WALL_LESS_END_EXTEND_MM);
});

// ---- 失敗系: hasWallAtLocal0/Run省略時（フィールド自体が無い）はtrue扱いで従来どおり ----
test('【失敗系・項目1】buildFaceFigure: faceにhasWallAtLocal0/hasWallAtLocalRunが無ければtrue扱い（従来どおり）', () => {
  const face = makeFace(); // hasWallAtLocal0/hasWallAtLocalRun未設定
  const prims = buildFaceFigure(face, baseCtx({ wallLessEndExtendModelMm: 200 }));
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');
  assert.equal(cutLines.length, 4, 'face側にフィールドが無ければ壁あり扱い＝床線・天井線＋両端の壁断面で4本のはず');
  assert.equal(silhouetteLines.length, 0, '壁のある端は壁断面(太線)で描くはず');
});

// ---- QA修正（実グラフでの発動確認）: buildRoomFaces由来の実faceでも続き表現が出る ----
// このファイルは通常フェイクgraph/roomを使う方針だが、この1件だけは実Plane/PlanGraph+
// 実finish/wallGeneration.jsを使う（elevationFaces.test.js/elevationBand.test.jsと同じ方針）
// ——hasWallAtLocal0/Runが実グラフで実際にfalseになる経路（stairOpeningsによる壁生成スキップ）を
// 経由したface自体を使わないと、「実アプリで発動するか」を検証したことにならないため。
test('【QA修正】buildFaceFigure: 実グラフの上り口辺（壁生成スキップ）由来のfaceは続き表現（延長・端縦線省略）が実際に出る', () => {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  const addCL = (type, value) => graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
  const x0 = addCL(CenterLineType.VERTICAL, 0);
  const x1 = addCL(CenterLineType.VERTICAL, 4000);
  const y0 = addCL(CenterLineType.HORIZONTAL, 0);
  const y1 = addCL(CenterLineType.HORIZONTAL, 3000);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'かいだん');
  // A面（上辺）を階段の上り口相当としてstairOpenings指定し、壁生成をスキップさせる
  // （finish/finishBoundary.jsが実際のStairに対して行うのと同じ入力形。onStairOpening参照）。
  const stairOpenings = [{ isVertical: false, value: y0.effectiveValue, lo: -1, hi: 4001 }];
  generateRoomWallsFromOutline(graph, room, {}, stairOpenings);

  const faces = realBuildRoomFaces(room, graph);
  const faceD = faces.find(f => f.label === 'D'); // D面の終端(hasWallAtLocalRun)がA隅＝壁なし
  assert.equal(faceD.hasWallAtLocalRun, false, '前提: D面の終端は壁なしのはず（QA修正の発動確認）');

  const prims = buildFaceFigure(faceD, {
    graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: 2400,
    materialMap: null, gridCLs: [], wallLessEndExtendModelMm: 150,
  });
  // 壁のある端（仮想断面を横切る＝壁断面がある）の縦線はCUT(太線)で描く。
  const cutVerticals = prims.filter(p => p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2);
  assert.equal(cutVerticals.length, 1, '壁なし側(run側)の縦線は描かれず、壁あり側(0側)の1本だけのはず');
  assert.equal(cutVerticals[0].x1, 0, '残る縦線は壁のある0側のはず');
  const floorLine = prims.find(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 === 0);
  assert.equal(floorLine.x2, faceD.run + 150, '床線はrunを超えてextendMm(150)ぶん外側へ延長されるはず');
});

// ---- QA修正（項目1・3。項目2と同根）: 出隅の見えがかり縦線(SILHOUETTE)は、隅を挟む区間の
// 「実際の床高さ」を正確に参照する。隅（出隅）に部分指定の床段差の境界が重なる実グラフで検証する
// （elevationFloorProfile.test.jsのwallAdjacentFloorSegments単体テストで直した「極小区間の
// 抽出不良」が、この出隅縦線のY座標（floorYAtStart/floorYAtEnd=segs[0]/segs[末尾]）にも
// そのまま影響するため、根っこは同じ関数の不具合だった）。 ----
test('【QA修正・項目1/3】buildFaceFigure: 出隅の縦線は、その隅に接する床区間の実際の高さ(floorDeltaMm)まで届く', () => {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  const addCL = (type, value) => graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
  const x0 = addCL(CenterLineType.VERTICAL, 0);
  const x1 = addCL(CenterLineType.VERTICAL, 2000);
  const x2 = addCL(CenterLineType.VERTICAL, 4000);
  const y0 = addCL(CenterLineType.HORIZONTAL, 0);
  const y1 = addCL(CenterLineType.HORIZONTAL, 3000);
  const cornerCell = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`; // A面・D面が共有する左上の角セル
  const otherCell  = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`;
  const room = graph.addRoom(new Set([cornerCell, otherCell]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([cornerCell]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const faces = realBuildRoomFaces(room, graph);
  const faceA = faces.find(f => f.label === 'A');
  const faceD = faces.find(f => f.label === 'D');
  const segsA = wallAdjacentFloorSegments(faceA, room, graph);
  const segsD = wallAdjacentFloorSegments(faceD, room, graph);

  const ctxBase = { graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: 2400, materialMap: null, gridCLs: [] };
  const primsA = buildFaceFigure(faceA, { ...ctxBase, floorSegments: segsA });
  const primsD = buildFaceFigure(faceD, { ...ctxBase, floorSegments: segsD });

  // A面のD側(x=0)・D面のA側(x=0)は同じ物理的な隅を指すため、どちらの縦線もy2=-300（子の床高さ）
  // まで届くはず——中心線を挟んで床高が変わる出隅で、実際の高さを正確に参照できているかの確認。
  const cornerVertA = primsA.find(p => p.type === 'line' && p.weight === 'thick' && p.x1 === 0 && p.x2 === 0);
  const cornerVertD = primsD.find(p => p.type === 'line' && p.weight === 'thick' && p.x1 === 0 && p.x2 === 0);
  assert.ok(cornerVertA && cornerVertD, '両面ともx=0の隅の縦線（壁断面）が見つかるはず');
  assert.equal(cornerVertA.y2, -300, 'A面の出隅縦線は子の床高さ(-300)まで届くはず');
  assert.equal(cornerVertD.y2, -300, 'D面の出隅縦線も同じ隅なので子の床高さ(-300)まで届くはず（両面で一致）');
});

// ---- 項目4: floorSegmentsが段差を含む場合、床線は区間ごとの水平線＋段差の縦線になる ----
// 新仕様「段差位置のCLオフセット」: 内部境界（区間水平線の端x・段差縦線x）は寸法・CL位置
// （segs[i].hiX=2000そのまま）ではなく、床が低い側（floorDeltaMmが小さい側＝この例ではseg0の
// x<2000側）へ半壁厚(halfWallThicknessMm)だけずらした位置に描く。makeFace()はfaceValue=0・
// axisCLにeffectiveValueが無いためhalfWallThicknessMmはDEFAULT_HALF_WALL_MM=57.5mmへ
// フォールバックする——riserXは2000-57.5=1942.5になる（elevation-model.md参照）。
const RISER_X_OFFSET_TESTS = 1942.5;

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
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');
  // 天井線1・床の水平線2（区間ごと）・段差縦線1・両端の壁断面の縦線2 = 計6本のCUT。
  assert.equal(cutLines.length, 6, `CUT線は6本のはず（実際:${cutLines.length}）`);
  assert.equal(silhouetteLines.length, 0, '壁のある端は壁断面(太線)で描くはず');

  const floorHorizontals = cutLines.filter(l => l.y1 === l.y2);
  assert.equal(floorHorizontals.length, 3, '天井線1本+床の水平線2本=3本の水平CUT線のはず');
  const seg0 = floorHorizontals.find(l => l.x1 === 0 && l.x2 === RISER_X_OFFSET_TESTS);
  const seg1 = floorHorizontals.find(l => l.x1 === RISER_X_OFFSET_TESTS && l.x2 === 4000);
  assert.ok(seg0 && seg1, '両区間の水平線がそれぞれ見つかるはず（境界は新仕様のオフセット後の位置）');
  assert.equal(seg0.y1, 0, '左区間(floorDeltaMm:0)はy=0のまま');
  assert.equal(seg1.y1, -300, '右区間(floorDeltaMm:300)はy=-300へ上がるはず');

  // 段差の縦線（オフセット後のx=1942.5でy=0→y=-300）。
  const riser = cutLines.find(l => l.x1 === RISER_X_OFFSET_TESTS && l.x2 === RISER_X_OFFSET_TESTS && l.y1 === 0 && l.y2 === -300);
  assert.ok(riser, '段差の縦線(x=1942.5, y:0→-300)が見つかるはず');
  assert.equal(riser.weight, 'thick', '段差の縦線もCUTのはず');

  // 段差の寸法線・寸法値は描かない（明示指示）。
  assert.ok(!prims.some(p => p.type === 'dim' && p.at === RISER_X_OFFSET_TESTS), '段差位置の寸法は描かないはず');

  // 両端の縦線（x=0とx=run=4000。壁断面=CUT）は、その位置の区間の床yまで伸びる
  // （面の外端はriserXAtの対象外＝オフセットの影響を受けない）。
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

// ---- floorSegments[].flatLineSpanX: 区間の床線を実体のある範囲だけに切り詰める
// （階段のレーン区間は床が階段そのもので、1FLの水平線は階段断面に出会うところで終わる。
// ユーザー実機指摘2026-09「「6」D1: 下りた階段の先（左側）に1FL断面はり出しが正解」）----
test('buildFaceFigure: floorSegments[].flatLineSpanXは区間の床線をその範囲へ切り詰める（はり出しは残る）', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, flatLineSpanX: { hi: 30 } },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const face = makeFace();
  const ctx = baseCtx({ ceilingHeight: CH, floorSegments });
  const prims = buildFaceFigure(face, ctx);

  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const floorHorizontals = cutLines.filter(l => l.y1 === l.y2 && l.y1 !== -CH);
  assert.equal(floorHorizontals.length, 2, '切り詰めた区間の床線も（範囲が残る限り）描かれるはず');
  const clipped = floorHorizontals.find(l => l.y1 === 0);
  assert.ok(clipped, '切り詰めた区間の床線が1本あるはず');
  assert.equal(clipped.x2, 30, '床線はflatLineSpanX.hiで終わるはず');

  // 床線が段差の境界まで届かない区間の段差縦線は描かない（そこに段差は無い）。
  const riser = cutLines.find(l => l.x1 === RISER_X_OFFSET_TESTS && l.x2 === RISER_X_OFFSET_TESTS && l.y1 === 0 && l.y2 === -300);
  assert.ok(!riser, '床線が境界まで来ていない区間の段差縦線は描かれないはず');

  // 両端縦線（壁断面。CUT）は影響を受けない。
  const leftEnd = cutLines.find(l => l.x1 === 0 && l.x2 === 0);
  assert.ok(leftEnd, '左端の縦線はflatLineSpanXの影響を受けず描かれるはず');
  assert.equal(leftEnd.y2, 0, '左端縦線は自身の区間の床y(0)まで届くはず');
});

test('【失敗系】buildFaceFigure: flatLineSpanXが区間と交わらなければその区間の床線も段差縦線も描かない', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, flatLineSpanX: { hi: -9999 } },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const prims = buildFaceFigure(makeFace(), baseCtx({ ceilingHeight: CH, floorSegments }));
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const floorHorizontals = cutLines.filter(l => l.y1 === l.y2 && l.y1 !== -CH);
  assert.equal(floorHorizontals.length, 1, '空になった区間の床線は描かれず、残る区間の1本だけのはず');
  assert.equal(floorHorizontals[0].x1, RISER_X_OFFSET_TESTS, '残った床線は段差位置(オフセット後)から始まるはず');
  assert.equal(floorHorizontals[0].x2, 4000);
  assert.ok(!cutLines.some(l => l.x1 === RISER_X_OFFSET_TESTS && l.x2 === RISER_X_OFFSET_TESTS && l.y1 === 0),
    '片側の床線が無い境界に段差縦線は描かれないはず');
});

test('【失敗系】buildFaceFigure: flatLineSpanX未指定(既定)は従来どおり全区間の床線と段差縦線を描く', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const floorHorizontals = cutLines.filter(l => l.y1 === l.y2 && l.y1 !== -CH);
  assert.equal(floorHorizontals.length, 2, 'flatLineSpanX未指定なら両区間とも床線が描かれるはず（既存挙動）');
  assert.ok(cutLines.some(l => l.x1 === RISER_X_OFFSET_TESTS && l.x2 === RISER_X_OFFSET_TESTS && l.y1 === 0 && l.y2 === -300),
    '段差縦線も従来どおり描かれるはず');
});

// ---- 項目5: 床に段差がある面は右側にもCH寸法を描く（値=右端区間の実効CH） ----
test('【項目5】buildFaceFigure: floorSegmentsが2区間（段差あり）なら右側にもCH寸法が出て、値は天井絶対高−右端区間FL', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const face = makeFace();
  const ctx = baseCtx({ ceilingHeight: CH, floorSegments });
  const prims = buildFaceFigure(face, ctx);

  const vDims = prims.filter(p => p.type === 'dim' && p.dir === 'v');
  assert.equal(vDims.length, 1, '左のCH寸法は帯レベル(elevationBand.js)で付くため、face単体では右のCH寸法1本だけのはず');
  const rightChDim = vDims[0];
  assert.equal(rightChDim.label, CH - 300, '値は天井絶対高(2400)−右端区間FL(300)=2100のはず');
  assert.equal(rightChDim.from, -CH, '天井から');
  assert.equal(rightChDim.to, -300, '右端区間の床y(-300)まで');
  assert.equal(rightChDim.dot, true, '左のCH寸法と同じ様式（端部塗り丸）のはず');
  assert.ok(rightChDim.at > face.run, '右側（面の右端より外側）に配置されるはず');
});

// ---- 失敗系: floorSegmentsが1区間（段差なし）なら右側のCH寸法は出さない ----
test('【失敗系・項目5】buildFaceFigure: floorSegmentsが1区間（段差なし）なら右側のCH寸法は出さない', () => {
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx());
  const vDims = prims.filter(p => p.type === 'dim' && p.dir === 'v');
  assert.equal(vDims.length, 0, '段差が無ければ右側のCH寸法は出ないはず');
});

// ---- 問題修正2026-08その6: segEndProfileは素の端区間（描かれるままの先頭/末尾）を読む ----
// 実機修正: 入隅の面端に挟まる半壁厚程度のgap-fill区間も実際に床として描かれる——
// 「B1の右側の床は1FL+100」（=右端の親スリバーの床）と次の面の左端の床の不一致こそが
// 継ぎ目＝CH寸法を出す箇所のため、読み飛ばさない（一時導入した幅閾値方式は撤回）。
test('segEndProfile: 素の先頭/末尾区間（入隅スリバー含む）の床・天井を返す', () => {
  const segs = [
    { loX: 0,   hiX: 57.5, floorDeltaMm: 0,    chMm: 2400 }, // 入隅スリバー（描かれる実床）
    { loX: 57.5, hiX: 4000, floorDeltaMm: -100, chMm: 2400 },
  ];
  assert.deepEqual(segEndProfile(segs, 2400, 'first'), { floorDeltaMm: 0, ceilAbsMm: 2400 },
    '先頭はスリバーであっても描かれるままの床・天井を返すはず');
  assert.deepEqual(segEndProfile(segs, 2400, 'last'), { floorDeltaMm: -100, ceilAbsMm: 2300 });
  assert.equal(segEndProfile(undefined, 2400, 'first'), null, 'segs未指定はnull');
});

// ---- 問題修正2026-08その6: 段差見付け面の天井断面は低い側エリアの天井、向こう側の天井は破線 ----
// ユーザー明示指示（実機の「C1」=段差見付け面）: 3'の帯のC1=3の展開図。天井断面は3の天井
// （ceilAbsMm=2300→-2300）、その上+100に3'の天井を表す破線（beyondCeilAbsMm=2400→-2400）。
test('【問題修正2026-08その6】buildFaceFigure: 段差見付け面の天井断面はceilAbsMm（低い側の天井）に描かれ、beyondCeilAbsMm（高い側の天井）が細線の破線で出る', () => {
  const face = makeFace({
    kind: 'step', baseFloorDeltaMm: -100, stepHeightMm: 100,
    ceilAbsMm: 2300, beyondCeilAbsMm: 2400, run: 1200, hi: 1200,
  });
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: 2400 }));

  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const ceil = cutLines.find(l => l.y1 === l.y2 && l.y1 === -2300);
  assert.ok(ceil, '天井断面線は低い側エリアの天井(-2300)に描かれるはず');
  assert.ok(!cutLines.some(l => l.y1 === l.y2 && l.y1 === -2400), '帯CH(-2400)には天井断面を描かないはず');
  const leftEnd  = cutLines.find(l => l.x1 === 0    && l.x2 === 0);
  const rightEnd = cutLines.find(l => l.x1 === 1200 && l.x2 === 1200);
  assert.equal(leftEnd.y2, -2300, '両端縦線は低い側の天井まで');
  assert.equal(rightEnd.y2, -2300);

  const beyond = prims.find(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.y1 === p.y2 && p.y1 === -2400);
  assert.ok(beyond, '高い側（向こう側）の天井を表す細線の破線(y=-2400)が出るはず');
  assert.equal(beyond.x1, 0);
  assert.equal(beyond.x2, 1200);

  // アキ標記は矩形を持たない（ユーザー明示指示「矩形をやめて」）。範囲はバツ（対角2本）で見る。
  const diag = prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 !== p.x2);
  assert.equal(diag.length, 2, 'アキのバツ（対角2本）が出るはず');
  const ys = [...new Set(diag.flatMap(p => [p.y1, p.y2]))].sort((a, b) => a - b);
  assert.deepEqual(ys, [-2300, 0], 'アキは見付け上端(0)から低い側の天井(-2300)までのはず');
  assert.equal(prims.filter(p => p.type === 'rect').length, 0, 'アキの矩形は描かないはず');
});

// ---- 失敗系: ceilAbsMm未指定の段差見付け面（旧経路・合成face）は従来どおり帯CHの天井 ----
test('【失敗系・問題修正2026-08その6】buildFaceFigure: ceilAbsMm未指定の段差見付け面は従来どおり帯CH(-CH)の天井で破線も出ない', () => {
  const face = makeFace({ kind: 'step', baseFloorDeltaMm: 0, stepHeightMm: 100, run: 1200, hi: 1200 });
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: 2400 }));
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  assert.ok(cutLines.some(l => l.y1 === l.y2 && l.y1 === -2400), '天井断面は帯CH(-2400)のはず');
  assert.ok(!prims.some(p => p.type === 'line' && p.dash === 'dashed' && p.y1 === p.y2),
    'beyondCeilAbsMm未指定なら破線は出ないはず');
});

// ---- 問題修正2026-08その4改: 一様な別FL面のCH寸法は面の左側＝帯レイアウトの担当 ----
// ユーザー明示指示: 「B1の右側の床は+100、つづくC1の左側の床は+0。床の起点高さが変わるので、
// C1の左側に天井高さの寸法線が必要」——面単体（buildFaceFigure）は従来どおり段差のある面の
// 右CH寸法だけを描き、一様な別FL面の左CH寸法はelevationBand.jsのlayoutBandFaces
// （直前の面の右端との比較）が描く。
test('【問題修正2026-08その4改】buildFaceFigure: 一様な別FL区間の面は、面単体では右CH寸法を出さない（左CH寸法は帯レイアウトが担当）', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: -100, chMm: 2400 }];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));
  assert.equal(prims.filter(p => p.type === 'dim' && p.dir === 'v').length, 0,
    '段差の無い面は面単体では縦寸法を出さないはず（左CH寸法は帯レイアウト側）');
});

// ---- 失敗系: 一様で床・天井とも帯基準どおり（chMm=CH・FL同一）ならCH寸法は出さない ----
test('【失敗系・問題修正2026-08その4】buildFaceFigure: 唯一の区間の床・天井が帯基準と同じならCH寸法は出さない', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400 }];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));
  assert.equal(prims.filter(p => p.type === 'dim' && p.dir === 'v').length, 0,
    '帯基準どおりの面には従来どおりCH寸法を出さないはず');
});

// ---- 問題修正2026-08: 天井断面線は区間（エリア）ごとに「床断面から天井高さ(chMm)の距離」に描く ----
// CLをまたいで天井の絶対高さが異なる境界は段差＝縦線になり、その描画xは「低い方からみて
// CLの向こう側」＝天井が高い側へ半壁厚(makeFaceはDEFAULT_HALF_WALL_MM=57.5へフォールバック)
// ずらした位置（drawnCeilingRiserX。床のdrawnRiserX=低い側へ、と対になる規約）。
test('【問題修正2026-08】buildFaceFigure: chMmが異なる2区間（床は同一FL）は天井線が2本＋天井段差の縦線になり、床の段差縦線は出ない', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0, chMm: 2400 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 0, chMm: 2600 }, // 明示CH指定で天井だけ高いエリア
  ];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));

  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const ceilRiserX = 2000 + 57.5; // 低い方(左)からみてCLの向こう側＝天井が高い側(右)へ半壁厚
  const ceil0 = cutLines.find(l => l.y1 === l.y2 && l.y1 === -2400 && l.x1 === 0);
  const ceil1 = cutLines.find(l => l.y1 === l.y2 && l.y1 === -2600);
  assert.ok(ceil0, '左区間の天井線(y=-2400)が見つかるはず');
  assert.ok(ceil1, '右区間の天井線(y=-2600)が見つかるはず');
  assert.equal(ceil0.x2, ceilRiserX, '左区間の天井線は天井段差の描画x(2057.5)まで');
  assert.equal(ceil1.x1, ceilRiserX, '右区間の天井線は天井段差の描画xから');
  assert.equal(ceil1.x2, 4000, '右区間の天井線は面の右端まで');

  const ceilRiser = cutLines.find(l => l.x1 === ceilRiserX && l.x2 === ceilRiserX);
  assert.ok(ceilRiser, '天井段差の縦線が見つかるはず');
  assert.deepEqual([Math.min(ceilRiser.y1, ceilRiser.y2), Math.max(ceilRiser.y1, ceilRiser.y2)], [-2600, -2400],
    '天井段差の縦線は低い天井(-2400)と高い天井(-2600)を結ぶはず');

  // 床は同一FLのため、床の水平線は分割されても段差の縦線は出ない（y=0同士の長さ0の線を残さない）。
  assert.ok(!cutLines.some(l => l.x1 === l.x2 && l.y1 === 0 && l.y2 === 0), '床の段差縦線（長さ0）は出ないはず');

  // 両端の縦線（壁断面。CUT）はその端の区間の実際の天井まで届く。
  const leftEnd  = cutLines.find(l => l.x1 === 0 && l.x2 === 0);
  const rightEnd = cutLines.find(l => l.x1 === 4000 && l.x2 === 4000);
  assert.equal(leftEnd.y1, -2400, '左端の縦線は左区間の天井(-2400)から');
  assert.equal(rightEnd.y1, -2600, '右端の縦線は右区間の天井(-2600)から');

  // 右CH寸法は右端区間の実際の床〜天井（値=そのエリアのCH=2600）。
  const rightChDim = prims.find(p => p.type === 'dim' && p.dir === 'v');
  assert.ok(rightChDim, '区間が2つに分かれるため右CH寸法が出るはず');
  assert.equal(rightChDim.label, 2600, '値は右端区間の実際のCH(2600)のはず');
  assert.equal(rightChDim.from, -2600, '右端区間の天井から');
  assert.equal(rightChDim.to, 0, '右端区間の床まで');
});

test('【問題修正2026-08】buildFaceFigure: 床段差＋同一chMmの2区間は天井も段差になる（天井絶対高さ=FL+CHが変わるため）', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0,   chMm: 2400 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300, chMm: 2400 }, // 小上がりに明示CH2400（天井も+300）
  ];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));

  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  // 床の段差縦線は低い側(左)へ半壁厚=1942.5、天井の段差縦線は高い側(右)へ半壁厚=2057.5。
  assert.ok(cutLines.some(l => l.x1 === 1942.5 && l.x2 === 1942.5 && Math.min(l.y1, l.y2) === -300),
    '床の段差縦線(x=1942.5)が見つかるはず');
  const ceilRiser = cutLines.find(l => l.x1 === 2057.5 && l.x2 === 2057.5);
  assert.ok(ceilRiser, '天井の段差縦線(x=2057.5)が見つかるはず');
  assert.deepEqual([Math.min(ceilRiser.y1, ceilRiser.y2), Math.max(ceilRiser.y1, ceilRiser.y2)], [-2700, -2400],
    '天井は-2400から-2700(FL300+CH2400)へ上がるはず');
});

// ---- 問題修正2026-08その3: 天井断面より上の別エリアの天井（beyondCeilings）は細線の破線で描く ----
// ユーザー明示指示（「3'」のC1）: 親FL−100・CH2400の部分指定（天井絶対高さ2300）が壁際を占め、
// その向こうに親（天井2400）が実在する面では、天井断面(-2300)の上+100に「3'」の天井を表す
// 破線(-2400)が出る。「床断面より下・天井断面より上の向こう側の断面は細線の破線」（その2）の天井側。
test('【問題修正2026-08その3】buildFaceFigure: 天井断面より上の別エリアの天井（beyondCeilings）は細線の破線で描かれる', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: -100, chMm: 2400 }]; // 天井断面2300
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({
    ceilingHeight: CH, floorSegments,
    beyondCeilings: [{ loX: 0, hiX: 4000, ceilAbsMm: 2400 }], // 向こう側に親（天井2400）が実在
  }));

  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const ceilSection = cutLines.find(l => l.y1 === l.y2 && l.y1 === -2300);
  assert.ok(ceilSection, '天井断面線は区間の天井(-2300)に描かれるはず');

  const dashed = prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.y1 === p.y2 && p.y1 === -2400);
  assert.equal(dashed.length, 1, '親の天井を表す細線の破線(y=-2400)が1本見つかるはず');
  assert.equal(dashed[0].x1, 0, '破線は面の実範囲[0,run]（延長なし）のはず');
  assert.equal(dashed[0].x2, 4000);
});

// ---- 失敗系: beyondCeilings未指定、または断面と同じ高さ・断面より下のエリアには破線を描かない ----
// A1/B1/D2の誤検出（旧ヒューリスティック: 帯CH比較だけで面全域に線を引いていた）の門番——
// 当該エリアが向こう側に実在しない（beyondCeilingsに無い/断面と同じ高さしか無い）面には出ない。
test('【失敗系・問題修正2026-08その3】buildFaceFigure: beyondCeilingsが無い・断面と同高・断面より下のエリアには破線を描かない', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: -100, chMm: 2400 }]; // 天井断面2300
  const face = makeFace();
  const horizDashed = prims => prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.y1 === p.y2);

  // beyondCeilings未指定（旧実装は帯CH2400≠断面2300というだけで面全域に線を出していた）
  const prims1 = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));
  assert.equal(horizDashed(prims1).length, 0, 'beyondCeilings未指定なら破線は出ないはず');

  // 断面と同じ高さ(2300)・断面より下(2200)のエリアのみ → いずれも対象外
  const prims2 = buildFaceFigure(face, baseCtx({
    ceilingHeight: CH, floorSegments,
    beyondCeilings: [{ loX: 0, hiX: 4000, ceilAbsMm: 2300 }, { loX: 0, hiX: 4000, ceilAbsMm: 2200 }],
  }));
  assert.equal(horizDashed(prims2).length, 0, '断面と同高・断面より下のエリアには破線を描かないはず（明示指示の範囲外）');
});

// ---- 問題修正2026-08その2: 開放スパンの向こう側の天井線 ----
// ユーザー明示指示（「3'」のA2, 1200）: 開放先の天井が近側の天井断面より低ければ、床〜天井の間に
// 見える見えがかりとしてSILHOUETTE実線（中線）で描く。アキはfar天井までにクランプする。
test('【問題修正2026-08その2】buildFaceFigure: 開放先の天井が低い開放スパンは、far天井の見えがかり線（中線実線）が出る', () => {
  const CH = 2400;
  const face = makeFace({
    spans: [
      { loX: 0,    hiX: 2800, kind: 'wall' },
      { loX: 2800, hiX: 4000, kind: 'open', farFloorDeltaMm: -100, farCeilAbsMm: 2300 },
    ],
  });
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH }));

  // アキ標記から矩形を廃止した（ユーザー明示指示「矩形をやめて」）ため、far天井の見えがかり線は
  // 線primitiveとして描く（旧QA G2の「矩形の上辺が兼ねるので積まない」は撤回。抑止を残すと
  // この線が誰にも描かれない）。
  const farCeilLines = prims.filter(p =>
    p.type === 'line' && p.y1 === p.y2 && p.y1 === -2300 && p.x1 === 2800 && p.x2 === 4000);
  assert.equal(farCeilLines.length, 1, 'far天井の見えがかり線(y=-2300)が1本出るはず');
  assert.equal(farCeilLines[0].weight, 'medium', '床〜天井断面の間に見える向こう側の断面は中線');

  // アキ（バツ・「ア キ」）は2026-09に断面エンジンへ一本化（図側では描かない）。
  assert.deepEqual(prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 !== p.x2), [],
    'アキのバツは図側では描かないはず');
  assert.equal(prims.filter(p => p.type === 'rect').length, 0, 'アキの矩形は描かないはず');
});

// ---- 問題修正2026-08その2: 開放先の天井が高い場合は「天井断面より上の向こう側」＝細線の破線＋端部縦線 ----
test('【問題修正2026-08その2】buildFaceFigure: 開放先の天井が天井断面より高い開放スパンは、far天井線が細線の破線になり端部縦線（near天井〜far天井）を継ぎ足す', () => {
  const CH = 2400;
  const face = makeFace({
    spans: [
      { loX: 0,    hiX: 2800, kind: 'wall' },
      { loX: 2800, hiX: 4000, kind: 'open', farFloorDeltaMm: 0, farCeilAbsMm: 2600 },
    ],
  });
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH }));

  const farCeil = prims.find(p => p.type === 'line' && p.y1 === p.y2 && p.y1 === -2600);
  assert.ok(farCeil, 'far天井線(y=-2600)が見つかるはず');
  assert.equal(farCeil.weight, 'thin', '天井断面より上の向こう側の断面のため細線のはず');
  assert.equal(farCeil.dash, 'dashed', '破線のはず');

  // 端部縦線（far天井-2600〜near天井-2400。角=far天井側を始点にした細線の破線）が両端に出る。
  const edges = prims.filter(p =>
    p.type === 'line' && p.x1 === p.x2 && p.weight === 'thin' && p.dash === 'dashed' &&
    p.y1 === -2600 && p.y2 === -2400);
  assert.equal(edges.length, 2, `x=2800とx=4000の両端に縦線が出るはず（実際:${JSON.stringify(edges)}）`);
  assert.deepEqual(edges.map(e => e.x1).sort((a, b) => a - b), [2800, 4000]);

  // アキの上端（近側/遠側の天井の低い方）は断面エンジンの管轄になったため、ここでは
  // 図側がアキを描かないことだけを固定する（2026-09）。
  assert.deepEqual(prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 !== p.x2), [],
    'アキのバツは図側では描かないはず');
});

// ---- ユーザー実機指摘2026-08「6」C「1500の一点鎖線が出ていない」 ----
// 階段帯の往復間の壁は切断線から見て面の裏側へ伸びるため、直交壁の検出（室内側へ突出する袖壁が
// 対象）に掛からず一点鎖線の源が無かった。呼び出し側が明示指定できるctx.extraCenterLineXsを追加。
test('【実機指摘】buildFaceFigure: extraCenterLineXsの位置に一点鎖線を描き、寸法の鎖は分割しない', () => {
  const face = makeFace();
  const dimsOf = prims => prims.filter(p => p.type === 'dim' && p.dir === 'h')
    .map(p => [p.from, p.to]);
  const centersOf = prims => prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 === p.x2)
    .map(p => p.x1).sort((a, b) => a - b);

  const before = buildFaceFigure(face, baseCtx({}));
  const after = buildFaceFigure(face, baseCtx({ extraCenterLineXs: [1500] }));

  assert.ok(!centersOf(before).includes(1500), '前提: 既定では1500に一点鎖線は無い');
  assert.ok(centersOf(after).includes(1500), 'extraCenterLineXsの位置に一点鎖線が出るはず');
  assert.deepEqual(dimsOf(after), dimsOf(before), '寸法の鎖は変わらないはず（線だけ追加する）');
});

test('【失敗系・実機指摘】buildFaceFigure: 既に一点鎖線がある位置のextraCenterLineXsは重複して描かない', () => {
  const face = makeFace();
  const centersAt = (prims, x) => prims.filter(p =>
    p.type === 'line' && p.dash === 'center' && p.x1 === p.x2 && Math.abs(p.x1 - x) < 1e-6).length;
  const base = buildFaceFigure(face, baseCtx({}));
  const existing = base.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 === p.x2)[0];
  assert.ok(existing, '前提: 既定でも一点鎖線が1本はある');
  const dup = buildFaceFigure(face, baseCtx({ extraCenterLineXs: [existing.x1] }));
  assert.equal(centersAt(dup, existing.x1), centersAt(base, existing.x1), '同じ位置に2本目は出ないはず');
});

// ---- QA H1: bc破線が最上位の水平線になる面では、注記の一点鎖線がその上へ突き出す ----
test('【QA H1】buildFaceFigure: beyondCeilingsの破線より上へ注記の一点鎖線が突き出す', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2300 }];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({
    ceilingHeight: CH, floorSegments,
    beyondCeilings: [{ loX: 0, hiX: 4000, ceilAbsMm: 2800 }], // 奥のエリアの高い天井
  }));

  const centerLines = prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 === p.x2);
  assert.ok(centerLines.length > 0, '壁中心線の一点鎖線があるはず');
  for (const l of centerLines) {
    assert.equal(l.y1, -2800 - GRID_LINE_ABOVE_CH_MM,
      `一点鎖線はbc破線(-2800)より上へ突き出すはず（実際:${l.y1}）`);
  }
});

// ---- QA H2: 天井が同じで床だけ違う隣接区間の上では、bc破線が1本に結合される（破線位相の分割防止） ----
test('【QA H2】buildFaceFigure: 天井が同じで床だけ違う隣接区間の上では、beyondCeilingsの破線が1本に結合される', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0,    chMm: 2400 }, // 天井絶対高さ2400
    { loX: 2000, hiX: 4000, floorDeltaMm: -200, chMm: 2600 }, // 天井絶対高さ2400（床だけ違う）
  ];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({
    ceilingHeight: CH, floorSegments,
    beyondCeilings: [{ loX: 0, hiX: 4000, ceilAbsMm: 2800 }],
  }));

  const dashed = prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.y1 === p.y2 && p.y1 === -2800);
  assert.equal(dashed.length, 1, `座標が連続する断片は1本にマージされるはず（実際:${JSON.stringify(dashed)}）`);
  assert.equal(dashed[0].x1, 0);
  assert.equal(dashed[0].x2, 4000);
});

// ---- QA H3: 開放スパンの向こう側にさらに高いファミリー天井があれば、開放スパン上にも描く ----
test('【失敗系・QA H3】buildFaceFigure: 開放スパンで差し引くのは同じ高さのfar天井線だけで、さらに高いbcの破線は開放スパン上にも描かれる', () => {
  const CH = 2400;
  const face = makeFace({
    spans: [
      { loX: 0,    hiX: 2800, kind: 'wall' },
      { loX: 2800, hiX: 4000, kind: 'open', farFloorDeltaMm: 0, farCeilAbsMm: 2600 },
    ],
  });
  const prims = buildFaceFigure(face, baseCtx({
    ceilingHeight: CH,
    beyondCeilings: [
      { loX: 2800, hiX: 4000, ceilAbsMm: 2600 }, // 開放先セル自身の天井＝far天井線と同高（差し引かれる）
      { loX: 0,    hiX: 4000, ceilAbsMm: 2800 }, // さらに奥の高い天井＝開放スパン上にも描く
    ],
  }));

  const at2600 = prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.y1 === p.y2 && p.y1 === -2600);
  assert.equal(at2600.length, 1, '-2600はfar天井線の1本だけ（bc側は差し引かれ二重にならない）はず');
  assert.equal(at2600[0].x1, 2800);
  assert.equal(at2600[0].x2, 4000);

  const at2800 = prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.y1 === p.y2 && p.y1 === -2800);
  assert.equal(at2800.length, 1, '-2800のbc破線は開放スパンに差し引かれず面全域の1本のはず');
  assert.equal(at2800[0].x1, 0);
  assert.equal(at2800[0].x2, 4000);
});

// ---- QA G1改: 開放スパン区間はfar天井線の管轄のため、beyondCeilingsの破線から差し引く ----
test('【QA G1】buildFaceFigure: beyondCeilingsの破線は開放スパン区間を差し引いた壁区間だけに引かれ、far天井線と二重にならない', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2300 }]; // 近側の天井2300(<CH)
  const face = makeFace({
    spans: [
      { loX: 0,    hiX: 2800, kind: 'wall' },
      { loX: 2800, hiX: 4000, kind: 'open', farFloorDeltaMm: 0, farCeilAbsMm: 2400 }, // 開放先=親の天井
    ],
  });
  const prims = buildFaceFigure(face, baseCtx({
    ceilingHeight: CH, floorSegments,
    beyondCeilings: [{ loX: 0, hiX: 4000, ceilAbsMm: 2400 }],
  }));

  const thinDashed = prims.filter(p =>
    p.type === 'line' && p.y1 === p.y2 && p.y1 === -2400 && p.weight === 'thin' && p.dash === 'dashed');
  assert.equal(thinDashed.length, 2, `壁区間(beyond)とopen区間(far天井線)で別々の1本ずつ＝計2本のはず（実際:${JSON.stringify(thinDashed)}）`);
  const sorted = [...thinDashed].sort((a, b) => a.x1 - b.x1);
  assert.equal(sorted[0].x1, 0);
  assert.equal(sorted[0].x2, 2800, 'beyondの破線は開放スパンの手前(2800)で止まるはず（同区間の二重描画をしない）');
  assert.equal(sorted[1].x1, 2800, 'open区間はfar天井線が担うはず');
  assert.equal(sorted[1].x2, 4000);
});

// ---- QA G3: 区間天井が帯CHより低い面でも、注記一点鎖線は見えがかり線(-CH)より上へ突き出す ----
test('【QA G3】buildFaceFigure: 区間の天井が帯CHより低くても、注記の一点鎖線は帯CH（見えがかり線の高さ）より上へ突き出す', () => {
  const CH = 2500;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2200 }];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));

  const centerLines = prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 === p.x2);
  assert.ok(centerLines.length > 0, '壁中心線の一点鎖線があるはず');
  for (const l of centerLines) {
    assert.equal(l.y1, -CH - GRID_LINE_ABOVE_CH_MM,
      `一点鎖線の上端は帯CH基準(-CH-GRID_LINE_ABOVE_CH_MM=${-CH - GRID_LINE_ABOVE_CH_MM})のはず（実際:${l.y1}）`);
  }
});

// ---- 天井段差のある複数runで、beyondCeilingsの破線は「断面より上」になるrunの範囲だけに引かれCUT天井と重ならない ----
test('buildFaceFigure: 天井段差のある複数runでは、beyondCeilingsの破線は天井断面がそれより低いrunの範囲だけに引かれる', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0, chMm: 2300 }, // 天井断面2300（破線の対象）
    { loX: 2000, hiX: 4000, floorDeltaMm: 0, chMm: 2400 }, // 天井断面2400（同高＝対象外）
  ];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({
    ceilingHeight: CH, floorSegments,
    beyondCeilings: [{ loX: 0, hiX: 4000, ceilAbsMm: 2400 }],
  }));

  // 天井段差の描画x: 高い側(右)へ半壁厚 → 2000+57.5。
  const dashedAt2400 = prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.y1 === p.y2 && p.y1 === -2400);
  assert.equal(dashedAt2400.length, 1, '破線は左run（断面2300）の範囲だけのはず');
  assert.equal(dashedAt2400[0].x1, 0);
  // 論理境界(2000)で止める——描画済みrun範囲（段差x=2057.5）基準にすると、bcの論理境界と
  // 一致する面で半壁厚ぶんの偽スリバーが生じるため（実装コメント参照）。
  assert.equal(dashedAt2400[0].x2, 2000, '破線は論理境界(2000)まで＝右runのCUT天井(-2400)と重ならないはず');
});

// ---- 失敗系: 自CH指定なしの部分指定（roomCeilingHeightの調整でchMm=親CH−FL差）は天井が水平1本のまま ----
test('【失敗系・問題修正2026-08】buildFaceFigure: 天井絶対高さが揃う2区間（chMm=親CH−FL差）は天井線1本のままで天井段差は出ない', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0,   chMm: 2400 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300, chMm: 2100 }, // 自CH指定なし→親と天井が揃う
  ];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));

  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const ceilLines = cutLines.filter(l => l.y1 === l.y2 && l.y1 === -2400);
  assert.equal(ceilLines.length, 1, '天井絶対高さが同じなら天井線は1本に結合されるはず');
  assert.equal(ceilLines[0].x1, 0);
  assert.equal(ceilLines[0].x2, 4000);
  // CUT線は天井1＋床2＋床段差縦線1＋両端の壁断面2の計6本（天井段差の縦線は出ない）。
  assert.equal(cutLines.length, 6, `天井段差の縦線は出ないはず（実際:${JSON.stringify(cutLines)}）`);
});

// ---- 項目3・4: 壁2段書き（材名の言い換え・配置・省略） ----
test('【項目3・4】buildFaceFigure: 壁2段書きは材名を言い換えて描画し、既定では面の壁中心線区間の中心に置かれる', () => {
  const room = makeRoom({ wallMaterial: 'm1', wallFinish: 'm2' });
  const materialMap = new Map([
    ['m1', { name: 'せっこうボード t=12.5' }],
    ['m2', { name: 'ビニルクロス' }],
  ]);
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ room, materialMap }));
  const texts = prims.filter(p => p.type === 'text' && p.anchor === 'middle' &&
    (p.text === '壁：PB ア)12.5' || p.text === 'ビニルクロス'));
  assert.equal(texts.length, 2, '2段とも材名変換済みで描かれるはず');
  for (const t of texts) assert.equal(t.x, 2000, '既定は面中心(boundary.lo=0..hi=4000の中点)のはず');
});

// ---- QA修正（項目1）: 壁2段書きはanchor:'middle'だけでなくbaseline:'middle'も合わせて
// 持たないと、レンダラ(figurePrimitivesKonva.jsx)の中央寄せ分岐に入らず左端合わせのまま
// 描画されてしまう不具合があった ----
test('【QA修正・項目1】buildFaceFigure: 壁2段書きのテキストはanchor・baselineとも"middle"を持つ（字群の中心合わせ）', () => {
  const room = makeRoom({ wallMaterial: 'm1', wallFinish: 'm2' });
  const materialMap = new Map([
    ['m1', { name: 'せっこうボード t=12.5' }],
    ['m2', { name: 'ビニルクロス' }],
  ]);
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ room, materialMap }));
  const texts = prims.filter(p => p.type === 'text' && (p.text === '壁：PB ア)12.5' || p.text === 'ビニルクロス'));
  assert.equal(texts.length, 2);
  for (const t of texts) {
    assert.equal(t.anchor, 'middle');
    assert.equal(t.baseline, 'middle', 'baseline:middleが無いとレンダラが左端合わせになる（QA修正対象）');
  }
});

test('【項目4】buildFaceFigure: 開口が面中心にかかると壁2段書きは最も広い空き区間へ退避する', () => {
  const room = makeRoom({ wallMaterial: 'm1' });
  const materialMap = new Map([['m1', { name: 'ラワン合板' }]]);
  const opening = {
    id: 'op9', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 2000, height: 2000, sillHeight: 0,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({ room, materialMap, graph: makeGraph({ openings: [opening] }) });
  const prims = buildFaceFigure(face, ctx);
  const text = prims.find(p => p.type === 'text' && p.text === '壁：ラワン合板');
  assert.ok(text, '材名の行が見つからない');
  // 開口スパン[1000,3000]が面中心(2000)と重なる。空き区間[0,1000](幅1000)・[3000,4000](幅1000)は
  // 同点——avoidObstacleRangesXは先に見つかった方[0,1000]を採るため中心=500になるはず。
  assert.equal(text.x, 500);
});

// ---- 扉のない建具（三方枠）: 内法をアキ（バツ＋「ア キ」）として標記する。扉のある建具には出ない ----
test('buildFaceFigure: 三方枠(FRAME_ONLY)は見付ぶん内側の内法にバツ2本＋「ア キ」を描く', () => {
  const opening = {
    id: 'opFrame', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 2000, height: 2000, sillHeight: null, frameFaceWidth: null, frameProjection: null,
    category: OpeningCategory.FITTING, subType: 'threeSidedFrame', fixtureType: 'WF',
  };
  const prims = buildFaceFigure(makeFace(), baseCtx({ graph: makeGraph({ openings: [opening] }) }));
  const label = prims.filter(p => p.type === 'text' && p.text === 'ア キ');
  assert.equal(label.length, 1, '「ア キ」は1つ');
  // 内法: x=1000+20〜3000-20、y=-(2000-20)〜0（見付の既定20） → 中心(2000, -990)
  assert.equal(label[0].x, 2000);
  assert.equal(label[0].y, -990);
  const diagonals = prims.filter(p => p.type === 'line' && p.dash === 'center'
    && Math.abs(p.x1 - p.x2) > 1 && Math.abs(p.y1 - p.y2) > 1);
  assert.equal(diagonals.length, 2, 'バツは対角線2本');
  for (const d of diagonals) {
    assert.deepEqual([Math.min(d.x1, d.x2), Math.max(d.x1, d.x2)], [1020, 2980], '対角線のx範囲は内法');
    assert.deepEqual([Math.min(d.y1, d.y2), Math.max(d.y1, d.y2)], [-1980, 0], '対角線のy範囲は内法（下端FL）');
  }
});

test('buildFaceFigure: 見付1px保証——scale=1/100では三方枠の内法（中線・アキ標記）が100mm内側になり、外周（細線）は指定寸法のまま', () => {
  const opening = {
    id: 'opFrame', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 2000, height: 2000, sillHeight: null, frameFaceWidth: 20, frameProjection: 12,
    category: OpeningCategory.FITTING, subType: 'threeSidedFrame', fixtureType: 'WF',
  };
  const prims = buildFaceFigure(makeFace(), baseCtx({ graph: makeGraph({ openings: [opening] }), scale: 1 / 100 }));
  const outerVerts = prims.filter(p => p.type === 'line' && p.weight === 'thin' && p.x1 === p.x2 && Math.min(p.y1, p.y2) === -2000);
  assert.deepEqual([...new Set(outerVerts.map(p => p.x1))].sort((a, b) => a - b), [1000, 3000], '外周は指定寸法(1000〜3000)');
  const innerVerts = prims.filter(p => p.type === 'line' && p.weight === 'medium' && p.x1 === p.x2 && Math.min(p.y1, p.y2) === -1900);
  assert.deepEqual([...new Set(innerVerts.map(p => p.x1))].sort((a, b) => a - b), [1100, 2900], '内法は1px(=100mm)内側');
  const label = prims.find(p => p.type === 'text' && p.text === 'ア キ');
  assert.equal(label.y, -950, 'アキ標記も広げた内法の中心');

  // 線幅を加味: lineWeightsPx{thin:1,medium:2} → 中心間 1+(1+2)/2=2.5px=250mm(1/100)
  const prims2 = buildFaceFigure(makeFace(), baseCtx({
    graph: makeGraph({ openings: [opening] }), scale: 1 / 100, lineWeightsPx: { thin: 1, medium: 2, thick: 3 },
  }));
  const innerVerts2 = prims2.filter(p => p.type === 'line' && p.weight === 'medium' && p.x1 === p.x2 && Math.min(p.y1, p.y2) === -1750);
  assert.deepEqual([...new Set(innerVerts2.map(p => p.x1))].sort((a, b) => a - b), [1250, 2750], '内法は余白1px＝250mm内側');
});

test('buildFaceFigure: 扉のある建具(singleSwing)の姿の前には「ア キ」を描かない（従来どおり）', () => {
  const opening = {
    id: 'opDoor', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 800, height: 2000, sillHeight: null,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const prims = buildFaceFigure(makeFace(), baseCtx({ graph: makeGraph({ openings: [opening] }) }));
  assert.equal(prims.filter(p => p.type === 'text' && p.text === 'ア キ').length, 0);
});

// ---- QA G1: 壁2段書きの幅概算は文字クラス別（半角ASCII=0.5・全角等=1.0）に積算する ----
test('【QA G1】estimateWallLabelWidthPx: 半角ASCIIは0.5倍・全角(CJK等)は1.0倍で積算する', () => {
  // 全角4文字のみ: 4×1.0×12=48px
  assert.equal(estimateWallLabelWidthPx('壁：ラワン'), 5 * 12); // '壁','：','ラ','ワ','ン'=5文字×1.0
  // 半角ASCIIのみ: 5文字×0.5×12=30px
  assert.equal(estimateWallLabelWidthPx('PB t=12'), 7 * 0.5 * 12);
  // 混在「壁：PB ア)12.5」: 全角(壁,：,ア)=3×1.0、半角(P,B, ,),1,2,.,5)=8×0.5
  assert.equal(estimateWallLabelWidthPx('壁：PB ア)12.5'), (3 * 1.0 + 8 * 0.5) * 12);
});

// ---- QA G1 probe: 変換後ラベルは半角主体になるため、旧・全角一律換算(×1.5相当の過大概算)より
// 実際のグリフ幅に近い新換算のほうが、通常サイズの面で過剰に省略されないことを確認する ----
test('【QA G1 probe】buildFaceFigure: 4m壁・1/20スケールでは壁2段書きが省略されずに描画される', () => {
  const room = makeRoom({ wallMaterial: 'm1', wallFinish: 'm2' });
  const materialMap = new Map([
    ['m1', { name: 'せっこうボード t=12.5' }], // 「壁：PB ア)12.5」（QAが指摘した変換後ラベル）
    ['m2', { name: 'ビニルクロス' }],
  ]);
  const face = makeFace({ run: 4000 }); // 4m壁
  const prims = buildFaceFigure(face, baseCtx({ room, materialMap, scale: 1 / 20 }));
  assert.ok(prims.some(p => p.type === 'text' && p.text === '壁：PB ア)12.5'),
    '4m壁@1/20は省略されず描画されるはず（旧・全角一律換算では省略されていた）');
});

test('【QA G1 probe・失敗系】buildFaceFigure: 2m壁・1/20スケールは（新換算でも）狭すぎるため意図どおり省略される', () => {
  const room = makeRoom({ wallMaterial: 'm1', wallFinish: 'm2' });
  const materialMap = new Map([
    ['m1', { name: 'せっこうボード t=12.5' }],
    ['m2', { name: 'ビニルクロス' }],
  ]);
  const face = makeFace({ run: 2000 }); // 2m壁（意図的省略の負例）
  const prims = buildFaceFigure(face, baseCtx({ room, materialMap, scale: 1 / 20 }));
  assert.ok(!prims.some(p => p.type === 'text' && p.text === '壁：PB ア)12.5'),
    '2m壁@1/20はラベル幅の2倍(3360mm)未満のため省略されるはず');
});

test('【QA G1 probe】buildFaceFigure: 1/50スケールでも、ラベル幅の2倍を満たす壁長（9m）なら省略されない', () => {
  // 1/50は画面固定12pxフォントに対しモデルmmで見て1/20の2.5倍の面積が要る（screen-fixed要素の
  // 性質上、縮尺が小さいほど同じ見た目サイズのラベルにより広い実寸が要る）。QAの「6m壁@1/50」
  // 例はこの具体的な材名（11文字・半角主体）では幾何的に満たせない（必要run=8400mm）ため、
  // 満たせる最小限に近い9mで動作を確認する（報告に6m@1/50が満たせない理由と併記する）。
  const room = makeRoom({ wallMaterial: 'm1', wallFinish: 'm2' });
  const materialMap = new Map([
    ['m1', { name: 'せっこうボード t=12.5' }],
    ['m2', { name: 'ビニルクロス' }],
  ]);
  const face = makeFace({ run: 9000 });
  const prims = buildFaceFigure(face, baseCtx({ room, materialMap, scale: 1 / 50 }));
  assert.ok(prims.some(p => p.type === 'text' && p.text === '壁：PB ア)12.5'),
    '9m壁@1/50は省略されず描画されるはず');
});

test('【失敗系・項目3】buildFaceFigure: 材が引けない（materialMapに無い）場合は壁2段書きを描かない', () => {
  const room = makeRoom({ wallMaterial: 'unknown', wallFinish: 'unknown2' });
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ room }));
  assert.ok(!prims.some(p => p.type === 'text' && p.anchor === 'middle' && /壁：/.test(p.text)));
});

test('【失敗系・項目4】buildFaceFigure: 壁中心線間の描画長さがラベル幅の2倍未満なら壁2段書きを描かない', () => {
  const room = makeRoom({ wallMaterial: 'm1' });
  const materialMap = new Map([['m1', { name: 'せっこうボード t=12.5' }]]); // 「壁：PB ア)12.5」
  const face = makeFace({ run: 100 });
  const prims = buildFaceFigure(face, baseCtx({ room, materialMap, scale: 1 }));
  assert.ok(!prims.some(p => p.type === 'text' && /PB/.test(p.text)));
});

test('buildFaceFigure: scale未指定（倍率決定用パス1）は壁2段書きの省略判定を行わず常に描画する', () => {
  const room = makeRoom({ wallMaterial: 'm1' });
  const materialMap = new Map([['m1', { name: 'せっこうボード t=12.5' }]]);
  const face = makeFace({ run: 10 });
  const prims = buildFaceFigure(face, baseCtx({ room, materialMap })); // scale未指定
  assert.ok(prims.some(p => p.type === 'text' && p.text === '壁：PB ア)12.5'));
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

// ---- 姿図の左右反転: 正準向き（世界座標昇順＝図のx昇順）に対し dirSign<0 の面では反転する ----
// 吊元 hingeSide=-1 は世界座標 coord1 側（平面記号 swingSymbol の hingeAlong と同じアンカー）。
// SWING の吊元表示（一点鎖線V）の頂点xが、面のローカル座標で「世界coord1の位置」に来ることを固定する。
test('buildFaceFigure: dirSign=-1の面では姿図が左右反転され、吊元が正しい世界端に描かれる', () => {
  const opening = {
    id: 'op-mirror', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 900, height: 2000, sillHeight: null, hingeSide: -1,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const ctx = () => baseCtx({ graph: makeGraph({ openings: [opening] }) });
  // 吊元の世界座標 = coord1 = 2000 - 450 = 1550
  // dirSign=+1（originWorld=0）: ローカルx = 1550
  const fwd = buildFaceFigure(makeFace({ dirSign: 1, originWorld: 0 }), ctx());
  const fwdVee = fwd.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 !== p.x2);
  assert.ok(fwdVee.length >= 2, '前提: 吊元表示のVが描かれる');
  assert.ok(fwdVee.every(p => p.x2 === 1550), 'dirSign=+1: V頂点（吊元）はローカルx=1550のはず');

  // dirSign=-1（originWorld=4000）: 同じ世界座標1550 → ローカルx = 4000-1550 = 2450
  const rev = buildFaceFigure(makeFace({ dirSign: -1, originWorld: 4000 }), ctx());
  const revVee = rev.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 !== p.x2);
  assert.ok(revVee.length >= 2, '前提: 吊元表示のVが描かれる');
  assert.ok(revVee.every(p => p.x2 === 2450),
    'dirSign=-1: 姿図が反転され、V頂点（吊元）は世界coord1に対応するローカルx=2450のはず（反転なしだと1550+900-900=1550側に残る）');
});

// ---- 姿図の左右反転（非対称機構その2）: 親子扉の子扉分割線も世界座標どおりの端に来る ----
test('buildFaceFigure: dirSign=-1の面では親子扉の子扉（分割線）が世界座標どおりの端に来る', () => {
  const opening = {
    id: 'op-pc', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 1200, height: 2000, sillHeight: null, hingeSide: -1,
    category: OpeningCategory.FITTING, subType: 'parentChild', fixtureType: null,
  };
  const ctx = () => baseCtx({ graph: makeGraph({ openings: [opening] }) });
  // 分割線の世界座標 = coord1(1400) + width×(1-childRatio=0.7) = 1400 + 840 = 2240
  // （hingeSide=-1: 親の吊元=coord1側、子扉は反対側の枠端）
  const isDivider = (p) => p.type === 'line' && p.x1 === p.x2 && p.dash == null && p.y1 === -2000 && p.y2 === 0;

  const fwd = buildFaceFigure(makeFace({ dirSign: 1, originWorld: 0 }), ctx());
  const fwdDiv = fwd.filter(isDivider);
  assert.equal(fwdDiv.length, 1, '前提: 子扉の分割線が1本描かれる');
  assert.equal(fwdDiv[0].x1, 2240, 'dirSign=+1: 分割線はローカルx=2240のはず');

  const rev = buildFaceFigure(makeFace({ dirSign: -1, originWorld: 4000 }), ctx());
  const revDiv = rev.filter(isDivider);
  assert.equal(revDiv.length, 1);
  assert.equal(revDiv[0].x1, 4000 - 2240, 'dirSign=-1: 同じ世界位置（2240）に対応するローカルx=1760のはず');
});

// ---- E2E: 実面・実壁経由で、共有壁の建具が両部屋の面の展開図に描かれる ----
// wallSide=+1（下室側の壁をホストにして配置）の建具が、反対側の上室C面にも描かれることを固定する。
test('buildFaceFigure: 共有壁の建具は配置時のクリック側と関係なく両部屋の面に描かれる', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opts);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, opts);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opts);
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opts);
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 5000, opts);
  const upper = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${yMid.id}`]), '上室');
  const lower = graph.addRoom(new Set([`${x0.id}:${yMid.id}:${x1.id}:${y2.id}`]), '下室');
  generateRoomWallsFromOutline(graph, upper);
  generateRoomWallsFromOutline(graph, lower);
  graph.addOpening(yMid, 1, false, x0, 1500, 900, OpeningCategory.FITTING, 'singleSwing', { hingeSide: -1 });

  const upperC = realBuildRoomFaces(upper, graph).find(f => f.letter === 'C');
  const lowerA = realBuildRoomFaces(lower, graph).find(f => f.letter === 'A');
  assert.ok(upperC && lowerA, '前提: 共有壁は上室C面・下室A面として存在する');

  for (const [label, face, room] of [['上室C', upperC, upper], ['下室A', lowerA, lower]]) {
    const prims = buildFaceFigure(face, baseCtx({ graph, room }));
    assert.ok(prims.some(p => p.type === 'rect' && p.w === 900), `${label}面に建具の枠rectが描かれるはず`);
    assert.ok(prims.some(p => p.type === 'tag'), `${label}面に建具記号丸が描かれるはず`);
  }
});

// ---- 床の段差（floorSegments）上の建具は、その区間の実際の床に乗る ----
// 問題: 親FL+100の帯で実効FL±0の部分指定区間（floorDeltaMm=-100）にあるドアが、
// 帯のFL基準（y=0）のまま置かれ 1FL+100 に浮いて描かれていた。
const STEP_SEGS = [
  { loX: 0, hiX: 2000, floorDeltaMm: -100 }, // 部分指定区間（親より100低い＝y=+100が床）
  { loX: 2000, hiX: 4000, floorDeltaMm: 0 },
];
function stepOpening(centerCoord, id = 'op-step') {
  return {
    id, isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord, width: 900, height: 2000, sillHeight: null, hingeSide: -1,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
}

test('buildFaceFigure: 床が低い区間（floorDeltaMm=-100）の建具は、その区間の床（y=+100）に乗る', () => {
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [stepOpening(1000)] }), floorSegments: STEP_SEGS });
  const prims = buildFaceFigure(face, ctx);
  const rect = prims.find(p => p.type === 'rect' && p.w === 900);
  assert.ok(rect, '開口の枠rectが見つからない');
  assert.equal(rect.y, -2000 + 100, '開口上端は区間の床基準（+100シフト）のはず');
  assert.equal(rect.y + rect.h, 100, '開口下端はその区間の実際の床（y=+100）に接するはず');
});

test('【失敗系】buildFaceFigure: 床が親FLどおりの区間（floorDeltaMm=0）の建具は従来どおりy=0の床に乗る', () => {
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [stepOpening(3000)] }), floorSegments: STEP_SEGS });
  const prims = buildFaceFigure(face, ctx);
  const rect = prims.find(p => p.type === 'rect' && p.w === 900);
  assert.equal(rect.y, -2000);
  assert.equal(rect.y + rect.h, 0);
});

test('【失敗系】buildFaceFigure: floorSegmentsに隙間があり開口中心がどの区間にも入らない場合は親FL基準（y=0）へフォールバックする', () => {
  const face = makeFace();
  const ctx = baseCtx({
    graph: makeGraph({ openings: [stepOpening(2000, 'op-gap')] }),
    floorSegments: [
      { loX: 0, hiX: 1000, floorDeltaMm: -100 },
      { loX: 3000, hiX: 4000, floorDeltaMm: -100 }, // 中央 1000..3000 が欠測
    ],
  });
  const prims = buildFaceFigure(face, ctx);
  const rect = prims.find(p => p.type === 'rect' && p.w === 900);
  assert.equal(rect.y + rect.h, 0, '欠測xの建具は親FL基準（y=0）に乗るはず（例外も出ない）');
});

test('buildFaceFigure: 窓のsillHeightは区間の床からの高さになる（段差区間では床とともにシフト）', () => {
  const win = {
    id: 'op-win-fl', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 1000, width: 900, height: 900, sillHeight: 800,
    category: OpeningCategory.WINDOW, subType: 'singleSliding', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [win] }), floorSegments: STEP_SEGS });
  const prims = buildFaceFigure(face, ctx);
  const rect = prims.find(p => p.type === 'rect' && p.w === 900);
  assert.equal(rect.y + rect.h, -800 + 100, '窓下端は「区間の床(+100) + sill(800)」＝y=-700のはず');
});

// 区間の同定は論理境界（hiX）ではなく描画上の段差線（riserXAt＝床が低い側へ半壁厚ずらした位置）
// 基準——境界から半壁厚以内に中心がある建具が「描かれた床」と別の区間に乗って浮かないことを固定する。
test('buildFaceFigure: 論理境界と描画段差線の間（半壁厚の帯）にある建具は「描かれた床」の側の区間に乗る', () => {
  // makeFaceはfaceValue=軸値のためhalfWallThicknessMmはDEFAULT(57.5)へフォールバック。
  // 段差線は論理境界2000から低い側（delta -100側＝左）へ57.5ずれた1942.5に描かれる。
  // 中心1970は論理的にはseg0(-100)だが、描画上は段差線より右＝床y=0の側。
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [stepOpening(1970, 'op-band')] }), floorSegments: STEP_SEGS });
  const prims = buildFaceFigure(face, ctx);
  const rect = prims.find(p => p.type === 'rect' && p.w === 900);
  assert.equal(rect.y + rect.h, 0, '描画段差線(1942.5)より右の建具は床y=0の区間に乗るはず（+100に浮かない）');
});

test('buildFaceFigure: 面端の直交壁建具断面（枠・扉の3rect）も、その隅の床に乗る', () => {
  // prevFace（直交壁）の 'end' 側の隅に届く開口。自面の x=0 の区間は床が100低い。
  const perpOpening = {
    id: 'op-perp-fl', isVertical: true, axisCL: { id: 'axisX_left' }, wallSide: 1,
    centerCoord: 1900, width: 800, height: 2000, sillHeight: null,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const prevFace = makeFace({
    axisCL: { id: 'axisX_left' }, isVertical: true, lo: 0, hi: 2000, run: 2000,
  });
  const face = makeFace();
  const ctx = baseCtx({
    graph: makeGraph({ openings: [perpOpening] }), prevFace, floorSegments: STEP_SEGS,
  });
  const prims = buildFaceFigure(face, ctx);
  assert.ok(prims.some(p => p.type === 'rect' && p.weight === 'thick' && p.h === 30 && p.y === -2000 + 100),
    '上枠が隅の床基準（+100シフト）で描かれるはず');
  assert.ok(prims.some(p => p.type === 'rect' && p.weight === 'medium' && p.y === -1980 + 100),
    '扉も同じ床基準（+100シフト）で描かれるはず');
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

// ---- 建具ドラッグの起点: 姿図の外形を覆う透明ヒット矩形（type:'hit'）と記号丸に openingId/dirSign を持たせる ----
test('buildFaceFigure: 建具ごとに姿図外形のヒット矩形(hit)を1つ出し、tag と共に openingId・dirSign を持つ', () => {
  const opening = {
    id: 'op5', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 900, height: 2000, sillHeight: 500,
    category: OpeningCategory.WINDOW, subType: 'singleSliding', fixtureType: null,
  };
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ graph: makeGraph({ openings: [opening] }) }));
  const hits = prims.filter(p => p.type === 'hit');
  assert.equal(hits.length, 1, '建具1件につきヒット矩形1つ');
  assert.deepEqual(hits[0], { type: 'hit', openingId: 'op5', dirSign: face.dirSign, x: 1550, y: -2500, w: 900, h: 2000 },
    '幅×高さ・窓台の上（y=-(sill+height)）を覆う');
  const tag = prims.find(p => p.type === 'tag');
  assert.equal(tag.openingId, 'op5');
  assert.equal(tag.dirSign, face.dirSign, '記号丸からのドラッグにも面の向きが要る');
  // 姿図のプリミティブ（枠 rect 等）にも openingId が付く——ドラッグ中のプレビュー（ElevationLayer.jsx が
  // この建具のプリミティブだけをずらす）が姿図全体を動かせるように。
  const frame = prims.find(p => p.type === 'rect' && p.w === 900);
  assert.equal(frame?.openingId, 'op5', '姿図の枠 rect にも openingId');
  assert.ok(!prims.some(p => p.type === 'line' && p.weight === 'thick' && p.openingId), '壁の断面線(thick)には付かない');
});

test('【失敗系】buildFaceFigure: 建具が無い面にはヒット矩形(hit)を出さない', () => {
  const prims = buildFaceFigure(makeFace(), baseCtx({ graph: makeGraph({ openings: [] }) }));
  assert.ok(!prims.some(p => p.type === 'hit'));
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

  // 片開き戸の断面（ユーザー明示指示2026-09。openings/openingSection.js）: 縦断面なので
  // 上枠（見付30・見込は壁厚+24）と扉（厚30・FL+10〜指定高さ-20・中線）の2本。
  // このフィクスチャのgraphは実壁を持たないため見込はフォールバック値（115+24=139）になる。
  const strip = prims.filter(p => p.type === 'rect' && p.x >= 0 && p.x + p.w <= 139 && p.weight != null);
  assert.equal(strip.length, 2, '上枠1＋扉1＝2本のrectが面のx=0側の帯に出るはず');
  const head = strip.find(r => r.weight === 'thick');
  assert.deepEqual([head.x, head.w, head.y, head.h], [0, 139, -2000, 30],
    '上枠は見付30・見込いっぱい・指定高さの直下のはず');
  const leaf = strip.find(r => r.weight === 'medium');
  assert.deepEqual([leaf.w, leaf.y, leaf.h], [30, -1980, 1970],
    '扉は厚30・上端=指定高さ-20(戸当たり)・下端=FL+10のはず');
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

// アキの標記（矩形＋バツ＋「ア キ」）を実際に描くのは断面エンジン（emitOpenGapMarks）へ移した
// ため、そのテストは section/sectionEmit.test.js へ移設した（移行の項目3）。
// kneeDropGapsOnFace 自体は残る——段差見付け面（kind==='step'。断面エンジンに対応概念が無い）の
// 専用描画と、壁2段書きラベルの回避範囲（描画ではなく配置の都合。エンジンの出力は
// buildFaceFigure の後に積まれるためここからは見えない）が読むため。

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

// ---- 項目7: 巾木は床の段差に追従する ----
test('【項目7】buildFaceFigure: floorSegmentsが段差を含む場合、巾木線は各区間自身の床Y基準になる', () => {
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const face = makeFace();
  const ctx = baseCtx({ floorSegments, room: makeRoom({}, { baseboardHeight: 'h=60' }) });
  const prims = buildFaceFigure(face, ctx);
  const baseboardLines = prims.filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2);
  // 新仕様「段差位置のCLオフセット」: 内部境界はオフセット後の位置(1942.5)になる（テストファイル
  // 冒頭のRISER_X_OFFSET_TESTS参照）。
  const seg0Line = baseboardLines.find(p => p.x1 === 0 && p.x2 === RISER_X_OFFSET_TESTS);
  const seg1Line = baseboardLines.find(p => p.x1 === RISER_X_OFFSET_TESTS && p.x2 === 4000);
  assert.ok(seg0Line, '左区間(FL=0)の巾木線が見つからない');
  assert.equal(seg0Line.y1, -60, '左区間はFL(0)から60上=-60のはず');
  assert.ok(seg1Line, '右区間(FL=-300)の巾木線が見つからない');
  assert.equal(seg1Line.y1, -360, '右区間はFL(-300)から60上=-360のはず');
});

// ---- 項目6: 段差床の巾木は床断面線（区間水平線＋段差縦線）をhだけ上へ平行移動した連続
// ポリラインとして描く（水平方向にはオフセットしない＝床の段差縦線と同じx。新仕様でその
// x自体がオフセット後の位置になった点はRISER_X_OFFSET_TESTS参照） ----
test('【項目6】buildFaceFigure: 段差の縦線は水平方向にオフセットせず、同じx位置のままhだけ上へ平行移動して描かれる', () => {
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const face = makeFace();
  const ctx = baseCtx({ floorSegments, room: makeRoom({}, { baseboardHeight: 'h=60' }) });
  const prims = buildFaceFigure(face, ctx);
  // 床の段差縦線(x=1942.5, y:0→-300)をそのままhだけ上へ平行移動した巾木縦線(x=1942.5, y:-60→-360)。
  const riserLine = prims.find(p => p.type === 'line' && p.weight === 'thin' && p.x1 === RISER_X_OFFSET_TESTS && p.x2 === RISER_X_OFFSET_TESTS);
  assert.ok(riserLine, '巾木の段差縦線（床断面の平行移動）が見つからない');
  assert.equal(riserLine.y1, -60, '左区間の床y(0)をhだけ上げた-60から始まるはず');
  assert.equal(riserLine.y2, -360, '右区間の床y(-300)をhだけ上げた-360まで届くはず');
});

// ---- 失敗系: 段差位置を開口がまたぐ場合は巾木の段差縦線も途切れさせる ----
test('【失敗系・項目6】buildFaceFigure: 段差位置(x=2000)を床まで達する開口がまたぐ場合、巾木の段差縦線は描かない', () => {
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const opening = {
    id: 'op-riser', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 1000, height: 2000, sillHeight: 0, // local span [1500,2500]。x=2000をまたぐ
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({
    floorSegments, room: makeRoom({}, { baseboardHeight: 'h=60' }),
    graph: makeGraph({ openings: [opening] }),
  });
  const prims = buildFaceFigure(face, ctx);
  const riserLine = prims.find(p => p.type === 'line' && p.weight === 'thin' && p.x1 === 2000 && p.x2 === 2000);
  assert.ok(!riserLine, '開口が段差位置をまたぐ場合、巾木の段差縦線は途切れて描かれないはず');
});

// ---- 失敗系: floorSegments省略（段差なし）なら巾木の側面線は付かず線も従来どおり1本 ----
test('【失敗系・項目7】buildFaceFigure: floorSegments省略（段差なし）なら巾木の側面線は付かない', () => {
  const face = makeFace();
  const ctx = baseCtx({ room: makeRoom({}, { baseboardHeight: 'h=60' }) });
  const prims = buildFaceFigure(face, ctx);
  const baseboardLines = prims.filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.y1 === -60);
  assert.equal(baseboardLines.length, 1, '段差が無ければ巾木線は1本のまま');
  assert.equal(baseboardLines[0].x1, 0);
  assert.equal(baseboardLines[0].x2, 4000);
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

// ---- 新仕様「段差見付け面」: kind==='step'の描画分岐 ----
function makeStepFace(overrides = {}) {
  return {
    axisCL: AXIS_Y0, isVertical: false, inward: 1, faceValue: 0,
    lo: 0, hi: 1200, run: 1200, dirSign: 1, originWorld: 0,
    startCLId: 'x0', endCLId: 'x1', label: 'C1',
    kind: 'step', baseFloorDeltaMm: 0, stepHeightMm: 100,
    ...overrides,
  };
}

test('buildFaceFigure: kind===\'step\'の面は低い側床線・両端縦線(壁断面)・天井線をCUTで、高い側床線(見付け上端)をSILHOUETTE(中線)で描く', () => {
  const face = makeStepFace();
  const prims = buildFaceFigure(face, baseCtx());
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');

  const lowFloor  = cutLines.find(l => l.y1 === l.y2 && l.y1 === 0   && l.x1 === 0 && l.x2 === 1200);
  const highFloor = silhouetteLines.find(l => l.y1 === l.y2 && l.y1 === -100 && l.x1 === 0 && l.x2 === 1200);
  const ceiling   = cutLines.find(l => l.y1 === l.y2 && l.y1 === -2400);
  // QA修正（ユーザー明示指示）: 両端縦線はtopY(-100)で止めず天井(-CH=-2400)まで描く
  // （見付け上端はあくまで見えがかり線で、壁自体は天井まで続くため）。
  const leftEnd   = cutLines.find(l => l.x1 === 0    && l.x2 === 0    && l.y1 === 0 && l.y2 === -2400);
  const rightEnd  = cutLines.find(l => l.x1 === 1200 && l.x2 === 1200 && l.y1 === 0 && l.y2 === -2400);

  assert.ok(lowFloor,  `低い側床線(y=0=floorY)が見つかるはず（実際:${JSON.stringify(cutLines)}）`);
  assert.ok(highFloor, `高い側床線(y=-100=見付け上端)はSILHOUETTE(中線)で見つかるはず（実際:${JSON.stringify(prims.filter(p => p.type === 'line' && p.y1 === p.y2 && p.y1 === -100))}）`);
  assert.ok(ceiling,   '天井線(y=-CH)が見つかるはず');
  assert.ok(leftEnd && rightEnd, `両端縦線(floorY→天井-CHまで。壁断面=CUT)が見つかるはず（実際:${JSON.stringify(cutLines)}）`);
});

// ---- 失敗系: kind==='step'の面は開口・巾木・壁2段書きを描かない ----
test('【失敗系】buildFaceFigure: kind===\'step\'の面は開口・巾木・壁2段書きをスキップする', () => {
  const opening = {
    id: 'op1', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 600, width: 800, height: 2000, sillHeight: 0,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeStepFace();
  const ctx = baseCtx({
    graph: makeGraph({ openings: [opening] }),
    room: makeRoom({ wallMaterial: 'm1', wallFinish: 'm2' }, { baseboardHeight: 'h=60' }),
    materialMap: new Map([['m1', { name: '石膏ボード' }], ['m2', { name: 'クロス' }]]),
  });
  const prims = buildFaceFigure(face, ctx);
  assert.ok(!prims.some(p => p.type === 'tag'), '開口記号丸(tag)は描かれないはず');
  assert.ok(!prims.some(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.y1 === -60),
    '巾木線(y=-60)は描かれないはず');
  assert.ok(!prims.some(p => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith('壁：')),
    '壁2段書きは描かれないはず');
});

// ---- kind==='step'でも注記帯（ROW1/ROW2/面ラベル）は通常面と共通合流する ----
test('buildFaceFigure: kind===\'step\'の面でも面ラベル(face.label)は描かれる（注記帯は通常面と共通合流）', () => {
  const face = makeStepFace();
  const prims = buildFaceFigure(face, baseCtx());
  assert.ok(prims.some(p => p.type === 'text' && p.text === 'C1'), '面ラベル"C1"が描かれるはず');
});

// 「袖壁・腰壁の面分割」の断面枠（旧 partitionCutAtLocal0/Run → appendPartitionCut）の
// テストは、規則ごと断面エンジンへ移したため section/sectionEmit.test.js へ移設した
// （移行の項目1）。面図側は袖壁の実体（位置・厚み・高さ）を知らず「面の端に枠を起こす」近似
// しか書けない——袖壁で2断片に分かれた面では、同じ1枚の袖壁を両断片が別々の近似で描いていた。

// ==== WP-2: ctx.ceilingProfile（区分線形の天井） ====

test('【WP-2】buildFaceFigure: ceilingProfileが面の範囲を覆っていれば天井は1本のpolylineになり、端縦線の上端も補間値に追従する', () => {
  const face = makeFace(); // run=4000
  const ceilingProfile = [[0, 2200], [4000, 3000]]; // 左端2200→右端3000の勾配天井
  const prims = buildFaceFigure(face, baseCtx({ ceilingProfile }));

  const polylines = prims.filter(p => p.type === 'polyline');
  assert.equal(polylines.length, 1, '天井は1本のpolylineになるはず');
  assert.equal(polylines[0].weight, 'thick', 'CUT(太)で描かれるはず');
  assert.deepEqual(polylines[0].points[0], [0, -2200], '左端は左端の天井高(-2200)のはず');
  assert.deepEqual(polylines[0].points[polylines[0].points.length - 1], [4000, -3000], '右端は右端の天井高(-3000)のはず');

  // 従来の水平天井CUT線は出ない（polylineに一本化される）——床線(y=0)だけがCUT水平線として残る。
  const flatHorizontalCutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2);
  assert.equal(flatHorizontalCutLines.length, 1, '水平のCUT線は床線1本だけのはず（天井はpolylineに置き換わる）');
  assert.equal(flatHorizontalCutLines[0].y1, 0);

  // 端の縦線（出隅=SILHOUETTE）の上端もceilAbsAtX経由で補間値に追従する。
  const endVerticals = prims.filter(p => p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2);
  const leftEdge = endVerticals.find(p => p.x1 === 0);
  const rightEdge = endVerticals.find(p => p.x1 === face.run);
  assert.ok(leftEdge && rightEdge, '両端の縦線(壁断面=CUT)が見つかるはず');
  assert.equal(leftEdge.y1, -2200, '左端縦線の上端は補間天井高(-2200)のはず');
  assert.equal(rightEdge.y1, -3000, '右端縦線の上端は補間天井高(-3000)のはず');
});

// ---- 失敗系: ceilingProfileが空配列なら現行の水平天井へフォールバックする ----
test('【失敗系・WP-2】buildFaceFigure: ceilingProfileが空配列なら従来の水平天井(CUT)へフォールバックする', () => {
  const CH = 2400;
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, ceilingProfile: [] }));
  const flatCeilLines = prims.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 === -CH);
  assert.equal(flatCeilLines.length, 1, '空配列は現行の水平天井（CH）へフォールバックするはず');
  assert.equal(prims.filter(p => p.type === 'polyline').length, 0, 'polylineは描かれないはず');
});

// ---- QA修正: ceilingProfileが面の描画範囲(drawnX0..drawnXRun)を覆っていなくても、フォールバック
// せずprofileの端点値へクランプして常にpolylineで描く（旧実装は「範囲を覆っていること」も条件に
// していたため、壁のない端部延長で描画範囲がprofile範囲よりわずかに広がる本番設定
// （wallLessEndExtendModelMm≈150が常に渡る）では常にこの条件が偽になり、勾配天井が
// 一度も描かれない不具合があった。書き換え理由: この不具合を修正したための仕様変更） ----
test('【QA修正・WP-2】buildFaceFigure: ceilingProfileが面の描画範囲を覆っていなくても、フォールバックせず端点値へクランプしてpolylineで描く', () => {
  const CH = 2400;
  const face = makeFace(); // run=4000（壁ありのため延長なし=drawnX0..drawnXRun=0..4000）
  const ceilingProfile = [[500, 2200], [3500, 3000]]; // 面の範囲[0,4000]を覆っていない
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, ceilingProfile }));

  const polylines = prims.filter(p => p.type === 'polyline');
  assert.equal(polylines.length, 1, 'profile未満の範囲でもpolylineで描かれるはず（フォールバックしない）');
  assert.equal(polylines[0].weight, 'thick', 'CUT(太)で描かれるはず');
  assert.deepEqual(polylines[0].points[0], [0, -2200], '左端(x=0)はprofile左端点値(-2200)へクランプされるはず');
  assert.deepEqual(polylines[0].points[polylines[0].points.length - 1], [4000, -3000],
    '右端(x=4000)はprofile右端点値(-3000)へクランプされるはず');

  const flatCeilLines = prims.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 === -CH);
  assert.equal(flatCeilLines.length, 0, '水平天井(CH)へのフォールバックは起きないはず');
});

// ---- 未指定時（ctx.ceilingProfile省略）は現行出力と完全一致する ----
test('【失敗系・WP-2】buildFaceFigure: ctx.ceilingProfile省略時は指定なしの既存呼び出しと完全に同じprimitivesになる', () => {
  const face = makeFace();
  const withoutProfile = buildFaceFigure(face, baseCtx());
  const withUndefinedProfile = buildFaceFigure(face, baseCtx({ ceilingProfile: undefined }));
  assert.deepEqual(withUndefinedProfile, withoutProfile);
});

// ==== WP-2: ctx.skipBaseboard / ctx.skipWallLabel ====

test('【WP-2】buildFaceFigure: ctx.skipBaseboard指定時は巾木線が描かれない', () => {
  const face = makeFace();
  const room = makeRoom({}, { baseboardHeight: 'h=60' });
  const withoutSkip = buildFaceFigure(face, baseCtx({ room }));
  const withSkip = buildFaceFigure(face, baseCtx({ room, skipBaseboard: true }));

  const baseboardLines = (prims) => prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.y1 === -60);
  assert.equal(baseboardLines(withoutSkip).length, 1, '前提: skipBaseboard未指定なら巾木線が出る');
  assert.equal(baseboardLines(withSkip).length, 0, 'skipBaseboard指定時は巾木線が描かれないはず');
});

test('【WP-2】buildFaceFigure: ctx.skipWallLabel指定時は壁2段書き（壁材・仕上げ材のテキスト）が描かれない', () => {
  const face = makeFace();
  const room = makeRoom({ wallMaterial: 'm1', wallFinish: 'm2' });
  const materialMap = new Map([
    ['m1', { name: 'せっこうボード t=12.5' }],
    ['m2', { name: 'ビニルクロス' }],
  ]);
  const withoutSkip = buildFaceFigure(face, baseCtx({ room, materialMap }));
  const withSkip = buildFaceFigure(face, baseCtx({ room, materialMap, skipWallLabel: true }));

  const wallLabelTexts = (prims) => prims.filter(p =>
    p.type === 'text' && (p.text === '壁：PB ア)12.5' || p.text === 'ビニルクロス'));
  assert.equal(wallLabelTexts(withoutSkip).length, 2, '前提: skipWallLabel未指定なら壁2段書きが出る');
  assert.equal(wallLabelTexts(withSkip).length, 0, 'skipWallLabel指定時は壁2段書きが描かれないはず');
});

// ---- 失敗系: skipBaseboard/skipWallLabel省略時（既定false）は現行出力と完全一致する ----
test('【失敗系・WP-2】buildFaceFigure: skipBaseboard/skipWallLabel省略時は指定なしの既存呼び出しと完全に同じprimitivesになる', () => {
  const room = makeRoom({ wallMaterial: 'm1', wallFinish: 'm2' }, { baseboardHeight: 'h=60' });
  const materialMap = new Map([
    ['m1', { name: 'せっこうボード t=12.5' }],
    ['m2', { name: 'ビニルクロス' }],
  ]);
  const face = makeFace();
  const withoutOpts = buildFaceFigure(face, baseCtx({ room, materialMap }));
  const withFalseOpts = buildFaceFigure(face, baseCtx({
    room, materialMap, skipBaseboard: false, skipWallLabel: false,
  }));
  assert.deepEqual(withFalseOpts, withoutOpts);
});

// 新仕様2026-08「腰壁の天端・端部」（旧 kneeCapMarksOnFace）のテストは、規則ごと断面エンジンへ
// 移したため section/sectionEmit.test.js へ移設した（「壁の輪郭を断面エンジンへ一本化」移行の項目2）。
// 面図側は腰壁の実体を知らない（ctx.graph の kneeDropWalls を読み直すしかない）——実体に属する
// 表現はエンジンが1箇所で持つ。


// ================================================================
// 多層帯の合成で延長された範囲には自階の壁が無い＝巾木も無い
// （ユーザー実機指摘2026-09「壁のないところに巾木はない」。voidAbove.selfLocal の補集合を
// 既存の floorGaps へ足すだけの実装。elevationVoid.js が selfLocal を載せる）。
// ================================================================
const BB = { baseboardHeight: 'h=60' };
const baseboardSpans = prims => prims
  .filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.y1 === -60)
  .map(p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]).sort((a, b) => a[0] - b[0]);

test('【実機修正2026-09】buildFaceFigure: 自階の面が無い区間（voidAbove.selfLocalの補集合）に巾木を描かない', () => {
  const face = makeFace({ voidAbove: { voidLocal: [{ lo: 0, hi: 4000 }], selfLocal: [{ lo: 0, hi: 1500 }] } });
  const prims = buildFaceFigure(face, baseCtx({ room: makeRoom({}, BB) }));
  assert.deepEqual(baseboardSpans(prims), [[0, 1500]],
    '自階の面がある0..1500だけに巾木が引かれるはず');
});

test('【不変ゲート】buildFaceFigure: voidAboveを持たない面・selfLocalが全幅の面は従来どおり全幅に巾木を引く', () => {
  const plain = buildFaceFigure(makeFace(), baseCtx({ room: makeRoom({}, BB) }));
  assert.deepEqual(baseboardSpans(plain), [[0, 4000]], 'voidAbove無しは現行と完全同一のはず');
  // C1型（吹抜けの範囲と自階の実壁範囲が重なるだけで走り範囲が動かない面）の回帰ゲート:
  // 「吹抜けの下」をギャップにする誤実装だとここで巾木が消える。
  const c1 = makeFace({ voidAbove: { voidLocal: [{ lo: 500, hi: 3500 }], selfLocal: [{ lo: 0, hi: 4000 }] } });
  assert.deepEqual(baseboardSpans(buildFaceFigure(c1, baseCtx({ room: makeRoom({}, BB) }))), [[0, 4000]],
    '自階の壁が全幅にある面は、吹抜けの下でも巾木が1本も消えてはいけない');
});

test('【実機修正2026-09】buildFaceFigure: 延長範囲に床段差の境界が来ても、巾木の段差縦線を描かない', () => {
  // 段差の境界(2000)は延長範囲(1500..4000)の中。floorGaps経由なので縦線の抑止も自動。
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const face = makeFace({ voidAbove: { voidLocal: [], selfLocal: [{ lo: 0, hi: 1500 }] } });
  const prims = buildFaceFigure(face, baseCtx({ floorSegments, room: makeRoom({}, BB) }));
  assert.deepEqual(baseboardSpans(prims), [[0, 1500]], '延長範囲には巾木を引かないはず');
  const risers = prims.filter(p => p.type === 'line' && p.weight === 'thin'
    && Math.abs(p.x1 - p.x2) < 1e-6 && Math.min(p.y1, p.y2) >= -400 && Math.max(p.y1, p.y2) <= -60);
  assert.deepEqual(risers, [], '延長範囲の中の段差には巾木の縦線も描かれないはず');
});

test('【実機修正2026-09】buildFaceFigure: 開放スパンとの二重適用でも、巾木の途切れは既存と同じ位置・本数になる', () => {
  // selfLocal(0..3000)の中に開放スパン(1000..2000)がある構図。
  const spans = [
    { loX: 0, hiX: 1000, kind: 'wall', hiCLId: null },
    { loX: 1000, hiX: 2000, kind: 'open', hiCLId: null },
    { loX: 2000, hiX: 4000, kind: 'wall', hiCLId: null },
  ];
  const ctx = baseCtx({ room: makeRoom({}, BB) });
  const withVoid = buildFaceFigure(makeFace({ spans, voidAbove: { voidLocal: [], selfLocal: [{ lo: 0, hi: 3000 }] } }), ctx);
  const plain = buildFaceFigure(makeFace({ spans }), ctx);
  assert.deepEqual(baseboardSpans(plain), [[0, 1000], [2000, 4000]],
    '前提: 開放スパンは従来どおり巾木を途切れさせる');
  assert.deepEqual(baseboardSpans(withVoid), [[0, 1000], [2000, 3000]],
    'selfLocal内の途切れは位置も本数も既存と同じで、延長範囲(3000..4000)だけが増えて消えるはず');
});

test('【実機修正2026-09】buildFaceFigure: 巾木は内部境界でも外端でもはね出さず、面の範囲で止まる', () => {
  // lo側が延長された面（自階の面は1500..4000）で、run端は「壁のない端部」＝床線がはね出す端。
  const face = makeFace({
    hasWallAtLocalRun: false,
    voidAbove: { voidLocal: [], selfLocal: [{ lo: 1500, hi: 4000 }] },
  });
  const prims = buildFaceFigure(face, baseCtx({
    room: makeRoom({}, BB), wallLessEndExtendModelMm: 150,
  }));
  assert.deepEqual(baseboardSpans(prims), [[1500, 4000]],
    '巾木は自階の面の端(1500)から面の端(run=4000)まで——壁のない端部のはね出し(4150)へは'
    + '伸ばさない（ユーザー実機指摘2026-09「巾木は壁のある所にしかない」）');
  // 床線のはね出しは従来どおり（この主張は変えない）。
  const floor = prims.filter(p => p.type === 'line' && p.weight === 'thick'
    && p.y1 === p.y2 && p.y1 === 0);
  assert.equal(Math.max(...floor.map(p => Math.max(p.x1, p.x2))), 4150,
    '床線は従来どおり150mmはね出すはず');
});

test('【実機修正2026-09】buildFaceFigure: lo側が延長かつlocal0端が壁なしでも、延長範囲の外に巾木の切れ端を残さない', () => {
  // 上の「外端のはね出し」テストの鏡像。自階の面は1500..4000で、local0端は壁のない端部
  // （＝床線はdrawnX0=-150まではね出す）。延長範囲(0..1500)だけでなく、その外側の
  // はね出し区間(-150..0)にも自階の壁は無いので巾木は1本も出てはいけない。
  const face = makeFace({
    hasWallAtLocal0: false,
    voidAbove: { voidLocal: [], selfLocal: [{ lo: 1500, hi: 4000 }] },
  });
  const prims = buildFaceFigure(face, baseCtx({
    room: makeRoom({}, BB), wallLessEndExtendModelMm: 150,
  }));
  assert.deepEqual(baseboardSpans(prims), [[1500, 4000]],
    'はね出し区間(-150..0)にも延長範囲(0..1500)にも巾木は残らないはず');
});

test('【不変ゲート・実機修正2026-09】buildFaceFigure: 壁のある端では巾木の出力は完全に不変', () => {
  // hasWallAtLocal0/Run とも既定(true) ＝ drawnX0=0・drawnXRun=run。Math.max/min は効かない。
  const prims = buildFaceFigure(makeFace(), baseCtx({ room: makeRoom({}, BB), wallLessEndExtendModelMm: 150 }));
  assert.deepEqual(baseboardSpans(prims), [[0, 4000]], '壁のある端では従来どおり面の全幅のはず');
});

test('【実機修正2026-09】buildFaceFigure: 階段帯のfloorSpanXクランプ（狭める方向）は巾木でも効いたまま', () => {
  // floorSpanX は drawnX0/drawnXRun をさらに内側へ狭めるフック。Math.max/min はこれを壊さない。
  const prims = buildFaceFigure(makeFace({ hasWallAtLocal0: false, hasWallAtLocalRun: false }),
    baseCtx({ room: makeRoom({}, BB), wallLessEndExtendModelMm: 150, floorSpanX: { lo: 500, hi: 3000 } }));
  assert.deepEqual(baseboardSpans(prims), [[500, 3000]], 'floorSpanXの範囲まで狭まるはず');
});

test('【実機修正2026-09】buildFaceFigure: 段差と壁のない端部が併発しても、端の区間だけ短くなり内部境界は不変', () => {
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const ctx = baseCtx({ floorSegments, room: makeRoom({}, BB), wallLessEndExtendModelMm: 150 });
  const plain = buildFaceFigure(makeFace(), ctx);
  const wallLess = buildFaceFigure(makeFace({ hasWallAtLocal0: false, hasWallAtLocalRun: false }), ctx);
  // 内部境界（riserXAt）は両者で同じ位置のまま。端だけが面の範囲で止まる（はね出さない）。
  // 段差があるので巾木は2つの高さ(-60/-360)に分かれる。高さを問わず全区間で比較する。
  const allSpans = prims => prims
    .filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.y1 < 0)
    .map(p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(allSpans(plain), allSpans(wallLess),
    '壁のない端部でも巾木の区間は面の範囲(0..run)のままで、内部境界も動かないはず');
  assert.equal(allSpans(plain)[0][0], 0, '左端は面の端(0)');
  assert.equal(allSpans(plain).at(-1)[1], 4000, '右端は面の端(run=4000)＝はね出さない');
});

// ================================================================
// 壁2段書きは「壁の実体がある区間ごとに1つ・その区間の中央」（ユーザー実機指摘2026-09
// 「壁仕上げは壁の中央に書く。図中、壁が2つに分かれていたら、それぞれの壁の中央に書く」）。
// 区間 = boundary ∩ 壁の実体がある範囲（= spans の wall ∩ selfLocal）。
// **開口・床の段差は区間を割らない**（従来どおり「避ける障害物」のまま）。
// ================================================================
const WALL_ROOM = { wallMaterial: 'm1' };
const WALL_MAP = new Map([['m1', { name: 'ラワン合板' }]]);
const wallLabelXs = prims => prims
  .filter(p => p.type === 'text' && p.text === '壁：ラワン合板').map(p => p.x).sort((a, b) => a - b);
const wallLabelCtx = extra => baseCtx({ room: makeRoom(WALL_ROOM), materialMap: WALL_MAP, ...extra });

test('【実機修正2026-09・室10 B2型】buildFaceFigure: 面の一部が開放スパンなら、壁区間の中央に置く', () => {
  // open[0..1000] + wall[1000..4000]。boundary=[0,4000]（makeFaceの既定）。
  const face = makeFace({ spans: [
    { loX: 0, hiX: 1000, kind: 'open', farFloorDeltaMm: 0 },
    { loX: 1000, hiX: 4000, kind: 'wall' },
  ] });
  assert.deepEqual(wallLabelXs(buildFaceFigure(face, wallLabelCtx())), [2500],
    '壁区間(1000..4000)の中央=2500のはず（面中心2000ではない）');
});

test('【実機修正2026-09・室11ダッシュ A2型】buildFaceFigure: open+wall+open でも壁区間の中央に1つ', () => {
  // **左右非対称**にする（壁区間の中央2000 ≠ 面/boundaryの中央2250）——対称だと「面ごとに1つ」の
  // 旧実装でも同じ座標になり、規則の変更を検知できない（qa指摘2026-09）。
  const face = makeFace({ lo: 0, hi: 4500, run: 4500, spans: [
    { loX: 0, hiX: 1000, kind: 'open', farFloorDeltaMm: 0 },
    { loX: 1000, hiX: 3000, kind: 'wall' },
    { loX: 3000, hiX: 4500, kind: 'open', farFloorDeltaMm: 0 },
  ] });
  assert.deepEqual(wallLabelXs(buildFaceFigure(face, wallLabelCtx())), [2000],
    '壁区間(1000..3000)の中央=2000のはず（boundary中央2250ではない）');
});

test('【実機修正2026-09・室5 A型】buildFaceFigure: 多層合成で延長された範囲には置かない（自階の壁の中央）', () => {
  const face = makeFace({ voidAbove: { voidLocal: [], selfLocal: [{ lo: 0, hi: 1600 }] } });
  assert.deepEqual(wallLabelXs(buildFaceFigure(face, wallLabelCtx())), [800],
    '自階の壁(0..1600)の中央=800のはず（面中心2000ではない）');
});

test('【実機修正2026-09・規則の核】buildFaceFigure: 壁が2つに分かれていれば、それぞれの中央に1つずつ', () => {
  const face = makeFace({ spans: [
    { loX: 0, hiX: 1000, kind: 'wall' },
    { loX: 1000, hiX: 2000, kind: 'open', farFloorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, kind: 'wall' },
  ] });
  assert.deepEqual(wallLabelXs(buildFaceFigure(face, wallLabelCtx())), [500, 3000],
    '2区間それぞれの中央(500と3000)に1つずつのはず');
});

test('【失敗系・実機修正2026-09】buildFaceFigure: 狭い壁区間だけラベルを省略する（区間ごとの判定）', () => {
  const face = makeFace({ spans: [
    { loX: 0, hiX: 400, kind: 'wall' },          // 狭い区間
    { loX: 400, hiX: 1000, kind: 'open', farFloorDeltaMm: 0 },
    { loX: 1000, hiX: 4000, kind: 'wall' },      // 広い区間
  ] });
  // scale=0.01（1mm=0.01px）→ ラベル幅は 5文字×12px/0.01 = 6000mm ではなく、実寸で効く値にする。
  const wide = buildFaceFigure(face, wallLabelCtx({ scale: 0.2 }));   // 幅 60/0.2=300mm
  assert.deepEqual(wallLabelXs(wide), [2500], '狭い区間(400)は落ち、広い区間(1000..4000)だけ残るはず');
  const none = buildFaceFigure(face, wallLabelCtx({ scale: 0.01 }));  // 幅 60/0.01=6000mm
  assert.deepEqual(wallLabelXs(none), [], '全区間が狭ければ0個のはず');
});

test('【失敗系・解釈の固定】buildFaceFigure: 開口は壁区間を割らない（1つのまま・退避だけ効く）', () => {
  const opening = {
    id: 'opW', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 2000, height: 2000, sillHeight: 0,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const prims = buildFaceFigure(makeFace(), wallLabelCtx({
    graph: makeGraph({ openings: [opening] }), scale: 0.2,
  }));
  const xs = wallLabelXs(prims);
  assert.equal(xs.length, 1, '開口で壁が割れてラベルが2つになってはいけない（開口は壁に開いた穴）');
  assert.ok(xs[0] < 1000 || xs[0] > 3000, `開口(1000..3000)を避けた位置のはず（実際:${xs[0]}）`);
});

test('【失敗系・実機修正2026-09】buildFaceFigure: 上階だけの面（selfLocal空）には自階の壁2段書きを置かない', () => {
  const face = makeFace({ voidAbove: { voidLocal: [{ lo: 0, hi: 4000 }], selfLocal: [] } });
  assert.deepEqual(wallLabelXs(buildFaceFigure(face, wallLabelCtx())), [],
    '自階の壁が1mmも無い面には置かない（巾木と同じ述語・同じ理由）');
});

test('【不変ゲート・実機修正2026-09】全面が壁の面のラベル座標は boundary の中心のまま（run基準へ寄らない）', () => {
  // **boundaryが面の範囲[0,run]と一致しない面**で固定する（実データでは壁中心線は面端より
  // 半壁厚外側にあり、片端が壁のない端部だと非対称になる）。基準をrunへ変えると座標が動き、
  // 全面の既存ラベル＝ゴールデン全面差分になる。
  const CL_LO = { id: 'clLo', centerLineType: CenterLineType.VERTICAL, effectiveValue: -100, value: -100 };
  const CL_HI = { id: 'clHi', centerLineType: CenterLineType.VERTICAL, effectiveValue: 4300, value: 4300 };
  const face = makeFace({ startCLId: 'clLo', endCLId: 'clHi' });
  const graph = makeGraph({ shapes: new Map([[CL_LO.id, CL_LO], [CL_HI.id, CL_HI]]) });
  const boundary = faceBoundaryLocalX(face, graph);
  assert.deepEqual([boundary.lo, boundary.hi], [-100, 4300], '前提: boundaryは[0,run]と一致しない');
  assert.deepEqual(wallLabelXs(buildFaceFigure(face, wallLabelCtx({ graph, scale: 0.2 }))), [2100],
    'boundaryの中心(2100)のまま——面の範囲(0..4000)の中心2000へ寄ってはいけない');
});

test('【不変ゲート】buildFaceFigure: scale未指定なら省略判定を行わない（狭い壁区間にも置く）', () => {
  const face = makeFace({ spans: [
    { loX: 0, hiX: 400, kind: 'wall' },
    { loX: 400, hiX: 4000, kind: 'open', farFloorDeltaMm: 0 },
  ] });
  assert.deepEqual(wallLabelXs(buildFaceFigure(face, wallLabelCtx())), [200],
    'scale未指定は従来どおり幅判定なし＝狭い区間にも置くはず');
});

test('【失敗系・実機修正2026-09】buildFaceFigure: 開放スパンは障害物に積まない（CL基準の値で壁区間の端を食わない）', () => {
  // 開放スパンの描画基準(drawnSpanRanges)は「境界に立つ実壁の**開放側の面**」で、CL基準より
  // **狭い**（drawn open ⊂ CL open。elevationFaces.jsのdrawnSpanBoundaryX）。よってCL基準の
  // open区間は壁区間の端へ半壁厚ぶん食い込む——障害物に積むと、その食い込みぶんラベルが寄る。
  // 食い込みが効くのは壁区間が狭いときだけなので、そういう構成で固定する。
  const clB = { id: 'clB', centerLineType: CenterLineType.VERTICAL, effectiveValue: 1000, value: 1000 };
  const clC = { id: 'clC', centerLineType: CenterLineType.VERTICAL, effectiveValue: 1200, value: 1200 };
  // 境界に立つ直交壁（垂直）。開放側の面はCLから左右非対称にずらす（左100・右50）。
  const wallAt = (cl, axisValue) => ({
    isVertical: true, axisCL: cl, axisValue, coord1: -500, coord2: 500,
    materialRange: { lo: axisValue - 1, hi: axisValue + 1 },
  });
  const graph = {
    openings: [], kneeDropWalls: new Map(), centerLines: [clB, clC],
    walls: [wallAt(clB, 900), wallAt(clC, 1250)],
    shapeMap: new Map([[clB.id, clB], [clC.id, clC]]),
  };
  const face = makeFace({ spans: [
    { loX: 0, hiX: 1000, kind: 'open', farFloorDeltaMm: 0, hiCLId: 'clB' },
    { loX: 1000, hiX: 1200, kind: 'wall', hiCLId: 'clC' },
    { loX: 1200, hiX: 4000, kind: 'open', farFloorDeltaMm: 0 },
  ] });
  const drawn = drawnSpanRanges(face, graph);
  assert.deepEqual([drawn[0].hiX, drawn[2].loX], [900, 1250],
    '前提: 描画基準の壁区間は900..1250（CL基準の1000..1200より広い＝CL側が食い込む側）');
  // ラベル幅161.5mm（=84px/0.52。'壁：ラワン合板'は全角7文字）: 壁区間350mmには収まる
  // （省略判定 350>=2W を満たす）が、CL基準の食い込みを障害物に積むと中央1075で衝突し、
  // 空き区間(1000..1200)の中央1100へ寄ってしまう。
  const xs = wallLabelXs(buildFaceFigure(face, wallLabelCtx({ graph, scale: 0.52 })));
  assert.deepEqual(xs, [1075],
    '壁区間(900..1250)の中央1075のはず——開放スパンを障害物に積むと1100へ寄る');
});

// ================================================================
// 実機修正2026-09「22」2階A1: 階段の下り口（stairOpeningsで壁生成がスキップされた区間）に
// 巾木が描かれる不具合。face.spansは開放スパン解析（部屋の連続性）由来で、'wall'区間の内側に
// 「壁が生成されていない区間」があっても'wall'のまま——wallCoverageGapsOnFace（実壁の被覆の
// 隙間）をwallLessRunsOnFaceへ合流させたことで、巾木・壁2段書きの両方がこの区間を避けるように
// なる。sectionProbeKneeCorner.test.jsのbuildFixture()を参考に、実際に部屋の輪郭を閉じた
// フル構成（realBuildRoomFacesではなくcomposeRoomFaces経由。腰壁の分割・spans組成を経る）で
// 固定する。
// ================================================================
test('【実機修正2026-09】buildFaceFigure: 階段の下り口区間（壁の実体なし）に巾木を描かず、壁2段書きラベルは壁区間ごとの中央へ移る', () => {
  const CH = 2400;
  const plane = new Plane('p2', 3000, '2階', 2, 1);
  const graph = new PlanGraph(plane);
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  const V = v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  const H = v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const X1 = V(-8000), X2 = V(-3000), X3 = V(0);
  const Y2 = H(-7000), Ym = H(-3500), Y1 = H(-2000);
  const cell = (x0, y0, x1, y1) => `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  // 室22（実機相当）: X1..X3、Ym..Y1の矩形。北面(Ym)はX1..X2の壁a1とX2..X3の腰壁の2本のみで
  // X2..-1500（階段の下り口）は壁が無い（実機「22」2階A1×階段の構成）。
  const room22 = graph.addRoom(new Set([cell(X1, Ym, X2, Y1), cell(X2, Ym, X3, Y1)]), '22');
  room22.finish.setField('baseboardHeight', 'h=60');
  room22.setOverride('wallMaterial', 'm1');
  graph.addRoom(new Set([cell(X2, Y2, X3, Ym)]), '').setFeature(RoomFeature.STAIR_VOID);
  graph.addRoom(new Set([cell(X1, Y2, X2, Ym)]), '21');
  const opts = { isRoomWall: true, wallFinish: 12.5, backingDepth: 90 };
  graph.addWall(Ym, 57.5, false, X1, 57.5, X2, 57.5, opts);   // a1壁（X1..X2）
  graph.addWall(Ym, 57.5, false, X2, 1500, X3, 57.5, opts);   // 腰壁（-1500..X3。X2..-1500は壁なし）
  graph.addWall(X2, 57.5, true, Y2, 57.5, Ym, 57.5, opts);    // 階段吹抜け側のX2壁
  graph.addWall(X1, 57.5, true, Ym, 57.5, Y1, 57.5, opts);    // 室22西壁（D）
  graph.addWall(X3, -57.5, true, Ym, 57.5, Y1, 57.5, opts);   // 室22東壁（B）
  graph.addWall(Y1, -57.5, false, X1, 57.5, X3, 57.5, opts);  // 室22南壁（C）
  graph.setKneeDropWall(edgeKey(Ym.id, X2.id, X3.id), { knee: { topHeight: 800 }, drop: null });

  const faces = composeRoomFaces(room22, graph);
  const faceA = faces.find(f => !f.isVertical && f.axisCL.effectiveValue === Ym.effectiveValue);
  // 前提: 実機どおりA面はX1..X3の全幅（局所run=7885）を1枚のfaceとして持つ
  // （spansは'wall'のまま。壁の実体の隙間は別の源=wallCoverageGapsOnFaceでしか分からない）。
  assert.equal(faceA.run, 7885, '前提: A面はX1..X3の全幅1枚のはず');

  const prims = buildFaceFigure(faceA, {
    graph, project: { openingNumberIndex: new Map() }, room: room22, ceilingHeight: CH,
    materialMap: new Map([['m1', { name: 'ラワン合板' }]]), gridCLs: [], scale: 0.3,
  });

  // 巾木線（y=床-巾木高=-60）: 階段の下り口区間(local 5000..6442.5。世界座標X2+57.5..-1500)を
  // 覆わず、a1壁の区間(0..5000)と腰壁の区間(6442.5..7885)にだけ引かれるはず。
  const baseboardSpans = prims
    .filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.y1 === -60)
    .map(p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(baseboardSpans, [[0, 5000], [6442.5, 7885]],
    '階段の下り口区間には巾木を描かず、実壁のある2区間にだけ引かれるはず');

  // 壁2段書きラベル（見た目が変わる点。壁区間ごとの中央へ移る——従来は全面1区間の中央だった）。
  const wallLabelXs = prims.filter(p => p.type === 'text' && p.text === '壁：ラワン合板').map(p => p.x);
  assert.deepEqual(wallLabelXs, [2471.25, 7192.5],
    '壁2段書きは壁区間ごと（a1壁区間・腰壁区間）の中央2箇所に移るはず');
});

// ---- 失敗系: 開放スパンと壁の被覆の隙間が同じ区間に重なっても、巾木の途切れは1区間のまま
// （二重に数えられない） ----
// QA注記: このテストは「開放スパン(kind==='open')」だけでも同じ巾木の途切れ方(結果的に
// [[0,1000],[2000,4000]])になるため、wallGaps（wallCoverageGapsOnFace由来の隙間）を
// wallLessRunsOnFaceへ合流させる新コード自体はゲートしていない（合流させなくても本テストは
// 緑のまま——`out.push(...(wallGaps ?? []))`を無効化して確認済み）。あくまで「2つの源が
// 同じ区間を指しても壊れない（重複しない）」という**併存時の不変条件**の固定であり、
// 新コードの単体ゲートは`elevationFaces.test.js`の`wallCoverageGapsOnFace`テスト群と、
// 本ファイルの「階段の下り口区間」テスト（wallGaps由来の隙間が'open'スパンに現れない
// 純粋なケース）が担う。
test('【失敗系・実機修正2026-09】buildFaceFigure: 開放スパンと壁の被覆の隙間が重なる区間でも、巾木の途切れは重複しない', () => {
  const clMid = { id: 'clMid', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 0, value: 0 };
  const graph = {
    openings: [], kneeDropWalls: new Map(), shapeMap: new Map([[clMid.id, clMid]]),
    // face自身の通り(clMid)の壁は1000..2000区間に無い——open区間(1000..2000)と完全一致する
    // 壁の被覆の隙間を作る（二重適用の回帰確認）。
    walls: [
      { isVertical: false, axisCL: clMid, coord1: 0, coord2: 1000 },
      { isVertical: false, axisCL: clMid, coord1: 2000, coord2: 4000 },
    ],
  };
  const face = makeFace({
    axisCL: clMid,
    spans: [
      { loX: 0, hiX: 1000, kind: 'wall', hiCLId: null },
      { loX: 1000, hiX: 2000, kind: 'open', farFloorDeltaMm: 0, hiCLId: null },
      { loX: 2000, hiX: 4000, kind: 'wall', hiCLId: null },
    ],
  });
  const prims = buildFaceFigure(face, baseCtx({ graph, room: makeRoom({}, BB) }));
  assert.deepEqual(baseboardSpans(prims), [[0, 1000], [2000, 4000]],
    '開放スパンと壁の被覆の隙間が同じ区間を指しても、巾木の途切れは1個所のまま重複しないはず');
});


// ---- ctx.floorProfile: 面端の縦線の下端を「その位置の断面線」にする（ユーザー明示指示2026-09
// 「展開図では、断面線の外は描画しない」。階段帯のように床が階段そのもので出来ている面では、
// 端の壁は帯の床ではなく階段断面から立ち上がる） ----
test('buildFaceFigure: ctx.floorProfile指定時、面端の縦線の下端はその位置の輪郭値になる', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  // 左端(x=0)で1200まで上がっている斜めの断面線（階段断面）。右端(x=4000)は床(0)のまま。
  const floorProfile = [[0, 1200], [2000, 0], [4000, 0]];
  const prims = buildFaceFigure(makeFace(), baseCtx({ ceilingHeight: CH, floorSegments, floorProfile }));
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');

  const leftEnd = cutLines.find(l => l.x1 === 0 && l.x2 === 0);
  assert.ok(leftEnd, '左端の縦線は描かれるはず');
  assert.equal(leftEnd.y2, -1200, '左端縦線の下端は輪郭(1200)のはず');
  const rightEnd = cutLines.find(l => l.x1 === 4000 && l.x2 === 4000);
  assert.equal(rightEnd.y2, 0, '右端は輪郭が床と同じ(0)なので従来どおり');

  // 床線・天井線には触らない（切り詰めはflatLineSpanX側の担当）。
  const floorHorizontal = cutLines.find(l => l.y1 === l.y2 && l.y1 === 0 && l.x1 !== l.x2);
  assert.ok(floorHorizontal, '床の水平線は輪郭の有無に関わらず描かれるはず');
  assert.equal(floorHorizontal.x1, 0);
  assert.equal(floorHorizontal.x2, 4000);
});

// ---- ctx.upperOverhang / ctx.upperFloorZ: 上階の平面が自階の面の端より外へ続くぶんのはり出し
// （ユーザー裁定2026-09「「6」D2」。上＝上階の天井断面線・下＝上階のFL断面線で閉じる） ----
test('buildFaceFigure: upperOverhang指定時、天井断面線だけがはり出し、床線・面端の縦線は面の端で終わる', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const ctx = baseCtx({ ceilingHeight: CH, floorSegments, upperOverhang: { lo: 160, hi: 0 } });
  const prims = buildFaceFigure(makeFace(), ctx);
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');

  const ceil = cutLines.find(l => l.y1 === l.y2 && l.y1 === -CH && l.x1 !== l.x2);
  assert.deepEqual([ceil.x1, ceil.x2], [-160, 4000], '天井断面線の左端だけがはり出す');
  const floor = cutLines.find(l => l.y1 === l.y2 && l.y1 === 0 && l.x1 !== l.x2);
  assert.deepEqual([floor.x1, floor.x2], [0, 4000], '床線は自階の面の要素なので延ばさない');
  const leftEnd = cutLines.find(l => l.x1 === 0 && l.x2 === 0);
  assert.ok(leftEnd, '面端の縦線は従来どおりローカルx=0に残る（はり出しの内側の辺）');
});

test('buildFaceFigure: upperOverhang+upperFloorZ指定時、上階FLの断面線ははり出し区間にだけ引かれる', () => {
  const CH = 5400 - 1500;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 1500, chMm: CH }];
  // 実データ「6」D2と同じ形: 断面線（階段）は面の外(-132.5..-102.5)で2FL(3000)にいて、
  // そこから面の中へ下っていく。
  const floorProfile = [[-132.5, 3000], [-102.5, 3000], [0, 2870], [4000, 1500]];
  const prims = buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: 5400, floorSegments, floorProfile,
    upperOverhang: { lo: 160, hi: 0 }, upperFloorZ: 3000,
  }));
  const flLines = prims.filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000);
  assert.equal(flLines.length, 1, '上階FLの断面線は1本');
  assert.deepEqual([flLines[0].x1, flLines[0].x2], [-160, -102.5],
    'はり出しの外端から、断面線が上階FLを下回る位置（階段が2FLに達するx）まで');
  assert.equal(flLines[0].weight, 'thick', '床の断面線はCUT（太線）');
});

// ---- floorProfileを持たない帯（上部吹抜けを持つ部屋帯。elevationVoid.jsの
// buildRoomBandWithVoidAbove）で、**はり出しの外端に切断壁が立たない**（ctx.upperFloorCutEnds
// 未指定）とき: はり出し区間のうち面端のCLより向こう側に上階FLの断面線を引く。
// 【裁定の履歴】旧「「5」A1: 追加された2階X3の2FLは、X3の右側が正解」はこのCL規則の根拠
// だったが、ユーザー裁定2026-09で**外端に切断壁が立つ端**については「2FL断面まで下りて外側に
// 向かって張り出して終了」へ置き換わった（下の`upperFloorCutEnds`の節）。実データ「5」A1は
// そちらへ移り、ここは切断壁の立たない端に残る既定の規則。 ----
test('buildFaceFigure: 切断壁の立たないはり出しでは、面端のCLより向こう側だけに上階FLの断面線を引く', () => {
  const CH = 2400;
  const RUN = 4000;
  const HALF_WALL = 57.5; // 面端に立つ壁（実データ「5」A1のX3の2階腰壁）の半壁厚
  const floorSegments = [{ loX: 0, hiX: RUN, floorDeltaMm: 0 }];
  // 面はCLの手前（壁の室内側の面）で終わり、CLはその外側にある＝はり出しの中にCLが立つ。
  const endCL = { id: 'x1', centerLineType: CenterLineType.VERTICAL,
    effectiveValue: RUN + HALF_WALL, value: RUN + HALF_WALL };
  const prims = buildFaceFigure(makeFace(), baseCtx({
    graph: makeGraph({ shapes: new Map([[endCL.id, endCL]]) }),
    ceilingHeight: CH, floorSegments,
    upperOverhang: { lo: 0, hi: 115 }, upperFloorZ: 3000,
  }));
  const flLines = prims.filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000);
  assert.equal(flLines.length, 1, '上階FLの断面線は1本（はり出しのある側だけ）');
  assert.deepEqual([flLines[0].x1, flLines[0].x2], [RUN + HALF_WALL, RUN + 115],
    'CL（上階の床が始まる位置）から、はり出しの外端まで');
  assert.equal(flLines[0].weight, 'thick', '床の断面線はCUT（太線）');
  assert.ok(!prims.some(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000
    && Math.min(p.x1, p.x2) < RUN + HALF_WALL - 1e-6),
    'CLより手前（吹抜けの上に壁が張り出している側）には引かない');
  // 起点はCLそのもの（RUN+HALF_WALL）。**外端に切断壁が立つ端はこの規則を使わない**
  // （ctx.upperFloorCutEndsの節。壁の向こう側の面から外へ張り出す）。
  assert.equal(Math.min(flLines[0].x1, flLines[0].x2), RUN + HALF_WALL,
    `切断壁の情報が無い端の起点はCL(${RUN + HALF_WALL})`);
});

// 【失敗系】はり出しに壁のCLが立たない面（面端のCLが引けない・面の端と一致する）では、
// 止める根拠が無いのではり出し区間の全幅のまま（makeFaceのstartCLId/endCLIdはbaseCtxの
// graphで引けないため faceBoundaryLocalX が {0, run} へフォールバックする）。
test('【失敗系】buildFaceFigure: はり出しに立つ壁のCLが無ければ上階FLの断面線ははり出し区間の全幅', () => {
  const CH = 2400;
  const RUN = 4000;
  const floorSegments = [{ loX: 0, hiX: RUN, floorDeltaMm: 0 }];
  const prims = buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments,
    upperOverhang: { lo: 0, hi: 115 }, upperFloorZ: 3000,
  }));
  const flLines = prims.filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000);
  assert.equal(flLines.length, 1, '上階FLの断面線は1本（はり出しのある側だけ）');
  assert.deepEqual([flLines[0].x1, flLines[0].x2], [RUN, RUN + 115],
    'はり出し区間（面の端〜外端）の全幅');
  assert.equal(flLines[0].weight, 'thick', '床の断面線はCUT（太線）');
  assert.ok(!prims.some(p => p.type === 'line' && p.y1 === -3000 && p.x1 < RUN - 1e-6),
    '面の内側には引かない（上階の床は腰壁の断面の中）');
});

// ---- ctx.upperFloorCutEnds: はり出しの外端に**切断壁（上階の腰壁）**が立つ端
// （ユーザー裁定2026-09「「6」C 左端X3外側の2階腰壁断面は、2FL断面まで下りて外側に向かって
// 張り出して終了、が正解」「「5」A1 X3外側の腰壁断面は…同」）。
// 値は壁の向こう側の面（面ローカルx）で、そこから**外側へ**wallLessEndExtendModelMm（既定150）
// ぶん張り出して終わる。壁の下（CL〜向こう側の面）には引かない。 ----
test('buildFaceFigure: はり出し外端に切断壁が立つ端は、壁の向こう側の面から外へ張り出して終わる', () => {
  const CH = 2400;
  const RUN = 4000;
  const OVERHANG = 115; // 実データ「5」A1: 面端6085→外端6200
  const floorSegments = [{ loX: 0, hiX: RUN, floorDeltaMm: 0 }];
  const prims = buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments,
    upperOverhang: { lo: 0, hi: OVERHANG }, upperFloorZ: 3000,
    upperFloorCutEnds: { lo: null, hi: RUN + OVERHANG },
  }));
  const flLines = prims.filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000);
  assert.equal(flLines.length, 1, '上階FLの断面線は1本（切断壁の立つ側だけ）');
  assert.deepEqual([flLines[0].x1, flLines[0].x2], [RUN + OVERHANG, RUN + OVERHANG + 150],
    '壁の向こう側の面から、外側へwallLessEndExtendModelMm(150)ぶん');
  assert.equal(flLines[0].weight, 'thick', '床の断面線はCUT（太線）');
  assert.ok(!prims.some(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000
    && Math.min(p.x1, p.x2) < RUN + OVERHANG - 1e-6),
    '壁の下（CL〜向こう側の面）には引かない＝切断壁の断面の中を通さない');
  const ceil = prims.filter(p => p.type === 'line' && p.weight === 'thick'
    && p.y1 === p.y2 && p.y1 === -CH);
  assert.deepEqual([ceil[0].x1, ceil[0].x2], [0, RUN + OVERHANG],
    '天井断面線は従来どおり壁の外側の面まで（張り出すのは2FL線だけ）');
});

test('buildFaceFigure: 切断壁の立つ端はfloorProfileより優先し、立たない端は従来どおり', () => {
  const RUN = 2885;
  const floorSegments = [{ loX: 0, hiX: RUN, floorDeltaMm: 1500, chMm: 5400 - 1500 }];
  // 実データ「6」C（seq1）: 断面線は踊り場1500で平ら＝floorProfile分岐なら線が出ない側。
  const floorProfile = [[0, 1500], [RUN, 1500]];
  const prims = buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: 5400, floorSegments, floorProfile,
    upperOverhang: { lo: 115, hi: 0 }, upperFloorZ: 3000,
    upperFloorCutEnds: { lo: -115, hi: null },
  }));
  const flLines = prims.filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000);
  assert.equal(flLines.length, 1, '切断壁の立つlo側だけ1本');
  assert.deepEqual([flLines[0].x1, flLines[0].x2], [-115 - 150, -115],
    '壁の向こう側の面(-115)から外側(-265)へ。断面線が平らでも引く');
});

test('【失敗系】buildFaceFigure: upperFloorCutEnds未指定・nullの端は現行の描き方と完全一致', () => {
  const RUN = 4000;
  const floorSegments = [{ loX: 0, hiX: RUN, floorDeltaMm: 0 }];
  const mk = upperFloorCutEnds => buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: 2400, floorSegments,
    upperOverhang: { lo: 0, hi: 115 }, upperFloorZ: 3000, upperFloorCutEnds,
  }));
  const base = mk(undefined);
  // 実データ「6」D2の外端は全高の**見えがかり**壁で切断壁ではない＝nullが来る側。
  assert.deepEqual(mk({ lo: null, hi: null }), base, '両端nullは未指定と同じ出力');
  assert.deepEqual(mk({ lo: 3000, hi: null }), base, 'はり出し0の端(lo)の値は無視する');
  const fl = base.filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000);
  assert.deepEqual([fl[0].x1, fl[0].x2], [RUN, RUN + 115], '従来どおりはり出し区間の中で終わる');
});

test('【失敗系】buildFaceFigure: 上階の床が実在しない端(upperFloorEnds=false)は切断壁でも引かない', () => {
  const RUN = 4000;
  const floorSegments = [{ loX: 0, hiX: RUN, floorDeltaMm: 0 }];
  const ctxOf = upperFloorEnds => baseCtx({
    ceilingHeight: 2400, floorSegments,
    upperOverhang: { lo: 0, hi: 115 }, upperFloorZ: 3000,
    upperFloorCutEnds: { lo: null, hi: RUN + 115 }, upperFloorEnds,
  });
  // 【案2】upperFloorEnds.lo=trueの面端縦線は、この帯自身も2層帯（upperFloorZ指定あり）
  // のため上端がupperFloorZ(-3000)まで縮む（elevationFigure.js:923-926。§5.12 D2-1是正・
  // 裁定(a)）——y1===-3000の「線」自体はこのテストの対象（upperFloorEdgeSpansの水平な
  // はり出し線）と別物なので、下記のとおりy1===y2===-3000（水平線）で絞って区別する
  // （openケースの絞り込みと同じ精度に揃える）。
  const blocked = buildFaceFigure(makeFace(), ctxOf({ lo: true, hi: false }));
  assert.equal(blocked.filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000).length, 0,
    '上階に実部屋が無い端のgateは切断壁の張り出しにも効く（既存gateを維持）');
  const open = buildFaceFigure(makeFace(), ctxOf({ lo: true, hi: true }));
  assert.equal(open.filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000).length, 1,
    'gateが開いていれば張り出しは出る');
  // 天井断面線・壁エッジはgateで落とさない（既存規約）。
  assert.ok(blocked.some(p => p.type === 'line' && p.weight === 'thick'
    && p.y1 === p.y2 && p.y1 === -2400 && Math.max(p.x1, p.x2) === RUN + 115),
    '天井断面線ははり出したまま');
});

// ---- 展開図一般化§5.12 D2-1是正・裁定(a)（案2）: 面端縦線の上端は2層帯ではupperFloorZまで ----
// 「面端の外はcontent側に渡す」——上階FLから上（はり出し・壁の縁）はupperFloorEdgeSpansと
// 断面エンジンのcontentが描くため、面端縦線自身は上階FLで止める。1層帯（upperFloorZ未指定）・
// upperFloorEnds未指定（上階の床の有無を判定していない呼び出し）は従来どおり天井まで
// ＝出力完全不変（elevationFigure.js:923-926付近のcapsAtUpperFloor）。
test('【案2】buildFaceFigure: 2層帯・はり出しあり(upperFloorZ+upperOverhang+upperFloorEnds指定)では面端縦線の上端がupperFloorZまでに縮む(天井までは伸びない)', () => {
  const CH = 5400; // 実データ「6」D2と同じ桁（旧: 天井5400まで誤って伸びていた）
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const prims = buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments, upperFloorZ: 3000,
    upperOverhang: { lo: 160, hi: 160 }, upperFloorEnds: { lo: true, hi: true },
  }));
  const endLines = prims.filter(p => p.type === 'line' && !p.dash && p.x1 === p.x2 && (p.x1 === 0 || p.x1 === 4000));
  assert.equal(endLines.length, 2, '面端の縦線(local0・localRun)が2本あるはず');
  for (const l of endLines) {
    assert.equal(Math.max(l.y1, l.y2), 0, '下端は床(y=0)のはず');
    assert.equal(Math.min(l.y1, l.y2), -3000, '上端は天井(-5400)ではなくupperFloorZ(-3000)までに縮むはず');
  }
});

// ---- QA是正2026-09（項目2）: capsAtUpperFloorのgateはupperFloorEdgeSpansと同じ関数を共有する ----
test('【QA是正・案2】buildFaceFigure: はり出しが無い端（upperOverhang未指定/0）では、upperFloorZ+upperFloorEndsが指定されていてもcapしない（従来どおり天井まで）', () => {
  const CH = 5400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const mk = upperOverhang => buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments, upperFloorZ: 3000, upperOverhang, upperFloorEnds: { lo: true, hi: true },
  }));
  const endLinesOf = prims => prims.filter(p => p.type === 'line' && !p.dash && p.x1 === p.x2 && (p.x1 === 0 || p.x1 === 4000));
  for (const overhang of [undefined, { lo: 0, hi: 0 }]) {
    for (const l of endLinesOf(mk(overhang))) {
      assert.equal(Math.min(l.y1, l.y2), -CH,
        `overhang=${JSON.stringify(overhang)}: はり出しが無ければupperFloorEdgeSpansは1本も引かないためcapしない（天井までのはず）`);
    }
  }
});

// ---- QA是正2026-09（項目1）: capped時も実際の天井より低い側では止まらない（Math.min） ----
test('【QA是正・案2】buildFaceFigure: 天井がupperFloorZより低い面端では、capしても実際の天井（低い方）で止まり、upperFloorZまで伸びない', () => {
  const CH = 2400; // 天井2400 < upperFloorZ3000（実機「5」x=0・x=21935相当）
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const prims = buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments, upperFloorZ: 3000,
    upperOverhang: { lo: 160, hi: 160 }, upperFloorEnds: { lo: true, hi: true },
  }));
  const endLines = prims.filter(p => p.type === 'line' && !p.dash && p.x1 === p.x2 && (p.x1 === 0 || p.x1 === 4000));
  assert.equal(endLines.length, 2, '面端の縦線が2本あるはず');
  for (const l of endLines) {
    assert.equal(Math.min(l.y1, l.y2), -CH,
      '天井(2400)がupperFloorZ(3000)より低いので、その低い方(天井)で止まるはず（600mm突き抜けない）');
  }
});

// ---- QA是正2026-09: capが隣接面（パネル接合部）と重なり2本を作らない ----
// パネル統合（mergeSteppedFacesIntoPanel）で1枚の壁として扱われる隣接面は、接合端で
// 同じ物理壁の断面線を共有する——同じ帯・同じupperFloorZ/upperOverhang/天井高であれば、
// 双方のbuildFaceFigureが出す端の縦線は高さも完全一致するはず（一致しなければ、dedupe
// （sectionEmit.js等）で1本に畳めず「2本」に分離して残ってしまう。実機「5」x=21935で
// 発現した症状の一般化ガード）。
test('【QA是正】buildFaceFigure: 同一のupperFloorZ/upperOverhang/天井高を持つ隣接面どうしは、接合端の縦線の高さが完全一致する（2本に分離しない）', () => {
  const CH = 2400;
  const ctxOf = () => baseCtx({
    ceilingHeight: CH, floorSegments: [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }],
    upperFloorZ: 3000, upperOverhang: { lo: 160, hi: 160 }, upperFloorEnds: { lo: true, hi: true },
  });
  // faceA(localRun側で接合)・faceB(local0側で接合)——実際のパネル接合と同じ「片方はhasWallAtLocalRun、
  // もう片方はhasWallAtLocal0」の組み合わせを模す。
  const primsA = buildFaceFigure(makeFace({ hasWallAtLocalRun: true }), ctxOf());
  const primsB = buildFaceFigure(makeFace({ hasWallAtLocal0: true }), ctxOf());
  const endLineOf = (prims, x) => prims.find(p => p.type === 'line' && !p.dash && p.x1 === p.x2 && p.x1 === x);
  const runEnd = endLineOf(primsA, 4000), localEnd = endLineOf(primsB, 0);
  assert.ok(runEnd && localEnd, '両方の接合端に縦線があるはず');
  assert.deepEqual([Math.min(runEnd.y1, runEnd.y2), Math.max(runEnd.y1, runEnd.y2)],
    [Math.min(localEnd.y1, localEnd.y2), Math.max(localEnd.y1, localEnd.y2)],
    '同一条件の隣接面どうしは接合端の縦線の高さ(上端=cap後・下端)が完全一致し、2本に分離しないはず');
});

// ---- QA是正2026-09（第2ラウンド・項目1/4・実機「6」D2の最小再現）----
// 実データ「6」D2相当: hasWallAtLocal0=false・hiddenWallAtLocal0=true（wallFilterで除外された
// 実壁がある端）・floorProfileがlocal -30..0でz=upperFloorZちょうどフラット（2FLに到達済み）。
test('【QA是正・第2ラウンド項目1/4】buildFaceFigure: hidden端の2F床の小口はthick1本・幅は上階壁の半壁厚（体裁の延長150mmを含まない207.5等にならない）', () => {
  const floorSegments = [{ loX: 0, hiX: 3442.5, floorDeltaMm: 0 }];
  const floorProfile = [[-30, 3000], [0, 3000], [220, 2700]];
  const face = { axisCL: { id: 'axisY0', effectiveValue: 0 }, isVertical: false, inward: 1, faceValue: 0,
    lo: 0, hi: 3442.5, run: 3442.5, dirSign: 1, originWorld: 0, startCLId: 'x0', endCLId: 'x1',
    hasWallAtLocal0: false, hiddenWallAtLocal0: true, hasWallAtLocalRun: true };
  const prims = buildFaceFigure(face, baseCtx({
    ceilingHeight: 5400, floorSegments, floorProfile,
    upperFloorZ: 3000, upperOverhang: { lo: 57.5, hi: 0 },
    upperFloorEnds: { lo: true, hi: false }, upperFloorCutEnds: { lo: null, hi: null },
  }));
  const edgeLines = prims.filter(p => p.type === 'line' && !p.dash && p.y1 === -3000 && p.y2 === -3000);
  assert.equal(edgeLines.length, 1, '2F床の小口は1本だけのはず');
  assert.equal(Math.abs(edgeLines[0].x2 - edgeLines[0].x1), 57.5,
    `長さは上階壁の半壁厚(57.5mm)のはず（実際:${Math.abs(edgeLines[0].x2 - edgeLines[0].x1)}）`);
});

// ---- QA是正2026-09（第2ラウンド・項目3(2)）: hidden端では床線・天井線を図の外へ延長しない ----
test('【QA是正・第2ラウンド項目3(2)】buildFaceFigure: hidden端(hasWall=false・hiddenWall=true)では床線・天井線を図の外へ延長しない（最小xが0）', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const face = makeFace({ hasWallAtLocal0: false, hiddenWallAtLocal0: true });
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));
  const xs = prims.flatMap(p => p.type === 'line' ? [p.x1, p.x2] : p.type === 'polyline' ? p.points.map(pt => pt[0]) : []);
  assert.equal(Math.min(...xs), 0,
    `hidden端は真に壁のない端部ではないため体裁の延長(-150)を受けず、最小xは0のはず（実際:${Math.min(...xs)}）`);
});

// ---- QA是正2026-09（第2ラウンド・項目3(3)）: 上階FLの断面線は同位置の中線を内包しない ----
test('【QA是正・第2ラウンド項目3(3)】clipContentAtHiddenEnds: hidden端のcontentは探査延長区間（面の外）に残る水平線（上階FL断面線と同位置の冗長な中線）を落とす', () => {
  const face = { run: 3442.5, hiddenWallAtLocal0: true, hiddenWallAtLocalRun: false };
  const prims = [
    // withProbeExtension（探査窓。§2で未変更）が広げた探査範囲の中で見つかった、面の外(x<0)へ
    // 残る冗長な中線（実機「6」D2の`medium x=0..-150 y=-3000`相当。elevationFigure.jsの
    // upperFloorEdgeSpans側が別途、面の真の境界までの太線を描くため二重になる）。
    { type: 'line', x1: 0, y1: -3000, x2: -150, y2: -3000, weight: 'medium' },
    { type: 'line', x1: 500, y1: -2400, x2: 600, y2: -2400, weight: 'medium' }, // 面の中の線は対象外
    { type: 'line', x1: 3442.5, y1: -2400, x2: 3500, y2: -2400, weight: 'medium' }, // hiddenでない端は対象外
    { type: 'line', x1: -57.5, y1: -3000, x2: -57.5, y2: -5400, weight: 'medium', __o: 'recessLo' }, // 縦線は対象外
  ];
  const out = clipContentAtHiddenEnds(prims, face);
  assert.ok(!out.some(p => p.type === 'line' && p.x1 !== p.x2 && Math.min(p.x1, p.x2) < 0),
    'hidden端(local0)を越えて面の外(x<0)へ残る水平線が無いはず（上階FL断面線と同位置の中線が重ならない）');
  assert.equal(out.length, 3, '面の外へ丸ごと出ていた冗長な中線(1本)だけが落ち、残り3本（面の中・非hidden端・縦線）は保たれるはず');
  assert.ok(out.some(p => p.x1 === 3442.5), 'hiddenでない端(localRun)の線はクリップされず残るはず');
  assert.ok(out.some(p => p.__o === 'recessLo'), '縦線(recessLo)はクリップされず残るはず');
});

test('【失敗系・案2】buildFaceFigure: upperFloorEnds未指定・1層帯(upperFloorZ未指定)では面端縦線は従来どおり天井まで(出力不変)', () => {
  const CH = 5400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const mk = extra => buildFaceFigure(makeFace(), baseCtx({ ceilingHeight: CH, floorSegments, ...extra }));
  const base = mk({});
  const endLinesOf = prims => prims.filter(p => p.type === 'line' && !p.dash && p.x1 === p.x2 && (p.x1 === 0 || p.x1 === 4000));
  for (const l of endLinesOf(base)) assert.equal(Math.min(l.y1, l.y2), -CH, '1層帯(upperFloorZ未指定)は従来どおり天井までのはず');
  // upperFloorEnds未指定（2層帯だがどちらの端も上階の床の有無を判定していない呼び出し）も
  // 天井までのまま＝出力完全不変（upperFloorZだけの指定では縮めない）。
  assert.deepEqual(mk({ upperFloorZ: 3000 }), base, 'upperFloorEnds未指定はupperFloorZがあっても出力不変のはず');
});

test('【失敗系】buildFaceFigure: floorProfileが無くupperFloorZ未指定なら上階FLの断面線は引かない', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const mk = extra => buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments, upperOverhang: { lo: 0, hi: 115 }, ...extra,
  }));
  const base = mk({});
  assert.equal(base.filter(p => p.type === 'line' && p.y1 === -3000).length, 0,
    'upperFloorZが無ければ上階FLの高さが分からない＝引かない');
  assert.deepEqual(mk({ upperFloorZ: undefined }), base);
  assert.deepEqual(mk({ upperFloorZ: null }), base);
});

test('【失敗系】buildFaceFigure: floorProfileが無くはり出し0の側には上階FLの断面線を引かない', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const mk = upperOverhang => buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments, upperOverhang, upperFloorZ: 3000,
  }));
  // 両側0＝はり出しが無い面には1本も出ない（＝通常の部屋帯は完全不変）。
  assert.deepEqual(mk({ lo: 0, hi: 0 }), mk(undefined),
    'はり出し0はupperOverhang未指定と同じ出力');
  assert.equal(mk({ lo: 0, hi: 0 }).filter(p => p.type === 'line' && p.y1 === -3000).length, 0);
  // 片側だけはり出す面では、0の側（ここではhi側）に線が現れない。
  const fl = mk({ lo: 160, hi: 0 }).filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000);
  assert.equal(fl.length, 1);
  assert.deepEqual([fl[0].x1, fl[0].x2], [-160, 0], 'lo側だけ＝面の端から外端まで');
});

// 面端のCLは（はり出しの有無に関わらず）どの面にもあるため、CLを起点にする分岐は
// **はり出し区間の外へは絶対に出ない**ことが安全条件。破ると、はり出しが0の面
// （＝通常の部屋帯のほぼ全面）にCLまでの偽の水平線が生える。
test('【失敗系】buildFaceFigure: 面端のCLがはり出しの外にあっても上階FLの断面線ははり出しを越えない', () => {
  const CH = 2400;
  const RUN = 4000;
  const floorSegments = [{ loX: 0, hiX: RUN, floorDeltaMm: 0 }];
  const endCL = { id: 'x1', centerLineType: CenterLineType.VERTICAL,
    effectiveValue: RUN + 57.5, value: RUN + 57.5 };
  const mk = upperOverhang => buildFaceFigure(makeFace(), baseCtx({
    graph: makeGraph({ shapes: new Map([[endCL.id, endCL]]) }),
    ceilingHeight: CH, floorSegments, upperOverhang, upperFloorZ: 3000,
  })).filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000);
  assert.equal(mk({ lo: 0, hi: 0 }).length, 0,
    'はり出し0の面にCLまでの線を生やさない（通常の部屋帯は完全不変）');
  assert.equal(mk({ lo: 0, hi: 30 }).length, 0,
    'はり出しがCLに届かない＝はり出しは丸ごと吹抜けの側＝上階の床は無い');
});

// T3（QA指摘2026-09）: 天井をceilingProfile（勾配天井・階段帯）で描く分岐にも、はり出しが効くこと。
// 水平天井の分岐だけを見ていると、この分岐のceilX0/ceilXRunがdrawnX0/drawnXRunへ戻っても
// 全テストが通ってしまう（＝天井のはり出しが静かに消える）。
test('buildFaceFigure: ceilingProfile+upperOverhang指定時、天井polylineの両端がはり出す', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const ceilingProfile = [[0, 2400], [2000, 2700], [4000, 2400]];
  const prims = buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments, ceilingProfile, upperOverhang: { lo: 160, hi: 80 },
  }));
  const poly = prims.filter(p => p.type === 'polyline' && p.weight === 'thick');
  assert.equal(poly.length, 1, '天井はpolyline1本');
  const xs = poly[0].points.map(([x]) => x);
  assert.equal(xs[0], -160, '左端はdrawnX0-lo');
  assert.equal(xs[xs.length - 1], 4080, '右端はdrawnXRun+hi');
  // はり出しぶんの高さは端点クランプ（勾配天井の端の値）で、床線はそのまま面の端で終わる。
  assert.equal(poly[0].points[0][1], -2400, 'はり出し部の天井高さは断面の端点値');
  const floor = prims.find(p => p.type === 'line' && p.y1 === 0 && p.y2 === 0 && p.x1 !== p.x2);
  assert.deepEqual([floor.x1, floor.x2], [0, 4000], '床線ははり出さない');
});

test('【失敗系】buildFaceFigure: ceilingProfile指定でもupperOverhang未指定なら天井polylineは面の端で終わる', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const ceilingProfile = [[0, 2400], [2000, 2700], [4000, 2400]];
  const base = buildFaceFigure(makeFace(), baseCtx({ ceilingHeight: CH, floorSegments, ceilingProfile }));
  const poly = base.find(p => p.type === 'polyline' && p.weight === 'thick');
  assert.deepEqual([poly.points[0][0], poly.points[poly.points.length - 1][0]], [0, 4000]);
  for (const overhang of [null, undefined, { lo: 0, hi: 0 }]) {
    assert.deepEqual(buildFaceFigure(makeFace(), baseCtx({
      ceilingHeight: CH, floorSegments, ceilingProfile, upperOverhang: overhang,
    })), base, `upperOverhang=${JSON.stringify(overhang)}は現行出力と一致するはず`);
  }
});

// ---- ctx.lowerOverhang: 下階の平面が自階の面の端より外へ続くぶんのはり出し（upperOverhangの
// 鏡像。吹抜け帯`elevationVoid.js`が渡す）。**区間の床断面線だけ**が伸び、上端（下階の天井）と
// 外端（下階の壁エッジ）は断面エンジンのcontentが描く ----
// QA指摘2026-09（テスト③）: これまで`lowerOverhang`の直接テストが無く、帯経由でしか触れて
// いなかった（＝この分岐をdrawnX0/drawnXRunへ戻しても図側の期待値が誰も落ちない）。
test('buildFaceFigure: lowerOverhang指定時、床断面線だけがはり出し、天井線・巾木・段差縦線・面端の縦線は面の端で終わる', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const ctx = baseCtx({
    ceilingHeight: CH, floorSegments, lowerOverhang: { lo: 160, hi: 0 },
    room: makeRoom({}, { baseboardHeight: 'h=60' }),
  });
  const prims = buildFaceFigure(makeFace(), ctx);
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');

  // 先頭区間（FL=0）の床線だけが -160 まで。次の区間（FL=-300）は面の中なので変わらない。
  const floor0 = cutLines.find(l => l.y1 === l.y2 && l.y1 === 0 && l.x1 !== l.x2);
  assert.deepEqual([floor0.x1, floor0.x2], [-160, RISER_X_OFFSET_TESTS],
    '先頭区間の床断面線の左端だけがはり出す');
  const floor1 = cutLines.find(l => l.y1 === l.y2 && l.y1 === -300 && l.x1 !== l.x2);
  assert.deepEqual([floor1.x1, floor1.x2], [RISER_X_OFFSET_TESTS, 4000], '2区間目は面の中のまま');

  // 天井線・巾木・段差縦線・面端の縦線は面の端（x=0）のまま。
  const ceil = cutLines.find(l => l.y1 === l.y2 && l.y1 === -CH && l.x1 !== l.x2);
  assert.deepEqual([ceil.x1, ceil.x2], [0, 4000], '天井断面線は下階のはり出しでは伸びない');
  const base0 = prims.find(p => p.type === 'line' && p.weight === 'thin' && p.y1 === -60 && p.y2 === -60);
  assert.equal(base0.x1, 0, '巾木は面の端で終わる');
  assert.ok(cutLines.some(l => l.x1 === l.x2 && l.x1 === RISER_X_OFFSET_TESTS),
    '段差の縦線は従来どおり段差位置のまま');
  assert.ok(cutLines.some(l => l.x1 === l.x2 && l.x1 === 0),
    '面端の縦線は面の端（x=0）のまま＝はり出し区間の内側の辺');
});

test('【失敗系】buildFaceFigure: lowerOverhang未指定／{lo:0,hi:0}は現行出力と完全一致（既定offの保証）', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0,    hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const mk = lowerOverhang => buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments, lowerOverhang,
    room: makeRoom({}, { baseboardHeight: 'h=60' }),
  }));
  const base = mk(undefined);
  for (const overhang of [null, { lo: 0, hi: 0 }]) {
    assert.deepEqual(mk(overhang), base,
      `lowerOverhang=${JSON.stringify(overhang)}は現行出力と一致するはず`);
  }
});

// T4（QA指摘2026-09）: 外端の輪郭値は`drawnFloorProfileZAt`の「範囲外は端点値」クランプで
// 得られるため、断面線が面の端ちょうどで終わっていても値が返る——それを根拠に線を引くのは
// 面の外への外挿になる。断面線がはり出し側へ伸びている面（実データ「6」D2）だけが対象。
test('【失敗系】buildFaceFigure: 断面線の定義域が面の中だけなら、上階FLの断面線を引かない', () => {
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 1500, chMm: 3900 }];
  // 断面線は面の中[0,4000]だけ。左端で上階FL(3000)にいるが、はり出し(-160..0)は未知。
  const floorProfile = [[0, 3000], [2000, 3000], [4000, 1500]];
  const prims = buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: 5400, floorSegments, floorProfile,
    upperOverhang: { lo: 160, hi: 0 }, upperFloorZ: 3000,
  }));
  assert.equal(prims.filter(p => p.type === 'line' && p.y1 === -3000 && p.y2 === -3000).length, 0,
    '定義域の外の端点値を根拠にはり出し区間へ床の小口を描いてはいけない');
});

test('【失敗系】buildFaceFigure: 断面線が上階FLに届かない面では上階FLの断面線を引かない', () => {
  const CH = 2400;
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }];
  const floorProfile = [[0, 0], [4000, 0]]; // 断面線は床(0)のまま＝上階FL(3000)に届かない
  const prims = buildFaceFigure(makeFace(), baseCtx({
    ceilingHeight: CH, floorSegments, floorProfile,
    upperOverhang: { lo: 160, hi: 0 }, upperFloorZ: 3000,
  }));
  assert.equal(prims.filter(p => p.type === 'line' && p.y1 === -3000).length, 0,
    'そこに上階の床の小口は現れない');
});

test('【失敗系】buildFaceFigure: upperOverhang未指定・0は既存出力と完全一致（通常の部屋帯は無変化）', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const floorProfile = [[0, 3000], [4000, 3000]];
  const base = buildFaceFigure(makeFace(), baseCtx({ ceilingHeight: CH, floorSegments, floorProfile }));
  for (const overhang of [null, undefined, { lo: 0, hi: 0 }]) {
    const actual = buildFaceFigure(makeFace(), baseCtx({
      ceilingHeight: CH, floorSegments, floorProfile, upperOverhang: overhang, upperFloorZ: 3000,
    }));
    assert.deepEqual(actual, base, `upperOverhang=${JSON.stringify(overhang)}は現行出力と一致するはず`);
  }
});

test('【失敗系】buildFaceFigure: floorProfile未指定・空配列は既存出力と完全一致（通常の部屋帯は無変化）', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const base = buildFaceFigure(makeFace(), baseCtx({ ceilingHeight: CH, floorSegments }));
  for (const profile of [null, undefined, []]) {
    const withProfile = buildFaceFigure(
      makeFace(), baseCtx({ ceilingHeight: CH, floorSegments, floorProfile: profile }));
    assert.deepEqual(withProfile, base, `floorProfile=${JSON.stringify(profile)}は現行出力と一致するはず`);
  }
});
