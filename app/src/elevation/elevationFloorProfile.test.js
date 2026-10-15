// wallAdjacentFloorSegments の基本挙動テスト。実 core.js（Plane/PlanGraph）+
// finish/wallGeneration.js で壁を生成した部屋に対して面を組み立てる（elevationFaces.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { outerWallFaceAt } from '../finish/wallFaces.js';
import { buildRoomFaces } from './elevationFaces.js';
import { makeGrid } from '../plan/planTestFixtures.js';
import { worldToCell, CEILING_CELL_GRID } from '../finish/gridCells.js';
import { createZone } from '../ceiling/ceilingZones.js';
import { setRoomCeilingShape } from '../ceiling/roomCeilingShape.js';
import {
  wallAdjacentFloorSegments, drawnRiserX, drawnCeilingRiserX, halfWallThicknessMm,
  familyCeilingSegments, floorProfileFromSegments, mergeFloorProfiles,
  drawnFloorProfileZAt, drawnFloorProfileZMax, clipContentAboveDrawnProfile, findRunCLAt, clipVerticalBelowProfile,
} from './elevationFloorProfile.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// x0-xMid-x1 × y0-y1 の2セル矩形部屋（内部に中心線xMidを1本持つ）を作る。
function makeSplitRoom(graph, name = 'LDK') {
  const x0   = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x1   = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${xMid.id}:${y1.id}`;
  const rightKey = `${xMid.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([leftKey, rightKey]), name);
  generateRoomWallsFromOutline(graph, room);
  return { room, x0, xMid, x1, y0, y1, leftKey, rightKey };
}

test('【S8a】findRunCLAt: 同じ座標に天井芯（先）と中心線（後）があるとき中心線を返す。天井芯しか無ければ null', () => {
  const graph = makeGraph();
  const ceiling = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.CEILING });
  assert.equal(findRunCLAt(graph, false, 2000), null, '天井芯だけなら見つからない');
  const center = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(graph.centerLines[0].id, ceiling.id, '前提: 天井芯が先頭');
  assert.equal(findRunCLAt(graph, false, 2000)?.id, center.id);
});

test('wallAdjacentFloorSegments: 部分指定が右半分を占めfloorLevelが異なるとき、面Aは左=0・右=段差の2区間になる', () => {
  const graph = makeGraph();
  const { room, xMid, rightKey } = makeSplitRoom(graph);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  assert.ok(faceA, '面Aが見つからない');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 2, '左(親=段差なし)・右(子=+300)の2区間になるはず');
  assert.equal(segs[0].floorDeltaMm, 0, '左区間は親自身なのでfloorDeltaMm=0のはず');
  assert.equal(segs[1].floorDeltaMm, 300, '右区間は子のfloorLevel(300)ぶんのはず');

  // 内部境界（xMid=2000）は隣接する直交壁の影響を受けないため、正確にlocalXへ変換した値になる。
  const toLocal = w => (w - faceA.originWorld) * faceA.dirSign;
  const expectedBoundary = toLocal(xMid.effectiveValue);
  assert.ok(Math.abs(segs[0].hiX - expectedBoundary) < 1e-6);
  assert.ok(Math.abs(segs[1].loX - expectedBoundary) < 1e-6);
  // 区間は面の全長(0..run)を隙間なく覆う。
  assert.equal(segs[0].loX, 0);
  assert.equal(segs[1].hiX, faceA.run);
});

// ---- 失敗系: floorLevelが親と同じ部分指定は段差を作らない（1区間に結合される） ----
test('【失敗系】wallAdjacentFloorSegments: 部分指定のfloorLevelが親と同じなら段差にならず1区間に結合される', () => {
  const graph = makeGraph();
  const { room, rightKey } = makeSplitRoom(graph);
  graph.addRoom(new Set([rightKey]), '床材違いエリア', undefined, new Set([room.id]));
  // floorLevel未設定 = 親と同じ実効FL

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 1, 'FL差が無ければ段差を作らず1区間に結合されるはず');
  assert.equal(segs[0].floorDeltaMm, 0);
  assert.equal(segs[0].loX, 0);
  assert.equal(segs[0].hiX, faceA.run);
});

// ---- 失敗系: 部分指定が無い通常の部屋は常に1区間（floorDeltaMm:0）を返す ----
test('【失敗系】wallAdjacentFloorSegments: 部分指定が無い部屋は常に1区間（floorDeltaMm:0）を返す', () => {
  const graph = makeGraph();
  const { room } = makeSplitRoom(graph);

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 1);
  assert.equal(segs[0].floorDeltaMm, 0);
});

// ---- QA指摘(a): dirSign=-1の面（C/D）でも0..runを単調・無間隙で被覆する ----
test('wallAdjacentFloorSegments: dirSign=-1の面（C）でも区間が0..runを単調・無間隙で被覆する', () => {
  const graph = makeGraph();
  const { room, rightKey } = makeSplitRoom(graph);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const faceC = buildRoomFaces(room, graph).find(f => f.label === 'C');
  assert.ok(faceC, '面Cが見つからない');
  assert.equal(faceC.dirSign, -1, '前提: 面Cはdirsign=-1のはず');
  const segs = wallAdjacentFloorSegments(faceC, room, graph);

  assert.equal(segs.length, 2, '面Cも段差で2区間に分かれるはず');
  assert.equal(segs[0].loX, 0, '先頭区間はloX=0から始まるはず');
  assert.equal(segs[segs.length - 1].hiX, faceC.run, '末尾区間はhiX=runで終わるはず');
  for (let i = 0; i + 1 < segs.length; i++) {
    assert.ok(segs[i].loX < segs[i].hiX, `区間${i}は空でないはず（loX<hiX）`);
    assert.equal(segs[i].hiX, segs[i + 1].loX, `区間${i}のhiXは次の区間のloXと一致し無間隙のはず`);
  }
});

