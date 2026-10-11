// 見上げ（opts.lookUp）の階段上の裏面（S13a）: planSolids の配線と、解決後の線。実物の PlanGraph で組む（planSolids.test.js の流儀）。
// 上階の続きの階段が下階（自階）の階段と同じ足元のとき、木造は階段裏の傾斜天井（stairSoffit）、鉄骨は踏面線（stairTread の輪郭）を出す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType, StructuralMaterialType } from '@core';
import { planSolids } from './planSolids.js';
import { planSolidsLayerPrimitivesUp, planSolidsLayerSolidsUp } from './planSolidsLayerFilter.js';
import { uTurnPlanLayout } from '../finish/stair/stairGeometry.js';
import { stairTreadFootprints } from '../finish/stair/stairTreads.js';
import { makeGrid, fakeLayer } from './planTestFixtures.js';

const WOOD = StructuralMaterialType.WOOD, STEEL = StructuralMaterialType.STEEL;
const FL = 2800;
const CUT = 1500;

/** 踊り場（y 0..1000）＋往路・復路（y 1000..4000）の折返し階段のある階。withStair=false は階段なしの同じ形の階。 */
function stairFloor(id, { structure = WOOD, withStair = true, sections = [6, 1, 6] } = {}) {
  const g = makeGrid([0, 1000, 2000, 3000], [0, 1000, 4000], { id });
  const keys = [g.cell(0, 0), g.cell(1, 0), g.cell(0, 1), g.cell(1, 1)];
  g.interior([[2, 1]]); // 階段の右隣の部屋（階段のセルは部屋に入れない＝階段所属で天井なし。上階の床も階段の外に残る）
  if (withStair) {
    const stair = g.graph.addStair({ type: StairType.SWITCHBACK, cells: new Set(keys), sections, flip: false, upDirection: 'up' });
    stair.structure = structure;
  }
  return g.graph;
}

function scene({ structure = WOOD, lowStair = true, lowSections = [6, 1, 6] } = {}) {
  const low = stairFloor('low', { structure, withStair: lowStair, sections: lowSections }), high = stairFloor('high', { structure });
  const layers = [fakeLayer({ graph: low }), fakeLayer({ graph: high, floorZMm: FL, role: 'above' })];
  const opts = { riserOf: () => 200, belowGraphOf: g => (g === high ? low : null), ceilings: true };
  return { low, high, layers, opts, abovePeek: { graph: high, floorHeightMm: FL, activePlaneId: low.plane.id } };
}

const soffitsOf = solids => solids.filter(s => s.source.kind === 'stairSoffit');
const treadsAt = (solids, z) => solids.filter(s => s.kind === 'stairTread' && s.source.layerFloorZ === z);
const upHoles = solids => solids.find(s => s.kind === 'floor' && s.source.layerFloorZ === FL).footprint.holes ?? [];

test('lookUp・木造: 上階の層に stairSoffit の立体が階段 1 本につき 1 件出る。段は従来どおり遮蔽専用（drawEdges:false）', () => {
  const { layers, opts } = scene();
  const solids = planSolids(layers, { ...opts, lookUp: true });
  const soffits = soffitsOf(solids);
  assert.equal(soffits.length, 1);
  assert.ok(soffits.every(s => s.kind === 'ceiling' && s.source.layerFloorZ === FL));
  assert.ok(treadsAt(solids, FL).length > 0 && treadsAt(solids, FL).every(s => s.drawEdges === false));
});

test('lookUp・鉄骨: 裏面は作らず、上階の続きの階段の段の輪郭を描く（drawEdges:true）。自階の段は遮蔽専用のまま', () => {
  const { layers, opts } = scene({ structure: STEEL });
  const solids = planSolids(layers, { ...opts, lookUp: true });
  assert.equal(soffitsOf(solids).length, 0);
  const upper = treadsAt(solids, FL);
  assert.ok(upper.length > 0 && upper.every(s => s.drawEdges === true));
  assert.ok(treadsAt(solids, 0).every(s => s.drawEdges === false), '自階の段は描かない（StairLayer が描く）');
});

