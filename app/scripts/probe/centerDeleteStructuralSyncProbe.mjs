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
// Node上ではReferenceError（指定indexedDB未定義）になる（実測で確認）。
//
// 基準は収束させてから採る（段階(b)・moku4不一致の対処。gridDeleteStructuralSyncProbe.mjsと同じ
// preConverge）: .stqの生データは構造未同期（屋根の梁等が未計算）のことがあるため、削除前の基準を
// 素の読込み直後ではなく「'all'で1回収束させた状態」にする——未収束の.stqをそのまま基準にすると
// undo比較（(4a)）が無意味になる（moku4で実測: 未収束のままだと収束の副作用が「削除の効果」に
// 誤って混入し(4a)がNGになっていた）。候補選定にも同じ収束後の状態を使う——収束前は対象の中心線を
// 参照する柱がまだ存在しないことがあり、(1)が空振り（分母0で無条件パス）になるため。
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

// 削除前に一度収束させておく（上記コメント「基準は収束させてから採る」参照）。
async function preConverge(harness) {
  harness.activate();
  harness.probeSync.request(harness.project.activeGraph, harness.project, { scope: 'all' });
  await harness.probeSync.whenIdle();
}

// ---- 候補選定: 「この中心線を参照する柱が1本以上ある」で絞り込んだ上で、配線あり／なしで
// 結果が変わる最初の1本を選ぶ（gridDeleteStructuralSyncProbe.mjsと同じ検出力優先の方式——実データ
// では「壁の中間に柱が立つ」の厳密な幾何一致がゼロのことがあり、直接participatingする柱・梁の
// 全体差分で検出する方が実際のバグ再現に忠実）。preConverge後の状態から候補を選ぶ——収束前は
// 対象の中心線を参照する柱がまだ無いことがあり、(1)が空振り（分母0で無条件パス）になるため
// （段階(b)・moku4不一致の対処）。
//
// 【実装時の食い違い・報告】設計書は「壁が乗っている中心線」の既存条件に「柱参照あり」をAND追加する
// 想定だったが、実データで確認したところ moku4.stq は「自身に壁が乗っており、かつ自身を柱が参照する」
// 中心線が実体3階すべてに1本も無い（壁がある中心線は柱参照0本、柱参照がある中心線は壁0本——実測で
// 確認、debug scriptは検証後削除）。AND条件のままではmoku4で候補0件になり「moku4で(4a)がOKになる
// ことを確認する」という設計の期待に到達できないため、「壁が乗っている」の事前条件は落とし「柱参照
// あり」だけを最低条件にした。
// QA指摘n-2（2026-09-25）: 候補は「壁が乗っており、かつ柱参照あり」を優先し、無ければ「柱参照あり
// だけ」の候補へ下がる順で並べる——両方満たす候補があるドキュメントでは(6)（壁由来梁芯の道連れ削除。
// 段階(b)以前からの別機能の検証）を確実に評価できるようにする（REASONED: tategu-test3は元々
// 「壁が乗っており、かつ柱参照あり」の候補（0061fe13, X=3640）を持つため、優先リストの先頭に来て
// 従来どおり選ばれ続ける——候補は不変）。
// **既知の限界（実測で確認）**: moku4.stqは実体3階のうち収束後の候補選定に使うアクティブ階（2階）に
// 「壁が乗っており、かつ柱参照あり」を同時に満たす中心線が1本も無い（壁がある中心線は柱参照0本、
// 柱参照がある中心線は壁0本）——優先順位を付けても、優先リストが空のままフォールバック（柱参照のみ）
// へ下がるため、moku4では引き続き(6)が「対象外」になる。これは候補選定コードの不備ではなく実データの
// 性質（このドキュメントのこの階には両条件を同時に満たす中心線が存在しない）——他階まで候補探索を
// 広げる変更は本指摘の範囲を超えるため行っていない。
const hCand = buildHarness(src);
await preConverge(hCand);
const activeForCandidates = hCand.project.activeGraph;
let candidates = activeForCandidates.centerLines.filter(cl => centerLineKind(cl) === 'center');
if (labelArg) candidates = candidates.filter(cl => cl.label === labelArg);
candidates = candidates.filter(cl =>
  activeForCandidates.columns.some(c => c.verticalCL.id === cl.id || c.horizontalCL.id === cl.id));
