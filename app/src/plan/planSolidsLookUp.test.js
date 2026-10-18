// 見上げ（opts.lookUp）の階段上の裏面（S13a）: planSolids の配線と、解決後の線。実物の PlanGraph で組む（planSolids.test.js の流儀）。
// 上階の続きの階段が下階（自階）の階段と同じ足元のとき、木造は階段裏の傾斜天井（stairSoffit）、鉄骨は踏面線（stairTread の輪郭）を出す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType, StructuralMaterialType, CenterLineType, RoomFeature, edgeKey } from '@core';
import { planSolids, narrowOpeningByWalls } from './planSolids.js';
import { planSolidsLayerPrimitivesUp, planSolidsLayerSolidsUp } from './planSolidsLayerFilter.js';
import { uTurnPlanLayout } from '../finish/stair/stairGeometry.js';
import { stairTreadFootprints } from '../finish/stair/stairTreads.js';
import { makeGrid, fakeLayer, addBeamH, ARCH, assignZoneSpec } from './planTestFixtures.js';

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
  // 穴の縁（上階の床の穴の外形線上）に乗る線は中線（S3）、それ以外は細線
  assert.ok(soffit.every(p => p.kind === 'line' && p.cls === 'below' && (p.weight === 'thin' || p.weight === 'medium') && p.source.layerFloorZ === FL));
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
  // 穴の縁（見える穴の外形）に乗る裏面の線は、同じ座標の上階の床の線と 1 本に畳まれる（S3。先に出る床の線が持つ）ので床の線も数える
  const soffitLines = prims.filter(p => p.source.layerFloorZ === FL && (p.source.kind === 'stairSoffit' || p.source.kind === 'floor'));
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

test('見上げの線・隔て壁の柱あり（frontA≠front）: 前縁はレーンごと（往路の前縁は往路レーンだけ・復路の前縁は復路レーンだけ）。対角線はピボットから全長', () => {
  for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
    const mk = id => {
      const g = makeGrid([0, 1000, 2000, 3000], [0, 1000, 4000], { id });
      g.interior([[2, 1]]);
      g.graph.setStructureOverride('木造（在来）');
      g.graph.addStair({ type, cells: new Set([g.cell(0, 0), g.cell(1, 0), g.cell(0, 1), g.cell(1, 1)]), sections: type === StairType.WINDING ? [5, 6, 5] : [6, 1, 6], flip: false, upDirection: 'up' }).structure = WOOD;
      return g.graph;
    };
    const low = mk('low'), high = mk('high');
    const abovePeek = { graph: high, floorHeightMm: FL, activePlaneId: low.plane.id };
    const prims = planSolidsLayerPrimitivesUp({ graph: low, abovePeek, aboveRiserOf: () => 200, cutZ: CUT });
    const lines = prims.filter(p => p.source.kind === 'stairSoffit');
    const L = uTurnPlanLayout(high.stairs[0], high);
    assert.equal(L.hasColumn, true, `${type}: 前提: 柱あり`);
    assert.notEqual(L.run.frontA, L.run.front, `${type}: 前提: frontA≠front`);
    const { frontA, front } = L.run, pvv = L.pivotAcross;
    const horizAt = y => lines.filter(l => l.points[1] === l.points[3] && Math.abs(l.points[1] - y) < 1).map(l => [Math.min(l.points[0], l.points[2]), Math.max(l.points[0], l.points[2])]);
    const within = (spans, lo, hi) => spans.every(([a, b]) => a >= Math.min(lo, hi) - 1 && b <= Math.max(lo, hi) + 1);
    assert.ok(horizAt(frontA).length > 0 && horizAt(front).length > 0, `${type}: 往路・復路の前縁の線がある`);
    assert.ok(within(horizAt(frontA), L.across.s0, pvv), `${type}: 往路の前縁（y=${frontA}）の線は往路レーン側 [s0, pivot] だけ（復路レーンに出ない）`);
    assert.ok(within(horizAt(front), pvv, L.across.s1), `${type}: 復路の前縁（y=${front}）の線は復路レーン側 [pivot, s1] だけ（往路レーンに出ない）`);
    if (type === StairType.WINDING) { // 対角線はピボット P_A=(pivot, frontA)・P_B=(pivot, front) から外側の奥の角まで（端点がピボット）で、共線
      const O = [[L.across.s0, L.run.back, pvv, frontA], [L.across.s1, L.run.back, pvv, front]];
      for (const [ox, oy, px, py] of O) {
        const diag = lines.filter(l => [[0, 1], [2, 3]].some(([i, k]) => Math.hypot(l.points[i] - ox, l.points[k] - oy) < 1));
        assert.ok(diag.length > 0, `${type}: 外側の奥の角 (${ox},${oy}) から出る線`);
        const hit = diag.some(l => {
          const [qx, qy] = Math.hypot(l.points[0] - ox, l.points[1] - oy) < 1 ? [l.points[2], l.points[3]] : [l.points[0], l.points[1]];
          return Math.hypot(qx - px, qy - py) < 1; // 反対側の端点がピボット（全長）
        });
        assert.ok(hit, `${type}: 対角線がピボット (${px},${py}) から始まる`);
      }
    }
  }
});


