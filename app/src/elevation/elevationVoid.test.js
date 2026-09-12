// elevationVoid.js の基本挙動テスト（WP-V1: 吹抜けの2層展開図帯。.claude/elevation-model.md参照）。
// 「設置階下階のFLから設置階の天井高さまで、CLを合わせて描画」——自階の面を下へ延長する方式
// （床だけ下げ、ceilAbs=floorDelta+chMmが不変になるよう天井は動かさない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildVoidBand, buildRoomBandWithVoidAbove } from './elevationVoid.js';
import { planeOverhangForFace } from './section/sectionContent.js';
import { buildRoomFaces } from './elevationFaces.js';
import { DEFAULT_WALL_LESS_END_EXTEND_MM } from './elevationStyle.js';

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

  const lowerGraph = makeGraph('p0', 0);
  // 下階に重なる「通常部屋」は無い（feature!==nullなのでfindLowerRoomは見つけられない）が、
  // 壁は同じCL上に実在する——下へ延長する条件（下階の壁の実在）は満たしつつ、FL差の
  // フォールバックだけを検証する。
  makeRectRoom(lowerGraph, 0, 0, 4000, 3000, '階段').setFeature(RoomFeature.STAIR);

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


// ---- 下階に壁が無い区間は下へ延長しない（ユーザー実機指摘2026-08その17。階段帯「6」D2と同構造） ----
// 「自階の面を下へ延長する」方式は、下階に同じ壁があることを暗黙の前提にしていた。
// 下階にその壁が無ければ、実在しない壁の輪郭が1FLまで描かれてしまう。
test('【実機指摘】buildVoidBand: 下階に同じ壁が無い面は下へ延長せず、設置階の床のまま残る', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  // 下階の部屋はx方向に広く、吹抜けのx=0の面（西側）に対応する壁が下階には無い。
  const lowerGraph = makeGraph('p0', 0);
  makeRectRoom(lowerGraph, -4000, 0, 4000, 3000, 'LDK');

  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm: 2900 });
  const floors = band.primitives
    .filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2).map(p => p.y1);
  assert.ok(floors.includes(2900), '下階に壁がある面（x=4000側・y方向の面）は従来どおり+2900まで下がるはず');
  assert.ok(floors.includes(0), `下階に壁が無いx=0の面は設置階の床(y=0)のまま残るはず（実際:${JSON.stringify([...new Set(floors)])}）`);
});

test('【失敗系】buildVoidBand: 下階に全ての面の壁が揃っていれば、床線は全て+dropに下がる', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const lowerGraph = makeGraph('p0', 0);
  makeRectRoom(lowerGraph, 0, 0, 4000, 3000, 'LDK');

  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm: 2900 });
  const floors = [...new Set(band.primitives
    .filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2).map(p => p.y1))];
  assert.deepEqual(floors.filter(y => y > 0), [2900], '床線は+2900の1種類だけのはず');
});

// ---- 上部吹抜けを持つ部屋帯（buildRoomBandWithVoidAbove）の**面の端も層ごとに違う** ----
// ユーザー裁定2026-09: 階段帯と同じ規則を吹抜け帯へ適用する（上限500mm）。認めるのは
// **吹抜けが面の端に達している端だけ**（gate）——そこだけが「上階の空間がその端で見えている」
// 端で、はり出し区間が上＝上階の天井断面線・外端＝上階の壁エッジで閉じる。
// 合成データ: 1階LDK(0,0)-(4000,3000)、2階は吹抜け(2000,0)-(4000,3000)＝面Aのrun側半分だけが
// 吹抜け。面Aの通り（y=0）の2階の壁を、面の**両端**より overhangMm ぶん外へ続ける。
const VOID_ABOVE_FH = 3000;           // 階高
const FACE_A_RUN = 3885;              // 面A（y=0の壁。0..4000のCL間から半壁厚ぶん内側）
const UPPER_CEIL_Y = -(VOID_ABOVE_FH + CH); // 上階の天井（図座標y=-z）

