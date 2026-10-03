// 下屋の外周の梁（軒桁）と、下屋の範囲の床梁ガード（ステップ C2d-1）のテスト。
// 設計意図: .claude/structural-model.md「下屋の外周」。小屋組の対象の下屋（roofFramingRegions.js
// leanToFramingRegions が region を返す下屋。矩形に加え L字の片流れも対象＝ステップ E2b）だけが対象。非在来・切妻や陸屋根になる L字は従来どおり何もしない。
// 比べるのは位置由来のキー（軸・座標・区間）で、エンティティ配列は deepEqual しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape,
} from '../core.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { autoFillWoodFloorBeams } from './woodAutoFill.js';
import { leanToFramingCellKeys } from './roofFramingRegions.js';

const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
const SQ = 3640;

// ---- 床梁ガード（autoFillWoodFloorBeams の roofCellKeys）----

// 3640×7280 の区画（短辺3640>1820＝床梁が要る）を4辺 primary で囲んだ1階。2セル分（上下）を1部屋にする。
function closedCellGraph({ roofRoom = false } = {}) {
  const graph = new PlanGraph(new Plane('p1', 3000, '2階', 2, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, SQ, STRUCT);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, SQ * 2, STRUCT);
  for (const [axis, isV, a, b] of [[y0, false, x0, x1], [y1, false, x0, x1], [x0, true, y0, y1], [x1, true, y0, y1]]) {
    graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, axis, isV, a, b, { role: 'primary' });
  }
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), roofRoom ? '屋根' : '居間');
  if (roofRoom) {
    room.setKind(RoomKind.EXTERIOR);
    room.setFeature(RoomFeature.ROOF);
    room.setRoofSpec(createLeanToRoofSpec());
  }
  return { graph, key, room };
}
const woodProject = () => {
  const p = new Project('p', 'test');
  p.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  return p;
};
const floorBeams = graph => graph.beams.filter(b => b.role === 'floor');

test('【床梁ガード】対象の屋根セルの区画には床梁を作らない。同じ区画でも屋内なら従来どおり作る（対照）', () => {
  const roof = closedCellGraph({ roofRoom: true });
  const roofKeys = leanToFramingCellKeys(roof.graph, woodProject());
  assert.deepEqual([...roofKeys.keys()], [roof.key], '前提: 屋根セルが対象（矩形の下屋）');
  assert.equal(roofKeys.get(roof.key), `lean:${roof.room.id}`, '値はどの下屋のセルか（region の key）');
  assert.equal(autoFillWoodFloorBeams(roof.graph, PROJECT, roofKeys).created.length, 0, '下屋の区画に床梁は出ない');
  assert.equal(floorBeams(roof.graph).length, 0);

  const inside = closedCellGraph();
  const created = autoFillWoodFloorBeams(inside.graph, PROJECT, leanToFramingCellKeys(inside.graph, woodProject())).created;
  assert.equal(created.length, 3, '対照: 屋内の区画は 7280/1820 → n=4 で内部3本');
});

test('【床梁ガード】引数省略・空集合・区画に無いセルキーは従来と同じ（屋根セルの区画にも床梁が出る）', () => {
  const lines = g => floorBeams(g).map(b => `${b.isVertical ? 'V' : 'H'}|${b.axisValue}`).sort();
  const base = closedCellGraph({ roofRoom: true });
  autoFillWoodFloorBeams(base.graph, PROJECT);
  for (const arg of [undefined, new Set(), new Set(['no-such:cell:key:x'])]) {
    const g = closedCellGraph({ roofRoom: true });
    autoFillWoodFloorBeams(g.graph, PROJECT, arg);
    assert.deepEqual(lines(g.graph), lines(base.graph));
  }
  assert.equal(floorBeams(base.graph).length, 3, '従来どおり屋根セルの区画にも作る');
});

test('【床梁ガード】既にある auto の床梁は、ガードで候補から外れると既存の撤去の流儀で消える', () => {
  const { graph, key, room } = closedCellGraph({ roofRoom: true });
  assert.equal(autoFillWoodFloorBeams(graph, PROJECT).created.length, 3, '前提: ガード無しで3本できる');
  const res = autoFillWoodFloorBeams(graph, PROJECT, new Set([key]));
  assert.equal(res.removed.length, 3, '撤去される');
  assert.equal(floorBeams(graph).length, 0);
  assert.equal(room.cells.has(key), true);
});

