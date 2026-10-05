// 「何も編集しない階切替の往復で、階の内容が安定するか」を実データで測る probe
// （調査用。製品コードから参照しない。.mjs のため `npm run lint` の対象外）。
//
// 目的: 「無編集の階の仕上げ脱出を丸ごと省く」案（脱出のたびに、前回の脱出直後の自階のバイト列を
// 印として持ち、次の脱出の時点で一致していれば脱出を省く）が実際に効くかを、数字で判定する。
//   (i)  往復の安定: 脱出 → swap で外す（保存）→ 別の階 → 戻す（復元＋heal）→ 突入境界 →
//        FinishModeState の生成と init、のあとで serializeGraph(graph) が「前回その階を脱出した直後」の
//        バイト列と完全一致するか。不一致ならどのフィールドが違うかを出す。
//   (ii) 脱出の収束: 無編集の脱出の前後で serializeGraphCanonicalWalls（壁 id の付け替えを無視する比較用）が
//        一致し、他の階（屋根専用平面・検討案を含む全平面＝planeMap）の書込み世代
//        （storage/floorWriteGeneration.js）が変わらないか。変わったら、どの階がどの呼び出し元から書かれたか。
//   (iii) その階の何回目の脱出か。
//   「印が付く脱出」＝(ii) を満たした脱出。「次の脱出で省ける遷移」＝その階の前回の脱出が印付きで、
//   今回の脱出の直前の serializeGraph が前回の脱出直後のバイト列と完全一致するもの（外部入力
//   ＝材カタログ・他階の内容は、この無編集の巡回では変わらないので一致を見ていない）。
//
// 使い方（app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/finishExitQuiescenceProbe.mjs [入力.stq ...] [--laps=N] [--edit=exit|return] [--quiet]
//   既定の入力: D:/tatsuya/Download/moku4.stq。--laps は巡回の往復回数（既定2。階 0→…→最上→…→0 を1往復とする）。
//   --edit=exit   : 3回目の遷移の脱出の直前に、自階の内壁下地材（graph.setInteriorWallBacking）を変える
//                   （(ii) が不一致になることの確認＝検出力）。
//   --edit=return : 3回目の遷移の突入・init のあと、自階の天井高初期値（graph.setDefaultCeilingHeight）を変える
//                   （(i) が不一致になることの確認＝検出力）。
//
// 【IndexedDB の扱い】fake・メモリ化（finishExitEccProbe.mjs の installFakeIndexedDB と同じ最小シム。floors の
// put/get/delete を模す）。実 IDB へは一切触れない。文書の全階のバイト列を fake IDB の floors へ種として入れ、
// 実アプリと同じく「アクティブ階だけがメモリに展開され、他階は空」の状態から始める（アクティブ階は
// floorSwapManager.activate＝復元＋heal）。peek・loadFloor・saveFloor は実物（storage/db.js・FloorSwapManager）。
// 書込みの呼び出し元は、シムの put で取ったスタックから推定する。
//
// 【実アプリの階切替（App.jsx switchFloorKeepingMode）との対応】
//   structuralSync.whenIdle → 脱出境界（runFinishExitBoundary。modeRef.current＝実物の FinishModeState）
//   → switchFloor（store.js 607-632）→ 突入境界（runFinishEntryBoundary。本番と同じ { loadFloorFn: loadFloor }）
//   → mode 再ロード effect（旧 FinishModeState を dispose → new FinishModeState(graph, project) → init）。
// ・store.js は react・localStorage を引くため Node から import できない。switchFloor は同じ呼び出し順を再現した:
//   whenCenterLineOpsIdle → runBusy('階切替') → floorSwapManager.swap(現階, 現グラフ, 次階, 次グラフ,
//   () => { project.activePlaneId = 次階 })（スワップ本体は実物）。store.js 側の追加処理は無い（コードを読んで確認）。
// ・省いたもの: App.jsx 786・812・841 行付近の3つの peek effect（上階階段・上階吹抜け・昇降機の図中記号）。
//   いずれも他階を peek して React state（setUpperStairEntries 等）か project.equipmentIndex を更新するだけで、
//   自階の graph を書かない（読んで確認。graph を書く effect は 764 行の建具採番だが floorplan モード限定で、
//   graph でなく project.openingNumberIndex を書く）。peek は読み取り専用の一時グラフなので IDB も書かない。
//   よって (i)(ii) の数字には影響しない（影響があるのは実時間だけ）。
// ・省いたもの: beginUiTransition・setActiveFloorId 以外の React state（スナップ点・メニュー等）。graph に無関係。
// ・巡回の対象は「屋根専用平面（isRoofPlane）・検討案（isAlternative）を除いた階」。屋根専用平面は構造モード専用
//   （仕上げでは表示しない）。project.planes（採用階のみのゲッター）は巡回にだけ使い、fake IDB への種入れ・
//   書込み世代の監視・graph のクリアは [...project.planeMap.values()]（屋根専用平面・検討案を含む全平面）で行う。
//
// 【数字の読み方】
//  (a) 「省略可」は、どの階も編集しない巡回での上限。この probe は自階のバイト列だけで判定している。他の階が変わった後は、
//      自階が一致していても脱出が他の階へ書き込む（wallRefresh.js:208 ← finishBoundary.js:293）。実際に省く仕組みは、
//      他の全平面の内容と外部入力（カタログ・通り芯・構造情報）の一致も条件にしなければならない。
//  (b) 書込み世代（floorWriteGeneration）だけでは他階の同一性を判定できない（FloorSwapManager.swap が変化が無くても
//      現階を毎回保存し、世代が巡回のたびに進むため）。
//  (c) この probe は読込み境界（store.js bootReady の refreshWallsAllFloors）を通していない。足すと各階の最初の脱出が
//      収束しやすくなる（13.stq は初回から収束）ので、数字は控えめ側。
//  (d) 文書同梱のカタログ（overlay）を立てていない。カタログを持つ文書（moku2-1 等）の数字は参考扱い。
// ・対象関数の呼出回数: 脱出境界・突入境界は本 probe が直接呼ぶ回数を数える。regenerateWalls は
//   runFinishExitBoundary の内部（ESM 束縛）で差し替えられないため、「regenerateWalls が regenerated:true を
//   返したときだけ呼ばれる graph.setWallFreshnessKey の呼出回数」（インスタンスに被せて数える）を代わりに出す。
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadFloor } from '../../src/storage/db.js';
import { floorWriteGeneration } from '../../src/storage/floorWriteGeneration.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { FinishModeState } from '../../src/modes/FinishModeState.js';
import { structuralSync } from '../../src/structural/structuralSync.js';
import { whenCenterLineOpsIdle } from '../../src/transform/centerLineOps.js';
import { runBusy } from '../../src/uiBusy.js';
import { serializeGraph, serializeGraphCanonicalWalls, decodeFloorSnapshot } from '../../src/graphSnapshot.js';
import { floorBytesEqual } from '../../src/floorOps.js';

