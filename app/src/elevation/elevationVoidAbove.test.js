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
  // removeShapeは**id**を取る（オブジェクトを渡すと何も消えない）。壁が消えていないと
  // 「境界に壁が無い」というこのフィクスチャの前提が成立しない。
  for (const w of [...g2.walls]) {
    if (!w.isVertical && Math.abs(w.axisCL.effectiveValue - 3000) < 1) g2.removeShape(w.id);
  }
  assert.equal([...g2.walls].filter(w => !w.isVertical
    && Math.abs(w.axisCL.effectiveValue - 3000) < 1).length, 0, '前提: 境界(y=3000)に壁が無いこと');
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
// boundary: 吹抜けと2階の部屋の境界(y=3000)に立つ壁の形。
//   'drop' … 垂れ壁（下端800まで空く）＝下階の空間と2階の空気が**つながる**ので上階を描く
//   'wall' … 上下いっぱいの壁＝そこで連結が切れるので上階は「断面の中」になり描かない
// （可視判定を入れる前は boundary に関わらず常に描いていた。elevationVoid.jsのupperStoreySegments）
function makeUpperStoreyBand({ upperBaseboard = 'h=120', lowerBaseboard = 'h=60',
  boundary = 'drop' } = {}) {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  room.finish.setField('baseboardHeight', lowerBaseboard);
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  const upper = makeRectRoom(g2, 0, 3000, 4000, 6000, '21');
  upper.finish.setField('baseboardHeight', upperBaseboard);
  if (boundary === 'drop') {
    const cls = [...g2.centerLines];
    const hCL = cls.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.effectiveValue === 3000);
    const v0 = cls.find(c => c.centerLineType === CenterLineType.VERTICAL && c.effectiveValue === 0);
    const v1 = cls.find(c => c.centerLineType === CenterLineType.VERTICAL && c.effectiveValue === 4000);
    g2.setKneeDropWall(`${hCL.id}:${v0.id}:${v1.id}`, { knee: null, drop: { bottomHeight: 800 } });
  }
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

// ================================================================
// 「展開図では断面の中は描画しない」の一般規則（ユーザー明示指示2026-08。実機「5」A・C1）
// 「断面の中」＝連続した断面線で切り取られた向こう側全て。多層帯では断面線が図を左右に
// 分割するので、**分割されたどちら側が中なのか**を空気セルの連結成分で決める
// （section/sectionVisibility.js）。
// 構成: 1階は0..6600の1室。2階はX2(=3200)で分かれ、左が部屋・右が吹抜け。
// ================================================================

function makeSplitUpperBand({ kneeTopMm = null } = {}) {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 6600, 3000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  makeRectRoom(g2, 0, 0, 3200, 3000, '21');
  const voidRoom = makeRectRoom(g2, 3200, 0, 6600, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  if (kneeTopMm != null) {
    // X2の2階壁を腰壁にする（吹抜けまわりの手すり壁）。天端の上で左右の空気がつながる。
    const cls = [...g2.centerLines];
    const vCL = cls.find(c => c.centerLineType === CenterLineType.VERTICAL && c.effectiveValue === 3200);
    const h0 = cls.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.effectiveValue === 0);
    const h1 = cls.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.effectiveValue === 3000);
    g2.setKneeDropWall(`${vCL.id}:${h0.id}:${h1.id}`, { knee: { topHeight: kneeTopMm }, drop: null });
  }
  return buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
}

