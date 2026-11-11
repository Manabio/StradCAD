// S2b: 在来木造の再計算で、手動・固定（auto でない）の柱が既にある AXIS 位置には自動の柱を作らない（案A。
// woodAutoFill.js autoFillWoodColumns の作成段。dedupeColumnsByAxis の Q1 裁定の前倒し）と、手動柱を消した後に
// 梁芯の組のキーの auto 柱が復活しない（manualMemberCommit.js commitManualMemberRemoval の除外記録）のテスト。
// fixture は原点から離した座標（縦壁 x=3300・横壁 y=4700 の十字。通り芯 x 1300/5300・y 2700/6700）。
// 柱・graph・CL は循環参照を持つため assert.equal に渡さず id・位置で比べる。.jsx/store.js/snap.js は import しない。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline, StructuralMaterialType, OpeningCategory, centerLineKind, columnSlotKey } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { undoManager } from '../undoManager.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { autoFillWallBeamAxes, selfWallSegments } from './wallBeamAxes.js';
import { autoFillWoodColumns } from './woodAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { commitManualColumnAdd, commitManualMemberRemoval } from './manualMemberCommit.js';

const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;
const WX = 3300, WY = 4700;
const WOOD_120 = 'WOOD-120x120';

let originalPeek;
beforeEach(() => {
  originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => null;
  undoManager._undoStack.splice(0);
  undoManager._redoStack.splice(0);
});
afterEach(() => { floorSwapManager.peek = originalPeek; });

function build(structure = TRADITIONAL_WOOD_STRUCTURE) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = structure;
  const sg = project.structGraph;
  const gx = [1300, 5300].map(v => sg.addCenterLine(V, v, { labeled: true, discipline: Discipline.STRUCT }));
  const gy = [2700, 6700].map(v => sg.addCenterLine(H, v, { labeled: true, discipline: Discipline.STRUCT }));
  const wall = (isVertical, value, a, b) => {
    const axisCL = graph.addCenterLine(isVertical ? V : H, value, { labeled: false, discipline: Discipline.ARCH });
    return graph.addWall(axisCL, 0, isVertical, a, 0, b, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  };
  const vWall = wall(true, WX, gy[0], gy[1]);
  const hWall = wall(false, WY, gx[0], gx[1]);
  return { project, graph, gx, gy, vWall, hWall, cV: vWall.axisCL, cH: hWall.axisCL };
}
const beamAt = (graph, type, value) => graph.centerLines.find(cl => centerLineKind(cl) === 'beam' && cl.centerLineType === type && cl.value === value);
function withBeamAxes() {
  const env = build();
  autoFillWallBeamAxes(env.graph, selfWallSegments(env.graph));
  env.bV = beamAt(env.graph, V, WX);
  env.bH = beamAt(env.graph, H, WY);
  return env;
}
const at = (graph, x, y) => graph.columns.filter(c => Math.abs(c.x - x) < 1 && Math.abs(c.y - y) < 1);
const atCross = graph => at(graph, WX, WY);
const kinds = c => `${centerLineKind(c.verticalCL)}/${centerLineKind(c.horizontalCL)}`;
const dump = graph => graph.columns.map(c => `${c.x},${c.y}:${c.dimensionStatus}:${kinds(c)}`).sort();

// 柱の作成（graph.addColumn）・撤去（columnMap.delete）を位置つきで記録する。
function instrument(graph) {
  const log = { created: [], removed: [] };
  const add = graph.addColumn.bind(graph);
  graph.addColumn = (...a) => { const c = add(...a); log.created.push({ id: c.id, x: c.x, y: c.y }); return c; };
  const del = graph.columnMap.delete.bind(graph.columnMap);
  graph.columnMap.delete = id => { const c = graph.columnMap.get(id); if (c) log.removed.push({ id, x: c.x, y: c.y }); return del(id); };
  return log;
}
const isCross = p => Math.abs(p.x - WX) < 1 && Math.abs(p.y - WY) < 1;