// ---- QA修正（項目2・3根本原因）: セル境界に極小(<1e-6mm)の隙間・重なりがあっても、
// 「子→親(極小)→子」という見た目上の1往復（段差の抽出不良）を作らない。CL昇格/降格・
// 再スナップ等で「同じ位置のはずの別CL」を参照するようになった場合に極小差が生じうる状況を、
// 2つの子セルの間に極小の未登録セル（親扱いのスリバー）を挟む構成で再現する。
// QA修正(J1): 以前はgap-fill判定・末尾判定にも別途epsilonを持たせていたが、そこで生成される
// 極小区間は結局この下の「極小幅の区間を吸収する」処理で必ず除去されるため冗長と判明し撤去した
// （elevationFloorProfile.jsのコメント参照）——epsilonはこの1箇所（極小幅の吸収）だけに残る。
// 本テストはその唯一の許容差メカニズムを実際のRoom/セル経由で振る舞いとして検証する
// （実装のtoString()等でソース文字列を照合する検証はしない）。 ----
test('wallAdjacentFloorSegments: 2つの子区間の間に極小(<1e-6mm)の未登録セル(親扱い)を挟んでも1往復せず1区間に結合される', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,          { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000,       { labeled: false, discipline: Discipline.ARCH });
  const xg1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000.0000002, { labeled: false, discipline: Discipline.ARCH });
  const xg2 = graph.addCenterLine(CenterLineType.VERTICAL, 2000.0000004, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000,       { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey    = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const childKey1  = `${x1.id}:${y0.id}:${xg1.id}:${y1.id}`; // 子1(壁際、xgapを挟んで子2と隣接するはず)
  const gapKey     = `${xg1.id}:${y0.id}:${xg2.id}:${y1.id}`; // 極小(<1e-6mm)の未登録セル＝親扱いのスリバー
  const childKey2  = `${xg2.id}:${y0.id}:${x2.id}:${y1.id}`; // 子2
  const room = graph.addRoom(new Set([leftKey, childKey1, gapKey, childKey2]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  // 子はchildKey1・childKey2の2つに分かれて登録される（gapKeyは子に含めない＝親扱いのまま）。
  const child = graph.addRoom(new Set([childKey1, childKey2]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 2, `極小スリバーは前後の子区間へ吸収され、左(親)・右(子)の2区間のはず（実際:${segs.length}区間 ${JSON.stringify(segs)}）`);
  assert.equal(segs[0].floorDeltaMm, 0);
  assert.equal(segs[1].floorDeltaMm, 300, '極小スリバーの左右は同じ子(floorDeltaMm=300)のまま連続しているはず（1往復しない）');
  // 吸収後の区間位置も面の全域(0..run)を隙間なく覆っているはず（lengthとdeltaだけでは
  // 「吸収先(segs[i-1])のhiXを正しくs.hiXへ広げているか」を見落とすため、位置も直接確認する）。
  assert.equal(segs[0].loX, 0);
  assert.ok(Math.abs(segs[0].hiX - segs[1].loX) < 1e-6, '吸収後の2区間は隙間なく連続しているはず');
  assert.equal(segs[1].hiX, faceA.run);
});

// ---- 失敗系: 極小スリバーが面の先頭（前に他区間が無い状態）に来ても吸収先（次の区間）へ
// 正しく吸収される（上のテストは中間の吸収=前の区間へ、こちらは先頭の吸収=次の区間への
// 境界ケース）。面の先頭(face.lo)は直交壁の仕上げ面厚み分だけ壁中心線からずれた非キリの良い
// 実数になるため、まず素直な部屋で一度faceを組んで実際のface.loを読み取り、その直後に極小幅の
// スリバーが来るよう後からroom.cellsを差し替える（壁生成そのものに極小差を持ち込むと外周抽出
// 自体が乱れるため。壁生成はfaceが確定する前に一度だけ行う）。 ----
test('【失敗系】wallAdjacentFloorSegments: 極小スリバーが面の先頭に来ても（前の区間が無くても）次の区間へ吸収される', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const wholeKey = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([wholeKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room); // 極小差を持ち込む前に、素直な形で壁・面を確定させる

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  // face.lo（直交壁の仕上げ面＝面の先頭）ちょうどのところへ極小(2e-7mm)幅のスリバーを置く。
  const xg1 = graph.addCenterLine(CenterLineType.VERTICAL, faceA.lo + 0.0000002, { labeled: false, discipline: Discipline.ARCH });
  const gapKey   = `${x0.id}:${y0.id}:${xg1.id}:${y1.id}`;  // 極小の未登録セル＝親扱いのスリバー（面の先頭）
  const childKey = `${xg1.id}:${y0.id}:${x1.id}:${y1.id}`;  // 子（面のほぼ全域）
  room.setCells(new Set([gapKey, childKey])); // faceAは既に確定済みのためこの差し替えの影響を受けない
  const child = graph.addRoom(new Set([childKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 1, `先頭の極小スリバーは唯一の吸収先(次の区間)へ吸収され1区間のはず（実際:${segs.length}区間 ${JSON.stringify(segs)}）`);
  assert.equal(segs[0].floorDeltaMm, 300, '先頭の極小スリバー(親扱い)が子側へ吸収され、区間全体が子のfloorDeltaMmになるはず');
  // 吸収後の区間位置そのものも面の全域(0..run)を正しく覆っているはず——lengthとdeltaだけでは
  // 「吸収先(segs[i+1])のloXを正しくs.loXへ広げているか」を見落とす（widthのみ計算しているだけの
  // 別解でも通ってしまう）ため、位置も直接確認する。
  assert.equal(segs[0].loX, 0, '吸収後の区間は面の先頭(loX=0)から始まるはず');
  assert.equal(segs[0].hiX, faceA.run, '吸収後の区間は面の末尾(hiX=run)まで届くはず');
});

// ---- QA指摘(b): 壁に接しない内側だけの部分指定では、その面はフラットのまま ----
test('【失敗系】wallAdjacentFloorSegments: 壁に接しない内側だけの部分指定は面Aをフラットのままにする', () => {
  const graph = makeGraph();
  // x0-x1(単一列) × y0-yMid-y1(2行)。面Aの軸はy0で、y0..yMid行だけが面Aに接する。
  const x0   = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1   = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const nearKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;   // 面A(y0)に接する行
  const farKey  = `${x0.id}:${yMid.id}:${x1.id}:${y1.id}`;   // 面Aに接しない奥の行
  const room = graph.addRoom(new Set([nearKey, farKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([farKey]), '奥だけの部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(300); // FL差があっても面Aには接しないため影響しないはず

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 1, '部分指定が面Aの壁際セルに含まれないためフラットのままのはず');
  assert.equal(segs[0].floorDeltaMm, 0);
  assert.equal(segs[0].loX, 0);
  assert.equal(segs[0].hiX, faceA.run);
});

// ---- QA修正: near側限定（旧実装は面の両側(near/far)を拾っていた） ----
// 面のaxisCL上で、near側(面が向く方向)とfar側(反対側)の両方に自室セルがあり、かつ両者の
// run方向range(y)が重なる構成を直接（buildRoomFacesを介さず）合成faceで作る——
// 現実の部屋形状で純粋にこの条件だけを満たす最小構成を組むのが難しいため、
// wallAdjacentFloorSegmentsが実際に読むfield（axisCL/isVertical/inward/lo/hi/dirSign/
// originWorld）だけを持つ合成faceと、near/far両方に同室セルを持つroomを直接組み立てる。
// near側のrunLo(200)をfar側(0)よりも大きくして非対称にする——旧実装の「両側拾う」バグは
// runLo昇順ソート後のcursorクランプ機構により、near/farのrun範囲が完全一致する構成だと
// far側がまるごとクランプされ症状が見えなくなる（既に検証済み）。非対称にすることで、
// 先にソートされたfar側がcursorを専有し、後続のnear側が誤って消える／far側のFLが
// 0..run全体に漏れ出る、という実害を確実に顕在化させる。
test('【失敗系】wallAdjacentFloorSegments: 面のnear側(inwardの向く側)だけを拾い、far側の自室セルは無視して0..runを単調・無重複で被覆する', () => {
  const graph = makeGraph();
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x2000 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x3000 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0    = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y200  = graph.addCenterLine(CenterLineType.HORIZONTAL, 200,  { labeled: false, discipline: Discipline.ARCH });
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  // near側: x:2000-3000×y:200-1000（b.x1===2000。face(axisCL=2000,inward=+1)の室内側）。
  const nearKey = `${x2000.id}:${y200.id}:${x3000.id}:${y1000.id}`;
  // far側: x:1000-2000×y:0-1000（b.x2===2000。旧実装は`b.x1===axisValue||b.x2===axisValue`で
  // これも「面に接する」と誤判定していた——run方向(y)がnear側の範囲を包含する）。
  const farKey = `${x1000.id}:${y0.id}:${x2000.id}:${y1000.id}`;
  const room = graph.addRoom(new Set([nearKey, farKey]), 'LDK');
  // far側だけ別FLの部分指定にし、もし旧実装のように誤って拾われれば区間・floorDeltaMmに
  // 混入して即座に検出できるようにする。
  const farChild = graph.addRoom(new Set([farKey]), 'far側の部分指定', undefined, new Set([room.id]));
  farChild.setFloorLevel(500);

  const face = {
    axisCL: x2000, isVertical: true, inward: 1, faceValue: 2000,
    lo: 0, hi: 1000, run: 1000, dirSign: 1, originWorld: 0,
    startCLId: y0.id, endCLId: y1000.id,
  };
  const segs = wallAdjacentFloorSegments(face, room, graph);

  // near側(y:200-1000)は自室(delta0)、near側が届かない先頭(y:0-200)はgap-fillで親扱い(delta0)——
  // いずれにせよfar側のFL500が混入せず、全区間delta0で0..runを覆うはず。
  assert.ok(segs.every(s => s.floorDeltaMm === 0), `far側の500が混入せず全区間delta0のはず（実際:${JSON.stringify(segs)}）`);
  assert.equal(segs[0].loX, 0);
  assert.equal(segs[segs.length - 1].hiX, 1000);
  for (let i = 0; i + 1 < segs.length; i++) assert.equal(segs[i].hiX, segs[i + 1].loX, '隙間なく連続するはず');
});

// ---- 新仕様「段差位置のCLオフセット」: loCLId/hiCLIdの実引継ぎ ----
test('wallAdjacentFloorSegments: 段差境界のhiCLIdは実在するCLのidを指す（ROW1寸法のCL分割のS1源）', () => {
  const graph = makeGraph();
  const { room, xMid, rightKey } = makeSplitRoom(graph);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 2);
  assert.equal(segs[0].hiCLId, xMid.id, '左区間の終端CL idは内部境界のCL(xMid)のはず');
  assert.equal(segs[1].loCLId, xMid.id, '右区間の始端CL idも同じCL(xMid)を指すはず（同じ境界の表裏）');
});

// ---- 失敗系: gap-fill区間（対応セルが見つからない=親扱い）のCL idはnull ----
test('【失敗系】wallAdjacentFloorSegments: 部分指定が無ければ唯一の区間のloCLId/hiCLIdはnull（実在の境界CLが無いため）', () => {
  const graph = makeGraph();
  const { room } = makeSplitRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].loCLId, null);
  assert.equal(segs[0].hiCLId, null);
});

// ---- 問題修正2026-08: 区間ごとの天井高さ(chMm)の引き継ぎ ----
test('【問題修正2026-08】wallAdjacentFloorSegments: 明示CH指定を持つ部分指定（FLは親と同一）はchMmだけ異なる2区間に分かれる', () => {
  const graph = makeGraph();
  const { room, rightKey } = makeSplitRoom(graph);
  room.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set([rightKey]), '天井高エリア', undefined, new Set([room.id]));
  child.setOverride('ceilingHeight', '2600'); // FLは親と同じ・天井だけ明示指定

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 2, '床が同一FLでもchMmが異なれば区間は結合されないはず');
  assert.equal(segs[0].floorDeltaMm, 0);
  assert.equal(segs[1].floorDeltaMm, 0);
  assert.equal(segs[0].chMm, 2400, '左区間は親のCH');
  assert.equal(segs[1].chMm, 2600, '右区間は部分指定の明示CH');
});

// ---- 失敗系: 自CH指定なしの部分指定はroomCeilingHeightの調整により天井絶対高さが親と揃う ----
test('【失敗系・問題修正2026-08】wallAdjacentFloorSegments: 自CH指定なし+FL差ありの部分指定はchMm=親CH−FL差（天井絶対高さが揃う）', () => {
  const graph = makeGraph();
  const { room, rightKey } = makeSplitRoom(graph);
  room.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 2);
  assert.equal(segs[1].chMm, 2100, '子のchMmは親CH(2400)−FL差(300)＝天井絶対高さが親と揃う値のはず');
  assert.equal(segs[0].floorDeltaMm + segs[0].chMm, segs[1].floorDeltaMm + segs[1].chMm,
    '両区間の天井絶対高さ(FL+CH)は一致するはず（天井段差は描かれない）');
});

// ---- 問題修正2026-08その5: familyCeilingSegments（壁の向こう側=far側のファミリーセルのプローブ） ----
// 2行部屋（親が両行を登録・下行を子が上書き）の中間CL(yM)上に合成faceを置き、near=上行・
// far=下行(子)としてプローブする——「壁の向こう側に部分指定関係のある部屋がある」ケースの機構検証。
function makeTwoRowFamily(graph, { splitBottom = false } = {}) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = splitBottom ? graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH }) : null;
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const yM = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const topKey = `${x0.id}:${y0.id}:${x1.id}:${yM.id}`;
  const botKeys = splitBottom
    ? [`${x0.id}:${yM.id}:${xm.id}:${y1.id}`, `${xm.id}:${yM.id}:${x1.id}:${y1.id}`]
    : [`${x0.id}:${yM.id}:${x1.id}:${y1.id}`];
  const room = graph.addRoom(new Set([topKey, ...botKeys]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', '2400');
  return { room, yM, botKeys };
}

test('familyCeilingSegments: 面の向こう側(far側)に部分指定の子セルがあれば、その天井絶対高さの区間を返す', () => {
  const graph = makeGraph();
  const { room, yM, botKeys } = makeTwoRowFamily(graph);
  const child = graph.addRoom(new Set(botKeys), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400'); // 天井絶対高さ=−100+2400=2300

  // 中間CL上の合成face: inward=-1（near=上行）→ far側プローブ=下行（子）。
  const face = { axisCL: yM, isVertical: false, inward: -1, lo: 0, hi: 4000, originWorld: 0, dirSign: 1 };
  const segs = familyCeilingSegments(face, room, graph);

  assert.equal(segs.length, 1, `向こう側=子の1区間のはず（実際:${JSON.stringify(segs)}）`);
  assert.equal(segs[0].ceilAbsMm, 2300, '子の天井絶対高さ(−100+2400=2300)のはず');
  assert.equal(segs[0].loX, 0);
  assert.equal(segs[0].hiX, 4000);
});

// ---- 失敗系: 外周壁（向こう側が部屋外）の面は空——A1/B1/D2の誤検出（旧・全セル投影方式）の門番 ----
test('【失敗系・問題修正2026-08その5】familyCeilingSegments: 向こう側が部屋外の外周面は空を返す（部屋内の別エリアが同じrun座標にあっても拾わない）', () => {
  const graph = makeGraph();
  const { room, botKeys } = makeTwoRowFamily(graph);
  const child = graph.addRoom(new Set(botKeys), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400'); // 天井2300（部屋内の別エリア）

  // 外周面すべて: 壁の向こう側は部屋外＝部分指定関係のある部屋は無い → 破線の元データは空。
  for (const face of buildRoomFaces(room, graph)) {
    const segs = familyCeilingSegments(face, room, graph);
    assert.deepEqual(segs, [], `外周面${face.label}は空のはず（実際:${JSON.stringify(segs)}）`);
  }
});

// ---- 失敗系: face.lo/hiの外はプローブしない（クランプ） ----
test('【失敗系】familyCeilingSegments: face.lo/hiの範囲だけをプローブし、ローカルxへクランプされる', () => {
  const graph = makeGraph();
  const { room, yM, botKeys } = makeTwoRowFamily(graph);
  const child = graph.addRoom(new Set(botKeys), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400');

  const face = { axisCL: yM, isVertical: false, inward: -1, lo: 100, hi: 1800, originWorld: 100, dirSign: 1 };
  const segs = familyCeilingSegments(face, room, graph);

  assert.equal(segs.length, 1);
  assert.equal(segs[0].loX, 0, '区間はface.loでクランプされるはず');
  assert.equal(segs[0].hiX, 1700, '区間はface.hiでクランプされるはず（1800-100=ローカル1700）');
});

// ---- dirSign<0の面でもローカルx（loX<hiX）へ正しく反転する ----
test('familyCeilingSegments: dirSign=-1の面では世界座標が反転してもloX<hiXの正規化済み区間になる', () => {
  const graph = makeGraph();
  const { room, yM, botKeys } = makeTwoRowFamily(graph, { splitBottom: true });
  // 下行左(0..2000)だけ子（天井2300）、下行右(2000..4000)は親のまま（天井2400）。
  const child = graph.addRoom(new Set([botKeys[0]]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400');

  const face = { axisCL: yM, isVertical: false, inward: -1, lo: 0, hi: 4000, originWorld: 4000, dirSign: -1 };
  const segs = familyCeilingSegments(face, room, graph);

  const at2300 = segs.find(s => s.ceilAbsMm === 2300);
  const at2400 = segs.find(s => s.ceilAbsMm === 2400);
  assert.ok(at2300 && at2400, `子(2300)・親(2400)の両区間が見つかるはず（実際:${JSON.stringify(segs)}）`);
  assert.ok(segs.every(s => s.loX < s.hiX), '全区間がloX<hiXへ正規化されているはず');
  assert.equal(at2300.loX, 2000, '子(世界0..2000)はローカル2000..4000へ反転するはず');
  assert.equal(at2300.hiX, 4000);
  assert.equal(at2400.loX, 0, '親(世界2000..4000)はローカル0..2000へ反転するはず');
  assert.equal(at2400.hiX, 2000);
});

// ---- drawnCeilingRiserX: 天井段差の描画xは「低い方からみてCLの向こう側」＝高い側へ半壁厚ずれる ----
test('drawnCeilingRiserX: 天井の絶対高さが高い側へhalfWallMmぶんずれる（床のdrawnRiserXと逆向きの規約）', () => {
  const segs = [
    { hiX: 2000, floorDeltaMm: 0, chMm: 2400 },
    { hiX: 4000, floorDeltaMm: 0, chMm: 2600 }, // 右が高い
  ];
  assert.equal(drawnCeilingRiserX(segs, 0, 57.5), 2000 + 57.5, '低い方(左)からみてCLの向こう側=右へずれる');
});

test('【失敗系】drawnCeilingRiserX: 左の天井が高ければ左方向へずれる。床段差込みの絶対高さ(FL+CH)で比較する', () => {
  const segs = [
    { hiX: 2000, floorDeltaMm: 300, chMm: 2400 }, // 絶対高さ2700（高い）
    { hiX: 4000, floorDeltaMm: 0,   chMm: 2500 }, // 絶対高さ2500（低い）
  ];
  assert.equal(drawnCeilingRiserX(segs, 0, 57.5), 2000 - 57.5, 'chMm単体ではなくFL+CHの絶対高さで比較し、高い側(左)へずれるはず');
});

// ---- drawnRiserX: 床が低い側へ半壁厚だけずれる（オフセット前=hiXとは別の値） ----
test('drawnRiserX: 段差の描画xは、floorDeltaMmが小さい（低い）側へhalfWallMmぶんずれる', () => {
  const segs = [
    { hiX: 2000, floorDeltaMm: 0 },
    { hiX: 4000, floorDeltaMm: 300 },
  ];
  // segs[0]=0(低い)・segs[1]=300(高い)なので、低い側=segs[0]の方向（xが小さくなる方向）へずれる。
  assert.equal(drawnRiserX(segs, 0, 57.5), 2000 - 57.5);
});

// ---- 失敗系: 逆向き（左が高い・右が低い）なら右方向へずれる ----
test('【失敗系】drawnRiserX: floorDeltaMmが右側の方が低ければ、低い側(右)=xが大きくなる方向へずれる', () => {
  const segs = [
    { hiX: 2000, floorDeltaMm: 300 },
    { hiX: 4000, floorDeltaMm: 0 },
  ];
  assert.equal(drawnRiserX(segs, 0, 57.5), 2000 + 57.5);
});

// ---- halfWallThicknessMm: |faceValue - axisCL.effectiveValue| ----
test('halfWallThicknessMm: 面自身のfaceValueとaxisCL.effectiveValueの差（半壁厚）を返す', () => {
  const face = { faceValue: 2057.5, axisCL: { effectiveValue: 2000 } };
  assert.equal(halfWallThicknessMm(face), 57.5);
});

// ---- 失敗系: faceValue===axisCL.effectiveValue（差0）は既定値57.5へフォールバックする ----
test('【失敗系】halfWallThicknessMm: 差が0（合成face等で不明）ならDEFAULT_HALF_WALL_MM(57.5)へフォールバックする', () => {
  const face = { faceValue: 0, axisCL: { effectiveValue: 0 } };
  assert.equal(halfWallThicknessMm(face), 57.5);
});

// ==== 断面線の外は描画しない（折れ線輪郭方式。ユーザー明示指示2026-09） ====
// QA修正2026-09: 実装をsection/sectionEmit.jsから本ファイルへ移したのに合わせ、
// テストもsectionEmit.test.jsからそのまま移設した（内容は無変更）。
const SEGS = [{ loX: 0, hiX: 1000, floorDeltaMm: 0 }, { loX: 1000, hiX: 2000, floorDeltaMm: 500 }];
const PROFILE = floorProfileFromSegments(SEGS);

test('floorProfileFromSegments: 段差は同じxを2点にして垂直に落とす', () => {
  assert.deepEqual(PROFILE, [[0, 0], [1000, 0], [1000, 500], [2000, 500]]);
});

test('clipContentAboveDrawnProfile: 断面線より下の縦線は輪郭で切り、全部下なら落とす', () => {
  const prims = [
    { type: 'line', x1: 1500, y1: 0, x2: 1500, y2: -2000 },   // 床500をまたぐ → 500から
    { type: 'line', x1: 1500, y1: 0, x2: 1500, y2: -400 },    // 全部床より下 → 落ちる
    { type: 'line', x1: 500, y1: 0, x2: 500, y2: -2000 },     // 床0の区間 → そのまま
  ];
  const out = clipContentAboveDrawnProfile(prims, PROFILE);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].y1, out[0].y2], [-500, -2000], '輪郭をまたぐ縦線は輪郭で切れるはず');
  assert.deepEqual([out[1].y1, out[1].y2], [0, -2000], '床0の区間の縦線は切られないはず');
});

test('【2026-10-15】clipContentAboveDrawnProfile: 輪郭の垂直な段の上に載る縦線は、両側のうち低い方の輪郭で切る（左右どちら側の段でも同じ）', () => {
  // 復路下の壁の断面の両面: 踊り場側（1400）と仕上げ空間（床 0）の境＝段の位置に壁の面の縦線が載る
  const stepLeft = [[0, 1400], [470, 1400], [470, 0], [1675, 0]];   // 左が高い段（stair-ports-test5 の seq5）
  const stepRight = [[0, 0], [967.5, 0], [967.5, 2200], [1747.5, 2200]]; // 右が高い段（moku4-3 の seq5）
  const v = (x, zHi) => ({ type: 'line', x1: x, y1: 0, x2: x, y2: -zHi });
  assert.deepEqual(clipContentAboveDrawnProfile([v(470, 1015)], stepLeft), [v(470, 1015)], '左が高い段の上の縦線は低い側（0）で判定して残す');
  assert.deepEqual(clipContentAboveDrawnProfile([v(967.5, 1615)], stepRight), [v(967.5, 1615)], '右が高い段の上の縦線も同じ');
  assert.deepEqual(clipContentAboveDrawnProfile([v(469, 1015)], stepLeft), [], '段の高い側（x=469 は 1400 の下）は従来どおり落ちる');
  assert.deepEqual(clipContentAboveDrawnProfile([v(969, 1615)], stepRight), [], '段の高い側（x=969 は 2200 の下）も落ちる');
  const out = clipContentAboveDrawnProfile([v(469, 2000)], stepLeft);
  assert.deepEqual([out[0].y1, out[0].y2], [-1400, -2000], '段の高い側をまたぐ縦線はその側の輪郭で切る');
});

test('clipContentAboveDrawnProfile: 床の高さちょうどの水平線（床断面線そのもの）は残す', () => {
  const out = clipContentAboveDrawnProfile([
    { type: 'line', x1: 1200, y1: -500, x2: 2000, y2: -500 }, // 床断面線そのもの
    { type: 'line', x1: 1200, y1: -200, x2: 2000, y2: -200 }, // 床より下
  ], PROFILE);
  assert.equal(out.length, 1, '床より下の水平線だけが落ちるはず');
  assert.equal(out[0].y1, -500);
});

test('clipContentAboveDrawnProfile: 矩形（建具の姿）は下端を輪郭まで詰める', () => {
  const out = clipContentAboveDrawnProfile([{ type: 'rect', x: 1200, y: -2000, w: 30, h: 1990 }], PROFILE);
  assert.equal(out.length, 1);
  assert.equal(out[0].y, -2000, '上端は動かさないはず');
  assert.equal(out[0].h, 1500, '下端は輪郭(500)まで＝高さ2000-500のはず');
});

// 斜めの輪郭（階段断面）: x:0→1000でz:0→1000へ上る。
const SLOPE = [[0, 0], [1000, 1000]];

test('clipContentAboveDrawnProfile: 斜めの輪郭を跨ぐ縦線は交点で切れる', () => {
  const out = clipContentAboveDrawnProfile(
    [{ type: 'line', x1: 400, y1: 0, x2: 400, y2: -900 }], SLOPE);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].y1, out[0].y2], [-400, -900], 'x=400の輪郭(400)から上だけ残るはず');
});

