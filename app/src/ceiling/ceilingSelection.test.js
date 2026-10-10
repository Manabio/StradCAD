// 天伏の天井セル選択（純モジュール）。所属の優先・ドラッグでなぞったセルだけ・部屋を超えない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature, StairType } from '@core';
import { makeGrid } from '../plan/planTestFixtures.js';
import { buildCeilingCellOwners, stairHasCeiling } from './ceilingOwners.js';
import { beginCeilingDrag, extendCeilingDrag } from './ceilingSelection.js';

const XS = [0, 1000, 2000, 3000, 4000, 5000, 6000];
const YS = [0, 1000, 2000, 3000];
/** セル (i, j) の中心のワールド座標。 */
const ctr = (i, j) => [i * 1000 + 500, j * 1000 + 500];
const keysOf = (drag) => [...drag.visited.keys()].sort();

test('所属: 屋内部屋のセルは {kind:room, id, rowId=id}。部屋の無いセルは索引に載らない', () => {
  const g = makeGrid(XS, YS);
  const a = g.interior([[0, 0], [1, 0]]);
  const owners = buildCeilingCellOwners(g.graph);
  assert.deepEqual(owners.get(g.cell(0, 0)), { kind: 'room', id: a.id, rowId: a.id });
  assert.deepEqual(owners.get(g.cell(1, 0)), { kind: 'room', id: a.id, rowId: a.id });
  assert.equal(owners.has(g.cell(2, 0)), false);
  assert.equal(owners.size, 2);
});

test('所属: 部分指定の子のセルは子の所属。reorderRooms で子を親より前に並べても子。親の残りは親', () => {
  const g = makeGrid(XS, YS);
  const parent = g.interior([[0, 0], [1, 0], [2, 0]]);
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '子', 'child-1', new Set([parent.id]));
  for (const order of [[parent.id, child.id], [child.id, parent.id]]) {
    g.graph.reorderRooms(order);
    const owners = buildCeilingCellOwners(g.graph);
    assert.equal(owners.get(g.cell(1, 0)).id, child.id, `順序 ${order}: 子のセルは子`);
    assert.equal(owners.get(g.cell(0, 0)).id, parent.id, `順序 ${order}: 親の残りは親`);
    assert.equal(owners.get(g.cell(2, 0)).id, parent.id);
  }
});

test('【失敗系】所属: 屋外・VOID・STAIR_VOID・UNDEFINED・屋根・昇降路・未割当のセルは索引に無く、そこからの begin は null', () => {
  const g = makeGrid(XS, YS);
  const out = g.interior([[0, 0]]);
  out.setKind(RoomKind.EXTERIOR);
  g.feature([[1, 0]], RoomFeature.VOID);
  g.feature([[2, 0]], RoomFeature.STAIR_VOID);
  g.feature([[3, 0]], RoomFeature.UNDEFINED);
  g.roof([[4, 0]]);
  g.feature([[5, 0]], RoomFeature.ELEVATOR_EQUIPMENT);
  const owners = buildCeilingCellOwners(g.graph);
  assert.equal(owners.size, 0);
  for (let i = 0; i < 6; i++) {
    const [x, y] = ctr(i, 0);
    assert.equal(beginCeilingDrag(g.graph, owners, x, y), null, `セル ${i}`);
  }
  const [ux, uy] = ctr(0, 2); // 未割当
  assert.equal(beginCeilingDrag(g.graph, owners, ux, uy), null);
});

test('【失敗系】begin: 格子外・NaN・Infinity は null（例外にしない）', () => {
  const g = makeGrid(XS, YS);
  g.interior([[0, 0]]);
  const owners = buildCeilingCellOwners(g.graph);
  assert.equal(beginCeilingDrag(g.graph, owners, -500, 500), null);
  assert.equal(beginCeilingDrag(g.graph, owners, 500, 99999), null);
  assert.equal(beginCeilingDrag(g.graph, owners, NaN, 500), null);
  assert.equal(beginCeilingDrag(g.graph, owners, 500, Infinity), null);
  assert.ok(beginCeilingDrag(g.graph, owners, 500, 500));
});

test('階段: 部屋の無い階段のセルは {kind:stair, rowId=stair.id}。変換元の部屋があれば rowId は roomId で、feature=STAIR の部屋が重なっても階段', () => {
  const g = makeGrid(XS, YS);
  const bare = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(0, 0)]) });
  const stairRoom = g.feature([[2, 0]], RoomFeature.STAIR);
  const withRoom = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(2, 0)]), roomId: stairRoom.id });
  const owners = buildCeilingCellOwners(g.graph);
  assert.deepEqual(owners.get(g.cell(0, 0)), { kind: 'stair', id: bare.id, rowId: bare.id });
  assert.deepEqual(owners.get(g.cell(2, 0)), { kind: 'stair', id: withRoom.id, rowId: stairRoom.id });
  assert.equal(owners.has(g.cell(1, 0)), false);
});

