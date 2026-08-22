// elevationVoid.js の基本挙動テスト（WP-V1: 吹抜けの2層展開図帯。.claude/elevation-model.md参照）。
// 「設置階下階のFLから設置階の天井高さまで、CLを合わせて描画」——自階の面を下へ延長する方式
// （床だけ下げ、ceilAbs=floorDelta+chMmが不変になるよう天井は動かさない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildVoidBand } from './elevationVoid.js';
import { buildRoomFaces } from './elevationFaces.js';

const CH = 2400; // DEFAULT_ROOM_CEILING_HEIGHT（core/constants.js）を明示指定なしの既定値として使う

function makeGraph(name = 'p1', elevation = 0) {
  const plane = new Plane(name, elevation, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

// 帯内の床線・天井線（ともにCUT=太の水平線）のyを拾う（elevationStair.test.jsのfloorYと同じ方針）。
function floorCeilYs(band) {
  const horiz = band.primitives.filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2);
  return { floorY: Math.max(...horiz.map(p => p.y1)), ceilY: Math.min(...horiz.map(p => p.y1)) };
}

// ---- 床線がy=+dropに来る（floorSegments変換の検証） ----
test('buildVoidBand: 床線がy=+drop、天井は不変（ceilAbs=floorDelta+chMmが不変のため天井は動かない）', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const lowerGraph = makeGraph('p0', 0);
  makeRectRoom(lowerGraph, 0, 0, 4000, 3000, 'LDK'); // feature=null・footprintが重なる・floorLevel=0

  const floorHeightBelowMm = 2900;
  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm });

  const { floorY, ceilY } = floorCeilYs(band);
  assert.equal(floorY, floorHeightBelowMm, `床線はy=+drop(${floorHeightBelowMm})に来るはず`);
  assert.equal(ceilY, -CH, '天井は動かず帯CHのままのはず');
});

// ---- 帯高さ ≈ CH + drop、heightUnits===2、unitHeightMm ≈ bounds.height/2 ----
test('buildVoidBand: 床〜天井の実高さはCH+dropになり、heightUnits=2・unitHeightMm=bounds.height/2', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const lowerGraph = makeGraph('p0', 0);
  makeRectRoom(lowerGraph, 0, 0, 4000, 3000, 'LDK');

  const floorHeightBelowMm = 2900;
  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm });

  const { floorY, ceilY } = floorCeilYs(band);
  assert.equal(floorY - ceilY, CH + floorHeightBelowMm, '床〜天井の実高さはCH+dropになるはず');
  // QA修正5(b): 差分だけでなくfloorY自体の絶対値も固定する（符号反転変異=floorDeltaMm+dropMm等の
  // 取り違えは差分だけの比較では検知できないケースがあるため）。
  assert.equal(floorY, floorHeightBelowMm, `floorYは+drop(${floorHeightBelowMm})そのもののはず`);
  assert.equal(band.heightUnits, 2, '下階が解決できた吹抜け帯はheightUnits=2(2層分)のはず');
  assert.equal(band.unitHeightMm, band.bounds.height / 2, 'unitHeightMm=bounds.height/heightUnitsのはず');
});

// ---- 下階RoomのFL差がdropに反映される ----
test('buildVoidBand: 下階Roomの実効FL差がdropへ上乗せされる', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const lowerGraph = makeGraph('p0', 0);
  const lowerRoom = makeRectRoom(lowerGraph, 0, 0, 4000, 3000, 'LDK');
  lowerRoom.setFloorLevel(200); // 下階Roomの実効FLが下階の基準FLより200mm高い

  const floorHeightBelowMm = 2900;
  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm });

  const { floorY } = floorCeilYs(band);
  assert.equal(floorY, floorHeightBelowMm + 200,
    'drop=floorHeightBelowMm+下階RoomのFL差(200)になるはず');
});

// ---- 下階に重なる通常部屋が無ければFL差は0扱い（見つからなければ0。ユーザー仕様どおり） ----
test('buildVoidBand: 下階に重なる通常部屋が無ければFL差0扱いでdrop=floorHeightBelowMmのみになる', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const lowerGraph = makeGraph('p0', 0); // 下階に重なる部屋を一切置かない

  const floorHeightBelowMm = 2900;
  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm });

  const { floorY } = floorCeilYs(band);
  assert.equal(floorY, floorHeightBelowMm,
    '下階Roomが見つからなければFL差0扱いでdrop=floorHeightBelowMmのみになるはず');
});