test('lookUp でも、下階（自階）に同じ足元の階段が無ければ裏面も段の輪郭も出ない（失敗経路）', () => {
  for (const structure of [WOOD, STEEL]) {
    const { layers, opts } = scene({ structure, lowStair: false });
    const solids = planSolids(layers, { ...opts, lookUp: true });
    assert.equal(soffitsOf(solids).length, 0, structure);
    assert.ok(treadsAt(solids, FL).every(s => s.drawEdges === false), structure);
  }
  // belowGraphOf が無い（下階が渡らない）ときも同じ
  const { layers, opts } = scene();
  const none = planSolids(layers, { riserOf: opts.riserOf, ceilings: true, lookUp: true });
  assert.equal(soffitsOf(none).length, 0);
  // 裏面・穴と同じ入力で決める: belowGraphOf が無ければ自階の段も除かない（穴だけ・裏面だけ・段だけが食い違わない）
  assert.ok(treadsAt(none, 0).length > 0, 'belowGraphOf なしでは自階の段を除かない');
});

test('lookUp なし（見下げ・従来）は裏面を足さず、段は全部遮蔽専用。lookUp:false も省略と同じ出力', () => {
  for (const structure of [WOOD, STEEL]) {
    const { layers, opts } = scene({ structure });
    const plain = planSolids(layers, opts);
    assert.equal(soffitsOf(plain).length, 0);
    assert.ok(plain.filter(s => s.kind === 'stairTread').every(s => s.drawEdges === false));
    // 見下げの出力の不変そのものは dumpPlanSolids（引数なし）の golden とのバイト一致で担保する（ここは lookUp:false が省略と同じ経路なので比べても恒真）。
    // lookUp で変わるのは穴・裏面・鉄骨の段の輪郭・自階の続き階段の段（遮蔽から外す）だけ。自階の他の立体は同じ
    const up = planSolids(layers, { ...opts, lookUp: true });
    const selfNonTread = ss => ss.filter(s => s.source.layerFloorZ === 0 && s.kind !== 'stairTread');
    assert.deepEqual(selfNonTread(up), selfNonTread(plain));
  }
});

test('lookUp: 上階スラブの穴は続きの階段の足元全体。lookUp なしは破れ先だけ（従来）', () => {
  const { layers, opts } = scene();
  assert.equal(upHoles(planSolids(layers, { ...opts, lookUp: true })).length, 4, '階段の4セル全部');
  const plainHoles = upHoles(planSolids(layers, opts));
  assert.ok(plainHoles.length < 4, `従来は破れ先だけ: ${plainHoles.length}`);
});

test('見上げの線: 木造は stairSoffit の線が出て踏面線（stairTread）は出ない。裏面の線は天井見切りのグレー化の対象外', () => {
  const { low, abovePeek } = scene();
  const prims = planSolidsLayerPrimitivesUp({ graph: low, abovePeek, aboveRiserOf: () => 200, cutZ: CUT });
  const soffit = prims.filter(p => p.source.kind === 'stairSoffit');
  assert.ok(soffit.length > 0, '裏面の輪郭');
  assert.ok(soffit.every(p => p.kind === 'line' && p.cls === 'below' && p.weight === 'thin' && p.source.layerFloorZ === FL));
  assert.ok(soffit.every(p => p.style === undefined), 'ceilingBoundary にならない');
  assert.equal(prims.filter(p => p.source.kind === 'stairTread').length, 0);
});

test('見上げの線: 鉄骨は踏面線（stairTread）が全段の輪郭として出て、裏面（stairSoffit）は出ない', () => {
  const { low, abovePeek } = scene({ structure: STEEL });
  const prims = planSolidsLayerPrimitivesUp({ graph: low, abovePeek, aboveRiserOf: () => 200, cutZ: CUT });
  const treads = prims.filter(p => p.source.kind === 'stairTread');
  assert.ok(treads.length > 0 && treads.every(p => p.kind === 'line' && p.cls === 'below' && p.weight === 'thin' && p.source.layerFloorZ === FL));
  // 全段の踏面線: 線の part（段の番号）の集合が stairTreadFootprints の番号の集合と一致する（1 本以上ではなく全段）
  const high = abovePeek.graph;
  const numbers = stairTreadFootprints(high.stairs[0], high, { riser: 200, insetView: 'upper' }).map(t => t.number);
  assert.deepEqual([...new Set(treads.map(p => p.source.part))].sort((a, b) => a - b), numbers.sort((a, b) => a - b));
  assert.equal(prims.filter(p => p.source.kind === 'stairSoffit').length, 0);
});