// ---- 順序 C（核心）: 手動柱が先・梁芯が後 ----
test('【S2b・順序C】梁芯が無い間に中心線の組で手動柱→再計算 4 回: 手動柱の位置に auto 柱は作られず、2〜4 回目は作成 0・撤去 0・changed=false', async () => {
  const { graph, project, cV, cH } = build();
  assert.equal(graph.centerLines.filter(cl => centerLineKind(cl) === 'beam').length, 0, '前提: 梁芯なし');
  const manual = commitManualColumnAdd(graph, project, { vCL: cV, hCL: cH });
  assert.equal(kinds(manual), 'center/center', '前提: 中心線の組で立つ');
  const log = instrument(graph);
  const results = [];
  for (let i = 0; i < 4; i++) {
    log.created.length = 0; log.removed.length = 0;
    const r = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
    results.push({ changed: r.changed, created: [...log.created], removed: [...log.removed] });
  }
  assert.ok(beamAt(graph, V, WX) && beamAt(graph, H, WY), '1 回目で梁芯が生えた');
  assert.ok(results[0].created.length >= 4, `1 回目: 他の交点に auto 柱が立つ（補完経路が動いた証拠。実際 ${results[0].created.length} 本）`);
  assert.equal(results[0].created.some(isCross), false, '1 回目: 手動柱の位置には作られない');
  assert.equal(results[0].removed.some(isCross), false, '1 回目: その位置の撤去もない（作って消す、が起きない）');
  for (const i of [1, 2, 3]) {
    assert.deepEqual(results[i].created, [], `${i + 1} 回目: 作成 0`);
    assert.deepEqual(results[i].removed, [], `${i + 1} 回目: 撤去 0`);
    assert.equal(results[i].changed, false, `${i + 1} 回目: changed=false`);
  }
  assert.deepEqual(atCross(graph).map(c => c.id), [manual.id], '手動柱 1 本が id 不変で残る');
  assert.equal(manual.dimensionStatus, 'locked');
  assert.equal(columnSlotKey(manual.verticalCL, manual.horizontalCL), columnSlotKey(cV, cH), '中心線の組のまま');
  // 最終状態（抑止の有無に依らず同じはずの状態）
  assert.deepEqual(dump(graph), [
    '1300,4700:auto:struct/beam', '3300,2700:auto:beam/struct', '3300,4700:locked:center/center',
    '3300,6700:auto:beam/struct', '5300,4700:auto:struct/beam',
  ]);
});

// 最終状態だけを見る（作成・撤去の記録は見ない）。抑止の有無に依らず同じ最終状態になること（案A は「作ってから消す」を
// 「作らない」にするだけ）の確認: 抑止を外した変異でもこのテストは緑のまま（赤になるのは上の created/removed の assert だけ）。
test('【S2b・最終状態】再計算 4 回後の柱の集合は、手動柱 1 本（中心線の組）＋他の交点の auto 柱 4 本', async () => {
  const { graph, project, cV, cH } = build();
  const manual = commitManualColumnAdd(graph, project, { vCL: cV, hCL: cH });
  for (let i = 0; i < 4; i++) await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  assert.deepEqual(dump(graph), [
    '1300,4700:auto:struct/beam', '3300,2700:auto:beam/struct', '3300,4700:locked:center/center',
    '3300,6700:auto:beam/struct', '5300,4700:auto:struct/beam',
  ]);
  assert.deepEqual(atCross(graph).map(c => c.id), [manual.id]);
});

// ---- auto でない柱はすべて対象（locked／calculated／manual）。auto は対象外 ----
for (const status of ['locked', 'calculated', 'manual']) {
  test(`【S2b】dimensionStatus=${status} の既存柱がある位置（キーは別＝中心線の組）には auto 柱を作らず、その柱も撤去しない`, () => {
    const { graph, project, cV, cH } = withBeamAxes();
    const col = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, cV, cH, {});
    col.setDimensionStatus(status);
    const { created, removed } = autoFillWoodColumns(graph, project, null);
    assert.equal(created.some(c => Math.abs(c.x - WX) < 1 && Math.abs(c.y - WY) < 1), false, '交点に auto 柱は作られない');
    assert.equal(removed.includes(col.id), false);
    assert.deepEqual(atCross(graph).map(c => c.id), [col.id]);
  });
}

