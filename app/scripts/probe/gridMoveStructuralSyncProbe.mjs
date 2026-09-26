// 通り芯の移動→構造同期＋壁由来梁芯の追従（段階(c)。core/centerLineKindPolicy.js
// structuralSyncScopeOfKind・transform/centerLineOps.js commitCLMoveOp）の実データ確認用probe。
// ハーネスは scripts/probe/centerMoveStructuralSyncProbe.mjs の写し。起動口は本番と同じ
// commitCLMoveOp だけ（基準の冪等性確認だけ probeSync.request を直接呼ぶ）。
//
// 基準は収束させてから採る（centerMoveStructuralSyncProbe.mjsと同じpreConverge。**必須**）。
//
// 検出力（M3）は配線あり／なし比較（構造フィールド全体のダンプ差分）のみを使う——design-c.mdが
// 想定していたM3S分岐（S造はcolumnPlacement:'wallIntersections'のため配線あり／なし比較が効かない、
// という前提）は、structureRules.jsの実際のS造ルールがcolumnPlacement:'gridIntersections'
// （'wallIntersections'ではない。'wallIntersections'は在来木造のみ）であるため現行ルールでは
// 到達しないと判明し、リード裁定（2026-09-25）で削除した。実測でも13.stq（S造）はM3の配線あり／なし
// 比較で検出力が確認できている（gridIntersections柱は「配線なし」では移動後の再計算が走らず
// 旧位置のまま残るため差分が出る）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/gridMoveStructuralSyncProbe.mjs [入力.stq] [通り芯ラベル省略可]
import { performance } from 'node:perf_hooks';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { PlanGraph, centerLineKind, CenterLineType } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { undoManager } from '../../src/undoManager.js';
import { commitCLMoveOp, setCenterLineStructuralListener } from '../../src/transform/centerLineOps.js';
import { createStructuralSync } from '../../src/structural/structuralSync.js';
import { recomputeForStructuralSync } from '../../src/structural/structuralOrchestration.js';
import { createStructuralResolveContext } from '../../src/structural/structuralResolveContext.js';
import {
  findWallBeamAxisCL, peekAboveGraph, peekBelowGraph, isTraditionalWoodStructure, wallBeamSourcesFor,
} from '../../src/structural/wallBeamAxes.js';
import { floorBytesEqual } from '../../src/floorOps.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const labelArg = process.argv[3] ?? null;

let ngCount = 0;
function ok(cond, label) {
  if (cond) { console.log(`OK: ${label}`); return true; }
  console.log(`NG: ${label}`);
  ngCount++;
  return false;
}

// ---- 本番同型ハーネス（centerMoveStructuralSyncProbe.mjsと同じ手順）----
function buildHarness(docSrc) {
  const { project } = loadDocument(docSrc);
  const store = new Map();
  for (const [planeId, g] of project.graphMap) store.set(planeId, serializeGraph(g));

  const bytePeek = async (plane, structGraph) => {
    const g = new PlanGraph(plane);
    g._structGraph = structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
  const storeSave = async (planeId, bytes) => { store.set(planeId, bytes); };
  const activate = () => { floorSwapManager.peek = bytePeek; };

  // 段階(g)・2026-09-26: centerMoveStructuralSyncProbe.mjsと同じ「ctxArg明示（owned生成ではない）
  // なので呼び出し側のctxへwrapSaveを仕込む」型。
  const probeSync = createStructuralSync({
    recompute: (p, s, rec) => {
      const ctx = createStructuralResolveContext({ peek: bytePeek, save: rec ? rec.wrapSave(storeSave) : storeSave });
      return recomputeForStructuralSync(p, s, ctx).finally(() => ctx.dispose());
    },
    loadFloorBytes: (id) => store.get(id) ?? null,
  });

  return { project, store, bytePeek, storeSave, probeSync, activate };
}

// ---- ダンプ（柱のAXIS・role、梁の軸・範囲・role、基礎、壁の本数・幾何）----
async function dumpAll(h) {
  h.activate();
  const out = {};
  for (const plane of h.project.planeMap.values()) {
    const g = plane.id === h.project.activePlaneId ? h.project.activeGraph : await h.bytePeek(plane, h.project.structGraph);
    out[plane.name + (plane.isRoofPlane ? '(屋根)' : '')] = {
      columns: g.columns.map(c => `${c.role ?? ''}:${Math.round(c.axisX)},${Math.round(c.axisY)}`).sort(),
      beams: g.beams.map(b => `${b.role ?? ''}:${b.isVertical}:${Math.round(b.axisValue)}:` +
        `${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}`).sort(),
      footings: g.footings.map(f => `${f.constructor.name}:${Math.round(f.verticalCL.effectiveValue)},${Math.round(f.horizontalCL.effectiveValue)}`).sort(),
      wallCount: g.walls.length,
      wallGeom: g.walls.map(w => `${w.isVertical}:${Math.round(w.axisValue)}:${Math.round(w.coord1)}..${Math.round(w.coord2)}`).sort(),
    };
  }
  return out;
}

function diffDumps(a, b) {
  const diffs = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = JSON.stringify(a[k] ?? null), bv = JSON.stringify(b[k] ?? null);
    if (av !== bv) diffs.push({ floor: k, before: a[k] ?? null, after: b[k] ?? null });
  }
  return diffs;
}