// floorAboveBeyondHi（既定true）: はり出しの向こう（hi側のCL=4000の外）に**2階の実部屋**を置くか。
// 既定は実データ「5」A1と同じ構成（X3の向こうに2階の実部屋がある＝上階FLの断面線が出る）。
// falseは「2階でも吹抜けが続き、境界には腰壁だけが立つ」構成——壁は同じだけ続くが床が無い。
function makeVoidAboveCase(overhangMm, { floorAboveBeyondHi = true } = {}) {
  const graph = makeGraph('p1', 0);
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  room.finish.setField('baseboardHeight', 'h=60');
  const upper = makeGraph('p2', VOID_ABOVE_FH);
  const voidRoom = makeRectRoom(upper, 2000, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  if (floorAboveBeyondHi) makeRectRoom(upper, 4000, 0, 4000 + overhangMm, 3000, '洋室');
  const cl = (t, v) => upper.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const axis = [...upper.centerLines].find(c => !c.isVertical && Math.abs(c.value) < 1);
  // hi側（吹抜けが達している端）へ overhangMm、lo側（吹抜けでない端）へも同じだけ続ける。
  upper.addWall(axis, 0, false, cl(CenterLineType.VERTICAL, 4000), -57.5,
    cl(CenterLineType.VERTICAL, 4000 + overhangMm), -57.5, {});
  upper.addWall(axis, 0, false, cl(CenterLineType.VERTICAL, -overhangMm), 57.5,
    cl(CenterLineType.VERTICAL, 0), 57.5, {});
  return buildRoomBandWithVoidAbove(room, graph, voidRoom, upper,
    { floorHeightAboveMm: VOID_ABOVE_FH });
}

const linesOf = band => band.primitives.filter(p => p.type === 'line');
// 面Aのパネル内（次の面Bのパネルは x=4700 から始まる）の線だけ。
const inFaceA = p => Math.max(p.x1, p.x2) < 4600;
// 図の本体（通り芯の一点鎖線・寸法行は除く）の縦線。
const vertsOf = band => linesOf(band).filter(p => p.x1 === p.x2 && !p.dash && inFaceA(p));

test('【はり出し】buildRoomBandWithVoidAbove: 吹抜けが達している端では面の外に上階の壁エッジが出る（自階の床線・面端縦線・巾木は面の端のまま）', () => {
  const band = makeVoidAboveCase(200);

  // 上＝上階の天井断面線が200はり出す（吹抜けの区間 local2000〜面の端3885 → 4085）。
  const upperCeil = linesOf(band).find(p => p.y1 === UPPER_CEIL_Y && p.y2 === UPPER_CEIL_Y && p.x1 === 2000);
  assert.equal(upperCeil.x2, FACE_A_RUN + 200, '上階の天井断面線が面の端より200外まで伸びるはず');

  // 外端＝上階の壁エッジ（断面エンジンのcontent）。面の外に出た縦線の最も外がはり出しの端。
  const outer = vertsOf(band).filter(p => p.x1 > FACE_A_RUN + 1e-6);
  assert.ok(outer.length > 0, 'はり出し区間に上階の壁エッジ（縦線）が出るはず');
  const far = outer.reduce((a, b) => (a.x1 >= b.x1 ? a : b));
  assert.equal(far.x1, FACE_A_RUN + 200, '最も外の縦線ははり出しの端（面の端+200）');
  assert.equal(Math.max(far.y1, far.y2), -VOID_ABOVE_FH, '下端は上階のFL');
  assert.equal(Math.min(far.y1, far.y2), UPPER_CEIL_Y, '上端は上階の天井');

  // 下＝上階のFL断面線（ユーザー裁定2026-09）。はり出し区間のうち**面端のCLより向こう側**
  // （CL4000＝面ローカル3942.5〜外端4085）にだけ引く——上階の床が始まるのは面端に立つ壁のCLで、
  // CLより手前は吹抜けの上に壁が張り出している側（ユーザー実機指摘2026-09「「5」A1: 追加された
  // 2階X3の2FLは、X3の右側が正解」）。面の内側へも続かない（上階の床は腰壁の断面の中）。
  // これで上・外端・下の3本ではり出し区間が閉じる。
  const upperFL = linesOf(band).filter(p => p.y1 === -VOID_ABOVE_FH && p.y2 === -VOID_ABOVE_FH
    && p.weight === 'thick' && inFaceA(p));
  assert.deepEqual(upperFL.map(p => [p.x1, p.x2]), [[3942.5, FACE_A_RUN + 200]],
    'はり出し区間のうちCLより外（3942.5〜+200）にだけ上階FLの断面線が1本出るはず');

  // 自階の実体は面の端で終わる: 床線（y=0・太）・巾木（y=-60・細）・面端の縦線。
  const floorHi = Math.max(...linesOf(band)
    .filter(p => p.y1 === 0 && p.y2 === 0 && p.weight === 'thick' && inFaceA(p)).map(p => p.x2));
  assert.equal(floorHi, FACE_A_RUN, '自階の床線は面の端で終わる（はり出さない）');
  const baseHi = Math.max(...linesOf(band)
    .filter(p => p.y1 === -60 && p.y2 === -60 && inFaceA(p)).map(p => p.x2));
  assert.equal(baseHi, FACE_A_RUN, '巾木は面の端で終わる（はり出さない）');
  // 【案2】展開図一般化§5.12 D2-1是正・裁定(a)「面端の外はcontent側に渡す」: 面端縦線自体の
  // 上端は、この帯自身の実壁の高さ＝上階FL（-VOID_ABOVE_FH）までに縮む——天井（UPPER_CEIL_Y）
  // まで伸ばすと、上階FLから上（はり出し・壁の縁）と二重に描くことになる。上階FLから上は
  // 上のupperFL断面線・外端の壁エッジ（content）が描く担当（elevationFigure.jsのcapsAtUpperFloor）。
  assert.ok(vertsOf(band).some(p => p.x1 === FACE_A_RUN && p.weight === 'thick'
    && Math.min(p.y1, p.y2) === -VOID_ABOVE_FH && Math.max(p.y1, p.y2) === 0),
  '面端の縦線は面の端のまま（床〜上階FL。天井までは伸ばさない）');
});

test('【失敗系・はり出し】buildRoomBandWithVoidAbove: はり出しの向こうにも吹抜けが続く（上階に床が無い）端では上階FLの断面線を引かない', () => {
  // 2階の壁は現行どおり200続くのでgateの条件（壁あり・吹抜けが端に達する・上限内）は通るが、
  // 面端のCLの向こうに2階の実部屋が無い＝**そこに上階の床は無い**（実機症状: 2階で吹抜けが
  // 2室ぶん続き境界に腰壁だけが立つ構成で、床の無い位置へ2FLの断面線が57.5出た）。
  // .claude/elevation-model.md「上に部屋が無い位置に床の断面線を描いてはいけない」。
  const band = makeVoidAboveCase(200, { floorAboveBeyondHi: false });
  const upperFL = linesOf(band).filter(p => p.y1 === -VOID_ABOVE_FH && p.y2 === -VOID_ABOVE_FH
    && p.weight === 'thick' && inFaceA(p)).map(p => [p.x1, p.x2]);
  assert.deepEqual(upperFL, [], `上階FLの断面線は1本も出ないはず（実際:${JSON.stringify(upperFL)}）`);

  // はり出しそのもの（上階の壁は実在する）は落とさない——上＝天井断面線と外端＝壁エッジは残る。
  const upperCeil = linesOf(band).find(p => p.y1 === UPPER_CEIL_Y && p.y2 === UPPER_CEIL_Y && p.x1 === 2000);
  assert.equal(upperCeil.x2, FACE_A_RUN + 200, '上階の天井断面線は従来どおり200はり出すはず');
  assert.ok(vertsOf(band).some(p => Math.abs(p.x1 - (FACE_A_RUN + 200)) < 1e-6),
    'はり出しの外端の壁エッジ（縦線）も残るはず');
});

test('【失敗系・はり出し】buildRoomBandWithVoidAbove: 上限500mmを超えて続く上階の平面には何も足さない（全か無か）', () => {
  const band = makeVoidAboveCase(600);
  const upperCeil = linesOf(band).find(p => p.y1 === UPPER_CEIL_Y && p.y2 === UPPER_CEIL_Y && p.x1 === 2000);
  assert.equal(upperCeil.x2, FACE_A_RUN, '600mm（>500mm）は上限超なので天井断面線は面の端で終わる');
  assert.deepEqual(vertsOf(band).filter(p => p.x1 > FACE_A_RUN + 1e-6), [],
    '面の外に線を1本も出さない');
});

test('【失敗系・はり出しgate】buildRoomBandWithVoidAbove: 吹抜けが達していない端は、上階の平面が続いていてもはり出さない', () => {
  const band = makeVoidAboveCase(200);
  // 面Aのlo側（local x=0）は吹抜けでない（吹抜けはlocal 2000〜）。上階の壁はそこにも200続くが、
  // 閉じる線が無いので広げない——広げると自階の天井断面線だけがx=-200まで飛び出す。
  const ownCeil = linesOf(band).find(p => p.y1 === -CH && p.y2 === -CH && p.weight === 'thick' && inFaceA(p));
  assert.equal(Math.min(ownCeil.x1, ownCeil.x2), 0, '自階の天井断面線は面の端(x=0)から始まるはず');
  // 図の本体（y<=0。寸法行・部屋名枠は床より下＝y>0）だけを見る。
  const outside = linesOf(band)
    .filter(p => !p.dash && Math.max(p.y1, p.y2) <= 0 && Math.min(p.x1, p.x2) < -1e-6);
  assert.deepEqual(outside, [], `面の外（lo側）に線を1本も出さないはず（実際:${JSON.stringify(outside)}）`);
});

test('【失敗系・はり出し】planeOverhangForFace: 壁のない端では広げない（体裁のはり出しの領域）', () => {
  // 合成データでは面の端の「壁あり」フラグは部屋の隅の形から決まり、壁を消しても落ちない
  // （elevationFaces.jsのsnapFaceEndsToCorners）ため、式そのものへ壁のない端を与えて確かめる。
  const graph = makeGraph('p1', 0);
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const upper = makeGraph('p2', VOID_ABOVE_FH);
  makeRectRoom(upper, 2000, 0, 4000, 3000, '洋室');
  const axis = [...upper.centerLines].find(c => !c.isVertical && Math.abs(c.value) < 1);
  const cl = v => upper.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  upper.addWall(axis, 0, false, cl(4000), -57.5, cl(4200), -57.5, {});
  const face = { isVertical: false, inward: 1, axisCL: { effectiveValue: 0 },
    lo: 57.5, hi: 3942.5, run: 3885, dirSign: 1, hasWallAtLocal0: true, hasWallAtLocalRun: true };
  const endBandZ = { atLocal0: VOID_ABOVE_FH + CH, atLocalRun: VOID_ABOVE_FH + CH };
  assert.equal(planeOverhangForFace(face, upper, { layerBoundaryZ: VOID_ABOVE_FH, endBandZ }).hi, 200,
    '壁のある端では200はり出す（前提）');
  assert.equal(planeOverhangForFace({ ...face, hasWallAtLocalRun: false }, upper,
    { layerBoundaryZ: VOID_ABOVE_FH, endBandZ }).hi, 0, '壁のない端では0');
});

// ---- 純粋な吹抜け帯（buildVoidBand。下階を積む帯）の**面の端も層ごとに違う** ----
// ユーザー裁定2026-09: 上部吹抜けの帯と同じ規則を鏡像で適用する（上限500mm）。認めるのは
// 「その端の区間の**床**断面が、下階層の**天井**より下にある端」＝下階のFLまで下りていて、
// 下階の空間がそこで見えている端だけ。
// 合成データ: 2階の吹抜け(2000,0)-(4000,3000)の下に、1階のLDKを lo 側へ overhangMm だけ広く
// 置く——面A（y=0の通り）の1階の壁が、面のlo端(2057.5)より overhangMm 外へ続く形。
const VOID_DROP = 2900;         // 階高（下階FL＝図座標 y=+2900）
const VOID_FACE_A_RUN = 1885;   // 面A（2057.5..3942.5）
const LOWER_CEIL_Y = VOID_DROP - CH; // 下階の天井（-2900+2400=-500 → y=+500）

function makeVoidBandCase(overhangMm, { lowerFeature = null } = {}) {
  const graph = makeGraph('p1', VOID_DROP);
  const voidRoom = makeRectRoom(graph, 2000, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  const lowerGraph = makeGraph('p0', 0);
  const lowerRoom = makeRectRoom(lowerGraph, 2000 - overhangMm, 0, 4000, 3000, 'LDK');
  // lowerFeature（既定null＝通常部屋）を与えると findLowerRoom（feature===null のみ）が引けなくなる。
  if (lowerFeature) lowerRoom.setFeature(lowerFeature);
  return buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm: VOID_DROP });
}