// 帯の先頭面（A面。xCursor=0・X2は面ローカル3142.5）で、1階天井(-2400)より完全に上にあり、
// かつX2より左に載るプリミティブ。破線（通り芯・壁中心線の一点鎖線）は作図補助なので除く。
const X2_LOCAL = 3142.5;
function aboveCeilLeftOfX2(band) {
  const xs = p => (p.type === 'line' ? [p.x1, p.x2] : p.type === 'dim' ? [p.at, p.at] : [p.x, p.x]);
  const ys = p => (p.type === 'line' ? [p.y1, p.y2] : p.type === 'dim' ? [p.from, p.to] : [p.y, p.y]);
  return band.primitives.filter(p => {
    if (p.dash) return false;
    if (!['line', 'dim', 'text'].includes(p.type)) return false;
    const y = ys(p), x = xs(p);
    if (Math.max(...y) > -CH - 1e-6) return false;          // 1階天井より上に完全に収まるものだけ
    return (x[0] + x[1]) / 2 < X2_LOCAL - 1e-6;             // かつX2より左
  });
}

test('【明示指示・実機「5」A】上下いっぱいの2階壁の向こう（左3200の1階天井より上）には何も描かない', () => {
  const band = makeSplitUpperBand();
  const inside = aboveCeilLeftOfX2(band);
  assert.deepEqual(inside, [],
    `X2の2階壁で分割された左側は「断面の中」なので何も描かない（実際:${JSON.stringify(inside)}）`);
  // 見える側（吹抜け側）は従来どおり: 2F天井断面線が吹抜けの範囲に立つこと。
  const top = band.primitives.filter(p => p.type === 'line' && !p.dash
    && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - (FLOOR_HEIGHT + CH)) < 1e-6
    && (p.x1 + p.x2) / 2 > X2_LOCAL);
  assert.ok(top.length > 0, '吹抜け側の2F天井断面線は残るはず');
});

test('【明示指示・実機「5」A】断面の中には壁の“見えない側”の面も描かない（壁の中は描画対象外）', () => {
  const band = makeSplitUpperBand();
  // X2の2階壁は世界3142.5..3257.5＝面ローカル3085..3200。左の面(3085)は断面の中を向いている。
  const verticalsAt = x => band.primitives.filter(p => p.type === 'line' && !p.dash
    && Math.abs(p.x1 - p.x2) < 1e-6 && Math.abs(p.x1 - x) < 1e-6
    && Math.min(-p.y1, -p.y2) > CH + 1e-6);
  assert.deepEqual(verticalsAt(3085), [], '壁の左（断面の中）側の面は描かない');
  assert.ok(verticalsAt(3200).length > 0, '壁の右（吹抜け＝見える）側の面は描く');
});

test('【明示指示】境界が腰壁なら天端の上で空気がつながるので、その向こうの上階を描く', () => {
  const band = makeSplitUpperBand({ kneeTopMm: 800 });
  const top = band.primitives.filter(p => p.type === 'line' && !p.dash
    && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - (FLOOR_HEIGHT + CH)) < 1e-6
    && (p.x1 + p.x2) / 2 < X2_LOCAL);
  assert.ok(top.length > 0,
    '腰壁越しに見えるので、X2より左にも2F天井断面線が立つはず（可視判定は「壁の有無」ではなく連結性で決まる）');
});

// ================================================================
// 見えがかり壁の面が切断壁で終わる位置（ユーザー実機指摘2026-08「「5」D1: 2階Y1から2000の
// CL左側の腰壁の上から2階天井までの線は、同じCL右側が正解」）。
// 実機「5」の平面をそのまま組む: 1階はL字の1室、2階は手前が吹抜け・奥が壁の無い部屋（アキ）で、
// 境界の通りに天端800の腰壁が立つ。
// ================================================================

