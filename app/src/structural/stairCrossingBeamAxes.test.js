// 階段を横切る孤児の梁芯の撤去（ユーザー指示 2026-10-12）の単体・統合・通知テスト。
// removeStairCrossingOrphanBeamAxes（stairCrossingBeamAxes.js）・本番経路 recomputeStructuralForGraph・
// 通知（structuralOrchestration.js withToastScope／setStructuralToastHandler）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline, StairType, StructuralMaterialType } from '../core.js';
import { centerLineKind, BeamAxisOrigin } from '../core/centerLine.js';
import { beamExclusionKey, columnSlotKey } from '../core/structuralEntities.js';
import { getAllCells } from '../finish/gridCells.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { generateStairPartitionWalls } from '../finish/stair/stairPartitionWalls.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from './structureRules.js';
import { removeStairCrossingOrphanBeamAxes, STAIR_CROSSING_REMOVED_MESSAGE } from './stairCrossingBeamAxes.js';
import { autoFillWoodColumns } from './woodAutoFill.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import {
  recomputeActiveStructural, recomputeStructuralComposition, reflectStructuralToOtherFloors, runStructuralModeSetup,
  setStructuralToastHandler,
} from './structuralOrchestration.js';
import { figureBindingManager } from '../figure/FigureBindingManager.js';
import { createStructuralResolveContext } from './structuralResolveContext.js';
import { ERR_STRUCT_MAIN_UNSPECIFIED } from '../error.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
// 階段 footprint: 幅2000×奥行4000。踊り場前縁 y=1000（水平の梁芯）、隔て壁線 x=1000（垂直の梁芯）。
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];
const FRONT_Y = 1000, PARTITION_X = 1000;
// 幅2400の階段（踊り場前縁 y=1000、隔て壁線 x=1200）。前縁と隔て壁の座標が違うので、梁芯の向きの取り違えを検出できる。
const WIDE_UP = [[0, 0, 2400, 1000], [0, 1000, 1200, 4000], [1200, 1000, 2400, 4000]];
const SEP = String.fromCharCode(0x3000); // トーストの連結に使う全角空白

// 下から floors 階。1階は隔て壁つきの SWITCHBACK 階段。2階以降は withUpperStairs なら同じ階段（続き）。
function makeFixture({ floors = 2, withUpperStairs = true, stairFloors = Infinity, rects = EQUAL_UP, stairStructure = StructuralMaterialType.WOOD, structure = WOOD, wideRoom = false } = {}) {
  const project = new Project('proj-stair-crossing', 'test');
  const mkFloor = (elevation, name, id, withStair) => {
    const { graph } = project.addPlane(elevation, name, id);
    graph.structureOverride = structure;
    const vs = new Map(), hs = new Map();
    const mk = (type, map, v) => map.get(v) ?? map.set(v, graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
    // 階段の外にも部屋を広げる（床梁が足元の外にも立つ）。'x'＝x 方向へ広げる・'y'＝y 方向へ広げる
    if (wideRoom === true || wideRoom === 'x') mk(CenterLineType.VERTICAL, vs, 6000);
    if (wideRoom === 'y') mk(CenterLineType.HORIZONTAL, hs, 8000);
    const keys = rects.map(([x1, y1, x2, y2]) =>
      `${mk(CenterLineType.VERTICAL, vs, x1).id}:${mk(CenterLineType.HORIZONTAL, hs, y1).id}:${mk(CenterLineType.VERTICAL, vs, x2).id}:${mk(CenterLineType.HORIZONTAL, hs, y2).id}`);
    if (withStair) graph.addStair({ type: StairType.SWITCHBACK, cells: new Set(keys), sections: [6, 1, 6], flip: false, upDirection: 'up', structure: stairStructure });
    const parent = graph.addRoom(new Set(getAllCells(graph).map(c => c.key)), 'A');
    generateRoomWallsFromOutline(graph, parent);
    return graph;
  };
  const gs = [];
  for (let i = 0; i < floors; i++) {
    const g = mkFloor(i * 3000, `${i + 1}階`, `p${i + 1}`, i === 0 || (withUpperStairs && i < stairFloors));
    if (i === 0) generateStairPartitionWalls(g, { structure: WOOD, underEdges: [] });
    gs.push(g);
  }
  return { project, g1: gs[0], g2: gs[1], g3: gs[2], gs };
}

const clAt = (g, type, v) => g.centerLines.find(c => c.centerLineType === type && Math.abs(c.value - v) < 0.5);
// 旧実装が残した孤児と同じ形（discipline:'fuse'・由来 floorBeam・refId なし）の梁芯を足す
function addOrphan(g, type, value, { lo = 0, hi = 4000, extra = {} } = {}) {
  return runInAction(() => g.addCenterLine(type, value, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.FLOOR_BEAM, extentLo: lo, extentHi: hi, ...extra,
  }));
}
const hOrphan = (g, y = FRONT_Y, opts) => addOrphan(g, CenterLineType.HORIZONTAL, y, { lo: 0, hi: 2000, ...opts });
const vOrphan = (g, x = PARTITION_X, opts) => addOrphan(g, CenterLineType.VERTICAL, x, { lo: 0, hi: 4000, ...opts });
const remove = (g, project, below = null, gen = []) => runInAction(() => removeStairCrossingOrphanBeamAxes(g, project, below, gen));