test('clipContentAboveDrawnProfile: 水平線は輪郭より下のx範囲だけが落ちる', () => {
  const out = clipContentAboveDrawnProfile(
    [{ type: 'line', x1: 0, y1: -600, x2: 1000, y2: -600 }], SLOPE);
  assert.equal(out.length, 1, '交点(x=600)で分かれ、輪郭より上の側だけ残るはず');
  assert.ok(Math.abs(out[0].x1 - 0) < 1e-6 && Math.abs(out[0].x2 - 600) < 1e-6,
    `輪郭が上回る手前（x:0..600）だけ残るはず（実際:${out[0].x1}..${out[0].x2}）`);
});

test('clipContentAboveDrawnProfile: polylineは輪郭で分断され、残った区間ごとに1本になる', () => {
  // 谷型の輪郭（両端が高く中央が0）。水平なpolylineは中央だけが残る。
  const valley = [[0, 1000], [400, 0], [600, 0], [1000, 1000]];
  const out = clipContentAboveDrawnProfile(
    [{ type: 'polyline', points: [[0, -500], [1000, -500]], weight: 'thin' }], valley);
  assert.equal(out.length, 1, '中央の1本だけが残るはず');
  assert.equal(out[0].weight, 'thin', '属性は引き継ぐはず');
  const xs = out[0].points.map(([x]) => x);
  assert.ok(Math.abs(Math.min(...xs) - 200) < 1e-6 && Math.abs(Math.max(...xs) - 800) < 1e-6,
    `残るのはx:200..800のはず（実際:${JSON.stringify(out[0].points)}）`);
});