test('【はり出し】buildVoidBand: 下階の平面が面の端より外へ続く端では、下階の壁エッジ・床断面線のはり出し・下階の天井断面線ではり出し区間が閉じる', () => {
  const band = makeVoidBandCase(100);
  const lines = band.primitives.filter(p => p.type === 'line' && !p.dash);

  // 下辺＝下階の床断面線（＝この端の区間の床断面。covered端なので下階のFL）が100はり出す。
  const floor = lines.find(p => p.y1 === VOID_DROP && p.y2 === VOID_DROP && p.weight === 'thick');
  assert.equal(floor.x1, -100, '床断面線が面の端(x=0)より100外まで伸びるはず');
  assert.equal(floor.x2, VOID_FACE_A_RUN, 'run側は面の端のまま（そちらに下階の平面の続きは無い）');

  // 外端＝下階の壁エッジ（断面エンジンのcontent）。下階のFL〜下階の天井。
  const edge = lines.find(p => p.x1 === p.x2 && p.x1 === -100);
  assert.ok(edge, 'はり出しの外端に下階の壁エッジ（縦線）が出るはず');
  assert.equal(Math.max(edge.y1, edge.y2), VOID_DROP, '下端は下階のFL');
  assert.equal(Math.min(edge.y1, edge.y2), LOWER_CEIL_Y, '上端は下階の天井');

  // 上辺＝下階の天井断面（contentが描く）。そこから上（下階の天井〜自階の床）は床構造＝非描画。
  const top = lines.find(p => p.y1 === LOWER_CEIL_Y && p.y2 === LOWER_CEIL_Y);
  assert.ok(top && Math.min(top.x1, top.x2) === -100 && Math.max(top.x1, top.x2) === 0,
    `はり出し区間の上辺（下階の天井）が出るはず（実際:${JSON.stringify(top)}）`);

  // 自階の要素（天井断面線・面端の縦線）は面の端のまま。
  const ceil = lines.find(p => p.y1 === -CH && p.y2 === -CH && p.weight === 'thick');
  assert.equal(Math.min(ceil.x1, ceil.x2), 0, '自階の天井断面線は面の端で終わる（はり出さない）');
  assert.ok(lines.some(p => p.x1 === p.x2 && p.x1 === 0 && p.weight === 'thick'),
    '面端の縦線は面の端のまま');
});