function diffWallFieldsOnly(a, b) {
  const floors = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const wa = JSON.stringify({ wallGeom: a[k]?.wallGeom ?? null, wallCount: a[k]?.wallCount ?? null });
    const wb = JSON.stringify({ wallGeom: b[k]?.wallGeom ?? null, wallCount: b[k]?.wallCount ?? null });
    if (wa !== wb) floors.push(k);
  }
  return floors;
}

function diffStructOnly(a, b) {
  const diffs = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const strip = (o) => o && { columns: o.columns, beams: o.beams, footings: o.footings };
    const av = JSON.stringify(strip(a[k]) ?? null), bv = JSON.stringify(strip(b[k]) ?? null);
    if (av !== bv) diffs.push({ floor: k, before: a[k] ?? null, after: b[k] ?? null });
  }
  return diffs;
}

function printDiffs(diffs, limit = 5) {
  for (const d of diffs.slice(0, limit)) {
    console.log(`  差分[${d.floor}]:`);
    console.log(`    before: ${JSON.stringify(d.before)}`.slice(0, 400));
    console.log(`    after : ${JSON.stringify(d.after)}`.slice(0, 400));
  }
  if (diffs.length > limit) console.log(`  ...他${diffs.length - limit}件`);
}

console.log(`=== ${src} ===`);

async function preConverge(harness) {
  harness.activate();
  harness.probeSync.request(harness.project.activeGraph, harness.project, { scope: 'all' });
  await harness.probeSync.whenIdle();
}

// ---- M0: 基準の冪等性 ----
const hBase = buildHarness(src);
hBase.activate();
console.log(`主構造: ${hBase.project.structuralInfo.mainStructure} plane: ${hBase.project.activeGraph.plane.name}`);
await preConverge(hBase);
const baseDump1 = await dumpAll(hBase);
hBase.probeSync.request(hBase.project.activeGraph, hBase.project, { scope: 'all' });
await hBase.probeSync.whenIdle();
const baseDump2 = await dumpAll(hBase);
const baseDiffs = diffDumps(baseDump1, baseDump2);
ok(baseDiffs.length === 0, 'M0: 基準の冪等性（収束後、probeSync.request("all")を2回回しても全階ダンプ差分ゼロ）');
if (baseDiffs.length > 0) printDiffs(baseDiffs);

// ---- 候補選定: 通り芯（struct）×「平行な最寄り通り芯までの半分(5mm丸め)の移動量が0でない」----
function nearestParallelGrid(graph, cl) {
  let best = null, bestDist = Infinity;
  for (const other of graph.centerLines) {
    if (other.id === cl.id || other.centerLineType !== cl.centerLineType) continue;
    if (centerLineKind(other) !== 'struct') continue;
    const d = Math.abs(other.effectiveValue - cl.effectiveValue);
    if (d > 0 && d < bestDist) { bestDist = d; best = other; }
  }
  return best;
}
function moveAmountToward(cl, target) {
  const raw = (target.effectiveValue - cl.effectiveValue) / 2;
  return Math.round(raw / 5) * 5;
}

const activeForCandidates = hBase.project.activeGraph;
let candidates = activeForCandidates.centerLines.filter(cl => centerLineKind(cl) === 'struct');
if (labelArg) candidates = candidates.filter(cl => cl.label === labelArg);
candidates = candidates
  .map(cl => {
    const target = nearestParallelGrid(activeForCandidates, cl);
    if (!target) return null;
    const moveAmount = moveAmountToward(cl, target);
    if (moveAmount === 0) return null;
    return { id: cl.id, type: cl.centerLineType, value: cl.effectiveValue, moveAmount };
  })
  .filter(Boolean);