// ---- 引数 ----
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const files = args.filter(a => !a.startsWith('--'));
const flagValue = (name, dflt) => {
  const f = flags.find(x => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!f) return dflt;
  return f.includes('=') ? f.slice(f.indexOf('=') + 1) : true;
};
const LAPS = Number(flagValue('laps', 2));
const EDIT = flagValue('edit', null); // null | 'exit' | 'return'
const QUIET = flagValue('quiet', false) === true;
if (EDIT != null && EDIT !== 'exit' && EDIT !== 'return') {
  console.error('--edit は exit か return');
  process.exit(2);
}
const EDIT_AT = 3; // 何回目の遷移で編集を入れるか（1始まり）
if (files.length === 0) files.push('D:/tatsuya/Download/moku4.stq');

// ---- fake IndexedDB（メモリ。floors への書込みを記録する） ----
const writeLog = []; // { planeId, op, frames }
const lastSavedBytes = new Map(); // planeId -> 最後に put された bytes
function installFakeIndexedDB() {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor(name) { this.name = name; this.data = new Map(); }
    put(value) {
      const req = new FakeRequest();
      const key = value.planeId ?? value.projectId;
      this.data.set(key, value);
      if (this.name === 'floors') {
        lastSavedBytes.set(key, value.bytes);
        writeLog.push({ planeId: key, op: 'put', frames: callerFrames(new Error().stack) });
      }
      queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
      return req;
    }
    get(key) {
      const req = new FakeRequest();
      queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } }));
      return req;
    }
    delete(key) {
      const req = new FakeRequest();
      this.data.delete(key);
      if (this.name === 'floors') writeLog.push({ planeId: key, op: 'delete', frames: callerFrames(new Error().stack) });
      queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
      return req;
    }
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
  globalThis.indexedDB = {
    open() {
      const req = new FakeRequest();
      queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } }));
      return req;
    },
  };
  return fakeDb;
}
Error.stackTraceLimit = 40;
function callerFrames(stack) {
  const out = [];
  for (const line of String(stack).split('\n')) {
    const m = line.match(/(src\/[^):\s]+):(\d+)/);
    if (!m) continue;
    if (/src\/storage\/db\.js/.test(m[1])) continue;
    const s = `${m[1].replace(/^src\//, '')}:${m[2]}`;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}
