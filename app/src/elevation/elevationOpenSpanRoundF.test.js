// 開放スパン（elevationOpenSpan.js）の受け入れ検証: ユーザー報告のRound Fフィクスチャ
// （8セル領域a-h・中心2/中心6のextent短縮延長・部分指定2'/3'）を実CLで固定化し、
// D1（room2）・B1（room3）の構造（spans=[wall,open]・ROW1・遠側床線・あき・境界エッジ・
// 段差見付け面との相互排除）を検証する。座標derivationはコーディネーター確定値
// （X1=0,中心2=3400,中心5=4600,中心6=6000,X2=7000 / Y2=0,中心1=2000,中心3=3000,
// 中心7=3400,中心4=4000,Y1=7000）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { getCellsInRect } from '../finish/gridCells.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { faceBoundaryLocalX } from './elevationFaces.js';
import { collectRow1SplitPoints } from './elevationDimSplit.js';
import { buildFaceFigure } from './elevationFigure.js';
import { wallAdjacentFloorSegments } from './elevationFloorProfile.js';

function buildRoundFFixture() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);

  const X1 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const C2 = graph.addCenterLine(CenterLineType.VERTICAL, 3400, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 4600, { labeled: false, discipline: Discipline.ARCH });
  const C6 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const X2 = graph.addCenterLine(CenterLineType.VERTICAL, 7000, { labeled: false, discipline: Discipline.ARCH });

  const Y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const C1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const C3 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const C7 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3400, { labeled: false, discipline: Discipline.ARCH });
  const C4 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const Y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 7000, { labeled: false, discipline: Discipline.ARCH });
  void C7;

  graph.setCenterLineExtentRef(C2, 'lo', { clId: C3.id, offset: 0 });
  graph.setCenterLineExtentRef(C2, 'hi', { clId: Y1.id, offset: 0 });
  graph.setCenterLineExtentRef(C6, 'lo', { clId: C1.id, offset: 0 });
  graph.setCenterLineExtentRef(C6, 'hi', { clId: C4.id, offset: 0 });

  const cells = getCellsInRect(X1.value, Y2.value, X2.value, Y1.value, graph);
  function classify(x1, x2, y1, y2) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const col = mx < 3400 ? 0 : mx < 4600 ? 1 : mx < 6000 ? 2 : 3;
    const row = my < 2000 ? 0 : my < 3000 ? 1 : my < 3400 ? 2 : my < 4000 ? 3 : 4;
    if (row === 0) return { room: '1' };
    if (row === 1) return { room: '2', part: col === 3 ? 'c' : 'd' };
    if (row === 2) return col === 0 ? { room: '2', part: 'd' } : col === 3 ? { room: '2', part: 'b' } : col === 1 ? { room: '3', part: 'g' } : { room: '4' };
    if (row === 3) return col === 0 ? { room: '2', part: 'd' } : col === 3 ? { room: '3', part: 'e' } : col === 1 ? { room: '3', part: 'g' } : { room: '4' };
    return col === 0 ? { room: '2', part: 'd' } : { room: '3', part: 'f' };
  }
  const buckets = { '1': [], '2': [], '3': [], '4': [] };
  const room2NonB = [], room3NonG = [];
  for (const c of cells) {
    const { room, part } = classify(c.x1, c.x2, c.y1, c.y2);
    buckets[room].push(c.key);
    if (room === '2' && part !== 'b') room2NonB.push(c.key);
    if (room === '3' && part !== 'g') room3NonG.push(c.key);
  }
  const room1 = graph.addRoom(new Set(buckets['1']), '1');
  const room2 = graph.addRoom(new Set(buckets['2']), '2');
  const room3 = graph.addRoom(new Set(buckets['3']), '3');
  const room4 = graph.addRoom(new Set(buckets['4']), '4');
  generateRoomWallsFromOutline(graph, room1);
  generateRoomWallsFromOutline(graph, room2);
  generateRoomWallsFromOutline(graph, room3);
  generateRoomWallsFromOutline(graph, room4);
  const room2p = graph.addRoom(new Set(room2NonB), "2'", undefined, new Set([room2.id]));
  room2p.setFloorLevel(-50);
  const room3p = graph.addRoom(new Set(room3NonG), "3'", undefined, new Set([room3.id]));
  room3p.setFloorLevel(100);

  return { graph, room1, room2, room3, room4, room2p, room3p };
}