if (candidates.length === 0) {
  console.log(`NG: 移動候補（平行な最寄り通り芯への移動量が0でない通り芯）が無い（labelArg=${labelArg}）`);
  process.exit(1);
}

// saveFloorFn/captureBox（段階(g)）: centerMoveStructuralSyncProbe.mjsのtryMoveOnと同じ役割。
function tryMoveOn(harness, clId, moveAmount, wired, { saveFloorFn, captureBox } = {}) {
  if (wired) {
    setCenterLineStructuralListener((g, p, scope, undoRecords) => {
      if (captureBox) captureBox(undoRecords);
      harness.probeSync.request(g, p, { scope, undoRecords });
    });
  } else setCenterLineStructuralListener(null);
  harness.activate();
  const cl = harness.project.activeGraph.centerLines.find(c => c.id === clId);
  const originalValue = cl.value;
  runInAction(() => { cl.pendingDelta = moveAmount; });
  const { toast } = commitCLMoveOp(harness.project.activeGraph, harness.project, cl, originalValue, { saveFloorFn });
  setCenterLineStructuralListener(null);
  return { toast, originalValue };
}

let chosen = null;
for (const cand of candidates) {
  const hWired = buildHarness(src);
  const hUnwired = buildHarness(src);
  await preConverge(hWired);
  await preConverge(hUnwired);
  const { toast: toastWired } = tryMoveOn(hWired, cand.id, cand.moveAmount, true);
  await hWired.probeSync.whenIdle();
  const { toast: toastUnwired } = tryMoveOn(hUnwired, cand.id, cand.moveAmount, false);
  await hUnwired.probeSync.whenIdle();
  if (toastWired !== null || toastUnwired !== null) continue;
  const dumpWired = await dumpAll(hWired);
  const dumpUnwired = await dumpAll(hUnwired);
  const diffs = diffDumps(dumpWired, dumpUnwired);
  if (diffs.length > 0) {
    chosen = cand;
    console.log(`対象通り芯: id=${cand.id.slice(0, 8)} type=${cand.type} value=${Math.round(cand.value)} ` +
      `moveAmount=${cand.moveAmount}mm（配線あり／なしで${diffs.length}平面に差分。検出力あり）`);
    break;
  }
}
ok(chosen != null, 'M3: 検出力（配線あり／なしで結果が変わる候補が少なくとも1本ある）');
if (!chosen) {
  console.log('NG: 検出力なし（どの通り芯を移動しても効果が確認できない）');
  process.exit(1);
}

// ---- 本編（配線あり） ----
const h = buildHarness(src);
await preConverge(h);
setCenterLineStructuralListener((g, p, scope, undoRecords) => h.probeSync.request(g, p, { scope, undoRecords }));

const baselineDump = await dumpAll(h);
const beforeUndoTop = undoManager.peekUndo();
// 段階(g)・G1用: 「実際に変化した他平面」はstore（IDBバイト）の前後比較で判定する——dumpAllの
// decoded比較（diffDumps）は使わない。通り芯・中心線は project.structGraph 共有インスタンスの
// 値で、各階の梁・柱はそれをidで参照して都度evaluateするため、対象CLを移動すると「自階の
// floor-bytes自体は変わっていない他平面（屋根等）」のdumpまで見かけ上動く（bytePeek→restoreGraphが
// 都度、現在の共有structGraph値でaxisValue等を再計算するため）——box（saveFloor実行の記録）が
// 捉えるべきは「実際にIDBへ保存されたか」であって「dumpの見え方が変わったか」ではない
// （実測: 13.stqで屋根の梁axisValueがdump上は動くが屋根の階自体はsaveFloorされない）。
const storeBeforeBytes = new Map(h.store);

let boxAfterMove = null;
const tMoveStart = performance.now();
const { toast: mainToast, originalValue } = tryMoveOn(h, chosen.id, chosen.moveAmount, true, {
  saveFloorFn: h.storeSave,
  captureBox: (rec) => { boxAfterMove = rec; },
});
const tMoveEnd = performance.now();
await h.probeSync.whenIdle();
const tSyncEnd = performance.now();
ok(mainToast === null, `M1: commitCLMoveOp(通り芯移動)はtoast:nullで成功する（実際: ${mainToast}）`);
ok(undoManager.peekUndo() !== beforeUndoTop, 'M1: 確定でundoエントリが1件増える');

