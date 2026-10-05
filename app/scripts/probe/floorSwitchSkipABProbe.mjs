// 「仕上げの階切替で、無編集の階の脱出を丸ごと省く」配線（finish/finishExitStamp.js ＋ finishBoundary.js の stamps）の
// 実データ A/B 比較 probe（調査用。製品コードから参照しない。.mjs のため `npm run lint` の対象外）。
//
// 同じ文書・同じ巡回を、
//   B（印なし）: 脱出境界へ stamps を渡さない（従来どおり毎回全部行う）
//   A（印あり）: 脱出境界へ本物の createFinishExitStamps({ loadFloorFn: loadFloor, generationOf: floorWriteGeneration })
//                を渡す（App.jsx finish.exit の floorSwitch 配線と同じ）
// の2通りで、それぞれ文書を読み直した別々の状態から走らせ、最終状態を比べる。
//
// 使い方（app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/floorSwitchSkipABProbe.mjs [入力.stq ...] [--laps=N] [--edit=none|finish|ecc|struct|otherfloor|catalog|catalogthick] [--quiet]
//   既定の入力: D:/tatsuya/Download/moku4.stq。--laps は巡回の往復回数（階 0→…→最上→…→0 を1往復）。
//   --edit は 3 周目の最初の遷移の脱出の直前に1種類だけ入れる（A・B 両方に同じ編集。--laps は 3 以上で使う）。
//     finish   : 自階の最初の部屋の床材を変える（壁の結果は変わらない編集。A/B の差は出にくい）
//     backing  : 自階の内壁下地材コードを変える（在来木造は突入境界の conformWoodBacking が戻すため、結果へは残らない）
//     ecc      : 自階の内壁（INTERIOR_WALL エッジ）のある中心線へ CL 偏芯（面合わせ）の指定を足す
//     struct   : 通り芯（structGraph）の最初の1本を +50mm 動かす
//     otherfloor: 最後の遷移の脱出の直前に、自階・遷移先以外の階（3階建て以上）を peek して天井高・部屋の床材・壁の鮮度キー（古い値）を変え、直列化して saveFloor（世代が進む）
//     catalog  : カタログ世代だけ進める（clearOverlays。壁の結果は変わらない）
//     catalogthick: 内壁下地材の材料の厚み（x・y）を変える文書同梱 overlay を立てる（壁の結果が変わる入力。立てられなければその旨を出す）
//
// 【通している関数列（実アプリの階切替 App.jsx switchFloorKeepingMode と同じ）】
//   structuralSync.whenIdle → 脱出境界（runFinishExitBoundary。modeRef.current＝実物の FinishModeState。A は stamps つき）
//   → swap（FloorSwapManager.swap。whenCenterLineOpsIdle → runBusy('階切替')）→ 突入境界（runFinishEntryBoundary。本番と同じ
//   { loadFloorFn: loadFloor }）→ 旧 FinishModeState を dispose → new FinishModeState(graph, project) → init。
// 【省いた段】finishExitQuiescenceProbe.mjs と同じ（store.js・App.jsx の React state・上階階段などの3つの peek effect・
//   beginUiTransition）。読込み境界（bootReady の refreshWallsAllFloors）は通していない。文書同梱カタログ（overlay）は
//   --edit=catalogthick 以外では立てていない（カタログを持つ文書の数字は参考扱い）。
// 【比べるもの】全平面（planeMap）の最終バイト列を canonicalizeFloorBytes（壁 id を位置で振り直す＝並び順まで見る）→ decode →
//   UUID を # に潰した JSON（乱数 id の差を無視。値・並び・参照関係は見る）で比べる。アクティブ階だけ
//   serializeGraphCanonicalWalls（壁を内容順に並べ替えて比べる緩い比較）でも見て、並び順だけの差かを切り分ける。
//   部材採番 index・通り芯・平面一覧・undo 数。undo を全部戻したあとの自階の正規形も比べる。
// 【数字の読み方】省いた回数は階切替の脱出区間の判定結果（canSkip の reason の件数）。ms は脱出境界呼び出しの前後
//   （A は判定込み）を performance.now() で測った、最後の1往復だけの中央値。Node・fake IDB での値で比率として読む。
import { performance } from 'node:perf_hooks';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadFloor, saveFloor } from '../../src/storage/db.js';
import { floorWriteGeneration } from '../../src/storage/floorWriteGeneration.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { createFinishExitStamps, memberNumberIndexSignature } from '../../src/finish/finishExitStamp.js';
import { FinishModeState } from '../../src/modes/FinishModeState.js';
import { structuralSync } from '../../src/structural/structuralSync.js';
import { whenCenterLineOpsIdle } from '../../src/transform/centerLineOps.js';
import { runBusy } from '../../src/uiBusy.js';
import {
  serializeGraph, serializeGraphCanonicalWalls, canonicalizeFloorBytes, decodeFloorSnapshot, serializeStructCLs, serializePlanes,
} from '../../src/graphSnapshot.js';
import { floorBytesEqual } from '../../src/floorOps.js';
import { undoManager } from '../../src/undoManager.js';
import { isGridCenterLine, CenterLineType, Discipline } from '../../src/core.js';
import { clearOverlays, setOverlay } from '../../src/catalog/catalogRegistry.js';
import { CatalogKind } from '../../src/catalog/catalogKinds.js';
import { clearDocumentAliases } from '../../src/catalog/codeNormalization.js';

