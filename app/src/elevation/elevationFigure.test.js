// buildFaceFigure の描画内容テスト（.claude/elevation-model.md §11 記載項目）。
// graph/room/opening は buildFaceFigure が実際に読むフィールドのみを持つ最小限のフェイクを使う
// （純関数のロジック検証が目的で、graph実体の生成コストを避ける）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeKey, OpeningCategory, CenterLineType, Plane, PlanGraph, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import {
  buildFaceFigure, kneeDropGapsOnFace, parseBaseboardHeightMm, avoidGridCollisionX,
  openingsReachingCorner, formatMaterialLabel, avoidObstacleRangesX, estimateWallLabelWidthPx,
  segEndProfile,
} from './elevationFigure.js';
import { buildRoomFaces as realBuildRoomFaces } from './elevationFaces.js';
import { wallAdjacentFloorSegments } from './elevationFloorProfile.js';
import {
  GRID_LINE_ABOVE_CH_MM, CANVAS_BG_COLOR, DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
  DEFAULT_OPENING_TAG_ROW_MM, OPENING_TAG_ROW_SCREEN_MM, OPENING_TAG_RADIUS_PX,
  DIM_ROW_GAP_SCREEN_MM, GRID_ROW_GAP_SCREEN_MM, GRID_TAG_RADIUS_PX,
  DEFAULT_WALL_LESS_END_EXTEND_MM,
} from './elevationStyle.js';
import { screenMmToModelMm, horizontalDimLabelBox } from './elevationLayout.js';
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
test('buildFaceFigure: 床線1・天井線1の計2本のCUT(太)線と、両端縦線2本のSILHOUETTE(中線)線が出る', () => {
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx());
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');
  assert.equal(cutLines.length, 2, '床線・天井線の2本のはず');
  assert.equal(silhouetteLines.length, 2, '出隅の両端縦線2本のはず');
});

// ---- 項目1・2・QA修正(5a): 壁のない端部（hasWallAtLocal0/Run=false）は床線・天井線を延長し
// 端の縦線は描かない。壁がある端（出隅）は縦線をSILHOUETTE(中線)で描く ----
test('【項目1】buildFaceFigure: hasWallAtLocal0=falseの面は左端の縦線を描かず、床線・天井線がx=-extendMmまで延長される', () => {
  const face = makeFace({ hasWallAtLocal0: false, hasWallAtLocalRun: true });
  const ctx = baseCtx({ wallLessEndExtendModelMm: 200 });
  const prims = buildFaceFigure(face, ctx);
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');

  assert.equal(cutLines.length, 2, '床線・天井線の2本のはず（縦線はCUTではない）');
  assert.equal(silhouetteLines.length, 1, '右端(出隅)の縦線1本だけSILHOUETTEで残るはず');
  assert.ok(!silhouetteLines.some(l => l.x1 === 0 && l.x2 === 0), '左端(x=0)の縦線は描かないはず');
  assert.ok(silhouetteLines.some(l => l.x1 === face.run && l.x2 === face.run), '右端(x=run)の縦線は残るはず');
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

  assert.equal(cutLines.length, 2);
  assert.equal(silhouetteLines.length, 1);
  assert.ok(!silhouetteLines.some(l => l.x1 === face.run && l.x2 === face.run), '右端の縦線は描かないはず');
  assert.ok(silhouetteLines.some(l => l.x1 === 0 && l.x2 === 0), '左端の縦線は残るはず');
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
  assert.equal(cutLines.length, 2, 'face側にフィールドが無ければ壁あり扱いで床線・天井線2本のはず');
  assert.equal(silhouetteLines.length, 2, '両端の縦線もSILHOUETTEで2本出るはず');
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
  // QA修正(5a): 壁のある端(出隅)の縦線はSILHOUETTE(中線)で描く。
  const silhouetteVerticals = prims.filter(p => p.type === 'line' && p.weight === 'medium' && p.x1 === p.x2);
  assert.equal(silhouetteVerticals.length, 1, '壁なし側(run側)の縦線は描かれず、壁あり側(0側)の1本だけのはず');
  assert.equal(silhouetteVerticals[0].x1, 0, '残る縦線は壁のある0側のはず');
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
  const cornerVertA = primsA.find(p => p.type === 'line' && p.weight === 'medium' && p.x1 === 0 && p.x2 === 0);
  const cornerVertD = primsD.find(p => p.type === 'line' && p.weight === 'medium' && p.x1 === 0 && p.x2 === 0);
  assert.ok(cornerVertA && cornerVertD, '両面ともx=0の出隅縦線が見つかるはず');
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
  // 天井線1・床の水平線2（区間ごと）・段差縦線1 = 計4本のCUT。両端縦線2本はSILHOUETTE（QA修正5a）。
  assert.equal(cutLines.length, 4, `CUT線は4本のはず（実際:${cutLines.length}）`);
  assert.equal(silhouetteLines.length, 2, '両端(出隅)の縦線2本はSILHOUETTEのはず');

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

  // 両端の縦線（x=0とx=run=4000。出隅=SILHOUETTE）は、その位置の区間の床yまで伸びる
  // （面の外端はriserXAtの対象外＝オフセットの影響を受けない）。
  const leftEnd  = silhouetteLines.find(l => l.x1 === 0 && l.x2 === 0);
  const rightEnd = silhouetteLines.find(l => l.x1 === face.run && l.x2 === face.run);
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

// ---- QA実機フィードバック修正: floorSegments[].hideFlatLine===trueの区間は床の水平線を描かない
// （階段のレーン区間で段鼻の断面ジグザグが既に境界を表しているため、床線が素通りして
// 反対側の隅まで貫通してしまう不具合の修正）----
test('【QA修正・実機フィードバック】buildFaceFigure: floorSegments[].hideFlatLine===trueの区間は床の水平線を描かない（段差縦線・両端縦線は不変）', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, hideFlatLine: true },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const face = makeFace();
  const ctx = baseCtx({ ceilingHeight: CH, floorSegments });
  const prims = buildFaceFigure(face, ctx);

  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const floorHorizontals = cutLines.filter(l => l.y1 === l.y2 && l.y1 !== -CH);
  assert.equal(floorHorizontals.length, 1, 'hideFlatLineの区間の床線は描かれず、残る区間の床線1本だけのはず');
  assert.equal(floorHorizontals[0].x1, RISER_X_OFFSET_TESTS, '残った床線は段差位置(オフセット後)から始まるはず');
  assert.equal(floorHorizontals[0].x2, 4000);

  // 段差縦線（区間間のriser）はhideFlatLineの影響を受けず、従来どおり描かれるはず。
  const riser = cutLines.find(l => l.x1 === RISER_X_OFFSET_TESTS && l.x2 === RISER_X_OFFSET_TESTS && l.y1 === 0 && l.y2 === -300);
  assert.ok(riser, '段差縦線はhideFlatLineの影響を受けず描かれるはず');

  // 両端縦線（出隅。SILHOUETTE）もhideFlatLineの影響を受けない。
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');
  const leftEnd = silhouetteLines.find(l => l.x1 === 0 && l.x2 === 0);
  assert.ok(leftEnd, '左端の縦線はhideFlatLineの影響を受けず描かれるはず');
  assert.equal(leftEnd.y2, 0, '左端縦線はhideFlatLineの区間でも自身の区間の床y(0)まで届くはず');
});