test('lookUp: 自階の続き階段（上階の階段と足元が一致）の段は遮蔽に入れない。続きでない自階の階段の段は残る。上階が無ければ何も除かない', () => {
  const { layers, opts } = scene();
  assert.ok(treadsAt(planSolids(layers, opts), 0).length > 0, '前提: 見下げでは自階の段がある');
  assert.equal(treadsAt(planSolids(layers, { ...opts, lookUp: true }), 0).length, 0, '見上げでは続き階段の段は除く');
  // 上階の層が無い（自階だけ）なら除かない
  assert.ok(treadsAt(planSolids([layers[0]], { ...opts, lookUp: true }), 0).length > 0);
  // 足元が違う階段（上階に一致する階段が無い）は残る
  const g = makeGrid([0, 1000, 2000, 3000], [0, 1000, 4000, 5000], { id: 'other' });
  g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(0, 2)]), sections: [3], flip: false, upDirection: 'up' }).structure = WOOD;
  const withOther = [layers[0], fakeLayer({ graph: g.graph, floorZMm: 0 }), layers[1]];
  const kept = planSolids(withOther, { ...opts, lookUp: true }).filter(x => x.kind === 'stairTread' && x.source.layerFloorZ === 0);
  assert.ok(kept.some(x => x.source.id === String(g.graph.stairs[0].id)), '続きでない階段の段は残る');
});

/** 点 (x,y) が線分 [x1,y1,x2,y2] 上（1mm 以内）にあるか。 */
const onSegment = (x, y, [x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(Math.max(((x - x1) * dx + (y - y1) * dy) / len2, 0), 1);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) < 1;
};
const footprintEdges = fp => {
  const loops = fp.poly ? [fp.poly] : fp.rects.map(r => [r.x1, r.y1, r.x2, r.y1, r.x2, r.y2, r.x1, r.y2]);
  return loops.flatMap(p => p.map((_, i) => i).filter(i => i % 2 === 0).map(i => [p[i], p[i + 1], p[(i + 2) % p.length], p[(i + 3) % p.length]]));
};

test('見上げ・木造: 自階の続き階段の段が切断高より上にあっても、裏面の外周（矩形群の輪郭）が全部線として出る', () => {
  // 自階の階段は区画数が違う（[4,1,4]）ので、自階の段の辺と裏面の矩形の辺がぴったり重ならない（重なると偶然見えて検出力が無い）
  const { low, abovePeek } = scene({ lowSections: [4, 1, 4] });
  const prims = planSolidsLayerPrimitivesUp({ graph: low, abovePeek, aboveRiserOf: () => 200, cutZ: CUT });
  const soffitLines = prims.filter(p => p.source.kind === 'stairSoffit');
  const soffits = soffitsOf(planSolidsLayerSolidsUp({ graph: low, abovePeek, aboveRiserOf: () => 200 }));
  assert.equal(soffits.length, 1);
  // 矩形群の外周の辺 = 1 つの矩形の辺のうち、他の矩形の辺と共有されない部分。ここでは各辺の中点が他の矩形の内部に入らないものを外周とみなす
  const rects = soffits[0].footprint.rects;
  const insideOther = (x, y, self) => rects.some(r => r !== self && x > r.x1 + 1e-6 && x < r.x2 - 1e-6 && y > r.y1 + 1e-6 && y < r.y2 - 1e-6);
  const sharedEdge = (x, y, self) => rects.some(r => r !== self && onRectBoundary(x, y, r));
  let checked = 0;
  for (const r of rects) {
    for (const [x1, y1, x2, y2] of footprintEdges({ rects: [r] })) {
      const mid = [(x1 + x2) / 2, (y1 + y2) / 2];
      if (insideOther(...mid, r) || sharedEdge(...mid, r)) continue; // 同じ立体の矩形どうしの共有辺は輪郭ではない
      checked++;
      assert.ok(soffitLines.some(l => onSegment(...mid, l.points)), `外周の辺 (${x1},${y1})-(${x2},${y2}) の中点が線になる`);
    }
  }
  assert.ok(checked >= 6, `検出力: 外周の辺を ${checked} 本確かめた`);
});

