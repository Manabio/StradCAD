// 開放スパン（extendFaceWithOpenSpans/extendFacesWithOpenSpans/clipSpans）のテスト。
// 実 core.js（Plane/PlanGraph）+ finish/wallGeneration.js で壁を生成した部屋に対して検証する
// （elevationFaces.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces } from './elevationFaces.js';
import { extendFaceWithOpenSpans, extendFacesWithOpenSpans, clipSpans } from './elevationOpenSpan.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// 3列(0-2000-4000-6000)×1行(0-3000)。右列(4000-6000)だけ部分指定の子(FLは呼び出し側が設定)。
// 中央-右の境界(x=4000)は同室内・壁なしのため、面Dはここを越えて開放スパンとして延長しうる。
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

// D1（Round Fフィクスチャで実際に検証した「壁区間+開放区間」パターン）の最小再現:
// 2行×2列。上段(y:0-1000)はx=2000で自室(左)と他室(右)が接する＝実壁。下段(y:1000-2000)は
// x=2000の両側とも自室（他室ではなく部分指定の子）＝壁なしの開放継続。x=2000に立つ縦の面
// （letterはbuildRoomFacesが決める）が、上段の実壁区間から下段の開放区間へ延長できるはず。
function makeWallThenOpenRoom(graph, childFL) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });

  const otherKey = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`; // 上段右＝他室
  const mainTopKey    = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`; // 上段左＝自室
  const mainBotLeftKey  = `${x0.id}:${y1.id}:${x1.id}:${y2.id}`; // 下段左＝自室
  const mainBotRightKey = `${x1.id}:${y1.id}:${x2.id}:${y2.id}`; // 下段右＝自室（部分指定の子にする）

  const other = graph.addRoom(new Set([otherKey]), '他室');
  generateRoomWallsFromOutline(graph, other);
  const room = graph.addRoom(new Set([mainTopKey, mainBotLeftKey, mainBotRightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([mainBotRightKey]), '部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  return { room, other };
}

test('extendFaceWithOpenSpans: 実壁区間の先で同室内部が壁なしで継続する面を延長し、wall区間+open区間(farFloorDeltaMm付き)になる', () => {
  const graph = makeGraph();
  const { room } = makeWallThenOpenRoom(graph, 300);
  const faces = buildRoomFaces(room, graph);
  // x=2000に立つ縦の面（上段y:0-1000の実壁区間から作られる。isVertical=trueでrunがY方向）。
  const face = faces.find(f => f.isVertical && Math.abs(f.axisCL.value - 2000) < 1e-6);
  assert.ok(face, 'x=2000の縦の面が見つかるはず');
  const originalRun = face.run;

  const extended = extendFaceWithOpenSpans(face, faces, room, graph);
  assert.ok(extended.run > originalRun, `延長されてrunが元(${originalRun})より大きくなるはず（実際:${extended.run}）`);
  assert.ok(extended.spans.length >= 2, `wall+open最低2区間になるはず（実際:${JSON.stringify(extended.spans)}）`);

  const wallSpan = extended.spans.find(s => s.kind === 'wall');
  const openSpan = extended.spans.find(s => s.kind === 'open');
  assert.ok(wallSpan, 'wall区間が見つかるはず');
  assert.ok(openSpan, 'open区間が見つかるはず');
  assert.equal(openSpan.farFloorDeltaMm, 300, '開放先(子部屋)のFL差がfarFloorDeltaMmに反映されるはず');
  // 問題修正2026-08その2: 開放先の天井絶対高さ。子は自CH指定なし→roomCeilingHeightの調整で
  // 親CH(default2400)−300=2100 → farCeilAbsMm=300+2100=2400（親の天井と揃う）。
  assert.equal(openSpan.farCeilAbsMm, 2400, '自CH指定なしの子は天井絶対高さが親と揃うはず');

  // spansは0..runを隙間なく単調に覆う。
  assert.equal(extended.spans[0].loX, 0);
  assert.equal(extended.spans[extended.spans.length - 1].hiX, extended.run);
  for (let i = 0; i + 1 < extended.spans.length; i++) {
    assert.equal(extended.spans[i].hiX, extended.spans[i + 1].loX, '隙間なく連続するはず');
  }
});

// ---- 問題修正2026-08その2: 開放先が明示CHを持つ場合、farCeilAbsMmにそのCHが反映される ----
test('extendFaceWithOpenSpans: 開放先の子が明示CHを持てばfarCeilAbsMm=子FL+子CH（親と天井が揃わない）になる', () => {
  const graph = makeGraph();
  const { room } = makeWallThenOpenRoom(graph, 300);
  const child = graph.rooms.find(r => r.name === '部分指定');
  child.setOverride('ceilingHeight', '2400'); // 明示CH → 天井絶対高さ300+2400=2700（親2400と異なる）

  const faces = buildRoomFaces(room, graph);
  const face = faces.find(f => f.isVertical && Math.abs(f.axisCL.value - 2000) < 1e-6);
  const extended = extendFaceWithOpenSpans(face, faces, room, graph);
  const openSpan = extended.spans.find(s => s.kind === 'open');
  assert.ok(openSpan, 'open区間が見つかるはず');
  assert.equal(openSpan.farCeilAbsMm, 2700, '開放先の天井絶対高さ=子FL(300)+明示CH(2400)のはず');
  const wallSpan = extended.spans.find(s => s.kind === 'wall');
  assert.equal(wallSpan.farCeilAbsMm, undefined, 'wall区間にはfarCeilAbsMmを付けない');
});

// ---- 失敗系: farFloorDeltaMmが同じでもfarCeilAbsMmが異なる隣接open区間は結合しない ----
// mergeSameKindの結合条件にfarCeilAbsMmを加えたことの門番——FLが同じ（farFloorDeltaMm同一）で
// 明示CHだけ異なる2つの開放先が隣接する場合、旧条件（kind+farFloorDeltaMm）だと1区間へ誤結合され、
// far天井線が片方のCHで全域に引かれてしまう。
test('【失敗系】extendFaceWithOpenSpans: FLが同じで明示CHだけ異なる2つの開放先は、open区間が結合されず2区間のまま残る', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });

  const otherKey       = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`;   // 上段右＝他室（実壁の元）
  const mainTopKey     = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;   // 上段左＝自室
  const mainBotLeftA   = `${x0.id}:${y1.id}:${x1.id}:${yMid.id}`; // 下段左上＝自室
  const mainBotLeftB   = `${x0.id}:${yMid.id}:${x1.id}:${y2.id}`; // 下段左下＝自室
  const farAKey        = `${x1.id}:${y1.id}:${x2.id}:${yMid.id}`; // 開放先A
  const farBKey        = `${x1.id}:${yMid.id}:${x2.id}:${y2.id}`; // 開放先B

  const other = graph.addRoom(new Set([otherKey]), '他室');
  generateRoomWallsFromOutline(graph, other);
  const room = graph.addRoom(new Set([mainTopKey, mainBotLeftA, mainBotLeftB, farAKey, farBKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const childA = graph.addRoom(new Set([farAKey]), '子A', undefined, new Set([room.id]));
  const childB = graph.addRoom(new Set([farBKey]), '子B', undefined, new Set([room.id]));
  childA.setOverride('ceilingHeight', '2500'); // FLは親と同じ（farFloorDeltaMm=0）・CHだけ異なる
  childB.setOverride('ceilingHeight', '2600');

  const faces = buildRoomFaces(room, graph);
  const face = faces.find(f => f.isVertical && Math.abs(f.axisCL.value - 2000) < 1e-6);
  assert.ok(face, 'x=2000の縦の面が見つかるはず');
  const extended = extendFaceWithOpenSpans(face, faces, room, graph);

  const openSpans = extended.spans.filter(s => s.kind === 'open');
  assert.equal(openSpans.length, 2, `CHの異なる開放先はopen区間が結合されず2区間のはず（実際:${JSON.stringify(extended.spans)}）`);
  assert.ok(openSpans.every(s => s.farFloorDeltaMm === 0), 'FLは親と同じ（farFloorDeltaMm=0同士でも結合されない）');
  assert.deepEqual(openSpans.map(s => s.farCeilAbsMm).sort((a, b) => a - b), [2500, 2600]);
});

// ---- 失敗系: 延長先が無ければ（矩形の閉じた部屋）面は実質不変（spansはwall1区間のみ） ----
test('【失敗系】extendFaceWithOpenSpans: 閉じた矩形部屋（延長先が無い）は元のlo/hi/hasWallAtLocal0/Runを変えず、spansはwall1区間だけになる', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const faces = buildRoomFaces(room, graph);

  for (const face of faces) {
    const extended = extendFaceWithOpenSpans(face, faces, room, graph);
    assert.equal(extended.lo, face.lo, `${face.label}のloは変わらないはず`);
    assert.equal(extended.hi, face.hi, `${face.label}のhiは変わらないはず`);
    assert.equal(extended.hasWallAtLocal0, true);
    assert.equal(extended.hasWallAtLocalRun, true);
    assert.equal(extended.spans.length, 1);
    assert.equal(extended.spans[0].kind, 'wall');
  }
});

// ---- 失敗系: kind==='step'の面はそのまま素通りする（対象外） ----
test('【失敗系】extendFaceWithOpenSpans: kind===\'step\'の面はそのまま返す（対象外）', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 300);
  const faces = buildRoomFaces(room, graph);
  const stepLike = { kind: 'step', label: 'X1' };
  assert.equal(extendFaceWithOpenSpans(stepLike, faces, room, graph), stepLike);
});

test('extendFacesWithOpenSpans: 全面へ適用し、kind===\'step\'以外の面はspansを持つ', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 300);
  const faces = buildRoomFaces(room, graph);
  for (const f of extendFacesWithOpenSpans(faces, room, graph)) {
    assert.ok(Array.isArray(f.spans), `${f.label}はspans配列を持つはず`);
  }
});

// 同一axisCL上に「自室のセルが同室で連続する区間」と「自室の壁区間」が、両者に挟まれた
// 他室（自室が所有しないセル）の区間で隔てられているケースの最小再現（Round Fフィクスチャの
// room2でC2/B2の面spansに他室領域ぶんの穴が空くバグを最小構成で再現する）。
// 配置（列: Left[0,1000] Mid[1000,3000] Right[3000,4000]、行: FarAbove[-1000,0] Above[0,1000]
// Below[1000,2000]）: FarAboveは3列とも自室（Above-LeftとAbove-Rightを繋ぐ橋）。
// Above-Left=自室・Below-Left=自室の子（部分指定・別FL）→ y=1000で同室継続（open）。
// Above-Mid/Below-Mid/Below-Right=自室が所有しない（void）→ Above-Rightの下は空地なので
// y=1000, x:3000-4000に実壁が生成される（この面がテスト対象）。
function makeGapInterruptedRoom(graph, childFL) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const yA = graph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: false, discipline: Discipline.ARCH });
  const yB = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,     { labeled: false, discipline: Discipline.ARCH });
  const yAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const yC = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });

  const farAboveLeft  = `${x0.id}:${yA.id}:${x1.id}:${yB.id}`;
  const farAboveMid   = `${x1.id}:${yA.id}:${x2.id}:${yB.id}`;
  const farAboveRight = `${x2.id}:${yA.id}:${x3.id}:${yB.id}`;
  const aboveLeft  = `${x0.id}:${yB.id}:${x1.id}:${yAxis.id}`;
  const aboveRight = `${x2.id}:${yB.id}:${x3.id}:${yAxis.id}`;
  const belowLeft  = `${x0.id}:${yAxis.id}:${x1.id}:${yC.id}`;

  const room = graph.addRoom(new Set([farAboveLeft, farAboveMid, farAboveRight, aboveLeft, aboveRight, belowLeft]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([belowLeft]), '部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  return { room };
}

test('extendFaceWithOpenSpans: 自室の壁区間の先に「他室が挟まる区間」を挟んで自室の開放継続区間があっても、他室区間を飛び越えて延長しない（QA修正: spansに他室領域ぶんの穴が空くバグ）', () => {
  const graph = makeGraph();
  const { room } = makeGapInterruptedRoom(graph, -50);
  const faces = buildRoomFaces(room, graph);
  // y=1000, inward=-1（近傍側=Above行）で見つかる壁面（Above-Rightの下が空地のために生成された実壁）。
  const face = faces.find(f => !f.isVertical && Math.abs(f.axisCL.value - 1000) < 1e-6 && f.inward === -1);
  assert.ok(face, 'y=1000,inward=-1の面が見つかるはず');
  assert.ok(face.run < 1000, '延長前は素のAbove-Right区間(3000-4000。仕上げ面基準で1000未満)のみのはず');

  const extended = extendFaceWithOpenSpans(face, faces, room, graph);
  // 他室（Above-Mid/Below-Mid/Below-Right＝自室が所有しない区間）を挟んでいるため、
  // Above-Left側の開放継続区間へ飛び越えて延長してはいけない＝runは変わらないはず。
  assert.equal(extended.run, face.run, `他室領域を飛び越えて延長してはいけない（実際run:${extended.run}）`);
  assert.equal(extended.spans.length, 1, `延長されないためspansはwall1区間のみのはず（実際:${JSON.stringify(extended.spans)}）`);
  assert.equal(extended.spans[0].kind, 'wall');
});

// 自室の登録セルが、far側の部屋境界より粗い（extent制限で該当行にはCLが分割されない）場合の
// 最小再現（Round Fフィクスチャのroom2でC2が「g」区間を誤ってopen扱いするバグを最小構成で
// 再現する）。配置: 列 x0=0,xSplit=1000(extent制限。y:1000-2000の行だけ有効),x1=4000。
// 行 Above[0,1000]（自室P・xSplitが無効域のため1セルに統合）／Below[1000,2000]
// （xSplitで分割: 左[0,1000]=Pの子(別FL)・右[1000,4000]=void）。
// テスト対象はy=1000,inward=-1（Aboveが近傍側）の面——素の壁区間はBelow右が空地のx:1000-4000。
// Above自身は1セルなので、1点プローブだとx:0-4000全体を「壁」と誤分類しかねない
// （実際にはx:0-1000はPの子＝同室継続でopenのはず）。
function makeCoarseNearCellRoom(graph, childFL) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xSplit = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.setCenterLineExtentRef(xSplit, 'lo', { clId: y1.id, offset: 0 });
  graph.setCenterLineExtentRef(xSplit, 'hi', { clId: y2.id, offset: 0 });

  const aboveKey = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`; // y:0-1000, x:0-4000（xSplit無効域=1セル）
  const belowLeftKey = `${x0.id}:${y1.id}:${xSplit.id}:${y2.id}`; // y:1000-2000, x:0-1000（Pの子）
  // 右側(x:1000-4000, y:1000-2000)はvoid（どの部屋にも属さない＝実壁の元）。

  const room = graph.addRoom(new Set([aboveKey, belowLeftKey]), 'P');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([belowLeftKey]), '部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  return { room };
}