// ---- 天井面の縁＝囲む壁の面（セル境界の通り芯ではない）

/**
 * 格子 xs × y 0..3000 に部屋を置き、graph.walls を壁の代役（芯 CL・帯・区間）で差し替えた自階の層で見上げの天井を解く。
 * walls は配列か (g) => 配列（実 CL が要るとき）。rooms は部屋ごとのセル [i,j] の配列（省略＝(0,0) の 1 部屋）。
 * 戻り値: {g, rooms, solids（ceiling の立体）, rectsOf(room)}。
 */
function ceilingScene(walls, { xs = [0, 2000], ys = [0, 3000], rooms: roomCells = [[[0, 0]]], setup } = {}) {
  const g = makeGrid(xs, ys);
  const rooms = roomCells.map(cells => g.interior(cells));
  setup?.(g, rooms);
  const graph = Object.create(g.graph);
  const list = typeof walls === 'function' ? walls(g) : walls;
  Object.defineProperty(graph, 'walls', {
    value: list.map(({ id, isVertical = true, axis = 'A', axisCL, band, span = [-100, 3100] }) => ({
      id, isVertical, axisCL: axisCL ?? { id: axis }, coord1: span[0], coord2: span[1],
      materialRange: band ? { lo: band[0], hi: band[1] } : null, backingRange: null,
    })),
  });
  const solids = planSolids([fakeLayer({ graph })], { ceilings: true, lookUp: true }).filter(s => s.kind === 'ceiling');
  return { g, rooms, solids, rectsOf: room => solids.find(s => s.source.id === room.id)?.footprint.rects };
}
const rectsOf1 = (walls, opts) => ceilingScene(walls, opts).solids.map(s => s.footprint.rects);
const CELL = [{ x1: 0, y1: 0, x2: 2000, y2: 3000 }];

test('天井の縁: セルの縁に寄った偏芯壁（帯がセル内側）では、天井面が壁の外面で止まる（縁との間の細片を除く）', () => {
  assert.deepEqual(rectsOf1([{ id: 'w', band: [1800, 1950] }]), [[{ x1: 0, y1: 0, x2: 1950, y2: 3000 }]]);
  assert.deepEqual(rectsOf1([{ id: 'w', isVertical: false, band: [2800, 2950], span: [-100, 2100] }]), [[{ x1: 0, y1: 0, x2: 2000, y2: 2950 }]]);
  assert.deepEqual(rectsOf1([{ id: 'w', band: [50, 200] }]), [[{ x1: 50, y1: 0, x2: 2000, y2: 3000 }]], '左の縁');
});

test('天井の縁: 芯振り分けの壁（帯が縁をまたぐ）・縁から 150 超離れた壁は不変', () => {
  assert.deepEqual(rectsOf1([{ id: 'w', band: [1942.5, 2057.5] }]), [CELL]);
  assert.deepEqual(rectsOf1([{ id: 'w', band: [1700, 1800] }]), [CELL], '縁との間 200');
  assert.deepEqual(rectsOf1([]), [CELL], '壁なし');
});

test('天井の縁: 同じ芯の下地の壁＋仕上げの薄壁（2 レコード）は 1 本に結合し、外側の面で止まる（薄壁の面では止まらない）', () => {
  const rects = rectsOf1([
    { id: 'thin', band: [1850, 1862.5] }, // 内側の薄壁
    { id: 'owner', band: [1862.5, 1950] }, // 下地オーナー壁
  ]);
  assert.deepEqual(rects, [[{ x1: 0, y1: 0, x2: 1950, y2: 3000 }]]);
  // 芯が違えば結合しない（別の壁の帯）。ただし削る帯状の矩形から壁の帯の和を除くので、接する別の壁の帯の下は削らず、結果は同じ 1950
  const sep = rectsOf1([{ id: 'a', axis: 'A', band: [1850, 1862.5] }, { id: 'b', axis: 'B', band: [1862.5, 1950] }]);
  assert.deepEqual(sep, [[{ x1: 0, y1: 0, x2: 1950, y2: 3000 }]]);
});

test('天井の縁: 同じ芯でも along が離れた壁は結合しない（それぞれの along だけ止める）', () => {
  assert.deepEqual(rectsOf1([{ id: 'a', band: [1800, 1950], span: [-100, 1000] }, { id: 'b', band: [1800, 1950], span: [2000, 3100] }]), [[
    { x1: 0, y1: 0, x2: 1950, y2: 1000 }, { x1: 0, y1: 1000, x2: 2000, y2: 2000 }, { x1: 0, y1: 2000, x2: 1950, y2: 3000 },
  ]]);
  // 遠い壁と結合して along が伸びないこと（結合していれば y 全体が削れる）
  assert.deepEqual(rectsOf1([{ id: 'a', band: [1800, 1950], span: [0, 500] }, { id: 'b', band: [1800, 1950], span: [8000, 9000] }]), [[
    { x1: 0, y1: 0, x2: 1950, y2: 500 }, { x1: 0, y1: 500, x2: 2000, y2: 3000 },
  ]]);
});