const afterMoveDump = await dumpAll(h);

// ---- G1/G2（段階(g)）: 箱は実際にsaveFloorされた他平面だけを指し、afterはstoreの現在値と一致する ----
const changedOtherPlaneIds = new Set(
  [...h.project.planeMap.values()]
    .filter(p => p.id !== h.project.activePlaneId)
    .map(p => p.id)
    .filter(id => !floorBytesEqual(storeBeforeBytes.get(id), h.store.get(id))),
);
const boxPlaneIds = new Set((boxAfterMove ?? []).map(r => r.planeId));
ok(Array.isArray(boxAfterMove), 'G1: コミット時notifyの第4引数(箱)は配列のはず');
ok([...boxPlaneIds].every(id => changedOtherPlaneIds.has(id)), 'G1: 箱に含まれるplaneIdはすべて実際にIDBへ保存された他平面のはず');
ok([...changedOtherPlaneIds].every(id => boxPlaneIds.has(id)), 'G1: 実際にIDBへ保存された他平面はすべて箱に含まれる（取りこぼしが無い）');
// G2: 同じplaneIdが複数回出うる（発見④と同じ規約）ため、各planeIdの最後のレコードのafterだけが
// storeの現在値と一致するはず。
const lastRecByPlaneMove = new Map();
for (const rec of boxAfterMove ?? []) lastRecByPlaneMove.set(rec.planeId, rec);
let g2ok = true;
for (const [planeId, rec] of lastRecByPlaneMove) {
  const current = h.store.get(planeId);
  if (!floorBytesEqual(rec.after, current)) { g2ok = false; console.log(`  NG詳細: 箱[${planeId.slice(0, 8)}]の最後のafterがstoreの現在値と不一致`); }
}
ok(g2ok, 'G2: 箱の各レコードのafterがstoreの現在値と一致する');
const retainedBytesMove = (boxAfterMove ?? []).reduce((sum, rec) => sum + (rec.before?.length ?? 0) + (rec.after?.length ?? 0), 0);
console.log(`保持バイト数: 箱の総容量=${retainedBytesMove}バイト（${boxAfterMove?.length ?? 0}件）`);

// ---- M2: whenIdle後の再要求で差分ゼロ（冪等）----
h.probeSync.request(h.project.activeGraph, h.project, { scope: 'all' });
await h.probeSync.whenIdle();
const afterSecondRun = await dumpAll(h);
const idempotentDiffs = diffDumps(afterMoveDump, afterSecondRun);
ok(idempotentDiffs.length === 0, 'M2: 移動後もう1回同期しても全階ダンプ差分ゼロ（冪等）');
if (idempotentDiffs.length > 0) printDiffs(idempotentDiffs);

// ---- M6: 移動後に旧座標の孤児梁芯が0本（NG判定。自階・自階の壁が根拠のもののみ）。
// 全階の孤児梁芯本数の一覧は情報表示（gridMove特有・design-c.md item5）----
const oldIsVertical = chosen.type === CenterLineType.VERTICAL;
const orphanAtOld = findWallBeamAxisCL(h.project.activeGraph, oldIsVertical, originalValue);
const belowGraphForM6 = await peekBelowGraph(h.project.activeGraph, h.project);
const sourcesForM6 = wallBeamSourcesFor(h.project.activeGraph, h.project, belowGraphForM6);
const oldStillHasSource = sourcesForM6.some(s => s.isVertical === oldIsVertical && Math.abs(s.coord - originalValue) < 0.5);
const genuineOrphan = orphanAtOld != null && !oldStillHasSource;
ok(!genuineOrphan, `M6: 移動後、旧座標(${Math.round(originalValue)})に孤児の壁由来梁芯が残っていない（自階のみ厳密判定）`);
if (genuineOrphan) console.log('  NG詳細: 旧座標に残っている梁芯id=', orphanAtOld.id.slice(0, 8));

