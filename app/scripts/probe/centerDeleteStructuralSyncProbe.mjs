// 中心線削除→構造同期（段階(b)。実機報告2026-09-25: tategu-test3.stqで真ん中の中心線を削除すると
// 壁の真ん中の柱が残ったまま（他モードへ移ってから戻ると消える）だったバグの修正確認用probe。
// openingJambInsertProbe.mjsと同型——本番の setCenterLineStructuralListener 配線だけを起動口にする
// （probe自身が structuralSync.request を直接呼ぶと本番配線を経由せずに済んでしまい、
// listener呼び出しを外しても検出できない＝検出力ゼロになる。手動でrecomputeStructuralForGraph/
// structuralSync.requestを直接呼ばない）。
//
// 本番同型peek: structuralSyncScopeOfKind('center')==='activeAndAbove'は現状recomputeForStructuralSync
// 内で'all'と同じコード（reflectStructuralToOtherFloors経由で他階へも触れる）を通るため、
// gridDeleteStructuralSyncProbe.mjsと同じくfloorSwapManager.peekをバイト復元に差し替え、
// structuralSync相当のインスタンスにも解決コンテキスト（peek/save）を注入する——ctx省略のまま
// 本番シングルトンをそのまま使うと既定のsave=storage/db.js saveFloorが実IndexedDBへ書き込もうとし、
// Node上ではReferenceError（indexedDB未定義）になる（実測で確認）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/centerDeleteStructuralSyncProbe.mjs [入力.stq] [中心線ラベル省略可]
import { loadDocument } from './loadDoc.mjs';
import { PlanGraph, centerLineKind, Discipline } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { undoManager } from '../../src/undoManager.js';
import { deleteCenterLineWithUndo, setCenterLineStructuralListener } from '../../src/transform/centerLineOps.js';
import { createStructuralSync } from '../../src/structural/structuralSync.js';
import { recomputeForStructuralSync } from '../../src/structural/structuralOrchestration.js';
import { createStructuralResolveContext } from '../../src/structural/structuralResolveContext.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/tategu-test3.stq';
const labelArg = process.argv[3] ?? null;

let ngCount = 0;
function ok(cond, label) {
  if (cond) { console.log(`OK: ${label}`); return true; }
  console.log(`NG: ${label}`);
  ngCount++;
  return false;
}

// ---- 本番同型ハーネス（gridDeleteStructuralSyncProbe.mjsと同じ手順。生きたgraphMapは返さない）----
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

// ---- ダンプ（柱のAXIS・role、梁の軸・範囲・role、基礎、壁の本数・幾何、CL参照id）----
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
      // (2)用: 柱・梁・基礎が参照するCL id一式（削除id参照ゼロの確認に使う。sortして順序差の誤検出を避ける）。
      clRefs: [
        ...g.columns.flatMap(c => [c.verticalCL.id, c.horizontalCL.id]),
        ...g.beams.flatMap(b => [b.axisCL.id, b.clStart.id, b.clEnd.id]),
        ...g.footings.flatMap(f => [f.verticalCL.id, f.horizontalCL.id]),
      ].sort(),
    };
  }
  return out;
}

// ignoreFields既定でclRefsを除く（壁由来梁芯idの作り直し等、本経路と無関係な既存の性質を誤検出しない
// ——gridDeleteStructuralSyncProbe.mjsと同じ理由）。
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

function printDiffs(diffs, limit = 5) {
  for (const d of diffs.slice(0, limit)) {
    console.log(`  差分[${d.floor}]:`);
    console.log(`    before: ${JSON.stringify(d.before)}`.slice(0, 400));
    console.log(`    after : ${JSON.stringify(d.after)}`.slice(0, 400));
  }
  if (diffs.length > limit) console.log(`  ...他${diffs.length - limit}件`);
}

console.log(`=== ${src} ===`);

// ---- 候補選定: 「壁が乗っている中心線」を軽く絞り込んだ上で、配線あり／なしで結果が変わる
// 最初の1本を選ぶ（gridDeleteStructuralSyncProbe.mjsと同じ検出力優先の方式——実データでは
// 「壁の中間に柱が立つ」の厳密な幾何一致がゼロのことがあり、直接participatingする柱・梁の
// 全体差分で検出する方が実際のバグ再現に忠実）。
const hCand = buildHarness(src);
const activeForCandidates = hCand.project.activeGraph;
let candidates = activeForCandidates.centerLines.filter(cl => centerLineKind(cl) === 'center');
if (labelArg) candidates = candidates.filter(cl => cl.label === labelArg);
candidates = candidates.filter(cl => activeForCandidates.walls.some(w => w.axisCL.id === cl.id));
if (candidates.length === 0) {
  console.log(`NG: 削除候補の中心線（壁が乗っているもの）が無い（labelArg=${labelArg}）`);
  process.exit(1);
}

