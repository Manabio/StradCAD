// 展開・天伏の突入境界（wallRefresh.js refreshWallsForViewEntry）の実測と、帯の一致確認の probe
// （調査用。製品コードから参照しない。`npm run lint` の対象〔eslint.config.js の **/*.mjs・node globals〕）。
//
// 測るもの
//  (a) 鍵一致時: 起動の読込み相当の全階再生成（bootReady と同じ refreshWallsAllFloors を、収束するまで繰り返す）
//      のあと、refreshWallsForViewEntry を 5 回。所要の中央値・changedPlaneIds が毎回 []・undo 長不変。
//  (b) 不一致時: 通り芯を動かし（既定 auto:50＝先頭の通り芯を +50mm。elevBandDump.mjs moveCenterLine＝
//      本番の確定と同じ commitCLMoveOp）→ 1 回実行。文書を読み直して 3 回の中央値。changedPlaneIds・
//      undo エントリ数（移動自身の 1 を除く）・壁本数の前後。直後にもう一度呼んで [] になること（収束）。
//  内訳: 注入した peek・saveFloorFn・saveActiveFloorFn・loadMaterialMapFn の累積時間、鍵計算（階あたり）、
//        残り＝再生成（下地整合・蹴上補正・2a 解決・壁再生成・梁芯追従・鍵保存）＋構造再計算＋serializeGraph。
//  帯の一致: (b) 1 回目の直後の階 F の帯（elevBandDump.dumpFloorBands）を、別プロセスの
//        `dumpElevFigure.mjs --regen --move=<同じCL>:<mm>` の同じ階の出力と diffElevGolden.mjs で比較する。
//        検出力は、境界を呼ばない（移動しただけ＝壁が古いまま）帯を、柱・梁・梁芯を両側から除いて基準と比べ、
//        差が出ること（「境界なし…を除去」の exit=1）だけで判定する。柱・梁を除かない「境界なし vs 基準」の差は
//        setup() の起動相当の全階再生成（構造再計算を含む）が基準側に無いことによる差を含むので、参考値。
//        検出力が出ない文書・階（壁が古くても柱・梁を除いた帯に差が出ない＝そこでの一致は検出力のない一致）:
//        stair-ports-test1 の両階・ceiling-steel-stair-test の両階・moku1-6 の 2階（既定の +50mm 移動の場合）。
//
// 使い方（app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/viewEntryProbe.mjs [文書.stq ...] [階名 ...] [--move=<CL id|label|auto>:<mm>] [--no-bands]
//   既定: 文書 D:/tatsuya/Download/{moku4-3,ceiling-zone-test,13}.stq・階 1階 2階・--move=auto:50
//   引数のうち .stq で終わるものが文書、それ以外（--以外）が階名（project.planes の name）。
//   --no-bands  帯の比較（別プロセス起動を含む）を省く。
//   --keep=<dir>  帯比較の中間 JSON（ref・probe 等）を <dir>/vep-* に残す（差分の原因調べ用）。
//
// 【IndexedDB の扱い】fake・メモリ化（finishExitQuiescenceProbe.mjs と同じ最小シム）。文書の全階を floors へ
// 種として入れ、アクティブ階だけをメモリへ展開（floorSwapManager.activate＝復元＋heal）、他階は空にする
// （実アプリと同じ）。peek・saveFloor・loadMaterialMap は実物（storage/db.js・FloorSwapManager・
// finish/wallRegeneration.js）。実 IDB へは一切触れない。
//
// 【本番との差・読み替え】
//  ・構造同期リスナー（setCenterLineStructuralListener）は登録しない＝移動確定後の構造再計算は走らない。
//    (b) は「移動直後の未同期の状態で展開へ入る」場合の上限側の所要（柱・梁の再計算は境界の
//    recomputeActiveStructural／reflectStructuralToOtherFloors が担う）。実アプリでは移動確定時の構造同期が
//    先に走るので、実機の (b) はその分 境界の構造再計算が軽くなる可能性がある（未検証）。
//  ・帯の上下階は dumpElevFigure.mjs と同じく project.orderedTabs の隣、IDB から peek（展開モードの
//    _peekAbove/BelowGraph は project.planes の隣。対象文書で同じことを実行時に確認して表示する）。
//  ・本番の elevation.enter は続けて collectOpeningNumbersAllFloors を呼ぶが、本 probe は省く（採番収集は壁・鍵を
//    変えず、帯の建具記号丸の番号だけに効く。基準側の dumpFloorBands も採番しないので比較に影響しない）。
//  ・柱・梁・梁芯は基準側（--regen は構造再計算をしない）との差が出うる。要因は 2 つ:
//    (1) 境界だけでなく setup() の起動相当の全階再生成も構造を作り直す（基準側は文書のままの構造）。
//    (2) 移動に使う graph が両側で違う（基準側は loadDocument の作業階 activeGraph 経由、本 probe は対象階で
//        commitCLMoveOp）。梁芯の追従は自階だけなので、2階を測るとき梁芯の差が混ざりうる。
//    差は 1 件ずつ分類して読むこと（壁・隔て壁・2a・床/天井線は一致が期待値。柱・梁・梁芯を除いた比較で判定する）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { dumpFloorBands, moveCenterLine, parseMoveSpec, stripStructuralMembers } from './elevBandDump.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { saveFloor } from '../../src/storage/db.js';
import { serializeGraph } from '../../src/graphSnapshot.js';
import { undoManager } from '../../src/undoManager.js';
import { refreshWallsAllFloors, refreshWallsForViewEntry } from '../../src/wallRefresh.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';

