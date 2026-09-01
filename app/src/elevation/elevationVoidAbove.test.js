// buildRoomBandWithVoidAbove（上部吹抜けの多層書き。ユーザー明示指示2026-08）のテスト。
// 「吹抜けの展開は床断面のある階に」「上部吹抜けが落ちている部屋の展開と一緒に多層書き」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomBandWithVoidAbove } from './elevationVoid.js';

const CH = 2400;
const FLOOR_HEIGHT = 3000;

function makeGraph(name, elevation) {
  return new PlanGraph(new Plane(name, elevation, name, 1, 1));
}
// 同じ値の通り芯は使い回す（実グラフと同じ前提。毎回addCenterLineすると同値のCLが二重にでき、
// 隣り合う部屋の境界の壁が「別の軸CLに載った別の壁」になって、断面の内部に縦線が出る）。
function clOf(graph, type, value) {
  return graph.centerLines.find(cl => cl.centerLineType === type && cl.value === value)
    ?? graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
}
function makeRectRoom(graph, x0v, y0v, x1v, y1v, name) {
  const x0 = clOf(graph, CenterLineType.VERTICAL, x0v);
  const x1 = clOf(graph, CenterLineType.VERTICAL, x1v);
  const y0 = clOf(graph, CenterLineType.HORIZONTAL, y0v);
  const y1 = clOf(graph, CenterLineType.HORIZONTAL, y1v);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}
// 帯のCUT水平線（床線・天井線）をy値ごとにまとめる。y=0が下階FL、-3000が2FL、-5400が2階天井。
function cutYs(band) {
  return [...new Set(band.primitives
    .filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2)
    .map(p => Math.round(p.y1)))].sort((a, b) => a - b);
}

test('【明示指示】buildRoomBandWithVoidAbove: 吹抜けが真上に載る部屋の帯が2層になり、上階天井まで描かれる', () => {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 3000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
  assert.equal(band.heightUnits, 2, '多層書きの帯はheightUnits=2のはず');
  // 4面とも下階に同じ壁があるので、壁は吹抜けを貫いて上階天井(-5400)まで続く。
  assert.deepEqual(cutYs(band), [-(FLOOR_HEIGHT + CH), 0],
    '床線は下階FL(0)・天井線は上階天井(-5400)の2本だけになるはず');
});

// 「吹抜けは天井断面まで水平断面が無い（見えがかりは存在する）」（ユーザー明示指示2026-08）。
// 下階にその面の壁があるかどうかは断面の有無を左右しない——吹抜け側だけ床を2FLへ上げていた
// 旧実装では1F床断面が面の端まで届かず、端の壁断面と取り合わなかった（「5」A1・D1）。
test('【明示指示】buildRoomBandWithVoidAbove: 吹抜けの区間にも上階床位置の水平断面は出ず、床断面は下階FLで通る', () => {
  // 下階は南北に広く、吹抜けは北半分だけ。吹抜けの南面(y=3000)は下階の室内側で壁が無い。
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
  const ys = cutYs(band);
  assert.ok(!ys.includes(-FLOOR_HEIGHT),
    `上階床(2FL=-3000)の位置に水平断面は出ないはず（実際:${JSON.stringify(ys)}）`);
  assert.ok(ys.includes(0), '床断面は下階FL(0)で通るはず');
  assert.ok(ys.includes(-(FLOOR_HEIGHT + CH)), '吹抜けの区間は上階天井(-5400)まで伸びるはず');
  assert.ok(ys.includes(-CH), '吹抜けの外の区間は下階天井(-2400)のままのはず');
});

test('【明示指示】buildRoomBandWithVoidAbove: 床断面は面の端（壁断面の位置）まで途切れずに届く', () => {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
  // 吹抜けを含む面（走り6000の面）の床線が、区間で分かれていても端から端まで連続すること。
  const floors = band.primitives
    .filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && Math.round(p.y1) === 0)
    .map(p => ({ a: Math.min(p.x1, p.x2), z: Math.max(p.x1, p.x2) }))
    .sort((u, v) => u.a - v.a);
  const gaps = floors.slice(1).map((f, i) => f.a - floors[i].z).filter(g => g > 1);
  assert.deepEqual(gaps.filter(g => g < 100), [],
    `同じ面の中で床断面が途切れてはいけない（実際の隙間:${JSON.stringify(gaps)}）`);
});