test('Round Fフィクスチャ: room2のD1はspans=[wall 400, open(-50)]・ROW1=400+1000（中心1..中心3..中心7）になる', () => {
  const { graph, room2 } = buildRoundFFixture();
  const faces = composeRoomFaces(room2, graph);
  const d1 = faces.find(f => f.label === 'D1');
  assert.ok(d1, 'D1面が見つかるはず');
  assert.equal(d1.spans.length, 2, `spansはwall+openの2区間のはず（実際:${JSON.stringify(d1.spans)}）`);
  assert.equal(d1.spans[0].kind, 'wall');
  assert.equal(d1.spans[1].kind, 'open');
  assert.equal(d1.spans[1].farFloorDeltaMm, -50, '開放先(2\')のFL差-50が伝わるはず');

  const boundary = faceBoundaryLocalX(d1, graph);
  const splits = collectRow1SplitPoints(d1, graph, { floorSegments: undefined, boundary, spans: d1.spans });
  const marks = [boundary.lo, ...splits, boundary.hi];
  const widths = marks.slice(1).map((m, i) => Math.round(m - marks[i]));
  assert.deepEqual(widths, [400, 1000], `ROW1は中心1..中心3..中心7=400+1000のはず（実際:${JSON.stringify(widths)}）`);
});

test('Round Fフィクスチャ: room3のB1はspans=[wall 400, open(+100)]になる（立ち上がり100）', () => {
  const { graph, room3 } = buildRoundFFixture();
  const faces = composeRoomFaces(room3, graph);
  const b1 = faces.find(f => f.label === 'B1');
  assert.ok(b1, 'B1面が見つかるはず');
  assert.equal(b1.spans.length, 2, `spansはwall+openの2区間のはず（実際:${JSON.stringify(b1.spans)}）`);
  assert.equal(b1.spans[0].kind, 'wall');
  assert.equal(b1.spans[1].kind, 'open');
  assert.equal(b1.spans[1].farFloorDeltaMm, 100, '開放先(3\')のFL差+100が伝わるはず');
});

test('Round Fフィクスチャ: D1のbuildFaceFigureは遠側床線を重複させず（wallAdjacentFloorSegmentsが既に同じ高さのCUT線を描くため）・上部あき・境界エッジを描く', () => {
  const { graph, room2 } = buildRoundFFixture();
  const faces = composeRoomFaces(room2, graph);
  const d1 = faces.find(f => f.label === 'D1');
  const floorSegments = wallAdjacentFloorSegments(d1, room2, graph);
  const CH = 2400;
  const prims = buildFaceFigure(d1, { graph, project: null, room: room2, ceilingHeight: CH, materialMap: null, gridCLs: [], floorSegments });

  const openSpan = d1.spans.find(s => s.kind === 'open');
  // 前提: D1はPhase1のnear側修正により、wallAdjacentFloorSegments（segs）自体が既に
  // open区間と同じ高さ(y=50=-(-50))のCUT(太)水平線を描いている（near側セルの延長がsegsにも
  // 反映されるため）。この場合、開放スパン側の「遠側床線」はfarDelta===nearDeltaとなり、
  // 重複したSILHOUETTE線を追加しない（見た目上の二重線を避ける設計どおり）。
  // segsの水平線は「段差位置のCLオフセット」(drawnRiserX)により低い側へ半壁厚ずれた位置
  // （raw境界342.5ではなく400）から始まる——ここではopen区間のhiX(=1285)側の端が一致すること、
  // かつ開始xがopen区間の範囲内（loX以上）にあることで「segs自体が代替表現している」ことを確認する。
  const cutFarLine = prims.find(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 === 50 &&
    p.x1 >= openSpan.loX && p.x2 === openSpan.hiX);
  assert.ok(cutFarLine, `segs自体が既にopen区間と同じ高さのCUT線を描いているはず（実際の全line:${JSON.stringify(prims.filter(p => p.type === 'line'))}）`);
  const silhouetteFarLine = prims.find(p => p.type === 'line' && p.weight === 'medium' && p.y1 === p.y2 && p.y1 === 50 &&
    p.x1 === openSpan.loX && p.x2 === openSpan.hiX);
  assert.equal(silhouetteFarLine, undefined, 'segsと同じ高さのSILHOUETTE遠側床線は重複して描かれないはず');

  // 上部あき（appendGapMark。rect＋対角2本＋「ア キ」テキスト。ユーザー差し戻し2026-08で復元）。
  const gapRect = prims.find(p => p.type === 'rect' && p.x === openSpan.loX && p.y === -CH);
  assert.ok(gapRect, '上部あきのrectが見つかるはず');
  assert.equal(gapRect.h, CH - openSpan.farFloorDeltaMm, 'あきの高さはCH-farFloorDeltaMm(2400-(-50)=2450)のはず');
  assert.ok(prims.some(p => p.type === 'text' && p.text === 'ア キ'), '「ア キ」テキストが見つかるはず');

  // 境界エッジ: open区間のloX側（隣がwall区間）にSILHOUETTE縦線。
  const edge = prims.find(p => p.type === 'line' && p.weight === 'medium' && p.x1 === openSpan.loX && p.x2 === openSpan.loX && p.y2 === -CH);
  assert.ok(edge, '境界エッジ（open区間の壁側端の中線縦線）が見つかるはず');
});

