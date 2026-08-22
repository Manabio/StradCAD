// buildRoomFaces / openingsOnFace の不変条件テスト（.claude/elevation-model.md §3.3 I1〜I5）。
// 実 core.js（Plane/PlanGraph）+ 実 finish/wallGeneration.js で壁を生成し、実際の仕上げ面位置を使う
// （openingRoomLabel.test.js と同じ方針。ダックタイピングでは面座標の実挙動を再現できない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import {
  buildRoomFaces, openingsOnFace, faceBoundaryLocalX, snapFaceEndsToCorners, faceWallLessExtents,
} from './elevationFaces.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function addCL(graph, type, value) {
  return graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
}

// 矩形部屋（x0..x1, y0..y1）を1セルで作り、外周壁を自動生成する。
function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = addCL(graph, CenterLineType.VERTICAL, x0v);
  const x1 = addCL(graph, CenterLineType.VERTICAL, x1v);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, y0v);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, y1v);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return { room, x0, x1, y0, y1 };
}

// ---- I1: 矩形部屋で ['A','B','C','D'] 順・12/3/6/9時に対応 ----
test('buildRoomFaces: 矩形部屋はA(上/北)→B(右/東)→C(下/南)→D(左/西)の順で並ぶ', () => {
  const graph = makeGraph();
  const { room } = makeRectRoom(graph, 0, 0, 4000, 3000);

  const faces = buildRoomFaces(room, graph);
  assert.deepEqual(faces.map(f => f.label), ['A', 'B', 'C', 'D']);
  assert.equal(faces[0].isVertical, false, 'A(上端)は水平壁');
  assert.equal(faces[1].isVertical, true,  'B(右端)は垂直壁');
  assert.equal(faces[2].isVertical, false, 'C(下端)は水平壁');
  assert.equal(faces[3].isVertical, true,  'D(左端)は垂直壁');
  // A(上)の面座標(y)はC(下)の面座標より小さい、B(右)の面座標(x)はD(左)より大きい
  const byLabel = Object.fromEntries(faces.map(f => [f.label, f]));
  assert.ok(byLabel.A.faceValue < byLabel.C.faceValue, 'Aの面はCの面より上(y小)');
  assert.ok(byLabel.B.faceValue > byLabel.D.faceValue, 'Bの面はDの面より右(x大)');
});

// ---- I2（本命）: 隣接面の終端隅＝次面の始端隅が世界座標で一致 ----
function worldAt(face, localAlong) {
  const along = face.originWorld + face.dirSign * localAlong;
  return face.isVertical ? { x: face.faceValue, y: along } : { x: along, y: face.faceValue };
}
function endCorner(face)   { return worldAt(face, face.run); }
function startCorner(face) { return worldAt(face, 0); }

function assertCornersMatch(faces, label) {
  for (let i = 0; i < faces.length; i++) {
    const cur  = faces[i];
    const next = faces[(i + 1) % faces.length];
    const e = endCorner(cur), s = startCorner(next);
    assert.ok(Math.abs(e.x - s.x) < 1e-6 && Math.abs(e.y - s.y) < 1e-6,
      `${label}: ${cur.label}の終端(${e.x},${e.y})と${next.label}の始端(${s.x},${s.y})が一致しない`);
  }
}

test('buildRoomFaces: 矩形部屋の隣接面の隅が世界座標で一致する', () => {
  const graph = makeGraph();
  const { room } = makeRectRoom(graph, 0, 0, 4000, 3000);
  assertCornersMatch(buildRoomFaces(room, graph), '矩形');
});

