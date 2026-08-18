// 段差見付け面（stepRiserSegments/buildStepFaces/insertStepFaces）のテスト。
// 実 core.js（Plane/PlanGraph）+ finish/wallGeneration.js で壁を生成した部屋に対して検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { getCellsInRect } from '../finish/gridCells.js';
import { buildRoomFaces } from './elevationFaces.js';
import { stepRiserSegments, buildStepFaces, insertStepFaces, subtractOpenSpanCoverage } from './elevationStepFace.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// 3列(0-2000-4000-6000)×1行(0-3000)の部屋。右列だけ部分指定の子（FLは呼び出し側が設定）。
function makeThreeColumnRoom(graph, childFL) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const midKey   = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`;
  const rightKey = `${x2.id}:${y0.id}:${x3.id}:${y1.id}`;
  const room = graph.addRoom(new Set([leftKey, midKey, rightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  return { room, x0, x1, x2, x3, y0, y1 };
}

test('stepRiserSegments: 部屋内部（壁のない境界）で子が親より高いとき、子側の外形からその境界の区間を抽出する', () => {
  const graph = makeGraph();
  const { room, x2 } = makeThreeColumnRoom(graph, 100);

  const segs = stepRiserSegments(room, graph);
  assert.equal(segs.length, 1, '内部境界1本ぶん、1区間のはず');
  const s = segs[0];
  assert.equal(s.isVertical, true, '境界は縦方向の中心線(x=4000)のはず');
  assert.equal(s.value, x2.value, '境界の位置は内部の仕切りCL(x=4000)のはず');
  assert.equal(s.highFL, 100, '自グループ(子)のFLが高い側のはず');
  assert.equal(s.lowFL, 0, '相手(親)のFLが低い側のはず');
  assert.equal(s.inward, -1, 'inwardは低い側(親=左)へ向かう符号のはず');
});

// ---- 失敗系: 子が親より低い場合は「低い側」からは生成されない（重複排除） ----
test('【失敗系】stepRiserSegments: 子が親より低いFLのときは子側からは見付け面を生成しない（親側だけが生成する）', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, -50);

  const segs = stepRiserSegments(room, graph);
  assert.equal(segs.length, 1, '低い側(子)ではなく高い側(親)グループから1区間生成されるはず');
  assert.equal(segs[0].highFL, 0, '親(左右2列合算)のFLが高い側のはず');
  assert.equal(segs[0].lowFL, -50, '子のFLが低い側のはず');
});

// ---- 失敗系: 親と子のFLが同じなら段差そのものが生じない ----
test('【失敗系】stepRiserSegments: 親と子のFLが同じなら区間は生成されない', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 0);
  assert.equal(stepRiserSegments(room, graph).length, 0);
});

test('buildStepFaces: lo/hiは両端の直交壁面のfaceValueへ詰められ、letter/dirSignは通常面と同じ規則になる', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 100);
  const wallFaces = buildRoomFaces(room, graph);
  const seg = stepRiserSegments(room, graph)[0];
  const parentFL = graph.effectiveFloorLevel(room);

  const face = buildStepFaces(seg, wallFaces, graph, parentFL);
  assert.equal(face.kind, 'step');
  assert.equal(face.letter, 'B', 'isVertical=true・inward=-1はletterOf規則でBのはず');
  assert.equal(face.dirSign, 1, 'DIR_SIGN.B===1のはず');
  // 両端(y=0とy=3000)の直交壁面(A/C)のfaceValueへ詰められる（壁厚ぶんCL値より内側になる）。
  const faceA = wallFaces.find(f => f.letter === 'A');
  const faceC = wallFaces.find(f => f.letter === 'C');
  assert.equal(face.lo, faceA.faceValue, 'lo(小さい方=y=0側)はA面のfaceValueへ詰められるはず');
  assert.equal(face.hi, faceC.faceValue, 'hi(大きい方=y=3000側)はC面のfaceValueへ詰められるはず');
  assert.equal(face.baseFloorDeltaMm, 0, '低い側(親)基準の相対値のはず');
  assert.equal(face.stepHeightMm, 100);
});

// ---- 失敗系: 対応する直交壁面が無い（CORNER_TOL_MM超）場合はCL値のままになる ----
test('【失敗系】buildStepFaces: 対応する直交壁面が見つからなければlo/hiはCL値のまま', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 100);
  const seg = stepRiserSegments(room, graph)[0];
  const parentFL = graph.effectiveFloorLevel(room);
  const face = buildStepFaces(seg, [], graph, parentFL); // wallFaces=空なので直交壁面が見つからない
  assert.equal(face.lo, seg.lo);
  assert.equal(face.hi, seg.hi);
});

// ---- QA修正（幅0の展開図バグの根本原因）: 到達判定を満たすがCORNER_TOL_MMより遠い直交面は
// 候補にしない（旧実装は「その時点でいちばん近い」というだけで採用し、部屋を貫通する遠い壁面へ
// 幅0.5mmの極小段差の両端を誤って引き伸ばしていた）。実グラフ（高さ0.5mmの極小部分指定セル。
// 左右の見付け面が壁面から遠く離れる）で検証する。 ----
test('【失敗系】buildStepFaces: 到達判定を満たしてもCORNER_TOL_MMより遠い直交面は候補にせず、CL値のままフォールバックする', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,      { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1500,   { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1500.5, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000,   { labeled: false, discipline: Discipline.ARCH });

  const cells = getCellsInRect(0, 0, 6000, 3000, graph);
  const narrowCell = cells.find(c => c.x1 === 2000 && c.x2 === 4000 && c.y1 === 1500 && c.y2 === 1500.5);
  const room = graph.addRoom(new Set(cells.map(c => c.key)), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([narrowCell.key]), '極小部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(100);

  const wallFaces = buildRoomFaces(room, graph); // A/Cは部屋を貫通しX方向に幅広（到達判定は満たす）がY方向には遠い
  const parentFL = graph.effectiveFloorLevel(room);
  const narrowSeg = stepRiserSegments(room, graph).find(s => s.isVertical && s.hi - s.lo < 1);
  assert.ok(narrowSeg, '前提: 極小幅(<1mm)の見付け面候補が実在するはず');

  const face = buildStepFaces(narrowSeg, wallFaces, graph, parentFL);
  assert.ok(face.run < 1, `遠い壁面へ誤って引き伸ばされず、極小幅(run=${face.run})のまま保たれるはず`);
});

test('insertStepFaces: 見付け面の始点を含む壁面の直後に挿入され、以降の同letter面は繰り下がる', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 100);
  const wallFaces = buildRoomFaces(room, graph); // A,B,C,D（矩形なので単独letter）
  const before = wallFaces.map(f => f.label);
  assert.deepEqual(before, ['A', 'B', 'C', 'D'], '前提: 段差挿入前はA/B/C/Dの4面のはず');

  const out = insertStepFaces(wallFaces, room, graph);
  assert.equal(out.length, 5, '段差見付け面が1枚増えて5面になるはず');
  const stepIdx = out.findIndex(f => f.kind === 'step');
  const bIdx = out.findIndex(f => f.label === 'B' && f.kind !== 'step');
  assert.equal(stepIdx, 1, '見付け面はA(idx0)の直後(idx1)に挿入されるはず');
  assert.equal(bIdx, 2, '既存Bはidx2へ繰り下がるはず（この時点ではまだ再採番前のためlabelはB）');
});

// ---- 失敗系: 段差が無い部屋はfacesをそのまま返す ----
test('【失敗系】insertStepFaces: 段差が無ければfacesをそのまま返す', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const faces = buildRoomFaces(room, graph);
  assert.equal(insertStepFaces(faces, room, graph), faces, '同じ配列参照がそのまま返るはず');
});

// ==== subtractOpenSpanCoverage（開放スパンとの相互排除） ====
// riserSegs・facesとも実際にstepRiserSegments/composeRoomFacesが返すfieldだけを持つ最小限の
// 合成オブジェクトで直接検証する（elevationFigure.test.jsのmakeFace()と同じ方針）。

// lo/hi=面自身の描画範囲（世界座標。QA修正: subtractOpenSpanCoverageがriserをこの範囲へ
// 丸めるようになったため、spansのopen区間[2000,3000]より広い[1000,3400]を既定にして
// 「open区間の外だが面自身の範囲内」の残り区間を検証できるようにする）。
function makeOpenSpanFace({ axisValue = 6000, inward = 1, originWorld = 3400, dirSign = -1, lo = 1000, hi = 3400 } = {}) {
  return {
    kind: 'wall', isVertical: true, axisCL: { value: axisValue }, inward, originWorld, dirSign, lo, hi,
    spans: [
      { loX: 0, hiX: 400, kind: 'wall' },
      { loX: 400, hiX: 1400, kind: 'open', farFloorDeltaMm: -50 },
    ],
  };
}

test('subtractOpenSpanCoverage: riserが開放スパンの範囲に完全に重なる場合、その区間は差し引かれ0件になる', () => {
  const riser = { isVertical: true, value: 6000, lo: 2000, hi: 3000, inward: 1, highFL: 0, lowFL: -50 };
  const faces = [makeOpenSpanFace()];
  const result = subtractOpenSpanCoverage([riser], faces);
  assert.equal(result.length, 0, `open区間に完全に重なるriserは差し引かれ0件になるはず（実際:${JSON.stringify(result)}）`);
});

// ---- 失敗系: riserが開放スパンの範囲と重ならなければ、そのまま残る ----
test('【失敗系】subtractOpenSpanCoverage: riserが開放スパンと重ならない（面平面外）場合はそのまま残る', () => {
  const riser = { isVertical: true, value: 9999, lo: 2000, hi: 3000, inward: 1, highFL: 0, lowFL: -50 };
  const faces = [makeOpenSpanFace()]; // axisValue=6000。riser.value=9999と一致する面が無い
  const result = subtractOpenSpanCoverage([riser], faces);
  assert.equal(result.length, 1, 'マッチする面が無ければriserはそのまま残るはず');
  assert.equal(result[0].lo, 2000);
  assert.equal(result[0].hi, 3000);
});

// ---- 失敗系: 部分的にしか重ならない場合は、重ならない残りだけが独立したriserとして残る ----
test('【失敗系】subtractOpenSpanCoverage: riserが開放スパンと部分的にしか重ならない場合、残りの区間だけ独立したriserとして残る', () => {
  // open区間の世界座標範囲は[2000,3000]（makeOpenSpanFace参照）。riserを[1500,3000]にすると、
  // [1500,2000]の500mmぶんだけがopen区間の外＝差し引かれず残るはず。
  const riser = { isVertical: true, value: 6000, lo: 1500, hi: 3000, inward: 1, highFL: 0, lowFL: -50 };
  const faces = [makeOpenSpanFace()];
  const result = subtractOpenSpanCoverage([riser], faces);
  assert.equal(result.length, 1, '重ならない残り1区間だけになるはず');
  assert.equal(result[0].lo, 1500);
  assert.equal(result[0].hi, 2000);
});

// ---- 失敗系: 差し引いた残りの幅がMIN_FACE_RUN_MM未満なら捨てる ----
test('【失敗系】subtractOpenSpanCoverage: 差し引いた残りの幅が極小(MIN_FACE_RUN_MM未満)なら捨てる', () => {
  const riser = { isVertical: true, value: 6000, lo: 1999.5, hi: 3000, inward: 1, highFL: 0, lowFL: -50 };
  const faces = [makeOpenSpanFace()];
  const result = subtractOpenSpanCoverage([riser], faces);
  assert.equal(result.length, 0, '残り0.5mm(<MIN_FACE_RUN_MM=1)は捨てられるはず');
});

// ---- QA修正: riserがmatchingFace自身の描画範囲(lo/hi)の外へはみ出す場合、その分は丸められる ----
// riserは輪郭セルの生CL値基準で抽出されるが、matchingFaceのlo/hiは実壁の隅で仕上げ面基準に
// スナップされた値——壁厚みぶん(数十mm)の差でriserがfaceの描画範囲をわずかに超えることがある。
// このはみ出し部分はopen区間に届いていないのではなく、そもそも対応する面が描かれない位置
// なので、差し引き前に面の描画範囲へ丸めて捨てる（幅0付近の見付け面が残るバグの修正）。
test('【失敗系】subtractOpenSpanCoverage: riserがmatchingFaceの描画範囲(lo/hi)を壁厚みぶんはみ出す場合、はみ出し分は残らない', () => {
  // face自身の描画範囲は[2000,3400]（open区間[2000,3000]と同じ下端）。riserがface.lo(2000)より
  // さらに外側(1942.5)まではみ出すケース——このはみ出し57.5mmはopen区間で差し引かれる訳ではなく、
  // face.loの外（対応する面が無い位置）なので丸めで消える。
  const riser = { isVertical: true, value: 6000, lo: 1942.5, hi: 3000, inward: 1, highFL: 0, lowFL: -50 };
  const faces = [makeOpenSpanFace({ lo: 2000, hi: 3400 })];
  const result = subtractOpenSpanCoverage([riser], faces);
  assert.equal(result.length, 0, 'riserの全区間がopen区間[2000,3000]に収まるため0件のはず（face.lo未満のはみ出し分は丸めで消える）');
});