// ---- QA修正5(a): 部分指定（referenceRoomIds）で床が複数区間ある吹抜けでも、全区間が同じdropで
// 下がり、天井は全区間で不変（ceilAbs=floorDelta+chMmが区間ごとに保たれるため）----
test('buildVoidBand: 部分指定で床が複数区間ある吹抜けでも、全区間が同じdropで下がり天井は全区間不変', () => {
  const graph = makeGraph('p1', 2900);
  const x0   = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x1   = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${xMid.id}:${y1.id}`;
  const rightKey = `${xMid.id}:${y0.id}:${x1.id}:${y1.id}`;
  const voidRoom = graph.addRoom(new Set([leftKey, rightKey]), '吹抜け');
  generateRoomWallsFromOutline(graph, voidRoom);
  voidRoom.setFeature(RoomFeature.VOID);
  const child = graph.addRoom(new Set([rightKey]), '部分', undefined, new Set([voidRoom.id]));
  child.setFloorLevel(300); // 右半分だけFL+300（自CH指定なし→親と天井が揃うよう自動調整される）

  const lowerGraph = makeGraph('p0', 0);
  makeRectRoom(lowerGraph, 0, 0, 4000, 3000, 'LDK');

  const floorHeightBelowMm = 2900;
  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm });

  const faceA = buildRoomFaces(voidRoom, graph).find(f => f.label === 'A');
  const horizOnFaceA = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.x1 >= 0 && p.x2 <= faceA.run);
  const floorHorizontals = horizOnFaceA.filter(l => l.y1 !== -CH);
  const ceilHorizontals  = horizOnFaceA.filter(l => l.y1 === -CH);

  assert.equal(floorHorizontals.length, 2, '面Aの床は段差で2本に分かれるはず');
  assert.ok(floorHorizontals.some(l => l.y1 === floorHeightBelowMm),
    `親区間(floorDeltaMm=0)の床はy=drop(${floorHeightBelowMm})のはず`);
  assert.ok(floorHorizontals.some(l => l.y1 === floorHeightBelowMm - 300),
    `子区間(floorDeltaMm=300)の床はy=drop-300(${floorHeightBelowMm - 300})のはず（両区間とも+dropだけ下がる）`);
  assert.ok(ceilHorizontals.length >= 1, '天井線は区間をまたいでも-CHのまま(不変)のはず');
});

// ---- QA修正4: 下階Roomの沈み床でdropMm(floorHeightBelowMm+flDiffMm)が0以下に相殺される場合は
// 0でクランプし、実質1層と同じ表現としてheightUnits=1にする（クランプ無しだと床が天井より上に
// 来る空白の2層帯になっていた） ----
test('【失敗系】buildVoidBand: 下階FL差で相殺されdrop<=0なら0でクランプし1層（heightUnits=1）になる', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const lowerGraph = makeGraph('p0', 0);
  const lowerRoom = makeRectRoom(lowerGraph, 0, 0, 4000, 3000, 'LDK');
  lowerRoom.setFloorLevel(-3000); // flDiffMm=-3000。floorHeightBelowMm(2900)+(-3000)=-100（負）

  const floorHeightBelowMm = 2900;
  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm });

  const { floorY, ceilY } = floorCeilYs(band);
  assert.equal(floorY, 0, 'dropMmは0へクランプされ、床線はy=0のままのはず（負値のまま使うと空白の2層帯になる）');
  assert.equal(ceilY, -CH, '天井は帯CHのままのはず');
  assert.equal(band.heightUnits, 1, 'dropMm<=0は実質1層のためheightUnits=1のはず');
});

// ---- 失敗系: lowerGraph=null は drop なしの1層（heightUnits=1・例外なし） ----
test('【失敗系】buildVoidBand: lowerGraph=nullはdropなしの1層(heightUnits=1)を返し例外を投げない', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const band = buildVoidBand(voidRoom, graph, null, { floorHeightBelowMm: 2900 });

  const { floorY, ceilY } = floorCeilYs(band);
  assert.equal(floorY, 0, 'dropなしなら床線はy=0のまま');
  assert.equal(ceilY, -CH);
  assert.equal(band.heightUnits, 1);
});

// ---- 失敗系: ctx.floorHeightBelowMm未指定(null)も drop なしの1層（heightUnits=1・例外なし） ----
test('【失敗系】buildVoidBand: ctx.floorHeightBelowMm未指定(null)はdropなしの1層(heightUnits=1)を返し例外を投げない', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const lowerGraph = makeGraph('p0', 0);
  makeRectRoom(lowerGraph, 0, 0, 4000, 3000, 'LDK');

  const band = buildVoidBand(voidRoom, graph, lowerGraph, {}); // floorHeightBelowMm未指定

  const { floorY, ceilY } = floorCeilYs(band);
  assert.equal(floorY, 0);
  assert.equal(ceilY, -CH);
  assert.equal(band.heightUnits, 1);
});