test('buildRoomFaces: L字部屋の隣接面の隅が世界座標で一致する（壁が向こう側へ折れる入隅の対を除く）', () => {
  const graph = makeGraph();
  // L字: 大矩形(0,0)-(6000,4000)から右上(3000,0)-(6000,2000)の角を欠いた形。
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 3000);
  const x2 = addCL(graph, CenterLineType.VERTICAL, 6000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 4000);
  const cells = new Set([
    `${x0.id}:${y0.id}:${x1.id}:${y2.id}`, // 左列全体
    `${x1.id}:${y1.id}:${x2.id}:${y2.id}`, // 右下
  ]);
  const room = graph.addRoom(cells, 'L字室');
  generateRoomWallsFromOutline(graph, room);

  const faces = buildRoomFaces(room, graph);
  const byLabel = Object.fromEntries(faces.map(f => [f.label, f]));
  // 凹み角(3000,2000)の対（B1終端↔A2始端）は、相手の壁がこの面の切断面を横切らず向こう側へ
  // 折れて続く＝図の端部に壁断面が現れない（ユーザー明示指示2026-08）。壁のない端部
  // （床・天井線の延長対象）だが見えがかりエッジとして縦線（中線）は立つ。端座標は
  // 壁の実端（直交面のfaceValue）へ詰める（ユーザー確認: 中心線位置ではなく実端）ため、
  // 隅共有の不変条件は凹み角でも保たれる（assertCornersMatchが全対を検証）。
  assert.equal(byLabel.B1.hasWallAtLocalRun, false, 'B1終端(凹み角)は壁断面が現れないためfalseのはず');
  assert.equal(byLabel.B1.edgeAtLocalRun, true, 'B1終端は見えがかりエッジ（縦線=中線の対象）のはず');
  assert.equal(byLabel.A2.hasWallAtLocal0, false, 'A2始端(凹み角)は壁断面が現れないためfalseのはず');
  assert.equal(byLabel.A2.edgeAtLocal0, true, 'A2始端は見えがかりエッジのはず');
  assertCornersMatch(faces, 'L字');
});

// ---- I3: 対向2面の run の和 < 芯々寸法×2（faceValueでなくeffectiveValueを使うと赤） ----
test('buildRoomFaces: 対向2面のrunの和は芯々寸法×2より小さい（壁厚ぶん有効長が短くなる）', () => {
  const graph = makeGraph();
  const { room, x0, x1, y0, y1 } = makeRectRoom(graph, 0, 0, 4000, 3000);
  const faces = buildRoomFaces(room, graph);
  const byLabel = Object.fromEntries(faces.map(f => [f.label, f]));

  const spanX = x1.effectiveValue - x0.effectiveValue;
  const spanY = y1.effectiveValue - y0.effectiveValue;
  assert.ok(byLabel.A.run + byLabel.C.run < 2 * spanX, 'A+Cのrun和はX芯々寸法×2未満');
  assert.ok(byLabel.B.run + byLabel.D.run < 2 * spanY, 'B+Dのrun和はY芯々寸法×2未満');
});