test('【S2b・対照】既存柱が auto なら従来どおり（梁芯の組の auto 柱が作られ、同じ位置は 1 本に整理される）', () => {
  const { graph, project, cV, cH } = withBeamAxes();
  const col = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, cV, cH, {}); // auto のまま
  const { created, removed } = autoFillWoodColumns(graph, project, null);
  assert.equal(created.some(c => Math.abs(c.x - WX) < 1 && Math.abs(c.y - WY) < 1), true, '抑止されず梁芯の組の柱が作られる');
  assert.equal(removed.includes(col.id), true, '候補に無い auto 柱は撤去される（従来どおり）');
  assert.equal(atCross(graph).length, 1);
  assert.equal(kinds(atCross(graph)[0]), 'beam/beam');
});

test('【S2b】基礎（role:foundation）の柱が同位置にあっても抑止しない（dedupe の母集団から外れるのと同じ）', () => {
  const { graph, project, cV, cH } = withBeamAxes();
  const f = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, cV, cH, { role: 'foundation' });
  f.setDimensionStatus('locked');
  const { created } = autoFillWoodColumns(graph, project, null);
  assert.equal(created.some(c => Math.abs(c.x - WX) < 1 && Math.abs(c.y - WY) < 1), true, '基礎では抑止されず auto 柱が作られる');
});

// ---- 位置の許容（dedupe と同じ境界 CL_OVERLAP_TOL_MM=0.5） ----
test('【S2b】AXIS が 0.4mm ずれた手動柱→抑止／0.6mm ずれた手動柱→抑止しない（従来は 2 本とも残る境界）', () => {
  for (const [dx, suppressed] of [[0.4, true], [0.6, false]]) {
    const { graph, project, cH } = withBeamAxes();
    const v = graph.addCenterLine(V, WX + dx, { labeled: false, discipline: Discipline.ARCH });
    const col = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, v, cH, {});
    col.setDimensionStatus('locked');
    const { created } = autoFillWoodColumns(graph, project, null);
    const madeAtCross = created.some(c => Math.abs(c.axisX - WX) < 0.1 && Math.abs(c.axisY - WY) < 0.1);
    assert.equal(madeAtCross, !suppressed, `dx=${dx}: ${suppressed ? '抑止される' : '抑止されず 2 本とも残る'}`);
    assert.equal(graph.columns.filter(c => Math.abs(c.axisY - WY) < 0.1 && Math.abs(c.axisX - WX) < 1).length, suppressed ? 1 : 2);
  }
});

test('【S2b】スロットの AXIS は作られる柱の axisX/axisY と同じ（柱芯オフセット columnAxisOffsets を含む）', () => {
  const { graph, project, cH, bV } = withBeamAxes();
  graph.columnAxisOffsets.set(bV.id, 30); // 梁芯 x=3300 の柱は AXIS x=3330 に立つ
  // 対照: 手動柱が無ければ AXIS (3330,4700) に auto 柱が作られる
  const probe = autoFillWoodColumns(graph, project, null);
  const made = probe.created.find(c => Math.abs(c.verticalCL.value - WX) < 1 && Math.abs(c.horizontalCL.value - WY) < 1);
  assert.ok(made, '前提: 交点の auto 柱が作られる');
  assert.deepEqual([made.axisX, made.axisY], [WX + 30, WY]);
  graph.columnMap.delete(made.id);
  // AXIS (3330,4700) に別の CL の組の手動柱（キーは別）→ 作られない
  const c33 = graph.addCenterLine(V, WX + 30, { labeled: false, discipline: Discipline.ARCH });
  const manual = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, c33, cH, {});
  manual.setDimensionStatus('locked');
  assert.deepEqual([manual.axisX, manual.axisY], [WX + 30, WY]);
  const { created } = autoFillWoodColumns(graph, project, null);
  assert.equal(created.some(c => Math.abs(c.axisX - (WX + 30)) < 1 && Math.abs(c.axisY - WY) < 1), false, 'AXIS が一致するので作られない');
});