function makeKneeBoundaryBand() {
  const cellKey = (g, x0, y0, x1, y1) => [
    clOf(g, CenterLineType.VERTICAL, x0).id, clOf(g, CenterLineType.HORIZONTAL, y0).id,
    clOf(g, CenterLineType.VERTICAL, x1).id, clOf(g, CenterLineType.HORIZONTAL, y1).id].join(':');
  const addRoom = (g, cells, name, feature = null) => {
    const r = g.addRoom(new Set(cells.map(c => cellKey(g, ...c))), name);
    if (feature) r.setFeature(feature);
    generateRoomWallsFromOutline(g, r);
    return r;
  };
  const g1 = makeGraph('1階', 0);
  const room = addRoom(g1, [[-6200, -2000, -3000, -1000], [-3400, -1000, -3000, 0],
    [-3000, -3500, 0, 0]], '5');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = addRoom(g2, [[-3000, -2000, 0, 0]], '吹抜け', RoomFeature.VOID);
  addRoom(g2, [[-8000, -3500, 1000, -2000]], '22');       // 通りx=-3000をまたぐ＝この面は壁が無い
  addRoom(g2, [[-3000, -7000, 0, -3500]], '階段吹抜け');
  for (const y of [-2000, -3500]) {                        // 吹抜けまわりの手すり壁（天端800）
    const h = clOf(g2, CenterLineType.HORIZONTAL, y);
    const a = clOf(g2, CenterLineType.VERTICAL, -3000), b = clOf(g2, CenterLineType.VERTICAL, 0);
    g2.setKneeDropWall(`${h.id}:${a.id}:${b.id}`, { knee: { topHeight: 800 }, drop: null });
  }
  return buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
}

test('【明示指示・実機「5」D1】見えがかり壁の面は、突き当たる腰壁の向こう側の面で終わる', () => {
  const band = makeKneeBoundaryBand();
  const vAt = (z0, z1, weight) => band.primitives.filter(p => p.type === 'line' && !p.dash
    && Math.abs(p.x1 - p.x2) < 1e-6 && p.weight === weight
    && Math.abs(Math.min(-p.y1, -p.y2) - z0) < 1e-6 && Math.abs(Math.max(-p.y1, -p.y2) - z1) < 1e-6)
    .map(p => p.x1).sort((a, b) => a - b);
  // 腰壁の断面（2FL〜天端800）の両縁。手前＝吹抜け側、向こう＝アキ側。
  const capEdges = vAt(FLOOR_HEIGHT, FLOOR_HEIGHT + 800, 'thick');
  assert.ok(capEdges.length >= 2, `腰壁の断面の両縁が出るはず（実際:${JSON.stringify(capEdges)}）`);
  const nearX = capEdges[0], farX = capEdges[1]; // 吹抜けはlo側なので far = 大きい方
  // 腰壁の上から2階天井までの見えがかり線は、**向こう側の面**（＝断面の右縁の続き）に立つ。
  const above = vAt(FLOOR_HEIGHT + 800, FLOOR_HEIGHT + CH, 'medium');
  assert.ok(above.some(x => Math.abs(x - farX) < 1e-6),
    `腰壁の上の縦線は向こう側の面(${farX})に立つはず（実際:${JSON.stringify(above)}）`);
  assert.ok(!above.some(x => Math.abs(x - nearX) < 1e-6),
    `手前の面(${nearX})＝断面の手前の縁から生やしてはいけない（実際:${JSON.stringify(above)}）`);
});