test('【失敗系】buildRoomBandWithVoidAbove: 階高が解決できなければ多層書きせず1層の帯を返す', () => {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 3000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, {});
  assert.equal(band.heightUnits, 1, '階高が無ければ1層のはず');
  assert.deepEqual(cutYs(band), [-CH, 0], '下階の床〜天井だけのはず');
});


// ---- 壁断面・見えがかりは階段展開と同じ2.5D断面エンジンで出す（ユーザー明示指示2026-08） ----
// 「見えがかりは存在する」＝1階天井高さ・2階の壁（腰壁・垂れ壁）は見える。
// 直交壁は面の壁に突き当たって室内側の面で終わるため、CL上の切断線には届かない
// （line.buttToleranceMm で面の壁の半厚ぶんを許容する。sectionProbe.jsのisCutWall）。
test('【明示指示】buildRoomBandWithVoidAbove: 上階の腰壁が面に突き当たる位置に断面（天端）が出る', () => {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  // 吹抜けの南辺(y=3000)に天端800の腰壁を指定する（吹抜けまわりの手すり壁）。
  const cls = [...g2.centerLines];
  const hCL = cls.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.effectiveValue === 3000);
  const vCLs = cls.filter(c => c.centerLineType === CenterLineType.VERTICAL);
  g2.setKneeDropWall(`${hCL.id}:${vCLs.find(c => c.effectiveValue === 0).id}:${vCLs.find(c => c.effectiveValue === 4000).id}`,
    { knee: { topHeight: 800 }, drop: null });

  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
  const kneeTopY = -(FLOOR_HEIGHT + 800);
  const tops = band.primitives.filter(p => p.type === 'line' && p.y1 === p.y2
    && Math.abs(p.y1 - kneeTopY) < 1e-6);
  assert.ok(tops.length > 0,
    `腰壁の天端(z=${FLOOR_HEIGHT + 800})の断面線が出るはず（実際:${tops.length}本）`);
});

test('【失敗系】buildRoomBandWithVoidAbove: 腰壁指定が無ければ天端の線は出ない', () => {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
  const tops = band.primitives.filter(p => p.type === 'line' && p.y1 === p.y2
    && Math.abs(p.y1 - (-(FLOOR_HEIGHT + 800))) < 1e-6);
  assert.equal(tops.length, 0, '腰壁が無ければ天端の線は出ないはず');
});

// ================================================================
// 新仕様（ユーザー明示指示）: 高低差のある、階の異なる水平な天井断面線は結ばない。
// 併せて、その境界に立つ2階の壁の断面が抽出されること（実機「5」A: 2階X2通りの壁が
// 断面抽出から丸ごと漏れていた——列の天井で打ち切る処理が落としていた）。
// ================================================================

// 下階は南北に広く、吹抜けは北半分だけ＝東西の面（走り6000）の途中で天井の高さが変わる。
// 吹抜けの南には**実在の2階の部屋**を置く（＝そこには上階の床がある）——実機「5」と同じ構成。
// 床が無ければ「上階の床の断面」は描かない（別テストで固定）。
function makeHalfVoidBand() {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  makeRectRoom(g2, 0, 3000, 4000, 6000, '21');
  return buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
}
const vLines = band => band.primitives.filter(p =>
  p.type === 'line' && !p.dash && Math.abs(p.x1 - p.x2) < 1e-6);

test('【新仕様】buildRoomBandWithVoidAbove: 階の異なる天井断面線（1F天井と2F天井）は縦線で結ばない', () => {
  const band = makeHalfVoidBand();
  const joins = vLines(band).filter(p =>
    p.weight === 'thick'
    && Math.abs(Math.min(-p.y1, -p.y2) - CH) < 1e-6
    && Math.abs(Math.max(-p.y1, -p.y2) - (FLOOR_HEIGHT + CH)) < 1e-6);
  // この位置に出てよいのは境界に立つ壁の断面（2本＝壁厚の両縁）だけで、
  // 「2本の天井線を1本で結ぶ線」は出ない——結ぶと壁厚を持たない線になり、実際にそこに
  // 立っている壁の断面と二重になる。
  const xs = [...new Set(joins.map(p => p.x1))];
  assert.equal(xs.length % 2, 0, `壁厚の両縁で必ず偶数本になるはず（実際:${JSON.stringify(xs)}）`);
  for (const x of xs) {
    assert.ok(joins.filter(p => Math.abs(p.x1 - x) < 1e-6).every(p => p.__o === 'cutEdgeLo' || p.__o === 'cutEdgeHi'),
      `x=${x}の縦線は壁断面の縁であるはず（天井線どうしを結ぶ線ではない）`);
  }
});