// floorSwapManager.peek を生きた graph を返すスタブにする（IDB なし）
async function withPeek(project, body) {
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  try { return await body(); } finally { floorSwapManager.peek = originalPeek; }
}
const recompute = (g, project, belowGraph) => withPeek(project, () => recomputeStructuralForGraph(g, project, WOOD, belowGraph));

// ---- 純モジュール ----
test('【撤去】下階の隔て壁あり階段の足元で、踊り場前縁（y=1000）・隔て壁線（x=1000）に一致する孤児は撤去され、戻り値に含まれる', () => {
  for (const withUpperStairs of [true, false]) { // 自階に続きの階段が有っても無くても（破れ先／STAIR_VOID）
    const { project, g1, g2 } = makeFixture({ withUpperStairs });
    const h = hOrphan(g2), v = vOrphan(g2);
    const removed = remove(g2, project, g1);
    assert.deepEqual(removed.map(c => c.id).sort(), [h.id, v.id].sort(), `withUpperStairs=${withUpperStairs}`);
    assert.equal(g2.shapeMap.has(h.id), false);
    assert.equal(g2.shapeMap.has(v.id), false);
  }
});

test('【向き】前縁（水平 y=1000）と隔て壁線（垂直 x=1200）は撤去、向きを取り違えた梁芯（垂直 x=1000・水平 y=1200）は残す', () => {
  const { project, g1, g2 } = makeFixture({ rects: WIDE_UP });
  const front = hOrphan(g2, 1000, { lo: 0, hi: 2400 });       // 水平 y=前縁
  const part = vOrphan(g2, 1200);                              // 垂直 x=隔て壁線
  const wrongV = vOrphan(g2, 1000);                            // 垂直 x=前縁の値（向き違い）
  const wrongH = hOrphan(g2, 1200, { lo: 0, hi: 2400 });       // 水平 y=隔て壁線の値（向き違い）
  const removed = remove(g2, project, g1);
  assert.deepEqual(removed.map(c => c.id).sort(), [front.id, part.id].sort());
  assert.ok(g2.shapeMap.has(wrongV.id) && g2.shapeMap.has(wrongH.id), '向きの違う梁芯は残る');
});

