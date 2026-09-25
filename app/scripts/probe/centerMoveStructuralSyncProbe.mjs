// 中心線の移動→構造同期＋壁由来梁芯の追従（段階(b)。core/centerLineKindPolicy.js
// structuralSyncScopeOnMove・transform/centerLineOps.js commitCLMoveOp・
// structural/wallBeamAxisFollow.js followWallBeamAxes）の実データ確認用probe。
// ハーネスは scripts/probe/gridDeleteStructuralSyncProbe.mjs の写し（centerDeleteStructuralSyncProbe.mjs
// と同型）。起動口は本番と同じ commitCLMoveOp だけ（基準の冪等性確認だけ probeSync.request を直接呼ぶ）。
//
// 基準は収束させてから採る（centerDeleteStructuralSyncProbe.mjsと同じpreConverge。**必須**）:
// .stqの生データは構造未同期のことがあるため、移動前の基準を素の読込み直後ではなく「'all'で1回
// 収束させた状態」にする——未収束のままだと収束の副作用が「移動の効果」に混入し、M7のundo基準比較が
// 無意味になる。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/centerMoveStructuralSyncProbe.mjs [入力.stq] [中心線ラベル省略可]
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
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { rulesFor, effectiveStructure } from '../../src/structural/structureRules.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/tategu-test3.stq';
const labelArg = process.argv[3] ?? null;

let ngCount = 0;
function ok(cond, label) {
  if (cond) { console.log(`OK: ${label}`); return true; }
  console.log(`NG: ${label}`);
  ngCount++;
  return false;
}