// ---- 引数 ----
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const positional = args.filter(a => !a.startsWith('--'));
const moveSpec = flags.find(a => a.startsWith('--move='))?.slice('--move='.length) ?? 'auto:50';
const noBands = flags.includes('--no-bands');
const keepDir = flags.find(a => a.startsWith('--keep='))?.slice('--keep='.length) ?? null;
const badFlag = flags.find(a => a !== '--no-bands' && !a.startsWith('--move=') && !a.startsWith('--keep='));
if (badFlag) { console.error(`unknown option: ${badFlag}`); process.exit(2); }
const { mm: MOVE_MM } = parseMoveSpec(moveSpec);
const DEFAULT_DOCS = ['moku4-3', 'ceiling-zone-test', '13'].map(n => `D:/tatsuya/Download/${n}.stq`);
const docs = positional.filter(a => a.endsWith('.stq'));
const floorNames = positional.filter(a => !a.endsWith('.stq'));
if (docs.length === 0) docs.push(...DEFAULT_DOCS);
if (floorNames.length === 0) floorNames.push('1階', '2階');

// ---- fake IndexedDB（finishExitQuiescenceProbe.mjs と同型。書込みログは不要なので持たない） ----
function installFakeIndexedDB() {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor() { this.data = new Map(); }
    put(value) {
      const req = new FakeRequest();
      this.data.set(value.planeId ?? value.projectId, value);
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
      queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
      return req;
    }
  }
  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
      for (const name of ['floors', 'projects', 'savedFloors']) this.stores.set(name, new FakeStore());
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
const fakeDb = installFakeIndexedDB();
console.warn = () => {}; // 壁再生成の警告（重複等）で表が読めなくなるのを避ける

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const ms = (v) => v.toFixed(1);

