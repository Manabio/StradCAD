// 階段の段（マス）の多角形（stairGeometry.js の collectCells）と、その遮蔽用アダプタ（stairTreads.js）の単体テスト。
// 実物の PlanGraph / Plane / Stair で組む。型ごとの fixture は stairStraightPorts / stairLTurnPorts / stairLaneGap の流儀に揃える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide, StructuralMaterialType } from '@core';
import { buildStairGeometry } from './stairGeometry.js';
import { measureStairSpans } from './stairClassify.js';
import { roomBounds } from '../gridCells.js';
import { landingZ } from './stairLanding.js';
import { stairTreadFootprints } from './stairTreads.js';
import { PARTITION_BACKING_MM, PARTITION_THICKNESS_MM } from './stairPartition.js';
import { generateStairPartitionWalls } from './stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';

const { LEFT } = StairPortSide;
const ARCH = { labeled: false, discipline: Discipline.ARCH };
const INSET = 57.5; // 設置枠から壁仕上げ面まで（壁の無いフィクスチャの既定）
const RISER = 200;
const COLUMN_HALF = PARTITION_BACKING_MM / 2; // 隔て壁端の柱（90 角）の柱材の半幅
const LANE_LEN = 3000; // uTurn フィクスチャの往路・復路の走行部の長さ（セルの実測 y 1000〜4000。レーンの間のあきはこの長さに沿う）

// ---------------------------------------------------------------- フィクスチャ

function gridOf(xs, ys) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const V = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const H = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const cell = (i, j) => `${V[i].id}:${H[j].id}:${V[i + 1].id}:${H[j + 1].id}`;
  return { graph, cell };
}

/** 北向き（up）の帯。ys は行の境界、cols 列。 */
function column(type, ys, cols, extra = {}) {
  const { graph, cell } = gridOf(Array.from({ length: cols + 1 }, (_, i) => i * 1000), ys);
  const keys = [];
  for (let j = ys.length - 2; j >= 0; j--) for (let i = 0; i < cols; i++) keys.push(cell(i, j));
  const stair = graph.addStair({ type, cells: new Set(keys), upDirection: 'up', flip: false, ...extra });
  return { graph, stair };
}

/** 踊り場（y 0..1000・全幅）＋往路・復路（y 1000..4000）。stairLaneGap.test.js と同じ配置。buildingStructure＝建物の構造（隔て壁が立つかを決める）。 */
function uTurn(type, { sections = [6, 1, 6], structure = StructuralMaterialType.WOOD, buildingStructure = 'S造', extra = {} } = {}) {
  const { graph, cell } = gridOf([0, 1000, 2000], [0, 1000, 4000]);
  const stair = graph.addStair({ type, cells: new Set([cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)]), sections, flip: false, upDirection: 'up', ...extra });
  stair.structure = structure;
  graph.setStructureOverride(buildingStructure);
  return { graph, stair };
}

/** stairLTurnPorts.test.js と同じ L 字（右向き。アーム1＝下の横帯、コーナー＝右下、アーム2＝右の縦帯。RUN_U=RUN_V=0.75）。 */
function lTurn(type, extra = {}) {
  const { graph, cell } = gridOf([0, 1000, 2000, 3000, 4000], [0, 1000, 2000, 3000, 4000]);
  const keys = [];
  for (let i = 0; i <= 3; i++) keys.push(cell(i, 3));
  for (let j = 0; j < 3; j++) keys.push(cell(3, j));
  const stair = graph.addStair({ type, cells: new Set(keys), upDirection: 'right', flip: false, sections: [10, 1, 10], ...extra });
  return { graph, stair };
}

/** 3×3 のセルに囲まれた中空き階段。 */
function openWell() {
  const { graph, cell } = gridOf([0, 1000, 2000, 3000], [0, 1000, 2000, 3000]);
  const keys = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) keys.push(cell(i, j));
  const stair = graph.addStair({ type: StairType.OPEN_WELL, cells: new Set(keys), upDirection: 'right', flip: false, sections: [4, 1, 4, 1, 4] });
  return { graph, stair };
}