// ---- 引数 ----
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const files = args.filter(a => !a.startsWith('--'));
const flagValue = (name, dflt) => {
  const f = flags.find(x => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!f) return dflt;
  return f.includes('=') ? f.slice(f.indexOf('=') + 1) : true;
};
const LAPS = Number(flagValue('laps', 3));
const EDIT = flagValue('edit', 'none');
const QUIET = flagValue('quiet', false) === true;
if (!['none', 'finish', 'backing', 'ecc', 'struct', 'otherfloor', 'catalog', 'catalogthick'].includes(EDIT)) {
  console.error('--edit は none|finish|backing|ecc|struct|otherfloor|catalog|catalogthick');
  process.exit(2);
}
if (files.length === 0) files.push('D:/tatsuya/Download/moku4.stq');

// ---- fake IndexedDB（メモリ。floors の put/get/delete のみ） ----
function installFakeIndexedDB() {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor(name) { this.name = name; this.data = new Map(); }
    put(value) { const r = new FakeRequest(); this.data.set(value.planeId ?? value.projectId, value); queueMicrotask(() => r.onsuccess?.({ target: { result: undefined } })); return r; }
    get(key) { const r = new FakeRequest(); queueMicrotask(() => r.onsuccess?.({ target: { result: this.data.get(key) } })); return r; }
    delete(key) { const r = new FakeRequest(); this.data.delete(key); queueMicrotask(() => r.onsuccess?.({ target: { result: undefined } })); return r; }
  }
  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
      for (const name of ['floors', 'projects', 'savedFloors']) this.stores.set(name, new FakeStore(name));
    }
    transaction(name) { const store = this.stores.get(name); return { objectStore: () => store }; }
  }
  const fakeDb = new FakeDB();
  globalThis.indexedDB = { open() { const r = new FakeRequest(); queueMicrotask(() => r.onsuccess?.({ target: { result: fakeDb } })); return r; } };
  return fakeDb;
}
const fakeDb = installFakeIndexedDB();

