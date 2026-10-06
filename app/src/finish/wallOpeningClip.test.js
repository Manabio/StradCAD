// 階段の開口の区間切り（wallGeneration.js clipEdgeParamsByOpenings）で切った壁の端の扱いの回帰テスト。
// 切った端は隅ではない: 出隅の補修（closeConvexCorners。仕上げ脱出・読込み時の _healDerivedGeometry）が
// 伸ばし戻さない／clipToAxisExtent は切った座標で軸の区間と比べる／divider をまたぐ開口の2本を結合しない／
// 柱包み（wrapFreeEnds）の自由端のはね出しは切った座標から。壁生成の単体（stairOpenings を直接渡す）で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph, Plane, CenterLineType, Discipline, RoomKind } from '@core';
import {
  generateExteriorWalls, generateRoomWallsFromOutline, closeConvexCorners, clipEdgeParamsByOpenings,
  computeExternalEdgeParams,
} from './wallGeneration.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const BASE = 120, FINISH = 12.5, OFFSET = BASE / 2 + FINISH; // 72.5
const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;
const round = (v) => Math.round(v * 1000) / 1000;

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}
// 水平の壁（軸が y≒value）の [lo, hi] を昇順で
function hWalls(graph, y, { exterior = null } = {}) {
  return graph.walls
    .filter(w => !w.isVertical && Math.abs(w.axisValue - y) < 200 && (exterior == null || !!w.isExteriorWall === exterior))
    .map(w => [round(Math.min(w.coord1, w.coord2)), round(Math.max(w.coord1, w.coord2))])
    .sort((a, b) => a[0] - b[0]);
}

// 3000×3000 の屋内部屋 A と、その北（y -3000..0）の屋外部屋 B（中庭）。A の北辺（y=0）が courtyard
function courtyardFixture({ topExtent = null, dividerX = null } = {}) {
  const g = makeGraph();
  const x0 = g.addCenterLine(V, 0, ARCH), x3 = g.addCenterLine(V, 3000, ARCH);
  const yN = g.addCenterLine(H, -3000, ARCH), y0 = g.addCenterLine(H, 0, { ...ARCH, ...(topExtent ?? {}) });
  const y3 = g.addCenterLine(H, 3000, ARCH);
  const xd = dividerX != null ? g.addCenterLine(V, dividerX, ARCH) : null;
  const a = xd
    ? [`${x0.id}:${y0.id}:${xd.id}:${y3.id}`, `${xd.id}:${y0.id}:${x3.id}:${y3.id}`]
    : [`${x0.id}:${y0.id}:${x3.id}:${y3.id}`];
  g.addRoom(new Set(a), 'A');
  const b = g.addRoom(new Set([`${x0.id}:${yN.id}:${x3.id}:${y0.id}`]), '庭');
  b.setKind(RoomKind.EXTERIOR);
  return { g, x0, x3, y0, y3 };
}
const topOpening = (lo, hi) => ({ isVertical: false, value: 0, lo, hi });

test('Major-A【courtyard・開口が中央】開口で切った壁の端は、出隅の補修（closeConvexCorners）で隅まで伸ばし戻されない（脱出境界・読込み時の補修後も 0..1000・2000..3000 だけ）', () => {
  const { g } = courtyardFixture();
  generateExteriorWalls(g, { wallBase: BASE, wallFinish: FINISH }, [topOpening(1000, 2000)]);
  const before = hWalls(g, 0, { exterior: true });
  assert.equal(before.length, 2, '前提: 開口の両側の2本');
  assert.ok(before[0][1] <= 1000 + 1e-6 && before[1][0] >= 2000 - 1e-6, '前提: 開口の区間に壁がない');
  closeConvexCorners([...g.walls]); // 仕上げ脱出・読込み時の _healDerivedGeometry と同じ補修
  const after = hWalls(g, 0, { exterior: true });
  // 外側の隅（0・3000）の端は出隅として閉じてよい（補修の本来の仕事）。開口で切った端（1000・2000）は動かない
  assert.equal(after.length, 2);
  assert.equal(after[0][1], 1000, '左の壁の切った端は 1000 のまま');
  assert.equal(after[1][0], 2000, '右の壁の切った端は 2000 のまま');
  assert.equal(closeConvexCorners([...g.walls]), 0, '冪等');
});

test('Major-A【開口が出隅の近く（隅から 100mm）】補修が伸ばす向き（出隅側）に切った端が来る配置でも、距離の閾値で隅と取り違えず切った端を動かさない', () => {
  // 北辺（y=0）の右端 x 2900..3000 が開口: 残る壁 0..2900 の切った端（2900）は、右の出隅（x=3000。外壁の右の壁と組む）まで 100mm
  const right = courtyardFixture();
  generateExteriorWalls(right.g, { wallBase: BASE, wallFinish: FINISH }, [topOpening(2900, 3000)]);
  closeConvexCorners([...right.g.walls]);
  const r = hWalls(right.g, 0, { exterior: true });
  assert.equal(r.length, 1);
  assert.equal(r[0][1], 2900, '右の切った端（隅まで 100mm）は 2900 のまま');
  // 左の端 x 0..100 が開口: 残る壁 100..3000 の切った端（100）は、左の出隅（x=0）まで 100mm
  const left = courtyardFixture();
  generateExteriorWalls(left.g, { wallBase: BASE, wallFinish: FINISH }, [topOpening(0, 100)]);
  closeConvexCorners([...left.g.walls]);
  const l = hWalls(left.g, 0, { exterior: true });
  assert.equal(l.length, 1);
  assert.equal(l[0][0], 100, '左の切った端（隅まで 100mm）は 100 のまま');
});