test('extendFaceWithOpenSpans: 自室の登録セルがfar側の部屋境界より粗い（extent制限で分割されない）場合でも、far側の実際の境界で正しくwall/open判定する（QA修正: 1点プローブによる誤分類バグ）', () => {
  const graph = makeGraph();
  const { room } = makeCoarseNearCellRoom(graph, -50);
  const faces = buildRoomFaces(room, graph);
  const face = faces.find(f => !f.isVertical && Math.abs(f.axisCL.value - 1000) < 1e-6 && f.inward === -1);
  assert.ok(face, 'y=1000,inward=-1の面が見つかるはず');
  const originalRun = face.run;

  const extended = extendFaceWithOpenSpans(face, faces, room, graph);
  assert.ok(extended.run > originalRun, `x:0-1000側（Pの子＝同室継続）へ正しく延長されるはず（元run:${originalRun}、実際:${extended.run}）`);
  assert.equal(extended.spans.length, 2, `wall+openの2区間になるはず（実際:${JSON.stringify(extended.spans)}）`);
  const openSpan = extended.spans.find(s => s.kind === 'open');
  assert.ok(openSpan, 'open区間（Pの子への延長）が見つかるはず');
  assert.equal(openSpan.farFloorDeltaMm, -50);
  // 隙間なく連続する（他室区間を誤って挟み込んでいないことの確認）。
  for (let i = 0; i + 1 < extended.spans.length; i++) {
    assert.equal(extended.spans[i].hiX, extended.spans[i + 1].loX, '隙間なく連続するはず');
  }
});