// ---- 比較の部品 ----
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const maskIds = (s) => s.replace(UUID_RE, '#');
const big = (k, v) => (typeof v === 'bigint' ? String(v) : v);
// 階のバイト列 → 比較用の文字列（壁 id は位置で振り直し、残りの乱数 id は # に潰す）
function floorForm(bytes) {
  if (bytes == null) return 'null';
  const c = canonicalizeFloorBytes(bytes);
  if (c === null) return `string:${String(bytes).length}`;
  if (c.length === 0) return 'empty';
  return maskIds(JSON.stringify(decode(c), big));
}
const decode = (bytes) => decodeFloorSnapshot(bytes);
// graph の serializeGraphCanonicalWalls（壁を内容順に並べ替える緩い比較）
const looseForm = (graph) => maskIds(JSON.stringify(decode(serializeGraphCanonicalWalls(graph)), big));
// 部材採番 index: エントリごとの署名を UUID 潰しのうえ並べ替えて比べる（乱数 id による並びの差を無視）
function indexForm(index) {
  return [...index.entries()].map(([k, v]) => maskIds(memberNumberIndexSignature(new Map([[k, v]])))).sort().join('|');
}
const median = (a) => { if (a.length === 0) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---- 1通りの巡回 ----
async function runOne(file, useStamps) {
  clearOverlays();
  clearDocumentAliases();
  undoManager._undoStack.splice(0);
  undoManager._redoStack.splice(0);
  const { project } = loadDocument(file);
  const tour = project.planes.filter(p => !p.isRoofPlane && !p.isAlternative);
  const allPlanes = [...project.planeMap.values()];
  if (tour.length < 2) return null;

  const floorsStore = fakeDb.stores.get('floors');
  floorsStore.data.clear();
  for (const p of allPlanes) {
    const g = project.graphMap.get(p.id);
    if (g) floorsStore.data.set(p.id, { planeId: p.id, bytes: serializeGraph(g) });
  }
  runInAction(() => { project.activePlaneId = tour[0].id; });
  for (const p of allPlanes) project.graphMap.get(p.id)?.clearFloorData();
  await floorSwapManager.activate(tour[0], project.graphMap.get(tour[0].id));

  // 印の保管庫（A のみ）。canSkip の判定結果（理由）を記録するため呼び出しを包む。
  const real = useStamps ? createFinishExitStamps({ loadFloorFn: loadFloor, generationOf: floorWriteGeneration }) : null;
  const rec = { last: null };
  const stamps = real
    ? { ...real, canSkip: async (g, p) => { const r = await real.canSkip(g, p); rec.last = r; return r; } }
    : null;

  const loadFinishState = async (graph, prev) => {
    prev?.dispose();
    const s = new FinishModeState(graph, project);
    await s.init();
    return s;
  };
  let graph = project.activeGraph;
  await runFinishEntryBoundary(graph, project, { loadFloorFn: loadFloor });
  let fmode = await loadFinishState(graph, null);

  const order = [];
  for (let l = 0; l < LAPS; l++) {
    for (let i = 1; i < tour.length; i++) order.push(i);
    for (let i = tour.length - 2; i >= 0; i--) order.push(i);
  }
  // 編集は3周目の最初の遷移の脱出の直前（その階に印がある状態で編集を入れるため。2周目だと印がまだ付いていない階がある）
  // otherfloor だけは最後の遷移（差し替えた階がその後に訪れられない＝その階自身の脱出が結果を直さない状態にする）
  const EDIT_AT = EDIT === 'otherfloor' ? order.length : 4 * (tour.length - 1) + 1;
  const rows = [];
  let t = 0;
  let catalogEditNote = null;

  for (const nextIdx of order) {
    t++;
    const fromPlane = project.activePlane;
    const toPlane = tour[nextIdx];
    const fromGraph = project.activeGraph;
    await structuralSync.whenIdle();

    if (t === EDIT_AT && EDIT !== 'none') {
      if (EDIT === 'finish') {
        const room = fromGraph.rooms.find(r => r.cells.size > 0);
        runInAction(() => room.finish.setField('floorMaterial', '301000000002'));
      } else if (EDIT === 'backing') {
        const alt = fromGraph.interiorWallBacking === '101400000001' ? '101400000000' : '101400000001';
        runInAction(() => fromGraph.setInteriorWallBacking(alt));
      } else if (EDIT === 'ecc') {
        // 内壁（INTERIOR_WALL エッジ）のある中心線へ面合わせの偏芯を指定する（壁へ効く）。無ければ通り芯でない縦の中心線
        const edge = fromGraph.edges.find(e => e.masterType === 'INTERIOR_WALL');
        const clId = edge?.axisCLId
          ?? fromGraph.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && !isGridCenterLine(c) && c.discipline === Discipline.ARCH)?.id;
        if (clId) runInAction(() => fromGraph.setCLEccentricity(clId, { mode: 'face', value: 0, side: 1, backing: '' }));
      } else if (EDIT === 'struct') {
        const cl = [...project.structGraph.shapeMap.values()].find(s => isGridCenterLine(s));
        if (cl) runInAction(() => { cl.value = cl.value + 50; });
      } else if (EDIT === 'otherfloor') {
        const target = tour.find(p => p !== fromPlane && p !== toPlane);
        if (!target) throw new Error('otherfloor: 自階・遷移先以外の階が無い（2階建ては対象外）');
        const tg = await floorSwapManager.peek(target, project.structGraph);
        const room = tg.rooms.find(r => r.cells.size > 0);
        // 天井高・床材に加え、壁の鮮度キーを古い値にする（自階の脱出の refreshWallsAllFloors が鍵不一致の他階の壁を
        // 作り直す入力。下地材コードは突入境界の conformWoodBacking で戻されるため使わない）
        runInAction(() => { tg.setDefaultCeilingHeight(tg.defaultCeilingHeight + 10); room?.finish.setField('floorMaterial', '301000000002'); tg.setWallFreshnessKey('s23b-stale'); });
        await saveFloor(target.id, serializeGraph(tg));
      } else if (EDIT === 'catalog') {
        clearOverlays();
      } else if (EDIT === 'catalogthick') {
        const mats = (await import('../../src/finish/materials/materialData.js')).MATERIALS;
        const code = fromGraph.interiorWallBacking;
        const ent = mats.find(m => m.code === code);
        if (!ent) catalogEditNote = `内壁下地材 ${code} が材マスタに無い`;
        else {
          try { setOverlay(CatalogKind.MATERIAL, { doc: [{ ...ent, x: (ent.x ?? 0) + 15, y: (ent.y ?? 0) + 15 }] }); }
          catch (e) { catalogEditNote = `overlay を立てられなかった: ${e.message}`; }
        }
      }
    }

    const undoBefore = undoManager._undoStack.length;
    rec.last = null;
    const t0 = performance.now();
    const ret = await runFinishExitBoundary(fromGraph, project, fmode, { goingToStructure: false, stamps });
    const exitMs = performance.now() - t0;
    const skipped = ret?.skipped === true;
    rows.push({ t, from: fromPlane.name, skipped, reason: rec.last?.reason ?? (stamps ? '?' : '-'), ms: exitMs, undoAdded: undoManager._undoStack.length - undoBefore });

    await whenCenterLineOpsIdle();
    const toGraph = project.graphMap.get(toPlane.id);
    await runBusy('階切替', async () => {
      await floorSwapManager.swap(fromPlane, fromGraph, toPlane, toGraph, () => { project.activePlaneId = toPlane.id; });
    });
    graph = project.activeGraph;
    await runFinishEntryBoundary(graph, project, { loadFloorFn: loadFloor });
    fmode = await loadFinishState(graph, fmode);
  }

  // ---- 最終状態 ----
  const active = project.activeGraph;
  const final = { planes: new Map(), loose: looseForm(active), activeName: project.activePlane.name };
  for (const p of allPlanes) {
    const bytes = p.id === project.activePlaneId ? serializeGraph(active) : floorsStore.data.get(p.id)?.bytes ?? null;
    final.planes.set(p.name, floorForm(bytes));
  }
  final.index = indexForm(project.memberNumberIndex);
  final.struct = maskIds(JSON.stringify(decode(serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger)), big));
  final.planeList = serializePlanes(project);
  final.undoCount = undoManager._undoStack.length;
  // undo を全部戻したあとの自階の正規形（A・B で食い違うなら、省いたぶんの undo 差ではなく状態の差）
  let undoErr = null;
  try { let n = 0; while (undoManager.canUndo && n++ < 100000) undoManager.undo(); } catch (e) { undoErr = e.message; }
  final.afterUndoLoose = undoErr ? `undo失敗:${undoErr}` : looseForm(project.activeGraph);
  return { rows, final, tourN: tour.length, catalogEditNote };
}