// 全階の孤児梁芯本数一覧（情報。design-c.md「M6の全階の孤児梁芯本数の一覧」）。
async function countOrphansForFloor(g, project) {
  const beamCLs = g.centerLines.filter(cl => centerLineKind(cl) === 'beam');
  if (beamCLs.length === 0) return 0;
  const belowGraph = await peekBelowGraph(g, project);
  const sources = wallBeamSourcesFor(g, project, belowGraph);
  let orphanCount = 0;
  for (const cl of beamCLs) {
    const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
    const hasSource = sources.some(s => s.isVertical === isVertical && Math.abs(s.coord - cl.effectiveValue) < 0.5);
    if (!hasSource) orphanCount++;
  }
  return orphanCount;
}
console.log('M6(情報): 移動後・全階の孤児梁芯本数一覧（他階・下階由来は段階(g)まで許容——NG判定には使わない）');
for (const plane of h.project.planeMap.values()) {
  const g = plane.id === h.project.activePlaneId ? h.project.activeGraph : await h.bytePeek(plane, h.project.structGraph);
  const count = await countOrphansForFloor(g, h.project);
  console.log(`  ${plane.name}${plane.isRoofPlane ? '(屋根)' : ''}: 孤児梁芯 ${count}本`);
}

if (isTraditionalWoodStructure(h.project.structuralInfo.mainStructure)) {
  const aboveGraph = await peekAboveGraph(h.project.activeGraph, h.project);
  const orphanAbove = aboveGraph ? findWallBeamAxisCL(aboveGraph, oldIsVertical, originalValue) : null;
  console.log(`M6(情報): 上階の旧座標(${Math.round(originalValue)})孤児梁芯 = ${orphanAbove ? 1 : 0}本` +
    (aboveGraph ? '' : '（上階なし）'));
}

setCenterLineStructuralListener(null);

// ---- M7: undoでCL値が戻り、redo後のダンプが移動直後と一致（厳密）。段階(g)で他平面も厳密判定へ
// 昇格した（commitCLMoveOpの箱がapplyFloorUndoRecordsで他平面のIDBバイトを移動前へ戻すため）----
setCenterLineStructuralListener((g, p, scope, undoRecords) => h.probeSync.request(g, p, { scope, undoRecords }));

undoManager.undo();
await h.probeSync.whenIdle();
const clAfterUndo = h.project.activeGraph.centerLines.find(c => c.id === chosen.id);
ok(clAfterUndo?.value === originalValue, `M7: undoでCL値が移動前(${Math.round(originalValue)})に戻る（実際: ${clAfterUndo?.value}）`);
const afterUndoDump = await dumpAll(h);
const undoDiffs = diffStructOnly(baselineDump, afterUndoDump);
ok(undoDiffs.length === 0, 'M7(G3・厳密): undo後のダンプ（構造フィールド）が基準と一致する（自階・他平面とも厳密判定。段階(g)）');
if (undoDiffs.length > 0) printDiffs(undoDiffs);
const undoWallDiffs = diffWallFieldsOnly(baselineDump, afterUndoDump);
if (undoWallDiffs.length > 0) {
  console.log(`注意: undo後の壁幾何(wallGeom/wallCount)に${undoWallDiffs.length}階分差分あり（${undoWallDiffs.join(', ')}）（NGにしない）`);
}

// ---- M8（Q1裁定・dedupeColumnsByAxis対応）: 移動→undo→同期後、全階で同じAXIS座標に柱が2本以上ある
// 箇所が0本（NG判定）----
async function countDuplicateAxisSpots(harness) {
  harness.activate();
  let dupSpots = 0;
  for (const plane of harness.project.planeMap.values()) {
    const g = plane.id === harness.project.activePlaneId
      ? harness.project.activeGraph : await harness.bytePeek(plane, harness.project.structGraph);
    const groups = [];
    for (const c of g.columns) {
      let group = groups.find(gr => Math.abs(gr.axisX - c.axisX) < 0.5 && Math.abs(gr.axisY - c.axisY) < 0.5);
      if (!group) { group = { axisX: c.axisX, axisY: c.axisY, count: 0 }; groups.push(group); }
      group.count++;
    }
    dupSpots += groups.filter(gr => gr.count >= 2).length;
  }
  return dupSpots;
}
const dupSpotsAfterUndo = await countDuplicateAxisSpots(h);
ok(dupSpotsAfterUndo === 0, `M8: 移動→undo→同期後、全階で同じAXISに柱が2本以上ある箇所が0（実際: ${dupSpotsAfterUndo}件）`);