test('【実機「5」A】buildRoomBandWithVoidAbove: 天井の高さが変わる境界の断面は、1F天井から2F天井まで途切れずに立つ', () => {
  const band = makeHalfVoidBand();
  // 内訳は「上階の床の小口（1F天井〜2FL）」＋「壁の断面（2FL〜2F天井）」の2本。壁の帯を下へ
  // 引き伸ばすのではなく、床構造の断面を別に立てる（そうしないと壁の**向こう側の面**まで
  // 1F天井まで下りてしまい、断面の中に線が入る）。
  const wallEdges = vLines(band).filter(p => p.__o === 'cutEdgeLo' || p.__o === 'cutEdgeHi');
  assert.ok(wallEdges.length > 0, `境界の壁の断面が出るはず（実際:${JSON.stringify(wallEdges)}）`);
  for (const p of wallEdges) {
    assert.equal(p.weight, 'thick', '壁の断面の縁は太線(CUT)');
    assert.equal(Math.min(-p.y1, -p.y2), FLOOR_HEIGHT, '壁の足元＝2FLから始まるはず');
    assert.equal(Math.max(-p.y1, -p.y2), FLOOR_HEIGHT + CH, '高い側の天井（2F天井）まで');
  }
  // 吹抜けに面する側の縁には、1F天井〜2FLの小口（太線）が繋がっている
  // （反対側の縁の下は上階の床の中なので小口は無い）。
  const slabEdges = vLines(band).filter(q => q.weight === 'thick'
    && Math.abs(Math.min(-q.y1, -q.y2) - CH) < 1e-6 && Math.abs(Math.max(-q.y1, -q.y2) - FLOOR_HEIGHT) < 1e-6);
  assert.ok(slabEdges.length > 0, '上階の床の小口（1F天井〜2FL）が立つはず');
  for (const e of slabEdges) {
    assert.ok(wallEdges.some(p => Math.abs(p.x1 - e.x1) < 1e-6),
      `小口(x=${e.x1})は壁の断面の縁と同じxで繋がるはず`);
  }
});

test('【失敗系・実機「5」A面左3200】buildRoomBandWithVoidAbove: 左右とも1F天井の区間に立つ2階の壁は、天井に隠れるので断面を出さない', () => {
  // 吹抜けを面の中央だけにし、「2階の間仕切りを吹抜けの外（左右とも1F天井の区間）へ足しても
  // 断面が1本も増えない」ことで確かめる——増えないこと自体が「天井に隠れている」の意味。
  const build = withPartition => {
    const g1 = makeGraph('1階', 0);
    const room = makeRectRoom(g1, 0, 0, 4000, 9000, 'LDK');
    const g2 = makeGraph('2階', FLOOR_HEIGHT);
    const voidRoom = makeRectRoom(g2, 0, 3000, 4000, 6000, '吹抜け');
    voidRoom.setFeature(RoomFeature.VOID);
    if (withPartition) {
      const yMid = g2.addCenterLine(CenterLineType.HORIZONTAL, 7500, { labeled: false, discipline: Discipline.ARCH });
      const xW = g2.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
      const xE = g2.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
      g2.addWall(yMid, 57.5, false, xW, 0, xE, 0, { isRoomWall: false, isExteriorWall: false, wallFinish: 12.5 });
      g2.addWall(yMid, -57.5, false, xW, 0, xE, 0, { isRoomWall: false, isExteriorWall: false, wallFinish: 12.5 });
    }
    return buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
  };
  const edgesOf = band => vLines(band)
    .filter(p => p.__o === 'cutEdgeLo' || p.__o === 'cutEdgeHi')
    .map(p => `${p.x1}|${p.y1}|${p.y2}`).sort();
  assert.deepEqual(edgesOf(build(true)), edgesOf(build(false)),
    '吹抜けの外（天井が1F天井のままの区間）に立つ2階の間仕切りは断面を増やさないはず');
});