// ---- clipSpans: 断片のローカル範囲でクリップ・再原点化する ----
test('clipSpans: 指定範囲でクリップし、断片自身のローカル座標(0起点)へ再原点化する', () => {
  const spans = [
    { loX: 0, hiX: 500, kind: 'wall', farFloorDeltaMm: undefined, hiCLX: 500, hiCLId: 'cl1' },
    { loX: 500, hiX: 1500, kind: 'open', farFloorDeltaMm: 300, hiCLX: null, hiCLId: null },
  ];
  const clipped = clipSpans(spans, 300, 1000);
  assert.equal(clipped.length, 2);
  assert.equal(clipped[0].loX, 0, '300でクリップした断片は0起点になるはず');
  assert.equal(clipped[0].hiX, 200, '元の[300,500]区間は幅200のはず');
  assert.equal(clipped[0].hiCLId, 'cl1', '断片内に収まる内部境界はhiCLIdを保つはず');
  assert.equal(clipped[1].loX, 200);
  assert.equal(clipped[1].hiX, 700, '元の[500,1000]区間は幅500、断片内では200..700のはず');
});

// ---- 失敗系: clipSpans範囲外のspanは除去される ----
test('【失敗系】clipSpans: クリップ範囲に重ならないspanは除去される', () => {
  const spans = [{ loX: 0, hiX: 100, kind: 'wall', hiCLX: null, hiCLId: null }];
  assert.deepEqual(clipSpans(spans, 200, 300), []);
});