test('天井の縁: 壁が一部の along だけ覆うときは、その範囲の細片だけを除く', () => {
  assert.deepEqual(rectsOf1([{ id: 'w', band: [1800, 1950], span: [1000, 2000] }]), [[
    { x1: 0, y1: 0, x2: 2000, y2: 1000 }, { x1: 0, y1: 1000, x2: 1950, y2: 2000 }, { x1: 0, y1: 2000, x2: 2000, y2: 3000 },
  ]]);
});

test('天井の縁: 両縁が同時に条件を満たす壁（帯が矩形の中で両側とも 150 以下）は両側とも削る', () => {
  assert.deepEqual(rectsOf1([{ id: 'w', band: [100, 1900] }]), [[{ x1: 100, y1: 0, x2: 1900, y2: 3000 }]]);
});

test('【失敗系】天井の縁: conceal range の無い壁・帯の幅 0・座標が NaN の壁・along が矩形と重ならない壁は無視する', () => {
  assert.deepEqual(rectsOf1([{ id: 'w', band: null }]), [CELL]);
  assert.deepEqual(rectsOf1([{ id: 'w', band: [1900, 1900] }]), [CELL], '帯の幅 0');
  assert.deepEqual(rectsOf1([{ id: 'w', band: [1800, 1950], span: [NaN, 3100] }]), [CELL], 'coord1=NaN');
  assert.deepEqual(rectsOf1([{ id: 'w', band: [1800, 1950], span: [3500, 5000] }]), [CELL]);
});

test('【失敗系】天井の縁: 全部削れた面は立体を出さない', () => {
  // 幅 100 のセルの中央に極薄の帯: 両側の細片で面が残らない
  assert.deepEqual(ceilingScene([{ id: 'w', band: [50, 50.0000005] }], { xs: [0, 100] }).solids, []);
});

test('【失敗系】天井の縁: 腰壁だけの区間（drop なし）は天井を隔てないので帯にしない。垂れ壁（drop）を持つ区間は帯にする', () => {
  const make = rec => rectsOf1(g => {
    const axisCL = g.graph.addCenterLine(CenterLineType.VERTICAL, 9000, ARCH, 'ax');
    g.graph.setKneeDropWall(edgeKey(axisCL.id, g.cy[0].id, g.cy[1].id), rec);
    return [{ id: 'w', axisCL, band: [1800, 1950], span: [0, 3000] }];
  });
  assert.deepEqual(make({ knee: { topHeight: 800 } }), [CELL], '腰壁だけ');
  assert.deepEqual(make({ drop: { bottomHeight: 600 } }), [[{ x1: 0, y1: 0, x2: 1950, y2: 3000 }]], '垂れ壁');
  assert.deepEqual(make({ knee: { topHeight: 800 }, drop: { bottomHeight: 600 } }), [[{ x1: 0, y1: 0, x2: 1950, y2: 3000 }]], '同時指定は全高');
});

test('天井の縁: 傾斜天井は縁を削っても zAt の基準は元の矩形のまま（削った面の内側で z は不変）', () => {
  const slope = (g, [room]) => room.setCeilingZones(assignZoneSpec(g.graph, room, [g.cell(0, 0)], { heightMm: 2300, shape: 'slope', dims: [1200, 0] }));
  const plain = ceilingScene([], { setup: slope }).solids[0];
  const trimmed = ceilingScene([{ id: 'w', band: [1800, 1950] }], { setup: slope }).solids[0];
  assert.ok(plain.zAt && trimmed.zAt, '傾斜は zAt を持つ');
  assert.deepEqual(trimmed.footprint.rects, [{ x1: 0, y1: 0, x2: 1950, y2: 3000 }]);
  for (const [x, y] of [[100, 100], [1000, 1500], [1900, 2900]]) assert.equal(trimmed.zAt(x, y), plain.zAt(x, y), `(${x},${y})`);
  assert.equal(trimmed.zHi, plain.zHi);
});

// ---- 削るだけ（向こう側の天井面はセル境界のまま。既知の限界）

/** 矩形群が互いに重ならない（面積のある重なりが無い）か。 */
const disjoint = rs => rs.every((a, i) => rs.every((b, j) => i >= j
  || !(Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 1e-6 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 1e-6)));

test('天井の縁: 隣り合う 2 部屋で帯が左の部屋の縁に寄るとき、削るのは左の部屋だけ（右の部屋は不変）。全天井の矩形は重ならない', () => {
  const sc = ceilingScene([{ id: 'w', band: [1800, 1950] }], { xs: [0, 2000, 4000], rooms: [[[0, 0]], [[1, 0]]] });
  assert.deepEqual(sc.rectsOf(sc.rooms[0]), [{ x1: 0, y1: 0, x2: 1950, y2: 3000 }]);
  assert.deepEqual(sc.rectsOf(sc.rooms[1]), [{ x1: 2000, y1: 0, x2: 4000, y2: 3000 }]);
  assert.ok(disjoint(sc.solids.flatMap(s => s.footprint.rects)));
});