test('【明示指示・実機「5」D1】上階の床の断面線は腰壁の断面の中を通らず、壁の向こう側の面で取り合う', () => {
  const band = makeKneeBoundaryBand();
  const vAt = (z0, z1, weight) => band.primitives.filter(p => p.type === 'line' && !p.dash
    && Math.abs(p.x1 - p.x2) < 1e-6 && p.weight === weight
    && Math.abs(Math.min(-p.y1, -p.y2) - z0) < 1e-6 && Math.abs(Math.max(-p.y1, -p.y2) - z1) < 1e-6)
    .map(p => p.x1).sort((a, b) => a - b);
  const capEdges = vAt(FLOOR_HEIGHT, FLOOR_HEIGHT + 800, 'thick');
  const nearX = capEdges[0], farX = capEdges[1]; // 吹抜けはlo側なので far = 大きい方
  // 上階の床の断面線（2FL）は腰壁の向こう側の面から始まる＝腰壁の断面の中を通らない。
  // 上階の床と、その上に載る腰壁は1つの連続した切断面なので、その内部に線を引いてはいけない。
  const floorLines = band.primitives.filter(p => p.type === 'line' && !p.dash && p.weight === 'thick'
    && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - FLOOR_HEIGHT) < 1e-6
    && Math.min(p.x1, p.x2) > nearX - 500 && Math.min(p.x1, p.x2) < nearX + 500)
    .map(p => Math.min(p.x1, p.x2));
  assert.deepEqual(floorLines, [farX],
    `2FL断面線は腰壁の向こう側の面(${farX})から始まるはず（実際:${JSON.stringify(floorLines)}）`);
  // 小口（1階天井→2FL）は境界のまま＝腰壁の手前の縁と1本の輪郭として続く。
  assert.deepEqual(vAt(CH, FLOOR_HEIGHT, 'thick').filter(x => Math.abs(x - nearX) < 500), [nearX],
    '小口は腰壁の手前の面に立ち、壁の断面の縁とつながる（スラブと壁は一体の切断面）');
});

test('【明示指示・実機「5」D1/B】壁のない端部では上階の天井断面線も同じだけはね出す', () => {
  const cellKey = (g, x0, y0, x1, y1) => [
    clOf(g, CenterLineType.VERTICAL, x0).id, clOf(g, CenterLineType.HORIZONTAL, y0).id,
    clOf(g, CenterLineType.VERTICAL, x1).id, clOf(g, CenterLineType.HORIZONTAL, y1).id].join(':');
  const addRoom = (g, cells, name, feature = null) => {
    const r = g.addRoom(new Set(cells.map(c => cellKey(g, ...c))), name);
    if (feature) r.setFeature(feature);
    generateRoomWallsFromOutline(g, r);
    return r;
  };
  // 上階の天井線のx範囲を、はね出し量を変えて2通り求める。
  const upperCeilSpans = (extendMm) => {
    const g1 = makeGraph('1階', 0);
    const room = addRoom(g1, [[-3000, -3500, 0, 0]], '5');
    // y=-3500の辺の壁を落とす（階段の上り口のように壁が生成されない辺＝面の端が「壁のない端部」）。
    for (const w of [...g1.walls]) {
      if (!w.isVertical && Math.abs(w.axisCL.effectiveValue + 3500) < 1) g1.removeShape(w.id);
    }
    const g2 = makeGraph('2階', FLOOR_HEIGHT);
    const voidRoom = addRoom(g2, [[-3000, -2000, 0, 0]], '吹抜け', RoomFeature.VOID);
    addRoom(g2, [[-8000, -3500, 1000, -2000]], '22'); // 通りをまたぐ＝この面に2階の壁は無い
    addRoom(g2, [[-3000, -7000, 0, -3500]], '階段吹抜け'); // 同じ通りに壁が続く＝上階の平面が存在する
    // 吹抜けの境界は腰壁（天端800）＝天端の上で空気がつながり、その向こうの上階を描く。
    for (const y of [-2000, -3500]) {
      const h = clOf(g2, CenterLineType.HORIZONTAL, y);
      const a = clOf(g2, CenterLineType.VERTICAL, -3000), b = clOf(g2, CenterLineType.VERTICAL, 0);
      g2.setKneeDropWall(`${h.id}:${a.id}:${b.id}`, { knee: { topHeight: 800 }, drop: null });
    }
    const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2,
      { floorHeightAboveMm: FLOOR_HEIGHT, wallLessEndExtendModelMm: extendMm });
    return band.primitives.filter(p => p.type === 'line' && !p.dash
      && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - (FLOOR_HEIGHT + CH)) < 1e-6)
      .map(p => Math.max(p.x1, p.x2) - Math.min(p.x1, p.x2))
      .sort((a, b) => a - b);
  };
  const base = upperCeilSpans(0), ext = upperCeilSpans(150);
  assert.ok(base.length > 0, '上階の天井断面線が出るはず（フィクスチャの前提）');
  assert.equal(ext.length, base.length, 'はね出しで線の本数は変わらない');
  const grown = ext.filter((v, i) => v > base[i] + 1e-6);
  assert.ok(grown.length > 0,
    `壁のない端部を持つ面では上階の天井線が延びるはず（実際:${JSON.stringify(base)}→${JSON.stringify(ext)}）`);
  assert.ok(ext.every((v, i) => Math.abs(v - base[i]) < 1e-6 || Math.abs(v - base[i] - 150) < 1e-6),
    `延びる量は1階の天井線と同じはね出し量(150)のはず（実際:${JSON.stringify(base)}→${JSON.stringify(ext)}）`);
});

