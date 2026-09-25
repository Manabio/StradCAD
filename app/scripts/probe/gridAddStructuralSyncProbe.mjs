// 通り芯の追加→構造同期（段階(c)。transform/centerLineOps.js addCenterLineFromDialog→
// pushUndoWithStructuralSync）の実データ確認用probe。
// ハーネスは scripts/probe/gridMoveStructuralSyncProbe.mjs の写し。起動口は本番と同じ
// addCenterLineFromDialog だけ。
//
// 基準は収束させてから採る（他probeと同じpreConverge。**必須**）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/gridAddStructuralSyncProbe.mjs [入力.stq]
import { performance } from 'node:perf_hooks';
import { loadDocument } from './loadDoc.mjs';
import { PlanGraph, centerLineKind, CenterLineType } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { undoManager } from '../../src/undoManager.js';
import { addCenterLineFromDialog, setCenterLineStructuralListener } from '../../src/transform/centerLineOps.js';
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

// 新規交点（新グリッド×既存直交グリッド）に柱があるかどうかを全階で数える。
async function countIntersectionColumns(h, newClId, newIsVertical) {
  h.activate();
  let count = 0;
  for (const plane of h.project.planeMap.values()) {
    const g = plane.id === h.project.activePlaneId ? h.project.activeGraph : await h.bytePeek(plane, h.project.structGraph);
    for (const c of g.columns) {
      if (c.role === 'foundation') continue;
      const onNew = newIsVertical ? c.verticalCL?.id === newClId : c.horizontalCL?.id === newClId;
      if (onNew) count++;
    }
  }
  return count;
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

// ---- 候補選定: structGraphの隣接通り芯（同軸2本の中点）。同座標に中心線等が既に無い
// （昇格経路に入らない）組合せを優先し、無ければ昇格経路（done:true+ERR_CL_CENTER_UPGRADED）で
// 妥協する——どちらも4箇所のpush先の1つであり、design-c.mdのA1「成功」の範囲（done:true）。----
function pickMidpointCandidates(structGraph, centerLineType) {
  const onAxis = structGraph.centerLines
    .filter(cl => cl.centerLineType === centerLineType && centerLineKind(cl) === 'struct')
    .sort((a, b) => a.value - b.value);
  const out = [];
  for (let i = 0; i < onAxis.length - 1; i++) {
    const gap = onAxis[i + 1].value - onAxis[i].value;
    if (gap <= 10) continue;
    const value = Math.round((onAxis[i].value + onAxis[i + 1].value) / 2);
    out.push({ type: centerLineType, value, perpCoord: (onAxis[i].value + onAxis[i + 1].value) / 2, gap });
  }
  return out.sort((a, b) => b.gap - a.gap); // 広い間隔を優先（衝突しにくい）
}

function makePayload(candidate) {
  return {
    clDialog: { type: candidate.type === CenterLineType.VERTICAL ? 'vertical' : 'horizontal', worldCoord: candidate.value, perpCoord: candidate.perpCoord },
    value: candidate.value, kind: 'struct', refId: null, refOffset: 0,
  };
}

// 既存の壁がこの候補の座標を横切るか（perpendicular wallのspanにcandidate.valueが含まれるか）。
// リード裁定（2026-09-25）: 壁と交差する位置を優先する——columnPlacement:'wallIntersections'
// （在来木造）は壁の交点に柱を置くため、壁が無い位置に通り芯だけ足しても柱は生まれない。
function crossesExistingWall(graph, candidate) {
  const isNewVertical = candidate.type === CenterLineType.VERTICAL;
  return graph.walls.some(w => {
    if (w.isVertical === isNewVertical) return false; // 直交壁だけが対象
    const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
    return c1 <= candidate.value && candidate.value <= c2;
  });
}

const allCandidates = [
  ...pickMidpointCandidates(hBase.project.structGraph, CenterLineType.VERTICAL),
  ...pickMidpointCandidates(hBase.project.structGraph, CenterLineType.HORIZONTAL),
].map(c => ({ ...c, crossesWall: crossesExistingWall(hBase.project.activeGraph, c) }))
  .sort((a, b) => (b.crossesWall - a.crossesWall) || (b.gap - a.gap)); // 壁交差を最優先、次に広い間隔
if (allCandidates.length === 0) {
  console.log('NG: 中点追加候補（同軸に通り芯2本以上）が無い');
  process.exit(1);
}

// ---- 検出力: 配線あり／なしでA2（新交点への格子柱）が変わる候補を順に探す（使い捨てハーネス）----
let candidate = null, wiredCount = 0, unwiredCount = 0;
for (const cand of allCandidates) {
  const hWiredProbe = buildHarness(src);
  const hUnwiredProbe = buildHarness(src);
  await preConverge(hWiredProbe);
  await preConverge(hUnwiredProbe);
  setCenterLineStructuralListener((g, p, scope) => hWiredProbe.probeSync.request(g, p, { scope }));
  addCenterLineFromDialog(hWiredProbe.project.activeGraph, hWiredProbe.project, makePayload(cand), null);
  setCenterLineStructuralListener(null);
  await hWiredProbe.probeSync.whenIdle();
  addCenterLineFromDialog(hUnwiredProbe.project.activeGraph, hUnwiredProbe.project, makePayload(cand), null);

  const newClIdWiredProbe = hWiredProbe.project.structGraph.centerLines.find(cl => cl.centerLineType === cand.type && Math.abs(cl.value - cand.value) < 1)?.id;
  const wc = newClIdWiredProbe ? await countIntersectionColumns(hWiredProbe, newClIdWiredProbe, cand.type === CenterLineType.VERTICAL) : 0;
  const newClIdUnwiredProbe = hUnwiredProbe.project.structGraph.centerLines.find(cl => cl.centerLineType === cand.type && Math.abs(cl.value - cand.value) < 1)?.id;
  const uc = newClIdUnwiredProbe ? await countIntersectionColumns(hUnwiredProbe, newClIdUnwiredProbe, cand.type === CenterLineType.VERTICAL) : 0;
  if (wc > uc) { candidate = cand; wiredCount = wc; unwiredCount = uc; break; }
}

if (!candidate) {
  console.log(`対象外（どの通り芯追加候補も配線あり／なしで格子柱数に差が出ない。主構造: ${hBase.project.structuralInfo.mainStructure}。` +
    'columnPlacementが壁交点方式で、候補位置に壁が無いため柱が生まれない可能性）');
  process.exit(0);
}
console.log(`対象: type=${candidate.type === CenterLineType.VERTICAL ? 'vertical' : 'horizontal'} value=${candidate.value}` +
  `（隣接通り芯の中点。壁交差=${candidate.crossesWall}）`);
console.log(`A2: 新交点の格子柱数 配線あり=${wiredCount}本 配線なし=${unwiredCount}本`);
ok(wiredCount > unwiredCount, `A2: whenIdle後に新交点へ格子柱が立つ（配線あり${wiredCount} > 配線なし${unwiredCount}）`);

// ---- 本編: フレッシュなハーネスでA1・A3・A4・A5を確認する（undoManagerは共有シングルトンのため、
// 使い捨てハーネスのpushと混ざらないよう独立させる）----
const h = buildHarness(src);
await preConverge(h);
setCenterLineStructuralListener((g, p, scope) => h.probeSync.request(g, p, { scope }));

const beforeUndoTop = undoManager.peekUndo();
const baselineDump = await dumpAll(h);
const addResult = addCenterLineFromDialog(h.project.activeGraph, h.project, makePayload(candidate), null);
await h.probeSync.whenIdle();

ok(addResult.done === true, `A1: addCenterLineFromDialog(通り芯追加)はdone:trueで成功する（実際: ${JSON.stringify(addResult)}）`);
ok(undoManager.peekUndo() !== beforeUndoTop, 'A1: 確定でundoエントリが1件増える');
const newClId = h.project.structGraph.centerLines.find(cl => cl.centerLineType === candidate.type && Math.abs(cl.value - candidate.value) < 1)?.id;
ok(!!newClId, 'A1: 追加された通り芯をstructGraphから引ける');

// ---- A3: 冪等（もう一度'all'で同期しても差分ゼロ）----
const dumpAfterAdd = await dumpAll(h);
h.probeSync.request(h.project.activeGraph, h.project, { scope: 'all' });
await h.probeSync.whenIdle();
const dumpSecond = await dumpAll(h);
const idempotentDiffs = diffDumps(dumpAfterAdd, dumpSecond);
ok(idempotentDiffs.length === 0, 'A3: 追加後もう1回同期しても全階ダンプ差分ゼロ（冪等）');
if (idempotentDiffs.length > 0) printDiffs(idempotentDiffs);

// ---- A4: undo→whenIdleで全階が基準に戻る（在来木造は他階の孤児梁芯を段階(g)まで許容し情報表示、
// それ以外の主構造は厳密判定）----
const isTraditionalWood = h.project.structuralInfo.mainStructure === '木造（在来）';
undoManager.undo();
await h.probeSync.whenIdle();
const dumpAfterUndo = await dumpAll(h);
const undoDiffs = diffDumps(baselineDump, dumpAfterUndo);
if (isTraditionalWood) {
  console.log(`A4(情報・在来木造は他階孤児梁芯を許容): undo後の全階差分 ${undoDiffs.length}件`);
  if (undoDiffs.length > 0) printDiffs(undoDiffs);
} else {
  ok(undoDiffs.length === 0, `A4: undo→whenIdleで全階が基準に戻る（実際: 差分${undoDiffs.length}件）`);
  if (undoDiffs.length > 0) printDiffs(undoDiffs);
}

// ---- A5: redoで追加直後と一致 ----
undoManager.redo();
await h.probeSync.whenIdle();
const dumpAfterRedo = await dumpAll(h);
const redoDiffs = diffDumps(dumpAfterAdd, dumpAfterRedo);
ok(redoDiffs.length === 0, `A5: redoで追加直後の状態と一致する（実際: 差分${redoDiffs.length}件）`);
if (redoDiffs.length > 0) printDiffs(redoDiffs);

setCenterLineStructuralListener(null);

// ---- 計時 ----
const commitMs = [], syncMs = [];
for (let i = 0; i < 3; i++) {
  const hp = buildHarness(src);
  await preConverge(hp);
  setCenterLineStructuralListener((g, p, s) => hp.probeSync.request(g, p, { scope: s }));
  const t0 = performance.now();
  addCenterLineFromDialog(hp.project.activeGraph, hp.project, makePayload(candidate), null);
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
console.log(`性能: 確定部分(addCenterLineFromDialog呼び出し)中央値=${median(commitMs).toFixed(1)}ms ` +
  `[${commitMs.map(v => v.toFixed(1)).join(', ')}] / 同期部分(whenIdle)中央値=${median(syncMs).toFixed(1)}ms ` +
  `[${syncMs.map(v => v.toFixed(1)).join(', ')}]`);

if (ngCount === 0) {
  console.log(`OK: gridAddStructuralSyncProbe 全項目パス（${src}）`);
} else {
  console.log(`NG: ${ngCount}件の不一致（${src}）`);
  process.exitCode = 1;
}