test('【S2b・境界】AXIS の差がちょうど CL_OVERLAP_TOL_MM（0.5mm。2 進で正確な 3300.5）なら抑止しない（< の境界）', () => {
  const { graph, project, cH } = withBeamAxes();
  const v = graph.addCenterLine(V, WX + 0.5, { labeled: false, discipline: Discipline.ARCH });
  const col = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, v, cH, {});
  col.setDimensionStatus('locked');
  assert.equal(col.axisX - WX, 0.5, '前提: 差はちょうど 0.5');
  const { created } = autoFillWoodColumns(graph, project, null);
  assert.equal(created.some(c => c.axisX === WX && c.axisY === WY), true, '0.5 ちょうどは別位置として auto 柱が作られる');
});

test('【S2b】袖柱（locked）が同じ AXIS 位置にあっても、袖柱でないスロットは抑止されない（母集団から袖柱を外す）', () => {
  const { graph, project, cV, cH } = withBeamAxes();
  const jamb = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, cV, cH, { woodJambRef: { openingId: 'op-x', side: -1, isVertical: false } });
  jamb.setDimensionStatus('locked');
  assert.deepEqual([jamb.axisX, jamb.axisY].map(Math.round), [WX, WY], '前提: 袖柱の AXIS が交点に重なる');
  const { created } = autoFillWoodColumns(graph, project, null);
  assert.equal(created.some(c => !c.woodJambRef && Math.abs(c.axisX - WX) < 1 && Math.abs(c.axisY - WY) < 1), true, '袖柱に抑止されず交点の auto 柱が作られる');
});

test('【S2b】ドラッグ中（pendingDelta≠0）の CL でも、スロットの位置は作られる柱の axisX（effectiveValue）と一致する', () => {
  const { graph, project, cV, cH } = build();
  runInAction(() => { cV.pendingDelta = 40; }); // 縦壁の軸 CL: value 3300・effectiveValue 3340
  const probe = autoFillWoodColumns(graph, project, null);
  const made = probe.created.find(c => c.verticalCL.id === cV.id && c.horizontalCL.id === cH.id);
  assert.ok(made, '前提: ドラッグ中の CL の組で auto 柱が作られる');
  assert.equal(made.axisX, WX + 40, '前提: 作られる柱の AXIS は effectiveValue');
  graph.columnMap.delete(made.id);
  const cM = graph.addCenterLine(V, WX + 40, { labeled: false, discipline: Discipline.ARCH });
  const manual = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, cM, cH, {});
  manual.setDimensionStatus('locked');
  assert.equal(columnSlotKey(manual.verticalCL, manual.horizontalCL) === columnSlotKey(cV, cH), false, '前提: キーは別');
  const { created } = autoFillWoodColumns(graph, project, null);
  assert.equal(created.some(c => c.verticalCL.id === cV.id && c.horizontalCL.id === cH.id), false, 'AXIS(3340) が一致するので作られない');
});