test('【失敗系】leanToFramingCellKeys: 屋根セルが無い・非在来は空集合', () => {
  assert.equal(leanToFramingCellKeys(closedCellGraph().graph, woodProject()).size, 0, '屋根セル無し');
  const { graph } = closedCellGraph({ roofRoom: true });
  const rc = new Project('p', 'test');
  rc.structuralInfo.mainStructure = 'S造';
  graph.structureOverride = null;
  assert.equal(leanToFramingCellKeys(graph, rc).size, 0, '非在来');
  assert.equal(leanToFramingCellKeys(null, woodProject()).size, 0, 'graph 無し');
});

test('【失敗系】leanToFramingCellKeys: 通り芯が消えて解決できない古いセルキーを持つ下屋でも例外を投げず、解決できないキーは返さない', () => {
  const { graph, key, room } = closedCellGraph({ roofRoom: true });
  const stale = 'gone-x0:gone-y0:gone-x1:gone-y1';
  room.cells.add(stale);
  let keys;
  assert.doesNotThrow(() => { keys = leanToFramingCellKeys(graph, woodProject()); });
  assert.equal(keys.has(stale), false, '解決できないキーは含めない');
  assert.ok([...keys.keys()].every(k => k === key), '返すのは現在の格子で解決できるキーだけ');
});

// ---- 配線（対象の1行をまるごと一致で固定。コメント・行末コメントでは一致しない）----

async function readSrc(name) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, name), 'utf8');
}

test('【配線】structuralRecompute.js: 実体階だけ下屋を1回導き（C2d-2）、セルキーを自階ゲートと autoFillStructuralGrid（床梁）へ、region を小屋梁の生成へ渡す', async () => {
  const src = await readSrc('structuralRecompute.js');
  assert.ok(/^\s{2}const leanTo = isRoof \? null : withGraphReadScope\(targetGraph, \(\) => leanToFraming\(targetGraph, project\)\);$/m.test(src), '下屋の導出行（1回だけ）');
  assert.ok(/^\s{2}const roofCellKeys = leanTo\?\.cellKeys;$/m.test(src), 'roofCellKeys は導出の cellKeys');
  assert.ok(/^\s{2}const roofRegions = isRoof \? \(mainRegion \? \[mainRegion\] : \[\]\) : leanTo\.regions;$/m.test(src), '実体階は下屋の regions を小屋梁の生成へ渡す（屋根専用平面は主屋根の region のまま）');
  assert.equal((src.match(/leanToFraming\(/g) ?? []).length, 1, '下屋の導出は1回（部屋を二重に走査しない）');
  assert.ok(/^\s{2}const selfGate = buildSelfFootprintGate\(isRoof \? \(belowGraph \?\? targetGraph\) : targetGraph, footprintCache, \{ roofPerimeterCellKeys: roofCellKeys \}\);$/m.test(src), 'selfGate へ roofPerimeterCellKeys を渡す行');
  assert.ok(/aboveBeamSegments, selfGate, freeEndGraph, wallSourceCache, openingSources, belowGraph, roofRegions, roofCellKeys\)\);$/m.test(src), 'autoFillStructuralGrid へ roofCellKeys を渡す行');
});

// ---- 統合（recomputeStructuralForGraph）----