test('【実機「5」A】buildRoomBandWithVoidAbove: 境界の壁の断面は、上階を描くようになった範囲では壁厚の両縁が出る', () => {
  const band = makeHalfVoidBand();
  const edges = vLines(band).filter(p => p.__o === 'cutEdgeLo' || p.__o === 'cutEdgeHi');
  // 下の断面は「見える側の面だけ」（低い天井の裏は描かない）だが、上階をそれ自身の階として
  // 描くようになった範囲では、同じ壁が上階の切断壁として普通に扱われ壁厚が出る
  // （ユーザー確定の方針C。1階と2階の展開を上下に並べる位置づけ）。
  assert.ok(edges.some(p => p.__o === 'cutEdgeLo') && edges.some(p => p.__o === 'cutEdgeHi'),
    `境界の壁は両縁が出るはず（実際:${JSON.stringify(edges)}）`);
  // 同じxに同じ縁が二重に出ることは無い（下の断面と上階の断面が同座標で重なるぶんは畳まれる）。
  const byX = new Map();
  for (const p of edges) byX.set(`${p.x1}|${p.y1}|${p.y2}`, (byX.get(`${p.x1}|${p.y1}|${p.y2}`) ?? 0) + 1);
  assert.ok([...byX.values()].every(n => n === 1), `同じ縁が二重に出てはいけない（実際:${JSON.stringify([...byX])}）`);
});

test('【失敗系・実機「5」A】buildRoomBandWithVoidAbove: 天井の高さが変わらない位置に立つ壁は、従来どおり両縁を描く', () => {
  // 吹抜けの内側（天井が2F天井のまま）に2階の間仕切りを立てる＝両側とも見えるので壁厚が出る。
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  // 吹抜けの中（y=1500）を東西に横切る2階の間仕切り。腰壁指定で天端を露出させ、天井に隠れない
  // ようにする（吹抜けの中なので列の天井は2F天井＝そもそも打ち切られない）。
  const yMid = g2.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const xW = g2.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const xE = g2.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
  g2.addWall(yMid, 57.5, false, xW, 0, xE, 0, { isRoomWall: false, isExteriorWall: false, wallFinish: 12.5 });
  g2.addWall(yMid, -57.5, false, xW, 0, xE, 0, { isRoomWall: false, isExteriorWall: false, wallFinish: 12.5 });

  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
  const edges = vLines(band).filter(p => p.__o === 'cutEdgeLo' || p.__o === 'cutEdgeHi');
  const pairs = edges.filter(p => Math.min(-p.y1, -p.y2) > CH + 1e-6); // 吹抜けの中に立つ壁の断面
  assert.ok(pairs.some(p => p.__o === 'cutEdgeLo') && pairs.some(p => p.__o === 'cutEdgeHi'),
    `吹抜けの中の壁は両縁（壁厚）が出るはず（実際:${JSON.stringify(pairs)}）`);
});

// ================================================================
// 天井の高さが変わる境界に立つのが**腰壁**の場合（ユーザー実機指摘: 実機「5」D1
// 「Y1から2000の左側、1階天井から2FLまで断面線がない」）。
// 腰壁も「低い側の天井から」始めないと、1F天井と2FLのあいだ（上階の床構造）の断面線が欠ける。
// ================================================================

// 吹抜けは面の北半分だけ。その境界（吹抜けの南壁）を腰壁にした図。
function makeHalfVoidKneeBand() {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  makeRectRoom(g2, 0, 3000, 4000, 6000, '21'); // 吹抜けの南は実在の2階の部屋＝床がある
  const yMid = g2.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000);
  const xW = g2.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const xE = g2.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
  g2.setKneeDropWall(edgeKey(yMid.id, xW.id, xE.id), { knee: { topHeight: 800 } });
  return buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
}

test('【実機「5」D1】buildRoomBandWithVoidAbove: 境界に立つのが腰壁なら、壁の断面は2FLで止まり、上階の床の断面が続く', () => {
  const band = makeHalfVoidKneeBand();
  const edges = vLines(band).filter(p => p.__o === 'cutEdgeLo' || p.__o === 'cutEdgeHi');
  assert.ok(edges.length > 0, `境界の腰壁の断面が出るはず（実際:${JSON.stringify(edges)}）`);
  for (const p of edges) {
    assert.equal(Math.min(-p.y1, -p.y2), FLOOR_HEIGHT,
      '腰壁の断面は足元＝2FLで止まるはず（その下は壁ではなく上階の床構造）');
    assert.equal(Math.max(-p.y1, -p.y2), FLOOR_HEIGHT + 800, '上端は腰壁の天端(2FL+800)');
  }
  // 上階の床の断面: 小口（1F天井〜2FL）と、低い天井の側へ走る床の線。
  const slabEdge = vLines(band).find(p => p.weight === 'thick'
    && Math.abs(Math.min(-p.y1, -p.y2) - CH) < 1e-6 && Math.abs(Math.max(-p.y1, -p.y2) - FLOOR_HEIGHT) < 1e-6);
  assert.ok(slabEdge, '上階の床の小口（1F天井〜2FL）が立つはず');
  const slabTop = band.primitives.find(p => p.type === 'line' && !p.dash && p.weight === 'thick'
    && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - FLOOR_HEIGHT) < 1e-6);
  assert.ok(slabTop, '上階の床の断面線（2FL）が低い天井の側へ走るはず');
});