test('Major-B【軸の区間が辺の途中で終わる】軸CLの区間が x 1000.. の辺では、開口で切った後の壁は区間の外（x<1000）へ出ない（壁の始点 ≥ 1000）', () => {
  const { g } = courtyardFixture({ topExtent: { extentLo: 1000, extentHi: 4000 } });
  generateExteriorWalls(g, { wallBase: BASE, wallFinish: FINISH }, [topOpening(1000, 2000)]);
  const walls = hWalls(g, 0, { exterior: true });
  assert.ok(walls.length >= 1, '前提: 開口の右側（2000..3000）の壁がある');
  for (const [lo] of walls) assert.ok(lo >= 1000 - 1e-6, `壁の始点は 1000 以上（実測 ${lo}）`);
  assert.equal(walls.length, 1, '開口の左側（0..1000）は軸の区間の外なので壁を作らない（開口へ入り込む壁も、二重の壁も無い）');
});

test('divider をまたぐ開口: 辺が divider で2つに分かれていても、開口で切った2本の壁は1本に結合されない（開口の区間は空いたまま）', () => {
  const { g } = courtyardFixture({ dividerX: 1500 });
  generateExteriorWalls(g, { wallBase: BASE, wallFinish: FINISH }, [topOpening(1000, 2000)]);
  const walls = hWalls(g, 0, { exterior: true });
  assert.equal(walls.length, 2, '2本（結合すると 0..3000 の1本になり開口を塞ぐ）');
  assert.ok(walls[0][1] <= 1000 + 1e-6 && walls[1][0] >= 2000 - 1e-6);
});

test('開口が辺の始端を覆う: 残りの区間の壁は開口の端から始まり、直交する壁は隅のはね出しを持たず開口の線で止まる', () => {
  const g = makeGraph();
  const x0 = g.addCenterLine(V, 0, ARCH), x3 = g.addCenterLine(V, 3000, ARCH);
  const y0 = g.addCenterLine(H, 0, ARCH), y3 = g.addCenterLine(H, 3000, ARCH);
  const room = g.addRoom(new Set([`${x0.id}:${y0.id}:${x3.id}:${y3.id}`]), 'A');
  const walls = generateRoomWallsFromOutline(g, room, { wallBase: BASE, wallFinish: FINISH }, [topOpening(0, 1000)]);
  const top = hWalls(g, 0);
  assert.equal(top.length, 1);
  assert.equal(top[0][0], 1000, '上辺の壁は開口の端（x=1000）から');
  const left = walls.find(w => w.isVertical && Math.abs(w.axisValue - 0) < 200);
  // 左の壁の上端（y 小さい側）は開口の線 y=0 ちょうど（上辺の壁が無いので隅のはね出しを持たない）
  assert.equal(round(Math.min(left.coord1, left.coord2)), 0, '直交する壁が開口の線まで届く（はね出さない）');
});

for (const wrap of [false, true]) {
  test(`柱包み wrapFreeEnds=${wrap}【開口が中央】開口で切った端のはね出し量: ${wrap ? '自由端として開口側へ壁厚の半分＋仕上げ厚（72.5）' : 'なし（切った座標ちょうど）'}`, () => {
    const { g } = courtyardFixture();
    generateExteriorWalls(g, { wallBase: BASE, wallFinish: FINISH, wrapFreeEnds: wrap }, [topOpening(1000, 2000)]);
    const walls = hWalls(g, 0, { exterior: true });
    assert.equal(walls.length, 2);
    const protrusion = wrap ? OFFSET : 0;
    assert.equal(walls[0][1], round(1000 + protrusion), '左の壁の開口側の端');
    assert.equal(walls[1][0], round(2000 - protrusion), '右の壁の開口側の端');
  });
}

test('clipEdgeParamsByOpenings: 開口と重ならない辺は同一オブジェクト・全部重なる辺は返さない・一部は clipStart/clipEnd 付きで分かれる・端の違う軸の開口は無視', () => {
  const { g } = courtyardFixture();
  const room = g.rooms.find(r => r.name === 'A');
  const params = computeExternalEdgeParams(room, 1, g);
  const top = params.filter(p => !p.isVertical && g.shapeMap.get(p.axisCLId).value === 0);
  assert.equal(top.length, 1);
  assert.deepEqual(clipEdgeParamsByOpenings(top, g, [{ isVertical: false, value: 5000, lo: 0, hi: 3000 }]), top, '別の軸の開口は無視');
  assert.equal(clipEdgeParamsByOpenings(top, g, [topOpening(-100, 3100)]).length, 0, '全部重なれば辺ごと除外');
  const cut = clipEdgeParamsByOpenings(top, g, [topOpening(1000, 2000)]);
  assert.deepEqual(cut.map(p => [p.clipStart ?? null, p.clipEnd ?? null]), [[null, 1000], [2000, null]]);
});
