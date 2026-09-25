// CL偏芯の確定→構造同期（段階(e)・2026-09-26。transform/centerLineOps.js
// applyCLEccentricityWithUndo・finish/eccentricityFloorSync.js propagateCLEccentricities）の
// 実データ確認用probe。ひな形は centerMoveStructuralSyncProbe.mjs（本番同型peek・probeSync・
// preConverge・検出力の候補探索ループ）。起動口は本番と同じ applyCLEccentricityWithUndo だけ
// （saveFloorFn: h.storeSave のみ差し替え。applyFn/propagateFnは実体のまま——本番配線だけを
// 起動口にする規律。openingJambInsertProbe.mjs・gridDeleteStructuralSyncProbe.mjsと同じ）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/clEccStructuralSyncProbe.mjs [入力.stq]
import { performance } from 'node:perf_hooks';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { PlanGraph, centerLineKind, CenterLineType } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { undoManager } from '../../src/undoManager.js';
import { applyCLEccentricityWithUndo, setCenterLineStructuralListener } from '../../src/transform/centerLineOps.js';
import { isFinishCellDivider } from '../../src/core/centerLineKindPolicy.js';
import { interiorWallSpans } from '../../src/finish/edgeClassify.js';
import { applyCLEccentricity } from '../../src/finish/clEccentricity.js';
import { wallBackingCenters, findWallBeamAxisCL, wallBeamSourcesFor, peekBelowGraph } from '../../src/structural/wallBeamAxes.js';
import { createStructuralSync } from '../../src/structural/structuralSync.js';
import { recomputeForStructuralSync } from '../../src/structural/structuralOrchestration.js';
import { createStructuralResolveContext } from '../../src/structural/structuralResolveContext.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { rulesFor, effectiveStructure } from '../../src/structural/structureRules.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/tategu-test3.stq';

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

  const probeSync = createStructuralSync({
    recompute: (p, s) => {
      const ctx = createStructuralResolveContext({ peek: bytePeek, save: storeSave });
      return recomputeForStructuralSync(p, s, ctx).finally(() => ctx.dispose());
    },
  });

  return { project, store, bytePeek, storeSave, probeSync, activate };
}

async function preConverge(harness) {
  harness.activate();
  harness.probeSync.request(harness.project.activeGraph, harness.project, { scope: 'all' });
  await harness.probeSync.whenIdle();
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
    console.log(`    before: ${JSON.stringify(d.before)}`.slice(0, 300));
    console.log(`    after : ${JSON.stringify(d.after)}`.slice(0, 300));
  }
  if (diffs.length > limit) console.log(`  ...他${diffs.length - limit}件`);
}

console.log(`=== ${src} ===`);

const hBase = buildHarness(src);
hBase.activate();
console.log(`主構造: ${hBase.project.structuralInfo.mainStructure} plane: ${hBase.project.activeGraph.plane.name}`);
await preConverge(hBase);

const activeRules = rulesFor(effectiveStructure(hBase.project.activeGraph, hBase.project));
if (activeRules.wallBeamAxes == null && activeRules.columnPlacement !== 'wallIntersections') {
  console.log(`対象外（中心線に反応しない主構造: ${hBase.project.structuralInfo.mainStructure}）`);
  process.exit(0);
}

// ---- E0: 基準の冪等性（収束後、probeSync.request('all')を2回回しても全階ダンプ差分ゼロ）----
const baseDump1 = await dumpAll(hBase);
hBase.probeSync.request(hBase.project.activeGraph, hBase.project, { scope: 'all' });
await hBase.probeSync.whenIdle();
const baseDump2 = await dumpAll(hBase);
const baseDiffs = diffDumps(baseDump1, baseDump2);
ok(baseDiffs.length === 0, 'E0: 基準の冪等性（収束後、probeSync.request("all")を2回回しても全階ダンプ差分ゼロ）');
if (baseDiffs.length > 0) printDiffs(baseDiffs);

// ---- 候補選定: isFinishCellDivider(cl) かつ interiorWallSpans(graph, cl.id).length>0 かつ
// 偏芯レコード未保持のCLに対し、3種の偏芯を順に試し「下地帯中心の移動1件以上」かつ
// 「配線あり／なしで結果が変わる」最初の組を選ぶ ----
const materialMap = await loadMaterialMap();
const SPEC_VARIANTS = [
  { mode: 'face', value: 0, side: 1, backing: '' },
  { mode: 'face', value: 0, side: -1, backing: '' },
  { mode: 'value', value: 30, side: 1 },
];