test('drawnFloorProfileZMax: 区間の最大（中点ではなく）を返す', () => {
  assert.equal(drawnFloorProfileZMax(SLOPE, 200, 800), 800);
  assert.equal(drawnFloorProfileZMax(PROFILE, 900, 1100), 500, '段差をまたぐ区間は高い側');
});

test('mergeFloorProfiles: 交わる2本は交点xを挿入してmaxになる', () => {
  const merged = mergeFloorProfiles([[0, 0], [1000, 1000]], [[0, 1000], [1000, 0]]);
  assert.ok(merged.some(([x, z]) => Math.abs(x - 500) < 1e-6 && Math.abs(z - 500) < 1e-6),
    `交点(500,500)が挿入されるはず（実際:${JSON.stringify(merged)}）`);
  assert.equal(drawnFloorProfileZAt(merged, 250), 750, '交点より左は下り側(高い方)のはず');
  assert.equal(drawnFloorProfileZAt(merged, 750), 750, '交点より右は上り側(高い方)のはず');
});

test('mergeFloorProfiles: 短い寄与は自分のx範囲の外まで相手を押し上げない', () => {
  // 踊り場（[2000,3000]でz=1500）と階段（[0,2000]でz:0→1500）の関係。踊り場の端点値が
  // 面の全長を覆うと、レーンの床線が丸ごと消える（回帰: seq2）。
  const merged = mergeFloorProfiles([[0, 0], [2000, 1500]], [[2000, 1500], [3000, 1500]]);
  assert.equal(drawnFloorProfileZAt(merged, 0), 0, '階段の足元は0のままのはず');
  assert.equal(drawnFloorProfileZAt(merged, 1000), 750);
  assert.equal(drawnFloorProfileZAt(merged, 2500), 1500);
});