test('Round Fフィクスチャ: D1・B1の位置には段差見付け面（step面）が独立して重ならない（相互排除）', () => {
  const { graph, room2, room3 } = buildRoundFFixture();
  const faces2 = composeRoomFaces(room2, graph);
  const faces3 = composeRoomFaces(room3, graph);
  // room2の残存段差riser（b/c境界）は、matchingFace(C3)自身の描画範囲(仕上げ面基準)を
  // はみ出す壁厚みぶんの残差(57.5mm)しか無く、open区間の外にはみ出す部分が「面が描かれない
  // 位置」であるため丸めにより0件に収束する（QA修正: 幅0付近の見付け面が残っていたバグを修正）。
  assert.equal(faces2.filter(f => f.kind === 'step').length, 0, 'room2のstep面は開放スパンで完全に吸収され0件のはず');
  // room3のC1（3'とgの境界。面平面上に対応する壁面が無い純粋な内部段差）は引き続き1件残る。
  assert.equal(faces3.filter(f => f.kind === 'step').length, 1, 'room3のstep面は従来どおり1件（C1）のはず');
  // D1/B1自身の軸(中心6・中心5)・inwardに一致する独立step面は無いはず。
  const d1 = faces2.find(f => f.label === 'D1');
  const spuriousForD1 = faces2.filter(f => f.kind === 'step' && f.axisCL.value === d1.axisCL.value && f.inward === d1.inward);
  assert.equal(spuriousForD1.length, 0, 'D1の軸に重なる独立段差見付け面は無いはず（開放スパンが表現を担うため）');
});

// ---- ユーザー報告項目2・3の根本原因（QA修正）: 自室セルがfar側の部屋境界より粗い場合の誤分類 ----
test('Round Fフィクスチャ: room2の「中心3」面（b/d境界）はg/hの他室区間を挟んで途切れず、spansが隙間なく0..runを覆う', () => {
  const { graph, room2 } = buildRoundFFixture();
  const faces = composeRoomFaces(room2, graph);
  // 中心3(y=3000)上・inward=-1の面。row1（自室・部分指定2'）がextent制限で1セルに
  // 統合されているため、1点プローブだと"g"(room3)の区間を誤ってopen扱いしてしまうバグがあった。
  const face = faces.find(f => !f.isVertical && Math.abs(f.axisCL.value - 3000) < 1e-6 && f.inward === -1);
  assert.ok(face, '中心3・inward=-1の面が見つかるはず');
  assert.equal(face.spans.length, 3, `open(b側)+wall(g/h側)+open(d側)の3区間のはず（実際:${JSON.stringify(face.spans)}）`);
  assert.equal(face.spans[0].loX, 0);
  assert.equal(face.spans[face.spans.length - 1].hiX, face.run);
  for (let i = 0; i + 1 < face.spans.length; i++) {
    assert.equal(face.spans[i].hiX, face.spans[i + 1].loX, '隙間なく連続するはず（g/h他室区間を誤ってopen扱いしていた旧バグの回帰確認）');
  }
  assert.equal(face.spans[0].kind, 'open');
  assert.equal(face.spans[1].kind, 'wall', 'g/h（他室）区間はwallのはず（旧バグではopenへ誤吸収されていた）');
  assert.equal(face.spans[2].kind, 'open');
});