test('【実機「5」D1】buildRoomBandWithVoidAbove: 腰壁は壁厚の両縁を描く（天端が露出しており見付が見えるため）', () => {
  const band = makeHalfVoidKneeBand();
  const edges = vLines(band).filter(p => p.__o === 'cutEdgeLo' || p.__o === 'cutEdgeHi');
  assert.ok(edges.some(p => p.__o === 'cutEdgeLo') && edges.some(p => p.__o === 'cutEdgeHi'),
    `腰壁は両縁が出るはず——片面だけにすると天端の線が宙で終わる（実際:${JSON.stringify(edges)}）`);
  // 壁厚が2つのWallオブジェクトに割れていても、断面の**内部**に縦線は出ない。
  const xs = [...new Set(edges.map(p => p.x1))].sort((a, b) => a - b);
  for (const face of new Set(xs.map(x => Math.round(x / 1000)))) {
    const inFace = xs.filter(x => Math.round(x / 1000) === face);
    assert.ok(inFace.length <= 2, `1枚の腰壁の断面の縁は2本まで（実際:${JSON.stringify(inFace)}）`);
  }
});

// ================================================================
// 「断面の中」（ユーザー提示の図のa＝1階天井と2階床に挟まれ、右が開いた区間）の輪郭。
// 中には何も描かず、輪郭（小口の縦線・上階の床の断面線）だけを描く。
// ================================================================

// 境界（吹抜けの南辺）に2階の壁が無い図＝上階の床の小口だけがある状態。
function makeHalfVoidNoWallBand() {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  makeRectRoom(g2, 0, 3000, 4000, 6000, '21');
  for (const w of [...g2.walls]) {
    if (!w.isVertical && Math.abs(w.axisCL.effectiveValue - 3000) < 1) g2.removeShape(w);
  }
  return buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
}

test('【断面の中】buildRoomBandWithVoidAbove: 境界に壁が無くても、上階の床の小口と床の断面線が立つ', () => {
  const band = makeHalfVoidNoWallBand();
  const edge = vLines(band).find(p => p.weight === 'thick'
    && Math.abs(Math.min(-p.y1, -p.y2) - CH) < 1e-6 && Math.abs(Math.max(-p.y1, -p.y2) - FLOOR_HEIGHT) < 1e-6);
  assert.ok(edge, '上階の床の小口（1F天井〜2FL）が立つはず——壁が無くても床の断面はある');
  const top = band.primitives.find(p => p.type === 'line' && !p.dash && p.weight === 'thick'
    && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - FLOOR_HEIGHT) < 1e-6);
  assert.ok(top, '上階の床の断面線（2FL）が低い天井の側へ走るはず');
  assert.ok(Math.abs(top.x1 - edge.x1) < 1e-6, '床の断面線は小口から始まるはず');
});

test('【断面の中】buildRoomBandWithVoidAbove: 1階天井と2階床に挟まれた区間（断面の中）には何も描かない', () => {
  for (const [label, band] of [['壁なし', makeHalfVoidNoWallBand()], ['腰壁', makeHalfVoidKneeBand()]]) {
    const inside = band.primitives.filter(p => p.type === 'line' && !p.dash
      // 完全に a の内側（両端が 1F天井 と 2FL のあいだ）にある線
      && Math.min(-p.y1, -p.y2) > CH + 1e-6 && Math.max(-p.y1, -p.y2) < FLOOR_HEIGHT - 1e-6);
    assert.equal(inside.length, 0, `${label}: 断面の中に線があってはならない（実際:${JSON.stringify(inside)}）`);
  }
});

