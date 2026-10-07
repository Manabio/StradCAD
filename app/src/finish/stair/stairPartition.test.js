// 在来木造・折返し階段の隔て壁（resolveStairPartition）の判定と幾何。
// フィクスチャは座標の矩形（x1,y1,x2,y2）から CL とセルキーを作る（y下向き正）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomKind } from '@core';
import { measureStairSpans, uTurnSpans } from './stairClassify.js';
import { portSpansOf, resolveStairPorts } from './stairPorts.js';
import { roomBounds } from '../gridCells.js';
import {
  partitionTopZAt, partitionTopCrossings, stairPartitionDescriptors,
  resolveStairPartition, PARTITION_BACKING_MM, PARTITION_FINISH_MM, PARTITION_TOP_ABOVE_NOSING_MM, PARTITION_THICKNESS_MM,
} from './stairPartition.js';

const WOOD = '木造（在来）';
const FH = 2400; // 階高。sections [6,1,6] → 総蹴上 12 → 蹴上 200

// rects の各 [x1,y1,x2,y2] を1セルとして Stair を作る
function makeStair(rects, stairProps) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const vs = new Map(), hs = new Map();
  const V = (v) => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = (v) => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const cells = new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, ...stairProps });
  return { graph, stair };
}

// upDirection='up'・等長レーン: 踊り場 y0〜1000（全幅）、左レーンA・右レーンB が y1000〜4000
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];
const opts = (o = {}) => ({ structure: WOOD, continuesAbove: false, floorHeight: FH, ...o });

test('在来・SWITCHBACK・等長レーン(up): 軸=レーン間中心線x=1000・区間=y1000〜4000・端点・厚み・斜め天端の z', () => {
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up' });
  const p = resolveStairPartition(stair, graph, opts());
  assert.equal(p.isVertical, true);
  assert.equal(p.axisValue, 1000);
  assert.deepEqual([p.lo, p.hi], [1000, 4000]);
  assert.deepEqual(p.entryEnd, { x: 1000, y: 4000 }, '上り口・下り口側＝t=0＝基端 y2');
  assert.deepEqual(p.landingEnd, { x: 1000, y: 1000 }, '踊り場側＝tRun');
  assert.deepEqual(p.thickness, { backing: 90, finish: 12.5, total: 115 });
  assert.equal(PARTITION_THICKNESS_MM, PARTITION_BACKING_MM + 2 * PARTITION_FINISH_MM);
  assert.equal(PARTITION_TOP_ABOVE_NOSING_MM, 800);
  // 蹴上=2400/12=200。復路の最初の踏面の番号 = 往路マス(6-1)+踊り場(1)+1 = 7 → 段鼻 7×200=1400。
  // 端: 上階FL+800=3200、踊り場側: 1400+800=2200
  assert.deepEqual(p.top, { kind: 'slope', zAtEntryEnd: 3200, zAtLandingEnd: 2200 });
});

test('不等長レーン: 区間は両レーンが並走する部分だけ（短い方の基端〜tRun）', () => {
  // B は y1000〜3000 だけ（基端側 y3000〜4000 は A のみ）
  const { graph, stair } = makeStair(
    [[0, 0, 2000, 1000], [0, 1000, 1000, 3000], [0, 3000, 1000, 4000], [1000, 1000, 2000, 3000]], { upDirection: 'up' });
  const p = resolveStairPartition(stair, graph, opts());
  assert.deepEqual([p.lo, p.hi], [1000, 3000], '重なり y1000〜3000（A の基端 y3000〜4000 には立たない）');
  assert.deepEqual(p.entryEnd, { x: 1000, y: 3000 });
  assert.equal(p.axisValue, 1000);
});

test('flip=true・upDirection=right: 軸は水平（y=1000）・走行は x 方向・端点はレーン基端 x=0 と踊り場前縁 x=3000', () => {
  const { graph, stair } = makeStair(
    [[3000, 0, 4000, 2000], [0, 0, 3000, 1000], [0, 1000, 3000, 2000]], { upDirection: 'right', flip: true });
  const p = resolveStairPartition(stair, graph, opts());
  assert.equal(p.isVertical, false);
  assert.equal(p.axisValue, 1000);
  assert.deepEqual([p.lo, p.hi], [0, 3000]);
  assert.deepEqual(p.entryEnd, { x: 0, y: 1000 });
  assert.deepEqual(p.landingEnd, { x: 3000, y: 1000 });
});

