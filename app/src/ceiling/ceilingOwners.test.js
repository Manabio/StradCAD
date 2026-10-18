// ceilingOwners.js（天井セルの所属索引）の吹抜け（VOID）セルの所属の単体テスト。実物の PlanGraph / Room / Wall で組む。
// 規則（裁定 2026-10-17）: 吹抜けのセルは、全高の壁（腰壁だけの壁は除く）で隔てられていない隣接部屋のうち面積最大の部屋の所属になる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, RoomKind, edgeKey } from '@core';
import { buildCeilingCellOwners, wallFullHeightSpans } from './ceilingOwners.js';
import { ceilingSurfacesOf } from './ceilingSurfaces.js';
import { ceilingGroupsOf } from './ceilingGroups.js';
import { makeGrid, assignZoneHeight } from '../plan/planTestFixtures.js';

/** x 方向に A | 吹抜け | B を並べた階。A・B の幅で面積の大小を作る。cell(i,0): A=0, 吹抜け=1, B=2。 */
function layout(widthA, widthB, { voidCols = 1 } = {}) {
  const xs = [0, widthA, widthA + 1000];
  for (let i = 1; i < voidCols; i++) xs.push(xs[xs.length - 1] + 1000);
  xs.push(xs[xs.length - 1] + widthB);
  const g = makeGrid(xs, [0, 1000]);
  const bIndex = xs.length - 2;
  const a = g.interior([[0, 0]]);
  const b = g.interior([[bIndex, 0]]);
  const v = g.feature(Array.from({ length: voidCols }, (_, k) => [1 + k, 0]), RoomFeature.VOID);
  return { g, a, b, v, bIndex };
}

/** 縦の壁（x = cx[i]）。knee/drop を渡すとその区間に腰壁・垂れ壁の指定を付ける。 */
function wallAt(g, i, { knee = null, drop = null } = {}) {
  const axis = g.cx[i];
  const w = g.graph.addWall(axis, 0, true, g.cy[0], 0, g.cy[1], 0, {});
  if (knee != null || drop != null) {
    g.graph.setKneeDropWall(edgeKey(axis.id, g.cy[0].id, g.cy[1].id), {
      knee: knee != null ? { topHeight: knee } : null,
      drop: drop != null ? { bottomHeight: drop } : null,
    });
  }
  return w;
}

const ownerOf = (g, i) => buildCeilingCellOwners(g.graph).get(g.cell(i, 0));

test('吹抜け: 壁が無ければ隣接部屋のうち面積最大の部屋の所属になる。面積を入れ替えると所属も入れ替わる', () => {
  const big = layout(3000, 1000);
  assert.deepEqual(ownerOf(big.g, 1), { kind: 'room', id: big.a.id, rowId: big.a.id });
  const swapped = layout(1000, 3000);
  assert.deepEqual(ownerOf(swapped.g, 1), { kind: 'room', id: swapped.b.id, rowId: swapped.b.id });
});

test('吹抜け: 腰壁だけで接する隣接部屋は候補になる（腰壁は天井を隔てない）。面積最大の部屋の所属', () => {
  const { g, a } = layout(3000, 1000);
  wallAt(g, 1, { knee: 800 }); // A | 吹抜け
  wallAt(g, 2, { knee: 800 }); // 吹抜け | B
  assert.equal(ownerOf(g, 1).id, a.id);
  const sw = layout(1000, 3000);
  wallAt(sw.g, 1, { knee: 800 });
  wallAt(sw.g, 2, { knee: 800 });
  assert.equal(ownerOf(sw.g, 1).id, sw.b.id);
});

test('吹抜け: 全高の壁で隔てられた部屋は候補にならない（面積が大きくても小さい方に付く）', () => {
  const { g, b } = layout(3000, 1000);
  wallAt(g, 1); // A | 吹抜け: 全高
  assert.equal(ownerOf(g, 1).id, b.id);
});

test('吹抜け: 垂れ壁（drop）で隔てられた部屋は候補にならない。腰壁＋垂れ壁の同時指定も隔てる', () => {
  const { g, b } = layout(3000, 1000);
  wallAt(g, 1, { drop: 600 });
  assert.equal(ownerOf(g, 1).id, b.id);
  const both = layout(3000, 1000);
  wallAt(both.g, 1, { knee: 800, drop: 600 });
  assert.equal(ownerOf(both.g, 1).id, both.b.id);
});