// ---- オフセット柱のスロット（woodAxisOffset）は実位置（AXIS）で判定する ----
// woodAutoFill.test.js の makeWoodLineWithRunGraph と同じ構成を (+1300, +2700) へ平行移動したもの
// （壁 y=4700・x=2300・x=4300(T字)。x=3800 を横切る上階の梁で走行方向 CL が解決できずオフセット柱になる）。
function offsetFixture() {
  const project = new Project('proj-off', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const sg = project.structGraph;
  const [x1, x2] = [1300, 5300].map(v => sg.addCenterLine(V, v, { labeled: true, discipline: Discipline.STRUCT }));
  const [y1, y2] = [2700, 6700].map(v => sg.addCenterLine(H, v, { labeled: true, discipline: Discipline.STRUCT }));
  const wall = (value, isVertical, a, b) => {
    const axisCL = graph.addCenterLine(isVertical ? V : H, value, { labeled: false, discipline: Discipline.ARCH });
    return graph.addWall(axisCL, 0, isVertical, a, 0, b, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  };
  wall(4700, false, x1, x2);                                   // 横壁 y=4700
  wall(2300, true, y1, y2);                                    // 縦壁 x=2300
  const ym = graph.addCenterLine(H, 4700, { labeled: false, discipline: Discipline.ARCH });
  wall(4300, true, ym, y2);                                    // 縦壁 x=4300（T字）
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  return { project, graph, wallSegments: selfWallSegments(graph), ym };
}
const TIE = [{ isVertical: true, coord: 3800, lo: 3700, hi: 5700 }]; // 縦の上階梁 x=3800（y 3700..5700）が横壁 y=4700 を横切る
const offsetCol = graph => graph.columns.find(c => c.woodAxisOffset);

test('【S2b・オフセット】対照: 実位置 (3800,4700) にオフセット柱が立つ（AXIS＝実位置）', () => {
  const { project, graph, wallSegments } = offsetFixture();
  autoFillWoodColumns(graph, project, null, [], wallSegments, TIE);
  const col = offsetCol(graph);
  assert.ok(col, '前提: オフセット柱が立つ');
  assert.deepEqual([col.axisX, col.axisY], [3800, 4700]);
});

// このテストが固定するのは「従来から」の挙動: オフセット候補は既存柱（locked 含む）の断面矩形との重なり規則で、
// 抑止より前の段で既に省略される（抑止を外しても緑）。S2b の抑止そのものがオフセット柱を止める構成は、同じ AXIS 位置の
// 柱が必ず重なり規則に掛かるため作れない（T1 は構成不能。報告参照）。抑止の「実位置で判定する」側は次の
// プレースホルダ側のテストが固定する（CL の位置で判定する変異で赤）。
test('【S2b・オフセット（従来の重なり規則）】オフセット柱の実位置に、キーの違う手動柱があれば作られない（抑止より前の段で省略）', () => {
  const { project, graph, wallSegments, ym } = offsetFixture();
  // 3800 に最も近い CL（3790）がプレースホルダ。手動柱は別の CL（3900＋柱芯オフセット-100）の組で AXIS が (3800,4700)。
  graph.addCenterLine(V, 3790, { labeled: false, discipline: Discipline.ARCH });
  const c39 = graph.addCenterLine(V, 3900, { labeled: false, discipline: Discipline.ARCH });
  graph.columnAxisOffsets.set(c39.id, -100);
  const manual = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, c39, ym, {});
  manual.setDimensionStatus('locked');
  assert.deepEqual([manual.axisX, manual.axisY], [3800, 4700], '前提: 手動柱の AXIS が実位置');
  const { created } = autoFillWoodColumns(graph, project, null, [], wallSegments, TIE);
  assert.equal(created.some(c => c.woodAxisOffset), false, '実位置に手動柱があるのでオフセット柱は作られない');
  assert.ok(graph.columnMap.has(manual.id));
});

test('【S2b・オフセット】CL の位置（プレースホルダ側 (4300,4700)）に手動柱があっても、実位置が違えばオフセット柱は作られる', () => {
  const { project, graph, wallSegments } = offsetFixture();
  autoFillWoodColumns(graph, project, null, [], wallSegments, TIE);
  const off = offsetCol(graph);
  const placeholderCol = graph.columns.find(c => !c.woodAxisOffset && Math.abs(c.axisX - 4300) < 1 && Math.abs(c.axisY - 4700) < 1);
  assert.ok(off && placeholderCol, '前提: オフセット柱と、プレースホルダ位置の 3a 柱がある');
  placeholderCol.setDimensionStatus('locked');
  graph.columnMap.delete(off.id);
  const { created } = autoFillWoodColumns(graph, project, null, [], wallSegments, TIE);
  const again = created.find(c => c.woodAxisOffset);
  assert.ok(again, 'プレースホルダ位置の手動柱に引きずられず、実位置のオフセット柱が再生成される');
  assert.deepEqual([again.axisX, again.axisY], [3800, 4700]);
});

// ---- 袖柱のスロットは抑止の対象外（従来どおり） ----
// 袖柱の生成可否は袖柱自身の重なり判定（既存柱の断面矩形との重なり。locked 含む）で決まり、同じ AXIS 位置に
// 手動柱がある袖柱は S2b の抑止より前にその規則で省略される（reason:'overlap'）。抑止の袖柱除外はこの挙動を変えないための
// 明示であり、観測できる挙動は従来と同じ（重なる側だけ省略・反対側は作られる）。
test('【S2b・袖柱】同じ AXIS 位置に手動柱があっても袖柱の扱いは従来どおり（重なる側は袖柱の重なり規則で省略・反対側は作られる）', () => {
  const project = new Project('proj-jamb', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const sg = project.structGraph;
  const [x1, x2] = [1300, 5300].map(v => sg.addCenterLine(V, v, { labeled: true, discipline: Discipline.STRUCT }));
  const axisCL = graph.addCenterLine(H, 4700, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, 0, false, x1, 0, x2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  graph.addOpening(wall.axisCL, 1, false, x1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {}); // 2850〜3750
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  const control = autoFillWoodColumns(graph, project, null);
  const jambs = control.created.filter(c => c.woodJambRef);
  assert.equal(jambs.length, 2, '前提: 両袖に袖柱');
  const lo = jambs.find(c => c.woodJambRef.side === -1);
  assert.equal(lo.x, 2785);
  // 袖柱を消し、同じ AXIS 位置（2785,4700）に手動柱を CL の組で立ててから再計算する
  for (const j of jambs) graph.columnMap.delete(j.id);
  const v = graph.addCenterLine(V, 2785, { labeled: false, discipline: Discipline.ARCH });
  const manual = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, v, axisCL, {});
  manual.setDimensionStatus('locked');
  const { created, jambSkipped } = autoFillWoodColumns(graph, project, null);
  const madeJambs = created.filter(c => c.woodJambRef);
  assert.deepEqual(madeJambs.map(c => c.woodJambRef.side), [1], '反対側（+1）の袖柱は作られる');
  assert.deepEqual(jambSkipped.map(s => `${s.side}:${s.reason}`), ['-1:overlap'], '手動柱と重なる側は従来の重なり規則で省略');
  assert.ok(graph.columnMap.has(manual.id), '手動柱も残る（dedupe は袖柱を母集団から外す）');
});

// ---- 削除後の復活（commitManualMemberRemoval の除外記録） ----
test('【S2b・削除】梁芯が後から生えた位置の手動柱（中心線の組）を消すと、梁芯の組のキーも除外され、再計算で復活しない（undo で戻る）', async () => {
  const { graph, project, cV, cH } = build();
  const manual = commitManualColumnAdd(graph, project, { vCL: cV, hCL: cH });
  await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE); // 梁芯が生える
  const bV = beamAt(graph, V, WX), bH = beamAt(graph, H, WY);
  assert.ok(bV && bH);
  assert.equal(graph.excludedColumnSlots.size, 0, '前提: 除外集合は空');
  assert.equal(commitManualMemberRemoval(graph, project, 'columnMap', [manual.id]), 1);
  assert.equal(graph.excludedColumnSlots.has(columnSlotKey(cV, cH)), true, '柱自身（中心線の組）のキー');
  assert.equal(graph.excludedColumnSlots.has(columnSlotKey(bV, bH)), true, '解決後（梁芯の組）のキー');
  const log = instrument(graph);
  for (let i = 0; i < 2; i++) {
    const r = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(r.changed, false, `削除後 ${i + 1} 回目: changed=false`);
    assert.equal(atCross(graph).length, 0, `削除後 ${i + 1} 回目: 交点に柱が復活しない`);
  }
  assert.deepEqual(log.created, []);
  undoManager.undo();
  assert.deepEqual(atCross(graph).map(c => c.id), [manual.id], 'undo で手動柱が戻る');
  assert.equal(graph.excludedColumnSlots.size, 0, 'undo で除外集合も削除前（空）に戻る');
  undoManager.redo();
  assert.equal(graph.excludedColumnSlots.has(columnSlotKey(bV, bH)), true, 'redo で解決後のキーの除外も戻る');
});

test('【S2b・削除】複数 id を 1 回で消すと、各柱の解決後のキーがすべて除外され、2 か所とも復活しない（undo で戻る）', async () => {
  const { graph, project, cV, cH, gx } = build();
  const axisCL2 = graph.addCenterLine(H, 6000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(axisCL2, 0, false, gx[0], 0, gx[1], 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 }); // 横壁 y=6000（交点 2 つ目）
  const m1 = commitManualColumnAdd(graph, project, { vCL: cV, hCL: cH });
  const m2 = commitManualColumnAdd(graph, project, { vCL: cV, hCL: axisCL2 });
  await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE); // 梁芯が生える
  const bV = beamAt(graph, V, WX), bH1 = beamAt(graph, H, WY), bH2 = beamAt(graph, H, 6000);
  assert.ok(bV && bH1 && bH2, '前提: 3 本の梁芯');
  assert.equal(at(graph, WX, 6000).length, 1, '前提: 2 か所目に手動柱');
  assert.equal(graph.excludedColumnSlots.size, 0);
  assert.equal(commitManualMemberRemoval(graph, project, 'columnMap', [m1.id, m2.id]), 2);
  for (const k of [columnSlotKey(cV, cH), columnSlotKey(bV, bH1), columnSlotKey(cV, axisCL2), columnSlotKey(bV, bH2)]) {
    assert.equal(graph.excludedColumnSlots.has(k), true, `除外されている: ${k}`);
  }
  for (let i = 0; i < 3; i++) {
    await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(atCross(graph).length, 0, `再計算 ${i + 1} 回目: 交点 1 に復活しない`);
    assert.equal(at(graph, WX, 6000).length, 0, `再計算 ${i + 1} 回目: 交点 2 に復活しない`);
  }
  undoManager.undo();
  assert.deepEqual([atCross(graph).map(c => c.id), at(graph, WX, 6000).map(c => c.id)], [[m1.id], [m2.id]], 'undo で 2 本が戻る');
  assert.equal(graph.excludedColumnSlots.size, 0, 'undo で除外集合も戻る');
});

