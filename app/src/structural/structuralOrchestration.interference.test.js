// 【干渉系テスト専用ファイル】（構造再計算の高速化・B-6差し戻し対応・2026-09-21）
//
// なぜ別ファイルか: storage/db.js の openDB() は接続 Promise をモジュールスコープの _dbPromise
// （非export）へキャッシュし、以後は globalThis.indexedDB の差し替えを無視して同じ接続を使い続ける
// （openDB() 参照。テスト用のリセット口を製品コードへ足すのは今回禁止）。structuralOrchestration.test.js
// は1ファイル内に多数の test() があり、ある test が saveFloor/peek 経由で最初に openDB() を成功させると、
// それ以降の test（本ファイルが元々持っていた【B-5・失敗系】【B-6・失敗系】を含む）が個別に用意する
// fakeDb・put フックは _dbPromise 越しに一切使われず、"干渉が一度も発火しないまま緑を装う" 空振りに
// なっていた（実測で発見。node --test の実行順では元ファイル内の他の test が先に openDB() を成功させる
// ため、単独実行（--test-name-pattern）でしか発火せず、npm test の全体実行では常に空振りだった）。
//
// node:test はテスト**ファイル**ごとに別プロセスへ分離される（同一ファイル内の複数 test() はプロセスを
// 共有するが、ファイルをまたぐと共有しない）ため、干渉フックに依存するこの2本だけを本ファイルへ切り出し、
// fakeDb を「このファイルの最初の import 時に1個だけ」作って module scope に固定する
// （storage/floorWriteGeneration.db.test.js と同じ方針——同ファイルのコメント参照）。これにより
// _dbPromise がこのプロセスで最初に解決する先が必ずこの fakeDb になり、干渉フックが確実に発火する。
//
// onFloorsPut 相当のフックは固定クロージャではなく「差し替え可能な変数」（onFloorsPutHook）にする——
// 元ファイルの withFakeIndexedDB は「1回のtest()呼び出しにつきnew FakeDBし直す」設計だったが、それ自体が
// _dbPromise キャッシュと相性が悪い（2回目以降のnew FakeDBが黙って無視される）ため、本ファイルでは
// fakeDb を使い回しつつフック本体だけを test ごとに差し替える。テスト間のデータ衝突は
// (a) 各 test の先頭で floors/projects/savedFloors を空にする、(b) planeId のサフィックスを
// シナリオごとに変える、の両方で防ぐ。
//
// buildWoodFloorForB1・buildMinimalReflectFixture・dumpB1AllFloorsAllFields 一式は
// structuralOrchestration.test.js から複製している（あちらは他の多数の test が使い続けるため移動できない。
// export もされていないテスト内部ヘルパのため import 共有もできない）。内容の乖離を避けたい場合は
// 両ファイルを見比べること。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import {
  Project, CenterLineType, Discipline,
  HDimensionLine, VDimensionLine, DimensionKind, DimensionSide,
} from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { saveFloor } from '../storage/db.js';
import { serializeGraph } from '../graphSnapshot.js';
import { decode } from '../schema/graphFbs.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { reflectStructuralToOtherFloors } from './structuralOrchestration.js';

// ---- module-level fake IndexedDB（このファイルで1個だけ。storage/floorWriteGeneration.db.test.jsと同じ方針）----
class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
// 差し替え可能な干渉フック——各 test が自分のシナリオの間だけセットし、finally で必ず null に戻す。
let onFloorsPutHook = null;
class FakeStore {
  constructor(isFloors) { this.data = new Map(); this.isFloors = isFloors; }
  put(value) {
    const req = new FakeRequest();
    this.data.set(value.planeId ?? value.projectId, value);
    if (this.isFloors) onFloorsPutHook?.(value);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
  get(key) {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } }));
    return req;
  }
}
const fakeStores = {
  floors: new FakeStore(true),
  projects: new FakeStore(false),
  savedFloors: new FakeStore(false),
};
const fakeDb = {
  objectStoreNames: { contains: (n) => n in fakeStores },
  transaction(name) { const store = fakeStores[name]; return { objectStore: () => store }; },
};
globalThis.indexedDB = {
  open() {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } }));
    return req;
  },
};

// 各 test の先頭で呼ぶ——fakeDb インスタンス自体は使い回すが、中身は test ごとに空にする
// （コーディネーター指示: 「テストごとに plane id を変えるか、開始時に floors ストアを空にする」の両方）。
function resetFakeStores() {
  fakeStores.floors.data.clear();
  fakeStores.projects.data.clear();
  fakeStores.savedFloors.data.clear();
}

// ---- buildWoodFloorForB1・buildMinimalReflectFixture（structuralOrchestration.test.jsから複製）----
function addDefaultDimensionLines(graph) {
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.RIGHT });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT });
}