test('【残す】下階が無い（belowGraph=null）／下階に階段が無い階では、自階の階段の足元でも対象外', () => {
  const { project, g1 } = makeFixture({ floors: 1 });
  const h = hOrphan(g1);
  assert.deepEqual(remove(g1, project, null), [], '最下階（自階の階段の足元は対象にしない）');
  const noStairBelow = makeFixture({ withUpperStairs: false }); // g2 は階段なし。g2 を「下階」に見立てる
  const h2 = hOrphan(noStairBelow.g1);
  assert.deepEqual(remove(noStairBelow.g1, noStairBelow.project, noStairBelow.g2), [], '下階に階段が無ければ自階の階段の足元でも対象外');
  assert.ok(g1.shapeMap.has(h.id) && noStairBelow.g1.shapeMap.has(h2.id));
});

test('【残す】足元の内部を通っても、踊り場前縁・隔て壁の線に一致しない梁芯（例: 床梁の y=2500）は対象外', () => {
  const { project, g1, g2 } = makeFixture();
  const other = hOrphan(g2, 2500);
  const otherV = vOrphan(g2, 500);
  assert.deepEqual(remove(g2, project, g1), []);
  assert.ok(g2.shapeMap.has(other.id) && g2.shapeMap.has(otherV.id));
});