const fakeDb = installFakeIndexedDB();

// ---- 差分（decodeFloorSnapshot 同士をトップレベルのキーごと・要素ごとに比べる。巨大出力にしない） ----
const trunc = (v, n = 150) => { const s = JSON.stringify(v) ?? 'undefined'; return s.length > n ? `${s.slice(0, n)}…` : s; };
// 長い配列（cells 等）を件数へ畳んで表示する
const shorten = (e) => (e && typeof e === 'object' && !Array.isArray(e)
  ? Object.fromEntries(Object.entries(e).map(([k, v]) => [k, Array.isArray(v) && v.length > 3 ? `[${v.length}件]` : v]))
  : e);
const elemKey = (e) => (e && typeof e === 'object' ? (e.id ?? e.key ?? e.clId ?? null) : null);
function diffSnapshots(bytesA, bytesB) {
  const A = decodeFloorSnapshot(bytesA);
  const B = decodeFloorSnapshot(bytesB);
  const out = [];
  for (const k of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
    const ja = JSON.stringify(A[k]);
    const jb = JSON.stringify(B[k]);
    if (ja === jb) continue;
    const a = A[k]; const b = B[k];
    if (Array.isArray(a) && Array.isArray(b)) {
      const mapA = new Map(); const mapB = new Map();
      a.forEach((e, i) => mapA.set(elemKey(e) ?? `#${i}:${JSON.stringify(e)}`, e));
      b.forEach((e, i) => mapB.set(elemKey(e) ?? `#${i}:${JSON.stringify(e)}`, e));
      const onlyA = [...mapA.keys()].filter(x => !mapB.has(x));
      const onlyB = [...mapB.keys()].filter(x => !mapA.has(x));
      const changed = [...mapA.keys()].filter(x => mapB.has(x) && JSON.stringify(mapA.get(x)) !== JSON.stringify(mapB.get(x)));
      // 順序だけが違うか（同じ集合で並びだけ違う）
      const sortedA = a.map(e => JSON.stringify(e)).sort().join('|');
      const sortedB = b.map(e => JSON.stringify(e)).sort().join('|');
      // id を除いた内容の多重集合が同じか（壁 id の付け替えだけの差）
      const noId = (e) => { if (!e || typeof e !== 'object') return JSON.stringify(e); const c = { ...e }; delete c.id; delete c.generatedWallIds; return JSON.stringify(c); };
      const idOnly = a.map(noId).sort().join('|') === b.map(noId).sort().join('|');
      const samples = [];
      for (const x of changed.slice(0, 2)) {
        const ea = mapA.get(x); const eb = mapB.get(x);
        const fields = Object.keys({ ...ea, ...eb }).filter(f => JSON.stringify(ea[f]) !== JSON.stringify(eb[f]));
        samples.push(`変化 ${String(x).slice(0, 12)} フィールド=${fields.join(',')} A=${trunc(fields.map(f => ea[f]), 80)} B=${trunc(fields.map(f => eb[f]), 80)}`);
      }
      for (const x of onlyA.slice(0, 1)) samples.push(`Aのみ ${trunc(mapA.get(x), 120)}`);
      for (const x of onlyB.slice(0, 1)) samples.push(`Bのみ ${trunc(shorten(mapB.get(x)), 420)}`);
      out.push({
        key: k, nA: a.length, nB: b.length, onlyA: onlyA.length, onlyB: onlyB.length, changed: changed.length,
        orderOnly: sortedA === sortedB, idOnly, samples,
      });
    } else {
      out.push({ key: k, nA: null, nB: null, samples: [`A=${trunc(a)} B=${trunc(b)}`] });
    }
  }
  return out;
}
function printDiff(d, indent) {
  for (const e of d) {
    const head = e.nA == null ? `${e.key}（非配列）` : `${e.key}[n=${e.nA}→${e.nB}, Aのみ${e.onlyA}/Bのみ${e.onlyB}/変化${e.changed}${e.orderOnly ? ', 並び順だけ' : ''}${e.idOnly ? ', id以外の内容は同じ多重集合' : ''}]`;
    console.log(`${indent}${head}`);
    for (const s of e.samples) console.log(`${indent}  ${s}`);
  }
}