const activeForCandidates = hBase.project.activeGraph;
const candidates = activeForCandidates.centerLines.filter(cl =>
  isFinishCellDivider(cl) && interiorWallSpans(activeForCandidates, cl.id).length > 0 && !activeForCandidates.clEccentricities.has(cl.id));
if (candidates.length === 0) {
  console.log('NG: 候補（内壁指定CLで偏芯レコード未保持のもの）が無い');
  process.exit(1);
}

function tryApplyOn(harness, clId, spec, wired) {
  if (wired) setCenterLineStructuralListener((g, p, scope) => harness.probeSync.request(g, p, { scope }));
  else setCenterLineStructuralListener(null);
  harness.activate();
  const cl = harness.project.activeGraph.shapeMap.get(clId);
  return applyCLEccentricityWithUndo(harness.project.activeGraph, harness.project, cl, { rec: spec, materialMap, saveFloorFn: harness.storeSave })
    .finally(() => setCenterLineStructuralListener(null));
}

let chosen = null;
for (const cand of candidates) {
  for (const spec of SPEC_VARIANTS) {
    const hWired = buildHarness(src);
    const hUnwired = buildHarness(src);
    await preConverge(hWired);
    await preConverge(hUnwired);
    const backingBefore = wallBackingCenters(hWired.project.activeGraph);
    let toastWired = null, toastUnwired = null;
    try {
      ({ toast: toastWired } = await tryApplyOn(hWired, cand.id, spec, true));
      await hWired.probeSync.whenIdle();
      ({ toast: toastUnwired } = await tryApplyOn(hUnwired, cand.id, spec, false));
    } catch (e) {
      continue; // この候補・specでは確定自体が失敗（想定外の壁構成等）。次を試す
    }
    if (toastWired !== null || toastUnwired !== null) continue;
    const backingAfter = wallBackingCenters(hWired.project.activeGraph);
    const movedCount = backingAfter.filter(a => {
      const b = backingBefore.find(x => x.axisCLId === a.axisCLId && x.isVertical === a.isVertical && x.side === a.side);
      return b && Math.abs(b.coord - a.coord) > 0.5;
    }).length;
    if (movedCount === 0) continue;
    const dumpWired = await dumpAll(hWired);
    const dumpUnwired = await dumpAll(hUnwired);
    const diffs = diffDumps(dumpWired, dumpUnwired);
    if (diffs.length > 0) {
      chosen = { clId: cand.id, spec, movedCount };
      console.log(`対象CL: id=${cand.id.slice(0, 8)} type=${cand.centerLineType} value=${Math.round(cand.value)} ` +
        `spec=${JSON.stringify(spec)}（下地帯中心の移動${movedCount}件・配線あり／なしで${diffs.length}平面に差分。検出力あり）`);
      break;
    }
  }
  if (chosen) break;
}
ok(chosen != null, 'E3前提: 検出力（配線あり／なしで結果が変わる候補・spec組が少なくとも1本ある）');
if (!chosen) {
  console.log('NG: 検出力なし（どの候補・specを試しても配線あり／なしで結果が変わらない）——ruling必須指示によりNGのまま報告する');
  process.exit(1);
}

// ---- 本編（配線あり）----
const h = buildHarness(src);
await preConverge(h);
const chosenCLKind = centerLineKind(h.project.activeGraph.shapeMap.get(chosen.clId));

const baselineDump = await dumpAll(h);
const backingBeforeMain = wallBackingCenters(h.project.activeGraph);
// E2用: 追従前（現在）の座標にある壁由来梁芯のidを控えておく（追従後は旧座標から消えるため、
// 「同idで新座標へ移った」ことを確認するには適用**前**にidを取得しておく必要がある）。
const oldAxisIdsByCoordKey = new Map(); // "isVertical:coord" -> id
for (const b of backingBeforeMain) {
  const key = `${b.isVertical}:${Math.round(b.coord)}`;
  if (oldAxisIdsByCoordKey.has(key)) continue;
  const ax = findWallBeamAxisCL(h.project.activeGraph, b.isVertical, b.coord);
  if (ax) oldAxisIdsByCoordKey.set(key, ax.id);
}
const beforeUndoTop = undoManager.peekUndo();