test('【残す】軸上に梁が 1 本でも乗っていれば孤児ではない', () => {
  const { project, g1, g2 } = makeFixture();
  const h = hOrphan(g2);
  const x0 = clAt(g2, CenterLineType.VERTICAL, 0), x2 = clAt(g2, CenterLineType.VERTICAL, 2000);
  runInAction(() => g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', h, false, x0, x2, { role: 'secondary', beamType: '小梁' }));
  assert.deepEqual(remove(g2, project, g1), []);
  assert.ok(g2.shapeMap.has(h.id));
});

test('【残す】線の座標は一致しても足元の外（区間が足元に掛からない）なら対象外', () => {
  const { project, g1, g2 } = makeFixture();
  const noOverlapH = hOrphan(g2, FRONT_Y, { lo: 2500, hi: 5000 }); // x 2500.. は足元（x 0..2000）の外
  const noOverlapV = vOrphan(g2, PARTITION_X, { lo: 5000, hi: 6000 }); // y 5000.. は足元（y 0..4000）の外
  assert.deepEqual(remove(g2, project, g1), []);
  assert.ok(g2.shapeMap.has(noOverlapH.id) && g2.shapeMap.has(noOverlapV.id));
});

test('【残す】保護される梁芯（固定の柱・CL偏芯・他CLの extent 参照）は守る', () => {
  const protections = {
    lockedColumn: (g, c) => g.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', clAt(g, CenterLineType.VERTICAL, 0), c, { dimensionStatus: 'locked' }),
    eccentricity: (g, c) => g.setCLEccentricity(c.id, { side: 1, amount: 30 }),
    extentRef: (g, c) => addOrphan(g, CenterLineType.HORIZONTAL, 6000, { lo: 0, hi: 2000, extra: { extentLoRef: { clId: c.id, offset: 0 } } }),
  };
  for (const [name, protect] of Object.entries(protections)) {
    const { project, g1, g2 } = makeFixture();
    const h = hOrphan(g2);
    runInAction(() => protect(g2, h));
    assert.deepEqual(remove(g2, project, g1).map(c => c.id), [], name);
    assert.ok(g2.shapeMap.has(h.id), name);
  }
});

test('【残す】由来 USER（手動追加）・通り芯・中心線は対象外', () => {
  const { project, g1, g2 } = makeFixture();
  const user = hOrphan(g2, FRONT_Y, { extra: { beamAxisOrigin: BeamAxisOrigin.USER } });
  const before = g2.centerLines.length;
  assert.deepEqual(remove(g2, project, g1), []);
  assert.equal(g2.centerLines.length, before, 'ARCH の y=1000・x=1000 の中心線も消えない');
  assert.ok(g2.shapeMap.has(user.id));
});

test('【残す・(e)】現況の生成源（壁・開口）の座標・向きに一致する梁芯は残す（防御）', () => {
  const { project, g1, g2 } = makeFixture();
  const h = hOrphan(g2);
  assert.deepEqual(remove(g2, project, g1, [{ isVertical: false, coord: FRONT_Y }]), []);
  assert.ok(g2.shapeMap.has(h.id));
  assert.equal(remove(g2, project, g1, [{ isVertical: true, coord: FRONT_Y }]).length, 1, '向きが違う源は無関係');
});

test('【残す・(f)】ユーザーが削除した床梁・柱の記録（除外集合のキー）がこの梁芯の id を参照していれば撤去しない', () => {
  const x0 = (g) => clAt(g, CenterLineType.VERTICAL, 0), x2 = (g) => clAt(g, CenterLineType.VERTICAL, 2000);
  const cases = {
    excludedBeamSlots: (g, c) => g.excludedBeamSlots.add(beamExclusionKey('floor', c, x0(g), x2(g))),
    excludedBeamSlotsSill: (g, c) => g.excludedBeamSlots.add(beamExclusionKey('sill', c, x0(g), x2(g))),
    excludedColumnSlots: (g, c) => g.excludedColumnSlots.add(columnSlotKey(x0(g), c)),
  };
  for (const [name, record] of Object.entries(cases)) {
    const { project, g1, g2 } = makeFixture();
    const h = hOrphan(g2);
    runInAction(() => record(g2, h));
    assert.deepEqual(remove(g2, project, g1), [], name);
    assert.ok(g2.shapeMap.has(h.id), name);
  }
  // 対照: 別の梁芯（y=2500）を指す記録は、この梁芯の撤去を止めない
  const { project, g1, g2 } = makeFixture();
  const h = hOrphan(g2), other = hOrphan(g2, 2500);
  runInAction(() => g2.excludedBeamSlots.add(beamExclusionKey('floor', other, x0(g2), x2(g2))));
  assert.deepEqual(remove(g2, project, g1).map(c => c.id), [h.id]);
});

test('【対象外】鉄骨階段（隔て壁なし）・非在来（S造）では何もしない', () => {
  for (const opts of [{ stairStructure: StructuralMaterialType.STEEL }, { structure: StructuralMaterialType.STEEL }]) {
    const { project, g1, g2 } = makeFixture(opts);
    const h = hOrphan(g2);
    assert.deepEqual(remove(g2, project, g1), [], JSON.stringify(opts));
    assert.ok(g2.shapeMap.has(h.id));
  }
});

// ---- 本番経路 ----
test('【本番経路】孤児の撤去→次の再計算で柱が中心線（梁芯でない CL）へ再アンカー、その後は撤去 0 で収束する', async () => {
  const { project, g1, g2 } = makeFixture();
  const orphan = hOrphan(g2); // 踊り場前縁の孤児（旧小梁 B1 の梁芯）
  await recompute(g1, project, null);
  autoFillWoodColumns(g2, project); // 前提: 規則2の柱が孤児 CL にアンカーされる
  assert.ok(g2.columns.filter(c => c.horizontalCL.id === orphan.id).length > 0, '前提: 柱が孤児 CL にアンカー');

  const r1 = await recompute(g2, project, g1);
  assert.equal(r1.removedStairCrossingAxes, 1);
  assert.equal(r1.changed, true);
  assert.equal(g2.shapeMap.has(orphan.id), false);
  const r2 = await recompute(g2, project, g1);
  assert.equal(r2.removedStairCrossingAxes, 0);
  const cols = g2.columns.filter(c => Math.abs(c.axisY - FRONT_Y) < 1 && (Math.abs(c.axisX) < 1 || Math.abs(c.axisX - 2000) < 1));
  assert.equal(cols.length, 2, '前縁の柱 2 本が残る（再生成）');
  for (const c of cols) {
    assert.ok(g2.shapeMap.has(c.horizontalCL.id), '再アンカー先の CL は存在する');
    assert.notEqual(centerLineKind(c.horizontalCL), 'beam', '梁芯ではなく中心線へ');
  }
  const r3 = await recompute(g2, project, g1);
  assert.equal(r3.removedStairCrossingAxes, 0);
  assert.equal(r3.changed, false, '収束（撤去と生成の往復がない）');
});

test('【本番経路・回帰】ユーザーが削除した自動床梁は、階段の足元でも再計算で復活しない（撤去されず、通知も出ない）', async () => {
  // QA の osc5／osc2 の構成: 階段の外にも部屋が広がる 2 階（自階に階段）で、床梁を除外キーつきで削除。
  // 注: この構成（幅2000×奥行4000の階段・部屋を x 方向へ広げる）で立つ自動床梁は水平（軸が y）だけ。
  // 垂直の床梁が立つ構成は作れていないので、向きごとの検証はしていない（lead への報告事項）。
  for (const target of ['y']) {
    const { project, g1, g2 } = makeFixture({ withUpperStairs: true, wideRoom: 'x' });
    await recompute(g1, project, null);
    for (let i = 0; i < 3; i++) await recompute(g2, project, g1);
    // target 'x'＝垂直の床梁（軸が x）・'y'＝水平の床梁。どちらの向きも別々に検証する。
    const floorBeams = g2.beams.filter(b => b.role === 'floor' && b.dimensionStatus === 'auto' && b.isVertical === (target === 'x'));
    assert.ok(floorBeams.length > 0, `前提: 向き ${target} の自動床梁がある`);
    const victim = floorBeams[0];
    const axisId = victim.axisCL.id;
    const same = floorBeams.filter(b => b.axisCL.id === axisId);
    runInAction(() => { for (const b of same) g2.removeBeam(b.id); });
    const keys = [...g2.excludedBeamSlots];
    assert.ok(keys.length > 0, '前提: 除外キーが記録された');
    const msgs = [];
    setStructuralToastHandler(m => msgs.push(m));
    try {
      let removedTotal = 0;
      for (let i = 0; i < 4; i++) removedTotal += (await recompute(g2, project, g1)).removedStairCrossingAxes;
      assert.equal(removedTotal, 0, `${target}: 梁芯は撤去されない`);
    } finally { setStructuralToastHandler(null); }
    assert.equal(g2.beams.filter(b => b.axisCL.id === axisId).length, 0, `${target}: 削除した床梁は復活しない`);
    assert.ok(g2.shapeMap.has(axisId), '梁芯は残る');
    assert.deepEqual(msgs, []);
  }
});

test('【本番経路・失敗系】下階が無い／下階に階段の無い在来の階では孤児を撤去しない', async () => {
  const { project, g1 } = makeFixture({ floors: 1 });
  const orphan = hOrphan(g1);
  const r = await recompute(g1, project, null);
  assert.equal(r.removedStairCrossingAxes, 0);
  assert.ok(g1.shapeMap.has(orphan.id));
});

// ---- 通知 ----
async function withHandler(project, body) {
  const msgs = [];
  setStructuralToastHandler(m => msgs.push(m));
  try { await withPeek(project, () => body(msgs)); } finally { setStructuralToastHandler(null); }
}

test('【通知】撤去があった再計算で「階段を横切る梁を削除しました。」が既定の通知先へ 1 回だけ渡る。撤去が無ければ出ない', async () => {
  const { project, g2 } = makeFixture();
  project.activePlaneId = 'p2';
  hOrphan(g2);
  vOrphan(g2);
  await withHandler(project, async (msgs) => {
    await recomputeActiveStructural(project, false);
    assert.deepEqual(msgs, [STAIR_CROSSING_REMOVED_MESSAGE], '2 本撤去しても 1 回・件数や階名は付けない');
    assert.equal(STAIR_CROSSING_REMOVED_MESSAGE, '階段を横切る梁を削除しました。');
    await recomputeActiveStructural(project, false);
    await recomputeActiveStructural(project, false);
    assert.equal(msgs.length, 1, '撤去が無い再計算では出ない');
  });
});

test('【通知】2 つの階で撤去があっても、全階の反映（reflectStructuralToOtherFloors）1 回につき通知は 1 回', async () => {
  const { project, g2, g3 } = makeFixture({ floors: 3, stairFloors: 2 }); // 3階は階段なし（2階の階段の破れ先）
  project.activePlaneId = 'p1';
  const o2 = hOrphan(g2), o3 = hOrphan(g3);
  // IDB を使わない解決コンテキスト（peek は生きた graph・save は何もしない）
  const ctx = createStructuralResolveContext({ peek: async (plane) => project.graphMap.get(plane.id) ?? null, save: async () => {} });
  await withHandler(project, async (msgs) => {
    try { await reflectStructuralToOtherFloors(project, ctx); } finally { ctx.dispose(); }
    assert.equal(g2.shapeMap.has(o2.id), false, '前提: 2階の孤児が撤去された');
    assert.equal(g3.shapeMap.has(o3.id), false, '前提: 3階の孤児が撤去された');
    assert.deepEqual(msgs, [STAIR_CROSSING_REMOVED_MESSAGE]);
  });
});

test('【通知】部材番号の振り直しと同時に起きたら、「材寸の変更にともない…（A → B）」と連結して 1 回で出す（順序: 振り直し → 階段）', async () => {
  const { project, g1, g2 } = makeFixture();
  project.activePlaneId = 'p2';
  await recompute(g1, project, null);
  for (let i = 0; i < 3; i++) await recompute(g2, project, g1);
  const composition = { graphForCategory: () => g1 };
  const first = [];
  await withPeek(project, () => recomputeStructuralComposition(composition, g2, project, { onToast: m => first.push(m), pushUndo: false }));
  assert.deepEqual(first, [], '前提: 撤去も振り直しも無い再計算では通知なし');
  const col = g2.columns.find(c => c.memberNo != null);
  assert.ok(col, '前提: 採番済みの柱がある');
  runInAction(() => { col.memberNo = 'ZZ99'; }); // 既に番号を持つ部材が別タグへ変わる＝振り直し
  hOrphan(g2);
  const msgs = [];
  await withPeek(project, () => recomputeStructuralComposition(composition, g2, project, { onToast: m => msgs.push(m), pushUndo: false }));
  assert.equal(msgs.length, 1, 'トーストは 1 回だけ（後勝ちで消えない）');
  assert.match(msgs[0], /^材寸の変更にともない部材番号を振り直しました（ZZ99 → .+）/, msgs[0]);
  assert.ok(msgs[0].endsWith(SEP + STAIR_CROSSING_REMOVED_MESSAGE), msgs[0]);
  assert.notEqual(col.memberNo, 'ZZ99');
});

test('【通知】構造モード突入の「主構造が未定」の警告も連結して残る（順序: 警告 → 階段）', async () => {
  const { project, g1, g2, g3 } = makeFixture({ floors: 3 });
  runInAction(() => { g3.structureOverride = UNSPECIFIED_STRUCTURE; });
  project.activePlaneId = 'p3';
  const orphan = hOrphan(g2);
  const msgs = [];
  const ctx = createStructuralResolveContext({ peek: async (plane) => project.graphMap.get(plane.id) ?? null, save: async () => {} });
  await withPeek(project, async () => {
    try { await runStructuralModeSetup(g3, project, { onToast: m => msgs.push(m), ctx }); } finally { ctx.dispose(); }
  });
  assert.equal(g2.shapeMap.has(orphan.id), false, '前提: 他階（2階）の孤児が撤去された');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0], [ERR_STRUCT_MAIN_UNSPECIFIED, STAIR_CROSSING_REMOVED_MESSAGE].join(SEP));
  assert.ok(g1);
});