function summarize(label, r) {
  const rows = r.rows;
  const skipped = rows.filter(x => x.skipped).length;
  const byReason = new Map();
  for (const x of rows) byReason.set(x.reason, (byReason.get(x.reason) ?? 0) + 1);
  const lastLap = rows.slice(-2 * (r.tourN - 1));
  const msAll = rows.map(x => x.ms);
  console.log(`  [${label}] 遷移${rows.length} 省いた${skipped}  理由別: ${[...byReason].map(([k, v]) => `${k}=${v}`).join(' ')}`
    + `  脱出区間ms 中央値: 全体${median(msAll).toFixed(1)} 最後の1往復${median(lastLap.map(x => x.ms)).toFixed(1)}`
    + `（省いた${median(lastLap.filter(x => x.skipped).map(x => x.ms)).toFixed(1)} / 省かない${median(lastLap.filter(x => !x.skipped).map(x => x.ms)).toFixed(1)}）`
    + `  undo積み総数${rows.reduce((s, x) => s + x.undoAdded, 0)}`);
}

// ---- 実行 ----
for (const file of files) {
  console.log(`\n==================== ${file}  edit=${EDIT} laps=${LAPS} ====================`);
  try {
    const B = await runOne(file, false);
    const A = await runOne(file, true);
    if (!A || !B) { console.log('巡回対象が2階未満のためスキップ'); continue; }
    if (A.catalogEditNote) console.log(`  [注意] ${A.catalogEditNote}`);
    summarize('B 印なし', B);
    summarize('A 印あり', A);
    if (!QUIET) {
      console.log('  A の遷移（# 階 skip/reason ms undo）: ' + A.rows.map(x => `#${x.t}${x.from}:${x.skipped ? 'SKIP' : 'full'}/${x.reason}/${x.ms.toFixed(0)}ms/u${x.undoAdded}`).join('  '));
    }
    // A/B 比較
    const diffs = [];
    for (const [name, form] of A.final.planes) {
      if (form !== B.final.planes.get(name)) diffs.push(`平面「${name}」の保存内容（壁 id を位置で振り直した比較）`);
    }
    if (A.final.loose !== B.final.loose) diffs.push('アクティブ階の serializeGraphCanonicalWalls（内容順の緩い比較）');
    if (A.final.index !== B.final.index) diffs.push('部材採番 index の署名');
    if (A.final.struct !== B.final.struct) diffs.push('通り芯（serializeStructCLs）');
    if (!floorBytesEqual(A.final.planeList, B.final.planeList)) diffs.push('平面一覧（serializePlanes）');
    if (A.final.afterUndoLoose !== B.final.afterUndoLoose) diffs.push('undo を全部戻したあとの自階の正規形');
    const strictOnlyOrder = diffs.length > 0 && A.final.loose === B.final.loose;
    console.log(`  A/B: ${diffs.length === 0 ? '一致（全平面・アクティブ階の緩い比較・採番 index・通り芯・平面一覧・undo 全戻し後）' : `不一致 ${diffs.length} 件`}`);
    for (const d of diffs) console.log(`    不一致: ${d}`);
    if (strictOnlyOrder) console.log('    （緩い比較は一致＝差は壁の並び順だけの可能性）');
    console.log(`  undo エントリ数（最終）: B=${B.final.undoCount} A=${A.final.undoCount} 差=${B.final.undoCount - A.final.undoCount}（＝省いて積まれなかった数。ただし階切替の途中の他の積みも含む）`);
  } catch (e) {
    console.error(`NG ${file}:`, e);
    process.exitCode = 1;
  }
}
