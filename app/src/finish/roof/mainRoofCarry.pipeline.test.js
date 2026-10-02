// 【階追加の本番 follower 列を通す専用テストファイル】（B3 QA 指摘 T-X2）
//
// 本物の saveFloor・floorSwapManager.peek・floorOrderFollowers（INSERT の全 follower）を applyFloorOrderChange で
// 通し、主屋根の引き継ぎ（mainRoofCarry）が先行 follower（外壁内側の部屋の自動追加など）が新階へ書いた内容を
// 消さないこと、mainRoofCarry による保存が1回だけであることを固定する。
//
// なぜ別ファイルか: storage/db.js の openDB() は接続をモジュールスコープにキャッシュし、以後の
// globalThis.indexedDB の差し替えを無視する。同じファイルの別テストが先に openDB() を成功させると、ここの
// フック（保存の記録）が空振りのまま緑になる（team-lessons「変異テストの赤を単独実行で確かめ、全体実行では
// 空振りのまま緑だった」）。node:test はファイル単位で別プロセスのため、fake IDB をこのファイルのモジュール
// レベルで1個だけ作る（前例: structural/structuralOrchestration.interference.test.js）。さらに、記録が
// 実際に発火した回数（保存の回数）を assert し、発火しなければ赤になる形にしている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlanGraph, CenterLineType, Discipline, RoofSpec, isDefaultRoofSpec } from '../../core.js';
import { saveFloor, loadFloor } from '../../storage/db.js';
import { serializeGraph, restoreGraph, decodeFloorSnapshot } from '../../graphSnapshot.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from '../../floorOrderChange.js';
import { computeFloorInsert } from '../../floorOps.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';
import { addDefaultDimensionLines, buildWoodFloorForB1 } from '../../structural/structuralOrchestrationFixtures.js';
import { NON_DEFAULT_ROOF_SPEC } from '../roofTestFixtures.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ---- module-level fake IndexedDB（このファイルで1個だけ）----
class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
// floors ストアへの保存の記録 [その時走っていた follower 名, planeId]
const putLog = [];
let currentFollower = '(setup)';
class FakeStore {
  constructor(isFloors) { this.data = new Map(); this.isFloors = isFloors; }
  put(value) {
    const req = new FakeRequest();
    const key = value.planeId ?? value.projectId;
    this.data.set(key, value);
    if (this.isFloors) putLog.push([currentFollower, key]);
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

/** 1階だけの在来木造プロジェクト（1階に主屋根 TOPVALUE を設定）。 */
function buildProject(suffix, { mainRoof }) {
  const project = new Project(`proj-carry-${suffix}`, 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const gx0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const g1 = buildWoodFloorForB1(project, 0, '1階', `f1-${suffix}`, { gx0, gx1, gy0, gy1 });
  // exteriorRoom follower は「元階に外壁（isExteriorWall）がある」ときだけ新階へ部屋を書く
  for (const w of g1.walls) w.isExteriorWall = true;
  if (mainRoof) g1.setMainRoofSpec(RoofSpec.fromData({ ...NON_DEFAULT_ROOF_SPEC, note: 'TOPVALUE' }));
  return { project, g1 };
}

/** 上に階を1つ追加する（INSERT の全 follower を本番の登録どおり通す）。carry=false なら mainRoofCarry だけ外す。 */
async function insertUpper(project, g1, newId, { carry }) {
  const followers = floorOrderFollowers
    .filter(f => carry || f.name !== 'mainRoofCarry')
    .map(f => ({ ...f, run: async (ctx) => { currentFollower = f.name; try { return await f.run(ctx); } finally { currentFollower = '(other)'; } } }));
  const ins = computeFloorInsert(project.planes, project.planes[project.planes.length - 1].id, 1);
  putLog.length = 0;
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates: ins.updates,
    sourceGraph: g1,
    newStartFloor: ins.newPlane.startFloor,
    addPlane: () => {
      const r = project.addPlane(ins.newPlane.elevation, ins.newPlane.name, newId, ins.newPlane.startFloor, ins.newPlane.stories);
      addDefaultDimensionLines(r.graph);
      return r;
    },
    ui: { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} },
  }, followers);
  const puts = putLog.filter(([, planeId]) => planeId === newId).map(([f]) => f);
  const bytes = await loadFloor(newId);
  const graph = new PlanGraph(project.planeMap.get(newId));
  graph._structGraph = project.structGraph;
  restoreGraph(graph, bytes);
  return { puts, bytes, graph };
}