const tApplyStart = performance.now();
const { toast: mainToast } = await tryApplyOn(h, chosen.clId, chosen.spec, true);
const tApplyEnd = performance.now();
await h.probeSync.whenIdle();
const tSyncEnd = performance.now();
ok(mainToast === null, `E1: applyCLEccentricityWithUndo(偏芯確定)はtoast:nullで成功する（実際: ${mainToast}）`);
ok(undoManager.peekUndo() !== beforeUndoTop, 'E1: 確定でundoエントリが1件増える');

const afterApplyDump = await dumpAll(h);
const backingAfterMain = wallBackingCenters(h.project.activeGraph);

// ---- E2: 移動元の壁由来梁芯が同idで移動先へ（通り芯は「対象なし」表示。実際はisFinishCellDividerが
// centerのみのため、この候補は必ずcenter種別になる）。複数の下地帯中心が同時に動く候補では、
// 重複ガードでskipされる組（ECC-重複skipのケース）が混ざりうるため、oldAxisIdが取れた
// （＝追従の余地があった）ものの中から最初の1件で確認する（NG判定はその1件だけに対して行う——
// skip自体はここでは対象外・裁定1の範囲）----
if (chosenCLKind !== 'center') {
  console.log('E2(対象なし): 候補が通り芯のため壁由来梁芯の移動id追跡は対象外');
} else {
  const movedEntries = backingAfterMain.filter(a => {
    const b = backingBeforeMain.find(x => x.axisCLId === a.axisCLId && x.isVertical === a.isVertical && x.side === a.side);
    return b && Math.abs(b.coord - a.coord) > 0.5;
  });
  const target = movedEntries
    .map(a => {
      const b = backingBeforeMain.find(x => x.axisCLId === a.axisCLId && x.isVertical === a.isVertical && x.side === a.side);
      const oldAxisId = oldAxisIdsByCoordKey.get(`${b.isVertical}:${Math.round(b.coord)}`);
      return oldAxisId ? { after: a, before: b, oldAxisId } : null;
    })
    .find(Boolean);
  if (!target) {
    console.log('E2(対象なし): 下地帯中心が移動した壁のいずれにも追従対象の壁由来梁芯が無かった');
  } else {
    const axAfter = h.project.activeGraph.shapeMap.get(target.oldAxisId);
    ok(axAfter != null && Math.abs(axAfter.effectiveValue - target.after.coord) < 0.5,
      `E2: 移動元(${Math.round(target.before.coord)})の壁由来梁芯(id=${target.oldAxisId.slice(0, 8)})が同idで移動先(${Math.round(target.after.coord)})へ追従する`);
  }
}

// ---- E3: 3ハーネス比較（本編は既にA=本番。B=listener null。C=追従なしの旧経路）----
// B（listener null）はapplyCLEccentricityWithUndo経由＝undoManager.pushを伴うため、hの確定
// （E1/E4b）とundo/redo（E5/E6）のあいだで呼ぶとundoManagerの（プロセス全体で共有の）スタックへ
// 割り込み、E5のundoManager.undo()がhではなくhBの操作を巻き戻してしまう（実測で踏んだ落とし穴。
// aux移動probeと同型）。B側の比較はhの確定・undo・redo一式が完全に終わったあと（E6の後）で行う。