test('天井の縁: 直交する偏芯壁 2 本（2×2 の 4 部屋）の隅は、削る側の部屋だけが変わり、矩形は重ならない', () => {
  const sc = ceilingScene([
    { id: 'v', band: [1800, 1950], span: [0, 6000] },
    { id: 'h', isVertical: false, axis: 'H', band: [2800, 2950], span: [0, 4000] },
  ], { xs: [0, 2000, 4000], ys: [0, 3000, 6000], rooms: [[[0, 0]], [[1, 0]], [[0, 1]], [[1, 1]]] });
  const [a, b, c, d] = sc.rooms;
  // 左上: 右と下の両方の縁を削るが、削る帯状の矩形から壁の帯の和を除く（壁の下は壁が隠すので削らない）ため、
  // 横壁の帯の中（y 2800..2950）の右縁と、縦壁の帯の中（x 1800..1950）の下縁は残る
  assert.deepEqual(sc.rectsOf(a), [
    { x1: 0, y1: 0, x2: 1950, y2: 2800 }, { x1: 0, y1: 2800, x2: 2000, y2: 2950 }, { x1: 1800, y1: 2950, x2: 1950, y2: 3000 },
  ], '左上');
  assert.deepEqual(sc.rectsOf(b), [{ x1: 2000, y1: 0, x2: 4000, y2: 2950 }], '右上: 下の縁だけ');
  assert.deepEqual(sc.rectsOf(c), [{ x1: 0, y1: 3000, x2: 1950, y2: 6000 }], '左下: 右の縁だけ');
  assert.deepEqual(sc.rectsOf(d), [{ x1: 2000, y1: 3000, x2: 4000, y2: 6000 }], '右下: 不変');
  assert.ok(disjoint(sc.solids.flatMap(s => s.footprint.rects)));
});

test('天井の縁: along が端で接するだけの 2 本（芯が同じで across が違う）は結合せず、それぞれの区間の面で止まる（外接矩形にしない）', () => {
  assert.deepEqual(rectsOf1([
    { id: 'a', band: [1800, 1950], span: [0, 1000] },
    { id: 'b', band: [1700, 1850], span: [1000, 3000] },
  ]), [[{ x1: 0, y1: 0, x2: 1950, y2: 1000 }, { x1: 0, y1: 1000, x2: 1850, y2: 3000 }]]);
});

test('天井の縁: 傾斜天井の marks は削った面の中に置く（zAt は元の矩形基準）', () => {
  const slope = (g, [room]) => room.setCeilingZones(assignZoneSpec(g.graph, room, [g.cell(0, 0)], { heightMm: 2300, shape: 'slope', dims: [1200, 0] }));
  const plain = ceilingScene([], { setup: slope }).solids[0];
  const trimmed = ceilingScene([{ id: 'w', band: [1800, 1950] }], { setup: slope }).solids[0];
  assert.ok(plain.marks?.length > 0 && trimmed.marks?.length > 0, '傾斜は marks を持つ');
  const [r] = trimmed.footprint.rects;
  for (const { anchor } of trimmed.marks) assert.ok(anchor.x > r.x1 && anchor.x < r.x2 && anchor.y > r.y1 && anchor.y < r.y2, '削った面の中');
  assert.ok(trimmed.marks[0].anchor.x < plain.marks[0].anchor.x, '削った面の中心へ寄る');
});

test('天井の縁: 角の取り合いで、薄壁だけの区間の帯が直交壁の帯の中に入るときは削らない（壁の下は壁が隠す。切欠きを作らない）', () => {
  // moku1-6 3階の簡略配置: セル x 7280..8190 × y −5460..−3640。縦の薄壁 帯 [7340,7352.5]（along −7207.5..−5387.5）と
  // 同じ芯の下地 帯 [7207.5,7340]（along −7352.5..−5532.5）、横壁 帯 y [−5520,−5387.5]（x 7207.5..8117.5）が角を作る
  const cell = [{ x1: 7280, y1: -5460, x2: 8190, y2: -3640 }];
  assert.deepEqual(rectsOf1([
    { id: 'thin', axis: 'V', band: [7340, 7352.5], span: [-7207.5, -5387.5] },
    { id: 'owner', axis: 'V', band: [7207.5, 7340], span: [-7352.5, -5532.5] },
    { id: 'h', isVertical: false, axis: 'H', band: [-5520, -5387.5], span: [7207.5, 8117.5] },
  ], { xs: [7280, 8190], ys: [-5460, -3640] }), [cell]);
  // 横壁が無ければ、薄壁だけの区間の帯は縁に寄っているので従来どおり削る
  assert.deepEqual(rectsOf1([
    { id: 'thin', axis: 'V', band: [7340, 7352.5], span: [-7207.5, -5387.5] },
    { id: 'owner', axis: 'V', band: [7207.5, 7340], span: [-7352.5, -5532.5] },
  ], { xs: [7280, 8190], ys: [-5460, -3640] }), [[
    { x1: 7340, y1: -5460, x2: 8190, y2: -5387.5 }, { x1: 7280, y1: -5387.5, x2: 8190, y2: -3640 },
  ]]);
});