// ---- 1 文書・1 階の初期化（実アプリの起動後＝アクティブ階だけ展開、bootReady の全階再生成まで） ----
async function setup(file, floorName) {
  const { project } = loadDocument(file);
  const plane = project.planes.find(p => p.name === floorName);
  if (!plane) return null;
  const floors = fakeDb.stores.get('floors');
  floors.data.clear();
  for (const p of project.planeMap.values()) {
    const g = project.graphMap.get(p.id);
    if (g) floors.data.set(p.id, { planeId: p.id, bytes: serializeGraph(g) });
  }
  runInAction(() => { project.activePlaneId = plane.id; });
  for (const p of project.planeMap.values()) project.graphMap.get(p.id)?.clearFloorData();
  await floorSwapManager.activate(plane, project.graphMap.get(plane.id));
  runInAction(() => { undoManager._undoStack.splice(0); undoManager._redoStack.splice(0); });
  const nameOf = (id) => project.planeMap.get(id)?.name;
  // bootReady と同じ呼び出し（pushUndo:false・pushActiveStructuralUndo:false）。v8 初回の再生成を吸収する。
  // 1 回で収束しない文書があるので、収束するまで（最大 4 回）繰り返し、回数と各回の変更階を出す。
  const boot = [];
  for (let i = 0; i < 4; i++) {
    const r = await refreshWallsAllFloors(project, { pushUndo: false, pushActiveStructuralUndo: false });
    boot.push(r.changedPlaneIds.map(nameOf));
    if (r.changedPlaneIds.length === 0) break;
  }
  return { project, plane, nameOf, boot };
}

// ---- 注入口の累積時間つきで境界を 1 回実行 ----
async function runEntry(ctx) {
  const { project, nameOf } = ctx;
  const t = { peek: 0, peekN: 0, saveFloor: 0, saveFloorN: 0, saveActive: 0, saveActiveN: 0, mat: 0, matN: 0 };
  const timed = (key, fn) => async (...a) => {
    const s = performance.now();
    try { return await fn(...a); } finally { t[key] += performance.now() - s; t[`${key}N`]++; }
  };
  const g = project.activeGraph;
  const u0 = undoManager._undoStack.length;
  const walls0 = g.walls.length;
  const s = performance.now();
  const r = await refreshWallsForViewEntry(project, {
    saveActiveFloorFn: timed('saveActive', saveFloor),
    peek: timed('peek', (plane, sg) => floorSwapManager.peek(plane, sg)),
    saveFloorFn: timed('saveFloor', saveFloor),
    loadMaterialMapFn: timed('mat', loadMaterialMap),
  });
  const total = performance.now() - s;
  const injected = t.peek + t.saveFloor + t.saveActive + t.mat;
  return {
    total, t, rest: total - injected, changed: r.changedPlaneIds.map(nameOf),
    undoDelta: undoManager._undoStack.length - u0, walls0, walls1: g.walls.length,
  };
}

function keyCostMs(ctx) {
  const g = ctx.project.activeGraph;
  const N = 20;
  const s = performance.now();
  for (let i = 0; i < N; i++) wallFreshnessKey(g, ctx.project);
  return (performance.now() - s) / N;
}

const fmtRow = (label, x) => `${label.padEnd(12)} ${ms(x.total).padStart(7)}ms | peek ${ms(x.t.peek)}(${x.t.peekN}) saveFloor ${ms(x.t.saveFloor)}(${x.t.saveFloorN})`
  + ` saveActive ${ms(x.t.saveActive)}(${x.t.saveActiveN}) mat ${ms(x.t.mat)}(${x.t.matN}) 残り ${ms(x.rest)}`
  + ` | changed ${JSON.stringify(x.changed)} undo+${x.undoDelta} 壁 ${x.walls0}→${x.walls1}`;

// ---- 帯の比較 ----
const ELEV_DIFF = path.join(import.meta.dirname, 'diffElevGolden.mjs');
const DUMP_FIG = path.join(import.meta.dirname, 'dumpElevFigure.mjs');
const APP_DIR = path.join(import.meta.dirname, '..', '..');
const floorFile = (name) => `elevfig-${name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_')}.json`;