// 型ごとの fixture。area＝「マスの面積の和」の理論値（設置枠の内側の面積から、階段が占めない所を引く）。
const inner = (w, h) => (w - 2 * INSET) * (h - 2 * INSET);
const CASES = [
  ['STRAIGHT', () => column(StairType.STRAIGHT, [0, 1000, 2000, 3000], 2, { sections: [15] }), inner(2000, 3000)],
  ['STRAIGHT（上り口が側面）', () => column(StairType.STRAIGHT, [0, 1000, 2000, 3000], 2, { sections: [11], entrySide: LEFT, entryTurnSteps: 4 }), inner(2000, 3000)],
  ['STRAIGHT（到達口が側面）', () => column(StairType.STRAIGHT, [0, 1000, 2000, 3000], 2, { sections: [11], arrivalSide: LEFT, arrivalTurnSteps: 4 }), inner(2000, 3000)],
  ['STRAIGHT_LANDING', () => column(StairType.STRAIGHT_LANDING, [0, 1000, 2000, 3000, 4000, 5000], 2, { sections: [6, 1, 6] }), inner(2000, 5000)],
  ['SWITCHBACK（あき 0）', () => uTurn(StairType.SWITCHBACK), inner(2000, 4000)],
  ['WINDING（偶数マス・あき 0）', () => uTurn(StairType.WINDING, { sections: [6, 2, 6] }), inner(2000, 4000)],
  ['WINDING（奇数マス・あき 0）', () => uTurn(StairType.WINDING, { sections: [6, 3, 6] }), inner(2000, 4000)],
  ['L_TURN', () => lTurn(StairType.L_TURN), inner(4000, 4000) * 0.4375],
  ['L_TURN（両口が側面）', () => lTurn(StairType.L_TURN, { sections: [6, 1, 6], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: LEFT, arrivalTurnSteps: 4 }), inner(4000, 4000) * 0.4375],
  ['FLARED', () => lTurn(StairType.FLARED, { sections: [10, 2, 10] }), inner(4000, 4000) * 0.4375],
  ['FLARED（奇数マス）', () => lTurn(StairType.FLARED, { sections: [10, 3, 10] }), inner(4000, 4000) * 0.4375],
  ['OPEN_WELL', () => openWell(), inner(3000, 3000) * 0.72],
];

// ---------------------------------------------------------------- 道具

const build = (stair, graph, { view = 'upper', detail = true, collectCells = true, riser = RISER, laneGap = true } = {}) =>
  buildStairGeometry(stair, roomBounds(stair.cells, graph), {
    view, detail, riser, spans: measureStairSpans(stair, graph), laneGap, graph, collectCells,
  });

