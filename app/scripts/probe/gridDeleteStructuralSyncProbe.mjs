// 通り芯削除→構造同期（段階(a)・案P。structural/structuralSync.js・transform/centerLineOps.js
// deleteCenterLineWithUndo・transform/centerLineFloorSync.js propagateGridCenterLineDeletion）の
// 実データ確認用probe。起動口は本番と同じ deleteCenterLineWithUndo だけ（基準の冪等性確認だけ
// probeSync.request を直接呼ぶ。openingJambInsertProbe.mjsと同じ「本番配線だけを起動口にする」規律）。
//
// 本番同型peek: floorSwapManager.peek をバイト復元（withProductionPeek。centerLineOps.test.js と同じ
// 手順）に差し替える——生きた project.graphMap をそのまま返すと、通り芯を structGraph から外した後の
// resolveCL欠落（graphSnapshot.js resolveCL が黙って壁参照を捨てる）を再現できない。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/gridDeleteStructuralSyncProbe.mjs [入力.stq] [通り芯ラベル省略可]
//
// B-1（リード裁定・QA差し戻し・2026-09-25）: I4（undo/redo一致）は柱・梁・基礎（構造フィールド。
// columns/beams/footings）だけで合否を決める。壁の幾何（wallGeom/wallCount。アーキ壁）は対象外——
// 13.stqでredo後にwallGeomだけがドリフトする既知の不具合が**HEAD（3055191。案P・本タスクの変更前）
// でも再現する**ことをgit stashで実証済み。原因はcenterLineOps.jsの通り芯削除が使う
// serializeGraph→restoreGraphの往復（beforeArch/afterArchスナップショット方式）とPlanGraphの
// chamferWalls reaction（core/planGraph.js）の組合せが完全な冪等性を持たないという、本タスク
// （構造同期・案P）とは無関係な既存の性質——修正は別タスクとしてリードがユーザーへ報告する
// （このprobeでは検出だけ行い、「注意」として表示するに留める。NGにはしない）。
import { performance } from 'node:perf_hooks';
import { loadDocument } from './loadDoc.mjs';
import { PlanGraph } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { undoManager } from '../../src/undoManager.js';
import { deleteCenterLineWithUndo, setCenterLineStructuralListener } from '../../src/transform/centerLineOps.js';
import { isLastGridOnAxis } from '../../src/transform/centerLineConvert.js';
import { createStructuralSync } from '../../src/structural/structuralSync.js';
import { recomputeForStructuralSync } from '../../src/structural/structuralOrchestration.js';
import { createStructuralResolveContext } from '../../src/structural/structuralResolveContext.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const labelArg = process.argv[3] ?? null;

let ngCount = 0;
function ok(cond, label) {
  if (cond) { console.log(`OK: ${label}`); return true; }
  console.log(`NG: ${label}`);
  ngCount++;
  return false;
}