// A（本編）で旧座標に孤児が0本・新座標に1本（NG判定。根拠はwallBeamSourcesFor）
if (chosenCLKind === 'center') {
  const movedEntry = backingAfterMain.find(a => {
    const b = backingBeforeMain.find(x => x.axisCLId === a.axisCLId && x.isVertical === a.isVertical && x.side === a.side);
    return b && Math.abs(b.coord - a.coord) > 0.5;
  });
  if (movedEntry) {
    const beforeEntry = backingBeforeMain.find(x => x.axisCLId === movedEntry.axisCLId && x.isVertical === movedEntry.isVertical && x.side === movedEntry.side);
    const belowGraphForE3 = await peekBelowGraph(h.project.activeGraph, h.project);
    const sourcesForE3 = wallBeamSourcesFor(h.project.activeGraph, h.project, belowGraphForE3);
    const orphanAtOld = findWallBeamAxisCL(h.project.activeGraph, movedEntry.isVertical, beforeEntry.coord);
    const oldStillHasSource = sourcesForE3.some(s => s.isVertical === movedEntry.isVertical && Math.abs(s.coord - beforeEntry.coord) < 0.5);
    ok(!orphanAtOld || oldStillHasSource, `E3: A(本番)で旧座標(${Math.round(beforeEntry.coord)})に孤児の壁由来梁芯が残っていない`);
    const newAxis = findWallBeamAxisCL(h.project.activeGraph, movedEntry.isVertical, movedEntry.coord);
    ok(newAxis != null, `E3: A(本番)で新座標(${Math.round(movedEntry.coord)})に壁由来梁芯が1本ある`);
  } else {
    console.log('E3(情報): 本編で下地帯中心の移動を検出できず、孤児/新規本数チェックをスキップした');
  }
}

// C（追従なしの旧経路。段階(e)以前の挙動を再現）: applyCLEccentricity直呼び＋構造同期なし。
// 「旧座標の孤児（壁由来梁芯）本数／新座標の作り直し（壁由来梁芯）本数／旧座標の柱本数」を
// 本数で情報出力する（追従の要否の実測根拠。NGにしない。QA指摘m-4: 真偽値ではなく実数で出す）。
function countWallBeamAxesAt(graph, isVertical, coord, tolMm = 0.5) {
  const wantType = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  return graph.centerLines.filter(cl =>
    centerLineKind(cl) === 'beam' &&
    cl.centerLineType === wantType &&
    Math.abs(cl.effectiveValue - coord) < tolMm).length;
}
function countColumnsAt(graph, isVertical, coord, tolMm = 0.5) {
  return graph.columns.filter(c => Math.abs((isVertical ? c.axisX : c.axisY) - coord) < tolMm).length;
}
{
  const hC = buildHarness(src);
  await preConverge(hC);
  hC.activate();
  const clC = hC.project.activeGraph.shapeMap.get(chosen.clId);
  const backingBeforeC = wallBackingCenters(hC.project.activeGraph);
  runInAction(() => {
    hC.project.activeGraph.setCLEccentricity(clC.id, chosen.spec);
    applyCLEccentricity(hC.project.activeGraph, clC.id, { materialMap });
  });
  const backingAfterC = wallBackingCenters(hC.project.activeGraph);
  const movedC = backingAfterC.find(a => {
    const b = backingBeforeC.find(x => x.axisCLId === a.axisCLId && x.isVertical === a.isVertical && x.side === a.side);
    return b && Math.abs(b.coord - a.coord) > 0.5;
  });
  if (!movedC) {
    console.log('E3(C・情報): 旧経路でも下地帯中心の移動を検出できなかった');
  } else {
    const beforeC = backingBeforeC.find(x => x.axisCLId === movedC.axisCLId && x.isVertical === movedC.isVertical && x.side === movedC.side);
    const orphanCountC = countWallBeamAxesAt(hC.project.activeGraph, movedC.isVertical, beforeC.coord);
    const regenCountC = countWallBeamAxesAt(hC.project.activeGraph, movedC.isVertical, movedC.coord);
    const columnsAtOldC = countColumnsAt(hC.project.activeGraph, movedC.isVertical, beforeC.coord);
    console.log(`E3(C・情報。追従の要否の実測根拠): 旧経路（追従なし）では旧座標(${Math.round(beforeC.coord)})の壁由来梁芯=${orphanCountC}本（孤児）` +
      `／新座標(${Math.round(movedC.coord)})の壁由来梁芯=${regenCountC}本（作り直しなし想定）` +
      `／旧座標(${Math.round(beforeC.coord)})の柱=${columnsAtOldC}本`);
  }
}

// ---- E4: 同期再実行で差分ゼロ・同じrecの再適用でも差分ゼロ ----
h.probeSync.request(h.project.activeGraph, h.project, { scope: 'activeAndAbove' });
await h.probeSync.whenIdle();
const dumpAfterSecondSync = await dumpAll(h);
const e4aDiffs = diffDumps(afterApplyDump, dumpAfterSecondSync);
ok(e4aDiffs.length === 0, 'E4a: 適用後もう1回同期しても全階ダンプ差分ゼロ（冪等）');
if (e4aDiffs.length > 0) printDiffs(e4aDiffs);

