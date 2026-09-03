// composeRoomFaces（新仕様の面リスト唯一の供給源）・neighborWallFace のテスト。
// 実 core.js（Plane/PlanGraph）+ finish/wallGeneration.js で壁を生成した部屋に対して検証する
// （elevationFaces.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { getCellsInRect } from '../finish/gridCells.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';
import { composeRoomFaces, neighborWallFace, splitFacesAtPartitionWalls, kneeDropRecordFor,
  dropFacesSeenAsSightline } from './elevationFaceList.js';
import { stepRiserSegments } from './elevationStepFace.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function makeRect(graph, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

// ---- 回帰: 段差・袖壁が無い部屋ではcomposeRoomFacesとbuildRoomFacesが構造的に一致する ----
test('composeRoomFaces: 段差・袖壁が無い矩形部屋ではbuildRoomFacesと同じ面配列（label順・件数・主要フィールド）になる', () => {
  const graph = makeGraph();
  const room = makeRect(graph);

  const a = buildRoomFaces(room, graph);
  const b = composeRoomFaces(room, graph);

  assert.equal(b.length, a.length, '面数が一致するはず');
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i].label, a[i].label, `面${i}のlabelが一致するはず`);
    assert.equal(b[i].lo, a[i].lo);
    assert.equal(b[i].hi, a[i].hi);
    assert.equal(b[i].dirSign, a[i].dirSign);
    assert.equal(b[i].kind, undefined, '段差・袖壁が無ければkindは付かないはず');
  }
});

// ---- 段差あり: composeRoomFacesはstep面を挿入し、既存Cは繰り下がる ----
test('composeRoomFaces: 内部（壁のない）段差があると段差見付け面(kind===\'step\')が挿入され、既存の同letter面は繰り下がる', () => {
  const graph = makeGraph();
  // 3列×1行。左列(0-2000)+中央列(2000-4000)=親、右列(4000-6000)は部分指定の子(FL+100)。
  // 中央-右の境界(x=4000)は同室内・壁なしのため、既存機構(wallAdjacentFloorSegments)では
  // 段差が出ない——ここに見付け面が挿入されるはず。
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
  child.setFloorLevel(100);

  const faces = composeRoomFaces(room, graph);
  const steps = faces.filter(f => f.kind === 'step');
  assert.equal(steps.length, 1, '段差見付け面が1枚挿入されるはず');
  assert.equal(steps[0].baseFloorDeltaMm, 0, '低い側(親自身)基準のfloorDeltaMmは0のはず');
  assert.equal(steps[0].stepHeightMm, 100, '段差高さは子のfloorLevel(100)ぶんのはず');

  // 挿入位置: 見付け面の始点を含む壁面Wの直後。既存Bは変わらず、見付け面がB1、既存Bだった
  // 面はB2へ繰り下がる（letterOf(isVertical=true, inward=-1)==='B'のため）。
  const labels = faces.map(f => f.label);
  assert.ok(labels.includes('B1') && labels.includes('B2'), `既存B面が繰り下がるはず（実際:${labels}）`);
  const stepIdx = faces.findIndex(f => f.kind === 'step');
  assert.equal(faces[stepIdx].label, 'B1', '見付け面はB1として先頭に来るはず');
});

