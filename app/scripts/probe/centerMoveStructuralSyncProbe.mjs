// 中心線の移動→構造同期＋壁由来梁芯の追従（段階(b)。core/centerLineKindPolicy.js
// structuralSyncScopeOfKind・transform/centerLineOps.js commitCLMoveOp・
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
import { floorBytesEqual } from '../../src/floorOps.js';

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

  // 段階(g)・2026-09-26: recの有無でsaveを差し替える（design-g.md「ハーネス」の型どおり。
  // ctxArgを明示している（=owned生成ではない）ため、recomputeForStructuralSync自体の{save}オプション
  // ではなく、ここで組むctx自身のsaveへwrapSaveを仕込む）。
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
// ステップ6（開口由来梁芯）追加: このガードは「壁交点柱・壁由来梁芯」経路の検出力の話であり、
// 開口由来梁芯（openingBeamAxes:'slabOpenings'）は独立した反応経路のため、メイン中心線シナリオを
// skipしても下部の「シナリオ追加」ブロックは常に実行する（exit(0)にはしない）。
const noCenterLineReaction = activeRules.wallBeamAxes == null && activeRules.columnPlacement !== 'wallIntersections';
if (noCenterLineReaction) {
  console.log(`対象外（メイン中心線シナリオ・中心線に反応しない主構造: ${hBase.project.structuralInfo.mainStructure}。` +
    `wallBeamAxes=${activeRules.wallBeamAxes} columnPlacement=${activeRules.columnPlacement}。` +
    '開口由来梁芯シナリオ（下記）は別途実行する）');
} else {

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

// saveFloorFn（段階(g)）: 省略すると既定のsaveFloor（実IDB）が使われ、undo/redoで実データを書き換える
// 偽NGを起こす（design-g.md item6の警告）——undo/redoを伴う呼び出しは必ずharness.storeSaveを渡すこと。
// captureBox（段階(g)）: コミット時のnotifyだけに渡る第4引数(undoRecords＝箱)を呼び出し元へ渡すための
// テスト用フック（省略可。候補選定フェーズでは使わない）。
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
setCenterLineStructuralListener((g, p, scope, undoRecords) => h.probeSync.request(g, p, { scope, undoRecords }));

const baselineDump = await dumpAll(h);
// 段階(g)・G1用: 「実際に変化した他平面」はstore（IDBバイト）の前後比較で判定する——dumpAllの
// decoded比較は使わない（gridMoveStructuralSyncProbe.mjsと同じ理由。通り芯・中心線はproject.
// structGraph共有インスタンスの値のため、対象CLを移動すると自階floor-bytes自体は変わっていない
// 他平面のdumpまで見かけ上動く。13.stqの屋根で実測済み）。
const storeBeforeBytes = new Map(h.store);
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

let boxAfterMove = null;
const tMoveStart = performance.now();
const { toast: mainToast, originalValue } = tryMoveOn(h, chosen.id, chosen.moveAmount, true, {
  saveFloorFn: h.storeSave,
  captureBox: (rec) => { boxAfterMove = rec; },
});
const tMoveEnd = performance.now();
await h.probeSync.whenIdle();
const tSyncEnd = performance.now();
ok(mainToast === null, `M1: commitCLMoveOp(中心線移動)はtoast:nullで成功する（実際: ${mainToast}）`);
ok(undoManager.peekUndo() !== beforeUndoTop, 'M1: 確定でundoエントリが1件増える');

const afterMoveDump = await dumpAll(h);

// ---- G1/G2（段階(g)）: 箱(floorRecords)は実際にsaveFloorされた他平面だけを指し、afterは
// storeの現在値と一致する ----
const changedOtherPlaneIds = new Set(
  [...h.project.planeMap.values()]
    .filter(p => p.id !== h.project.activePlaneId)
    .map(p => p.id)
    .filter(id => !floorBytesEqual(storeBeforeBytes.get(id), h.store.get(id))),
);
const boxPlaneIds = new Set((boxAfterMove ?? []).map(r => r.planeId));
ok(Array.isArray(boxAfterMove), 'G1: コミット時notifyの第4引数(箱)は配列のはず');
ok([...boxPlaneIds].every(id => changedOtherPlaneIds.has(id)), 'G1: 箱に含まれるplaneIdはすべて実際にIDBへ保存された他平面のはず（変化していない階を誤って含まない）');
ok([...changedOtherPlaneIds].every(id => boxPlaneIds.has(id)), 'G1: 実際にIDBへ保存された他平面はすべて箱に含まれる（取りこぼしが無い）');
// G2: 同じplaneIdが複数回出うる（発見④と同じ規約）ため、各planeIdの最後のレコードのafterだけが
// storeの現在値と一致するはず（gridDeleteStructuralSyncProbe.mjsと同じ理由）。
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

// ---- M7: undoでCL値が戻り、redo後のダンプが移動直後と一致（厳密）。段階(g)で他平面（屋根含む）も
// 厳密判定へ昇格した——undo時にcommitCLMoveOpの箱(floorRecords)がapplyFloorUndoRecordsで他平面の
// IDBバイトを移動前へ戻すため、以前は「孤児として残りうる」としていた他平面の差分も基準と一致する
// はずになった（リード裁定2026-09-25の「段階(g)まで許容」はここで解消。旧・情報表示扱いは廃止）。
setCenterLineStructuralListener((g, p, scope, undoRecords) => h.probeSync.request(g, p, { scope, undoRecords }));

undoManager.undo();
await h.probeSync.whenIdle();
const clAfterUndo = h.project.activeGraph.centerLines.find(c => c.id === chosen.id);
ok(clAfterUndo?.value === originalValue, `M7: undoでCL値が移動前(${Math.round(originalValue)})に戻る（実際: ${clAfterUndo?.value}）`);
const afterUndoDump = await dumpAll(h);
const undoDiffs = diffDumps(baselineDump, afterUndoDump);
ok(undoDiffs.length === 0, 'M7(G3・厳密): undo後のダンプ（dumpの全フィールド。壁幾何を含む）が基準と一致する（自階・他平面とも厳密判定。段階(g)）');
if (undoDiffs.length > 0) printDiffs(undoDiffs);

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
const redoDiffs = diffDumps(afterMoveDump, afterRedoDump);
ok(redoDiffs.length === 0, 'M7/G4: redo後のダンプ（dumpの全フィールド。壁幾何を含む）が移動直後と一致する（全平面厳密）');
if (redoDiffs.length > 0) printDiffs(redoDiffs);

setCenterLineStructuralListener(null);

// ---- G5（段階(g)）: 検出力の対照。undoRecordsを一切forwardしない（＝箱への記録を無効にした）
// フレッシュなハーネスで同じ操作→undoを行うと、他平面に差分が残ることを確認する——この文書・この
// 操作で「箱方式が実際に何かを直している」ことの実証（0件なら検出力なしと明記してNGにしない）。
const hNoBox = buildHarness(src);
await preConverge(hNoBox);
setCenterLineStructuralListener((g, p, scope) => hNoBox.probeSync.request(g, p, { scope })); // undoRecordsを渡さない＝記録無効
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
  const g5Diffs = diffDumps(baselineDumpNoBox, afterUndoDumpNoBox);
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

} // end: if (!noCenterLineReaction)