// ---- QA修正（項目5b根本原因）: 張り出し(アルコーブ)付き部屋で、同じ壁通り(axisCLId)が
// 開口を挟み2区間に分かれても、両区間とも抽出漏れせずchainに現れる ----
// 根本原因: buildRoomFacesのchain-walk・snapFaceEndsToCornersが、隅の相手探索に
// Map<axisCLId, 単一face>を使っていたため、同じaxisCLIdを持つ複数面（張り出し・ノッチ等で
// 1本の壁面が非連続な2区間以上に分かれる場合に発生）のうち後から登録された方で上書きされ、
// 片方が事実上たどり着けなくなり出力から消えていた（ユーザー観察の「面のrunが1000以下で
// 抽出漏れ」は、張り出しの両脇に残る短い返し壁（本テストでは幅1000のアルコーブの両脇＝
// 約943mm）がこの上書きで消える典型パターンと一致する）。
test('【QA修正・項目5b】buildRoomFaces: 張り出し(アルコーブ)付き部屋は、壁を挟む同じ壁通りの2区間とも抽出される（旧実装は片方が消えていた）', () => {
  const graph = makeGraph();
  // 主室(0,0)-(4000,3000)の右側面(x=4000)に、幅800(x方向)×高さ1000(y方向、y:1000..2000)の
  // アルコーブが張り出す。主室の右壁(B)はアルコーブの開口を挟みB1(y:0..1000)・B3(y:2000..3000)の
  // 2区間に分かれ、どちらも同じaxisCLId(x=4000)を持つ——これが本バグの発生条件。
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const x2 = addCL(graph, CenterLineType.VERTICAL, 4800);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, 1000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y3 = addCL(graph, CenterLineType.HORIZONTAL, 3000);
  const cells = new Set([
    `${x0.id}:${y0.id}:${x1.id}:${y3.id}`, // 主室
    `${x1.id}:${y1.id}:${x2.id}:${y2.id}`, // アルコーブ
  ]);
  const room = graph.addRoom(cells, 'アルコーブ室');
  generateRoomWallsFromOutline(graph, room);
  const faces = buildRoomFaces(room, graph);

  // 主室4辺(A/B/C/D。うちBはアルコーブ開口で分割)＋アルコーブ自身の3辺(奥・左右)＝計8面のはず。
  assert.equal(faces.length, 8, `旧実装は同じ壁通りの上書きでアルコーブごと消え4面になっていた（実際:${faces.length}）`);
  const byLabel = Object.fromEntries(faces.map(f => [f.label, f]));
  assert.ok(byLabel.B1 && byLabel.B2 && byLabel.B3, 'Bは開口を挟みB1/B2/B3の3区間に分かれるはず');
  // B1・B3（アルコーブ両脇の返し壁）はどちらも約943mm（run<=1000。ユーザー観察と一致）。
  assert.ok(byLabel.B1.run <= 1000 && byLabel.B1.run > 0, `B1のrunが1000以下のはず（実際:${byLabel.B1.run}）`);
  assert.ok(byLabel.B3.run <= 1000 && byLabel.B3.run > 0, `B3のrunが1000以下のはず（実際:${byLabel.B3.run}）`);
  // アルコーブ開口の2隅を挟む4端（B1終端・アルコーブ天面A2始端・アルコーブ底面C1終端・B3始端）は
  // 相手の壁が切断面を横切らず開口の向こうへ折れて続くため壁のない端部（ユーザー明示指示2026-08:
  // 壁断面のない中心線＝続きがある表現）。それ以外の端は従来どおり壁あり。
  const wallLess = new Set(['B1:run', 'A2:0', 'C1:run', 'B3:0']);
  for (const f of faces) {
    assert.equal(f.hasWallAtLocal0, !wallLess.has(`${f.label}:0`),
      `${f.label}のhasWallAtLocal0が期待と異なる`);
    assert.equal(f.hasWallAtLocalRun, !wallLess.has(`${f.label}:run`),
      `${f.label}のhasWallAtLocalRunが期待と異なる`);
  }
});

// ---- 項目1: snapFaceEndsToCornersが「対応する直交面が無い端」をhasWallAtLocal0/Runで公開する ----
test('snapFaceEndsToCorners: 対応する直交面が無い端（壁のない端部）はhasWallAtLocal0/hasWallAtLocalRunがfalseになる', () => {
  // faceA--faceB の2面チェーン（中間の隅=axAは繋がるが、両端=clStartDangling/clEndDanglingは
  // どの面のaxisCLとも一致しない＝対応する直交面が無い「壁のない端部」）。dirSignは両方+1。
  const faceA = { axisCL: { id: 'axA' }, startCLId: 'clStartDangling', endCLId: 'axB', dirSign: 1, lo: 0, hi: 4000, faceValue: 0 };
  const faceB = { axisCL: { id: 'axB' }, startCLId: 'axA', endCLId: 'clEndDangling', dirSign: 1, lo: 0, hi: 3000, faceValue: 4000 };
  const [outA, outB] = snapFaceEndsToCorners([faceA, faceB]);

  assert.equal(outA.hasWallAtLocal0, false, 'faceAのstart側(clStartDangling)は対応する面が無いはず');
  assert.equal(outA.hasWallAtLocalRun, true, 'faceAのend側(axB=faceB)は対応する面があるはず');
  assert.equal(outB.hasWallAtLocal0, true, 'faceBのstart側(axA=faceA)は対応する面があるはず');
  assert.equal(outB.hasWallAtLocalRun, false, 'faceBのend側(clEndDangling)は対応する面が無いはず');
});

