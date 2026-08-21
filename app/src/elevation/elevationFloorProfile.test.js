// wallAdjacentFloorSegments の基本挙動テスト。実 core.js（Plane/PlanGraph）+
// finish/wallGeneration.js で壁を生成した部屋に対して面を組み立てる（elevationFaces.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces } from './elevationFaces.js';
import {
  wallAdjacentFloorSegments, drawnRiserX, drawnCeilingRiserX, halfWallThicknessMm,
  familyCeilingSegments,
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
