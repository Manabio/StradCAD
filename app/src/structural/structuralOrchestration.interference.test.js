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
// addDefaultDimensionLines・buildWoodFloorForB1・buildCLResolver・normalizeStructEntity・
// allFieldsDumpForGraph・dumpB1AllFloorsAllFields は structuralOrchestration.test.js と共有する
// structuralOrchestrationFixtures.js（同ディレクトリ・非test.jsの共有モジュール）から import する
// （B-7是正・2026-09-21。かつては複製していたが、内容の乖離を避けるため集約した）。
// buildMinimalReflectFixture・buildMinimalReflectFixtureFootprint は本ファイル固有（他のテスト
// ファイルは使わない最小フィクスチャのため、共有モジュールへは出さない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { saveFloor } from '../storage/db.js';
import { serializeGraph } from '../graphSnapshot.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { reflectStructuralToOtherFloors } from './structuralOrchestration.js';
import { addDefaultDimensionLines, buildWoodFloorForB1, dumpB1AllFloorsAllFields } from './structuralOrchestrationFixtures.js';

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

// 【B-6・失敗系（フットプリント版）】専用フィクスチャ: buildMinimalReflectFixtureと同じ土台に、
// X方向のグリッドをもう1コマ（gx1..gx2）足し、1階はその2コマ分を最初から1部屋（矩形1つ）で覆う一方、
// 2階は手前のコマ（gx0..gx1）だけの部屋にしておく——奥のコマ（gx1..gx2）を「部屋の無いセル」として
// 用意する（1階には既に奥コマまで届く壁があるため、干渉で2階側のRoom.cellsへ奥コマを追加するだけで
// 鉛直連続性ゲート（wallGate.js buildStructuralWallGate＝基準階＋直下の全階のAND。本フィクスチャは
// 2階建てなので2階×1階）が変わり、1階の壁から
// 導かれる梁のスパン・本数が変わる——壁を1枚も増やさずにfootprintCacheの陳腐化だけを検出できる構成。
// scratchpad実験（node --import ./scripts/testSetup.mjs で直接recomputeStructuralForGraphを往復）で
// 確認済み: 2階のRoom.cellsへ奥コマを追加するだけで、1階の奥コマ分の壁（x:3640..7280）に沿う通し梁が
// 2階側にも新たに生成される（cellB追加前は通し梁が0..3640で止まっていたが、追加後は0..7280まで伸びる）。
function buildMinimalReflectFixtureFootprint(idSuffix) {
  const project = new Project(`proj-minor2fp-${idSuffix}`, 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const gx0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gx2 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 7280, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const cellA = `${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`; // 手前コマ（両階とも最初から部屋あり）
  const cellB = `${gx1.id}:${gy0.id}:${gx2.id}:${gy1.id}`; // 奥コマ（1階のみ最初から部屋あり）

  const { graph: g1 } = project.addPlane(0, '1階', `f1${idSuffix}`);
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  addDefaultDimensionLines(g1);
  const room1 = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx2.id}:${gy1.id}`]), 'A'); // 手前+奥を1矩形で
  generateRoomWallsFromOutline(g1, room1);

  const { graph: g2 } = project.addPlane(3000, '2階', `f2${idSuffix}`);
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  addDefaultDimensionLines(g2);
  const room2 = g2.addRoom(new Set([cellA]), 'A'); // 手前コマだけ
  generateRoomWallsFromOutline(g2, room2);

  return { project, g1, g2, cellB };
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

// ==== 【B-6・失敗系】反映の最中に他経路が保持済み階をフットプリント（部屋セル）ごと書き換えても
// 最終結果は一致する ====
// 上記2本（柱の削除・壁の追加）はどちらもwallSourceCache寄りの干渉——柱削除はcolumnAxisOffsets等
// 経由の間接効果、壁追加はwallSourceCacheが直接キーにする壁区間そのものを変える。footprintCache
// （wallGate.js createFootprintCache。鉛直連続性ゲート＝基準階＋直下の全階のフットプリントAND）の陳腐化は
// このどちらでも検出できない——柱削除・壁追加はどちらも「壁は動かすが部屋（フットプリント）は動かさない」
// 干渉のため、footprintCacheが古いインスタンスを誤って返しても、footprintの中身自体は変わっていない
// （プローブの答えが同じ）ので結果が分かれない。
// そこで干渉の中身を「保持済みの階（2階）のRoomへセルを1つ追加してフットプリントを広げる」に変える。
// buildMinimalReflectFixtureFootprint（上記）が用意する「部屋の無いセル」（1階は最初から手前+奥の
// 2コマを1部屋で覆うが、2階は手前コマだけ）を使う——1階には既に奥コマまで届く壁があるため、2階の
// フットプリントが奥コマへ広がると鉛直連続性ゲートが変わり、1階の壁から導かれる通し梁のスパンが
// 0..3640から0..7280へ伸びる（壁は1枚も増やしていない。scratchpad実験で確認済み・上記フィクスチャの
// コメント参照）。fresh cache（正しく再走査）は広がったフットプリントを反映するが、stale cache
// （古いインスタンスのフットプリント索引を誤って流用）は広がりを見落とす——両者の最終ダンプが必ず
// 分かれるため、footprintCacheの陳腐化を検出できる。
// タイミング・put回数の数え方は上記2本と同じ最小フィクスチャの2階建て・屋根なし・同じonFloorsPutフック
// の規律（n===3＝2階のcollect書込み直後）を再利用する。
async function runMinimalReflectScenarioFootprintInterference(state, idSuffix, ctxOption) {
  const { project, g1, g2, cellB } = buildMinimalReflectFixtureFootprint(idSuffix);
  const plane2 = project.planes[1];
  state.phase = { n: 0, project, plane2, cellB, interferenceDone: null };
  await saveFloor(project.planes[0].id, serializeGraph(g1));
  await saveFloor(project.planes[1].id, serializeGraph(g2));
  project.activePlaneId = project.planes[0].id; // 1階をアクティブにする（2階だけが反映対象）
  await reflectStructuralToOtherFloors(project, ctxOption);
  if (state.phase.interferenceDone) await state.phase.interferenceDone;
  state.phase = null;
  return dumpB1AllFloorsAllFields(project);
}

test('【B-6・失敗系】reflectStructuralToOtherFloors: collect完了後・採番適用前に他経路が保持済み階へ部屋（フットプリント）を1つ追加しても、古い保持を返さず最終結果がctx:null（従来経路）と全フィールド一致する', async () => {
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
        // buildMinimalReflectFixtureFootprintが2階に作った唯一の部屋（名前'A'）へ、奥コマ（cellB）を
        // 追加する——壁は一切増やさない（Room.cellsだけを拡張する。既存Roomのcellsを1セル拡張する版）。
        const room = other.rooms.find(r => r.name === 'A');
        runInAction(() => { room.addCell(phase.cellB); });
        await saveFloor(phase.plane2.id, serializeGraph(other));
      })();
    }
  };
  try {
    // ---- シナリオ1: ctx:null（従来経路）----
    const traditional = await runMinimalReflectScenarioFootprintInterference(state, 'fn', null);
    // ---- シナリオ2: ctx省略（自前生成）----
    const owned = await runMinimalReflectScenarioFootprintInterference(state, 'fu', undefined);

    assert.equal(fired, 2, '干渉が発火していない＝このテストは何も検証していない（ctx:null・ctx省略の両シナリオで1回ずつ発火するはず）');
    assert.deepEqual(owned, traditional,
      'フットプリントを広げる干渉が同じタイミングで入っても、ctx省略の最終結果はctx:null（従来経路）で同じ干渉を入れた場合と全フィールド一致する');
  } finally {
    onFloorsPutHook = null;
  }
});