async function seed(project) {
  for (const [planeId, g] of project.graphMap) await saveFloor(planeId, serializeGraph(g));
}

test('【B3・T-X2】最上階へ階を追加: 主屋根が新階へ写り、先行 follower（外壁内側の部屋）が新階へ書いた内容は残る。mainRoofCarry の保存は1回', async () => {
  const on = buildProject('on', { mainRoof: true });
  await seed(on.project);
  const resultOn = await insertUpper(on.project, on.g1, 'NEW-on', { carry: true });

  // 空振りしないことの確認: 先行 follower が新階へ書いている（部屋ができている）。carry の保存はちょうど1回。
  assert.ok(resultOn.puts.includes('exteriorRoom'), '前提: exteriorRoom follower が新階へ保存している（発火しないと検証にならない）');
  assert.equal(resultOn.puts.filter(f => f === 'mainRoofCarry').length, 1, 'mainRoofCarry による新階への保存は1回');
  assert.ok(resultOn.graph.rooms.length >= 1, '先行 follower が書いた部屋が残る');
  assert.equal(resultOn.graph.mainRoofSpec.note, 'TOPVALUE', '主屋根の値が新しい最上階へ写る');
  assert.deepEqual(resultOn.graph.mainRoofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC, note: 'TOPVALUE' });
  assert.equal(on.g1.mainRoofSpec.note, 'TOPVALUE', '旧最上階の値は残る');

  // carry なしと比べ、主屋根だけ既定へ戻した新階のバイト列が一致する（主屋根以外を一切変えていない）
  const off = buildProject('off', { mainRoof: true });
  await seed(off.project);
  const resultOff = await insertUpper(off.project, off.g1, 'NEW-off', { carry: false });
  assert.equal(resultOff.puts.filter(f => f === 'mainRoofCarry').length, 0, 'carry なしでは保存が無い');
  assert.equal(isDefaultRoofSpec(resultOff.graph.mainRoofSpec), true);

  // fixture は構築のたびに部材 id（UUID）が変わるため、UUID を伏せた全フィールドのダンプで比べる
  // （巨大な差分表示を避けるため文字列そのものではなく真偽で assert する）
  const normalize = (graph) => JSON.stringify(decodeFloorSnapshot(serializeGraph(graph))).replace(UUID_RE, '#');
  resultOn.graph.setMainRoofSpec(new RoofSpec());
  const dumpOn = normalize(resultOn.graph);
  const dumpOff = normalize(resultOff.graph);
  assert.ok(dumpOn.length > 1000, '前提: ダンプが空でない');
  assert.equal(dumpOn === dumpOff, true, '主屋根を既定へ戻せば、carry あり・なしで新階の全フィールドが一致する（carry は主屋根以外を変えない）');
});

test('【B3・T-X2】旧最上階の主屋根が既定値のままなら、mainRoofCarry は新階へ何も保存しない', async () => {
  const p = buildProject('default', { mainRoof: false });
  await seed(p.project);
  const result = await insertUpper(p.project, p.g1, 'NEW-default', { carry: true });
  assert.ok(result.puts.includes('exteriorRoom'), '前提: 他の follower は新階へ保存している');
  assert.equal(result.puts.filter(f => f === 'mainRoofCarry').length, 0, '既定値なら carry の保存は0回');
  assert.equal(isDefaultRoofSpec(result.graph.mainRoofSpec), true);
});