test('【通知】構造モード突入で警告・振り直し・階段撤去が同時に起きたら、この順に全角空白で連結して 1 回で出す', async () => {
  const { project, g1, g2, g3 } = makeFixture({ floors: 3 });
  // 2階の柱に採番させておく（反映パスが番号を確定する）
  project.activePlaneId = 'p2';
  await recompute(g1, project, null);
  for (let i = 0; i < 3; i++) await recompute(g2, project, g1);
  runInAction(() => { g3.structureOverride = UNSPECIFIED_STRUCTURE; });
  project.activePlaneId = 'p3';
  const orphan = hOrphan(g2);
  // 突入の途中（反映パスの後・自階＋下階の再計算の前）で下階（2階）の柱の番号を壊す＝再計算側の採番が振り直す
  const originalActivate = figureBindingManager.activate.bind(figureBindingManager);
  figureBindingManager.activate = async (...args) => {
    const composition = await originalActivate(...args);
    const col = g2.columns.find(c => c.memberNo != null);
    if (col) runInAction(() => { col.memberNo = 'ZZ99'; });
    return composition;
  };
  const msgs = [];
  const ctx = createStructuralResolveContext({ peek: async (plane) => project.graphMap.get(plane.id) ?? null, save: async () => {} });
  try {
    await withPeek(project, async () => {
      try { await runStructuralModeSetup(g3, project, { onToast: m => msgs.push(m), ctx }); } finally { ctx.dispose(); }
    });
  } finally {
    figureBindingManager.activate = originalActivate;
    await figureBindingManager.deactivate();
  }
  assert.equal(g2.shapeMap.has(orphan.id), false, '前提: 2階の孤児が撤去された');
  assert.equal(msgs.length, 1, 'トーストは 1 回だけ');
  const parts = msgs[0].split(SEP);
  assert.equal(parts.length, 3, msgs[0]);
  assert.equal(parts[0], ERR_STRUCT_MAIN_UNSPECIFIED);
  assert.match(parts[1], /^材寸の変更にともない部材番号を振り直しました（ZZ99 → /, msgs[0]);
  assert.equal(parts[2], STAIR_CROSSING_REMOVED_MESSAGE);
});