if (candidates.length === 0) {
  console.log(`NG: 削除候補の中心線（収束後に柱を1本以上参照しているもの）が無い（labelArg=${labelArg}）`);
  process.exit(1);
}
const hasOwnWall = cl => activeForCandidates.walls.some(w => w.axisCL.id === cl.id);
candidates = [...candidates.filter(hasOwnWall), ...candidates.filter(cl => !hasOwnWall(cl))];

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
  await preConverge(hWired);
  await preConverge(hUnwired);
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
await preConverge(h);
setCenterLineStructuralListener((g, p, scope) => h.probeSync.request(g, p, { scope }));

const baselineDump = await dumpAll(h);
const clMain = h.project.activeGraph.centerLines.find(c => c.id === chosenId);
// (6)がこの候補に適用可能か（自身に壁が乗っているか。上記「候補選定」コメント参照——
// 候補条件は「柱参照あり」だけなので、壁を持たない候補が選ばれることがある）。
const chosenHasOwnWall = h.project.activeGraph.walls.some(w => w.axisCL.id === chosenId);
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
// 選ばれた候補が自身に壁を持たない場合（候補選定は「柱参照あり」だけを条件にしたため起こりうる。
// 実データではmoku4）、この候補の削除では壁由来梁芯を道連れにする根拠自体が無い——「0本道連れ」を
// 不具合として扱わず対象外（情報表示のみ・NGにしない）とする。
const beamAxisIdsAfterDelete = new Set(
  h.project.activeGraph.centerLines.filter(cl => cl.discipline === Discipline.FUSE).map(cl => cl.id));
const draggedAlongIds = [...beamAxisIdsBefore].filter(id => !beamAxisIdsAfterDelete.has(id));
if (chosenHasOwnWall) {
  ok(draggedAlongIds.length > 0,
    `(6) 中心線削除で失われる壁だけが根拠だった壁由来梁芯が削除直後に道連れで消える（${draggedAlongIds.length}本）`);
  if (draggedAlongIds.length === 0) console.log('  NG詳細: 道連れで消えた壁由来梁芯が0本（例外の起動を検出できない）');
  ok(h.project.activeGraph.excludedWallBeamAxes.size === excludedSizeBefore,
    '(6) 道連れ削除はexcludedWallBeamAxesの件数を変えない（一般の梁芯削除記録と混同しない）');
} else {
  console.log(`(6) 対象外: 選ばれた候補(${chosenId.slice(0, 8)})は自身に壁を持たないため、壁由来梁芯の道連れ削除の検証は適用されない（NGにしない）`);
}

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

// (6続き) undoで道連れ削除された壁由来梁芯が同じidのまま戻り、excludedWallBeamAxesも変わらない
// （chosenHasOwnWallがfalseなら(6)本体と同様に対象外——上記コメント参照）。
if (chosenHasOwnWall) {
  const beamAxisIdsAfterUndo = new Set(
    h.project.activeGraph.centerLines.filter(cl => cl.discipline === Discipline.FUSE).map(cl => cl.id));
  const draggedAlongRestored = draggedAlongIds.every(id => beamAxisIdsAfterUndo.has(id));
  ok(draggedAlongIds.length > 0 && draggedAlongRestored,
    '(6) undoで道連れ削除された壁由来梁芯が同じidのまま戻る');
  ok(h.project.activeGraph.excludedWallBeamAxes.size === excludedSizeBefore,
    '(6) undo後もexcludedWallBeamAxesの件数は変わらない');
}
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

// (5) 配線なしでは柱が残る（検出力）。フレッシュなハーネスで同じ削除を配線なしで行う
// （afterDeleteDumpと公平に比較するため、こちらも本編のhと同じくpreConvergeしてから削除する）。
const hNoWire = buildHarness(src);
await preConverge(hNoWire);
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