async function tryDeleteOn(harness, clId, wired) {
  if (wired) setCenterLineStructuralListener((g, p, scope) => harness.probeSync.request(g, p, { scope }));
  else setCenterLineStructuralListener(null);
  harness.activate();
  const cl = harness.project.activeGraph.centerLines.find(c => c.id === clId);
  const { toast } = await deleteCenterLineWithUndo(harness.project.activeGraph, harness.project, cl);
  await harness.probeSync.whenIdle();
  setCenterLineStructuralListener(null);
  return toast;
}

let chosenId = null;
for (const cand of candidates) {
  const hWired = buildHarness(src);
  const hUnwired = buildHarness(src);
  const toastWired = await tryDeleteOn(hWired, cand.id, true);
  const toastUnwired = await tryDeleteOn(hUnwired, cand.id, false);
  if (toastWired !== null || toastUnwired !== null) continue;
  const dumpWired = await dumpAll(hWired);
  const dumpUnwired = await dumpAll(hUnwired);
  const diffs = diffDumps(dumpWired, dumpUnwired);
  if (diffs.length > 0) {
    chosenId = cand.id;
    console.log(`対象中心線: id=${cand.id.slice(0, 8)} type=${cand.centerLineType} value=${Math.round(cand.effectiveValue)}（配線あり／なしで${diffs.length}平面に差分。検出力あり）`);
    break;
  }
}
if (!chosenId) {
  console.log('NG: 検出力なし（どの中心線を削除しても配線あり／なしで結果が変わらない）');
  process.exit(1);
}

// ---- 検証（配線あり）本編。フレッシュなハーネスで再実行する ----
const h = buildHarness(src);
h.activate();
setCenterLineStructuralListener((g, p, scope) => h.probeSync.request(g, p, { scope }));

const baselineDump = await dumpAll(h);
const clMain = h.project.activeGraph.centerLines.find(c => c.id === chosenId);
// (1)用: 削除前にこの中心線を直接参照している柱（壁交点柱含む）を控えておく。
const columnsOnClBefore = h.project.activeGraph.columns
  .filter(c => c.verticalCL.id === chosenId || c.horizontalCL.id === chosenId)
  .map(c => c.id);

// (6)用: 削除前の壁由来梁芯（discipline:fuse）id一式とexcludedWallBeamAxesの件数を控えておく
// （ユーザー承認済み例外・2026-09-25。明示的な中心線削除で失われる壁だけが根拠の梁芯を道連れにする）。
const beamAxisIdsBefore = new Set(
  h.project.activeGraph.centerLines.filter(cl => cl.discipline === Discipline.FUSE).map(cl => cl.id));
const excludedSizeBefore = h.project.activeGraph.excludedWallBeamAxes.size;

const { toast: mainToast } = await deleteCenterLineWithUndo(h.project.activeGraph, h.project, clMain);
await h.probeSync.whenIdle();
ok(mainToast === null, `deleteCenterLineWithUndo(中心線)はtoast:nullで成功する（実際: ${mainToast}）`);

const afterDeleteDump = await dumpAll(h);

// (1) その中心線上に立っていた柱（壁交点柱）が消える。
const stillThere = columnsOnClBefore.filter(id => h.project.activeGraph.columnMap.has(id));
ok(columnsOnClBefore.length > 0 && stillThere.length === 0,
  `(1) 削除前にこの中心線を参照していた柱(${columnsOnClBefore.length}本)が削除直後にすべて撤去される`);
if (stillThere.length > 0) console.log('  残っている柱id:', stillThere.map(id => id.slice(0, 8)));

// (2) 全階で削除id参照の柱・梁・基礎が0本。
const stillReferencing = Object.entries(afterDeleteDump).filter(([, d]) => d.clRefs.includes(chosenId));
ok(stillReferencing.length === 0, '(2) 全階で削除id参照の柱・梁・基礎が0本');
if (stillReferencing.length > 0) console.log('  参照が残る階:', stillReferencing.map(([name]) => name));

// (6) 削除で失われる壁だけが根拠だった壁由来梁芯（discipline:fuse）が削除直後に消え、
// excludedWallBeamAxesは変わらない（一般の梁芯削除記録＝手動削除・移動と混同しない）。
const beamAxisIdsAfterDelete = new Set(
  h.project.activeGraph.centerLines.filter(cl => cl.discipline === Discipline.FUSE).map(cl => cl.id));
const draggedAlongIds = [...beamAxisIdsBefore].filter(id => !beamAxisIdsAfterDelete.has(id));
ok(draggedAlongIds.length > 0,
  `(6) 中心線削除で失われる壁だけが根拠だった壁由来梁芯が削除直後に道連れで消える（${draggedAlongIds.length}本）`);
if (draggedAlongIds.length === 0) console.log('  NG詳細: 道連れで消えた壁由来梁芯が0本（例外の起動を検出できない）');
ok(h.project.activeGraph.excludedWallBeamAxes.size === excludedSizeBefore,
  '(6) 道連れ削除はexcludedWallBeamAxesの件数を変えない（一般の梁芯削除記録と混同しない）');