// ---- 失敗系: dirSign<0の面はhasWallAtLocal0/Runの対応がstart/endに対して反転する ----
test('【失敗系】snapFaceEndsToCorners: dirSign<0の面はhasWallAtLocal0がendCLId側・hasWallAtLocalRunがstartCLId側になる', () => {
  const faceA = { axisCL: { id: 'axA' }, startCLId: 'clStartDangling', endCLId: 'axB', dirSign: -1, lo: 0, hi: 4000, faceValue: 0 };
  const faceB = { axisCL: { id: 'axB' }, startCLId: 'axA', endCLId: 'clEndDangling', dirSign: -1, lo: 0, hi: 3000, faceValue: 4000 };
  const [outA, outB] = snapFaceEndsToCorners([faceA, faceB]);

  // dirSign<0: hasWallAtLocal0はhi側(endCLId)、hasWallAtLocalRunはlo側(startCLId)に対応する。
  assert.equal(outA.hasWallAtLocal0, true, 'faceAはend側(axB)に対応する面があるためlocal0がtrueのはず');
  assert.equal(outA.hasWallAtLocalRun, false, 'faceAはstart側(clStartDangling)に対応する面が無いためlocalRunがfalseのはず');
  assert.equal(outB.hasWallAtLocal0, false);
  assert.equal(outB.hasWallAtLocalRun, true);
});

// ---- QA G2: faceWallLessExtents（隣接面ギャップ算出用の壁のない端部延長オフセット） ----
test('【QA G2】faceWallLessExtents: hasWallAtLocalRunがfalseの面はrightExtendMmにwallLessExtendMmが乗る', () => {
  const face = { hasWallAtLocal0: true, hasWallAtLocalRun: false };
  const { leftExtendMm, rightExtendMm } = faceWallLessExtents(face, 19); // 19=5screenMm@DEFAULT_PX_PER_MM換算相当の例
  assert.equal(leftExtendMm, 0, '左端は壁ありのため延長0のはず');
  assert.equal(rightExtendMm, 19, '右端は壁なしのためwallLessExtendMmがそのまま乗るはず');
});

test('【QA G2】faceWallLessExtents: hasWallAtLocal0がfalseの面はleftExtendMmにwallLessExtendMmが乗る', () => {
  const face = { hasWallAtLocal0: false, hasWallAtLocalRun: true };
  const { leftExtendMm, rightExtendMm } = faceWallLessExtents(face, 19);
  assert.equal(leftExtendMm, 19);
  assert.equal(rightExtendMm, 0);
});

// ---- 失敗系: 両端に壁があれば（フィールド省略時のフォールバック含む）延長は0 ----
test('【失敗系・QA G2】faceWallLessExtents: 両端に壁がある（またはフィールド省略）面は延長0になる', () => {
  assert.deepEqual(faceWallLessExtents({ hasWallAtLocal0: true, hasWallAtLocalRun: true }, 19),
    { leftExtendMm: 0, rightExtendMm: 0 });
  assert.deepEqual(faceWallLessExtents({}, 19), { leftExtendMm: 0, rightExtendMm: 0 },
    'フィールド省略時はtrue(壁あり)扱い＝延長0（buildFaceFigureの`?? true`と同じ規約）');
});