test('【失敗系】clipContentAboveDrawnProfile: profile未指定なら入力配列をそのまま返す（通常の部屋帯・吹抜け帯は無変化）', () => {
  const prims = [{ type: 'line', x1: 1500, y1: 0, x2: 1500, y2: -400 }];
  assert.equal(clipContentAboveDrawnProfile(prims, null), prims);
  assert.equal(clipContentAboveDrawnProfile(prims, []), prims);
  assert.equal(drawnFloorProfileZAt(null, 100), -Infinity);
  assert.equal(drawnFloorProfileZMax(null, 0, 100), -Infinity);
});

test('【失敗系】clipContentAboveDrawnProfile: 輪郭と交わらない線は無傷（同じオブジェクトの値のまま）', () => {
  const prims = [
    { type: 'line', x1: 0, y1: -1800, x2: 2000, y2: -1800, weight: 'thin', dash: 'dashed' },
    { type: 'text', x: 500, y: -1000, text: 'ア キ' },
  ];
  const out = clipContentAboveDrawnProfile(prims, PROFILE);
  assert.equal(out.length, 2);
  assert.deepEqual({ ...out[0] }, prims[0], '輪郭より上の線は属性ごとそのままのはず');
  assert.equal(out[1], prims[1]);
});

test('drawnFloorProfileZAt: 範囲外（壁のない端部のはり出しぶん）は端点値を保持する', () => {
  assert.equal(drawnFloorProfileZAt(PROFILE, -150), 0);
  assert.equal(drawnFloorProfileZAt(PROFILE, 2150), 500);
});

// ---- QA指摘: -0 を出力しない（sectionStair.jsのstairCutFloorProfile・elevationFigure.jsの
// endFloorYOfと同じ規約。z=0の輪郭で切ると -(0) = -0 になり、Object.is比較（assert.strict・
// ゴールデン）が 0 と食い違う） ----
test('clipContentAboveDrawnProfile: 輪郭の値が0の区間でも -0 を出力しない', () => {
  const profile = [[0, 0], [1000, 0]];
  const [line] = clipContentAboveDrawnProfile(
    [{ type: 'line', x1: 500, y1: 500, x2: 500, y2: -2000 }], profile);
  assert.equal(Object.is(line.y1, -0), false, `縦線の切り口が-0になっている（実際:${line.y1}）`);
  assert.equal(line.y1, 0);
  // polylineは切り口が区間の**先頭**になる向き（下→上）と**末尾**になる向き（上→下）の両方。
  const polys = clipContentAboveDrawnProfile([
    { type: 'polyline', points: [[0, 500], [1000, -500]] },
    { type: 'polyline', points: [[0, -500], [1000, 500]] },
  ], profile);
  assert.equal(polys.length, 2);
  for (const poly of polys) {
    assert.ok(poly.points.every(([, y]) => Object.is(y, -0) === false),
      `polylineの切り口が-0になっている（実際:${JSON.stringify(poly.points)}）`);
  }
});

// ---- QA指摘: profileLimitsOn（外挿）の極小区間ガード ----
// 「同じ位置のはずの2点」が丸め誤差でμm単位ずれた準垂直な段差が、区間の**内側**に挟まると、
// 外挿の分母(2q)が潰れて段差の高さぶん上下へ飛び出した値が返る（＝合成結果に入力のどこにも
// 無いzが現れる）。PROFILE_LIMIT_MIN_SPAN_MM(1e-3mm)未満の区間は外挿せず端点値を使う。
test('【失敗系】mergeFloorProfiles: μm幅の準垂直な段差があってもNaN・入力範囲外のzを出さない', () => {
  const a = [[0, 0], [1000, 0], [1000.0000005, 1000], [2000, 1000]]; // 1000で0→1000へ立つ
  const b = [[0, -5000], [999.999999, -5000], [1000.000002, -5000], [2000, -5000]];
  const merged = mergeFloorProfiles(a, b);
  for (const [x, z] of merged) {
    assert.ok(Number.isFinite(x) && Number.isFinite(z), `NaN/Infinityが出ている: ${JSON.stringify([x, z])}`);
    assert.ok(z >= -5000 - 1e-6 && z <= 1000 + 1e-6,
      `入力のz範囲(-5000..1000)の外の値が出ている: ${JSON.stringify([x, z])}`);
  }
});

test('【失敗系・2026-10-08】clipContentAboveDrawnProfile: 端点だけが断面線に触れる水平線は長さ0の線を残さず落とす（触れない側は従来どおり残す）', () => {
  const rising = [[0, 0], [1000, 2000]];
  const touching = [{ type: 'line', x1: 0, y1: 0, x2: 1000, y2: 0, weight: 'medium' }];
  assert.deepEqual(clipContentAboveDrawnProfile(touching, rising), [], '輪郭の上に出る部分が無い（z=0は輪郭より下へ潜る）');
  // 逆向き（右端で触れる）も同様
  const falling = [[0, 2000], [1000, 0]];
  assert.deepEqual(clipContentAboveDrawnProfile([{ type: 'line', x1: 0, y1: 0, x2: 1000, y2: 0, weight: 'medium' }], falling), []);
  // 輪郭の上へ出る部分があれば従来どおり残る
  const crossing = [{ type: 'line', x1: 0, y1: -1000, x2: 1000, y2: -1000, weight: 'medium' }];
  const out = clipContentAboveDrawnProfile(crossing, rising);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].x1) < 1e-6 && Math.abs(out[0].x2 - 500) < 1e-6, `x 0..500（輪郭より上）が残る: ${out[0].x1}..${out[0].x2}`);
});