// ---- 本番同型ハーネス（gridDeleteStructuralSyncProbe.mjs / centerDeleteStructuralSyncProbe.mjsと同じ手順）----
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

  const probeSync = createStructuralSync({
    recompute: (p, s) => {
      const ctx = createStructuralResolveContext({ peek: bytePeek, save: storeSave });
      return recomputeForStructuralSync(p, s, ctx).finally(() => ctx.dispose());
    },
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

// B-1と同種: 壁の幾何（wallGeom/wallCount）だけを比較する（既知の不具合の検出専用。NG判定には使わない）。
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

// 移動前に一度収束させておく（冒頭コメント「基準は収束させてから採る」参照）。
async function preConverge(harness) {
  harness.activate();
  harness.probeSync.request(harness.project.activeGraph, harness.project, { scope: 'all' });
  await harness.probeSync.whenIdle();
}

// ---- M0: 基準の冪等性（収束後、probeSync.request('all')を2回回しても全階ダンプ差分ゼロ）----
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

// QA指摘n-3（2026-09-25）: 主構造が中心線の位置に一切構造的に反応しない場合（壁由来梁芯を生成せず
// ＝wallBeamAxes:null、かつ壁交点柱も置かない＝columnPlacement!=='wallIntersections'。例: S造の
// gridIntersections/wallBeamAxes:null）、中心線移動で配線あり／なしの差が原理的に生まれない
// （M3が必ずNGになる）。これは13.stqで実測済みの仕様どおりの結果であり、13.stqを回帰ゲート
// （このprobe自体が壊れていないかの確認）として使えるよう、検出力が無いこと自体をNGにせず
// 「対象外」として exit 0 で終える。
const activeRules = rulesFor(effectiveStructure(hBase.project.activeGraph, hBase.project));
if (activeRules.wallBeamAxes == null && activeRules.columnPlacement !== 'wallIntersections') {
  console.log(`対象外（中心線に反応しない主構造: ${hBase.project.structuralInfo.mainStructure}。` +
    `wallBeamAxes=${activeRules.wallBeamAxes} columnPlacement=${activeRules.columnPlacement}）`);
  process.exit(0);
}

// ---- 候補選定: 「壁の軸CLになっているcenter CL」×「平行な最寄りCLまでの半分(5mm丸め)の移動量が
// 0でない」を軽く絞り込んだ上で、配線あり／なしで結果が変わる最初の1本を選ぶ（M3・検出力）。
function nearestParallelCL(graph, cl) {
  let best = null, bestDist = Infinity;
  for (const other of graph.centerLines) {
    if (other.id === cl.id || other.centerLineType !== cl.centerLineType) continue;
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
let candidates = activeForCandidates.centerLines.filter(cl => centerLineKind(cl) === 'center');
if (labelArg) candidates = candidates.filter(cl => cl.label === labelArg);
candidates = candidates.filter(cl => activeForCandidates.walls.some(w => w.axisCL.id === cl.id));
candidates = candidates
  .map(cl => {
    const target = nearestParallelCL(activeForCandidates, cl);
    if (!target) return null;
    const moveAmount = moveAmountToward(cl, target);
    if (moveAmount === 0) return null;
    return { id: cl.id, type: cl.centerLineType, value: cl.effectiveValue, moveAmount };
  })
  .filter(Boolean);
if (candidates.length === 0) {
  console.log(`NG: 移動候補（壁が乗っており、平行な最寄りCLへの移動量が0でない中心線）が無い（labelArg=${labelArg}）`);
  process.exit(1);
}

function tryMoveOn(harness, clId, moveAmount, wired) {
  if (wired) setCenterLineStructuralListener((g, p, scope) => harness.probeSync.request(g, p, { scope }));
  else setCenterLineStructuralListener(null);
  harness.activate();
  const cl = harness.project.activeGraph.centerLines.find(c => c.id === clId);
  const originalValue = cl.value;
  runInAction(() => { cl.pendingDelta = moveAmount; });
  const { toast } = commitCLMoveOp(harness.project.activeGraph, harness.project, cl, originalValue);
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
  if (toastWired !== null || toastUnwired !== null) continue; // 確定自体が拒否された候補はスキップ
  const dumpWired = await dumpAll(hWired);
  const dumpUnwired = await dumpAll(hUnwired);
  const diffs = diffDumps(dumpWired, dumpUnwired);
  if (diffs.length > 0) {
    chosen = cand;
    console.log(`対象中心線: id=${cand.id.slice(0, 8)} type=${cand.type} value=${Math.round(cand.value)} ` +
      `moveAmount=${cand.moveAmount}mm（配線あり／なしで${diffs.length}平面に差分。検出力あり）`);
    break;
  }
}
ok(chosen != null, 'M3: 検出力（配線あり／なしで結果が変わる候補が少なくとも1本ある）');
if (!chosen) {
  console.log('NG: 検出力なし（どの中心線を移動しても配線あり／なしで結果が変わらない）');
  process.exit(1);
}

// ---- 本編（配線あり）。フレッシュなハーネスで再実行する ----
const h = buildHarness(src);
await preConverge(h);
setCenterLineStructuralListener((g, p, scope) => h.probeSync.request(g, p, { scope }));

const baselineDump = await dumpAll(h);
const clMainBefore = h.project.activeGraph.centerLines.find(c => c.id === chosen.id);
const centerLinesCountBefore = h.project.activeGraph.centerLines.length;
const beforeUndoTop = undoManager.peekUndo();

// M5用: 移動前の「追従 vs 作り直し」比較の基準を採っておく（移動で新たに生じた差分だけを
// あとで一覧するため）。
async function regenerateComparisonFor(graph, clIds) {
  const materialMap = await loadMaterialMap();
  const cloneForRegen = new PlanGraph(graph.plane);
  cloneForRegen._structGraph = graph._structGraph;
  restoreGraph(cloneForRegen, serializeGraph(graph));
  const stairPeek = async (plane) => h.bytePeek(plane, h.project.structGraph);
  const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(cloneForRegen, h.project, stairPeek);
  await regenerateWalls(cloneForRegen, { materialMap, project: h.project, stairUnderEntries, extraStairOpenings });
  const wallDigest = (g, clId) => g.walls.filter(w => w.axisCL.id === clId)
    .map(w => `${Math.round(w.axisValue)}:${Math.round(w.coord1)}..${Math.round(w.coord2)}`).sort();
  const out = {};
  for (const clId of clIds) out[clId] = { regenerated: wallDigest(cloneForRegen, clId) };
  return out;
}
function actualWallDigestFor(graph, clId) {
  return graph.walls.filter(w => w.axisCL.id === clId)
    .map(w => `${Math.round(w.axisValue)}:${Math.round(w.coord1)}..${Math.round(w.coord2)}`).sort();
}
const m5TargetIdsBefore = [chosen.id];
const m5RegenBefore = await regenerateComparisonFor(h.project.activeGraph, m5TargetIdsBefore);
for (const clId of m5TargetIdsBefore) m5RegenBefore[clId].actual = actualWallDigestFor(h.project.activeGraph, clId);

const tMoveStart = performance.now();
const { toast: mainToast, originalValue } = tryMoveOn(h, chosen.id, chosen.moveAmount, true);
const tMoveEnd = performance.now();
await h.probeSync.whenIdle();
const tSyncEnd = performance.now();
ok(mainToast === null, `M1: commitCLMoveOp(中心線移動)はtoast:nullで成功する（実際: ${mainToast}）`);
ok(undoManager.peekUndo() !== beforeUndoTop, 'M1: 確定でundoエントリが1件増える');

const afterMoveDump = await dumpAll(h);

// ---- M2: whenIdle後の再要求で差分ゼロ（冪等）----
h.probeSync.request(h.project.activeGraph, h.project, { scope: 'activeAndAbove' });
await h.probeSync.whenIdle();
const afterSecondRun = await dumpAll(h);
const idempotentDiffs = diffDumps(afterMoveDump, afterSecondRun);
ok(idempotentDiffs.length === 0, 'M2: 移動後もう1回同期しても全階ダンプ差分ゼロ（冪等）');
if (idempotentDiffs.length > 0) printDiffs(idempotentDiffs);

// ---- M5: 裁定10の例外判定（情報・NGにしない）----
// 移動CL・結合で残ったCL・extentRefで移動CLを参照するCLを軸に持つ壁について、followWallBeamAxes
// （実際に追従した壁）とregenerateWalls（materialMap等をフルに使って作り直した壁。wallRefreshProbe.mjs
// L67・L81と同じ手順）の範囲・本数を比較する。移動前にも同じ比較を採り、移動で新たに生じた差分だけを
// 一覧する（実データの既存の不一致——本タスクと無関係な性質——を誤検出しないため）。
const survivorId = h.project.activeGraph.centerLines.length < centerLinesCountBefore
  ? chosen.id // 結合が起きた場合、survivorはchosen.id自身（commitCLMoveOpはsubjectをsurvivorにする）
  : null;
const m5TargetIdsAfter = new Set([chosen.id]);
if (survivorId) m5TargetIdsAfter.add(survivorId);
for (const other of h.project.activeGraph.centerLines) {
  if (other.extentLoRef?.clId === chosen.id || other.extentHiRef?.clId === chosen.id) m5TargetIdsAfter.add(other.id);
}
const m5RegenAfter = await regenerateComparisonFor(h.project.activeGraph, [...m5TargetIdsAfter]);
const m5NewDiffs = [];
for (const clId of m5TargetIdsAfter) {
  const actual = actualWallDigestFor(h.project.activeGraph, clId);
  const regenerated = m5RegenAfter[clId].regenerated;
  const diffNow = JSON.stringify(actual) !== JSON.stringify(regenerated);
  const before = m5RegenBefore[clId];
  const diffBefore = before ? JSON.stringify(before.actual) !== JSON.stringify(before.regenerated) : false;
  if (diffNow && !diffBefore) {
    m5NewDiffs.push({ clId, axisValue: Math.round(h.project.activeGraph.shapeMap.get(clId)?.effectiveValue ?? NaN), actual, regenerated });
  }
}
console.log(`M5(情報・NGにしない): 追従で壊れる壁の有無 — 移動で新たに生じた差分 ${m5NewDiffs.length}件`);
for (const d of m5NewDiffs) {
  console.log(`  CL=${d.clId.slice(0, 8)} axisValue=${d.axisValue} 追従後=${JSON.stringify(d.actual)} 作り直し=${JSON.stringify(d.regenerated)}`);
}

// ---- M6: 移動後に旧座標の孤児梁芯が0本（NG判定）。上階の孤児本数は情報 ----
// 「孤児」＝旧座標に梁芯CLが残っており、かつ自階・下階（selfAndBelow構成のときだけ）のどちらの壁も
// もう根拠にしていないもの。在来木造は自階＋1つ下の実体階の壁を根拠にするため（wallBeamAxes:
// 'selfAndBelow'）、移動元CLに壁が無くなっても直下階の同座標に壁が残っていれば梁芯は正しく残る
// ——それを孤児と誤検出しないよう wallBeamSourcesFor（自階＋下階の壁ソース）で裏取りする。
const oldIsVertical = clMainBefore.centerLineType === CenterLineType.VERTICAL;
const orphanAtOld = findWallBeamAxisCL(h.project.activeGraph, oldIsVertical, originalValue);
const belowGraphForM6 = await peekBelowGraph(h.project.activeGraph, h.project);
const sourcesForM6 = wallBeamSourcesFor(h.project.activeGraph, h.project, belowGraphForM6);
const oldStillHasSource = sourcesForM6.some(s => s.isVertical === oldIsVertical && Math.abs(s.coord - originalValue) < 0.5);
const genuineOrphan = orphanAtOld != null && !oldStillHasSource;
ok(!genuineOrphan, `M6: 移動後、旧座標(${Math.round(originalValue)})に孤児の壁由来梁芯が残っていない`);
if (genuineOrphan) console.log('  NG詳細: 旧座標に残っている梁芯id=', orphanAtOld.id.slice(0, 8));
if (orphanAtOld && oldStillHasSource) {
  console.log(`  情報: 旧座標(${Math.round(originalValue)})の梁芯は自階または下階の壁がまだ根拠のため正しく残っている（孤児ではない）`);
}

if (isTraditionalWoodStructure(h.project.structuralInfo.mainStructure)) {
  const aboveGraph = await peekAboveGraph(h.project.activeGraph, h.project);
  const orphanAbove = aboveGraph ? findWallBeamAxisCL(aboveGraph, oldIsVertical, originalValue) : null;
  console.log(`M6(情報): 上階の旧座標(${Math.round(originalValue)})孤児梁芯 = ${orphanAbove ? 1 : 0}本` +
    (aboveGraph ? '' : '（上階なし）'));
} else {
  console.log('M6(情報): 非在来のため上階孤児の対象外');
}

setCenterLineStructuralListener(null);

// ---- M7: undoでCL値が戻り、redo後のダンプが移動直後と一致（厳密）。undo後の基準一致は
// 自階（アクティブ平面）だけ厳密判定し、他平面（屋根含む）は情報表示に留める（NGにしない）——
// リード裁定（2026-09-25）: 移動中に他平面（屋根等）へ生成された壁由来梁芯は、undo時に自階の
// 追従（followWallBeamAxes）が戻すのは自階の梁芯だけで、他平面に生成された分は「孤児」として
// 残りうる。既存裁定「CL操作の後始末は当該階のみ・他階の孤児梁芯は許容（段階(g)の他階undo化で
// 戻る）」の範囲内であり、centerMoveStructuralSyncProbe.mjs固有の欠陥ではない——他階の構造まで
// undo対象にする段階(g)が実装されるまでは、他平面の差分をNG判定の対象から外す。redo後の一致は
// 従来どおり全平面厳密（移動直後の状態への到達を確認するだけなので、他階の孤児混入は影響しない）。
setCenterLineStructuralListener((g, p, scope) => h.probeSync.request(g, p, { scope }));

undoManager.undo();
await h.probeSync.whenIdle();
const clAfterUndo = h.project.activeGraph.centerLines.find(c => c.id === chosen.id);
ok(clAfterUndo?.value === originalValue, `M7: undoでCL値が移動前(${Math.round(originalValue)})に戻る（実際: ${clAfterUndo?.value}）`);
const afterUndoDump = await dumpAll(h);
const undoDiffs = diffStructOnly(baselineDump, afterUndoDump);
const activePlaneKey = h.project.activeGraph.plane.name; // アクティブ平面は候補選定の起点のため常に実体階（屋根ではない）
const undoDiffsActive = undoDiffs.filter(d => d.floor === activePlaneKey);
const undoDiffsOther = undoDiffs.filter(d => d.floor !== activePlaneKey);
ok(undoDiffsActive.length === 0, 'M7: undo後のダンプ（構造フィールド）が基準と一致する（自階＝アクティブ平面のみ厳密判定）');
if (undoDiffsActive.length > 0) printDiffs(undoDiffsActive);
if (undoDiffsOther.length > 0) {
  console.log(`M7(情報・他平面は非NG): 他平面（屋根含む）のundo後ダンプ（構造フィールド）と基準の差分 ${undoDiffsOther.length}件` +
    '（他階・屋根の孤児梁芯は段階(g)の他階undo化まで許容——既存裁定「CL操作の後始末は当該階のみ・他階の孤児梁芯は許容」の範囲。NGにしない）');
  printDiffs(undoDiffsOther);
} else {
  console.log('M7(情報): 他平面（屋根含む）のundo後ダンプ（構造フィールド）は基準と差分0件');
}
const undoWallDiffs = diffWallFieldsOnly(baselineDump, afterUndoDump);
if (undoWallDiffs.length > 0) {
  console.log(`注意: undo後の壁幾何(wallGeom/wallCount)に${undoWallDiffs.length}階分差分あり（${undoWallDiffs.join(', ')}）——` +
    'B-1と同種の既知の性質の可能性（NGにしない）');
}

// ---- M8（Q1裁定・dedupeColumnsByAxis対応・2026-09-25）: 移動→undo→同期後、全階で同じAXIS座標
// （CL_OVERLAP_TOL_MM）に柱が2本以上ある箇所が0本（NG判定）。既存ソルバーが「同座標だがアンカーCLが
// 違う」auto柱を重複排除しない撤去段の穴（M7の発見2。qa-reviewer 2026-09-25特定）の直接的な検出。
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
ok(redoDiffs.length === 0, 'M7: redo後のダンプ（構造フィールド）が移動直後と一致する（厳密）');
if (redoDiffs.length > 0) printDiffs(redoDiffs);
const redoWallDiffs = diffWallFieldsOnly(afterMoveDump, afterRedoDump);
if (redoWallDiffs.length > 0) {
  console.log(`注意: redo後の壁幾何(wallGeom/wallCount)に${redoWallDiffs.length}階分差分あり（${redoWallDiffs.join(', ')}）——` +
    'B-1と同種の既知の性質の可能性（NGにしない）');
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
  setCenterLineStructuralListener((g, p, s) => hp.probeSync.request(g, p, { scope: s }));
  const t0 = performance.now();
  commitCLMoveOp(hp.project.activeGraph, hp.project, clP, origP);
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
  console.log(`OK: centerMoveStructuralSyncProbe 全項目パス（${src}）`);
} else {
  console.log(`NG: ${ngCount}件の不一致（${src}）`);
  process.exitCode = 1;
}