// QA指摘2026-09（テスト①）: 「下階Roomが引けなければオプトインしない」（＝下階の天井が
// 分からないまま面の外を描かない）が無防備だった——ガードを外してもテストが1つも落ちない。
// 下階の部屋を階段（feature≠null）にすると`findLowerRoom`が引けず、はり出しの材料が無くなる。
test('【失敗系・はり出し】buildVoidBand: 下階Roomが引けなければ（階段室しか無い）はり出しを一切認めない', () => {
  const band = makeVoidBandCase(100, { lowerFeature: RoomFeature.STAIR });
  const lines = band.primitives.filter(p => p.type === 'line' && !p.dash);

  // 下階に同じ通りの壁はあるので床は下がる（＝はり出しだけが落ちていることを示す前提）。
  const floor = lines.find(p => p.y1 === VOID_DROP && p.y2 === VOID_DROP && p.weight === 'thick');
  assert.ok(floor, '床断面線は従来どおり下階のFLまで下がるはず（前提）');
  assert.equal(floor.x1, 0, '下階の天井が分からない＝床断面線は面の端で終わる（はり出さない）');

  const outside = lines.filter(p =>
    Math.max(p.y1, p.y2) <= VOID_DROP && Math.min(p.x1, p.x2) < -1e-6);
  assert.deepEqual(outside, [], `面の外へ線を1本も出さないはず（実際:${JSON.stringify(outside)}）`);
});