// 3列×2行（各3640角）の格子。1階: 左列の2セル＋屋根セルの下（＝屋根の掛かる範囲）の1部屋（外周に壁）。
// 2階: 左列の2セルが屋内（外周に壁）、roofCellsIJ が屋根セル（壁なし）。
function buildTwoFloors(roofCellsIJ) {
  const project = new Project('proj-lean', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const grid = (g) => {
    const xs = [0, 1, 2, 3].map(i => g.addCenterLine(CenterLineType.VERTICAL, i * SQ, STRUCT));
    const ys = [0, 1, 2].map(j => g.addCenterLine(CenterLineType.HORIZONTAL, j * SQ, STRUCT));
    return (i, j) => `${xs[i].id}:${ys[j].id}:${xs[i + 1].id}:${ys[j + 1].id}`;
  };
  const c1 = grid(g1);
  const all = [c1(0, 0), c1(0, 1), ...roofCellsIJ.map(([i, j]) => c1(i, j))];
  generateRoomWallsFromOutline(g1, g1.addRoom(new Set(all), 'A'));
  const c2 = grid(g2);
  generateRoomWallsFromOutline(g2, g2.addRoom(new Set([c2(0, 0), c2(0, 1)]), '居間'));
  const roof = g2.addRoom(new Set(roofCellsIJ.map(([i, j]) => c2(i, j))), '屋根');
  roof.setKind(RoomKind.EXTERIOR);
  roof.setFeature(RoomFeature.ROOF);
  roof.setRoofSpec(createLeanToRoofSpec());
  return { project, g1, g2 };
}

async function withPeek(graphs, fn) {
  const peekMap = Object.fromEntries(graphs.map(g => [g.plane.id, g]));
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try { return await fn(); } finally { floorSwapManager.peek = original; }
}

// 本番の反映パスと同じ降順（上階→下階）を、2階とも changed=false になるまで回す（上限8周）。
async function converge({ project, g1, g2 }) {
  return withPeek([g1, g2], async () => {
    const history = [];
    for (let i = 0; i < 8; i++) {
      const a = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
      const b = await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
      history.push([!!a.changed, !!b.changed]);
      if (!a.changed && !b.changed) return history;
    }
    return history;
  });
}

const r = v => Math.round(v * 100) / 100;
// 軸(isVertical, coord)上の primary 梁が [lo, hi] を隙間なく覆うか。
function primaryCovers(graph, isVertical, coord, lo, hi) {
  const spans = graph.beams
    .filter(b => b.role === 'primary' && b.isVertical === isVertical && Math.abs(b.axisValue - coord) < 1)
    .map(b => [Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue), Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)])
    .sort((a, b) => a[0] - b[0]);
  let at = lo;
  for (const [s, e] of spans) {
    if (s > at + 1) break;
    at = Math.max(at, e);
  }
  return at >= hi - 1;
}
const beamKeys = (graph, role) => graph.beams.filter(b => b.role === role).map(b =>
  [b.isVertical ? 'V' : 'H', r(b.axisValue), r(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue)), r(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))].join('|')).sort();

test('【統合】矩形の下屋（片流れ）: 外周の3辺に primary 梁が出て、屋内との境界にも出る。下屋の範囲に床梁は無い。収束し、収束後は changed=false', async () => {
  const doc = buildTwoFloors([[1, 0], [2, 0]]); // 2階 x3640..10920 × y0..3640（短手3640＝片流れ）
  const { g2 } = doc;
  assert.equal(leanToFramingCellKeys(g2, doc.project).size, 2, '前提: 2セルが対象の下屋');
  const history = await converge(doc);
  assert.deepEqual(history.at(-1), [false, false], `収束: ${JSON.stringify(history)}`);
  assert.ok(history.length <= 5, `スイープ数は上限5以内: ${history.length}`);

  assert.ok(primaryCovers(g2, false, 0, SQ, SQ * 3), '軒（y=0）に梁が出る');
  assert.ok(primaryCovers(g2, false, SQ, SQ, SQ * 3), '軒（y=3640。1階の壁線）に梁が出る');
  assert.ok(primaryCovers(g2, true, SQ * 3, 0, SQ), '妻（x=10920）に梁が出る');
  assert.ok(primaryCovers(g2, true, SQ, 0, SQ), '屋内との境界（x=3640）には従来どおり出る');
  // 床梁が下屋の範囲（x>3640）に入るか: 縦軸なら軸が、横軸なら区間の終端が x=3640 より東。
  const floorInRoof = g2.beams.filter(b => b.role === 'floor'
    && (b.isVertical ? b.axisValue : Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)) > SQ + 1);
  assert.equal(floorInRoof.length, 0, '下屋の範囲（x>3640）に床梁は無い');
  assert.ok(g2.beams.some(b => b.role === 'floor'), '対照: 屋内の区画（x0..3640）の床梁は従来どおり出る');

  // 収束後にもう一度再計算しても変化なし（冪等）
  const again = await withPeek([doc.g1, g2], () => recomputeStructuralForGraph(g2, doc.project, TRADITIONAL_WOOD_STRUCTURE));
  assert.equal(again.changed, false);
});