function inPoly(p, x, y) {
  let inside = false;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
    const xi = p[2 * i], yi = p[2 * i + 1], xj = p[2 * j], yj = p[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function area(p) {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return Math.abs(a) / 2;
}
const areaSum = (cells) => cells.reduce((s, c) => s + area(c.poly), 0);
const near = (a, b, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

// ---------------------------------------------------------------- collectCells（stairGeometry）

for (const [name, make, expectedArea] of CASES) {
  test(`${name}: 番号は 1〜総蹴上数−1 が1つずつで、各段数字の点が同じ番号の多角形の内部にある`, () => {
    const { graph, stair } = make();
    const g = build(stair, graph);
    assert.deepEqual(g.cells.map(c => c.number).sort((a, b) => a - b), Array.from({ length: stair.totalSteps - 1 }, (_, i) => i + 1),
      '到達番号（総蹴上数）は含まない');
    assert.equal(g.stepNumbers.length, stair.totalSteps, '前提: 段数字は到達番号を含めて総蹴上数ぶん');
    for (const sn of g.stepNumbers) {
      const k = Number(sn.text);
      if (k === stair.totalSteps) continue;
      const cell = g.cells.find(c => c.number === k);
      assert.ok(inPoly(cell.poly, sn.x, sn.y), `段数字 ${k} (${sn.x},${sn.y}) が多角形の内部: ${JSON.stringify(cell.poly)}`);
    }
    for (const c of g.cells) {
      assert.ok(c.poly.length >= 6 && c.poly.length % 2 === 0 && c.poly.every(Number.isFinite), `有限な単純多角形: ${c.number}`);
      assert.ok(area(c.poly) > 1, `面積がある: ${c.number}`);
    }
  });

  test(`${name}: 多角形どうしは重ならない（格子サンプル）。面積の和は理論値`, () => {
    const { graph, stair } = make();
    const g = build(stair, graph);
    const b = roomBounds(stair.cells, graph);
    let sampled = 0;
    for (let x = b.x1 + 3.137; x < b.x2; x += 41) {
      for (let y = b.y1 + 3.137; y < b.y2; y += 41) {
        const hit = g.cells.filter(c => inPoly(c.poly, x, y)).map(c => c.number);
        assert.ok(hit.length <= 1, `(${x},${y}) が複数のマスに入る: ${hit}`);
        sampled++;
      }
    }
    assert.ok(sampled > 100, '前提: サンプル数');
    assert.ok(near(areaSum(g.cells), expectedArea), `面積の和 ${areaSum(g.cells)} ≒ 理論値 ${expectedArea}`);
  });

  test(`${name}: collectCells の有無で cells 以外の出力は完全に同じ。省略・false では cells キー自体が無い（view・detail 全組）`, () => {
    const { graph, stair } = make();
    for (const view of ['install', 'upper']) {
      for (const detail of [true, false]) {
        const withCells = build(stair, graph, { view, detail, collectCells: true });
        const without = build(stair, graph, { view, detail, collectCells: false });
        const { cells, ...rest } = withCells;
        assert.ok(Array.isArray(cells));
        assert.deepEqual(rest, without, `${view}/${detail}`);
        assert.equal('cells' in without, false, `${view}/${detail}: false は cells キー無し`);
        const omitted = buildStairGeometry(stair, roomBounds(stair.cells, graph), {
          view, detail, riser: RISER, spans: measureStairSpans(stair, graph), laneGap: true, graph,
        });
        assert.equal('cells' in omitted, false, `${view}/${detail}: 省略は cells キー無し`);
        assert.deepEqual(omitted, without);
      }
    }
  });

  test(`${name}: 多角形は detail（段鼻）に依らない`, () => {
    const { graph, stair } = make();
    assert.deepEqual(build(stair, graph, { detail: true }).cells, build(stair, graph, { detail: false }).cells);
  });
}

test('破れの上限は多角形に適用しない: STRAIGHT の install（FL+1600 で破れる）でも走行部は全マス', () => {
  const { graph, stair } = column(StairType.STRAIGHT, [0, 1000, 2000, 3000], 2, { sections: [15] });
  const inst = build(stair, graph, { view: 'install', detail: false });
  assert.ok(inst.treads.length < 13, '前提: 踏面線は破れで打ち切られる');
  assert.deepEqual(inst.cells.map(c => c.number), Array.from({ length: 14 }, (_, i) => i + 1));
});

test('SWITCHBACK のあき: 100（鉄骨）・115（在来の木造で隔て壁が立つ）のとき往路と復路の間にあきができ、面積の和はあき分だけ減る', () => {
  const full = inner(2000, 4000);
  for (const [label, fx, gap, laneLen] of [
    ['鉄骨', uTurn(StairType.SWITCHBACK, { structure: StructuralMaterialType.STEEL }), 100, LANE_LEN],
    // 隔て壁が立つと、あきが空く範囲は基端の壁面から復路側の前縁（回転部側の柱の回転部側の面＝通り芯 y=1000 から柱材の半幅だけ奥）まで
    ['在来の木造（隔て壁 115）', uTurn(StairType.SWITCHBACK, { buildingStructure: '木造（在来）' }), 115, LANE_LEN - INSET + COLUMN_HALF],
    ['在来以外の木造（あき 0）', uTurn(StairType.SWITCHBACK), 0, LANE_LEN],
  ]) {
    const g = build(fx.stair, fx.graph);
    assert.ok(near(areaSum(g.cells), full - gap * laneLen), `${label}: ${areaSum(g.cells)} ≒ ${full - gap * laneLen}`);
    // 往路（番号 1〜5）と復路（7〜11）の間のあき: 復路の x の最小と往路の x の最大の差
    const xs = (from, to) => g.cells.filter(c => c.number >= from && c.number <= to).flatMap(c => c.poly.filter((_, i) => i % 2 === 0));
    assert.ok(near(Math.min(...xs(7, 11)) - Math.max(...xs(1, 5)), gap), `${label}: あき ${gap}`);
  }
});

test('WINDING のあき 115（在来の木造で隔て壁が立つ）: 往路・復路の踏面は軸 x=1000 から ±57.5 の内側に入らず、面積の和はあき分だけ減る。周回部は全幅', () => {
  for (const sections of [[6, 2, 6], [6, 3, 6]]) {
    const { graph, stair } = uTurn(StairType.WINDING, { sections, buildingStructure: '木造（在来）' });
    // 隔て壁（柱包み付き）を足す: 柱は PB の外面（通り芯±57.5）なので、回り段の起点 P1・P2 はレーン内側端（x=942.5/1057.5）に載る
    for (const w of generateStairPartitionWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE })) {
      const sign = Math.sign(w.clEnd.effectiveValue - w.clStart.effectiveValue) || 1;
      w.startOffset = -sign * 57.5; w.endOffset = sign * 57.5;
    }
    const g = build(stair, graph);
    const turnFrom = sections[0], turnTo = sections[0] + sections[1] - 1; // 周回部のマス番号（直進部 n は n-1 マス）
    const lanes = g.cells.filter(c => c.number < turnFrom || c.number > turnTo);
    assert.ok(lanes.length >= 8, `前提: 往路・復路のマスがある: ${lanes.length}`);
    const dx = lanes.flatMap(c => c.poly.filter((_, i) => i % 2 === 0).map(x => Math.abs(x - 1000)));
    assert.ok(Math.min(...dx) > 57.5 - 1e-6, `レーンのマスが壁面の内側に入る: 最小 |x-1000|=${Math.min(...dx)}`);
    assert.ok(dx.some(d => Math.abs(d - 57.5) < 1e-6), '壁面（±57.5）で止まっている');
    // あきが空くのは基端の壁面（y=3942.5）から復路側の前縁（回転部側の柱の PB の回転部側の面＝通り芯 y=1000 の奥 57.5）まで
    assert.ok(near(areaSum(g.cells), inner(2000, 4000) - 115 * (LANE_LEN - INSET + PARTITION_THICKNESS_MM / 2)), `${sections}: ${areaSum(g.cells)}`);
    const turn = g.cells.filter(c => c.number >= turnFrom && c.number <= turnTo);
    const tx = turn.flatMap(c => c.poly.filter((_, i) => i % 2 === 0));
    assert.ok(Math.min(...tx) < 1000 - 57.5 && Math.max(...tx) > 1000 + 57.5, '周回部は軸をまたぐ全幅');
  }
});

test('WINDING のあき 100（鉄骨）でも周回部は全幅の帯（扇形の和）で、面積の和はあき分だけ減る', () => {
  for (const sections of [[6, 2, 6], [6, 3, 6]]) {
    const { graph, stair } = uTurn(StairType.WINDING, { sections, structure: StructuralMaterialType.STEEL });
    const g = build(stair, graph);
    assert.ok(near(areaSum(g.cells), inner(2000, 4000) - 100 * LANE_LEN), `${sections}: ${areaSum(g.cells)}`);
  }
});

// ---------------------------------------------------------------- stairTreadFootprints（アダプタ）

test('stairTreadFootprints: 天端 = 番号 × 蹴上。多角形は collectCells と同じ。insetView の既定は upper', () => {
  const { graph, stair } = uTurn(StairType.SWITCHBACK);
  const treads = stairTreadFootprints(stair, graph, { riser: 200 });
  assert.equal(treads.length, stair.totalSteps - 1);
  assert.deepEqual(treads.map(t => t.topZ), treads.map(t => t.number * 200));
  const g = build(stair, graph, { detail: false });
  assert.deepEqual(treads.map(t => t.poly), g.cells.map(c => c.poly));
  // install の逃がし規則（insetView）は始端の枠だけ変える（壁の無いこのフィクスチャでは upper は始端も内側へ、install は走行端の始端を CL のまま）
  const inst = stairTreadFootprints(stair, graph, { riser: 200, insetView: 'install' });
  assert.equal(inst.length, treads.length);
  assert.notDeepEqual(inst.map(t => t.poly), treads.map(t => t.poly));
});

test('SWITCHBACK の踊り場のマスの天端は landingZ（往路の段数 × 蹴上）と一致する。明示 riser でも', () => {
  for (const [riserField, floorHeight] of [[null, 2400], [180, 2400]]) {
    const { graph, stair } = uTurn(StairType.SWITCHBACK);
    stair.riser = riserField;
    const riser = stair.riser ?? floorHeight / stair.totalSteps;
    const landing = stairTreadFootprints(stair, graph, { riser }).find(t => t.number === 6);
    assert.ok(landing, '踊り場のマス（番号 6）');
    assert.equal(landing.topZ, landingZ(stair, graph, floorHeight));
  }
});

test('失敗系: 蹴上が null・非有限・0 以下なら []（遮蔽しない）。例外にしない', () => {
  const { graph, stair } = uTurn(StairType.SWITCHBACK);
  for (const riser of [null, undefined, NaN, Infinity, 0, -200]) {
    assert.deepEqual(stairTreadFootprints(stair, graph, { riser }), [], `riser=${riser}`);
  }
  assert.deepEqual(stairTreadFootprints(stair, graph), [], 'opts なし');
});

test('失敗系: 階段・graph が無い／セルが空／設置枠が不正なら []', () => {
  const { graph, stair } = uTurn(StairType.SWITCHBACK);
  assert.deepEqual(stairTreadFootprints(null, graph, { riser: 200 }), []);
  assert.deepEqual(stairTreadFootprints(stair, null, { riser: 200 }), []);
  stair.setCells(new Set());
  assert.deepEqual(stairTreadFootprints(stair, graph, { riser: 200 }), [], 'セルが空');
  stair.setCells(new Set(['no-such:cell:key:here']));
  assert.deepEqual(stairTreadFootprints(stair, graph, { riser: 200 }), [], '解決できないセル');
});

test('失敗系: 型が未知でも例外にしない（直進として扱われ、配列を返す）', () => {
  const { graph, stair } = column(StairType.STRAIGHT, [0, 1000, 2000, 3000], 2, { sections: [15] });
  stair.type = 'NO_SUCH_TYPE';
  assert.doesNotThrow(() => stairTreadFootprints(stair, graph, { riser: 200 }));
  assert.ok(Array.isArray(stairTreadFootprints(stair, graph, { riser: 200 })));
});