test('【失敗系・はり出し】buildVoidBand: 下階の平面が面の端に達していない端では何も足さない', () => {
  // 1階を吹抜けより狭く置く＝面Aのlo端の外に下階の壁が無い（床も設置階のまま）。
  const graph = makeGraph('p1', VOID_DROP);
  const voidRoom = makeRectRoom(graph, 2000, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  const lowerGraph = makeGraph('p0', 0);
  makeRectRoom(lowerGraph, 2500, 0, 4000, 3000, 'LDK');
  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm: VOID_DROP });
  const lines = band.primitives.filter(p => p.type === 'line' && !p.dash);
  assert.ok(lines.some(p => p.y1 === 0 && p.y2 === 0 && p.x1 === 0),
    '面Aのlo端の区間は下階に壁が無いので設置階の床(y=0)のまま（前提）');
  const outside = lines.filter(p => Math.max(p.y1, p.y2) <= VOID_DROP && Math.min(p.x1, p.x2) < -1e-6);
  assert.deepEqual(outside, [], `面の外へ線を1本も出さないはず（実際:${JSON.stringify(outside)}）`);
});

// QA指摘2026-09（テスト②）: 上の「面の端に達していない」テストは**gateを判別していない**
// ——面の外に下階の壁がそもそも無いので、gateを常にtrueにしても`planeOverhangForFace`は0を返す。
// gateだけを問うには「面の外側**だけ**を占める下階の壁」が要る:
//   ・`lowerCoverLocal`は面の端（ローカル0）に届かない → 先頭区間の床は設置階の床(0)のまま
//     ＝下階の空間はその端で見えていない ＝ gateは閉じる
//   ・`wallWorldRangesOnFacePlane`はその端をまたいで外へ続く → gateが無ければ100はり出す
test('【失敗系・はり出しgate】buildVoidBand: 面の外側だけを占める下階の壁があっても、床が下りていない端でははり出さない', () => {
  const graph = makeGraph('p1', VOID_DROP);
  const voidRoom = makeRectRoom(graph, 2000, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  const lowerGraph = makeGraph('p0', 0);
  // 下階の部屋は面Aのlo端(2057.5)より内側(2557.5)からしか無い＝lo端の区間は床が下りない。
  makeRectRoom(lowerGraph, 2500, 0, 4000, 3000, 'LDK');
  // その上で、面Aの通り（y=0）の下階の壁を lo端の**外側だけ**（1957.5..2057.5）に置く。
  const axis = [...lowerGraph.centerLines].find(c => !c.isVertical && Math.abs(c.value) < 1);
  const cl = v => lowerGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  lowerGraph.addWall(axis, 0, false, cl(1900), 57.5, cl(2000), 57.5, {});

  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm: VOID_DROP });
  const lines = band.primitives.filter(p => p.type === 'line' && !p.dash);

  const ownFloor = lines.find(p => p.y1 === 0 && p.y2 === 0 && p.weight === 'thick');
  assert.ok(ownFloor, '面Aのlo端の区間は下階に壁が無いので設置階の床(y=0)に残るはず（前提）');
  assert.equal(ownFloor.x1, 0, '床断面線は面の端で終わる（gateが閉じているのではり出さない）');
  const outside = lines.filter(p =>
    Math.max(p.y1, p.y2) <= VOID_DROP && Math.min(p.x1, p.x2) < -1e-6);
  assert.deepEqual(outside, [], `面の外へ線を1本も出さないはず（実際:${JSON.stringify(outside)}）`);
});