// ---- QA G2 (buildRoomBandの実際の配置式を模擬): 壁なし端を挟む2面でも実間隔はgapModelMm
// (実画面30mm相当)を維持する ----
// buildRoomBandへ合成faceを注入する手段は無い（buildFaceFigureのように直接ctxへfaceを渡す
// 設計ではないため）ので、elevationBand.js/elevationStair.jsのxCursor/prevRightExtent算出式を、
// このfaceWallLessExtents（実装が共有する同一の純関数）を使ってそのまま2面ぶん模擬し、
// 「前の面の右端が壁なし」→次面のxCursorがwallLessExtendMmぶん余分に押し出される、という
// 修正後の性質を直接検証する（実グラフでの同等の検証はこの下・elevationFaces.jsのQA修正節、
// および elevationBand.test.js の実グラフblack-boxテストを参照）。
test('【QA G2】buildRoomBandの配置式を模擬: 前の面の右端が壁なしなら、次の面とのxCursor間隔がwallLessExtendMmぶん広がる', () => {
  const gapModelMm = 113; // 実画面30mm相当の例（値そのものに意味は無い）
  const wallLessExtendMm = 19; // 実画面5mm相当の例
  const boundaryA = { lo: 0, hi: 4000 };
  const boundaryB = { lo: 0, hi: 3000 };

  const simulate = (faceA, faceB) => {
    const extA = faceWallLessExtents(faceA, wallLessExtendMm);
    const xCursorA = 0;
    const prevBoundaryHiA = xCursorA + boundaryA.hi;
    const prevRightExtent = prevBoundaryHiA + extA.rightExtendMm; // floorSegments段差なし想定
    const extB = faceWallLessExtents(faceB, wallLessExtendMm);
    const xCursorB = prevRightExtent + gapModelMm - boundaryB.lo + extB.leftExtendMm;
    return xCursorB;
  };

  const bothWalled = simulate({ hasWallAtLocalRun: true }, { hasWallAtLocal0: true });
  const aRightWallLess = simulate({ hasWallAtLocalRun: false }, { hasWallAtLocal0: true });
  assert.equal(aRightWallLess, bothWalled + wallLessExtendMm,
    '面Aの右端が壁なしなら、面Bのxカーソルはwallless延長ぶんさらに右へ押し出されるはず');

  // 実間隔（面Aの右端の実描画=prevBoundaryHiA+rightExtendMm から 面Bの左端の実描画=xCursorB+
  // (leftExtendMmが無ければboundaryB.lo、あればさらに手前)まで）は、どちらのケースでもgapModelMm
  // ちょうどを維持する（G2修正前は壁なし側の延長ぶんだけ実間隔が縮んでいた）。
  const realGap = (faceA, faceB, xCursorB) => {
    const extA = faceWallLessExtents(faceA, wallLessExtendMm);
    const drawnRightA = boundaryA.hi + extA.rightExtendMm;
    const extB = faceWallLessExtents(faceB, wallLessExtendMm);
    const drawnLeftB = xCursorB + boundaryB.lo - extB.leftExtendMm;
    return drawnLeftB - drawnRightA;
  };
  assert.equal(
    realGap({ hasWallAtLocalRun: true }, { hasWallAtLocal0: true }, bothWalled), gapModelMm);
  assert.equal(
    realGap({ hasWallAtLocalRun: false }, { hasWallAtLocal0: true }, aRightWallLess), gapModelMm);
  assert.equal(
    realGap({ hasWallAtLocalRun: true }, { hasWallAtLocal0: false }, simulate({ hasWallAtLocalRun: true }, { hasWallAtLocal0: false })),
    gapModelMm);
});

// ---- QA修正（実グラフでの発動確認）: hasWallAtLocal0/hasWallAtLocalRunは「隅に直交面が存在する
// か」ではなく「隅の直交面に実壁(graph.walls)があるか」で判定する ----
// 閉じた部屋の外周は幾何的に必ず1周の閉ループになるため（隣接面の隅は必ず世界座標で一致する。
// buildRoomFacesの不変条件）、隅に直交"面"（幾何セグメント）が存在しないケースは実グラフからは
// 作れない。実際の「壁のない端部」（上り口等）は、generateRoomWallsFromOutlineのstairOpenings
// 引数（finish/wallGeneration.js。finishBoundary.jsが階段の登り口・下り口辺=stairPortEdgesを
// 渡し、その辺の壁生成をスキップする）で再現する——onStairOpeningが要求する形
// {isVertical, value, lo, hi} を直接渡せば、実際のStair/階段室オブジェクトを組まなくても
// 同じ「壁生成スキップ」経路を通せる（本物のStairが行うのと同じ入力形）。
function makeRectRoomWithWallLessTop(graph, x0v, y0v, x1v, y1v, name = 'かいだん') {
  const x0 = addCL(graph, CenterLineType.VERTICAL, x0v);
  const x1 = addCL(graph, CenterLineType.VERTICAL, x1v);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, y0v);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, y1v);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  // A面（上辺=y0軸・isVertical:false）全体をstairOpening指定し、壁生成をスキップさせる。
  const stairOpenings = [
    { isVertical: false, value: y0.effectiveValue, lo: x0.effectiveValue - 1, hi: x1.effectiveValue + 1 },
  ];
  generateRoomWallsFromOutline(graph, room, {}, stairOpenings);
  return room;
}

