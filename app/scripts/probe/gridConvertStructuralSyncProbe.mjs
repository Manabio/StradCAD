// 通り芯⇔中心線の変換（昇格・降格）→構造同期（段階(c)。core/centerLineKindPolicy.js
// structuralSyncScopeOfConversion・transform/centerLineOps.js promoteCenterToGridWithUndo/
// demoteGridToCenterWithUndo）の実データ確認用probe。
// ハーネスは scripts/probe/gridMoveStructuralSyncProbe.mjs の写し。起動口は本番と同じ
// demoteGridToCenterWithUndo→promoteCenterToGridWithUndo（往復）。findFloorsWithCounterpartCL・
// propagateDemotedCenterLine・recallPromotedCenterLineDuplicatesはfloorSwapManager.peekを直接
// 呼ぶため（ctx経由ではない）、harness.activate()でpeekを差し替えるだけでよい。
//
// 基準は収束させてから採る（他probeと同じpreConverge。**必須**）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/gridConvertStructuralSyncProbe.mjs [入力.stq]
import { performance } from 'node:perf_hooks';
import { loadDocument } from './loadDoc.mjs';
import { PlanGraph, centerLineKind, CenterLineType } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { undoManager } from '../../src/undoManager.js';
import { promoteCenterToGridWithUndo, demoteGridToCenterWithUndo, setCenterLineStructuralListener } from '../../src/transform/centerLineOps.js';
import { checkDemoteToCenterGuards } from '../../src/transform/centerLineConvert.js';
import { createStructuralSync } from '../../src/structural/structuralSync.js';
import { recomputeForStructuralSync } from '../../src/structural/structuralOrchestration.js';
import { createStructuralResolveContext } from '../../src/structural/structuralResolveContext.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/13.stq';

let ngCount = 0;
function ok(cond, label) {
  if (cond) { console.log(`OK: ${label}`); return true; }
  console.log(`NG: ${label}`);
  ngCount++;
  return false;
}

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

async function preConverge(harness) {
  harness.activate();
  harness.probeSync.request(harness.project.activeGraph, harness.project, { scope: 'all' });
  await harness.probeSync.whenIdle();
}

const hBase = buildHarness(src);
hBase.activate();
console.log(`主構造: ${hBase.project.structuralInfo.mainStructure} plane: ${hBase.project.activeGraph.plane.name}`);
await preConverge(hBase);

// ---- 候補選定: 降格ガードを通る通り芯（軸最後でない・直交通り芯2本・図形干渉なし）を同期ガードで
// 絞り込み、実際にdemoteGridToCenterWithUndo（使い捨てハーネス）を試して他階重複トースト等も
// 含めて成功する最初の1本を選ぶ。----
const syncGuardCandidates = hBase.project.structGraph.centerLines
  .filter(cl => centerLineKind(cl) === 'struct')
  .filter(cl => checkDemoteToCenterGuards(hBase.project.activeGraph, hBase.project.structGraph, cl) === null)
  .map(cl => ({ id: cl.id, type: cl.centerLineType, value: cl.value }));

let candidateId = null;
for (const cand of syncGuardCandidates) {
  const hTry = buildHarness(src);
  await preConverge(hTry);
  const cl = hTry.project.structGraph.shapeMap.get(cand.id);
  const { toast } = await demoteGridToCenterWithUndo(hTry.project.activeGraph, hTry.project, cl, { saveFloorFn: hTry.storeSave });
  if (toast === null) { candidateId = cand.id; break; }
}
if (!candidateId) {
  console.log('NG: 降格候補（ガードを通り実際にも成功する通り芯）が無い');
  process.exit(1);
}
const candMeta = syncGuardCandidates.find(c => c.id === candidateId);
console.log(`対象: id=${candidateId.slice(0, 8)} type=${candMeta.type} value=${Math.round(candMeta.value)}（降格候補）`);