undoManager.redo();
await h.probeSync.whenIdle();
const afterRedoDump = await dumpAll(h);
const redoDiffs = diffStructOnly(afterMoveDump, afterRedoDump);
ok(redoDiffs.length === 0, 'M7/G4: redo後のダンプ（構造フィールド）が移動直後と一致する（全平面厳密）');
if (redoDiffs.length > 0) printDiffs(redoDiffs);
const redoWallDiffs = diffWallFieldsOnly(afterMoveDump, afterRedoDump);
if (redoWallDiffs.length > 0) {
  console.log(`注意: redo後の壁幾何(wallGeom/wallCount)に${redoWallDiffs.length}階分差分あり（${redoWallDiffs.join(', ')}）（NGにしない）`);
}

setCenterLineStructuralListener(null);

// ---- G5（段階(g)）: 検出力の対照。undoRecordsを一切forwardしない箱無効ハーネスで同じ操作→undoを
// 行い、他平面に差分が残ることを確認する（0件なら検出力なしと明記してNGにしない）----
const hNoBox = buildHarness(src);
await preConverge(hNoBox);
setCenterLineStructuralListener((g, p, scope) => hNoBox.probeSync.request(g, p, { scope })); // undoRecords無し
const baselineDumpNoBox = await dumpAll(hNoBox);
hNoBox.activate();
const clG5 = hNoBox.project.activeGraph.centerLines.find(c => c.id === chosen.id);
const origG5 = clG5.value;
runInAction(() => { clG5.pendingDelta = chosen.moveAmount; });
const { toast: g5Toast } = commitCLMoveOp(hNoBox.project.activeGraph, hNoBox.project, clG5, origG5, { saveFloorFn: hNoBox.storeSave });
await hNoBox.probeSync.whenIdle();
if (g5Toast !== null) {
  console.log(`G5: 検出力の対照をスキップ（コミット拒否。実際のtoast=${g5Toast}）`);
} else {
  undoManager.undo();
  await hNoBox.probeSync.whenIdle();
  const afterUndoDumpNoBox = await dumpAll(hNoBox);
  const g5Diffs = diffStructOnly(baselineDumpNoBox, afterUndoDumpNoBox);
  if (g5Diffs.length === 0) {
    console.log('G5: 検出力なし（このデータ・この操作では記録を無効にしても他平面に差分が出ない）');
  } else {
    console.log(`G5: 検出力あり（記録を無効にすると他平面を含め${g5Diffs.length}件の差分が残る＝箱方式の必要性を実証）`);
  }
}
setCenterLineStructuralListener(null);

// ---- 計時: 独立に3回読み込み、移動確定〜whenIdleの中央値を確定部分・同期部分に分けて出す ----
const commitMs = [], syncMs = [];
for (let i = 0; i < 3; i++) {
  const hp = buildHarness(src);
  await preConverge(hp);
  const clP = hp.project.activeGraph.centerLines.find(c => c.id === chosen.id);
  const origP = clP.value;
  runInAction(() => { clP.pendingDelta = chosen.moveAmount; });
  setCenterLineStructuralListener((g, p, s, undoRecords) => hp.probeSync.request(g, p, { scope: s, undoRecords }));
  const t0 = performance.now();
  commitCLMoveOp(hp.project.activeGraph, hp.project, clP, origP, { saveFloorFn: hp.storeSave });
  const t1 = performance.now();
  await hp.probeSync.whenIdle();
  const t2 = performance.now();
  commitMs.push(t1 - t0);
  syncMs.push(t2 - t1);
  setCenterLineStructuralListener(null);
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
console.log(`性能: 確定部分(commitCLMoveOp呼び出し)中央値=${median(commitMs).toFixed(1)}ms ` +
  `[${commitMs.map(v => v.toFixed(1)).join(', ')}] / 同期部分(whenIdle)中央値=${median(syncMs).toFixed(1)}ms ` +
  `[${syncMs.map(v => v.toFixed(1)).join(', ')}]`);
console.log(`性能(参考): 移動確定の実測(本編) = ${(tMoveEnd - tMoveStart).toFixed(1)}ms / 同期 = ${(tSyncEnd - tMoveEnd).toFixed(1)}ms`);

if (ngCount === 0) {
  console.log(`OK: gridMoveStructuralSyncProbe 全項目パス（${src}）`);
} else {
  console.log(`NG: ${ngCount}件の不一致（${src}）`);
  process.exitCode = 1;
}