test('【QA修正】buildRoomFaces: 上り口辺（壁生成スキップ）に隣接する面の端はhasWallAtLocal0/Runがfalseになる', () => {
  const graph = makeGraph();
  const room = makeRectRoomWithWallLessTop(graph, 0, 0, 4000, 3000);
  const faces = buildRoomFaces(room, graph);
  const byLabel = Object.fromEntries(faces.map(f => [f.label, f]));

  // A自身（壁の無い辺そのもの）はhasRealWallがfalse（faceValueがCL芯へフォールバック）。
  assert.equal(byLabel.A.hasRealWall, false, 'A面自身は実壁が無いためhasRealWallがfalseのはず');
  // A⇔B・A⇔D の隅は「隣の面(A)に実壁が無い」ため、B/D側の対応する端がfalseになる
  // （A自身のhasWallAtLocal0/Runは「A自身の隣=B/Dに実壁があるか」の話なので、B/Dが実壁を
  // 持つ通常の面である限りtrueのまま——false化されるのはB/D側）。
  assert.equal(byLabel.B.hasWallAtLocal0, false, 'B面の始端(A隅)はAに実壁が無いためfalseのはず');
  assert.equal(byLabel.D.hasWallAtLocalRun, false, 'D面の終端(A隅)はAに実壁が無いためfalseのはず');
  // 他の端（実壁があるC・B/Dの反対側）はtrueのまま。
  assert.equal(byLabel.B.hasWallAtLocalRun, true);
  assert.equal(byLabel.D.hasWallAtLocal0, true);
  assert.equal(byLabel.C.hasWallAtLocal0, true);
  assert.equal(byLabel.C.hasWallAtLocalRun, true);
});

// ---- 失敗系: 全周壁のある矩形部屋は全面ともhasWallAtLocal0/Runがtrueになる ----
test('【失敗系】buildRoomFaces: 全周壁のある矩形部屋は全面でhasWallAtLocal0/hasWallAtLocalRunがtrueになる', () => {
  const graph = makeGraph();
  const { room } = makeRectRoom(graph, 0, 0, 4000, 3000);
  const faces = buildRoomFaces(room, graph);
  for (const f of faces) {
    assert.equal(f.hasWallAtLocal0, true, `${f.label}のhasWallAtLocal0はtrueのはず`);
    assert.equal(f.hasWallAtLocalRun, true, `${f.label}のhasWallAtLocalRunはtrueのはず`);
  }
});

// ---- faceBoundaryLocalX: 面は両端の壁中心線（CL）で挟まれる（壁面より外側） ----
test('faceBoundaryLocalX: 境界はface.lo/hi(壁仕上げ面)よりさらに外側の壁中心線（CL）位置になる', () => {
  const graph = makeGraph();
  const { room } = makeRectRoom(graph, 0, 0, 4000, 3000);
  const faces = buildRoomFaces(room, graph);
  const a = faces.find(f => f.label === 'A');

  const boundary = faceBoundaryLocalX(a, graph);
  assert.ok(boundary.lo < 0, `境界loは面のローカル原点(0)より外側（負）のはず（実際:${boundary.lo}）`);
  assert.ok(boundary.hi > a.run, `境界hiはface.run(${a.run})より外側のはず（実際:${boundary.hi}）`);
});