// ==== QA修正M1: 統合シームのテスト（同一(axisCL.id,inward)の面統合の配線検証） ====
// アルコーブ（主室(0,0)-(4000,3000)にx:4000-4800,y:1000-2000の張り出し）はB面がB1(y:0-1000)・
// B2(張り出し先端x=4800)・B3(y:2000-3000)の3区間に分かれる（buildRoomFacesの既存挙動＝8面）。
// B1とB3は同一(axisCL.id=x=4000, inward)を持ち、どちらも張り出し内部（同室・壁なし）へ開放
// スパンとして延長される——延長後の範囲が重なるため、extendFacesWithOpenSpansの統合ロジックで
// 1面(B1)へ統合され、面数は7になるはず。
function makeAlcoveRoom(graph) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4800, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y3 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const cells = new Set([
    `${x0.id}:${y0.id}:${x1.id}:${y3.id}`,
    `${x1.id}:${y1.id}:${x2.id}:${y2.id}`,
  ]);
  const room = graph.addRoom(cells, 'アルコーブ室');
  generateRoomWallsFromOutline(graph, room);
  return room;
}

test('extendFacesWithOpenSpans: 同一(axisCL.id, inward)で範囲が重なる面は1面へ統合される（アルコーブでB1/B3が統合され面数7になる）', () => {
  const graph = makeGraph();
  const room = makeAlcoveRoom(graph);
  const raw = buildRoomFaces(room, graph);
  assert.equal(raw.length, 8, '前提: buildRoomFacesは8面（張り出しでBがB1/B2/B3の3区間に分かれる）のはず');

  const extended = extendFacesWithOpenSpans(raw, room, graph);
  assert.equal(extended.length, 7, `B1とB3が同一(axisCL.id,inward)・範囲重複で1面へ統合され7面になるはず（実際:${extended.length}件、labels=${JSON.stringify(extended.map(f => f.label))}）`);

  const merged = extended.find(f => f.isVertical && Math.abs(f.axisCL.value - 4000) < 1e-6 && f.inward < 0);
  assert.ok(merged, '統合後のB面が見つかるはず');
  assert.ok(merged.spans.length >= 3, `統合後は張り出しの手前・中・奥で最低3区間になるはず（実際:${JSON.stringify(merged.spans)}）`);
  // spans合計は統合後の面の全域(0..run)と一致する（統合で範囲が欠落・重複していないことの確認）。
  assert.equal(merged.spans[0].loX, 0);
  assert.ok(Math.abs(merged.spans[merged.spans.length - 1].hiX - merged.run) < 1e-6,
    'spans末尾は統合後の面のrunと一致するはず（範囲の欠落が無いことの確認）');
  const totalCovered = merged.spans.reduce((sum, s) => sum + (s.hiX - s.loX), 0);
  assert.ok(Math.abs(totalCovered - merged.run) < 1e-6, 'spansの幅合計は統合後のrunと一致するはず（重複・隙間が無いことの確認）');
});