// ---- 本番同型ハーネス（本番と同じ関数列を通す。生きたgraphMapは返さない）----
function buildHarness(docSrc) {
  const { project } = loadDocument(docSrc);
  const store = new Map();
  for (const [planeId, g] of project.graphMap) store.set(planeId, serializeGraph(g));

  // 本番同型のバイト復元peek（centerLineOps.test.js withProductionPeekと同じ手順）。
  const bytePeek = async (plane, structGraph) => {
    const g = new PlanGraph(plane);
    g._structGraph = structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
  const storeSave = async (planeId, bytes) => { store.set(planeId, bytes); };

  // floorSwapManager.peek はプロセス全体で共有のシングルトンのため、ハーネスを使う直前に必ず
  // 差し替える（下記の各フェーズで都度 harness.activate() を呼ぶ）。
  const activate = () => { floorSwapManager.peek = bytePeek; };

  const probeSync = createStructuralSync({
    recompute: (p, s) => {
      const ctx = createStructuralResolveContext({ peek: bytePeek, save: storeSave });
      return recomputeForStructuralSync(p, s, ctx).finally(() => ctx.dispose());
    },
  });

  return { project, store, bytePeek, storeSave, probeSync, activate };
}

// ---- ダンプ（柱のAXIS・role・woodJambRef、梁の軸・範囲・role、壁の本数・幾何・CL参照id）----
async function dumpAll(h) {
  h.activate();
  const out = {};
  for (const plane of h.project.planeMap.values()) {
    const g = plane.id === h.project.activePlaneId ? h.project.activeGraph : await h.bytePeek(plane, h.project.structGraph);
    const openingIds = new Set(g.openings.map(o => o.id));
    out[plane.name + (plane.isRoofPlane ? '(屋根)' : '')] = {
      columns: g.columns.map(c => {
        const jamb = c.woodJambRef ? `jamb:${openingIds.has(c.woodJambRef.openingId) ? 'ok' : 'ORPHAN'}:${c.woodJambRef.side}` : '';
        return `${c.role ?? ''}:${Math.round(c.axisX)},${Math.round(c.axisY)}:${jamb}`;
      }).sort(),
      beams: g.beams.map(b => `${b.role ?? ''}:${b.isVertical}:${Math.round(b.axisValue)}:` +
        `${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}`).sort(),
      footings: g.footings.map(f => `${f.constructor.name}:${Math.round(f.verticalCL.effectiveValue)},${Math.round(f.horizontalCL.effectiveValue)}`).sort(),
      wallCount: g.walls.length,
      wallGeom: g.walls.map(w => `${w.isVertical}:${Math.round(w.axisValue)}:${Math.round(w.coord1)}..${Math.round(w.coord2)}`).sort(),
      // I2用: 柱・梁・基礎が参照するCL id一式（削除id参照ゼロの確認に使う）。sortする——
      // 生成順（Map挿入順）は再計算の内部経路（同じ結果集合でも辿る順序）で入れ替わりうるため、
      // 未sortだと「同じ多重集合なのに順序違いで差分扱いになる」誤検出になる（I4bデバッグで実測）。
      clRefs: [
        ...g.columns.flatMap(c => [c.verticalCL.id, c.horizontalCL.id]),
        ...g.beams.flatMap(b => [b.axisCL.id, b.clStart.id, b.clEnd.id]),
        ...g.footings.flatMap(f => [f.verticalCL.id, f.horizontalCL.id]),
      ].sort(),
    };
  }
  return out;
}

// ignoreFields: 比較から除く1階分オブジェクトのキー名（既定でclRefsを除く——壁由来梁芯(discipline:FUSE)は
// 独立した再計算パス（peek→recompute→save）のたびにwallBeamAxes.jsが新しいid（crypto.randomUUID()）で
// 作り直すことがあり、柱・梁・基礎の位置・役割・本数（columns/beams/footings/wallGeom）が完全一致でも
// 参照先CLのid自体は変わりうる——これは本経路（案P）と無関係な既存の性質（実測: moku4.stq 3階で
// 削除直後→undo→redoの2回目のall再計算後にclRefsのid 4件が別idへ入れ替わったが、columns/beams/
// footings/wallGeomは1文字も変わらなかった）。I2（削除id参照ゼロの確認）だけは
// afterDeleteDump[floor].clRefsを直接読み、cross-run比較（I3/I4）には含めない。
function diffDumps(a, b, { ignoreFields = ['clRefs'] } = {}) {
  const diffs = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const strip = (obj) => {
    if (!obj) return obj;
    const copy = { ...obj };
    for (const f of ignoreFields) delete copy[f];
    return copy;
  };
  for (const k of keys) {
    const av = JSON.stringify(strip(a[k]) ?? null), bv = JSON.stringify(strip(b[k]) ?? null);
    if (av !== bv) diffs.push({ floor: k, before: a[k] ?? null, after: b[k] ?? null });
  }
  return diffs;
}

// B-1用: 壁の幾何（wallGeom/wallCount）だけを比較する（既知の不具合の検出専用。NG判定には使わない）。
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

function printDiffs(diffs, limit = 5) {
  for (const d of diffs.slice(0, limit)) {
    console.log(`  差分[${d.floor}]:`);
    console.log(`    before: ${JSON.stringify(d.before)}`.slice(0, 400));
    console.log(`    after : ${JSON.stringify(d.after)}`.slice(0, 400));
  }
  if (diffs.length > limit) console.log(`  ...他${diffs.length - limit}件`);
}

console.log(`=== ${src} ===`);

// ---- (1) 基準の冪等性: probeSync.request('all')直呼びで2回回しても全階ダンプ差分ゼロ ----
// （起動口はdeleteCenterLineWithUndoだけに絞る規律の唯一の例外——基準そのものの収束確認のため）。
const hBase = buildHarness(src);
hBase.activate();
console.log(`主構造: ${hBase.project.structuralInfo.mainStructure} plane: ${hBase.project.activeGraph.plane.name}`);
hBase.probeSync.request(hBase.project.activeGraph, hBase.project, { scope: 'all' });
await hBase.probeSync.whenIdle();
const baseDump1 = await dumpAll(hBase);
hBase.probeSync.request(hBase.project.activeGraph, hBase.project, { scope: 'all' });
await hBase.probeSync.whenIdle();
const baseDump2 = await dumpAll(hBase);
const baseDiffs = diffDumps(baseDump1, baseDump2);
ok(baseDiffs.length === 0, '基準の冪等性: probeSync.request("all")を2回回しても全階ダンプ差分ゼロ');
if (baseDiffs.length > 0) printDiffs(baseDiffs);

// ---- (2) 対象通り芯の選定: 「配線あり」と「配線なし」で結果が変わる最初の1本 ----
const activeGraphForCandidates = hBase.project.activeGraph;
let candidates = [...activeGraphForCandidates.gridXs, ...activeGraphForCandidates.gridYs]
  .filter(cl => !isLastGridOnAxis(activeGraphForCandidates, cl));
if (labelArg) candidates = candidates.filter(cl => cl.label === labelArg);
if (candidates.length === 0) {
  console.log(`NG: 削除候補の通り芯が無い（labelArg=${labelArg}）`);
  process.exit(1);
}

// 削除前に一度収束させておく（.stqの生データは構造未同期＝屋根の梁等が未計算のことがあるため、
// 「削除前の基準」を素の読込み直後ではなく「収束済みの状態」にする——I4のundo比較対象を
// 意味のある基準にする）。
async function preConverge(harness) {
  harness.activate();
  harness.probeSync.request(harness.project.activeGraph, harness.project, { scope: 'all' });
  await harness.probeSync.whenIdle();
}

async function tryDeleteOn(harness, clId, wired) {
  if (wired) setCenterLineStructuralListener((g, p, s) => harness.probeSync.request(g, p, { scope: s }));
  else setCenterLineStructuralListener(null);
  harness.activate();
  const cl = harness.project.structGraph.shapeMap.get(clId);
  const { toast } = await deleteCenterLineWithUndo(harness.project.activeGraph, harness.project, cl, { saveFloorFn: harness.storeSave });
  await harness.probeSync.whenIdle();
  setCenterLineStructuralListener(null);
  return toast;
}

let chosenId = null, chosenLabel = null;
for (const cand of candidates) {
  const hWired = buildHarness(src);
  const hUnwired = buildHarness(src);
  await preConverge(hWired);
  await preConverge(hUnwired);
  const toastWired = await tryDeleteOn(hWired, cand.id, true);
  const toastUnwired = await tryDeleteOn(hUnwired, cand.id, false);
  if (toastWired !== null || toastUnwired !== null) continue; // 削除自体が拒否された候補はスキップ
  const dumpWired = await dumpAll(hWired);
  const dumpUnwired = await dumpAll(hUnwired);
  const diffs = diffDumps(dumpWired, dumpUnwired);
  if (diffs.length > 0) {
    chosenId = cand.id;
    chosenLabel = cand.label;
    console.log(`対象通り芯: ${chosenLabel}（配線あり／なしで${diffs.length}平面に差分。検出力あり）`);
    break;
  }
}
if (!chosenId) {
  console.log('NG: 検出力なし（どの通り芯を削除しても配線あり／なしで結果が変わらない）');
  process.exit(1);
}

// ---- (3) 検証（配線あり）本編。フレッシュなハーネスで再実行する ----
const h = buildHarness(src);
await preConverge(h);
setCenterLineStructuralListener((g, p, s) => h.probeSync.request(g, p, { scope: s }));

const baselineDump = await dumpAll(h);
// I5用: 削除前に他階（非アクティブ）で対象CLを片端(clStart/clEndのどちらか一方)だけ参照する壁を探す
// （軸参照(axisCL===id)は削除対象、両端参照は完全削除——端点ルールの対象は「片端だけ」の壁）。
async function findSingleEndWalls(harness, clId) {
  harness.activate();
  const hits = [];
  for (const plane of harness.project.planeMap.values()) {
    if (plane.id === harness.project.activePlaneId) continue;
    const g = await harness.bytePeek(plane, harness.project.structGraph);
    for (const w of g.walls) {
      const sMatch = w.clStart.id === clId, eMatch = w.clEnd.id === clId, axisMatch = w.axisCL.id === clId;
      if (!axisMatch && (sMatch !== eMatch)) hits.push({ planeId: plane.id, wallId: w.id });
    }
  }
  return hits;
}
const singleEndWallsBefore = await findSingleEndWalls(h, chosenId);

const clMain = h.project.structGraph.shapeMap.get(chosenId);
const tDeleteStart = performance.now();
const { toast: mainToast } = await deleteCenterLineWithUndo(h.project.activeGraph, h.project, clMain, { saveFloorFn: h.storeSave });
const tDeleteEnd = performance.now();
await h.probeSync.whenIdle();
const tSyncEnd = performance.now();
ok(mainToast === null, `deleteCenterLineWithUndo(${chosenLabel})はtoast:nullで成功する（実際: ${mainToast}）`);

const afterDeleteDump = await dumpAll(h);

// I1: 全階でwoodJambRef.openingIdが存在しない袖柱（ORPHAN）が0本。
const orphanFloors = Object.entries(afterDeleteDump).filter(([, d]) => d.columns.some(c => c.includes(':jamb:ORPHAN:')));
ok(orphanFloors.length === 0, 'I1: 全階でopeningが存在しない袖柱(ORPHAN)が0本');
if (orphanFloors.length > 0) console.log('  ORPHAN検出階:', orphanFloors.map(([name]) => name));

// I2: 全階（ストアから復号／アクティブは生きたgraph）で削除idを参照する柱・梁・基礎が0本。
const stillReferencing = Object.entries(afterDeleteDump).filter(([, d]) => d.clRefs.includes(chosenId));
ok(stillReferencing.length === 0, 'I2: 全階で削除id参照の柱・梁・基礎が0本（removeDependentsOfCenterLineの効果）');
if (stillReferencing.length > 0) console.log('  参照が残る階:', stillReferencing.map(([name]) => name));

// I3: もう1回request('all')しても全階ダンプ差分ゼロ（冪等）。
h.probeSync.request(h.project.activeGraph, h.project, { scope: 'all' });
await h.probeSync.whenIdle();
const afterSecondRun = await dumpAll(h);
const idempotentDiffs = diffDumps(afterDeleteDump, afterSecondRun);
ok(idempotentDiffs.length === 0, 'I3: 削除後もう1回request("all")しても全階ダンプ差分ゼロ（冪等）');
if (idempotentDiffs.length > 0) printDiffs(idempotentDiffs);

// I4: undo→whenIdle後のダンプが基準と一致、redo→whenIdle後が削除直後と一致。
// B-1: 合否は構造フィールド（columns/beams/footings。clRefsは前述のとおり除外）だけで決める——
// wallGeom/wallCountは既知の不具合（上記コメント参照）の検出専用に別途調べ、「注意」表示に留める。
const STRUCT_ONLY_IGNORE = ['clRefs', 'wallGeom', 'wallCount'];

undoManager.undo();
await h.probeSync.whenIdle();
const afterUndoDump = await dumpAll(h);
const undoDiffs = diffDumps(baselineDump, afterUndoDump, { ignoreFields: STRUCT_ONLY_IGNORE });
ok(undoDiffs.length === 0, 'I4a: undo後のダンプ（構造フィールド：柱・梁・基礎）が削除前の基準と一致する');
if (undoDiffs.length > 0) printDiffs(undoDiffs);
const undoWallDiffs = diffWallFieldsOnly(baselineDump, afterUndoDump);
if (undoWallDiffs.length > 0) {
  console.log(`注意: I4aの壁幾何(wallGeom/wallCount)に${undoWallDiffs.length}階分差分あり（${undoWallDiffs.join(', ')}）——` +
    'B-1・既知の不具合（HEAD 3055191でも再現。案Pとは無関係。NGにしない）');
}

undoManager.redo();
await h.probeSync.whenIdle();
const afterRedoDump = await dumpAll(h);
const redoDiffs = diffDumps(afterDeleteDump, afterRedoDump, { ignoreFields: STRUCT_ONLY_IGNORE });
ok(redoDiffs.length === 0, 'I4b: redo後のダンプ（構造フィールド：柱・梁・基礎）が削除直後と一致する');
if (redoDiffs.length > 0) printDiffs(redoDiffs);
const redoWallDiffs = diffWallFieldsOnly(afterDeleteDump, afterRedoDump);
if (redoWallDiffs.length > 0) {
  console.log(`注意: I4bの壁幾何(wallGeom/wallCount)に${redoWallDiffs.length}階分差分あり（${redoWallDiffs.join(', ')}）——` +
    'B-1・既知の不具合（HEAD 3055191でも再現。案Pとは無関係。NGにしない）');
}

// I5: 他階で片端だけ参照していた壁が削除後も残る（端点ルール）。
if (singleEndWallsBefore.length === 0) {
  console.log('I5: 対象データに他階の片端参照壁が無いためスキップ（NGにしない）');
} else {
  let i5ok = true;
  for (const { planeId, wallId } of singleEndWallsBefore) {
    const plane = [...h.project.planeMap.values()].find(p => p.id === planeId);
    const decoded = await h.bytePeek(plane, h.project.structGraph);
    const wall = decoded.walls.find(w => w.id === wallId);
    if (!wall) { console.log(`  NG詳細: ${plane.name}の壁${wallId.slice(0, 8)}が消えている（端点ルールで残るはず）`); i5ok = false; continue; }
    if (wall.clStart.id === chosenId || wall.clEnd.id === chosenId) {
      console.log(`  NG詳細: ${plane.name}の壁${wallId.slice(0, 8)}が依然として削除idを参照している`);
      i5ok = false;
    }
  }
  ok(i5ok, `I5: 他階の片端参照壁(${singleEndWallsBefore.length}本)は端点ルールで残り、削除id参照は無い`);
}

// ---- (4) 性能: 独立に3回読み込み、削除呼び出し〜whenIdleの中央値を伝播部分・同期部分に分けて出す ----
const propagationMs = [], syncMs = [];
for (let i = 0; i < 3; i++) {
  const hp = buildHarness(src);
  await preConverge(hp);
  setCenterLineStructuralListener((g, p, s) => hp.probeSync.request(g, p, { scope: s }));
  const clP = hp.project.structGraph.shapeMap.get(chosenId);
  const t0 = performance.now();
  await deleteCenterLineWithUndo(hp.project.activeGraph, hp.project, clP, { saveFloorFn: hp.storeSave });
  const t1 = performance.now();
  await hp.probeSync.whenIdle();
  const t2 = performance.now();
  propagationMs.push(t1 - t0);
  syncMs.push(t2 - t1);
  setCenterLineStructuralListener(null);
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
console.log(`性能: 伝播部分(deleteCenterLineWithUndo呼び出し)中央値=${median(propagationMs).toFixed(1)}ms ` +
  `[${propagationMs.map(v => v.toFixed(1)).join(', ')}] / 同期部分(whenIdle)中央値=${median(syncMs).toFixed(1)}ms ` +
  `[${syncMs.map(v => v.toFixed(1)).join(', ')}]`);
if (median(syncMs) + median(propagationMs) > 200) {
  console.log(`注意: 合計中央値が200msを超えています（${(median(syncMs) + median(propagationMs)).toFixed(1)}ms）`);
}

setCenterLineStructuralListener(null);

if (ngCount === 0) {
  console.log(`OK: gridDeleteStructuralSyncProbe 全項目パス（${src}）`);
} else {
  console.log(`NG: ${ngCount}件の不一致（${src}）`);
  process.exitCode = 1;
}