test('【明示指示・実機「5」D1】アキのバツは、面を横切る腰壁の向こう側の面から始まる', () => {
  const band = makeKneeBoundaryBand();
  // 腰壁の断面（2FL〜天端800）の両縁。吹抜けはlo側なので far = 大きい方＝アキ側の面。
  const capEdges = band.primitives.filter(p => p.type === 'line' && !p.dash && p.weight === 'thick'
    && Math.abs(p.x1 - p.x2) < 1e-6
    && Math.abs(Math.min(-p.y1, -p.y2) - FLOOR_HEIGHT) < 1e-6
    && Math.abs(Math.max(-p.y1, -p.y2) - (FLOOR_HEIGHT + 800)) < 1e-6)
    .map(p => p.x1).sort((a, b) => a - b);
  const nearX = capEdges[0], farX = capEdges[1];
  // その腰壁のすぐ右にあるバツ（対角線2本）。
  const diagonals = band.primitives.filter(p => p.type === 'line' && p.dash
    && Math.abs(p.x1 - p.x2) > 1e-6 && Math.abs(p.y1 - p.y2) > 1e-6
    && Math.min(p.x1, p.x2) > nearX - 200 && Math.min(p.x1, p.x2) < nearX + 400);
  assert.equal(diagonals.length, 2, `バツは対角線2本（実際:${diagonals.length}本）`);
  for (const d of diagonals) {
    assert.ok(Math.abs(Math.min(d.x1, d.x2) - farX) < 1e-6,
      `バツは腰壁の向こう側の面(${farX})から始まるはず——手前の縁(${nearX})から生やすと` +
      `断面の厚みの中にバツが入る（実際:${Math.min(d.x1, d.x2)}）`);
  }
  // 端点は上階の床〜天井の全高（腰壁の天端で切り上がらない）。
  const zs = diagonals.flatMap(d => [Math.min(-d.y1, -d.y2), Math.max(-d.y1, -d.y2)]);
  assert.ok(zs.every(z => Math.abs(z - FLOOR_HEIGHT) < 1e-6 || Math.abs(z - (FLOOR_HEIGHT + CH)) < 1e-6),
    `バツの端点は2FL(${FLOOR_HEIGHT})と2階天井(${FLOOR_HEIGHT + CH})のはず（実際:${JSON.stringify(zs)}）`);
});