/** 点が矩形の境界上（1mm 以内）にあるか。 */
const onRectBoundary = (x, y, r) => x >= r.x1 - 1 && x <= r.x2 + 1 && y >= r.y1 - 1 && y <= r.y2 + 1
  && (Math.abs(x - r.x1) < 1 || Math.abs(x - r.x2) < 1 || Math.abs(y - r.y1) < 1 || Math.abs(y - r.y2) < 1);

test('見上げの線: 往路と回転部の境（共有辺）の線は同じ座標に 1 本だけ（2 本の平行線・重複線が無い）。WINDING と SWITCHBACK の両方', () => {
  for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
    const sections = type === StairType.WINDING ? [5, 6, 5] : [6, 1, 6];
    const mk = id => {
      const g = makeGrid([0, 1000, 2000, 3000], [0, 1000, 4000], { id });
      g.interior([[2, 1]]);
      g.graph.addStair({ type, cells: new Set([g.cell(0, 0), g.cell(1, 0), g.cell(0, 1), g.cell(1, 1)]), sections, flip: false, upDirection: 'up' }).structure = WOOD;
      return g.graph;
    };
    const low = mk('low'), high = mk('high');
    const abovePeek = { graph: high, floorHeightMm: FL, activePlaneId: low.plane.id };
    const prims = planSolidsLayerPrimitivesUp({ graph: low, abovePeek, aboveRiserOf: () => 200, cutZ: CUT });
    const lines = prims.filter(p => p.source.kind === 'stairSoffit');
    assert.ok(lines.length > 0);
    // 同じ座標（端点の組。向き不問）の線が 2 本以上ないこと
    const keys = lines.map(l => { const [a, b, c, d] = l.points.map(v => Math.round(v)); return [[a, b], [c, d]].sort().join('|'); });
    assert.equal(new Set(keys).size, keys.length, `${type}: 重複線なし`);
    // 往路と回転部の境: 走行方向の座標 y=frontA（縦走行）上の線は、幅方向に重ならない（被覆の合計が重複を含まない）
    const L = uTurnPlanLayout(high.stairs[0], high);
    const onFront = lines.filter(l => l.points[1] === l.points[3] && Math.abs(l.points[1] - L.run.frontA) < 1);
    const spans = onFront.map(l => [Math.min(l.points[0], l.points[2]), Math.max(l.points[0], l.points[2])]).sort((p, q) => p[0] - q[0]);
    for (let k = 1; k < spans.length; k++) assert.ok(spans[k][0] >= spans[k - 1][1] - 1e-6, `${type}: frontA 上の線が重ならない ${JSON.stringify(spans)}`);
    const covered = spans.reduce((t, [a, b]) => t + (b - a), 0);
    assert.ok(Math.abs(covered - (L.across.s1 - L.across.s0)) < 1, `${type}: frontA の線は幅全体を 1 回ずつ覆う（${covered}）`);
    // あき 0（sA==sB）: 往路と復路の境（x=sA、run front〜base）の線が出る。高さが食い違う境で、輪郭には現れない（1 立体化で消えない）
    assert.ok(Math.abs(L.across.sA - L.across.sB) < 1, '前提: あき 0');
    const sideSpans = lines.filter(l => l.points[0] === l.points[2] && Math.abs(l.points[0] - L.across.sA) < 1 && Math.min(l.points[1], l.points[3]) >= Math.min(L.run.front, L.run.baseA) - 1 && Math.max(l.points[1], l.points[3]) <= Math.max(L.run.front, L.run.baseA) + 1)
      .map(l => [Math.min(l.points[1], l.points[3]), Math.max(l.points[1], l.points[3])]).sort((p, q) => p[0] - q[0]);
    const sideCovered = sideSpans.reduce((t, [p, q]) => t + (q - p), 0);
    assert.ok(Math.abs(sideCovered - Math.abs(L.run.baseA - L.run.front)) < 1, `${type}: x=sA の境の線が front〜baseA を覆う（${sideCovered}）`);
  }
});