test('階段: 階段下の屋内部屋（2a）が重なるセルは部屋が勝つ。屋外の変換元を持つ階段は選べない', () => {
  const g = makeGrid(XS, YS);
  g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(0, 0), g.cell(1, 0)]) });
  const under = g.interior([[1, 0]]);
  const outRoom = g.interior([[3, 0]]);
  outRoom.setKind(RoomKind.EXTERIOR);
  const outStair = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(3, 0)]), roomId: outRoom.id });
  const owners = buildCeilingCellOwners(g.graph);
  assert.equal(owners.get(g.cell(0, 0)).kind, 'stair');
  assert.deepEqual(owners.get(g.cell(1, 0)), { kind: 'room', id: under.id, rowId: under.id });
  assert.equal(owners.has(g.cell(3, 0)), false);
  assert.equal(stairHasCeiling(g.graph, outStair), false);
});

test('階段: 階段下部屋（2a）は feature=STAIR のペア部屋つき階段にも勝つ。ペア部屋のセルは階段（rowId=ペア部屋）のまま', () => {
  const g = makeGrid(XS, YS);
  const pair = g.feature([[0, 0], [1, 0]], RoomFeature.STAIR);
  const stair = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(0, 0), g.cell(1, 0)]), roomId: pair.id });
  const under = g.interior([[1, 0]]);
  const owners = buildCeilingCellOwners(g.graph);
  assert.deepEqual(owners.get(g.cell(1, 0)), { kind: 'room', id: under.id, rowId: under.id });
  assert.deepEqual(owners.get(g.cell(0, 0)), { kind: 'stair', id: stair.id, rowId: pair.id });
});

test('所属: VOID の部屋が屋内部屋より先に並んでいても、重なるセルは屋内部屋の所属（VOID 単独のセルは載らない）', () => {
  const g = makeGrid(XS, YS);
  g.feature([[0, 0], [1, 0]], RoomFeature.VOID);
  const room = g.interior([[1, 0]]);
  const owners = buildCeilingCellOwners(g.graph);
  assert.deepEqual(owners.get(g.cell(1, 0)), { kind: 'room', id: room.id, rowId: room.id });
  assert.equal(owners.has(g.cell(0, 0)), false);
});

test('所属: 天井を持たない部分指定の子（VOID）のセルは親の所属にならず、begin は null。親の残りは親', () => {
  const g = makeGrid(XS, YS);
  const parent = g.interior([[0, 0], [1, 0]]);
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '吹抜け', 'void-child', new Set([parent.id]));
  child.setFeature(RoomFeature.VOID);
  const owners = buildCeilingCellOwners(g.graph);
  assert.equal(owners.has(g.cell(1, 0)), false);
  assert.equal(beginCeilingDrag(g.graph, owners, ...ctr(1, 0)), null);
  assert.equal(owners.get(g.cell(0, 0)).id, parent.id);
});

test('境界: 他所属を通って戻る経路の補間は、通っていないセルを拾わない（lastWorld を進める）', () => {
  const xs = [0, 1000, 2000, 3000];
  const ys = [0, 1000, 2000];
  const g = makeGrid(xs, ys);
  g.interior([[0, 0], [1, 0], [2, 0], [2, 1]]);
  g.interior([[0, 1], [1, 1]]);
  const owners = buildCeilingCellOwners(g.graph);
  let d = beginCeilingDrag(g.graph, owners, ...ctr(0, 0));
  for (const [i, j] of [[0, 1], [1, 1], [2, 1]]) d = extendCeilingDrag(g.graph, owners, d, ...ctr(i, j), 100);
  assert.deepEqual(keysOf(d), [g.cell(0, 0), g.cell(2, 1)].sort());
});

test('【失敗系】extend: stepMm が極小（1e-9・Number.MIN_VALUE）でも例外なく短時間で終わり、途中のセルも入る', () => {
  const g = makeGrid(XS, YS);
  g.interior([[0, 0], [1, 0], [2, 0], [3, 0]]);
  const owners = buildCeilingCellOwners(g.graph);
  for (const step of [1e-9, Number.MIN_VALUE]) {
    const t0 = Date.now();
    const d = extendCeilingDrag(g.graph, owners, beginCeilingDrag(g.graph, owners, ...ctr(0, 0)), ...ctr(3, 0), step);
    assert.ok(Date.now() - t0 < 2000, `step=${step}: 時間がかかりすぎ`);
    assert.equal(d.visited.size, 4, `step=${step}`);
  }
});