// ---- I4: L字で同letter2本・label B1/B2（群内ソート順） ----
test('buildRoomFaces: L字部屋は同letterが複数面に分かれB1/B2のラベルが付く', () => {
  const graph = makeGraph();
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 3000);
  const x2 = addCL(graph, CenterLineType.VERTICAL, 6000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 4000);
  const cells = new Set([
    `${x0.id}:${y0.id}:${x1.id}:${y2.id}`,
    `${x1.id}:${y1.id}:${x2.id}:${y2.id}`,
  ]);
  const room = graph.addRoom(cells, 'L字室');
  generateRoomWallsFromOutline(graph, room);

  const faces = buildRoomFaces(room, graph);
  const bFaces = faces.filter(f => f.letter === 'B');
  assert.equal(bFaces.length, 2, 'B(右向き)の壁は2面に分かれる');
  assert.deepEqual(bFaces.map(f => f.label), ['B1', 'B2']);
  // B群はy昇順（dirSign=+1）
  assert.ok(bFaces[0].lo < bFaces[1].lo, 'B1はB2より上(y小)側');
});

// ---- 開口は壁を貫通するため、共有壁では両側の部屋の面に出る ----
// （旧I5仕様「片方の面にしか出ない」は撤回: wallSide＝配置時にクリックした側で表示先が
// 決まってしまい、反対側の部屋の展開図に建具が一切描かれない実機不具合の原因だった。
// 裏側から見る面の左右反転は elevationFigure.js の dirSign 反転が担う）
test('openingsOnFace: 隣接2部屋が共有する壁の開口は両側の部屋の面に出る（壁を貫通するため）', () => {
  const graph = makeGraph();
  // 上室(0,0)-(4000,2000) と 下室(0,2000)-(4000,5000) が y=2000 のCLを共有する。
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const yMid = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 5000);

  const upperKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const lowerKey = `${x0.id}:${yMid.id}:${x1.id}:${y2.id}`;
  const upperRoom = graph.addRoom(new Set([upperKey]), '上室');
  const lowerRoom = graph.addRoom(new Set([lowerKey]), '下室');
  generateRoomWallsFromOutline(graph, upperRoom);
  generateRoomWallsFromOutline(graph, lowerRoom);

  // 共有CL(yMid)の上室側(下端=C, wallSide=-1)に開口を1つ置く。
  const opening = graph.addOpening(yMid, -1, false, x0, 1500, 900, OpeningCategory.FITTING, 'singleSwing', {});

  const upperFaces = buildRoomFaces(upperRoom, graph);
  const lowerFaces = buildRoomFaces(lowerRoom, graph);
  const upperC = upperFaces.find(f => f.letter === 'C');
  const lowerA = lowerFaces.find(f => f.letter === 'A');
  assert.ok(upperC && lowerA, '前提: 共有壁は上室C面・下室A面として存在する');

  assert.equal(openingsOnFace(upperC, graph).length, 1, '上室C面にこの開口が乗る');
  assert.equal(openingsOnFace(lowerA, graph).length, 1, '下室A面にも乗る（クリック側と逆でも貫通するため描く）');
  assert.equal(openingsOnFace(upperC, graph)[0].id, opening.id);
  assert.equal(openingsOnFace(lowerA, graph)[0].id, opening.id);
});

// ---- QA F4テスト4: wallSide===0 の開口は対向2面の両方に出る（CL偏芯の仕上げ面合わせ等） ----
test('【QA】openingsOnFace: wallSide===0の開口は共有壁の両側の面に出る', () => {
  const graph = makeGraph();
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const yMid = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 5000);

  const upperKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const lowerKey = `${x0.id}:${yMid.id}:${x1.id}:${y2.id}`;
  const upperRoom = graph.addRoom(new Set([upperKey]), '上室');
  const lowerRoom = graph.addRoom(new Set([lowerKey]), '下室');
  generateRoomWallsFromOutline(graph, upperRoom);
  generateRoomWallsFromOutline(graph, lowerRoom);

  const opening = graph.addOpening(yMid, 0, false, x0, 1500, 900, OpeningCategory.FITTING, 'singleSwing', {});

  const upperC = buildRoomFaces(upperRoom, graph).find(f => f.letter === 'C');
  const lowerA = buildRoomFaces(lowerRoom, graph).find(f => f.letter === 'A');

  assert.equal(openingsOnFace(upperC, graph).length, 1, '上室C面にも乗る');
  assert.equal(openingsOnFace(lowerA, graph).length, 1, '下室A面にも乗る');
  assert.equal(openingsOnFace(upperC, graph)[0].id, opening.id);
  assert.equal(openingsOnFace(lowerA, graph)[0].id, opening.id);
});