test('天井の縁: 13 相当（2a 壁 帯 [−1665,−1550]。直交する帯が x>−1550 を覆わない）では従来どおり −1550 で止まる', () => {
  assert.deepEqual(rectsOf1([
    { id: 'wall2a', axis: 'V', band: [-1665, -1550], span: [-6012.5, -3442.5] },
    { id: 'h', isVertical: false, axis: 'H', band: [-6012.5, -5897.5], span: [-3000, -1550] },
  ], { xs: [-3000, -1500], ys: [-6000, -3500] }), [[{ x1: -3000, y1: -6000, x2: -1550, y2: -3500 }]]);
});

test('天井の縁: 同じ芯・同じ along で across が離れた 2 帯は結合しない（外接の帯にすると縁をまたいで削られなくなる配置）', () => {
  // 帯 [-50,50]（セルの左縁をまたぐ＝削らない）と [1850,1950]（右縁に寄る＝1950 で止める）。across を外接で [-50,1950] にまとめると
  // 縁をまたぐ帯になって右も削られず CELL のままになる
  assert.deepEqual(rectsOf1([
    { id: 'a', axis: 'A', band: [-50, 50] },
    { id: 'b', axis: 'A', band: [1850, 1950] },
  ]), [[{ x1: 0, y1: 0, x2: 1950, y2: 3000 }]]);
});

test('天井の縁: 同じ芯・同じ帯で along が接する 2 レコード（[0,1000] と [1000,3000]）は 1 本に戻り、面は矩形 1 個', () => {
  assert.deepEqual(rectsOf1([
    { id: 'a', axis: 'A', band: [1800, 1950], span: [0, 1000] },
    { id: 'b', axis: 'A', band: [1800, 1950], span: [1000, 3000] },
  ]), [[{ x1: 0, y1: 0, x2: 1950, y2: 3000 }]]);
});


// ---- 規則 V: N の天井の穴＝N+1 の床の穴（void・shaft）。梁は天伏に描かない

/** 下階: xs×[0,3000] の 1 部屋（全セル）。上階: ys=[0,1500,3000] の同じ xs。upSetup(g) で上階に部屋を足す。 */
function holeScene(upSetup, { withUpper = true, lowCells = [[0, 0], [1, 0]] } = {}) {
  const xs = [0, 1000, 2000];
  const low = makeGrid(xs, [0, 3000], { id: 'hl' });
  low.interior(lowCells);
  const layers = [fakeLayer({ graph: low.graph })];
  let up = null;
  if (withUpper) {
    up = makeGrid(xs, [0, 1500, 3000], { id: 'hu' });
    upSetup?.(up);
    layers.push(fakeLayer({ graph: up.graph, floorZMm: FL, role: 'above' }));
  }
  const all = planSolids(layers, { ceilings: true, lookUp: true });
  return { low, up, all, ceilings: all.filter(s => s.kind === 'ceiling') };
}
const area = rs => rs.reduce((s, r) => s + (r.x2 - r.x1) * (r.y2 - r.y1), 0);
const FULL = [{ x1: 0, y1: 0, x2: 2000, y2: 3000 }];

test('規則 V: 直上階の吹抜け（VOID）の矩形が天井面から除かれる（残りは矩形群）', () => {
  const { ceilings } = holeScene(up => up.feature([[0, 0], [0, 1]], RoomFeature.VOID));
  assert.equal(ceilings.length, 1);
  assert.equal(area(ceilings[0].footprint.rects), 2000 * 3000 - 1000 * 3000);
  assert.ok(ceilings[0].footprint.rects.every(r => r.x1 >= 1000), '穴の x 0..1000 は残らない');
});

test('規則 V: 直上階の昇降路（shaft）も同じ', () => {
  const { ceilings } = holeScene(up => up.feature([[0, 0], [0, 1]], RoomFeature.ELEVATOR_EQUIPMENT));
  assert.equal(area(ceilings[0].footprint.rects), 2000 * 3000 - 1000 * 3000);
});

test('規則 V: 直上階が階段吹抜け（STAIR_VOID）なら天井は除かない', () => {
  const { ceilings } = holeScene(up => up.feature([[0, 0], [0, 1]], RoomFeature.STAIR_VOID));
  assert.equal(area(ceilings[0].footprint.rects), 2000 * 3000);
});

test('【失敗系】規則 V: 上階の層が無い・上階に部屋が無いときは天井面は不変', () => {
  assert.equal(area(holeScene(null, { withUpper: false }).ceilings[0].footprint.rects), area(FULL));
  assert.equal(area(holeScene(null).ceilings[0].footprint.rects), area(FULL));
});

test('規則 V: 穴が天井面の一部だけに重なるとき、残りの矩形は重ならず面積は穴の分だけ減る', () => {
  const { ceilings } = holeScene(up => up.feature([[0, 0]], RoomFeature.VOID)); // x 0..1000 × y 0..1500
  const rs = ceilings[0].footprint.rects;
  assert.equal(area(rs), 2000 * 3000 - 1000 * 1500);
  assert.ok(rs.every((a, i) => rs.every((b, j) => i >= j
    || a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1)), '矩形が重ならない');
  assert.ok(rs.every(r => !(r.x1 < 1000 && r.y1 < 1500)), '穴の中に残らない');
});