function buildWoodFloorForB1(project, elevation, name, id, gridCLs) {
  const { graph } = project.addPlane(elevation, name, id);
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  addDefaultDimensionLines(graph);
  const { gx0, gx1, gy0, gy1 } = gridCLs;
  const room = graph.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(graph, room);
  return graph;
}

// 1階・2階のid をサフィックスで振り分ける——両シナリオ（ctx:null／ctx省略）を「1回のフックスコープの
// 中で順番に」走らせるため（id を分けて共有fakeストア内で衝突しないようにする）。
function buildMinimalReflectFixture(idSuffix) {
  const project = new Project(`proj-minor2-${idSuffix}`, 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const gx0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const gridCLs = { gx0, gx1, gy0, gy1 };
  const g1 = buildWoodFloorForB1(project, 0,    '1階', `m1${idSuffix}`, gridCLs);
  const g2 = buildWoodFloorForB1(project, 3000, '2階', `m2${idSuffix}`, gridCLs);
  // 屋根は意図的に作らない（syncRoofPlaneを呼ばない）——project.roofPlaneがnullのまま残り、
  // reflectRoofPlane（reflectStructuralToOtherFloors内）は早期returnして無関与になる
  // （収束パス数を対象階1つの収束だけに単純化するため）。
  return { project, g1, g2 };
}

// ---- 全フィールド意味ダンプ（structuralOrchestration.test.jsのallFieldsDumpForGraph一式を複製）----
const UUID_RE_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CL_REF_FIELD_KEYS = new Set(['verticalCLId', 'horizontalCLId', 'axisCLId', 'clStartId', 'clEndId', 'clId']);

function buildCLResolver(g) {
  const clById = new Map(g.centerLines.map(cl => [cl.id, cl]));
  const resolveId = (id) => {
    if (id == null) return 'null';
    const cl = clById.get(id);
    return cl ? `${cl.centerLineType}:${Math.round(cl.effectiveValue)}` : `?${id}`;
  };
  const resolveComposite = (s) => s.replace(UUID_RE_GLOBAL, (id) => {
    const cl = clById.get(id);
    return cl ? `${cl.centerLineType}:${Math.round(cl.effectiveValue)}` : id;
  });
  return { resolveId, resolveComposite };
}

function normalizeStructEntity(v, resolver) {
  const parts = [];
  for (const k of Object.keys(v).sort()) {
    if (k === 'id' || k === 'extraKeys' || k === 'extraVals') continue;
    if (CL_REF_FIELD_KEYS.has(k)) {
      parts.push(`${k}=${v[k] == null ? 'null' : resolver.resolveId(v[k])}`);
    } else {
      parts.push(`${k}=${JSON.stringify(v[k])}`);
    }
  }
  if (Array.isArray(v.extraKeys)) {
    v.extraKeys.forEach((k, i) => parts.push(`extra.${k}=${v.extraVals[i]}`));
  }
  return parts.join('|');
}

function allFieldsDumpForGraph(g) {
  const snap = decode(serializeGraph(g));
  const resolver = buildCLResolver(g);
  const columns = snap.columns.map(c => normalizeStructEntity(c, resolver)).sort();
  const beams = snap.beams.map(b => normalizeStructEntity(b, resolver)).sort();
  const footings = snap.footings.map(f => normalizeStructEntity(f, resolver)).sort();
  const slabs = snap.slabs.map(s => {
    const parts = [];
    for (const k of Object.keys(s).sort()) {
      if (k === 'id' || k === 'extraKeys' || k === 'extraVals' || k === 'cells') continue;
      parts.push(`${k}=${JSON.stringify(s[k])}`);
    }
    parts.push(`cells=${JSON.stringify([...s.cells].map(resolver.resolveComposite).sort())}`);
    if (Array.isArray(s.extraKeys)) s.extraKeys.forEach((k, i) => parts.push(`extra.${k}=${s.extraVals[i]}`));
    return parts.join('|');
  }).sort();
  const excludedColumnSlots  = snap.excludedColumnSlots.map(resolver.resolveComposite).sort();
  const excludedBeamSlots    = snap.excludedBeamSlots.map(resolver.resolveComposite).sort();
  const excludedFootingSlots = snap.excludedFootingSlots.map(resolver.resolveComposite).sort();
  const excludedWallBeamAxes = snap.excludedWallBeamAxes.map(resolver.resolveComposite).sort();
  const columnAxisOffsets = snap.columnAxisOffsetKeys
    .map((clId, i) => `${resolver.resolveId(clId)}=${snap.columnAxisOffsetVals[i]}`)
    .sort();
  const fuseCLs = g.centerLines
    .filter(cl => cl.discipline === Discipline.FUSE)
    .map(cl => `${cl.centerLineType}:${Math.round(cl.effectiveValue)}:` +
      `${cl.extentLo == null ? 'null' : Math.round(cl.extentLo)}..${cl.extentHi == null ? 'null' : Math.round(cl.extentHi)}`)
    .sort();
  const clEccentricities = snap.clEccentricities.map(e => normalizeStructEntity(e, resolver)).sort();
  const structureOverride = snap.structureOverride ?? 'null';
  const woodColumnWidthMm = snap.woodColumnWidthMm ?? 'null';
  return {
    columns, beams, footings, slabs, excludedColumnSlots, excludedBeamSlots, excludedFootingSlots, excludedWallBeamAxes,
    columnAxisOffsets, fuseCLs, clEccentricities, structureOverride, woodColumnWidthMm,
  };
}

async function dumpB1AllFloorsAllFields(project) {
  const out = {};
  for (const p of [...project.planes, project.roofPlane].filter(Boolean)) {
    const g = p.id === project.activePlaneId ? project.activeGraph : await floorSwapManager.peek(p, project.structGraph);
    out[p.name] = allFieldsDumpForGraph(g);
  }
  return out;
}

// ==== 【B-5・失敗系】反映の最中に他経路が保持済み階を柱ごと書き換えても最終結果は一致する ====
// put順序（本フィクスチャでの実測・固定値。シナリオごとに1-2=初期保存(1階,2階)
// 3=collectの2階書込み——屋根が無いため1パスで収束・2パス目は書込み無しの確認のみ）
// 4-=apply（2階のみ）。3回目のput（collectの2階書込み）の直後に割り込む——2階の柱を1本
// `removeColumn`で削除する（excludedColumnSlotsへ記録されるため、確認パス・apply処理では
// 自動補完で復活しない「再計算で復活しない変更」）。干渉後にapplyMemberNumbersToFloor(2階)が
// 読む内容が、干渉を正しく検知して読み直した場合と、古い保持を返す場合とで分かれる——
// このテストにはinvalidatedカウンタのassertを入れず、最終ダンプの内容だけで判定する
// （コーディネーター指示）。
async function runMinimalReflectScenario(state, idSuffix, ctxOption) {
  const { project, g1, g2 } = buildMinimalReflectFixture(idSuffix);
  const plane2 = project.planes[1];
  // 初期保存2回（put順序1-2）も含めてこのシナリオのカウンタ（n=0起点）で数える——
  // state.phaseは初期保存より前にセットする（put順序1-2が数えられずトリガのnがずれて
  // 干渉が一度も発火しない不具合を防ぐため）。
  state.phase = { n: 0, project, plane2, interferenceDone: null };
  await saveFloor(project.planes[0].id, serializeGraph(g1));
  await saveFloor(project.planes[1].id, serializeGraph(g2));
  project.activePlaneId = project.planes[0].id; // 1階をアクティブにする（2階だけが反映対象）
  await reflectStructuralToOtherFloors(project, ctxOption);
  // 干渉（onFloorsPutフック内で非同期に開始）の完了を待ってから返す——待たずに次のシナリオへ
  // 進むと、干渉のsaveFloorが未完了のまま次シナリオのput回数とフックへ紛れ込む恐れがある。
  if (state.phase.interferenceDone) await state.phase.interferenceDone;
  state.phase = null;
  return dumpB1AllFloorsAllFields(project);
}

test('【B-5・失敗系】reflectStructuralToOtherFloors: collect完了後・採番適用前に他経路が保持済み階を書き換えても、古い保持を返さず最終結果がctx:null（従来経路）と全フィールド一致する', async () => {
  resetFakeStores();
  const state = { phase: null };
  let fired = 0; // 干渉フックが実際に発火した回数（両シナリオで1回ずつ＝期待2）
  onFloorsPutHook = () => {
    const phase = state.phase;
    if (!phase) return;
    phase.n++;
    if (phase.n === 3) {
      fired++;
      phase.interferenceDone = (async () => {
        const other = await floorSwapManager.peek(phase.plane2, phase.project.structGraph);
        const victim = other.columns[0];
        if (victim) runInAction(() => other.removeColumn(victim.id));
        await saveFloor(phase.plane2.id, serializeGraph(other));
      })();
    }
  };
  try {
    // ---- シナリオ1: ctx:null（従来経路）----
    const traditional = await runMinimalReflectScenario(state, 'n', null);
    // ---- シナリオ2: ctx省略（自前生成）----
    const owned = await runMinimalReflectScenario(state, 'u', undefined);

    assert.equal(fired, 2, '干渉が発火していない＝このテストは何も検証していない（ctx:null・ctx省略の両シナリオで1回ずつ発火するはず）');
    assert.deepEqual(owned, traditional,
      'collect完了後・apply直前に他経路が2階を書き換えても、ctx省略の最終結果はctx:null（従来経路）で同じ干渉を入れた場合と全フィールド一致する');
  } finally {
    onFloorsPutHook = null;
  }
});

// ==== 【B-6・失敗系】反映の最中に他経路が保持済み階を壁ごと書き換えても最終結果は一致する ====
// 【B-5・失敗系】（上記）は柱1本の削除で干渉したが、B-6が追加したwallSourceCache/footprintCacheの
// 使い回しは壁・部屋を直接キーにするため、干渉の対象を「壁そのもの」にした版を別途固定する。
// **削除ではなく追加で干渉する**——壁由来の梁芯CL（discipline:FUSE）は「対応先の壁が無くなっても
// 撤去しない」設計（wallBeamAxes.js冒頭のコメント参照）のため、壁を1枚削除する干渉は「1回目の
// recomputeで既に生成済みの梁芯CL・柱・梁」に対しては無検出力（stale cacheでもfresh cacheでも
// 結果が変わらない）。壁を1枚**追加**する干渉なら、fresh cache（正しく再走査）は新しい梁芯CL・
// 柱・梁を追加で生成するが、stale cache（古いインスタンスの壁区間を誤って流用）は追加を見落とす——
// 両者の最終ダンプが必ず分かれるため、この干渉のほうが検出力を持つ。
// タイミング・put回数の数え方は【B-5・失敗系】と同じ最小フィクスチャ（buildMinimalReflectFixture。
// 屋根なし・非アクティブ階1つだけ）・同じonFloorsPutフックの規律（n===3＝2階のcollect書込み直後）を
// 再利用する。
async function runMinimalReflectScenarioWallInterference(state, idSuffix, ctxOption) {
  const { project, g1, g2 } = buildMinimalReflectFixture(idSuffix);
  const plane2 = project.planes[1];
  state.phase = { n: 0, project, plane2, interferenceDone: null };
  await saveFloor(project.planes[0].id, serializeGraph(g1));
  await saveFloor(project.planes[1].id, serializeGraph(g2));
  project.activePlaneId = project.planes[0].id; // 1階をアクティブにする（2階だけが反映対象）
  await reflectStructuralToOtherFloors(project, ctxOption);
  if (state.phase.interferenceDone) await state.phase.interferenceDone;
  state.phase = null;
  return dumpB1AllFloorsAllFields(project);
}

test('【B-6・失敗系】reflectStructuralToOtherFloors: collect完了後・採番適用前に他経路が保持済み階へ壁を1枚追加しても、古い保持を返さず最終結果がctx:null（従来経路）と全フィールド一致する', async () => {
  resetFakeStores();
  const state = { phase: null };
  let fired = 0; // 干渉フックが実際に発火した回数（両シナリオで1回ずつ＝期待2）
  onFloorsPutHook = () => {
    const phase = state.phase;
    if (!phase) return;
    phase.n++;
    if (phase.n === 3) {
      fired++;
      phase.interferenceDone = (async () => {
        const other = await floorSwapManager.peek(phase.plane2, phase.project.structGraph);
        // buildWoodFloorForB1と同じ通り芯（project.structGraph、x:0/3640・y:0/1820）の内部に、
        // 既存の四周壁（generateRoomWallsFromOutline生成）には無い新規の間仕切り壁を1本足す
        // （x=1820の縦壁。y方向は通り芯y0..y1いっぱい）。
        const gy0 = other.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && Math.abs(cl.effectiveValue - 0) < 1);
        const gy1 = other.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && Math.abs(cl.effectiveValue - 1820) < 1);
        runInAction(() => {
          const axisCL = other.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: false, discipline: Discipline.ARCH });
          other.addWall(axisCL, 0, true, gy0, 0, gy1, 0,
            { isExteriorWall: false, backingOffset: 0, backingDepth: 120, bandOffset: null, wallFinish: 12.5 });
        });
        await saveFloor(phase.plane2.id, serializeGraph(other));
      })();
    }
  };
  try {
    // ---- シナリオ1: ctx:null（従来経路）----
    const traditional = await runMinimalReflectScenarioWallInterference(state, 'wn', null);
    // ---- シナリオ2: ctx省略（自前生成）----
    const owned = await runMinimalReflectScenarioWallInterference(state, 'wu', undefined);

    assert.equal(fired, 2, '干渉が発火していない＝このテストは何も検証していない（ctx:null・ctx省略の両シナリオで1回ずつ発火するはず）');
    assert.deepEqual(owned, traditional,
      '壁を1枚追加する干渉が同じタイミングで入っても、ctx省略の最終結果はctx:null（従来経路）で同じ干渉を入れた場合と全フィールド一致する');
  } finally {
    onFloorsPutHook = null;
  }
});