const { toast: reapplyToast } = await tryApplyOn(h, chosen.clId, chosen.spec, true);
await h.probeSync.whenIdle();
ok(reapplyToast === null, 'E4b前提: 同じrecの再適用もtoast:nullで成功する');
const dumpAfterReapply = await dumpAll(h);
const e4bDiffs = diffDumps(dumpAfterSecondSync, dumpAfterReapply);
ok(e4bDiffs.length === 0, 'E4b: 同じrecの再適用でも全階ダンプ差分ゼロ（冪等）');
if (e4bDiffs.length > 0) printDiffs(e4bDiffs);

// ---- E5: undoで自階の構造・偏芯レコード・梁芯値が基準へ（自階NG判定、他平面情報）----
// E4bで同じrecを再適用しており、それ自体が独立したundoエントリを積んでいる（本番の実際の挙動——
// 「再適用でも差分ゼロ」は before/after のグラフ内容が同じというだけで、undoスタックへの
// pushは1回の確定ごとに必ず起こる）。E1の確定（1回目）まで戻すには、E4bの再適用（2回目）分と
// 合わせて2回undoする必要がある。
undoManager.undo(); // E4bの再適用ぶんを戻す
await h.probeSync.whenIdle();
undoManager.undo(); // E1の確定ぶんを戻す（ここでベースラインに一致するはず）
await h.probeSync.whenIdle();
const dumpAfterUndo = await dumpAll(h);
const activePlaneKey = h.project.activeGraph.plane.name;
const undoDiffsAll = diffDumps(baselineDump, dumpAfterUndo);
const undoDiffsActive = undoDiffsAll.filter(d => d.floor === activePlaneKey);
const undoDiffsOther = undoDiffsAll.filter(d => d.floor !== activePlaneKey);
ok(undoDiffsActive.length === 0, 'E5: undo後のダンプ（自階＝アクティブ平面）が基準と一致する');
ok(h.project.activeGraph.clEccentricities.has(chosen.clId) === false, 'E5: undoで偏芯レコードが基準（未保持）へ戻る');
if (undoDiffsActive.length > 0) printDiffs(undoDiffsActive);
if (undoDiffsOther.length > 0) {
  console.log(`E5(情報・他平面は非NG): 他平面のundo後ダンプと基準の差分 ${undoDiffsOther.length}件` +
    '（他階の孤児梁芯は段階(g)まで許容。既存裁定の範囲）');
  printDiffs(undoDiffsOther);
} else {
  console.log('E5(情報): 他平面のundo後ダンプは基準と差分0件');
}

// ---- E8（Q1裁定・dedupeColumnsByAxis対応と同型）: undo＋同期後、全階で同じAXISに柱が2本以上ある箇所が0 ----
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
ok(dupSpotsAfterUndo === 0, `E8: undo→同期後、全階で同じAXISに柱が2本以上ある箇所が0（実際: ${dupSpotsAfterUndo}件）`);

// ---- E6: redoで全平面が適用直後と一致 ----
// E5と対称に2回redoする（E1の確定→E4bの再適用の順で戻す。E4bで確認済みのとおり内容は
// afterApplyDumpと同じになるはず——再適用は冪等）。
undoManager.redo(); // E1の確定ぶんを戻す
await h.probeSync.whenIdle();
undoManager.redo(); // E4bの再適用ぶんを戻す
await h.probeSync.whenIdle();
const dumpAfterRedo = await dumpAll(h);
const redoDiffs = diffDumps(afterApplyDump, dumpAfterRedo);
ok(redoDiffs.length === 0, 'E6: redo後のダンプ（全平面）が適用直後と一致する');
if (redoDiffs.length > 0) printDiffs(redoDiffs);

setCenterLineStructuralListener(null);

// ---- E3(B): A(本番=afterApplyDump)とB(listener null)の比較。hの確定・undo・redo一式が
// 完全に終わったこのタイミングで行う（undoManager共有スタックへの割り込み回避。上記コメント参照）----
const hB = buildHarness(src);
await preConverge(hB);
const { toast: toastB } = await tryApplyOn(hB, chosen.clId, chosen.spec, false);
ok(toastB === null, 'E3(B)前提: listener null（配線なし）でも確定はtoast:nullで成功する');
const dumpB = await dumpAll(hB);
const abDiffs = diffDumps(afterApplyDump, dumpB);
ok(abDiffs.length > 0, `E3: A(本番)とB(listener null)で結果が異なる（検出力。実際: ${abDiffs.length}平面に差分）`);