// ---- 1文書ぶんの巡回 ----
async function runDocument(file) {
  const { project } = loadDocument(file);
  // 巡回する階（仕上げで表示する採用階。project.planes は屋根専用平面・検討案を除くゲッター）と、
  // IDB の種・書込み監視の対象（屋根専用平面・検討案を含む全平面＝planeMap）を別の変数で持つ。
  const tour = project.planes.filter(p => !p.isRoofPlane && !p.isAlternative);
  const allPlanes = [...project.planeMap.values()];
  console.log(`\n==================== ${file} ====================`);
  console.log(`planes(全${allPlanes.length}。巡回${tour.length}): ${allPlanes.map(p => `${p.name}${p.isRoofPlane ? '(屋根専用)' : p.isAlternative ? '(検討案)' : ''}`).join(', ')}`);
  console.log(`巡回対象(${tour.length}階): ${tour.map(p => p.name).join(', ')} / laps=${LAPS} / edit=${EDIT ?? '無し'}`);
  if (tour.length < 2) { console.log('巡回対象が2階未満のためスキップ'); return null; }

  // 全階のバイト列を fake IDB へ種として入れ、メモリ上は最下階だけを展開する（実アプリの起動後の状態）。
  const floorsStore = fakeDb.stores.get('floors');
  floorsStore.data.clear();
  lastSavedBytes.clear();
  writeLog.length = 0;
  for (const p of allPlanes) {
    const g = project.graphMap.get(p.id);
    if (!g) continue;
    // loadDocument が restoreGraph 済みの graph から、復元前と同じ内容のバイト列を作って種にする。
    // （doc の生バイト列を使わないのは、restore→serialize の往復で正規化された形を実アプリの保存済み状態とみなすため。
    //   この種の往復は巡回の前に1度だけで、(i)(ii) の比較には入らない。）
    floorsStore.data.set(p.id, { planeId: p.id, bytes: serializeGraph(g) });
  }
  const startPlane = tour[0];
  runInAction(() => { project.activePlaneId = startPlane.id; });
  for (const p of allPlanes) project.graphMap.get(p.id)?.clearFloorData();
  await floorSwapManager.activate(startPlane, project.graphMap.get(startPlane.id));

  // regenerateWalls の呼出（regenerated:true）を graph.setWallFreshnessKey の呼出で数える
  const regenCalls = new Map();
  for (const p of allPlanes) {
    const g = project.graphMap.get(p.id);
    if (!g) continue;
    const orig = g.setWallFreshnessKey;
    regenCalls.set(p.id, 0);
    Object.defineProperty(g, 'setWallFreshnessKey', {
      configurable: true, writable: true,
      value(...a) { regenCalls.set(p.id, regenCalls.get(p.id) + 1); return orig.apply(this, a); },
    });
  }

  // 仕上げモードへ入る（handleModeChange の突入側＝突入境界 → mode 再ロード effect）
  const calls = { exit: 0, entry: 0, swap: 0 };
  const loadFinishState = async (graph, prev) => {
    prev?.dispose();
    const s = new FinishModeState(graph, project);
    await s.init();
    return s;
  };
  let graph = project.activeGraph;
  await runFinishEntryBoundary(graph, project, { loadFloorFn: loadFloor });
  calls.entry++;
  let fmode = await loadFinishState(graph, null);

  // 巡回順: 0→1→…→最上→…→0 を laps 回
  const order = [];
  for (let l = 0; l < LAPS; l++) {
    for (let i = 1; i < tour.length; i++) order.push(i);
    for (let i = tour.length - 2; i >= 0; i--) order.push(i);
  }

  const lastExit = new Map(); // planeId -> { plain, marked }
  const exitCount = new Map(); // planeId -> 回数
  const rows = [];
  const diffSigs = new Set();
  let t = 0;

  for (const nextIdx of order) {
    t++;
    const fromPlane = project.activePlane;
    const toPlane = tour[nextIdx];
    const fromGraph = project.activeGraph;
    const k = (exitCount.get(fromPlane.id) ?? 0) + 1;
    exitCount.set(fromPlane.id, k);

    // ---- 脱出（switchFloorKeepingMode: whenIdle → exit） ----
    await structuralSync.whenIdle();
    if (EDIT === 'exit' && t === EDIT_AT) {
      const cur0 = fromGraph.interiorWallBacking;
      const alt = cur0 === '101400000001' ? '101400000000' : '101400000001';
      runInAction(() => fromGraph.setInteriorWallBacking(alt));
      console.log(`  [edit=exit] ${fromPlane.name}: interiorWallBacking ${cur0} → ${alt}`);
    }
    const plainBefore = serializeGraph(fromGraph);
    const canonBefore = serializeGraphCanonicalWalls(fromGraph);
    const wallIdsBefore = new Set(fromGraph.walls.map(w => w.id));
    const gensBefore = new Map(allPlanes.map(p => [p.id, floorWriteGeneration(p.id)]));
    const regenBefore = regenCalls.get(fromPlane.id);
    writeLog.length = 0;
    const prev = lastExit.get(fromPlane.id) ?? null;
    const skippable = !!(prev && prev.marked && floorBytesEqual(plainBefore, prev.plain));

    await runFinishExitBoundary(fromGraph, project, fmode, { goingToStructure: false });
    calls.exit++;

    const plainExit = serializeGraph(fromGraph);
    const canonAfter = serializeGraphCanonicalWalls(fromGraph);
    const exitWrites = writeLog.map(w => ({ ...w }));
    const changedGens = allPlanes
      .filter(p => floorWriteGeneration(p.id) !== gensBefore.get(p.id))
      .map(p => p.name);
    const wallsReplaced = fromGraph.walls.filter(w => !wallIdsBefore.has(w.id)).length;
    const regenerated = regenCalls.get(fromPlane.id) - regenBefore;
    const canonEq = floorBytesEqual(canonBefore, canonAfter);
    const noOtherWrites = changedGens.length === 0;
    const marked = canonEq && noOtherWrites;
    lastExit.set(fromPlane.id, { plain: plainExit, marked });

    // ---- 階移動（store.js switchFloor の再現） ----
    await whenCenterLineOpsIdle();
    const toGraph = project.graphMap.get(toPlane.id);
    await runBusy('階切替', async () => {
      await floorSwapManager.swap(fromPlane, fromGraph, toPlane, toGraph, () => { project.activePlaneId = toPlane.id; });
    });
    calls.swap++;
    const savedPlain = lastSavedBytes.get(fromPlane.id);
    const swapSaveEqExit = floorBytesEqual(savedPlain, plainExit);

    // ---- 突入 → mode 再ロード effect ----
    graph = project.activeGraph;
    // 段ごとの食い違いの切り分け用: 復元＋heal 直後 / 突入境界後 / init 後 のそれぞれを前回の脱出直後と比べる
    const bk = lastExit.get(toPlane.id) ?? null;
    const afterSwapEq = bk ? floorBytesEqual(serializeGraph(graph), bk.plain) : null;
    await runFinishEntryBoundary(graph, project, { loadFloorFn: loadFloor });
    calls.entry++;
    const afterEntryEq = bk ? floorBytesEqual(serializeGraph(graph), bk.plain) : null;
    fmode = await loadFinishState(graph, fmode);
    if (EDIT === 'return' && t === EDIT_AT) {
      const c0 = graph.defaultCeilingHeight;
      runInAction(() => graph.setDefaultCeilingHeight(c0 + 1));
      console.log(`  [edit=return] ${toPlane.name}: defaultCeilingHeight ${c0} → ${c0 + 1}`);
    }

    // ---- (i): 戻ってきた階が、前回その階を脱出した直後と一致するか ----
    const backPrev = lastExit.get(toPlane.id) ?? null;
    let iState = 'n/a(初回)';
    let diff = null;
    if (backPrev) {
      const returned = serializeGraph(graph);
      if (floorBytesEqual(returned, backPrev.plain)) iState = 'EQ';
      else {
        iState = 'NEQ';
        diff = diffSnapshots(backPrev.plain, returned);
      }
    }
    rows.push({
      t, from: fromPlane.name, to: toPlane.name, k, canonEq, noOtherWrites, marked, skippable,
      iState, wallsReplaced, regenerated, swapSaveEqExit, hasPrev: !!prev,
    });
    console.log(`#${t} ${fromPlane.name}→${toPlane.name} | 脱出(${fromPlane.name} ${k}回目) 壁再生成${regenerated}回・壁id付替${wallsReplaced}/${wallIdsBefore.size}`
      + ` (ii)=${canonEq ? 'EQ' : 'NEQ'}/他階書込み${noOtherWrites ? '無' : `有[${changedGens.join(',')}]`}`
      + ` 印=${marked ? '付' : '無'} 省略可=${prev ? (skippable ? 'YES' : 'no') : 'n/a(初回)'}`
      + ` | 復帰(${toPlane.name}) (i)=${iState} | swap保存==脱出直後:${swapSaveEqExit ? 'EQ' : 'NEQ'}`);
    if (!noOtherWrites && !QUIET) {
      for (const w of exitWrites) {
        const pn = project.planeMap.get(w.planeId)?.name ?? w.planeId;
        console.log(`    書込み: ${pn} ${w.op} ← ${w.frames.join(' < ')}`);
      }
    }
    if (!canonEq && !QUIET) {
      console.log('    (ii)不一致の差分（脱出前→脱出後）:');
      printDiff(diffSnapshots(canonBefore, canonAfter), '      ');
    }
    if (diff) {
      const sig = diff.map(e => e.key).join(',');
      console.log(`    (i)不一致: 差のあるキー=${sig} / 前回の脱出直後との一致: 復元+heal後=${afterSwapEq ? 'EQ' : 'NEQ'} 突入境界後=${afterEntryEq ? 'EQ' : 'NEQ'} init後=NEQ`);
      if (!diffSigs.has(sig) || !QUIET) {
        printDiff(diff, '      ');
        diffSigs.add(sig);
      }
    }
  }

  // ---- 集計 ----
  const nExit = rows.length;
  const withPrev = rows.filter(r => r.hasPrev);
  const iRows = rows.filter(r => r.iState !== 'n/a(初回)');
  const sum = {
    file, floors: tour.length, transitions: nExit, calls,
    regenerated: rows.reduce((s, r) => s + r.regenerated, 0),
    iEq: iRows.filter(r => r.iState === 'EQ').length, iTotal: iRows.length,
    iiEq: rows.filter(r => r.canonEq).length,
    iiNoWrites: rows.filter(r => r.noOtherWrites).length,
    marked: rows.filter(r => r.marked).length,
    skippable: rows.filter(r => r.skippable).length,
    withPrev: withPrev.length,
  };
  console.log('\n---- 集計 ----');
  console.log(`脱出境界の呼出=${calls.exit} 突入境界の呼出=${calls.entry}(初回突入1を含む) swap=${calls.swap} / regenerateWalls が regenerated:true を返した回数(setWallFreshnessKey 呼出)=${sum.regenerated}`);
  console.log(`(i)  往復の安定        : ${sum.iEq}/${sum.iTotal} 遷移で EQ（復帰先に前回の脱出記録がある遷移のみ）`);
  console.log(`(ii) 脱出の収束        : 比較用直列化の一致 ${sum.iiEq}/${nExit}、他階書込み無し ${sum.iiNoWrites}/${nExit}`);
  console.log(`印が付く脱出            : ${sum.marked}/${nExit}（(ii) を両方満たしたもの）`);
  console.log(`次の脱出で省ける遷移     : ${sum.skippable}/${nExit}（全遷移比 ${(100 * sum.skippable / nExit).toFixed(0)}%）、前回の脱出がある遷移だけで見ると ${sum.skippable}/${sum.withPrev}`);
  // 定常状態の見積り: 最後の1往復（2*(階数-1) 遷移）だけで見る（それ以前は各階の初回の脱出＝文書が保存時点から
  // 整う過程を含むため）。laps が小さいと最後の往復も整い切っていないので、laps>=3 で読む。
  const lastLap = rows.slice(-2 * (tour.length - 1));
  console.log(`最後の1往復(${lastLap.length}遷移)だけ: (i)EQ ${lastLap.filter(r => r.iState === 'EQ').length}/${lastLap.filter(r => r.iState !== 'n/a(初回)').length}`
    + ` (ii)両方 ${lastLap.filter(r => r.marked).length}/${lastLap.length} 省略可 ${lastLap.filter(r => r.skippable).length}/${lastLap.length}`);
  // 階ごと
  const byFloor = new Map();
  for (const r of rows) {
    const e = byFloor.get(r.from) ?? { exits: 0, marked: 0, skippable: 0, iiEq: 0 };
    e.exits++; if (r.marked) e.marked++; if (r.skippable) e.skippable++; if (r.canonEq) e.iiEq++;
    byFloor.set(r.from, e);
  }
  for (const [name, e] of byFloor) console.log(`  ${name}: 脱出${e.exits}回 (ii)比較用一致${e.iiEq} 印${e.marked} 省略可${e.skippable}`);
  return sum;
}

for (const f of files) {
  try {
    await runDocument(f);
  } catch (e) {
    console.error(`NG ${f}:`, e);
    process.exitCode = 1;
  }
}