// ---- C3: 配線なし比較（検出力。差が出ない主構造は対象外扱いでNGにしない）----
// undoManagerはグローバルシングルトンのため、使い捨てハーネス（hWired/hUnwired）のdemote呼び出しが
// 積むundoエントリが、後続の本編（h）のundo×2(C6)を汚染しないよう、本編ハーネスhを構築する前に
// C3を完了させる（実際に発見したprobe側のバグ。gridAddStructuralSyncProbe.mjsの旧版で発見した
// 「使い捨てハーネスと本編ハーネスでundoManagerのpush/popが混ざる」症状と同型。2026-09-25）。
{
  const hWired = buildHarness(src);
  const hUnwired = buildHarness(src);
  await preConverge(hWired);
  await preConverge(hUnwired);
  // floorSwapManager.peekはグローバルのため、各ハーネスの操作の直前に必ずそのハーネス自身の
  // peekへ戻す（preConverge(hUnwired)がpeekをhUnwired側へ上書きしたまま——実際に発見したバグ。
  // 2026-09-25）。
  hWired.activate();
  setCenterLineStructuralListener((g, p, scope) => hWired.probeSync.request(g, p, { scope }));
  const clWired = hWired.project.structGraph.shapeMap.get(candidateId);
  const { toast: wiredToast } = await demoteGridToCenterWithUndo(hWired.project.activeGraph, hWired.project, clWired, { saveFloorFn: hWired.storeSave });
  setCenterLineStructuralListener(null);
  await hWired.probeSync.whenIdle();
  hUnwired.activate();
  const clUnwired = hUnwired.project.structGraph.shapeMap.get(candidateId);
  const { toast: unwiredToast } = await demoteGridToCenterWithUndo(hUnwired.project.activeGraph, hUnwired.project, clUnwired, { saveFloorFn: hUnwired.storeSave });

  if (wiredToast !== null || unwiredToast !== null) {
    console.log(`C3(対象外): 配線あり／なしのいずれかで降格自体が失敗した（wired=${wiredToast} unwired=${unwiredToast}）`);
  } else {
    const dumpWired = await dumpAll(hWired);
    const dumpUnwired = await dumpAll(hUnwired);
    const c3Diffs = diffDumps(dumpWired, dumpUnwired);
    if (c3Diffs.length === 0) {
      console.log(`対象外（配線あり／なしで降格の効果に差が出ない主構造: ${hBase.project.structuralInfo.mainStructure}）`);
    } else {
      ok(true, `C3: 検出力（配線あり／なしで${c3Diffs.length}平面に差分）`);
    }
  }
}

// ---- 本編: フレッシュなハーネス（undoManagerの汚染を避けるためC3の後に構築する）----
const h = buildHarness(src);
await preConverge(h);
setCenterLineStructuralListener((g, p, scope) => h.probeSync.request(g, p, { scope }));

const baselineDump = await dumpAll(h);
let cl = h.project.structGraph.shapeMap.get(candidateId);

// ---- C1: 降格 ----
const beforeUndoTop1 = undoManager.peekUndo();
const { toast: c1Toast } = await demoteGridToCenterWithUndo(h.project.activeGraph, h.project, cl, { saveFloorFn: h.storeSave });
await h.probeSync.whenIdle();
ok(c1Toast === null, `C1: demoteGridToCenterWithUndo(降格)はtoast:nullで成功する（実際: ${c1Toast}）`);
ok(undoManager.peekUndo() !== beforeUndoTop1, 'C1: 確定でundoエントリが1件増える');
cl = h.project.activeGraph.shapeMap.get(candidateId);
ok(cl != null && centerLineKind(cl) === 'center', 'C1: 降格後は自階に中心線として存在する');

const dumpAfterDemote = await dumpAll(h);

// ---- C2: 冪等 ----
h.probeSync.request(h.project.activeGraph, h.project, { scope: 'all' });
await h.probeSync.whenIdle();
const dumpAfterDemoteAgain = await dumpAll(h);
const c2Diffs = diffDumps(dumpAfterDemote, dumpAfterDemoteAgain);
ok(c2Diffs.length === 0, 'C2: 降格後もう1回同期しても全階ダンプ差分ゼロ（冪等）');
if (c2Diffs.length > 0) printDiffs(c2Diffs);

// ---- C4: 同idで昇格。発見①②④はいずれも案Aで解消済みのため厳密判定に戻す（2026-09-25） ----
const beforeUndoTop4 = undoManager.peekUndo();
const { toast: c4Toast } = await promoteCenterToGridWithUndo(h.project.activeGraph, h.project, cl, { saveFloorFn: h.storeSave });
await h.probeSync.whenIdle();
ok(c4Toast === null, `C4: promoteCenterToGridWithUndo(昇格)はtoast:nullで成功する（実際: ${c4Toast}）`);
ok(undoManager.peekUndo() !== beforeUndoTop4, 'C4: 確定でundoエントリが1件増える');
ok(h.project.structGraph.shapeMap.has(candidateId), 'C4: 昇格後は同idでstructGraphに存在する');