test('吹抜け: 隣接部屋がすべて全高の壁で隔てられる・隣接部屋が無ければ索引外（従来どおり）', () => {
  const { g } = layout(3000, 1000);
  wallAt(g, 1);
  wallAt(g, 2);
  assert.equal(ownerOf(g, 1), undefined);
  const lone = makeGrid([0, 1000], [0, 1000]);
  lone.feature([[0, 0]], RoomFeature.VOID);
  assert.equal(buildCeilingCellOwners(lone.graph).size, 0);
});

test('吹抜け: 複数セルでも 1 単位で同じ部屋へ（セルごとに隣が違っても面積最大の 1 部屋）', () => {
  const { g, a } = layout(3000, 1000, { voidCols: 2 }); // A | v1 | v2 | B
  const owners = buildCeilingCellOwners(g.graph);
  assert.equal(owners.get(g.cell(1, 0)).id, a.id);
  assert.equal(owners.get(g.cell(2, 0)).id, a.id, '2 つ目のセルは A に接さないが吹抜け 1 単位として A');
});

test('吹抜け: 階段吹抜け（STAIR_VOID）は従来どおり索引外', () => {
  const xs = [0, 2000, 3000, 4000];
  const g = makeGrid(xs, [0, 1000]);
  g.interior([[0, 0]]);
  g.feature([[1, 0]], RoomFeature.STAIR_VOID);
  g.interior([[2, 0]]);
  assert.equal(buildCeilingCellOwners(g.graph).has(g.cell(1, 0)), false);
});

test('面・群: 吹抜けを含む部屋の天井面は 1 面で、面のキー集合＝群のセル。吹抜け部屋自体の面は出ない', () => {
  const { g, a, v } = layout(3000, 1000);
  wallAt(g, 1, { knee: 800 });
  const faces = ceilingSurfacesOf(g.graph);
  assert.equal(faces.some(f => f.roomId === v.id), false);
  const face = faces.find(f => f.roomId === a.id);
  assert.equal(faces.filter(f => f.roomId === a.id).length, 1);
  assert.equal(face.rects.length, 2, 'A のセル＋吹抜けのセル');
  const owners = buildCeilingCellOwners(g.graph);
  const { groups } = ceilingGroupsOf(g.graph, owners);
  const cells = groups.get(`room:${a.id}`).cells;
  assert.deepEqual([...cells].sort(), [g.cell(0, 0), g.cell(1, 0)].sort());
  assert.equal(cells.size, face.rects.length, '面の矩形数＝群のセル数');
});

test('区画: 吹抜けのセルを含む区画は所属の部屋の区画の面・zone 群になる（面のキー集合＝zone 群のセル。区画の cells は通常のセルキー）', () => {
  const { g, a } = layout(3000, 1000);
  wallAt(g, 1, { knee: 800 });
  const zones = assignZoneHeight(g.graph, a, [g.cell(1, 0)], 2100);
  a.setCeilingZones(zones);
  const owners = buildCeilingCellOwners(g.graph);
  const { groups } = ceilingGroupsOf(g.graph, owners);
  const zoneGroup = [...groups.values()].find(x => x.kind === 'zone');
  assert.deepEqual([...zoneGroup.cells], [g.cell(1, 0)]);
  const zoneFace = ceilingSurfacesOf(g.graph).find(f => f.zoneId != null);
  assert.equal(zoneFace.zMm, 2100);
  assert.equal(zoneFace.rects.length, zoneGroup.cells.size);
  assert.equal(groups.get(`room:${a.id}`).cells.size, 1, '残りは A 自身のセルだけ');
});

// ---- 壁の区間別判定・部分被覆・水平の辺 ----
const KNEE = { knee: { topHeight: 800 }, drop: null };
const DROP = { knee: null, drop: { bottomHeight: 600 } };
const setRec = (g, axis, s, e, rec) => g.graph.setKneeDropWall(edgeKey(axis.id, s.id, e.id), rec);

/** 縦に 2 行（ys 0..1000..2000）。A=左の 2 セル(6000000mm2)・吹抜け(1,0)・B=(2,0)。吹抜けに接する A の辺は y0..1000 だけ。 */
function tallLayout() {
  const g = makeGrid([0, 3000, 4000, 5000], [0, 1000, 2000]);
  const a = g.interior([[0, 0], [0, 1]]);
  const b = g.interior([[2, 0]]);
  g.feature([[1, 0]], RoomFeature.VOID);
  return { g, a, b };
}

test('区間別: 1 本の壁の吹抜けに接しない区間だけ腰壁・接する区間は全高 → 隔てる（B）', () => {
  const { g, b } = tallLayout();
  g.graph.addWall(g.cx[1], 0, true, g.cy[0], 0, g.cy[2], 0, {});
  setRec(g, g.cx[1], g.cy[1], g.cy[2], KNEE);
  assert.equal(ownerOf(g, 1).id, b.id);
});