// (3) もう1回同期しても全階ダンプ差分ゼロ（冪等）。
h.probeSync.request(h.project.activeGraph, h.project, { scope: 'activeAndAbove' });
await h.probeSync.whenIdle();
const afterSecondRun = await dumpAll(h);
const idempotentDiffs = diffDumps(afterDeleteDump, afterSecondRun);
ok(idempotentDiffs.length === 0, '(3) 削除後もう1回同期しても全階ダンプ差分ゼロ（冪等）');
if (idempotentDiffs.length > 0) printDiffs(idempotentDiffs);

// (4) undo→whenIdle後のダンプが基準と一致、redo→whenIdle後が削除直後と一致（構造フィールドのみ）。
const STRUCT_ONLY_IGNORE = ['clRefs', 'wallGeom', 'wallCount'];

undoManager.undo();
await h.probeSync.whenIdle();
const afterUndoDump = await dumpAll(h);
const undoDiffs = diffDumps(baselineDump, afterUndoDump, { ignoreFields: STRUCT_ONLY_IGNORE });
const undoColumnsBack = columnsOnClBefore.every(id => h.project.activeGraph.columnMap.has(id));
ok(undoDiffs.length === 0 && undoColumnsBack, '(4a) undo後は柱が戻り、基準（構造フィールド）と一致する');
if (undoDiffs.length > 0) printDiffs(undoDiffs);

// (6続き) undoで道連れ削除された壁由来梁芯が同じidのまま戻り、excludedWallBeamAxesも変わらない。
const beamAxisIdsAfterUndo = new Set(
  h.project.activeGraph.centerLines.filter(cl => cl.discipline === Discipline.FUSE).map(cl => cl.id));
const draggedAlongRestored = draggedAlongIds.every(id => beamAxisIdsAfterUndo.has(id));
ok(draggedAlongIds.length > 0 && draggedAlongRestored,
  '(6) undoで道連れ削除された壁由来梁芯が同じidのまま戻る');
ok(h.project.activeGraph.excludedWallBeamAxes.size === excludedSizeBefore,
  '(6) undo後もexcludedWallBeamAxesの件数は変わらない');
const undoWallDiffs = diffWallFieldsOnly(baselineDump, afterUndoDump);
if (undoWallDiffs.length > 0) {
  console.log(`注意: (4a)の壁幾何(wallGeom/wallCount)に${undoWallDiffs.length}階分差分あり（${undoWallDiffs.join(', ')}）——` +
    'B-1と同種の既知の性質の可能性（NGにしない）');
}

undoManager.redo();
await h.probeSync.whenIdle();
const afterRedoDump = await dumpAll(h);
const redoDiffs = diffDumps(afterDeleteDump, afterRedoDump, { ignoreFields: STRUCT_ONLY_IGNORE });
ok(redoDiffs.length === 0, '(4b) redo後のダンプ（構造フィールド）が削除直後と一致する');
if (redoDiffs.length > 0) printDiffs(redoDiffs);
const redoWallDiffs = diffWallFieldsOnly(afterDeleteDump, afterRedoDump);
if (redoWallDiffs.length > 0) {
  console.log(`注意: (4b)の壁幾何(wallGeom/wallCount)に${redoWallDiffs.length}階分差分あり（${redoWallDiffs.join(', ')}）——` +
    'B-1と同種の既知の性質の可能性（NGにしない）');
}

setCenterLineStructuralListener(null);

// (5) 配線なしでは柱が残る（検出力）。フレッシュなハーネスで同じ削除を配線なしで行う。
const hNoWire = buildHarness(src);
hNoWire.activate();
const clNoWire = hNoWire.project.activeGraph.centerLines.find(c => c.id === chosenId);
setCenterLineStructuralListener(null);
const { toast: noWireToast } = await deleteCenterLineWithUndo(hNoWire.project.activeGraph, hNoWire.project, clNoWire);
await hNoWire.probeSync.whenIdle(); // 配線なしなので即座に解決するはずだが、配線ありと同じだけ待つ
ok(noWireToast === null, '(5) 検出力確認: 配線なしでも削除自体はtoast:nullで成功する');
const noWireDump = await dumpAll(hNoWire);
const noWireDiffs = diffDumps(afterDeleteDump, noWireDump);
ok(noWireDiffs.length > 0, '(5) 配線なしでは配線ありの削除直後ダンプと食い違う（柱・梁が残る＝検出力あり）');
if (noWireDiffs.length === 0) console.log('  NG詳細: 配線なしでも配線ありと同じ結果になった（検出力なし）');

if (ngCount === 0) {
  console.log(`OK: centerDeleteStructuralSyncProbe 全項目パス（${src}）`);
} else {
  console.log(`NG: ${ngCount}件の不一致（${src}）`);
  process.exitCode = 1;
}