// ---- QA修正（幅0の展開図バグ）: MIN_FACE_RUN_MM未満の極小内部FLゾーンは面を生成しない ----
// 段差見付け面の「run」は境界CLの伸びる方向（isVertical=trueなら軸に直交するY方向）の長さで
// 決まる——子セル自体を細くする軸を間違えると再現しない（幅ではなく高さを細くする必要がある）。
// 6000×3000の部屋の中央(x:2000-4000)に、高さ0.5mmだけの極小な部分指定セル(y:1500-1500.5)を
// 埋め込むと、その左右の境界(x=2000・x=4000)の見付け面がrun=0.5mmの極小幅になる。
test('【失敗系】composeRoomFaces: MIN_FACE_RUN_MM(1mm)未満の極小な内部FLゾーンは段差見付け面として出さない（幅0面ガード）', () => {
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
  assert.ok(narrowCell, '前提: 高さ0.5mmの極小セルが1件見つかるはず');
  const room = graph.addRoom(new Set(cells.map(c => c.key)), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([narrowCell.key]), '極小部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(100);

  // 素の段差検出（stepRiserSegments）だけならrun=0.5の極小見付け面候補が実在する前提を確認
  // （このガードが無ければcomposeRoomFacesの最終出力に漏れ出ることの裏取り）。
  const rawRisers = stepRiserSegments(room, graph);
  assert.ok(rawRisers.some(s => s.hi - s.lo < 1), '前提: 極小幅(<1mm)の見付け面候補がstepRiserSegments段階では実在するはず');

  const faces = composeRoomFaces(room, graph);
  const tinyFaces = faces.filter(f => f.run < 1);
  assert.equal(tinyFaces.length, 0, `run<1mmの面は無いはず（実際:${JSON.stringify(faces.map(f => ({ label: f.label, run: f.run })))}）`);
});

// ---- 失敗系: neighborWallFaceは段差見付け面をスキップして実壁面を返す ----
test('【失敗系】neighborWallFace: 段差見付け面(kind===\'step\')を挟んでも実壁面同士を隣接として返す', () => {
  const faces = [
    { label: 'A', kind: undefined },
    { label: 'B1', kind: 'step' },
    { label: 'B2', kind: undefined },
    { label: 'C', kind: undefined },
  ];
  // index=0(A)から見て次(dir=1)はB1(step)をスキップしB2になるはず。
  assert.equal(neighborWallFace(faces, 0, 1).label, 'B2');
  // index=2(B2)から見て前(dir=-1)はB1(step)をスキップしAになるはず。
  assert.equal(neighborWallFace(faces, 2, -1).label, 'A');
});

// ---- 失敗系: 全てstepの場合はnullを返す ----
test('【失敗系】neighborWallFace: 面が2枚未満、または全てstepなら null を返す', () => {
  assert.equal(neighborWallFace([{ label: 'A', kind: undefined }], 0, 1), null);
  const allStep = [{ label: 'A', kind: 'step' }, { label: 'B', kind: 'step' }];
  assert.equal(neighborWallFace(allStep, 0, 1), null);
});

// ==== 仕様2: splitFacesAtPartitionWalls（袖壁・腰壁の面分割） ====

// 矩形部屋(0-6000×0-3000)＋面A(y=0)の内側へ突き出す袖壁（x=3000。isRoomWall/isExteriorWallとも
// false＝室内自立の間仕切り壁）を1本追加する。
function makeRoomWithSleeveWall(graph, { spanMm = 500, knee = null } = {}) {
  const room = makeRect(graph, 'LDK');
  const sleeveAxis = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 0);
  const ySpan = graph.addCenterLine(CenterLineType.HORIZONTAL, spanMm, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(sleeveAxis, 0, true, y0, 0, ySpan, 0, { isRoomWall: false, isExteriorWall: false });
  if (knee) {
    graph.setKneeDropWall(edgeKey(sleeveAxis.id, y0.id, ySpan.id), knee);
  }
  return { room, wall, sleeveAxis, y0, ySpan };
}

test('splitFacesAtPartitionWalls: 面まで到達し室内へ十分突き出す袖壁は面を2断片に分割する（境界一致・幅合計不変）', () => {
  const graph = makeGraph();
  const { room } = makeRoomWithSleeveWall(graph);
  const faces = buildRoomFaces(room, graph);
  const faceA = faces.find(f => f.label === 'A');

  const out = splitFacesAtPartitionWalls(faces, room, graph);
  const aFrags = out.filter(f => f.letter === 'A');
  assert.equal(aFrags.length, 2, '袖壁1本で面Aは2断片になるはず');

  // 断片boundary一致: 断片は各々が自分のローカル座標系(x=0起点)を持つため、比較は世界座標
  // （face.lo/hi。両断片とも同じ袖壁CLの位置を指す）で行う——faceBoundaryLocalXは断片ごとに
  // originWorldが異なるため、その戻り値同士をそのまま比較しても意味を持たない。
  assert.ok(Math.abs(aFrags[0].hi - aFrags[1].lo) < 1e-6,
    `断片1の右端(${aFrags[0].hi})と断片2の左端(${aFrags[1].lo})が世界座標で一致するはず`);
  // 同じ袖壁CL idを参照している（faceBoundaryLocalX基準の境界も、それぞれの断片内では
  // 自分自身のrun全体=boundary.lo=0〜boundary.hi=runと整合しているはず）。
  assert.equal(aFrags[0].endCLId, aFrags[1].startCLId, '両断片は同じ袖壁CL idを参照するはず');
  const b1 = faceBoundaryLocalX(aFrags[0], graph);
  const b2 = faceBoundaryLocalX(aFrags[1], graph);
  assert.ok(Math.abs(b1.hi - aFrags[0].run) < 1e-6, '断片1自身のboundary.hiは自分のrun端と一致するはず');
  assert.ok(Math.abs(b2.lo - 0) < 1e-6, '断片2自身のboundary.loは自分のrun始端(0)と一致するはず');

  // 幅合計===元の面の幅（lo/hiベースのrun合計）。
  const totalRun = aFrags.reduce((sum, f) => sum + f.run, 0);
  assert.ok(Math.abs(totalRun - faceA.run) < 1e-6, `断片の幅合計(${totalRun})は元の面の幅(${faceA.run})と一致するはず`);

  // 分割端はhasWallAtLocal*=false（続き表現）。元の面端（袖壁で切られていない側）はtrueのまま。
  assert.equal(aFrags[0].hasWallAtLocal0, faceA.hasWallAtLocal0, '断片1の始端は元の面端のままのはず');
  assert.equal(aFrags[0].hasWallAtLocalRun, false, '断片1の終端(袖壁側)はfalseのはず');
  assert.equal(aFrags[1].hasWallAtLocal0, false, '断片2の始端(袖壁側)はfalseのはず');
  assert.equal(aFrags[1].hasWallAtLocalRun, faceA.hasWallAtLocalRun, '断片2の終端は元の面端のままのはず');

  // partitionCutAtLocal*は分割端にだけ付く。
  assert.equal(aFrags[0].partitionCutAtLocal0, null);
  assert.ok(aFrags[0].partitionCutAtLocalRun, '断片1の分割端にはpartitionCutAtLocalRunが付くはず');
  assert.ok(aFrags[1].partitionCutAtLocal0, '断片2の分割端にはpartitionCutAtLocal0が付くはず');
  assert.equal(aFrags[1].partitionCutAtLocalRun, null);
});

// ---- 腰壁: kneeDropWallsにknee指定があればpartitionCutAt*.topHeightMmがknee.topHeightになる ----
test('splitFacesAtPartitionWalls: 腰壁（kneeDropWallsにknee指定）はpartitionCutAt*.topHeightMmがknee.topHeightになる', () => {
  const graph = makeGraph();
  const { room } = makeRoomWithSleeveWall(graph, { knee: { knee: { topHeight: 900 } } });
  const faces = buildRoomFaces(room, graph);
  const out = splitFacesAtPartitionWalls(faces, room, graph);
  const aFrags = out.filter(f => f.letter === 'A');
  assert.equal(aFrags[0].partitionCutAtLocalRun.topHeightMm, 900, '腰壁指定の高さが伝わるはず');
});

// ---- 失敗系: knee指定が無ければtopHeightMmはnull（=天井まで） ----
test('【失敗系】splitFacesAtPartitionWalls: 腰壁指定が無ければpartitionCutAt*.topHeightMmはnull（天井まで）', () => {
  const graph = makeGraph();
  const { room } = makeRoomWithSleeveWall(graph);
  const faces = buildRoomFaces(room, graph);
  const out = splitFacesAtPartitionWalls(faces, room, graph);
  const aFrags = out.filter(f => f.letter === 'A');
  assert.equal(aFrags[0].partitionCutAtLocalRun.topHeightMm, null);
});

// ---- 失敗系: 面の仕上げ面まで届かない壁は分割しない ----
test('【失敗系】splitFacesAtPartitionWalls: 面まで届かない壁（面の内側で終わり仕上げ面に到達しない）は分割しない', () => {
  const graph = makeGraph();
  const room = makeRect(graph, 'LDK');
  const sleeveAxis = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  // 壁のスパンをy=[500,1000]にする——面A(y=0付近)の仕上げ面まで届かない（TOUCH_TOL=150を超えて離れている）。
  const y500  = graph.addCenterLine(CenterLineType.HORIZONTAL, 500,  { labeled: false, discipline: Discipline.ARCH });
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(sleeveAxis, 0, true, y500, 0, y1000, 0, { isRoomWall: false, isExteriorWall: false });

  const faces = buildRoomFaces(room, graph);
  const out = splitFacesAtPartitionWalls(faces, room, graph);
  assert.equal(out.filter(f => f.letter === 'A').length, 1, '届かない壁は面Aを分割しないはず');
});

// ---- 失敗系: 突出量がMIN_PROJECTION_MM未満の壁は分割しない ----
test('【失敗系】splitFacesAtPartitionWalls: 室内側への突出がMIN_PROJECTION_MM(100mm)未満の壁は分割しない', () => {
  const graph = makeGraph();
  const { room } = makeRoomWithSleeveWall(graph, { spanMm: 90 }); // 仕上げ面(~57.5)から90mmでは突出約32.5mm<100mm
  const faces = buildRoomFaces(room, graph);
  const out = splitFacesAtPartitionWalls(faces, room, graph);
  assert.equal(out.filter(f => f.letter === 'A').length, 1, '突出不足の壁は面Aを分割しないはず');
});

// ---- 統合: composeRoomFacesは分割後にlabelFacesを再実行しA1/A2へ採番する ----
test('composeRoomFaces: 袖壁で分割された面はA1/A2へ再採番される', () => {
  const graph = makeGraph();
  const { room } = makeRoomWithSleeveWall(graph);
  const labels = composeRoomFaces(room, graph).map(f => f.label);
  assert.ok(labels.includes('A1') && labels.includes('A2'), `A1/A2に再採番されるはず（実際:${labels}）`);
});

// ---- kneeDropRecordFor: axisCLId一致＋スパン重なりでレコードを返す ----
test('kneeDropRecordFor: axisCLId一致かつスパンが重なるkneeDropWallsのレコードを返す', () => {
  const graph = makeGraph();
  const { room, wall } = makeRoomWithSleeveWall(graph, { knee: { knee: { topHeight: 900 } } });
  void room;
  const rec = kneeDropRecordFor(wall, graph);
  assert.equal(rec?.knee?.topHeight, 900);
});

// ---- 失敗系: axisCLIdが一致してもスパンが重ならなければnull ----
test('【失敗系】kneeDropRecordFor: スパンが重ならなければnullを返す', () => {
  const graph = makeGraph();
  const { room, wall, sleeveAxis } = makeRoomWithSleeveWall(graph);
  void room;
  // wallのスパン外(y=[2000,2500])にkneeDropWallsエントリを置く。
  const y2000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y2500 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2500, { labeled: false, discipline: Discipline.ARCH });
  graph.setKneeDropWall(edgeKey(sleeveAxis.id, y2000.id, y2500.id), { knee: { topHeight: 900 } });
  assert.equal(kneeDropRecordFor(wall, graph), null);
});