test('区間別: 接する区間が腰壁・他の区間が垂れ壁 → 隔てない（A）。指定の並び順に依らない', () => {
  for (const order of [0, 1]) {
    const { g, a } = tallLayout();
    g.graph.addWall(g.cx[1], 0, true, g.cy[0], 0, g.cy[2], 0, {});
    const recs = [() => setRec(g, g.cx[1], g.cy[1], g.cy[2], DROP), () => setRec(g, g.cx[1], g.cy[0], g.cy[1], KNEE)];
    if (order) recs.reverse();
    recs.forEach(f => f());
    assert.equal(ownerOf(g, 1).id, a.id, `order ${order}`);
  }
});

test('部分被覆: 辺 2000 に全高の袖壁 300 だけ（すき間 1700）→ 隔てない（A）。半壁厚 57.5 を両端に残す壁は隔てる（B）', () => {
  const part = makeGrid([0, 3000, 4000, 5000], [0, 2000]);
  const a = part.interior([[0, 0]]);
  const b = part.interior([[2, 0]]);
  part.feature([[1, 0]], RoomFeature.VOID);
  part.graph.addWall(part.cx[1], 0, true, part.cy[0], 0, part.cy[1], -1700, {});
  assert.equal(ownerOf(part, 1).id, a.id);
  const full = makeGrid([0, 3000, 4000, 5000], [0, 2000]);
  full.interior([[0, 0]]);
  const b2 = full.interior([[2, 0]]);
  full.feature([[1, 0]], RoomFeature.VOID);
  full.graph.addWall(full.cx[1], 0, true, full.cy[0], 57.5, full.cy[1], -57.5, {});
  assert.equal(ownerOf(full, 1).id, b2.id);
  assert.ok(b);
});

test('隅の食い込み: 同じ軸の隣の辺から 57.5 だけ食い込む壁は辺を隔てない（A）', () => {
  const { g, a } = tallLayout();
  g.graph.addWall(g.cx[1], 0, true, g.cy[0], -1000, g.cy[0], 57.5, {});
  assert.equal(ownerOf(g, 1).id, a.id);
});

test('同面積なら graph.rooms の順の先勝ち（A 先なら A、B を先に並べれば B）', () => {
  const { g, a, b } = layout(2000, 2000);
  assert.equal(ownerOf(g, 1).id, a.id);
  const sw = layout(2000, 2000);
  sw.g.graph.reorderRooms([sw.b.id, sw.a.id, sw.v.id]);
  assert.equal(ownerOf(sw.g, 1).id, sw.b.id);
  assert.ok(b);
});

test('水平の辺（上下の部屋）: 全高の壁なら反対側、腰壁なら面積最大', () => {
  const build = rec => {
    const g = makeGrid([0, 1000], [0, 3000, 4000, 5000]);
    const top = g.interior([[0, 0]]);
    g.feature([[0, 1]], RoomFeature.VOID);
    const bottom = g.interior([[0, 2]]);
    g.graph.addWall(g.cy[1], 0, false, g.cx[0], 0, g.cx[1], 0, {});
    if (rec) setRec(g, g.cy[1], g.cx[0], g.cx[1], rec);
    return { owner: buildCeilingCellOwners(g.graph).get(g.cell(0, 1)), top, bottom };
  };
  const full = build(null);
  assert.equal(full.owner.id, full.bottom.id, '上との境が全高 → 下');
  const knee = build(KNEE);
  assert.equal(knee.owner.id, knee.top.id, '腰壁 → 面積最大の上');
});

test('中間のすき間: 辺 2000 に全高の壁 [0,800] と [1200,2000]、間の 400 は壁なし → 隔てない（面積の大きい A）。すき間 100 なら隔てる（B）', () => {
  const build = gapEnd => {
    const g = makeGrid([0, 3000, 4000, 5000], [0, 2000]);
    const a = g.interior([[0, 0]]);
    const b = g.interior([[2, 0]]);
    g.feature([[1, 0]], RoomFeature.VOID);
    g.graph.addWall(g.cx[1], 0, true, g.cy[0], 0, g.cy[0], 800, {});
    g.graph.addWall(g.cx[1], 0, true, g.cy[0], gapEnd, g.cy[1], 0, {});
    return { g, a, b };
  };
  const wide = build(1200);
  assert.equal(ownerOf(wide.g, 1).id, wide.a.id);
  const narrow = build(900);
  assert.equal(ownerOf(narrow.g, 1).id, narrow.b.id);
});

// ---- wallFullHeightSpans（壁 1 本の全高の区間。腰壁だけの区間を除く）