test('Round Fフィクスチャ: room3の「中心4」面（e/g境界）も同様にf/hの他室区間を挟んで途切れず、spansが隙間なく0..runを覆う', () => {
  const { graph, room3 } = buildRoundFFixture();
  const faces = composeRoomFaces(room3, graph);
  const face = faces.find(f => !f.isVertical && Math.abs(f.axisCL.value - 4000) < 1e-6 && f.inward === 1);
  assert.ok(face, '中心4・inward=1の面が見つかるはず');
  assert.ok(face.spans.length >= 2, `複数区間へ延長されるはず（実際:${JSON.stringify(face.spans)}）`);
  assert.equal(face.spans[0].loX, 0);
  assert.equal(face.spans[face.spans.length - 1].hiX, face.run);
  for (let i = 0; i + 1 < face.spans.length; i++) {
    assert.equal(face.spans[i].hiX, face.spans[i + 1].loX, '隙間なく連続するはず');
  }
});

// ---- 失敗系: 通常部屋（開放スパンが生じない）はcomposeRoomFacesの構造がbuildRoomFacesと一致する ----
test('【失敗系】Round Fフィクスチャ: room1（開放スパンが生じない単純な部屋）はspans=[wall]1区間のみになる', () => {
  const { graph, room1 } = buildRoundFFixture();
  const faces = composeRoomFaces(room1, graph);
  for (const f of faces) {
    assert.equal(f.spans.length, 1, `${f.label}はspans1区間のみのはず（実際:${JSON.stringify(f.spans)}）`);
    assert.equal(f.spans[0].kind, 'wall');
  }
});

// ==== ユーザー報告6点（2026-08-18）＋差し戻し後の明示指示（2026-08-18その2）: 「2」（room2）を
// 先に確定し、「3」（room3）の修正後も「2」が緑のままであることを保証する。
// 詳細は.claude/elevation-model.md「開放スパン」節参照。====
// 差し戻し: 「アキ」マーク全廃は指示範囲外の拡大解釈だったため復元済み（上のD1テストで固定）。
// 以降は「非描画バグ修正（維持）」＋「新規の明示指示2点（C1線種・A2破線）」のみを対象にする。

// 項目4: room3のC1（段差見付け面）はROW1境界が幅0に退化せず、A1と同じ1200幅になる
// （elevationStepFace.jsのbuildStepFacesがstartCLId/endCLIdへ段差自身の軸を誤って詰めていたバグ）。
test('ユーザー報告item4: room3のC1（段差見付け面）のROW1境界は幅0に退化せず、隣接するA1と同じ1200のはず', () => {
  const { graph, room3 } = buildRoundFFixture();
  const faces = composeRoomFaces(room3, graph);
  const c1 = faces.find(f => f.label === 'C1');
  const a1 = faces.find(f => f.label === 'A1');
  assert.ok(c1 && c1.kind === 'step', 'C1（段差見付け面）が見つかるはず');
  const boundary = faceBoundaryLocalX(c1, graph);
  assert.ok(boundary.hi - boundary.lo > 1000, `C1のROW1境界幅は0に退化しないはず（実際:${JSON.stringify(boundary)}）`);
  const a1Boundary = faceBoundaryLocalX(a1, graph);
  assert.equal(Math.round(boundary.hi - boundary.lo), Math.round(a1Boundary.hi - a1Boundary.lo),
    'C1とA1は同じ2本の直交壁(D2・B1)に挟まれるため、ROW1幅は一致するはず');
});

