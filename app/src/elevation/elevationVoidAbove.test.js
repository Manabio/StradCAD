// buildRoomBandWithVoidAbove（上部吹抜けの多層書き。ユーザー明示指示2026-08）のテスト。
// 「吹抜けの展開は床断面のある階に」「上部吹抜けが落ちている部屋の展開と一緒に多層書き」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomBandWithVoidAbove } from './elevationVoid.js';

const CH = 2400;
const FLOOR_HEIGHT = 3000;

function makeGraph(name, elevation) {
  return new PlanGraph(new Plane(name, elevation, name, 1, 1));
}
function makeRectRoom(graph, x0v, y0v, x1v, y1v, name) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
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
function makeHalfVoidBand() {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  const voidRoom = makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
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

test('【実機「5」A】buildRoomBandWithVoidAbove: 天井の高さが変わる境界に立つ2階の壁が、1F天井から2F天井まで断面として出る', () => {
  const band = makeHalfVoidBand();
  const edges = vLines(band).filter(p => p.__o === 'cutEdgeLo' || p.__o === 'cutEdgeHi');
  assert.ok(edges.length >= 2, `境界の壁の断面（壁厚の両縁）が出るはず（実際:${JSON.stringify(edges)}）`);
  for (const p of edges) {
    assert.equal(p.weight, 'thick', '壁の断面の縁は太線(CUT)');
    assert.equal(Math.min(-p.y1, -p.y2), CH, '低い側の天井（1F天井）から始まるはず——壁の実体は2FLからだが、その間は上階の床構造で断面は連続する');
    assert.equal(Math.max(-p.y1, -p.y2), FLOOR_HEIGHT + CH, '高い側の天井（2F天井）まで');
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