// E2b で書き換え（旧: 「L字の下屋（対象外）は従来どおり外周に梁は出ない」。L字の片流れも対象になった）。
test('【統合】L字の下屋（片流れ）も外周の梁が出る。L字の内側の入隅（セルどうしの境界）には出ない。屋根の範囲に床梁は無い。収束し、収束後は changed=false', async () => {
  const doc = buildTwoFloors([[1, 0], [2, 0], [2, 1]]); // L字（2階 x3640..10920 × y0..3640 と x7280..10920 × y3640..7280）
  assert.equal(leanToFramingCellKeys(doc.g2, doc.project).size, 3, '前提: L字の3セルが対象');
  const history = await converge(doc);
  assert.deepEqual(history.at(-1), [false, false], `収束: ${JSON.stringify(history)}`);
  assert.ok(history.length <= 5, `スイープ数は上限5以内: ${history.length}`);
  assert.ok(primaryCovers(doc.g2, false, 0, SQ, SQ * 3), '外周の軒（y=0）に梁が出る');
  assert.ok(primaryCovers(doc.g2, true, SQ * 3, 0, SQ * 2), '外周の妻（x=10920）に梁が出る');
  assert.ok(primaryCovers(doc.g2, false, SQ * 2, SQ * 2, SQ * 3), '外周（y=7280。下の腕の下辺）に梁が出る');
  assert.ok(primaryCovers(doc.g2, true, SQ, 0, SQ), '屋内との境界（x=3640）には従来どおり出る');
  const floorInRoof = doc.g2.beams.filter(b => b.role === 'floor'
    && (b.isVertical ? b.axisValue : Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)) > SQ + 1);
  assert.equal(floorInRoof.length, 0, 'L字の範囲（x>3640）に床梁は無い');
  const again = await withPeek([doc.g1, doc.g2], () => recomputeStructuralForGraph(doc.g2, doc.project, TRADITIONAL_WOOD_STRUCTURE));
  assert.equal(again.changed, false);
});

test('【統合・失敗系】自動の形状が切妻になる L字・明示の寄棟・陸屋根の L字は対象外: セルキーは空で、屋根セルの外周に梁は出ない', async () => {
  for (const shape of [RoofShape.HIP, RoofShape.FLAT, RoofShape.GABLE]) {
    const doc = buildTwoFloors([[1, 0], [2, 0], [2, 1]]);
    doc.g2.rooms.find(room => room.feature === RoomFeature.ROOF).roofSpec.setField('shape', shape);
    assert.equal(leanToFramingCellKeys(doc.g2, doc.project).size, 0, `前提: 明示の ${shape} の L字は region 無し`);
    await converge(doc);
    assert.equal(primaryCovers(doc.g2, false, 0, SQ, SQ * 3), false, `${shape}: 外周の軒（y=0）に梁は出ない`);
    assert.equal(primaryCovers(doc.g2, true, SQ * 3, 0, SQ), false, `${shape}: 外周の妻（x=10920）に梁は出ない`);
    assert.ok(primaryCovers(doc.g2, true, SQ, 0, SQ), `${shape}: 屋内との境界（x=3640）には従来どおり出る`);
  }
});

test('【統合・対照】同じ屋根セルを陸屋根（小屋組なし＝対象外）にすると、外周の梁・屋根の範囲の床梁は従来どおりの結果になる', async () => {
  const flat = buildTwoFloors([[1, 0], [2, 0]]);
  flat.g2.rooms.find(room => room.feature === RoomFeature.ROOF).roofSpec.setField('shape', RoofShape.FLAT);
  assert.equal(leanToFramingCellKeys(flat.g2, flat.project).size, 0, '前提: 陸屋根は対象外');
  await converge(flat);
  assert.equal(primaryCovers(flat.g2, false, 0, SQ, SQ * 3), false, '外周の軒に梁は出ない（従来どおり）');

  const lean = buildTwoFloors([[1, 0], [2, 0]]);
  await converge(lean);
  const flatKeys = new Set(beamKeys(flat.g2, 'primary'));
  const added = beamKeys(lean.g2, 'primary').filter(k => !flatKeys.has(k));
  assert.ok(added.length > 0, '対象の下屋では外周の梁が増える');
  assert.ok(added.every(k => !k.startsWith('V|3640|')), '屋内との境界（x=3640）の梁は変わらない');
});