// 新規の明示指示: room3のA2の「1200」幅（開放スパン部分。near(+100)よりfar(g,0)が低い＝
// 見下ろし方向）は、1FL線（遠側床線）と左右の縦線（境界エッジ）をdash付き（中線・破線）にする
// （ユーザー差し戻し後の明示指示。前ラウンドの「近側〜远側の接続部だけ破線」という限定規則は
// 撤回し、遠側床線本体＋両端の境界エッジを含めて破線にする形へ置き換えた）。
test('新規指示: room3のA2の「1200」開放区間（見下ろし方向）は遠側床線・左右の境界エッジがdash付きになる', () => {
  const { graph, room3 } = buildRoundFFixture();
  const faces = composeRoomFaces(room3, graph);
  const a2 = faces.find(f => f.label === 'A2');
  assert.ok(a2, 'A2が見つかるはず');
  const floorSegments = wallAdjacentFloorSegments(a2, room3, graph);
  const CH = 2400;
  const prims = buildFaceFigure(a2, { graph, project: null, room: room3, ceilingHeight: CH, materialMap: null, gridCLs: [], floorSegments });

  const span = a2.spans[0]; // open(g側。farFloorDeltaMm:0)。near(segsのdelta100)より低い＝見下ろし方向。
  assert.equal(span.kind, 'open');
  assert.equal(span.farFloorDeltaMm, 0);

  // 遠側床線（y=-far=0、x:loX..hiX）はdash付き。
  const farLine = prims.find(p => p.type === 'line' && p.dash === 'dashed' &&
    p.y1 === 0 && p.y2 === 0 && p.x1 === span.loX && p.x2 === span.hiX);
  assert.ok(farLine, `遠側床線はdash付きのはず（実際:${JSON.stringify(prims.filter(p => p.type === 'line' && p.y1 === p.y2))}）`);

  // 左側境界エッジ（x=loX=0。面端）・右側境界エッジ（x=hiX。wall区間との境界）も両方dash付き。
  const leftEdge = prims.find(p => p.type === 'line' && p.dash === 'dashed' &&
    p.x1 === span.loX && p.x2 === span.loX && p.y2 === -CH);
  assert.ok(leftEdge, `左側の境界エッジ(x=${span.loX})はdash付きのはず`);
  const rightEdge = prims.find(p => p.type === 'line' && p.dash === 'dashed' &&
    p.x1 === span.hiX && p.x2 === span.hiX && p.y2 === -CH);
  assert.ok(rightEdge, `右側の境界エッジ(x=${span.hiX})はdash付きのはず`);
});