test('【失敗系】規則 V: 直上階の VOID が自階の天井の無い所にだけあるとき天井面は不変', () => {
  const { ceilings } = holeScene(up => up.feature([[1, 0], [1, 1]], RoomFeature.VOID), { lowCells: [[0, 0]] });
  assert.equal(area(ceilings[0].footprint.rects), 1000 * 3000);
});

test('規則 V: L 字の VOID（3 セル・非矩形）は全部抜ける', () => {
  const { ceilings } = holeScene(up => up.feature([[0, 0], [0, 1], [1, 0]], RoomFeature.VOID));
  const rs = ceilings[0].footprint.rects;
  assert.equal(area(rs), 2000 * 3000 - 3 * 1000 * 1500);
  const cells = [[0, 0, 1000, 1500], [0, 1500, 1000, 3000], [1000, 0, 2000, 1500]];
  assert.ok(rs.every(r => cells.every(([x1, y1, x2, y2]) => r.x2 <= x1 || x2 <= r.x1 || r.y2 <= y1 || y2 <= r.y1)), 'どのセルの中にも残らない');
});

test('見上げ: 上階の層の梁は立体にしない。自階の梁は残る。見下げ（lookUp なし）は上階の梁も残る（従来）', () => {
  const beams = (all, z) => all.filter(s => s.kind === 'beam' && s.source.layerFloorZ === z);
  const mk = lookUp => {
    const low = makeGrid([0, 2000], [0, 3000], { id: 'bl' }), up = makeGrid([0, 2000], [0, 3000], { id: 'bu' });
    addBeamH(low.graph); addBeamH(up.graph);
    const layers = [fakeLayer({ graph: low.graph }), fakeLayer({ graph: up.graph, floorZMm: FL, role: 'above' })];
    return planSolids(layers, lookUp ? { lookUp: true } : {});
  };
  const upv = mk(true), down = mk(false);
  assert.equal(beams(upv, FL).length, 0, '見上げの上階の梁');
  assert.ok(beams(upv, 0).length > 0, '見上げの自階の梁');
  assert.ok(beams(down, FL).length > 0, '見下げの上階の梁');
});


// ---- S3: 上階の穴の縁＝穴に張り出す壁の面。自階の天井面は張り出しの面まで延びる

/**
 * 下階: 部屋 A（セル 0,0 = x 0..2000）と部屋 B（セル 1,0 = x 2000..4000）、y 0..3000。上階: セル (1,0) が吹抜け（穴 x 2000..4000）。
 * 上階の壁は walls（ceilingScene と同じ代役。実 CL が要るときは (g) => 配列）で差し替える。B の天井は規則 V で全面が抜ける。
 */
function overhangScene(walls, { lookUp = true } = {}) {
  const low = makeGrid([0, 2000, 4000], [0, 3000], { id: 'ol' });
  const roomA = low.interior([[0, 0]]), roomB = low.interior([[1, 0]]);
  const up = makeGrid([0, 2000, 4000], [0, 3000], { id: 'ou' });
  up.feature([[1, 0]], RoomFeature.VOID);
  const list = typeof walls === 'function' ? walls(up) : walls;
  const graph = Object.create(up.graph);
  Object.defineProperty(graph, 'walls', {
    value: list.map(({ id, isVertical = true, axis = 'A', axisCL, band, span = [-100, 3100] }) => ({
      id, isVertical, axisCL: axisCL ?? { id: axis }, coord1: span[0], coord2: span[1],
      materialRange: band ? { lo: band[0], hi: band[1] } : null, backingRange: null,
    })),
  });
  const layers = [fakeLayer({ graph: low.graph }), fakeLayer({ graph, floorZMm: FL, role: 'above' })];
  const all = planSolids(layers, { ceilings: true, ...(lookUp ? { lookUp: true } : {}) });
  const upFloor = all.find(s => s.kind === 'floor' && s.source.layerFloorZ === FL);
  return { all, upFloor, holes: upFloor.footprint.holes, rectsOf: room => all.find(s => s.kind === 'ceiling' && s.source.id === room.id)?.footprint.rects, roomA, roomB };
}
const HOLE_B = { x1: 2000, y1: 0, x2: 4000, y2: 3000 };

test('S3: 穴の縁に乗る上階の壁（帯が縁をまたぐ）で、床の穴が壁の面まで狭まる。床の rects は不変。自階の天井面が張り出しの面まで延びる', () => {
  const s = overhangScene([{ id: 'w', band: [1942.5, 2057.5] }]);
  assert.deepEqual(s.holes, [{ x1: 2057.5, y1: 0, x2: 4000, y2: 3000 }]);
  const a = s.rectsOf(s.roomA);
  assert.equal(area(a), 2000 * 3000 + 57.5 * 3000);
  assert.ok(a.some(r => r.x1 === 2000 && r.x2 === 2057.5 && r.y1 === 0 && r.y2 === 3000), '穴の中の張り出し分が A の面へ');
  assert.equal(s.rectsOf(s.roomB), undefined, 'B の天井は規則 V で全面が抜けたまま');
});

