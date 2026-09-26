// 補助線（aux）の移動・削除→構造同期（段階(d)・2026-09-25。core/centerLineKindPolicy.js
// structuralSyncScopeForCenterLine・transform/centerLineOps.js commitCLMoveOp/deleteCenterLineWithUndo）
// の実データ確認用probe。ハーネスは centerMoveStructuralSyncProbe.mjs / gridDeleteStructuralSyncProbe.mjs
// の写し（本番同型peek・probeSync）。起動口は本番と同じ commitCLMoveOp / deleteCenterLineWithUndo だけ。
//
// 【重要・前提】実データ（tategu-test3.stq・moku4.stq）には「中心線が参照する補助線」が無い
// （両ファイルとも aux CL 自体が0本）。段階(d)裁定の指示どおり、probe内でメモリ上に合成する:
//   1. 補助線 aux を1本追加する（既存の座標と衝突しない自由な位置）。
//   2. 【extentLoRef retrofit・check(1)用】aux と直交する向きの既存「center種別」CL（あれば実在の
//      ものを再利用、無ければ新規に1本追加）へ aux を extentLoRef で付け替える——offsetは現在の
//      extentLo値を保つよう逆算するため、付け替え直後の数値は変化しない（再計算に無関係な導入時の
//      副作用ゼロを別途確認する）。
//   3. 【refId retrofit・check(2)用】aux と同じ向きの、実在する壁の軸CL（center種別）へ aux への
//      refId を付け替える——refOffsetは現在値を保つよう逆算する（導入時は無変化）。
// この2つの付け替えにより、aux の移動は (1) extentLoRef を持つCLのextentLo/Hiの追従と、
// (2) refIdでaux位置に追従する実壁の軸移動→壁交点柱の変化、の両方を同時に起こす——
// structuralSyncScopeForCenterLine は extentLoRef/extentHiRef・refId のいずれも同じ「参照」として
// 扱う（core/planGraph.js referencingCenterLines）ため、単一の aux で両方の効果を確認できる。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/auxMoveStructuralSyncProbe.mjs [入力.stq]
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { PlanGraph, CenterLineType, Discipline, centerLineKind } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { undoManager } from '../../src/undoManager.js';
import { commitCLMoveOp, deleteCenterLineWithUndo, setCenterLineStructuralListener } from '../../src/transform/centerLineOps.js';
import { createStructuralSync } from '../../src/structural/structuralSync.js';
import { recomputeForStructuralSync } from '../../src/structural/structuralOrchestration.js';
import { createStructuralResolveContext } from '../../src/structural/structuralResolveContext.js';
import { floorBytesEqual } from '../../src/floorOps.js';
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

  // 段階(g)・2026-09-26: recの有無でsaveを差し替える（design-g.md「ハーネス」の型どおり）。
  const probeSync = createStructuralSync({
    recompute: (p, s, rec) => {
      const ctx = createStructuralResolveContext({ peek: bytePeek, save: rec ? rec.wrapSave(storeSave) : storeSave });
      return recomputeForStructuralSync(p, s, ctx).finally(() => ctx.dispose());
    },
    loadFloorBytes: (id) => store.get(id) ?? null,
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

const hProbe = buildHarness(src);
hProbe.activate();
console.log(`主構造: ${hProbe.project.structuralInfo.mainStructure} plane: ${hProbe.project.activeGraph.plane.name}`);

// QA指摘m-2（2026-09-26）: 中心線・補助線に反応しない主構造（S造。columnPlacement:'gridIntersections'
// のため、refId retrofitで壁の軸CLをauxへ追従させても壁交点柱は生まれない——centerMove/clEcc
// StructuralSyncProbe.mjsと同じ判定）は「対象外」表示でexit 0にする——検出力ゼロの状態でcheck(2)を
// NG扱いにしていた誤りを修正する（S造データでは原理的に検出できない。実データの性質であり不具合ではない）。
const activeRulesForGuard = rulesFor(effectiveStructure(hProbe.project.activeGraph, hProbe.project));
if (activeRulesForGuard.wallBeamAxes == null && activeRulesForGuard.columnPlacement !== 'wallIntersections') {
  console.log(`対象外（中心線・補助線に反応しない主構造: ${hProbe.project.structuralInfo.mainStructure}。` +
    `wallBeamAxes=${activeRulesForGuard.wallBeamAxes} columnPlacement=${activeRulesForGuard.columnPlacement}）`);
  process.exit(0);
}

// ---- 合成セットアップ（前提を出力に明記。ヘッダコメント参照）----
function farFreeCoord(graph, type) {
  const values = graph.centerLines.filter(c => c.centerLineType === type).map(c => c.effectiveValue);
  const maxV = values.length ? Math.max(...values) : 0;
  return Math.round((maxV + 3000) / 5) * 5; // 実在座標から離れた自由な座標
}

// aux と直交する向きの既存「center種別」CLを1本選ぶ（extentLoRef retrofit用）。無ければ新規追加する。
function pickOrCreateExtentVictim(graph, auxType) {
  const crossType = auxType === CenterLineType.VERTICAL ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const existing = graph.centerLines.find(c => c.centerLineType === crossType && centerLineKind(c) === 'center');
  if (existing) return { cl: existing, synthetic: false };
  const created = graph.addCenterLine(crossType, farFreeCoord(graph, crossType), { labeled: false, discipline: Discipline.ARCH });
  return { cl: created, synthetic: true };
}

// aux と同じ向きの、実在する壁の軸CL（center種別）を1本選ぶ（refId retrofit用）。
function pickWallAxisVictim(graph, auxType) {
  return graph.walls.find(w => w.axisCL.centerLineType === auxType && centerLineKind(w.axisCL) === 'center')?.axisCL ?? null;
}

// auxType を決める: refId retrofit対象（同じ向きの壁の軸CL）が見つかる向きを優先する。
let auxType = CenterLineType.HORIZONTAL;
let wallAxisVictim = pickWallAxisVictim(hProbe.project.activeGraph, auxType);
if (!wallAxisVictim) {
  auxType = CenterLineType.VERTICAL;
  wallAxisVictim = pickWallAxisVictim(hProbe.project.activeGraph, auxType);
}
if (!wallAxisVictim) {
  console.log('NG: refId retrofit対象（center種別の壁の軸CL）がどちらの向きにも無い');
  process.exit(1);
}
const { cl: extentVictimTemplate } = pickOrCreateExtentVictim(hProbe.project.activeGraph, auxType);

// QA指摘m-2（2026-09-26）: なぜメモリ上に合成するのかを実行時出力に1行明記する（ヘッダコメントは
// ソースを読まないと見えないため、実行結果だけを見る読者にも前提が伝わるようにする）。
const existingAuxWithRef = hProbe.project.activeGraph.centerLines.filter(c =>
  c.lineType === 'dashed' && hProbe.project.activeGraph.referencingCenterLines(c.id).length > 0);
if (existingAuxWithRef.length === 0) {
  console.log('前提: 実データに「参照されている補助線」が無いため（このデータのaux本数=' +
    `${hProbe.project.activeGraph.centerLines.filter(c => c.lineType === 'dashed').length}）、` +
    'probe内でメモリ上に合成する（下記の合成セットアップ参照）。');
} else {
  console.log(`前提: 実データに既に「参照されている補助線」が${existingAuxWithRef.length}本あるが、` +
    '再現性のため今回もprobe内でメモリ上に合成した状態を使う（下記の合成セットアップ参照）。');
}
console.log(`合成セットアップ: aux種別=${auxType} / refId victim(壁の軸)=${wallAxisVictim.id.slice(0, 8)} ` +
  `/ extentLoRef victim=${extentVictimTemplate.id.slice(0, 8)}${extentVictimTemplate ? '' : ''}`);

// 実際に1つのharnessへ合成セットアップを適用する（wired/unwired双方で同一手順を再現するため関数化）。
function applySynthesis(h) {
  h.activate();
  const g = h.project.activeGraph;
  const aux = g.addCenterLine(auxType, farFreeCoord(g, auxType), { labeled: false, lineType: 'dashed' });
  const wallAxis = g.shapeMap.get(wallAxisVictim.id);
  const { cl: extentVictim, synthetic } = pickOrCreateExtentVictim(g, auxType);
  runInAction(() => {
    // refId retrofit（refOffsetは現在値を保つよう逆算——付け替え直後は無変化）。
    // wallAxisIdの実CLは実データ上すでに別CLへrefId済み（はね出し追従の子）のことがある——
    // g.resolveCenterLineRefs()は「未解決（_referencedCLがnull）」のときしか再解決しないため、
    // 付け替え（既存refIdの上書き）では効かない。_referencedCLを直接張り替える（実測で確認した
    // 落とし穴。builder作業ログ参照）。
    wallAxis.refOffset = wallAxis.value - aux.value;
    wallAxis.refId = aux.id;
    wallAxis._referencedCL = aux;
    // extentLoRef retrofit（offsetは現在のextentLoを保つよう逆算。extentLoがnull=全幅扱いのCLは
    // 対象から除く——縮めることになるため。新規追加したCLはextentLo=null=フリー端点なので、
    // offset=0で新しい参照だけを張る）。
    const currentLo = extentVictim.extentLo;
    const offset = currentLo != null ? currentLo - aux.value : 0;
    g.setCenterLineExtentRef(extentVictim, 'lo', { clId: aux.id, offset });
  });
  return { auxId: aux.id, wallAxisId: wallAxis.id, extentVictimId: extentVictim.id, extentVictimSynthetic: synthetic };
}

// ================================================================
// M1: 合成セットアップ自体は幾何・構造フィールドを変えない（offsetは現在値を保つよう逆算している）
// ================================================================
const hA = buildHarness(src);
await preConverge(hA);
const dumpBeforeSynthesis = await dumpAll(hA);
const idsA = applySynthesis(hA);
const dumpAfterSynthesis = await dumpAll(hA);
const synthesisDiffs = diffDumps(dumpBeforeSynthesis, dumpAfterSynthesis);
ok(synthesisDiffs.length === 0, 'M1: 合成セットアップ（refId/extentLoRefの付け替え）自体は柱・梁・基礎・壁本数を変えない（offset逆算で無変化のはず）');
if (synthesisDiffs.length > 0) printDiffs(synthesisDiffs);

// ================================================================
// check(1): 参照元CL（extentVictim）のextentLoがauxの移動に追従する
// ================================================================
const moveAmount = 300;
{
  const aux = hA.project.activeGraph.shapeMap.get(idsA.auxId);
  const extentVictim = hA.project.activeGraph.shapeMap.get(idsA.extentVictimId);
  const extentLoBefore = extentVictim.extentLo;
  const originalValue = aux.value;
  setCenterLineStructuralListener((g, p, scope, undoRecords) => hA.probeSync.request(g, p, { scope, undoRecords }));
  runInAction(() => { aux.pendingDelta = moveAmount; });
  const { toast } = commitCLMoveOp(hA.project.activeGraph, hA.project, aux, originalValue, { saveFloorFn: hA.storeSave });
  await hA.probeSync.whenIdle();
  ok(toast === null, `check(1)前提: commitCLMoveOp(aux移動)はtoast:nullで成功する（実際: ${toast}）`);
  const extentLoAfter = extentVictim.extentLo;
  ok(Math.abs((extentLoAfter - extentLoBefore) - moveAmount) < 0.5,
    `check(1): 参照元CLのextentLoがaux移動分(${moveAmount})だけ追従する（前: ${extentLoBefore}, 後: ${extentLoAfter}）`);
  setCenterLineStructuralListener(null);
  undoManager.undo(); // 後続チェックのため一旦戻す（このhAはM2以降で作り直す）
}

// ================================================================
// check(2): 配線あり／なしで壁交点柱（在来木造）が変わる（検出力）。差が無ければNG（対象外にしない）
// ================================================================
const hWired = buildHarness(src);
const hUnwired = buildHarness(src);
await preConverge(hWired);
await preConverge(hUnwired);
const idsWired = applySynthesis(hWired);
const idsUnwired = applySynthesis(hUnwired);
const dumpBaselineWired = await dumpAll(hWired); // 移動前（合成セットアップ直後）。check(4)のundo基準に使う

// captureBox（段階(g)）: コミット時のnotifyだけに渡る第4引数(undoRecords＝箱)を呼び出し元へ渡す。
function moveAux(h, auxId, amount, wired, { captureBox } = {}) {
  if (wired) {
    setCenterLineStructuralListener((g, p, scope, undoRecords) => {
      if (captureBox) captureBox(undoRecords);
      h.probeSync.request(g, p, { scope, undoRecords });
    });
  } else setCenterLineStructuralListener(null);
  h.activate();
  const aux = h.project.activeGraph.shapeMap.get(auxId);
  const originalValue = aux.value;
  runInAction(() => { aux.pendingDelta = amount; });
  const { toast } = commitCLMoveOp(h.project.activeGraph, h.project, aux, originalValue, { saveFloorFn: h.storeSave });
  setCenterLineStructuralListener(null);
  return { toast, originalValue };
}

const { toast: toastWired } = moveAux(hWired, idsWired.auxId, moveAmount, true);
await hWired.probeSync.whenIdle();
const { toast: toastUnwired } = moveAux(hUnwired, idsUnwired.auxId, moveAmount, false);
ok(toastWired === null && toastUnwired === null, `check(2)前提: 配線あり／なしとも移動確定はtoast:nullで成功する（実際: wired=${toastWired}, unwired=${toastUnwired}）`);

const dumpWired = await dumpAll(hWired);
const dumpUnwired = await dumpAll(hUnwired);
const detectionDiffs = diffDumps(dumpWired, dumpUnwired);
// 段階(d)裁定: 差が出ない場合は「対象外」ではなくNG（既存probeの「主構造が反応しないので対象外」
// パターンをここでは使わない——このprobeの対象種別・データは在来木造の壁交点柱方式のため反応するはず）。
ok(detectionDiffs.length > 0, `check(2): 配線あり／なしで柱・梁・基礎に差がある（検出力。実際: ${detectionDiffs.length}平面に差分）`);
if (detectionDiffs.length === 0) {
  console.log('  NG詳細: refId retrofit（壁の軸CL）経由でも壁交点柱に差が生じなかった——合成セットアップの前提（実壁の軸が' +
    'auxに追従すれば交点柱の位置も変わるはず）が崩れている可能性がある。builderへ報告する設計相違として扱う。');
} else {
  printDiffs(detectionDiffs);
}

// ================================================================
// check(3): 冪等性（移動後もう1回 'activeAndAbove' を回しても差分ゼロ）
// ================================================================
hWired.probeSync.request(hWired.project.activeGraph, hWired.project, { scope: 'activeAndAbove' });
await hWired.probeSync.whenIdle();
const dumpAfterSecondRun = await dumpAll(hWired);
const idempotentDiffs = diffDumps(dumpWired, dumpAfterSecondRun);
ok(idempotentDiffs.length === 0, 'check(3): 移動後もう1回同期しても全階ダンプ差分ゼロ（冪等）');
if (idempotentDiffs.length > 0) printDiffs(idempotentDiffs);

// ================================================================
// check(4): undoで自階が基準と一致する（他平面は情報。centerMoveStructuralSyncProbe.mjsのM7と同じ規律）
// ================================================================
// undoManagerはプロセス全体で共有のシングルトンのため、check(2)のhWired/hUnwired（それぞれ1件ずつ
// commitCLMoveOpのundoをpushする）と同じ空間で操作すると、undoManager.undo()がスタック最上段
// （直近にpushされた方＝hUnwired側）を巻き戻してしまい、hWiredに対するundoにならない
// （実測で踏んだ落とし穴）。check(4)は専用の新規harnessでpush→undo→redoを他の操作を挟まず
// 閉じた手順として行う——「合成セットアップ→移動（push）→undo→redo」の間に他harnessの
// commitCLMoveOp/deleteCenterLineWithUndoを一切呼ばない。
const hUndo = buildHarness(src);
await preConverge(hUndo);
const idsUndo = applySynthesis(hUndo);
const dumpBaselineUndo = await dumpAll(hUndo);
let boxAfterAuxMove = null;
setCenterLineStructuralListener((g, p, scope, undoRecords) => {
  boxAfterAuxMove = undoRecords ?? boxAfterAuxMove;
  hUndo.probeSync.request(g, p, { scope, undoRecords });
});
const storeBeforeAuxMove = new Map(hUndo.store);
{
  hUndo.activate();
  const aux = hUndo.project.activeGraph.shapeMap.get(idsUndo.auxId);
  const originalValue = aux.value;
  runInAction(() => { aux.pendingDelta = moveAmount; });
  const { toast } = commitCLMoveOp(hUndo.project.activeGraph, hUndo.project, aux, originalValue, { saveFloorFn: hUndo.storeSave });
  await hUndo.probeSync.whenIdle();
  ok(toast === null, `check(4)前提: commitCLMoveOp(aux移動)はtoast:nullで成功する（実際: ${toast}）`);
}
const dumpAfterMoveUndo = await dumpAll(hUndo);

// ---- G1/G2（段階(g)）: 箱は実際にIDBへ保存された他平面だけを指し、各planeIdの最後のレコードの
// afterがstoreの現在値と一致する ----
const changedOtherPlaneIds = new Set(
  [...hUndo.project.planeMap.values()]
    .filter(p => p.id !== hUndo.project.activePlaneId)
    .map(p => p.id)
    .filter(id => !floorBytesEqual(storeBeforeAuxMove.get(id), hUndo.store.get(id))),
);
const boxPlaneIds = new Set((boxAfterAuxMove ?? []).map(r => r.planeId));
ok(Array.isArray(boxAfterAuxMove), 'G1: コミット時notifyの第4引数(箱)は配列のはず');
ok([...boxPlaneIds].every(id => changedOtherPlaneIds.has(id)), 'G1: 箱に含まれるplaneIdはすべて実際にIDBへ保存された他平面のはず');
ok([...changedOtherPlaneIds].every(id => boxPlaneIds.has(id)), 'G1: 実際にIDBへ保存された他平面はすべて箱に含まれる（取りこぼしが無い）');
const lastRecByPlane = new Map();
for (const rec of boxAfterAuxMove ?? []) lastRecByPlane.set(rec.planeId, rec);
let g2ok = true;
for (const [planeId, rec] of lastRecByPlane) {
  const current = hUndo.store.get(planeId);
  if (!floorBytesEqual(rec.after, current)) { g2ok = false; console.log(`  NG詳細: 箱[${planeId.slice(0, 8)}]の最後のafterがstoreの現在値と不一致`); }
}
ok(g2ok, 'G2: 箱の各planeIdについて最後のレコードのafterがstoreの現在値と一致する');
const retainedBytesAuxMove = (boxAfterAuxMove ?? []).reduce((sum, rec) => sum + (rec.before?.length ?? 0) + (rec.after?.length ?? 0), 0);
console.log(`保持バイト数: 箱の総容量=${retainedBytesAuxMove}バイト（${boxAfterAuxMove?.length ?? 0}件）`);

undoManager.undo();
await hUndo.probeSync.whenIdle();
const dumpAfterUndo = await dumpAll(hUndo);
// 段階(g)でcheck(4)は全平面厳密判定へ昇格した（commitCLMoveOpの箱がapplyFloorUndoRecordsで他平面の
// IDBバイトを移動前へ戻すため。旧「他平面は非NG」扱いは廃止）。
const undoDiffsAll = diffDumps(dumpBaselineUndo, dumpAfterUndo);
ok(undoDiffsAll.length === 0, 'check(4)/G3: undo後のダンプ（全平面）が合成セットアップ直後の基準と一致する（全平面厳密。段階(g)）');
if (undoDiffsAll.length > 0) printDiffs(undoDiffsAll);

undoManager.redo();
await hUndo.probeSync.whenIdle();
const dumpAfterRedo = await dumpAll(hUndo);
const redoDiffs = diffDumps(dumpAfterMoveUndo, dumpAfterRedo);
ok(redoDiffs.length === 0, 'check(4)続き/G4: redo後のダンプ（全平面）が移動直後と一致する');
if (redoDiffs.length > 0) printDiffs(redoDiffs);
setCenterLineStructuralListener(null);

// ---- G5（段階(g)）: 検出力の対照。undoRecordsを一切forwardしない箱無効ハーネスで同じ移動→undoを
// 行い、他平面に差分が残ることを確認する（0件なら検出力なしと明記してNGにしない）----
const hNoBox = buildHarness(src);
await preConverge(hNoBox);
const idsNoBox = applySynthesis(hNoBox);
const baselineDumpNoBox = await dumpAll(hNoBox);
setCenterLineStructuralListener((g, p, scope) => hNoBox.probeSync.request(g, p, { scope })); // undoRecords無し
hNoBox.activate();
const auxG5 = hNoBox.project.activeGraph.shapeMap.get(idsNoBox.auxId);
const origG5 = auxG5.value;
runInAction(() => { auxG5.pendingDelta = moveAmount; });
const { toast: g5Toast } = commitCLMoveOp(hNoBox.project.activeGraph, hNoBox.project, auxG5, origG5, { saveFloorFn: hNoBox.storeSave });
await hNoBox.probeSync.whenIdle();
if (g5Toast !== null) {
  console.log(`G5: 検出力の対照をスキップ（移動拒否。実際のtoast=${g5Toast}）`);
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

// ================================================================
// check(5): 参照が無い補助線の移動は構造同期リスナーを呼ばない（0回。requestの呼出し回数で確認）
// ================================================================
{
  const hNoRef = buildHarness(src);
  await preConverge(hNoRef);
  hNoRef.activate();
  const freeAux = hNoRef.project.activeGraph.addCenterLine(
    auxType, farFreeCoord(hNoRef.project.activeGraph, auxType), { labeled: false, lineType: 'dashed' });
  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  runInAction(() => { freeAux.pendingDelta = moveAmount; });
  const { toast } = commitCLMoveOp(hNoRef.project.activeGraph, hNoRef.project, freeAux, freeAux.value);
  setCenterLineStructuralListener(null);
  ok(toast === null, 'check(5)前提: 参照の無い補助線の移動もtoast:nullで成功する');
  ok(calls === 0, `check(5): 参照の無い補助線の移動は構造同期リスナーを呼ばない（実際の呼出し回数: ${calls}）`);
}

// ================================================================
// check(6): 削除の同型バッテリ（参照あり→'activeAndAbove'で呼ばれる／参照なし→0回）
// ================================================================
{
  const hDelRef = buildHarness(src);
  await preConverge(hDelRef);
  const idsDelRef = applySynthesis(hDelRef);
  const dumpBeforeDelete = await dumpAll(hDelRef);
  const scopes = [];
  setCenterLineStructuralListener((g, p, scope, undoRecords) => { scopes.push(scope); hDelRef.probeSync.request(g, p, { scope, undoRecords }); });
  hDelRef.activate();
  const auxToDelete = hDelRef.project.activeGraph.shapeMap.get(idsDelRef.auxId);
  const { toast: delToast } = await deleteCenterLineWithUndo(hDelRef.project.activeGraph, hDelRef.project, auxToDelete, { saveFloorFn: hDelRef.storeSave });
  await hDelRef.probeSync.whenIdle();
  ok(delToast === null, `check(6)前提: 参照ありの補助線の削除はtoast:nullで成功する（実際: ${delToast}）`);
  ok(scopes.length === 1 && scopes[0] === 'activeAndAbove',
    `check(6): 参照ありの補助線の削除は構造同期リスナーを(scope="activeAndAbove")で1回呼ぶ（実際: ${JSON.stringify(scopes)}）`);
  undoManager.undo();
  await hDelRef.probeSync.whenIdle();
  const dumpAfterDeleteUndo = await dumpAll(hDelRef);
  // 段階(g)で全平面厳密判定へ昇格（deleteCenterLineWithUndoの箱が他平面のIDBバイトを削除前へ戻すため）。
  const delUndoDiffsAll = diffDumps(dumpBeforeDelete, dumpAfterDeleteUndo);
  ok(delUndoDiffsAll.length === 0, 'check(6)続き/G3: 削除undo後のダンプ（全平面）が削除前の基準と一致する（全平面厳密。段階(g)）');
  if (delUndoDiffsAll.length > 0) printDiffs(delUndoDiffsAll);
  setCenterLineStructuralListener(null);

  const hDelNoRef = buildHarness(src);
  await preConverge(hDelNoRef);
  hDelNoRef.activate();
  const freeAuxForDelete = hDelNoRef.project.activeGraph.addCenterLine(
    auxType, farFreeCoord(hDelNoRef.project.activeGraph, auxType), { labeled: false, lineType: 'dashed' });
  let delCalls = 0;
  setCenterLineStructuralListener(() => { delCalls++; });
  const { toast: delToastNoRef } = await deleteCenterLineWithUndo(hDelNoRef.project.activeGraph, hDelNoRef.project, freeAuxForDelete);
  setCenterLineStructuralListener(null);
  ok(delToastNoRef === null, 'check(6)前提: 参照の無い補助線の削除もtoast:nullで成功する');
  ok(delCalls === 0, `check(6): 参照の無い補助線の削除は構造同期リスナーを呼ばない（実際の呼出し回数: ${delCalls}）`);
}

if (ngCount === 0) {
  console.log(`OK: auxMoveStructuralSyncProbe 全項目パス（${src}）`);
} else {
  console.log(`NG: ${ngCount}件の不一致（${src}）`);
  process.exitCode = 1;
}