async function dumpBandsOfActive(ctx, outDir, { strip = false } = {}) {
  const { project, plane } = ctx;
  const tabs = project.orderedTabs;
  const i = tabs.findIndex(p => p.id === plane.id);
  const peekGraph = async (p) => (p ? floorSwapManager.peek(p, project.structGraph) : null);
  const upper = await peekGraph(tabs[i + 1]);
  const lower = await peekGraph(tabs[i - 1]);
  if (strip) { // 柱・梁を除く（自階は生きたグラフなので呼び出し側が最後に使う）
    stripStructuralMembers(project.activeGraph); stripStructuralMembers(upper); stripStructuralMembers(lower);
  }
  const planes = project.planes;
  const j = planes.findIndex(p => p.id === plane.id);
  const sameNeighbors = planes[j + 1]?.id === tabs[i + 1]?.id && planes[j - 1]?.id === tabs[i - 1]?.id;
  const rows = dumpFloorBands(project, project.activeGraph, upper, lower);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, floorFile(plane.name)), JSON.stringify(rows, null, 1));
  return { rows, sameNeighbors };
}

function diffReport(refDir, probeDir) {
  try {
    const out = execFileSync(process.execPath, [ELEV_DIFF, refDir, probeDir, '--top', '8'], { encoding: 'utf8' });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

async function compareBands(file, ctx, movedCl, tmp) {
  const refAll = path.join(tmp, 'ref-all');
  execFileSync(process.execPath, ['--import', './scripts/testSetup.mjs', DUMP_FIG, refAll, file, '--regen', `--move=${movedCl.id}:${MOVE_MM}`],
    { cwd: APP_DIR, stdio: ['ignore', 'ignore', 'ignore'] });
  const refDir = path.join(tmp, 'ref');
  fs.mkdirSync(refDir, { recursive: true });
  const fname = floorFile(ctx.plane.name);
  fs.copyFileSync(path.join(refAll, fname), path.join(refDir, fname));
  const probeDir = path.join(tmp, 'probe');
  const { rows, sameNeighbors } = await dumpBandsOfActive(ctx, probeDir);
  const prims = rows.reduce((n, r) => n + (r.count ?? 0), 0);
  console.log(`  帯比較(境界あり): 階${ctx.plane.name} 部屋${rows.length} プリミティブ${prims} 上下の隣=planes と orderedTabs ${sameNeighbors ? '同じ' : '**異なる**'}`);
  const withB = diffReport(refDir, probeDir);
  console.log(`  [境界あり vs --regen --move] exit=${withB.exit}\n${withB.out.split('\n').map(l => `    ${l}`).join('\n')}`);

  // 切り分け: 両側から柱・梁・梁芯を除いて再比較（境界あり側は自階の柱・梁を消すので、境界ありの通常比較より後）
  const refStripAll = path.join(tmp, 'ref-strip-all');
  execFileSync(process.execPath, ['--import', './scripts/testSetup.mjs', DUMP_FIG, refStripAll, file, '--regen', '--strip-struct', `--move=${movedCl.id}:${MOVE_MM}`],
    { cwd: APP_DIR, stdio: ['ignore', 'ignore', 'ignore'] });
  const refStripDir = path.join(tmp, 'ref-strip');
  fs.mkdirSync(refStripDir, { recursive: true });
  fs.copyFileSync(path.join(refStripAll, fname), path.join(refStripDir, fname));
  const probeStripDir = path.join(tmp, 'probe-strip');
  await dumpBandsOfActive(ctx, probeStripDir, { strip: true });
  const st = diffReport(refStripDir, probeStripDir);
  console.log(`  [境界あり vs --regen --move、両側の柱・梁・梁芯を除去] exit=${st.exit}（0 なら差は柱・梁・梁芯だけ）\n${st.out.split('\n').map(l => `    ${l}`).join('\n')}`);

  // 検出力: 境界を呼ばない（移動しただけ＝壁が古いまま）帯。新しく読み直して移動のみ。
  // 判定は柱・梁除去側だけ（通常側は起動相当の構造再計算の差を含む参考値）。
  const ctx0 = await setup(file, ctx.plane.name);
  moveCenterLine(ctx0.project, `${movedCl.id}:${MOVE_MM}`);
  const noDir = path.join(tmp, 'noboundary');
  await dumpBandsOfActive(ctx0, noDir);
  const without = diffReport(refDir, noDir);
  console.log(`  [境界なし(移動のみ) vs --regen --move] exit=${without.exit}（参考。柱・梁は起動時の構造再計算の差を含む）\n${without.out.split('\n').map(l => `    ${l}`).join('\n')}`);
  const noStripDir = path.join(tmp, 'noboundary-strip');
  await dumpBandsOfActive(ctx0, noStripDir, { strip: true });
  const withoutStrip = diffReport(refStripDir, noStripDir);
  console.log(`  [境界なし(移動のみ) vs --regen --move、両側の柱・梁・梁芯を除去] exit=${withoutStrip.exit}（検出力の判定はこちら: 壁が古いことによる差が残れば 1）\n${withoutStrip.out.split('\n').map(l => `    ${l}`).join('\n')}`);
}

// ---- 本体 ----
for (const file of docs) {
  console.log(`\n==================== ${file} ====================`);
  for (const floorName of floorNames) {
    try {
      const ctx = await setup(file, floorName);
      if (!ctx) { console.log(`-- ${floorName}: 無し（planes: ${loadDocument(file).project.planes.map(p => p.name).join(',')}）`); continue; }
      console.log(`\n-- ${floorName}（planes ${ctx.project.planes.map(p => p.name).join(',')}）起動時の全階再生成: ${ctx.boot.map(b => JSON.stringify(b)).join(' → ')}`);
      console.log(`  鍵計算 ${ms(keyCostMs(ctx))}ms/階`);

      // (a) 鍵一致
      const A = [];
      for (let i = 0; i < 5; i++) A.push(await runEntry(ctx));
      const aChanged = A.every(x => x.changed.length === 0);
      const aUndo = A.every(x => x.undoDelta === 0);
      console.log(`  (a) 鍵一致 x5: 中央値 ${ms(median(A.map(x => x.total)))}ms（${A.map(x => ms(x.total)).join(' / ')}）changed 毎回[] ${aChanged ? 'OK' : 'NG'} undo 不変 ${aUndo ? 'OK' : 'NG'}`);
      console.log(`      ${fmtRow('内訳(中央値の回に近い=3回目)', A[2])}`);

      // (b) 不一致（1 回目はこの ctx、2・3 回目は読み直し）
      const u0 = undoManager._undoStack.length;
      const moved = moveCenterLine(ctx.project, moveSpec);
      const moveUndo = undoManager._undoStack.length - u0;
      const mismatch = wallFreshnessKey(ctx.project.activeGraph, ctx.project) !== ctx.project.activeGraph.wallFreshnessKey;
      console.log(`  移動: ${moved.cl.label || moved.cl.id}（id ${moved.cl.id}）${moved.from} → ${moved.to}、移動自身の undo +${moveUndo}、自階の鍵不一致 ${mismatch}`);
      const B = [];
      B.push(await runEntry(ctx));
      console.log(`  (b)#1 ${fmtRow('', B[0])}`);
      const again = await runEntry(ctx);
      console.log(`  収束: 直後の再実行 changed ${JSON.stringify(again.changed)} undo+${again.undoDelta} ${again.changed.length === 0 && again.undoDelta === 0 ? 'OK' : 'NG'}（${ms(again.total)}ms）`);
      if (!noBands) {
        const tmp = keepDir ? fs.mkdtempSync(path.join(keepDir, 'vep-')) : fs.mkdtempSync(path.join(os.tmpdir(), 'viewEntryProbe-'));
        try { await compareBands(file, ctx, moved.cl, tmp); } finally { if (!keepDir) fs.rmSync(tmp, { recursive: true, force: true }); }
      }
      for (let k = 2; k <= 3; k++) {
        const c = await setup(file, floorName);
        moveCenterLine(c.project, `${moved.cl.id}:${MOVE_MM}`);
        B.push(await runEntry(c));
        console.log(`  (b)#${k} ${fmtRow('', B[k - 1])}`);
      }
      console.log(`  (b) 不一致 x3: 中央値 ${ms(median(B.map(x => x.total)))}ms`);
    } catch (e) {
      console.error(`NG ${file} ${floorName}:`, e);
      process.exitCode = 1;
    }
  }
}