test('S3: 腰壁だけの帯も張り出しになる（fullHeightOnly:false。天井の縁 S1 は腰壁を帯にしない）', () => {
  const s = overhangScene(g => {
    const axisCL = g.graph.addCenterLine(CenterLineType.VERTICAL, 9000, ARCH, 'ax');
    g.graph.setKneeDropWall(edgeKey(axisCL.id, g.cy[0].id, g.cy[1].id), { knee: { topHeight: 800 } });
    return [{ id: 'w', axisCL, band: [1942.5, 2057.5], span: [0, 3000] }];
  });
  assert.deepEqual(s.holes, [{ x1: 2057.5, y1: 0, x2: 4000, y2: 3000 }]);
});

test('S3: 帯が穴の中に収まる壁は縁ではないので無視する（穴・天井面とも不変）', () => {
  const s = overhangScene([{ id: 'w', band: [2500, 2600], span: [500, 2500] }]);
  assert.deepEqual(s.holes, [HOLE_B]);
  assert.equal(area(s.rectsOf(s.roomA)), 2000 * 3000);
});

test('【失敗系】S3: 上階の層が無い・上階に壁が無い・conceal range の無い壁は S2 までと同じ出力', () => {
  assert.deepEqual(overhangScene([]).holes, [HOLE_B]);
  assert.deepEqual(overhangScene([{ id: 'w', band: null }]).holes, [HOLE_B]);
  assert.deepEqual(overhangScene([{ id: 'w', band: [1942.5, 2057.5], span: [NaN, 3100] }]).holes, [HOLE_B], '座標が NaN');
  const { ceilings } = holeScene(null, { withUpper: false });
  assert.equal(area(ceilings[0].footprint.rects), area(FULL));
});

test('S3: 見下げ（lookUp なし）は穴も天井面も触らない', () => {
  const s = overhangScene([{ id: 'w', band: [1942.5, 2057.5] }], { lookUp: false });
  assert.deepEqual(s.holes, [HOLE_B]);
  assert.equal(area(s.rectsOf(s.roomA)), 2000 * 3000);
});

/** narrowOpeningByWalls へ直接渡す入力（穴 H = 0..1000 の正方形、床は H を含む）。walls は {axis, isVertical, band, span}。 */
const H = { x1: 0, y1: 0, x2: 1000, y2: 1000 };
function narrowOf(walls, ceilings = []) {
  const upperFloor = { kind: 'floor', footprint: { rects: [{ x1: -1000, y1: -1000, x2: 2000, y2: 2000 }], holes: [H] } };
  const graph = {
    walls: walls.map(({ id, isVertical, band, span }) => ({
      id, isVertical, axisCL: { id }, coord1: span[0], coord2: span[1], materialRange: { lo: band[0], hi: band[1] }, backingRange: null,
    })),
  };
  return narrowOpeningByWalls(upperFloor, graph, ceilings.map(rects => ({ kind: 'ceiling', footprint: { rects } })));
}
const holeArea = r => area(r.floor.footprint.holes ?? []);
const HW = (id, span, band = [-50, 50]) => ({ id, isVertical: false, band, span }); // y 帯の横壁
const VW = (id, span, band = [-50, 50]) => ({ id, isVertical: true, band, span }); // x 帯の縦壁

test('S3 すき間閉じ: 端の先が穴の和の中で、帯も天井面も無ければ穴の縁まで延ばす（150 以内）。150 超は延ばさない', () => {
  assert.equal(holeArea(narrowOf([HW('w', [100, 900])])), 1e6 - 1000 * 50, '両端とも 100 → 穴の縁まで');
  assert.equal(holeArea(narrowOf([HW('w', [150, 850])])), 1e6 - 1000 * 50, 'ちょうど 150 は延ばす');
  assert.equal(holeArea(narrowOf([HW('w', [151, 849])])), 1e6 - 698 * 50, '151 は延ばさない');
  assert.equal(holeArea(narrowOf([HW('w', [400, 600])])), 1e6 - 200 * 50, '400 は延ばさない');
});

test('S3 すき間閉じ: 途中に自階の天井面の縁があればそこで止まる。先が他の帯なら延ばさない', () => {
  // 左の端 100 の先 60 に天井面（x 0..60）の縁: 60 まで（40 延びる）。右は穴の縁（1000）まで
  const f = narrowOf([HW('w', [100, 900])], [[{ x1: 0, y1: -200, x2: 60, y2: 200 }]]);
  assert.equal(holeArea(f), 1e6 - (1000 - 60) * 50);
  // 右の端 900 に接して縦壁の帯（x 900..940）: 横壁の右は延びず（左は穴の縁 0 まで延びる）、縦壁の張り出し [900..940]×[0..1000] と重ならない
  const g = narrowOf([HW('w', [100, 900]), VW('v', [-100, 1100], [900, 940])]);
  assert.equal(holeArea(g), 1e6 - (900 * 50 + 40 * 1000));
});