test('upDirection=left: 基端は右（x=4000）・踊り場前縁は x=1000。lo<hi に整列される', () => {
  const { graph, stair } = makeStair(
    [[0, 0, 1000, 2000], [1000, 0, 4000, 1000], [1000, 1000, 4000, 2000]], { upDirection: 'left' });
  const p = resolveStairPartition(stair, graph, opts());
  assert.equal(p.isVertical, false);
  assert.deepEqual([p.lo, p.hi], [1000, 4000]);
  assert.deepEqual(p.entryEnd, { x: 4000, y: 1000 });
  assert.deepEqual(p.landingEnd, { x: 1000, y: 1000 });
});

test('entryTurnSteps>0（側面の上り口・ports.entry が end 以外）: 段鼻の蹴上番号が取りつき回転部の蹴上数ぶん上がる', () => {
  // 往路 A が復路 B より長く張り出す → 上り口は側面（自動＝内側）。総蹴上 = 12 + 2 = 14 → 蹴上 2400/14。番号 = 2 + 6 + 1 = 9
  const rects = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 3000]];
  const { graph, stair } = makeStair(rects, { upDirection: 'up', entryTurnSteps: 2 });
  assert.equal(stair.totalSteps, 14, '前提: 取りつき分が総段数に入る');
  const ports = resolveStairPorts(stair, portSpansOf(measureStairSpans(stair, graph)));
  assert.notEqual(ports.entry, 'end', '前提: 上り口が側面に解決される（描画側で turnStepsE=2 になる形）');
  const p = resolveStairPartition(stair, graph, opts());
  assert.equal(p.top.kind, 'slope');
  assert.ok(Math.abs(p.top.zAtLandingEnd - (9 * (FH / 14) + 800)) < 1e-9, `zAtLandingEnd=${p.top.zAtLandingEnd}`);
  assert.equal(p.top.zAtEntryEnd, 3200);
  assert.deepEqual([p.lo, p.hi], [1000, 3000], '並走は B の基端 y3000 まで');
});

test('不等長レーン（復路が長い）: 区間は往路の基端まで', () => {
  const { graph, stair } = makeStair(
    [[0, 0, 2000, 1000], [0, 1000, 1000, 3000], [1000, 1000, 2000, 3000], [1000, 3000, 2000, 4000]], { upDirection: 'up' });
  const p = resolveStairPartition(stair, graph, opts());
  assert.deepEqual([p.lo, p.hi], [1000, 3000]);
  assert.deepEqual(p.entryEnd, { x: 1000, y: 3000 });
});

test('全幅の取りつき帯（entryFull）は隔て壁に含めない', () => {
  const { graph, stair } = makeStair(
    [[0, 0, 2000, 1000], [0, 1000, 1000, 3000], [1000, 1000, 2000, 3000], [0, 3000, 2000, 4000]], { upDirection: 'up' });
  assert.equal(uTurnSpans(stair, graph, roomBounds(stair.cells, graph)).entryFull, true, '前提: 基端の全幅帯が取りつき');
  const p = resolveStairPartition(stair, graph, opts());
  assert.deepEqual([p.lo, p.hi], [1000, 3000], '帯 y3000〜4000 には立たない');
});

test('sections=null は defaultSections で天端を出す', () => {
  // totalSteps=13 → defaultSections = [7,1,6]（a=ceil(13/2)=7, s=6）。蹴上 2600/13=200。番号 = 7+1 = 8 → 1600
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up', sections: null, totalSteps: 13 });
  const p = resolveStairPartition(stair, graph, opts({ floorHeight: 2600 }));
  assert.deepEqual(p.top, { kind: 'slope', zAtEntryEnd: 3400, zAtLandingEnd: 1600 + 800 });
});

test('【失敗系】stair.riser が 0 / NaN: 幾何は返し天端はフルハイト', () => {
  for (const riser of [0, NaN]) {
    const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up', riser });
    const p = resolveStairPartition(stair, graph, opts());
    assert.ok(p, String(riser));
    assert.deepEqual(p.top, { kind: 'full' }, String(riser));
    assert.equal(p.axisValue, 1000);
  }
});

test('stair.riser の明示指定は階高/総段数より優先される', () => {
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up', riser: 180 });
  const p = resolveStairPartition(stair, graph, opts());
  assert.equal(p.top.zAtLandingEnd, 7 * 180 + 800);
});

test('continuesAbove=true（上に続く階段）: 幾何は同じでフルハイト', () => {
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up' });
  const p = resolveStairPartition(stair, graph, opts({ continuesAbove: true }));
  assert.deepEqual(p.top, { kind: 'full' });
  assert.deepEqual([p.lo, p.hi], [1000, 4000]);
});

test('【失敗系】floorHeight=null かつ riser 未指定: 幾何は返し、天端は安全側のフルハイト', () => {
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up' });
  const p = resolveStairPartition(stair, graph, opts({ floorHeight: null }));
  assert.ok(p, 'null にはしない');
  assert.deepEqual(p.top, { kind: 'full' });
  assert.equal(p.axisValue, 1000);
});