test('【S2b・削除】非在来は解決が恒等なので、除外集合には柱自身のキーだけ', () => {
  const { graph, project, cV, cH } = build('S造');
  const col = graph.addColumn(StructuralMaterialType.STEEL, 'STEEL-H200x200', cV, cH, {});
  commitManualMemberRemoval(graph, project, 'columnMap', [col.id]);
  assert.deepEqual([...graph.excludedColumnSlots], [columnSlotKey(cV, cH)]);
});

test('【S2b・削除】在来木造でも梁芯の組で立つ柱は柱自身のキーだけ（解決後と同じ）', () => {
  const { graph, project, cV, cH, bV, bH } = withBeamAxes();
  const col = commitManualColumnAdd(graph, project, { vCL: cV, hCL: cH });
  assert.equal(columnSlotKey(col.verticalCL, col.horizontalCL), columnSlotKey(bV, bH));
  commitManualMemberRemoval(graph, project, 'columnMap', [col.id]);
  assert.deepEqual([...graph.excludedColumnSlots], [columnSlotKey(bV, bH)]);
});

test('【S2b・削除】袖柱・オフセット柱は自身のキー（jamb:／off:）だけ。解決後のキーは足さない', () => {
  const { graph, project, cV, cH } = withBeamAxes();
  const jamb = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, cV, cH, { woodJambRef: { openingId: 'op-1', side: -1, isVertical: false } });
  commitManualMemberRemoval(graph, project, 'columnMap', [jamb.id]);
  assert.deepEqual([...graph.excludedColumnSlots], ['jamb:op-1:-1']);
  graph.excludedColumnSlots.clear();
  const off = graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, cV, cH, { woodAxisOffset: { isVertical: true, offset: 100 } });
  const key = `off:${Math.round(off.axisX)}:${Math.round(off.axisY)}`;
  commitManualMemberRemoval(graph, project, 'columnMap', [off.id]);
  assert.deepEqual([...graph.excludedColumnSlots], [key]);
});

test('【S2b・削除】柱以外（梁）の削除では除外集合に柱のキーを足さない', () => {
  const { graph, project, gx, gy } = withBeamAxes();
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x240', gy[0], false, gx[0], gx[1], {});
  commitManualMemberRemoval(graph, project, 'beamMap', [beam.id]);
  assert.equal(graph.excludedColumnSlots.size, 0);
});