// ---- シナリオ追加（ステップ6・開口由来梁芯の追従・回収）: アクティブ階のVOID開口の辺が乗る
// 中心線を移動すると、開口由来の梁芯（beamAxisOrigin===OPENING）が同idで追従し、undoで戻り、
// redoで再び追従することを確認する。13.stq/14.stq（2階のVOID [-3000,0]×[-2000,0]。辺y=-2000）を
// 主対象に想定しているが、座標をハードコードせず汎用的に選ぶ——他データで該当が無ければ対象外として
// スキップする（NGにしない）。
{
  const { RoomFeature, CenterLineType: CLType } = await import('../../src/core.js');
  const { openingBeamSourcesFor } = await import('../../src/structural/openingBeamAxes.js');
  const { BeamAxisOrigin } = await import('../../src/core/centerLine.js');

  function findVoidPlaneIdMove(harness) {
    return [...harness.project.graphMap.entries()]
      .find(([, g]) => g.rooms.some(r => r.feature === RoomFeature.VOID))?.[0] ?? null;
  }

  const hOMProbe = buildHarness(src);
  const voidPlaneIdMove = findVoidPlaneIdMove(hOMProbe);
  if (voidPlaneIdMove) hOMProbe.project.activePlaneId = voidPlaneIdMove;
  await preConverge(hOMProbe);
  const openingAxesProbe = hOMProbe.project.activeGraph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING);
  const sourcesOM = voidPlaneIdMove ? openingBeamSourcesFor(hOMProbe.project.activeGraph, hOMProbe.project) : [];
  // 候補: 由来openingの梁芯が現に存在する座標に一致する開口ソースのaxisCLId（辺が乗る中心線）。
  // 移動量は「辺自身の座標と直交しない側で0でない値」——ここでは単純に+50mm固定（辺の中心線を
  // わずかに動かすだけで十分。結合・吸収の分岐まで踏み込む検証はwallBeamAxisFollow.test.js /
  // centerLineOps.test.jsの単体テストが担う——本probeは実データでの追従自体の検出が目的）。
  const openingMoveCandidates = sourcesOM
    .filter(s => openingAxesProbe.some(ax =>
      ax.centerLineType === (s.isVertical ? CLType.VERTICAL : CLType.HORIZONTAL) && Math.abs(ax.effectiveValue - s.coord) < 5))
    .map(s => ({ source: s, cl: hOMProbe.project.activeGraph.centerLines.find(cl => cl.id === s.axisCLId) }))
    .filter(({ cl }) => cl && centerLineKind(cl) === 'center');

  if (!voidPlaneIdMove || openingMoveCandidates.length === 0) {
    console.log(`対象外（ステップ6シナリオ）: VOID開口の辺が乗る中心線が見つからない（${src}）`);
  } else {
    const { source: targetSourceMove, cl: targetClCandidate } = openingMoveCandidates[0];
    const MOVE_AMOUNT = 50;

    const hOM = buildHarness(src);
    hOM.project.activePlaneId = voidPlaneIdMove;
    await preConverge(hOM);
    const gOM = hOM.project.activeGraph;
    const targetCLMove = gOM.centerLines.find(cl => cl.id === targetClCandidate.id);
    const openingAxisBeforeMove = gOM.centerLines.find(cl =>
      cl.beamAxisOrigin === BeamAxisOrigin.OPENING
      && cl.centerLineType === (targetSourceMove.isVertical ? CLType.VERTICAL : CLType.HORIZONTAL)
      && Math.abs(cl.effectiveValue - targetSourceMove.coord) < 5);
    const openingAxisIdBeforeMove = openingAxisBeforeMove.id;
    const openingAxisValueBeforeMove = openingAxisBeforeMove.effectiveValue;
    console.log(`対象中心線(ステップ6・移動): id=${targetCLMove.id.slice(0, 8)} type=${targetCLMove.centerLineType} ` +
      `value=${Math.round(targetCLMove.effectiveValue)} / 開口由来梁芯: id=${openingAxisIdBeforeMove.slice(0, 8)} value=${Math.round(openingAxisValueBeforeMove)}`);

    const originalValueMove = targetCLMove.value;
    setCenterLineStructuralListener((g, p, scope, undoRecords) => hOM.probeSync.request(g, p, { scope, undoRecords }));
    runInAction(() => { targetCLMove.pendingDelta = MOVE_AMOUNT; });
    const { toast: moveToast } = commitCLMoveOp(gOM, hOM.project, targetCLMove, originalValueMove, { saveFloorFn: hOM.storeSave });
    await hOM.probeSync.whenIdle();
    ok(moveToast === null, `(8) ステップ6: 開口の辺の中心線移動はtoast:nullで成功する（実際: ${moveToast}）`);

    const axisAfterMove = gOM.shapeMap.get(openingAxisIdBeforeMove);
    ok(!!axisAfterMove, '(8a) ステップ6: 開口由来梁芯は同idのまま残る（撤去・作り直しではなく追従）');
    ok(axisAfterMove && axisAfterMove.value !== openingAxisValueBeforeMove,
      `(8b) ステップ6: 開口由来梁芯が辺の移動分だけ追従する（前=${Math.round(openingAxisValueBeforeMove)} 後=${axisAfterMove ? Math.round(axisAfterMove.value) : 'なし'}）`);

    undoManager.undo();
    await hOM.probeSync.whenIdle();
    const axisAfterUndoMove = gOM.shapeMap.get(openingAxisIdBeforeMove);
    ok(!!axisAfterUndoMove && Math.abs(axisAfterUndoMove.value - openingAxisValueBeforeMove) < 1,
      `(8c) ステップ6: undoで開口由来梁芯が同idのまま元の座標へ戻る（実際: ${axisAfterUndoMove?.value}）`);
    ok(targetCLMove.value === originalValueMove, '(8c) ステップ6: undoで中心線自体の座標も戻る');

    undoManager.redo();
    await hOM.probeSync.whenIdle();
    const axisAfterRedoMove = gOM.shapeMap.get(openingAxisIdBeforeMove);
    ok(!!axisAfterRedoMove && axisAfterRedoMove.value !== openingAxisValueBeforeMove,
      '(8d) ステップ6: redoで開口由来梁芯が再び追従する（同id）');

    setCenterLineStructuralListener(null);
  }
}

if (ngCount === 0) {
  console.log(`OK: centerMoveStructuralSyncProbe 全項目パス（${src}）`);
} else {
  console.log(`NG: ${ngCount}件の不一致（${src}）`);
  process.exitCode = 1;
}