test('【失敗系・断面の中】buildRoomBandWithVoidAbove: 上に部屋が無い（床が無い）境界には床の断面線を描かない', () => {
  // 吹抜けの南に2階の部屋を置かない＝そこには上階の床が無い。
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
  const atFloor = band.primitives.filter(p => p.type === 'line' && Math.abs(p.y1 - p.y2) < 1e-6
    && Math.abs(-p.y1 - FLOOR_HEIGHT) < 1e-6);
  assert.equal(atFloor.length, 0,
    `床が無い境界に2FLの断面線を描いてはいけない（実際:${JSON.stringify(atFloor)}）`);
});

// ================================================================
// 上階ぶんの展開を同じ帯へ重ねる（ユーザー確定の方針C）。
// 輪郭は断面エンジン、体裁（天井線・巾木・壁2段書き・天井高寸法）は面図側。
// **値の出どころはすべて2階の部屋**——1階の巾木高さ・壁材を2階へ転用しない。
// ================================================================

// 吹抜けは面の北半分。南は実在の2階の部屋で、1階と違う巾木高さを持たせる。
function makeUpperStoreyBand({ upperBaseboard = 'h=120', lowerBaseboard = 'h=60' } = {}) {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  room.finish.setField('baseboardHeight', lowerBaseboard);
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  const upper = makeRectRoom(g2, 0, 3000, 4000, 6000, '21');
  upper.finish.setField('baseboardHeight', upperBaseboard);
  return buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
}
const hLines = (band, z) => band.primitives.filter(p => p.type === 'line' && !p.dash
  && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - z) < 1e-6);

test('【方針C】buildRoomBandWithVoidAbove: 上階を描く範囲には上階の天井断面線が立つ', () => {
  const band = makeUpperStoreyBand();
  const top = hLines(band, FLOOR_HEIGHT + CH);
  assert.ok(top.length > 0, '上階の天井断面線(2F天井)が出るはず——これが無いと上階の壁・アキの上が宙で終わる');
  assert.ok(top.every(p => p.weight === 'thick'), '天井断面線は太線(CUT)');
});

test('【方針C】buildRoomBandWithVoidAbove: 上階の巾木は2階の部屋の設定から引く（1階の値を転用しない）', () => {
  const band = makeUpperStoreyBand({ upperBaseboard: 'h=120', lowerBaseboard: 'h=60' });
  assert.ok(hLines(band, 60).length > 0, '1階の巾木(h=60)は床から60');
  assert.ok(hLines(band, FLOOR_HEIGHT + 120).length > 0,
    `2階の巾木は2FL+120のはず（1階の60を転用してはいけない）`);
  assert.equal(hLines(band, FLOOR_HEIGHT + 60).length, 0, '2FL+60（1階の値の転用）は出てはいけない');
});

test('【失敗系・方針C】buildRoomBandWithVoidAbove: 2階の巾木が読めない部屋には上階の巾木を描かない', () => {
  const band = makeUpperStoreyBand({ upperBaseboard: '' });
  const above2FL = band.primitives.filter(p => p.type === 'line' && !p.dash && p.weight === 'thin'
    && Math.abs(p.y1 - p.y2) < 1e-6 && -p.y1 > FLOOR_HEIGHT + 1e-6 && -p.y1 < FLOOR_HEIGHT + CH - 1e-6);
  assert.equal(above2FL.length, 0, `巾木が読めなければ描かない（実際:${JSON.stringify(above2FL)}）`);
});

test('【方針C】buildRoomBandWithVoidAbove: 上階の天井高寸法を1本足す（横方向の寸法は増やさない）', () => {
  const band = makeUpperStoreyBand();
  const vdims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'v');
  const upperDim = vdims.find(p => Math.abs(-p.from - (FLOOR_HEIGHT + CH)) < 1e-6 && Math.abs(-p.to - FLOOR_HEIGHT) < 1e-6);
  assert.ok(upperDim, `上階の天井高寸法(2FL〜2F天井)が1本出るはず（実際:${JSON.stringify(vdims)}）`);
  assert.equal(upperDim.label, CH, '値は2階の天井高');
  assert.equal(vdims.filter(p => Math.abs(-p.from - (FLOOR_HEIGHT + CH)) < 1e-6
    && Math.abs(-p.to - FLOOR_HEIGHT) < 1e-6).length, 1, '帯につき1本だけ');
});