test('【明示指示・実機「5」B】アキに面する腰壁の断面の縁は、天端から2階天井まで見えがかりで続く', () => {
  const band = makeKneeBoundaryBand();
  const V = (z0, z1, w) => band.primitives.filter(p => p.type === 'line' && !p.dash && p.weight === w
    && Math.abs(p.x1 - p.x2) < 1e-6
    && Math.abs(Math.min(-p.y1, -p.y2) - z0) < 1e-6 && Math.abs(Math.max(-p.y1, -p.y2) - z1) < 1e-6)
    .map(p => p.x1).sort((a, b) => a - b);
  const capEdges = V(FLOOR_HEIGHT, FLOOR_HEIGHT + 800, 'thick'); // 腰壁の断面の両縁（2枚ぶん）
  assert.equal(capEdges.length, 4, `腰壁2枚ぶんの断面の縁が出るはず（実際:${JSON.stringify(capEdges)}）`);
  const walls = [[capEdges[0], capEdges[1]], [capEdges[2], capEdges[3]]];
  const ends = V(FLOOR_HEIGHT + 800, FLOOR_HEIGHT + CH, 'medium'); // 天端→2階天井の見えがかり
  assert.equal(ends.length, 2,
    `アキに面する腰壁ごとに1本ずつ出るはず（実際:${JSON.stringify(ends)}）`);
  for (const [a, b] of walls) {
    const hit = ends.filter(x => Math.abs(x - a) < 1e-6 || Math.abs(x - b) < 1e-6);
    assert.equal(hit.length, 1,
      `腰壁(${a}..${b})の**片側の縁**にだけ立つはず——両側に出れば壁厚が図に出る、` +
      `出なければアキの端で壁面の終わりが読めない（実際:${JSON.stringify(ends)}）`);
  }
});

test('【明示指示・実機「5」D1/B1】巾木は壁のない端部で床線と同じだけはね出す（CLで止めない）', () => {
  const cellKey = (g, x0, y0, x1, y1) => [
    clOf(g, CenterLineType.VERTICAL, x0).id, clOf(g, CenterLineType.HORIZONTAL, y0).id,
    clOf(g, CenterLineType.VERTICAL, x1).id, clOf(g, CenterLineType.HORIZONTAL, y1).id].join(':');
  const g1 = makeGraph('1階', 0);
  const room = g1.addRoom(new Set([cellKey(g1, -3000, -3500, 0, 0)]), '5');
  room.finish.setField('baseboardHeight', 'h=60');
  generateRoomWallsFromOutline(g1, room);
  // y=-3500の辺の壁を落とす＝その端が「壁のない端部」になる。
  for (const w of [...g1.walls]) {
    if (!w.isVertical && Math.abs(w.axisCL.effectiveValue + 3500) < 1) g1.removeShape(w.id);
  }
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = g2.addRoom(new Set([cellKey(g2, -3000, -2000, 0, 0)]), '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  generateRoomWallsFromOutline(g2, voidRoom);
  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2,
    { floorHeightAboveMm: FLOOR_HEIGHT, wallLessEndExtendModelMm: 150 });
  const spans = z => band.primitives.filter(p => p.type === 'line' && !p.dash
    && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - z) < 1e-6)
    .map(p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]);
  const ends = ls => [Math.min(...ls.map(l => l[0])), Math.max(...ls.map(l => l[1]))];
  const floor = spans(0), base = spans(60);
  assert.ok(floor.length > 0 && base.length > 0, '床線と巾木の両方が出るはず（フィクスチャの前提）');
  assert.deepEqual(ends(base), ends(floor),
    `巾木の端は床線の端と揃うはず——CLで止めると、はね出した床線との間に段が付く` +
    `（床線:${JSON.stringify(ends(floor))} / 巾木:${JSON.stringify(ends(base))}）`);
});

test('【明示指示・実機「5」A】上階の天井高寸法は、その端に上階の断面がある面の左に立つ', () => {
  const band = makeKneeBoundaryBand();
  const vdims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'v');
  const upper = vdims.filter(p => Math.abs(-p.to - FLOOR_HEIGHT) < 1e-6
    && Math.abs(-p.from - (FLOOR_HEIGHT + CH)) < 1e-6);
  assert.equal(upper.length, 1, `上階の天井高寸法は帯に1本（実際:${upper.length}本）`);
  // このフィクスチャの先頭面は、左端が1階天井で閉じている（その上は「断面の中」で何も描かない）
  // ——そこへ2階の天井高を書くと、図中に該当する断面が無い寸法になる。
  const bandLeftX = Math.min(...vdims.map(p => p.at));
  assert.notEqual(upper[0].at, bandLeftX,
    `先頭面の左(${bandLeftX})には上階の断面が無いので、そこへは立てない`);
  // 同じxの他のCH寸法とz範囲が重ならない（左端が吹抜けの面は自身の寸法が1FL〜2階天井を測る）。
  for (const d of vdims) {
    if (d === upper[0] || Math.abs(d.at - upper[0].at) > 1e-6) continue;
    const overlap = Math.min(-d.from, -upper[0].from) - Math.max(-d.to, -upper[0].to);
    assert.ok(overlap <= 1e-6,
      `同じx(${d.at})の寸法とz範囲が重なってはいけない（相手:${-d.to}..${-d.from}）`);
  }
});