/** 縦の壁（x=0, y 0..1000）。CL は y=0/400/600/1000。knee(区間) の指定を付ける。 */
function spanWall(kneeRanges = [], extra = {}) {
  const g = makeGrid([0, 1000], [0, 400, 600, 1000]);
  const w = g.graph.addWall(g.cx[0], 0, true, g.cy[0], 0, g.cy[3], 0, {});
  for (const [i, j] of kneeRanges) g.graph.setKneeDropWall(edgeKey(g.cx[0].id, g.cy[i].id, g.cy[j].id), { knee: { topHeight: 800 }, ...extra });
  return { g, w };
}

test('wallFullHeightSpans: 腰壁なしは壁全体。lo/hi で切る', () => {
  const { g, w } = spanWall();
  assert.deepEqual(wallFullHeightSpans(g.graph, w), [[0, 1000]]);
  assert.deepEqual(wallFullHeightSpans(g.graph, w, 200, 700), [[200, 700]]);
});

test('wallFullHeightSpans: 中間の腰壁で 2 区間に分かれる。垂れ壁（drop）を持つ区間は全高', () => {
  const { g, w } = spanWall([[1, 2]]);
  assert.deepEqual(wallFullHeightSpans(g.graph, w), [[0, 400], [600, 1000]]);
  const withDrop = spanWall([[1, 2]], { drop: { bottomHeight: 600 } });
  assert.deepEqual(wallFullHeightSpans(withDrop.g.graph, withDrop.w), [[0, 1000]]);
});

test('【失敗系】wallFullHeightSpans: 重なりなし・座標が NaN は []。腰壁が全区間なら []', () => {
  const { g, w } = spanWall();
  assert.deepEqual(wallFullHeightSpans(g.graph, w, 2000, 3000), []);
  assert.deepEqual(wallFullHeightSpans(g.graph, { ...w, coord1: NaN, coord2: 1000, axisCL: w.axisCL }), []);
  const all = spanWall([[0, 3]]);
  assert.deepEqual(wallFullHeightSpans(all.g.graph, all.w), []);
});

// ---- 屋外部屋の天井（屋外 S1。裁定 2026-10-18）----
function porchLayout() {
  const g = makeGrid([0, 1000, 2000, 3000], [0, 1000]);
  const inner = g.interior([[0, 0]]);
  const porch = g.interior([[1, 0]]);
  porch.setKind(RoomKind.EXTERIOR);
  return { g, inner, porch };
}

test('屋外部屋: feature なしのポーチのセルは所属に載る。\'0\' で外すと載らない。屋内の隣の部屋の所属は変わらない', () => {
  const { g, inner, porch } = porchLayout();
  assert.deepEqual(ownerOf(g, 1), { kind: 'room', id: porch.id, rowId: porch.id });
  assert.deepEqual(ownerOf(g, 0), { kind: 'room', id: inner.id, rowId: inner.id });
  porch.setOverride('exteriorCeiling', '0');
  assert.equal(ownerOf(g, 1), undefined);
  assert.deepEqual(ownerOf(g, 0), { kind: 'room', id: inner.id, rowId: inner.id });
});

test('屋外部屋: 屋根の部屋・屋外階段（feature STAIR）の部屋は所属に載らない', () => {
  const { g } = porchLayout();
  g.roof([[2, 0]]);
  assert.equal(ownerOf(g, 2), undefined);
  const g2 = makeGrid([0, 1000], [0, 1000]);
  const st = g2.feature([[0, 0]], RoomFeature.STAIR);
  st.setKind(RoomKind.EXTERIOR);
  assert.equal(buildCeilingCellOwners(g2.graph).get(g2.cell(0, 0)), undefined);
});

test('屋外部屋: 吹抜けの所属候補は屋内の部屋だけ（裁定 2026-10-19）。面積の大きい屋外ポーチが隣にあっても屋内の部屋へ溶け込む', () => {
  const g = makeGrid([0, 1000, 2000, 5000], [0, 1000]);
  const inner = g.interior([[0, 0]]);
  const v = g.feature([[1, 0]], RoomFeature.VOID);
  const porch = g.interior([[2, 0]]);
  porch.setKind(RoomKind.EXTERIOR);
  assert.equal(ownerOf(g, 1).id, inner.id, '面積が小さくても屋内の部屋');
  assert.ok(v);
});

test('【失敗系】屋外部屋: 吹抜けの隣が屋外ポーチだけなら候補なし（索引外のまま）', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  g.feature([[0, 0]], RoomFeature.VOID);
  const porch = g.interior([[1, 0]]);
  porch.setKind(RoomKind.EXTERIOR);
  assert.equal(ownerOf(g, 0), undefined);
});