test('境界: A のセルから B のセルを通って A に戻ると、B は捨て A は足す（ドラッグは続く）', () => {
  const g = makeGrid(XS, YS);
  const a = g.interior([[0, 0], [2, 0]]);
  g.interior([[1, 0]]);
  const owners = buildCeilingCellOwners(g.graph);
  const d0 = beginCeilingDrag(g.graph, owners, ...ctr(0, 0));
  assert.equal(d0.owner.id, a.id);
  const d1 = extendCeilingDrag(g.graph, owners, d0, ...ctr(1, 0), 0);
  assert.equal(d1, d0, 'B のセルでは何も足さず同じ drag を返す');
  const d2 = extendCeilingDrag(g.graph, owners, d1, ...ctr(2, 0), 0);
  assert.deepEqual(keysOf(d2), [g.cell(0, 0), g.cell(2, 0)].sort());
});

test('なぞったセルだけ: 3×3 の部屋を対角になぞると通ったセルだけ（矩形の補完で 9 にならない）', () => {
  const g = makeGrid(XS, YS);
  const room = g.interior([0, 1, 2].flatMap(i => [0, 1, 2].map(j => [i, j])));
  const owners = buildCeilingCellOwners(g.graph);
  assert.equal(owners.size, 9);
  let d = beginCeilingDrag(g.graph, owners, ...ctr(0, 0));
  d = extendCeilingDrag(g.graph, owners, d, ...ctr(1, 1), 0);
  d = extendCeilingDrag(g.graph, owners, d, ...ctr(2, 2), 0);
  assert.equal(d.owner.id, room.id);
  assert.deepEqual(keysOf(d), [g.cell(0, 0), g.cell(1, 1), g.cell(2, 2)].sort());
});

test('補間: 1回の move で (0,0)→(3,0) に跳んでも途中の (1,0)(2,0) が入る。stepMm が 0・NaN・負・未指定なら終点だけ（例外にしない）', () => {
  const g = makeGrid(XS, YS);
  g.interior([[0, 0], [1, 0], [2, 0], [3, 0]]);
  const owners = buildCeilingCellOwners(g.graph);
  const all = [0, 1, 2, 3].map(i => g.cell(i, 0)).sort();
  const run = (step) => keysOf(extendCeilingDrag(g.graph, owners,
    beginCeilingDrag(g.graph, owners, ...ctr(0, 0)), ...ctr(3, 0), step));
  assert.deepEqual(run(100), all);
  const ends = [g.cell(0, 0), g.cell(3, 0)].sort();
  for (const step of [0, NaN, -5, undefined]) assert.deepEqual(run(step), ends, `step=${step}`);
});

test('【失敗系】extend: 非有限座標は変更なし（同じ drag）', () => {
  const g = makeGrid(XS, YS);
  g.interior([[0, 0], [1, 0]]);
  const owners = buildCeilingCellOwners(g.graph);
  const d0 = beginCeilingDrag(g.graph, owners, ...ctr(0, 0));
  assert.equal(extendCeilingDrag(g.graph, owners, d0, NaN, 500, 100), d0);
  assert.equal(extendCeilingDrag(g.graph, owners, d0, 1500, Infinity, 100), d0);
  assert.equal(d0.visited.size, 1);
});

test('L字: 連結領域（短縮した通り芯で結合したセル群）は同じ所属がまとめて入る', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000, 2000]);
  g.cx[1].setProps({ _extentLo: 0, _extentHi: 1000 });
  g.cy[1].setProps({ _extentLo: 0, _extentHi: 1000 });
  g.interior([[0, 0], [1, 0], [0, 1], [1, 1]]);
  const owners = buildCeilingCellOwners(g.graph);
  const d = beginCeilingDrag(g.graph, owners, 1500, 500); // L字の縦棒
  assert.equal(d.visited.size, 2, '縦棒＋左下の2セル（左上は別セル）');
  assert.ok(![...d.visited.values()].some(c => c.x2 <= 1000 && c.y2 <= 1000), '左上のセルは入っていない');
  const d2 = extendCeilingDrag(g.graph, owners, d, 500, 500, 0);
  assert.equal(d2.visited.size, 3, '左上へなぞるとそのセルが足される');
});