// 新規の明示指示: room3のC1（段差見付け面）は両端の縦線が壁断面（CUT=太）のまま、
// 見付けの水平線（1FL+100の線＝高い側床線）はSILHOUETTE（中線）になる
// （旧実装は見付け上端も含め全てCUTで描いていた。両端縦線はCUTのまま変更なし）。
// QA修正（ユーザー明示指示2026-08その3）: 両端縦線はtopY（見付け上端）で止めず天井(-CH)まで描く
// （見付け上端はあくまで見えがかり線で、壁自体は天井まで続くため）。
test('新規指示: room3のC1（段差見付け面）は両端縦線=CUT（壁断面。床〜天井）・見付け上端=SILHOUETTE（中線）', () => {
  const { graph, room3 } = buildRoundFFixture();
  const faces = composeRoomFaces(room3, graph);
  const c1 = faces.find(f => f.label === 'C1');
  assert.ok(c1 && c1.kind === 'step', 'C1（段差見付け面）が見つかるはず');
  const CH = 2400;
  const prims = buildFaceFigure(c1, { graph, project: null, room: room3, ceilingHeight: CH, materialMap: null, gridCLs: [] });

  const floorY = -c1.baseFloorDeltaMm;
  const topY = -(c1.baseFloorDeltaMm + c1.stepHeightMm);
  const leftWall = prims.find(p => p.type === 'line' && p.weight === 'thick' &&
    p.x1 === 0 && p.x2 === 0 && p.y1 === floorY && p.y2 === -CH);
  assert.ok(leftWall, `左端縦線はCUT(太)=壁断面・天井(-CH)までのはず（実際:${JSON.stringify(prims.filter(p => p.type === 'line' && p.x1 === 0 && p.x2 === 0))}）`);
  const rightWall = prims.find(p => p.type === 'line' && p.weight === 'thick' &&
    p.x1 === c1.run && p.x2 === c1.run && p.y1 === floorY && p.y2 === -CH);
  assert.ok(rightWall, `右端縦線はCUT(太)=壁断面・天井(-CH)までのはず（実際:${JSON.stringify(prims.filter(p => p.type === 'line' && p.x1 === c1.run && p.x2 === c1.run))}）`);
  const topLine = prims.find(p => p.type === 'line' && p.y1 === topY && p.y2 === topY &&
    p.x1 === 0 && p.x2 === c1.run);
  assert.ok(topLine, '見付け上端（高い側床線）が見つかるはず');
  assert.equal(topLine.weight, 'medium', '見付け上端はSILHOUETTE(中線)のはず');
});

// QA修正（ユーザー明示指示2026-08その4）: room3のC1（段差見付け面）には見付け上端(topY)〜天井(-CH)
// のアキ（矩形＋対角線＋「ア キ」テキスト）が必要——旧実装はkneeDropGapsOnFace（腰壁・垂れ壁の
// 明示指定がある軸だけ）にしか依存しておらず、指定の無い通常の段差見付け面ではアキが一切
// 描かれない欠落があった（段差見付け面を新設したコミット5f8ec62の時点から一貫した欠落）。
test('新規指示: room3のC1（段差見付け面）は見付け上端〜天井にアキ（矩形＋「ア キ」）を描く', () => {
  const { graph, room3 } = buildRoundFFixture();
  const faces = composeRoomFaces(room3, graph);
  const c1 = faces.find(f => f.label === 'C1');
  assert.ok(c1 && c1.kind === 'step', 'C1（段差見付け面）が見つかるはず');
  const CH = 2400;
  const prims = buildFaceFigure(c1, { graph, project: null, room: room3, ceilingHeight: CH, materialMap: null, gridCLs: [] });

  const topY = -(c1.baseFloorDeltaMm + c1.stepHeightMm);
  const gapRect = prims.find(p => p.type === 'rect' && p.x === 0 && p.y === -CH && p.w === c1.run);
  assert.ok(gapRect, `アキの矩形（x=0,y=-CH,w=run）が見つかるはず（実際のrect:${JSON.stringify(prims.filter(p => p.type === 'rect'))}）`);
  assert.equal(gapRect.h, CH + topY, 'あきの高さは天井(-CH)〜見付け上端(topY)の距離のはず');
  assert.ok(prims.some(p => p.type === 'text' && p.text === 'ア キ'), '「ア キ」テキストが見つかるはず');
});

// 項目6: room3のD1は面全体でFLが一定（+100。左端の極小sliverによる床の高低差が無い）。
test('ユーザー報告item6: room3のD1は床の高低差が無く、floorSegmentsは1区間(delta100)のみになる', () => {
  const { graph, room3 } = buildRoundFFixture();
  const faces = composeRoomFaces(room3, graph);
  const d1 = faces.find(f => f.label === 'D1');
  assert.ok(d1, 'D1が見つかるはず');
  const floorSegments = wallAdjacentFloorSegments(d1, room3, graph);
  assert.equal(floorSegments.length, 1, `floorSegmentsは1区間のみのはず（実際:${JSON.stringify(floorSegments)}）`);
  assert.equal(floorSegments[0].floorDeltaMm, 100);
  assert.equal(floorSegments[0].loX, 0);
  assert.equal(floorSegments[0].hiX, d1.run);
});