test('【明示指示】見えがかりの奥行きは「最も近い壁から800未満」——それ以上奥はアキ', () => {
  const band = makeKneeBoundaryBand();
  // D1相当の面（平面X=-3000・西を見る）: 面ローカル0..1000の先には400奥の壁(x=-3400)、
  // 1000..1885の先には3200奥の壁(x=-6200)がある。面自身の壁面までが58なので
  // 400-58<800（見えがかり）／3200-58>=800（アキ）。
  const diag = band.primitives.filter(p => p.type === 'line' && p.dash
    && Math.abs(p.x1 - p.x2) > 1e-6 && Math.abs(p.y1 - p.y2) > 1e-6);
  const gapAt = (x0, x1) => diag.filter(d => Math.abs(Math.min(d.x1, d.x2) - x0) < 1e-6
    && Math.abs(Math.max(d.x1, d.x2) - x1) < 1e-6);
  assert.equal(gapAt(7900, 8785).length, 2,
    `3200奥の区間はアキ（バツ2本）になるはず（実際:${JSON.stringify(diag.map(d => [d.x1, d.x2]))}）`);
  const thinV = band.primitives.filter(p => p.type === 'line' && !p.dash && p.weight === 'thin'
    && Math.abs(p.x1 - p.x2) < 1e-6).map(p => p.x1);
  assert.ok(thinV.some(x => Math.abs(x - 7900) < 1e-6),
    `400奥の壁は見えがかりとして残り、その端(7900)に細線の縦線が立つはず（実際:${JSON.stringify(thinV)}）`);
});