// ---- 天伏の平面区画（区画の境界で天井断面線が割れる） ----
// 1セルの部屋（x 0..5000 × y 0..3000）に天井芯 x=2000 を足し、天井セルを区画にする。
// 区画の境界は仕上げの格子ではなく天伏だけの線＝壁の中心線に載らない（実機の主寝室と同じ形）。
function zoneFace(zones, shape = 'flat', { dims = [600, 0], faceAxis = 0 } = {}) {
  const g = makeGrid([0, 5000], [0, 3000]);
  const room = g.interior([[0, 0]], { walls: true });
  room.setOverride('ceilingHeight', '2500');
  g.graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.CEILING }, 'cc');
  for (const [x, mm] of zones) {
    const key = worldToCell(x, 1500, g.graph, CEILING_CELL_GRID).key;
    room.setCeilingZones(createZone(g.graph, room, [key], { heightMm: mm, shape, dims: shape === 'flat' ? [] : dims }).zones);
  }
  const face = buildRoomFaces(room, g.graph).find(f => !f.isVertical && f.axisCL.value === faceAxis);
  return { g, room, face };
}
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg ?? ''} 実際:${actual} 期待:${expected}`);

test('【天井芯の上の区画境界で分割】左2400・右3000 は x=2000 で割れ、境界のCL idはnull・zoneCeilEdgeHi あり', () => {
  const { g, room, face } = zoneFace([[1000, 2400], [3500, 3000]]);
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map(s => s.chMm), [2400, 3000]);
  assert.deepEqual(segs.map(s => [s.loX, s.hiX]), [[0, 1942.5], [1942.5, 4885]], '面は壁の内面（芯から57.5）から始まる＝x=2000 の芯はローカル1942.5');
  assert.equal(segs[0].hiCLId, null, '区画境界は天井芯でありCLではない');
  assert.equal(segs[1].loCLId, null);
  const b = zoneFace([]); // 区画なし（同じ id の CL を持つ別 graph）
  const base = wallAdjacentFloorSegments(b.face, b.room, b.g.graph)[0];
  assert.equal(segs[0].loCLId, base.loCLId, '先頭の片は元のloCLIdを引き継ぐ');
  assert.equal(segs[1].hiCLId, base.hiCLId, '最後の片は元のhiCLIdを引き継ぐ');
  assert.equal(segs[0].zoneCeilEdgeHi, true);
  assert.equal('zoneCeilEdgeHi' in segs[1], false, '該当するときだけ付ける');
  assert.equal('owner' in segs[0], false, '内部用ownerは出力に出さない');
});

test('【区画なしは変更前と deepEqual】区画の無い部屋は1区間・余計なキーなし', () => {
  const { g, room, face } = zoneFace([]);
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 1);
  assert.deepEqual(Object.keys(segs[0]).sort(), ['chMm', 'floorDeltaMm', 'hiCLId', 'hiX', 'loCLId', 'loX']);
  assert.equal(segs[0].chMm, 2500);
});

test('【区画高＝部屋CHは1区間に戻り hiCLId も保つ】右区画 2500（部屋CHと同じ）', () => {
  const { g, room, face } = zoneFace([[3500, 2500]]);
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].chMm, 2500);
  assert.equal(segs[0].loX, 0);
  assert.equal(segs[0].hiX, 4885);
  const b = zoneFace([]);
  const base = wallAdjacentFloorSegments(b.face, b.room, b.g.graph);
  assert.deepEqual(segs, base, '区画高＝部屋CHなら区画なしと同じ（端のCL idも元のまま）');
  assert.equal('zoneCeilEdgeHi' in segs[0], false);
});

// ---- E4: 円弧・ドーム（片の chMm〔lo 端〕・chHiMm〔hi 端〕に加え、頭頂があれば ceilArc:{alongX, chMm}） ----
test('【arc 区画の片に ceilArc】右区画 arc[400,90]（x 2000..5000・幅3000・R=3012.5）: 左は平面 2500・右は 2400→2432.18・頭頂 alongX 3442.5 で 2800', () => {
  const { g, room, face } = zoneFace([[3500, 2400]], 'arc', { dims: [400, 90] });
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].chMm, 2500);
  assert.equal('ceilArc' in segs[0], false, '平らな片は ceilArc を持たない');
  assert.equal('chHiMm' in segs[0], false);
  near(segs[1].chMm, 2400, '縁（x=2000）');
  near(segs[1].chHiMm, 2400 + Math.sqrt(3012.5 ** 2 - 1442.5 ** 2) - 2612.5, '壁の仕上げ面（x=4942.5）で評価');
  assert.equal(segs[1].ceilArc.alongX, 3442.5);
  near(segs[1].ceilArc.chMm, 2800, '頭頂');
});

test('【dirSign<0 で alongX が反転】反対側の壁（y=3000）は lo/hi の高さが入れ替わり、頭頂のローカル x は 4942.5−3500=1442.5', () => {
  const { g, room, face } = zoneFace([[3500, 2400]], 'arc', { dims: [400, 90], faceAxis: 3000 });
  assert.equal(face.dirSign, -1);
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].ceilArc.alongX, 1442.5);
  near(segs[0].chMm, 2400 + Math.sqrt(3012.5 ** 2 - 1442.5 ** 2) - 2612.5, 'lo 側が世界の hi 端の高さ');
  near(segs[0].chHiMm, 2400, 'hi 側が世界の lo 端（縁）の高さ');
  assert.equal('ceilArc' in segs[1], false);
});

test('【arc は結合しない】CL で割れる円弧の片は 1 面＝1 片のまま、頭頂を持つ片は隣と結合しない', () => {
  // 天井芯 x=2000 の左右とも同じ arc[400,90]（高さ同じ）の区画にしても、各区画の片は結合されない
  const { g, room, face } = zoneFace([[1000, 2400], [3500, 2400]], 'arc', { dims: [400, 90] });
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 2, '区画ごとに 1 片');
  assert.ok(segs.every(s => s.ceilArc), '両方の片が頭頂を持つ');
});

test('【arc（軸に平行な壁）は一定の水平な片】arc[400,0] を走り x の壁で見ると 1 片・chMm は壁の仕上げ面の深さの高さ・chHiMm/ceilArc なし', () => {
  const { g, room, face } = zoneFace([[3500, 2400]], 'arc', { dims: [400, 0] });
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 2);
  near(segs[1].chMm, 2400 + Math.sqrt(3012.5 ** 2 - 1442.5 ** 2) - 2612.5, 'y=57.5（t=1442.5）の高さ');
  assert.equal('chHiMm' in segs[1], false);
  assert.equal('ceilArc' in segs[1], false);
});

test('【dome の片】dome[500]（x 2000..5000 × y 0..3000）の壁 y=0 の面: 両端 2400+500×0 より仕上げ面の分だけ高く、頭頂は中央 x=3500', () => {
  const { g, room, face } = zoneFace([[3500, 2400]], 'dome', { dims: [500] });
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  const dome = segs[1];
  assert.equal(dome.ceilArc.alongX, 3442.5);
  const qq = (1 - (1442.5 / 1500) ** 2);
  near(dome.ceilArc.chMm, 2400 + 500 * qq, '頭頂 = 底＋ライズ×(1−q²)（q は壁の仕上げ面の正規化奥行き）');
  assert.ok(dome.chHiMm > 2400 && dome.chHiMm < dome.ceilArc.chMm);
});

test('【flat・slope は出力形不変】ceilArc を持たない（キー自体なし）', () => {
  for (const shape of ['flat', 'slope']) {
    const { g, room, face } = zoneFace([[3500, 2700]], shape);
    const segs = wallAdjacentFloorSegments(face, room, g.graph);
    assert.ok(segs.every(s => !('ceilArc' in s)), shape);
  }
});

// ---- 天伏の傾斜（E3a-2: 片の両端の高さ chMm〔lo 端〕・chHiMm〔hi 端〕。壁の仕上げ面で評価） ----
test('【傾斜区画の片に chHiMm】右区画 slope[600,+x]・底 2400（x 2000..5000）: 左は平面 2500・右は 2400→2988.5（面は仕上げ面 x 57.5..4942.5）', () => {
  const { g, room, face } = zoneFace([[3500, 2400]], 'slope');
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].chMm, 2500);
  assert.equal('chHiMm' in segs[0], false, '平らな片はキー自体を持たない');
  assert.equal(segs[0].zoneCeilEdgeHi, true, '同じ所有者の高さの違う境界＝壁の無い境界');
  near(segs[1].chMm, 2400, '区画の左端 x=2000 は底');
  near(segs[1].chHiMm, 2988.5, 'x=4942.5: 2400 + 600×(4942.5−2000)/3000');
  assert.deepEqual([segs[1].loX, segs[1].hiX], [1942.5, 4885]);
});

test('【dirSign<0 の面では chMm/chHiMm が入れ替わる】向かいの壁（y=3000。ローカル x は世界 x と逆）', () => {
  const { g, room, face } = zoneFace([[3500, 2400]], 'slope', { faceAxis: 3000 });
  assert.equal(face.dirSign, -1, '前提: 向かいの面は逆向き');
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 2);
  near(segs[0].chMm, 2988.5, 'ローカル 0＝世界 x 4942.5（高い側）');
  near(segs[0].chHiMm, 2400, 'ローカル hiX＝世界 x 2000（底）');
  assert.equal(segs[1].chMm, 2500, '左の平らな片はローカルの右に回る');
  assert.equal(segs[1].zoneCeilEdgeHi, undefined);
  assert.equal(segs[0].zoneCeilEdgeHi, true);
});

test('【走りに直交する向きの傾斜】slope[600,+y]（y 0..3000）を壁 y=0 の面で見ると両端同値・chHiMm なし・芯ではなく仕上げ面 y=57.5 の値 2411.5', () => {
  const { g, room, face } = zoneFace([[1000, 2400], [3500, 2400]], 'slope', { dims: [600, 90] });
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 1, '両区画とも同値＝結合');
  near(segs[0].chMm, 2400 + 600 * 57.5 / 3000, '仕上げ面（faceValue 57.5）で評価。芯 y=0 なら 2400');
  assert.equal('chHiMm' in segs[0], false);
  assert.equal(face.faceValue, 57.5, '前提: 評価点は face.faceValue');
});

test('【部屋形状の slope（setRoomCeilingShape）も片に効く】CL x=2000 で割れた格子も1本の斜線に結合する', () => {
  const { g, room, face } = zoneFace([]);
  setRoomCeilingShape(room, { shape: 'slope', dims: [300, 0] });
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 1, '天井芯 x=2000 で刻んだ片は連続・同勾配＝結合');
  near(segs[0].chMm, 2500 + 300 * 57.5 / 5000, 'x=57.5 の値（底は部屋の CH 2500）');
  near(segs[0].chHiMm, 2500 + 300 * 4942.5 / 5000, 'x=4942.5');
  assert.equal(segs[0].hiX, 4885);
  assert.equal('zoneCeilEdgeHi' in segs[0], false);
});

test('【区画なし・平面区画は chHiMm キーなし（出力形不変）】', () => {
  for (const zones of [[], [[1000, 2400], [3500, 3000]]]) {
    const { g, room, face } = zoneFace(zones);
    for (const s of wallAdjacentFloorSegments(face, room, g.graph)) assert.equal('chHiMm' in s, false);
  }
});

test('【drawnCeilingRiserX】傾いた区間は境界に接する端の高さで高低を決める（手前の hi 端・次の lo 端）', () => {
  // 手前は 2400→3000 の傾斜。境界での高さは手前 3000・次 2800 → 手前が高い＝低い側（次）へ-半壁厚
  const segs = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, chMm: 2400, chHiMm: 3000 },
    { loX: 2000, hiX: 5000, floorDeltaMm: 0, chMm: 2800 },
  ];
  assert.equal(drawnCeilingRiserX(segs, 0, 60, 2400), 1940);
  // lo 端 2400 だけで比べると次の方が高く見えてしまう（+60）——hi 端で比べていることの対照
  assert.notEqual(drawnCeilingRiserX(segs, 0, 60, 2400), 2060);
});

test('【drawnCeilingRiserX】区画境界（zoneCeilEdgeHi）はずらさない・無印の境界は従来どおり半壁厚ずらす', () => {
  const segs = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, chMm: 2400, zoneCeilEdgeHi: true },
    { loX: 2000, hiX: 5000, floorDeltaMm: 0, chMm: 3000 },
  ];
  assert.equal(drawnCeilingRiserX(segs, 0, 60, 2400), 2000);
  const plain = [{ ...segs[0], zoneCeilEdgeHi: undefined }, segs[1]];
  assert.equal(drawnCeilingRiserX(plain, 0, 60, 2400), 2060, '従来どおり天井が高い側へ半壁厚');
});

test('【drawnRiserX】区画境界（zoneCeilEdgeHi）は床側もずらさない（床の段差ではない）。無印は従来どおり', () => {
  const segs = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, chMm: 2400, zoneCeilEdgeHi: true },
    { loX: 2000, hiX: 5000, floorDeltaMm: 0, chMm: 3000 },
  ];
  assert.equal(drawnRiserX(segs, 0, 60), 2000);
  assert.equal(drawnRiserX([{ ...segs[0], zoneCeilEdgeHi: undefined }, segs[1]], 0, 60), 1940, '従来どおり（同じ床なら手前側へ半壁厚）');
});

test('【区画＋床段差の部分指定の子】床+100 の子に区画 3000: 片は {floorDeltaMm:100, chMm:3000}（体裁側で床段差を二重に足さない）。所有者が違う境界に zoneCeilEdgeHi は付かない', () => {
  const g = makeGrid([0, 2500, 5000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]], { walls: true });
  parent.setOverride('ceilingHeight', '2500');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setFloorLevel(100);
  child.setCeilingZones(createZone(g.graph, child, [g.cell(1, 0)], { heightMm: 3000, shape: 'flat', dims: [] }).zones);
  const face = buildRoomFaces(parent, g.graph).find(f => !f.isVertical && f.axisCL.value === 0);
  const segs = wallAdjacentFloorSegments(face, parent, g.graph);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map(s => [s.floorDeltaMm, s.chMm]), [[0, 2500], [100, 3000]]);
  assert.equal('zoneCeilEdgeHi' in segs[0], false, '親と子の境界は所有者が違う＝従来どおり（半壁厚ずらし）');
  assert.equal('owner' in segs[0], false);
});

test('【床 +100 の部分指定の子に傾斜区画】floorDeltaMm=100 は別に持ち、chMm/chHiMm に床段差 100 を足さない（3000 → 3000+600×2442.5/2500）', () => {
  const g = makeGrid([0, 2500, 5000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]], { walls: true });
  parent.setOverride('ceilingHeight', '2500');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setFloorLevel(100);
  child.setCeilingZones(createZone(g.graph, child, [g.cell(1, 0)], { heightMm: 3000, shape: 'slope', dims: [600, 0] }).zones);
  const face = buildRoomFaces(parent, g.graph).find(f => !f.isVertical && f.axisCL.value === 0);
  const segs = wallAdjacentFloorSegments(face, parent, g.graph);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].floorDeltaMm, 100);
  near(segs[1].chMm, 3000, 'lo 端は区画の底（床段差を足さない）');
  near(segs[1].chHiMm, 3000 + 600 * 2442.5 / 2500, 'hi 端 x=4942.5');
  assert.equal('chHiMm' in segs[0], false);
});

// ---- 天伏の平面区画（C2: 壁の向こうの家族の天井の破線が区画に追従） ----
function zonedFamily(zones) {
  const graph = makeGraph();
  const { room, yM, botKeys } = makeTwoRowFamily(graph);
  const child = graph.addRoom(new Set(botKeys), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400');
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.CEILING }, 'cc');
  for (const [x, mm, shape] of zones) {
    const key = worldToCell(x, 2250, graph, CEILING_CELL_GRID).key;
    child.setCeilingZones(createZone(graph, child, [key], { heightMm: mm, shape: shape ?? 'flat', dims: shape ? [600, 0] : [] }).zones);
  }
  const face = { axisCL: yM, isVertical: false, inward: -1, lo: 0, hi: 4000, originWorld: 0, dirSign: 1 };
  return familyCeilingSegments(face, room, graph);
}

test('【familyCeilingSegments は far 側の区画で ceilAbsMm が割れる】子の右半分が区画 3000 なら天井芯 x=2000 で 2300 / 2900', () => {
  const segs = zonedFamily([[3000, 3000]]);
  assert.deepEqual(segs, [
    { loX: 0, hiX: 2000, ceilAbsMm: 2300 },
    { loX: 2000, hiX: 4000, ceilAbsMm: 2900 },
  ]);
});

test('【区画なしは不変】区画のない家族は従来どおり1区間 2300', () => {
  assert.deepEqual(zonedFamily([]), [{ loX: 0, hiX: 4000, ceilAbsMm: 2300 }]);
});

// ---- 天伏の傾斜（E3b-2: 家族の破線の片に ceilAbsHiMm。断面なので壁の外側の仕上げ面で評価） ----
// 子（床−100・CH2400）の右半分 x 2000..4000 に区画（底 3000・勾配 600/2000）。
function zonedFamilyTilt({ dims, dirSign = 1, withWall = false, shape = 'slope' }) {
  const graph = makeGraph();
  const { room, yM, botKeys } = makeTwoRowFamily(graph);
  const child = graph.addRoom(new Set(botKeys), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400');
  if (withWall) generateRoomWallsFromOutline(graph, child); // 中間CL y=1500 にも壁が立つ
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.CEILING }, 'cc');
  const key = worldToCell(3000, 2250, graph, CEILING_CELL_GRID).key;
  child.setCeilingZones(createZone(graph, child, [key], { heightMm: 3000, shape, dims }).zones);
  const face = { axisCL: yM, isVertical: false, inward: -1, lo: 0, hi: 4000, originWorld: dirSign < 0 ? 4000 : 0, dirSign };
  return { segs: familyCeilingSegments(face, room, graph), graph, yM };
}

test('【家族の破線の片に ceilAbsHiMm】走り方向 slope[600,+x]: 左は平ら 2300・右は 2900→3500（床−100 込み。区画の底 3000＋勾配 600/2000）', () => {
  const { segs } = zonedFamilyTilt({ dims: [600, 0] });
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].loX, segs[0].hiX, segs[0].ceilAbsMm], [0, 2000, 2300]);
  assert.equal('ceilAbsHiMm' in segs[0], false, '平らな片はキー自体を持たない');
  assert.deepEqual([segs[1].loX, segs[1].hiX], [2000, 4000]);
  near(segs[1].ceilAbsMm, 2900, 'x=2000: −100＋3000');
  near(segs[1].ceilAbsHiMm, 3500, 'x=4000: −100＋3600');
});

test('【dirSign<0 で ceilAbsMm/ceilAbsHiMm が入れ替わる】向かいから見ると傾斜の片はローカル 0..2000 で 3500→2900', () => {
  const { segs } = zonedFamilyTilt({ dims: [600, 0], dirSign: -1 });
  const tilt = segs.find(s => 'ceilAbsHiMm' in s);
  assert.deepEqual([tilt.loX, tilt.hiX], [0, 2000]);
  near(tilt.ceilAbsMm, 3500, 'ローカル 0＝世界 x 4000（高い側）');
  near(tilt.ceilAbsHiMm, 2900, 'ローカル 2000＝世界 x 2000（底）');
});

test('【奥行き方向の slope は両端同値で ceilAbsHiMm なし】slope[600,+y]・壁なしの芯 y=1500 は区画の底 3000 → ceilAbsMm 2900', () => {
  const { segs } = zonedFamilyTilt({ dims: [600, 90] });
  const right = segs.find(s => s.loX === 2000);
  near(right.ceilAbsMm, 2900, '芯 y=1500（区画の y 1500..3000 の手前の端）＝底');
  assert.equal('ceilAbsHiMm' in right, false);
});

test('【評価点は壁の外側の仕上げ面】中間CL y=1500 に壁があると、奥行き方向の slope[600,+y] は芯の値 2900 ではなく壁の向こう側の面の値になる', () => {
  const noWall = zonedFamilyTilt({ dims: [600, 90] });
  const walled = zonedFamilyTilt({ dims: [600, 90], withWall: true });
  const outer = outerWallFaceAt(walled.graph, walled.yM, { isVertical: false, outward: 1, spanLo: 2000, spanHi: 4000 });
  assert.ok(outer != null && outer > 1500, `前提: 中間CL上に壁があり向こう側（+y）の面が芯より先（実際:${outer}）`);
  const right = walled.segs.find(s => s.loX === 2000);
  near(right.ceilAbsMm, -100 + 3000 + 600 * (outer - 1500) / 1500, '底 3000＋勾配 600/1500×(外側の面−区画の端 y=1500)');
  assert.ok(right.ceilAbsMm > noWall.segs.find(s => s.loX === 2000).ceilAbsMm, '芯の値（2900）より高い');
  assert.equal('ceilAbsHiMm' in right, false);
});

test('【失敗系】円弧の区画は対象外＝割れず 2300 のまま・ceilAbsHiMm なし（部屋 CH）', () => {
  const { segs } = zonedFamilyTilt({ dims: [400, 0], shape: 'arc' });
  assert.deepEqual(segs, [{ loX: 0, hiX: 4000, ceilAbsMm: 2300 }]);
});

test('【失敗系】ドームの区画も対象外＝部屋 CH', () => {
  const { segs } = zonedFamilyTilt({ dims: [400], shape: 'dome' });
  assert.deepEqual(segs, [{ loX: 0, hiX: 4000, ceilAbsMm: 2300 }]);
});

// ---- E3b-2 QA: 壁の端で刻む／CL で割れた同じ傾斜の片の結合 ----
// 中間CLの壁を x 0..(2000+overlap) に縮め、傾斜の片 2000..4000 への重なりを overlap(mm) にした familyCeilingSegments の x>=2000 の片
function segsWithCornerOverlap(overlap) {
  const graph = makeGraph();
  const { room, yM, botKeys } = makeTwoRowFamily(graph);
  const child = graph.addRoom(new Set(botKeys), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400');
  generateRoomWallsFromOutline(graph, child);
  const wall = [...graph.walls].find(w => w.axisCL?.id === yM.id);
  wall.endOffset -= wall.coord2 - (2000 + overlap);
  assert.ok(Math.abs(wall.coord2 - (2000 + overlap)) < 1e-6, `前提: 壁の端 ${2000 + overlap}（実際:${wall.coord2}）`);
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.CEILING }, 'cc');
  const key = worldToCell(3000, 2250, graph, CEILING_CELL_GRID).key;
  child.setCeilingZones(createZone(graph, child, [key], { heightMm: 3000, shape: 'slope', dims: [600, 90] }).zones);
  const face = { axisCL: yM, isVertical: false, inward: -1, lo: 0, hi: 4000, originWorld: 0, dirSign: 1 };
  return familyCeilingSegments(face, room, graph).filter(s => s.loX >= 2000);
}

test('【重なり 72.5mm の出隅は壁無し＝芯で 1 片】中間CLの壁が x 0..2072.5（傾斜の片 2000..4000 に 72.5mm だけ重なる）: 割れず芯 2900 の 1 片', () => {
  const right = segsWithCornerOverlap(72.5);
  assert.equal(right.length, 1, JSON.stringify(right));
  assert.deepEqual([right[0].loX, right[0].hiX], [2000, 4000]);
  near(right[0].ceilAbsMm, 2900, '短い壁は壁と見なさず芯の値');
});

test('【重なり 100mm 以上は壁あり】境界値 99.9 は芯の 1 片・100 は壁のある 100mm の片だけ外側の面（芯 2900 より高い）で割れる', () => {
  const short = segsWithCornerOverlap(99.9);
  assert.equal(short.length, 1, JSON.stringify(short));
  near(short[0].ceilAbsMm, 2900, '99.9mm は壁無し');
  const edge = segsWithCornerOverlap(100);
  assert.equal(edge.length, 2, JSON.stringify(edge));
  assert.deepEqual([edge[0].loX, edge[0].hiX], [2000, 2100]);
  assert.ok(edge[0].ceilAbsMm > 2900 + 1e-6, '100mm は壁あり＝外側の面の値');
  assert.deepEqual([edge[1].loX, edge[1].hiX], [2100, 4000]);
  near(edge[1].ceilAbsMm, 2900, '壁の無い残りは芯');
});

test('【CL で割れた同じ傾斜の片は1本に結合】走り方向 slope の中に縦CL x=3000 を足しても 2000..4000 の 1 片（2900→3500）', () => {
  const graph = makeGraph();
  const { room, yM, botKeys } = makeTwoRowFamily(graph);
  const child = graph.addRoom(new Set(botKeys), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400');
  graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.CEILING }, 'cc');
  const keys = [2500, 3500].map(x => worldToCell(x, 2250, graph, CEILING_CELL_GRID).key); // x=3000 の CL で 2 セルに割れた 1 つの区画
  child.setCeilingZones(createZone(graph, child, keys, { heightMm: 3000, shape: 'slope', dims: [600, 0] }).zones);
  const face = { axisCL: yM, isVertical: false, inward: -1, lo: 0, hi: 4000, originWorld: 0, dirSign: 1 };
  const tilt = familyCeilingSegments(face, room, graph).filter(s => s.loX >= 2000);
  assert.equal(tilt.length, 1, JSON.stringify(tilt));
  assert.deepEqual([tilt[0].loX, tilt[0].hiX], [2000, 4000]);
  near(tilt[0].ceilAbsMm, 2900, 'lo');
  near(tilt[0].ceilAbsHiMm, 3500, 'hi');
});

test('【勾配が違えば結合しない】x 2000..3000 は勾配 600/1000・3000..4000 は水平寄りの別区画 → 2 片', () => {
  const graph = makeGraph();
  const { room, yM, botKeys } = makeTwoRowFamily(graph);
  const child = graph.addRoom(new Set(botKeys), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400');
  graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.CEILING }, 'cc3');
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.CEILING }, 'cc2');
  const kA = worldToCell(2500, 2250, graph, CEILING_CELL_GRID).key;
  const kB = worldToCell(3500, 2250, graph, CEILING_CELL_GRID).key;
  const zA = createZone(graph, child, [kA], { heightMm: 3000, shape: 'slope', dims: [600, 0] }).zones;
  child.setCeilingZones(zA);
  child.setCeilingZones(createZone(graph, child, [kB], { heightMm: 3600, shape: 'slope', dims: [300, 0] }).zones);
  const face = { axisCL: yM, isVertical: false, inward: -1, lo: 0, hi: 4000, originWorld: 0, dirSign: 1 };
  const tilt = familyCeilingSegments(face, room, graph).filter(s => s.loX >= 2000);
  assert.equal(tilt.length, 2, JSON.stringify(tilt));
  near(tilt[0].ceilAbsHiMm, 3500, 'A の hi');
  near(tilt[1].ceilAbsMm, 3500, 'B の lo（高さは連続）');
  near(tilt[1].ceilAbsHiMm, 3800, 'B の hi（勾配 300/1000 で違う）');
});

test('【E4・同じ円弧の面が仕上げのセル境界で割れても 1 片】2 セルにまたがる arc[400,90] の区画は壁の面で 1 片・頭頂は面全体の中央', () => {
  const g = makeGrid([0, 2500, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]], { walls: true });
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 90] }).zones);
  const face = buildRoomFaces(room, g.graph).find(f => !f.isVertical && f.axisCL.value === 0);
  const segs = wallAdjacentFloorSegments(face, room, g.graph);
  assert.equal(segs.length, 1, 'セル境界 x=2500 で割れない');
  assert.equal(segs[0].ceilArc.alongX, 2442.5, '頭頂は面全体（x 0..5000）の中央 x=2500（ローカル 2442.5）');
  near(segs[0].ceilArc.chMm, 2800, '頭頂 2400＋ライズ400');
});

// ---- clipVerticalBelowProfile（蹴上が壁と取り合う端の縦線を断面線より下だけに。ユーザー裁定 2026-10-15）----
test('【裁定2026-10-15】clipVerticalBelowProfile: 断面線より下だけ残す。段の上は低い側で切る。輪郭が無ければ切らない', () => {
  const profile = [[0, 1000], [500, 1000], [500, 1200], [1000, 1200]];
  assert.deepEqual(clipVerticalBelowProfile(profile, 250, 0, 3000), [0, 1000]);
  assert.deepEqual(clipVerticalBelowProfile(profile, 250, 3000, 0), [0, 1000], '端の順序に依らない');
  assert.equal(clipVerticalBelowProfile(profile, 500, 1000, 1200), null, '段の上（断面の蹴上の位置）は残さない');
  assert.deepEqual(clipVerticalBelowProfile(profile, 500, 800, 1200), [800, 1000], '段の上は低い側で切る');
  assert.equal(clipVerticalBelowProfile(profile, 750, 1200, 2000), null, '全体が断面線より上');
  assert.deepEqual(clipVerticalBelowProfile(profile, 750, 600, 900), [600, 900], '全体が下ならそのまま');
  assert.deepEqual(clipVerticalBelowProfile(null, 750, 600, 2000), [600, 2000], '輪郭が無ければ切らない');
  assert.deepEqual(clipVerticalBelowProfile([], 750, 600, 2000), [600, 2000]);
});