// ---- E7（NG判定・案B・2026-09-26）: 適用→解除の往復で孤児梁芯が0本であること。
// 案A（重複ガードでskipして旧を残す）では往復で孤児が残りうる既知の限界があったが、
// 案B（保護されなければ吸収して撤去する一般則）はこの限界を解消する——0本にならなければNG。 ----
{
  const hE7 = buildHarness(src);
  await preConverge(hE7);
  const { toast: applyToastE7 } = await tryApplyOn(hE7, chosen.clId, chosen.spec, true);
  await hE7.probeSync.whenIdle();
  if (applyToastE7 !== null) {
    ok(false, `E7前提: 適用がtoast:nullで成功する（実際: ${applyToastE7}）`);
  } else {
    const backingBeforeUndoE7 = wallBackingCenters(hE7.project.activeGraph);
    const { toast: undoToastE7 } = await tryApplyOn(hE7, chosen.clId, null, true);
    await hE7.probeSync.whenIdle();
    if (undoToastE7 !== null) {
      ok(false, `E7前提: 解除がtoast:nullで成功する（実際: ${undoToastE7}）`);
    } else {
      const backingAfterUndoE7 = wallBackingCenters(hE7.project.activeGraph);
      // QA指摘m-4: 複数の壁（backing）が同じ壁由来梁芯CLを共有しうるため、壁の本数ではなく
      // 孤児となったCL idの集合（ユニーク）で数える——延べ数にしない。
      const orphanIds = new Set();
      for (const b of backingBeforeUndoE7) {
        const a = backingAfterUndoE7.find(x => x.axisCLId === b.axisCLId && x.isVertical === b.isVertical && x.side === b.side);
        if (!a || Math.abs(a.coord - b.coord) < 0.5) continue; // 動いていない側は対象外
        const oldAxis = findWallBeamAxisCL(hE7.project.activeGraph, b.isVertical, b.coord);
        if (oldAxis) orphanIds.add(oldAxis.id);
      }
      ok(orphanIds.size === 0, `E7: 適用→解除の往復で孤児梁芯が0本（案B。実際: ${orphanIds.size}本・ユニークCL id数）`);
    }
  }
}

// ---- 回帰: centerMoveStructuralSyncProbe（tategu-test3で確認）----
console.log('回帰確認: centerMoveStructuralSyncProbe.mjs は別途 `node --import ./scripts/testSetup.mjs scripts/probe/centerMoveStructuralSyncProbe.mjs D:/tatsuya/Download/tategu-test3.stq` で確認する（このprobe内では再実行しない）。');

// ---- 計時: 独立に3回読み込み、確定〜whenIdleの中央値を確定部分・同期部分に分けて出す ----
const applyMs = [], syncMs = [];
for (let i = 0; i < 3; i++) {
  const hp = buildHarness(src);
  await preConverge(hp);
  const t0 = performance.now();
  await tryApplyOn(hp, chosen.clId, chosen.spec, true);
  const t1 = performance.now();
  await hp.probeSync.whenIdle();
  const t2 = performance.now();
  applyMs.push(t1 - t0);
  syncMs.push(t2 - t1);
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
console.log(`性能: 確定部分(applyCLEccentricityWithUndo呼び出し)中央値=${median(applyMs).toFixed(1)}ms ` +
  `[${applyMs.map(v => v.toFixed(1)).join(', ')}] / 同期部分(whenIdle)中央値=${median(syncMs).toFixed(1)}ms ` +
  `[${syncMs.map(v => v.toFixed(1)).join(', ')}]`);
console.log(`性能(参考): 確定の実測(本編) = ${(tApplyEnd - tApplyStart).toFixed(1)}ms / 同期 = ${(tSyncEnd - tApplyEnd).toFixed(1)}ms`);

if (ngCount === 0) {
  console.log(`OK: clEccStructuralSyncProbe 全項目パス（${src}）`);
} else {
  console.log(`NG: ${ngCount}件の不一致（${src}）`);
  process.exitCode = 1;
}