test('S3 天井面の延長: 張り出しが接する穴の縁の外側の面へ、重なり分の帯状矩形を足す。接する面が無ければ足さない', () => {
  const west = { x1: -1000, y1: -1000, x2: 0, y2: 1000 };
  const r = narrowOf([VW('v', [-500, 1500])], [[west]]); // strip [0..50]×[0..1000]
  assert.deepEqual(r.floor.footprint.holes, [{ x1: 50, y1: 0, x2: 1000, y2: 1000 }]);
  assert.deepEqual(r.ceilings[0].footprint.rects, [west, { x1: 0, y1: 0, x2: 50, y2: 1000 }]);
  // 縁に接しない面（x2=-100）・穴の反対側の面だけ → 足さない（穴だけ狭まる）
  const none = narrowOf([VW('v', [-500, 1500])], [[{ x1: -1000, y1: -1000, x2: -100, y2: 1000 }]]);
  assert.deepEqual(none.ceilings[0].footprint.rects, [{ x1: -1000, y1: -1000, x2: -100, y2: 1000 }]);
  assert.deepEqual(none.floor.footprint.holes, [{ x1: 50, y1: 0, x2: 1000, y2: 1000 }]);
});

test('S3 天井面の延長: 面の既存の矩形と重なる分は足さない（面内に重なりを作らない）', () => {
  const west = { x1: -1000, y1: -1000, x2: 0, y2: 1000 };
  const already = { x1: 0, y1: 0, x2: 30, y2: 500 };
  const r = narrowOf([VW('v', [-500, 1500])], [[west, already]]);
  const rs = r.ceilings[0].footprint.rects;
  assert.equal(area(rs), area([west, already]) + 50 * 1000 - 30 * 500);
  assert.ok(disjoint(rs), '面内で重ならない');
});

test('S3 角: 直交する 2 枚の張り出しの piece は、2 つの面に足しても重ならない', () => {
  const west = { x1: -1000, y1: -1000, x2: 0, y2: 1000 }, north = { x1: 0, y1: -1000, x2: 2000, y2: 0 };
  const r = narrowOf([VW('v', [-500, 1500]), HW('h', [-500, 1500])], [[west], [north]]);
  const added = r.ceilings[0].footprint.rects.slice(1).concat(r.ceilings[1].footprint.rects.slice(1));
  assert.equal(area(added), 50 * 1000 + (1000 * 50 - 50 * 50), '縦の張り出し（西の面）＋横の張り出しから角を除いた分（北の面）');
  assert.ok(disjoint(added), '2 つの面の piece が重ならない');
});

test('S3: 重なった穴（2 つの穴が重なる）でも、穴をまたいで外へ出る帯を「収まる」と判定しない', () => {
  const holes = [H, { x1: 500, y1: 0, x2: 1500, y2: 1000 }];
  const upperFloor = { kind: 'floor', footprint: { rects: [{ x1: -1000, y1: -1000, x2: 2000, y2: 2000 }], holes } };
  const wall = { id: 'v', isVertical: true, axisCL: { id: 'v' }, coord1: -100, coord2: 1100, materialRange: { lo: 900, hi: 940 }, backingRange: null };
  const r = narrowOpeningByWalls(upperFloor, { walls: [wall] }, []);
  assert.notEqual(r.floor, upperFloor, '帯は穴の外（y<0・y>1000）へ出るので張り出し');
  assert.ok(!r.floor.footprint.holes.some(h => h.x1 < 920 && h.x2 > 920 && h.y1 < 500 && h.y2 > 500), '帯の中は穴から除かれる');
});

test('S3 受容の固定: 縁から穴へ突き出す直交壁（壁端）は穴の切欠きになる（その輪郭は見える穴の縁＝中線になる）', () => {
  const r = narrowOf([HW('w', [-500, 300], [400, 450])]); // y 400..450 の横壁が x=0 の縁から穴の中へ x=300 まで
  assert.equal(holeArea(r), 1e6 - 300 * 50);
  const inHole = (x, y) => r.floor.footprint.holes.some(h => x > h.x1 && x < h.x2 && y > h.y1 && y < h.y2);
  assert.ok(!inHole(150, 425) && inHole(150, 100) && inHole(500, 425));
});

test('【失敗系】S3: 穴が無い・壁が無い床は同じオブジェクトを返す（入力を変更しない）', () => {
  const rects = [{ x1: 0, y1: 0, x2: 10, y2: 10 }];
  const noHole = { kind: 'floor', footprint: { rects } };
  const c = [{ kind: 'ceiling', footprint: { rects } }];
  const r1 = narrowOpeningByWalls(noHole, { walls: [] }, c);
  assert.equal(r1.floor, noHole);
  assert.equal(r1.ceilings, c);
  const withHole = { kind: 'floor', footprint: { rects, holes: [H] } };
  const r2 = narrowOpeningByWalls(withHole, { walls: [] }, c);
  assert.equal(r2.floor, withHole);
  assert.equal(narrowOpeningByWalls(null, { walls: [] }, c).floor, null);
});