test('【失敗系】在来木造以外（RC・S・2x4・null）は null', () => {
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up' });
  for (const structure of ['RC造(ラーメン)', 'S造', '木造（2"×4"）', null]) {
    assert.equal(resolveStairPartition(stair, graph, opts({ structure })), null, String(structure));
  }
});

test('【失敗系】SWITCHBACK 以外（STRAIGHT・WINDING）は null', () => {
  for (const type of [StairType.STRAIGHT, StairType.WINDING]) {
    const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up', type });
    assert.equal(resolveStairPartition(stair, graph, opts()), null, type);
  }
});

test('【失敗系】uTurnSpans が取れない（回転部が走行全長を占める）階段は null', () => {
  const { graph, stair } = makeStair([[0, 0, 1000, 900], [1000, 0, 2000, 900]], { upDirection: 'up' });
  assert.equal(resolveStairPartition(stair, graph, opts()), null);
});

test('【失敗系】stair が null / セルが空: 例外なく null', () => {
  const { graph } = makeStair(EQUAL_UP, { upDirection: 'up' });
  assert.equal(resolveStairPartition(null, graph, opts()), null);
  const empty = graph.addStair({ type: StairType.SWITCHBACK, cells: new Set(), sections: [6, 1, 6], upDirection: 'up' });
  assert.equal(resolveStairPartition(empty, graph, opts()), null);
});

// ---- S4-1: 天端の単一情報源 ----
test('partitionTopZAt: 両端・中点・端の外のクランプ（等長 up: entryEnd y=4000 で3200・landingEnd y=1000 で2200）', () => {
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up' });
  const p = resolveStairPartition(stair, graph, opts());
  assert.equal(partitionTopZAt(p, 4000), 3200);
  assert.equal(partitionTopZAt(p, 1000), 2200);
  assert.equal(partitionTopZAt(p, 2500), 2700);
  assert.equal(partitionTopZAt(p, 5000), 3200, 'entry 側の外は端の値');
  assert.equal(partitionTopZAt(p, 0), 2200, 'landing 側の外は端の値');
});

test('partitionTopZAt: full（続く層）・desc なしは null', () => {
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up' });
  assert.equal(partitionTopZAt(resolveStairPartition(stair, graph, opts({ continuesAbove: true })), 2500), null);
  assert.equal(partitionTopZAt(null, 2500), null);
});

test('partitionTopCrossings: 斜線が横切る z は1交点・範囲外（端の値ちょうど含む）は0交点・full は空', () => {
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up' });
  const p = resolveStairPartition(stair, graph, opts());
  assert.deepEqual(partitionTopCrossings(p, [2700]), [2500]);
  assert.deepEqual(partitionTopCrossings(p, [2800, 2600]), [2200, 2800], '昇順で返す');
  assert.deepEqual(partitionTopCrossings(p, [2200, 3200, 1000, 4000]), []);
  assert.deepEqual(partitionTopCrossings(resolveStairPartition(stair, graph, opts({ continuesAbove: true })), [2700]), []);
});

test('stairPartitionDescriptors: continuesAbove の true→full・false→slope・null/未指定→full・非在来→空・屋外階段は除外', () => {
  const { graph, stair } = makeStair(EQUAL_UP, { upDirection: 'up' });
  const d = (o) => stairPartitionDescriptors(graph, { structure: WOOD, floorHeight: FH, ...o });
  assert.equal(d({ continuesAbove: () => true })[0].desc.top.kind, 'full');
  assert.equal(d({ continuesAbove: () => false })[0].desc.top.kind, 'slope');
  assert.equal(d({ continuesAbove: () => null })[0].desc.top.kind, 'full');
  assert.equal(d({})[0].desc.top.kind, 'full');
  assert.equal(d({ continuesAbove: () => false, floorHeight: null })[0].desc.top.kind, 'full', '階高が決まらなければ full');
  const got = d({ continuesAbove: () => false })[0];
  assert.equal(got.stair, stair);
  assert.deepEqual(got.line, { isVertical: true, axisValue: 1000, lo: 1000, hi: 4000 });
  assert.deepEqual(stairPartitionDescriptors(graph, { structure: 'S造', floorHeight: FH, continuesAbove: () => false }), []);
  const pair = graph.addRoom(new Set(stair.cells), '階段');
  stair.roomId = pair.id;
  assert.equal(d({ continuesAbove: () => false }).length, 1, '対照（屋内）');
  pair.setKind(RoomKind.EXTERIOR);
  assert.deepEqual(d({ continuesAbove: () => false }), []);
});