test('【通知・失敗系】処理が例外で終わったときは通知を出さず、通知のスコープも残らない（次の再計算の通知が正しく 1 回出る）', async () => {
  const { project, g1, g2 } = makeFixture();
  project.activePlaneId = 'p2';
  hOrphan(g2);
  // 自階の再計算（孤児を撤去する）の後、下階の柱を読むところで例外を投げる composition
  const throwingBelow = new Proxy(g1, { get(t, p) { if (p === 'columns') throw new Error('boom'); return Reflect.get(t, p); } });
  await withHandler(project, async (msgs) => {
    await assert.rejects(
      recomputeStructuralComposition({ graphForCategory: () => throwingBelow }, g2, project, { pushUndo: false }),
      /boom/);
    assert.equal(g2.centerLines.filter(c => c.discipline === Discipline.FUSE && Math.abs(c.value - FRONT_Y) < 1).length, 0, '前提: 例外の前に撤去は行われた');
    assert.deepEqual(msgs, [], '例外時は通知しない');
    hOrphan(g2); // 改めて同型の孤児を足す
    await recomputeActiveStructural(project, false);
    assert.deepEqual(msgs, [STAIR_CROSSING_REMOVED_MESSAGE], 'スコープが残らず、次の再計算の通知は 1 回');
  });
});

test('【通知・失敗系】通知先が未登録でも例外を投げない', async () => {
  const { project, g2 } = makeFixture();
  project.activePlaneId = 'p2';
  hOrphan(g2);
  setStructuralToastHandler(null);
  await withPeek(project, () => assert.doesNotReject(recomputeActiveStructural(project, false)));
});