test('【失敗系・はり出し】buildVoidBand: 上限500mmを超えて続く下階の平面には何も足さない（全か無か）', () => {
  const band = makeVoidBandCase(600);
  const lines = band.primitives.filter(p => p.type === 'line' && !p.dash);
  const floor = lines.find(p => p.y1 === VOID_DROP && p.y2 === VOID_DROP && p.weight === 'thick');
  assert.equal(floor.x1, 0, '600mm（>500mm）は上限超なので床断面線は面の端で終わる');
  // 図の本体（下階のFLより上）だけを見る——部屋名の引き出し線はその下の注記行。
  const outside = lines.filter(p =>
    Math.max(p.y1, p.y2) <= VOID_DROP && Math.min(p.x1, p.x2) < -1e-6);
  assert.deepEqual(outside, [], '面の外へ線を1本も出さないはず');
});

// ---- ユーザー裁定2026-09「「5」A1 X3外側の腰壁断面は、2FL断面まで下りて外側に向かって
// 張り出して終了、が正解」: はり出しの外端に**切断壁**（上階の腰壁）が立つ端では、上階FLの
// 断面線をその壁の向こう側の面から外へwallLessEndExtendModelMmぶん張り出して終える。
// 実データ「5」A1と同じ形になるのは、はり出し量が**隅の壁厚ぶん**（115）＝はり出しの外端が
// 壁の向こう側の面と一致する構成（overhangMm=115）。 ----
test('【はり出し】buildRoomBandWithVoidAbove: はり出し外端に上階の切断壁が立つ端は、壁の向こう側の面から外へ2FL線を張り出す', () => {
  const band = makeVoidAboveCase(115);
  const OUT = FACE_A_RUN + 115; // はり出しの外端＝面端に立つ壁の向こう側の面
  const upperFL = linesOf(band).filter(p => p.y1 === -VOID_ABOVE_FH && p.y2 === -VOID_ABOVE_FH
    && p.weight === 'thick' && Math.max(p.x1, p.x2) < 4600);
  assert.deepEqual(upperFL.map(p => [p.x1, p.x2]),
    [[OUT, OUT + DEFAULT_WALL_LESS_END_EXTEND_MM]],
    '壁の向こう側の面から外へwallLessEndExtendModelMm(150)ぶん、1本だけ');
  assert.ok(!upperFL.some(p => Math.min(p.x1, p.x2) < OUT - 1e-6),
    '壁の下（面端のCL〜向こう側の面）には引かない＝切断壁の断面の中を通さない');
  // 天井断面線は従来どおり壁の外側の面まで（張り出すのは2FL線だけ）。
  const upperCeil = linesOf(band).find(p => p.y1 === UPPER_CEIL_Y && p.y2 === UPPER_CEIL_Y && p.x1 === 2000);
  assert.equal(upperCeil.x2, OUT, '上階の天井断面線ははり出しの外端で終わる');
});

test('【失敗系・はり出し】buildRoomBandWithVoidAbove: 上階に床が無い端(upperFloorEnds=false)は切断壁でも2FL線を引かない', () => {
  const band = makeVoidAboveCase(115, { floorAboveBeyondHi: false });
  const upperFL = linesOf(band).filter(p => p.y1 === -VOID_ABOVE_FH && p.y2 === -VOID_ABOVE_FH
    && p.weight === 'thick' && Math.max(p.x1, p.x2) < 4600).map(p => [p.x1, p.x2]);
  assert.deepEqual(upperFL, [],
    `上階の床が無い端のgateは切断壁の張り出しにも効く（実際:${JSON.stringify(upperFL)}）`);
});