// ==== QA修正M1: 統合シームのテスト（clipSpans配線の検証） ====
// 「他室(壁あり)→部分指定の子(壁なし・同室継続)」という開放スパンが出る形状に、面自身の軸CLから
// 室内へ向かう袖壁（makeRoomWithSleeveWallと同じ安全なパターン。壁を交差させると自動トリムで
// 座標がずれるため、面自身の軸CLを起点にする）を追加し、composeRoomFacesが返す各断片の
// spansが断片自身のローカル座標系[0,run]へ正しくクリップ・再原点化されていることを検証する。
test('composeRoomFaces: 開放スパンを持つ面が袖壁で分割されたとき、各断片のspansが断片自身の[0,run]へクリップ・再原点化される', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });

  const otherKey = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`; // 上段右＝他室（実壁の原因）
  const mainTopKey = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const mainBotLeftKey = `${x0.id}:${y1.id}:${x1.id}:${y2.id}`;
  const mainBotRightKey = `${x1.id}:${y1.id}:${x2.id}:${y2.id}`; // 下段右＝部分指定の子（壁なし継続）
  const other = graph.addRoom(new Set([otherKey]), '他室');
  generateRoomWallsFromOutline(graph, other);
  const room = graph.addRoom(new Set([mainTopKey, mainBotLeftKey, mainBotRightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([mainBotRightKey]), '部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  // x=2000の面（wall区間y:0-1000, open区間y:1000-2000）に、面自身の軸CL(x1)から室内へ向かう
  // 袖壁を追加する（makeRoomWithSleeveWallと同じ安全パターン）——wall区間の途中(y=500)で
  // 面を分割する。
  const ySleeve = graph.addCenterLine(CenterLineType.HORIZONTAL, 500,  { labeled: false, discipline: Discipline.ARCH });
  const xInner  = graph.addCenterLine(CenterLineType.VERTICAL, 1800, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(ySleeve, 0, false, x1, 0, xInner, 0, { isRoomWall: false, isExteriorWall: false });

  const faces = composeRoomFaces(room, graph);
  // 面自身の軸(x=2000)を持つ非step面（袖壁で分割された断片群）を集める。
  const fragments = faces.filter(f => f.kind !== 'step' && f.isVertical && Math.abs(f.axisCL.value - 2000) < 1e-6);
  assert.ok(fragments.length >= 2, `袖壁により2断片以上に分割されるはず（実際:${fragments.length}件）`);

  for (const f of fragments) {
    assert.ok(Array.isArray(f.spans) && f.spans.length > 0, `${f.label}はspansを持つはず`);
    // 断片自身のローカル座標系[0,run]をspansが隙間なく・超過なく覆う。
    assert.equal(f.spans[0].loX, 0, `${f.label}のspans先頭はloX=0のはず`);
    assert.ok(Math.abs(f.spans[f.spans.length - 1].hiX - f.run) < 1e-6,
      `${f.label}のspans末尾hiX(${f.spans[f.spans.length - 1].hiX})は断片自身のrun(${f.run})と一致するはず（親のrunへはみ出していないはず）`);
    for (let i = 0; i + 1 < f.spans.length; i++) {
      assert.equal(f.spans[i].hiX, f.spans[i + 1].loX, `${f.label}のspansは隙間なく連続するはず`);
    }
    for (const s of f.spans) {
      assert.ok(s.loX >= 0 && s.hiX <= f.run + 1e-6, `${f.label}のspan[${s.loX},${s.hiX}]は断片の範囲[0,${f.run}]を超えないはず`);
    }
  }
  // 少なくとも1断片はopen区間を持つ（開放スパンが分割後も残っていることの確認）。
  assert.ok(fragments.some(f => f.spans.some(s => s.kind === 'open')), '少なくとも1断片はopen区間を持つはず');
});

// ---- 見えがかりに取り込まれた面は落とす（ユーザー明示指示2026-08） ----
// 「「5」D1に描画済なのでD2パネルを削除」——同じ壁面を2枚のパネルに描かないための規則。
const sightFace = (axis, lo, hi) => ({
  isVertical: true, inward: 1, axisCL: { effectiveValue: axis }, lo, hi, letter: 'D',
});

test('【明示指示】dropFacesSeenAsSightline: 手前の面に丸ごと見えている奥の面は落とす', () => {
  const near = sightFace(-3000, -3500, -57.5);   // 実機「5」D1（吹抜けと合成後の走り範囲）
  const far = sightFace(-3400, -1057.5, -57.5);  // 実機「5」D2（400奥・全長が手前の面に収まる）
  assert.deepEqual(dropFacesSeenAsSightline([near, far], { walls: [] }), [near]);
});

test('【失敗系】dropFacesSeenAsSightline: 見えがかりの奥行きを超える面は落とさない', () => {
  const near = sightFace(-3000, -3500, -57.5);
  const far = sightFace(-6200, -1942.5, -1057.5); // 3200奥＝アキになる距離なので見えていない
  assert.deepEqual(dropFacesSeenAsSightline([near, far], { walls: [] }).length, 2);
});

test('【失敗系】dropFacesSeenAsSightline: 走り範囲がはみ出す面は落とさない', () => {
  const near = sightFace(-3000, -3500, -2000);
  const far = sightFace(-3400, -1057.5, -57.5);  // 手前の面の外にある＝その図に現れない
  assert.equal(dropFacesSeenAsSightline([near, far], { walls: [] }).length, 2);
});

test('【失敗系】dropFacesSeenAsSightline: 手前の面に壁があれば奥は隠れるので落とさない', () => {
  const near = sightFace(-3000, -3500, -57.5);
  const far = sightFace(-3400, -1057.5, -57.5);
  const walls = [{ isVertical: true, axisCL: { effectiveValue: -3000 }, coord1: -1500, coord2: 0 }];
  assert.equal(dropFacesSeenAsSightline([near, far], { walls }).length, 2);
});

test('【失敗系】dropFacesSeenAsSightline: 逆向きの面（背中合わせ）は取り込みにならない', () => {
  const near = sightFace(-3000, -3500, -57.5);
  const far = { ...sightFace(-3400, -1057.5, -57.5), inward: -1 };
  assert.equal(dropFacesSeenAsSightline([near, far], { walls: [] }).length, 2);
});