test('【失敗系・QA修正・実機フィードバック】buildFaceFigure: hideFlatLine未指定(既定)は従来どおり全区間の床線を描く', () => {
  const CH = 2400;
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300 },
  ];
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ ceilingHeight: CH, floorSegments }));
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  const floorHorizontals = cutLines.filter(l => l.y1 === l.y2 && l.y1 !== -CH);
  assert.equal(floorHorizontals.length, 2, 'hideFlatLine未指定なら両区間とも床線が描かれるはず（既存挙動）');
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

  // 両端の縦線（SILHOUETTE）はその端の区間の実際の天井まで届く。
  const silhouetteLines = prims.filter(p => p.type === 'line' && p.weight === 'medium');
  const leftEnd  = silhouetteLines.find(l => l.x1 === 0 && l.x2 === 0);
  const rightEnd = silhouetteLines.find(l => l.x1 === 4000 && l.x2 === 4000);
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
test('【問題修正2026-08その2】buildFaceFigure: 開放先の天井が低い開放スパンは、far天井の見えがかり線（中線実線）が出てアキもそこまでにクランプされる', () => {
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

  // アキの範囲はバツ（対角2本）で見る。上端はfar天井(-2300)までクランプされる。
  const diag = prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 !== p.x2);
  assert.equal(diag.length, 2, 'アキのバツ（対角2本）が出るはず');
  const ys = [...new Set(diag.flatMap(p => [p.y1, p.y2]))].sort((a, b) => a - b);
  assert.deepEqual(ys, [-2300, 0], 'アキはfar天井(-2300)から床(max(-100,0)=0)までのはず');
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

  const diag = prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 !== p.x2);
  const topY = Math.min(...diag.flatMap(p => [p.y1, p.y2]));
  assert.equal(topY, -2400, 'far天井が高い場合、アキの上端は近側の天井断面(-2400)までのはず');
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
  // CUT線は天井1＋床2＋床段差縦線1の計4本（天井段差の縦線は出ない）。
  assert.equal(cutLines.length, 4, `天井段差の縦線は出ないはず（実際:${JSON.stringify(cutLines)}）`);
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

// ---- E2E: 実面・実壁経由で、共有壁の建具が両部屋の面の展開図に描かれる（問題.mdの症状そのもの） ----
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
  const sections = prims.filter(p => p.type === 'rect' && p.h === 2000 && p.y === -2000 + 100);
  assert.equal(sections.length, 3, '断面の[枠][扉][枠]3rectが隅の床基準（+100シフト）で描かれるはず');
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
  const endVerticals = prims.filter(p => p.type === 'line' && p.weight === 'medium' && p.x1 === p.x2);
  const leftEdge = endVerticals.find(p => p.x1 === 0);
  const rightEdge = endVerticals.find(p => p.x1 === face.run);
  assert.ok(leftEdge && rightEdge, '両端の縦線(SILHOUETTE)が見つかるはず');
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