test('【明示指示・実機「5」D1】壁の無い区間では、向こう側の1階天井が中線の見えがかりとして出る', () => {
  const cellKey = (g, x0, y0, x1, y1) => [
    clOf(g, CenterLineType.VERTICAL, x0).id, clOf(g, CenterLineType.HORIZONTAL, y0).id,
    clOf(g, CenterLineType.VERTICAL, x1).id, clOf(g, CenterLineType.HORIZONTAL, y1).id].join(':');
  const addRoom = (g, cells, name, feature = null) => {
    const r = g.addRoom(new Set(cells.map(c => cellKey(g, ...c))), name);
    if (feature) r.setFeature(feature);
    generateRoomWallsFromOutline(g, r);
    return r;
  };
  const g1 = makeGraph('1階', 0);
  // 実機「5」のL字: 面の平面(x=-3000)には y-2000..0 の区間に壁が無く、その先は同じ部屋が続く。
  const room = addRoom(g1, [[-6200, -2000, -3000, -1000], [-3400, -1000, -3000, 0],
    [-3000, -3500, 0, 0]], '5');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = addRoom(g2, [[-3000, -2000, 0, 0]], '吹抜け', RoomFeature.VOID);
  addRoom(g2, [[-8000, -3500, 1000, -2000]], '22');
  addRoom(g2, [[-3000, -7000, 0, -3500]], '階段吹抜け');
  // **壁の無い区間の「向こう側」の真上には実部屋がある**——だからその空間は1階天井で閉じる。
  addRoom(g2, [[-5600, -2000, -3000, 0]], '24');
  addRoom(g2, [[-8000, -2000, -5600, 0]], '23');
  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2,
    { floorHeightAboveMm: FLOOR_HEIGHT, wallLessEndExtendModelMm: 150 });
  const at2400 = band.primitives.filter(p => p.type === 'line' && !p.dash
    && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - CH) < 1e-6)
    .map(p => ({ x0: Math.min(p.x1, p.x2), x1: Math.max(p.x1, p.x2), w: p.weight }))
    .sort((a, b) => a.x0 - b.x0);
  // 天井は切断面のすぐ手前から奥へ広がる面で、その縁までの奥行きは0＝最も近い面と同格なので
  // **中線**（ユーザー明示指示2026-08「最も近い壁（=主な描画対象）と同じ面のエッジなので中線」）。
  const sight = at2400.filter(l => l.w === 'medium');
  const cut = at2400.filter(l => l.w === 'thick');
  assert.ok(sight.length > 0, `1階天井の見えがかり（中線）が出るはず（実際:${JSON.stringify(at2400)}）`);
  assert.equal(at2400.filter(l => l.w === 'thin').length, 0,
    `天井の見えがかりに細線は使わない（実際:${JSON.stringify(at2400)}）`);
  assert.ok(cut.length > 0, '1階天井の断面（太線）も出るはず（フィクスチャの前提）');
  // 見えがかりは断面に突き当たって終わる＝中線の右端と太線の左端が一致する組がある。
  assert.ok(sight.some(t => cut.some(c => Math.abs(t.x1 - c.x0) < 1e-6)),
    `見えがかりの天井線は1階天井断面に突き当たって終わるはず（中線:${JSON.stringify(sight)} / 断面:${JSON.stringify(cut)}）`);
  // 天井裏（天井〜上階FL）は天井に隠れるので、そこに見えがかりの縦線は残らない。
  const above = band.primitives.filter(p => p.type === 'line' && !p.dash && p.weight === 'thin'
    && Math.abs(p.x1 - p.x2) < 1e-6
    && Math.min(-p.y1, -p.y2) > CH + 1e-6 && Math.max(-p.y1, -p.y2) < FLOOR_HEIGHT - 1e-6);
  assert.deepEqual(above, [], '天井裏（天井〜上階FL）は天井に隠れて見えない');
});

test('【明示指示・実機「5」D1】壁の無い区間の寸法は、見えがかりの奥行きが変わる位置で割れる', () => {
  const band = makeKneeBoundaryBand();
  const hdims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'h')
    .map(p => ({ lo: Math.min(p.from, p.to), hi: Math.max(p.from, p.to), label: p.label }))
    .sort((a, b) => a.lo - b.lo);
  // D1相当の面: Y1(=6842.5)から2000の区間は、面ローカル1000の位置で見えがかりの奥行きが
  // 変わる（400奥の壁がそこで終わる）。図にはその位置に見えがかりの縦線が立つので、寸法も
  // 1000+1000へ割れるのが正（2000の1本ではない）。割る位置は壁の実体の端ではなく**中心線**。
  const pair = hdims.filter(d => d.lo >= 6842.5 - 1e-6 && d.hi <= 8842.5 + 1e-6);
  assert.deepEqual(pair.map(d => d.label), [1000, 1000],
    `見えがかりに合わせて1000+1000へ割れるはず（実際:${JSON.stringify(pair)}）`);
  assert.ok(Math.abs(pair[0].hi - 7842.5) < 1e-6,
    `割る位置は壁の端(7900)ではなく中心線(7842.5)のはず（実際:${pair[0].hi}）`);
  // 面に自壁がある区間（D1の右1500）は見えがかりが存在しないので割れない。
  const right = hdims.find(d => Math.abs(d.lo - 8842.5) < 1e-6);
  assert.equal(right?.label, 1500, `自壁のある区間は1本のまま（実際:${JSON.stringify(right)}）`);
});