// ---- 失敗系: 部屋にセルが無い（cells空） → 面リストは空配列（例外を投げない） ----
test('【失敗系】buildRoomFaces: セルが無い部屋は空配列を返す', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(), '空室');
  assert.deepEqual(buildRoomFaces(room, graph), []);
});

// ---- 失敗系: selectElevationRooms は STAIR_VOID/VOID/UNDEFINED/屋外/無名を除外する ----
test('【失敗系】selectElevationRooms: 屋外・無名・STAIR_VOID等は対象外', async () => {
  const { RoomKind, RoomFeature } = await import('@core');
  const { selectElevationRooms } = await import('./elevationFaces.js');
  const graph = makeGraph();
  const named = graph.addRoom(new Set(), 'LDK');
  const unnamed = graph.addRoom(new Set(), '');
  const exterior = graph.addRoom(new Set(), 'テラス');
  exterior.setKind(RoomKind.EXTERIOR);
  const stairVoid = graph.addRoom(new Set(), '階段吹抜け');
  stairVoid.setFeature(RoomFeature.STAIR_VOID);
  const stair = graph.addRoom(new Set(), '階段');
  stair.setFeature(RoomFeature.STAIR);

  const result = selectElevationRooms(graph);
  assert.deepEqual(result.map(r => r.id), [named.id, stair.id]);
  void unnamed;
});

// ---- QA修正: 部分指定（referenceRoomIds非空）は独自の帯を持たず親の帯内で表現されるため、
// selectElevationRoomsの対象から除外する（除外しないと親・部分指定の両方に同じ壁面が
// 重複して展開されてしまう不具合があった） ----
test('【QA修正】selectElevationRooms: 部分指定（referenceRoomIds非空）は対象外（親のみ対象）', async () => {
  const { selectElevationRooms } = await import('./elevationFaces.js');
  const graph = makeGraph();
  const parent = graph.addRoom(new Set(), 'LDK');
  const partial = graph.addRoom(new Set(), '小上がり', undefined, new Set([parent.id]));

  const result = selectElevationRooms(graph);
  assert.deepEqual(result.map(r => r.id), [parent.id], '部分指定は含まれず親だけが対象のはず');
  void partial;
});

// ---- WP-V1: selectElevationRooms は feature===VOID（吹抜け・ユーザー指定）も採用する ----
test('【WP-V1】selectElevationRooms: feature===VOID（吹抜け）も対象に含まれる', async () => {
  const { RoomFeature } = await import('@core');
  const { selectElevationRooms } = await import('./elevationFaces.js');
  const graph = makeGraph();
  const named = graph.addRoom(new Set(), 'LDK');
  const voidRoom = graph.addRoom(new Set(), '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const result = selectElevationRooms(graph);
  assert.deepEqual(result.map(r => r.id), [named.id, voidRoom.id]);
});

// ---- WP-V1: STAIR_VOID（自動管理・描画対象外）は有名でも除外される ----
test('【失敗系・WP-V1】selectElevationRooms: STAIR_VOIDは名前を付けても対象外のまま', async () => {
  const { RoomFeature } = await import('@core');
  const { selectElevationRooms } = await import('./elevationFaces.js');
  const graph = makeGraph();
  const named = graph.addRoom(new Set(), 'LDK');
  const stairVoid = graph.addRoom(new Set(), '階段吹抜け'); // 本来は自動管理・無名だが、除外条件を明示するため有名にする
  stairVoid.setFeature(RoomFeature.STAIR_VOID);

  const result = selectElevationRooms(graph);
  assert.deepEqual(result.map(r => r.id), [named.id], 'STAIR_VOIDは有名でもfeature軸で除外されるはず');
});