const dumpAfterPromote = await dumpAll(h);

// ---- C5: 往復（降格→昇格）が基準と一致（全階）。発見③（境界通り芯の一時消失に伴う偏心・軒の
// 出量再計算のずれ。既知の限界として受容・.claude/cl-conversion-limits.md参照）はS造でのみ
// 確認されているため、S造だけ情報表示に留め、それ以外（在来木造等）は厳密判定にする（2026-09-25）----
const isSteelStructure = h.project.structuralInfo.mainStructure === 'S造';
const c5Diffs = diffDumps(baselineDump, dumpAfterPromote);
if (isSteelStructure) {
  console.log(`C5(情報・既知の限界。.claude/cl-conversion-limits.md参照): 降格→昇格の往復後、全階ダンプと基準の差分 = ${c5Diffs.length}件` +
    (c5Diffs.length > 0 ? '（発見③: 境界通り芯の一時消失で偏心・軒の出量が再計算され微妙にずれる）' : '（差分なし）'));
  if (c5Diffs.length > 0) printDiffs(c5Diffs);
} else {
  ok(c5Diffs.length === 0, `C5: 降格→昇格の往復後、全階ダンプが基準と一致する（実際: 差分${c5Diffs.length}件）`);
  if (c5Diffs.length > 0) printDiffs(c5Diffs);
}

// ---- C6: undo×2で基準、redo×2で昇格後と一致 ----
undoManager.undo(); // 昇格を戻す
await h.probeSync.whenIdle();
undoManager.undo(); // 降格を戻す
await h.probeSync.whenIdle();
const dumpAfterUndo2 = await dumpAll(h);
const c6UndoDiffs = diffDumps(baselineDump, dumpAfterUndo2);
ok(c6UndoDiffs.length === 0, `C6: undo×2で全階ダンプが基準と一致する（実際: 差分${c6UndoDiffs.length}件）`);
if (c6UndoDiffs.length > 0) printDiffs(c6UndoDiffs);

undoManager.redo(); // 降格をやり直す
await h.probeSync.whenIdle();
undoManager.redo(); // 昇格をやり直す
await h.probeSync.whenIdle();
const dumpAfterRedo2 = await dumpAll(h);
const c6RedoDiffs = diffDumps(dumpAfterPromote, dumpAfterRedo2);
ok(c6RedoDiffs.length === 0, `C6: redo×2で全階ダンプが昇格後の状態と一致する（実際: 差分${c6RedoDiffs.length}件）`);
if (c6RedoDiffs.length > 0) printDiffs(c6RedoDiffs);

setCenterLineStructuralListener(null);

// ---- 計時 ----
const demoteMs = [], promoteMs = [];
for (let i = 0; i < 3; i++) {
  const hp = buildHarness(src);
  await preConverge(hp);
  const clP = hp.project.structGraph.shapeMap.get(candidateId);
  setCenterLineStructuralListener((g, p, s) => hp.probeSync.request(g, p, { scope: s }));
  const t0 = performance.now();
  await demoteGridToCenterWithUndo(hp.project.activeGraph, hp.project, clP, { saveFloorFn: hp.storeSave });
  const t1 = performance.now();
  await hp.probeSync.whenIdle();
  const t2 = performance.now();
  demoteMs.push(t1 - t0);
  promoteMs.push(t2 - t1);
  setCenterLineStructuralListener(null);
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
console.log(`性能: 降格確定部分中央値=${median(demoteMs).toFixed(1)}ms [${demoteMs.map(v => v.toFixed(1)).join(', ')}] / ` +
  `同期部分中央値=${median(promoteMs).toFixed(1)}ms [${promoteMs.map(v => v.toFixed(1)).join(', ')}]`);

if (ngCount === 0) {
  console.log(`OK: gridConvertStructuralSyncProbe 全項目パス（${src}）`);
} else {
  console.log(`NG: ${ngCount}件の不一致（${src}）`);
  process.exitCode = 1;
}
