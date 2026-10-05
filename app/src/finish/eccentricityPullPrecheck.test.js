// pullCLEccentricities の事前確認（loadFloorFn。他階に偏芯レコードが1件も無ければ peek しない）の回帰テスト。
// 他階のスタブは本番同型: Map のストアにバイト列を置き、peek は new PlanGraph → restoreGraph で復元する
// （生きたグラフは返さない）。loadFloorFn 省略＝旧経路（常に peek）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlanGraph, CenterLineType, Discipline, RoomFeature } from '../core.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph, decodeFloorSnapshot, floorBytesMayHaveClEccentricities } from '../graphSnapshot.js';
import { countClEccentricities } from '../schema/graphFbs.js';
import { runFinishEntryBoundary } from './finishBoundary.js';
import { loadMaterialMap } from './wallRegeneration.js';
import { pullCLEccentricities } from './eccentricityFloorSync.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

const REC = { mode: 'face', value: 0, side: 1, backing: '' };
// 安定ダンプ: 復元のたびに振り直される uuid（壁などの内部id）は '#' に正規化して比べる。
const hex = (g) => JSON.stringify(decodeFloorSnapshot(serializeGraph(g)))
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#');

// 直下階 below（部屋A1/B1）・自階 above（吹抜け/部屋A2）。吹抜け連動で above ⇔ below が結ばれる。
// 戻り値の store は各階のバイト列（Map）。
async function makeFixture() {
  const project = new Project('proj', 'test');
  const { graph: below } = project.addPlane(0, '1階', 'p1');
  const { graph: above } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === below.plane.id ? below : above);
  try {
    const grid = (g) => ({
      x0: g.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH }),
      x1: g.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH }),
      y0: g.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH }),
      ym: g.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH }),
      y1: g.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH }),
    });
    const b = grid(below);
    below.addRoom(new Set([`${b.x0.id}:${b.y0.id}:${b.x1.id}:${b.ym.id}`]), '部屋A1');
    below.addRoom(new Set([`${b.x0.id}:${b.ym.id}:${b.x1.id}:${b.y1.id}`]), '部屋B1');
    below.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    await runFinishEntryBoundary(below, project);
    const a = grid(above);
    above.addRoom(new Set([`${a.x0.id}:${a.y0.id}:${a.x1.id}:${a.ym.id}`]), '吹抜け').setFeature(RoomFeature.VOID);
    above.addRoom(new Set([`${a.x0.id}:${a.ym.id}:${a.x1.id}:${a.y1.id}`]), '部屋A2');
    above.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    await runFinishEntryBoundary(above, project);
    const materialMap = await loadMaterialMap();
    return { project, below, above, belowYm: b.ym, aboveYm: a.ym, materialMap };
  } finally {
    floorSwapManager.peek = orig;
  }
}

// 本番同型の他階スタブ。peek 回数と loadFloorFn 回数を数える。
function makeStubs(project, store) {
  const calls = { peek: 0, load: 0 };
  const peekFn = async (plane, structGraph) => {
    calls.peek++;
    const g = new PlanGraph(plane);
    g._structGraph = structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
  const loadFloorFn = async (planeId) => { calls.load++; return store.get(planeId) ?? null; };
  return { calls, peekFn, loadFloorFn };
}

// 自階 above を保存バイト列から復元した別インスタンス（新旧の比較で同じ入力を2回作る）
function freshActive(project, aboveBytes) {
  const plane = project.planes.find(p => p.id === 'p2');
  const g = new PlanGraph(plane);
  g._structGraph = project.structGraph;
  restoreGraph(g, aboveBytes);
  return g;
}

async function setup({ belowRec, aboveRec = false }) {
  const f = await makeFixture();
  if (belowRec) f.below.setCLEccentricity(f.belowYm.id, REC);
  if (aboveRec) f.above.setCLEccentricity(f.aboveYm.id, REC);
  const store = new Map([['p1', serializeGraph(f.below)], ['p2', serializeGraph(f.above)]]);
  return { ...f, store };
}

test('countClEccentricities: 偏芯レコード 0・1・3件の graph を本番 serializeGraph でバイト列にして、復元した graph の件数と一致する', async () => {
  const { below } = await makeFixture();
  const ids = [...below.centerLines.keys()];
  assert.ok(ids.length >= 3, '対象のCLが3本以上あること（空でない確認）');
  for (const n of [0, 1, 3]) {
    const g = new PlanGraph(below.plane);
    restoreGraph(g, serializeGraph(below));
    for (let i = 0; i < n; i++) g.setCLEccentricity(ids[i], REC);
    const bytes = serializeGraph(g);
    const restored = new PlanGraph(below.plane);
    restoreGraph(restored, bytes);
    assert.equal(restored.clEccentricities.size, n);
    assert.equal(countClEccentricities(bytes), n);
    assert.equal(floorBytesMayHaveClEccentricities(bytes), n > 0);
    assert.equal(floorBytesMayHaveClEccentricities(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), n > 0, 'ArrayBuffer も同じ');
  }
});

test('countClEccentricities【失敗系】: null・長さ0のバイト列は 0', () => {
  assert.equal(countClEccentricities(null), 0);
  assert.equal(countClEccentricities(undefined), 0);
  assert.equal(countClEccentricities(new Uint8Array(0)), 0);
});

test('floorBytesMayHaveClEccentricities: null・undefined・長さ0は false／0件のバイト列は false／JSON文字列などバイト列でないものは不明＝true', async () => {
  const { below } = await makeFixture();
  assert.equal(floorBytesMayHaveClEccentricities(null), false);
  assert.equal(floorBytesMayHaveClEccentricities(undefined), false);
  assert.equal(floorBytesMayHaveClEccentricities(new Uint8Array(0)), false);
  assert.equal(floorBytesMayHaveClEccentricities(new ArrayBuffer(0)), false);
  assert.equal(floorBytesMayHaveClEccentricities(serializeGraph(below)), false);
  below.setCLEccentricity([...below.centerLines.keys()][0], REC);
  assert.equal(floorBytesMayHaveClEccentricities(serializeGraph(below)), true);
  assert.equal(floorBytesMayHaveClEccentricities(JSON.stringify(decodeFloorSnapshot(serializeGraph(below)))), true, '文字列は不明＝true');
});

test('pull(a): loadFloorFn あり・他階が全部0件 → peek 0回で自階・undo・戻り値が不変', async () => {
  const s = await setup({ belowRec: false });
  const { calls, peekFn, loadFloorFn } = makeStubs(s.project, s.store);
  const active = freshActive(s.project, s.store.get('p2'));
  const before = hex(active);
  const undoTop = undoManager.peekUndo();
  const ret = await pullCLEccentricities(s.project, active, { materialMap: s.materialMap, loadFloorFn, peekFn });
  assert.equal(calls.peek, 0);
  assert.equal(calls.load, 1, '他階（1階）だけ確かめる');
  assert.equal(ret, undefined);
  assert.equal(hex(active), before);
  assert.equal(undoManager.peekUndo(), undoTop);
});

test('pull(b): loadFloorFn あり・連動先にレコードあり → 今と同じく取り込む（peek は他階1回）', async () => {
  const s = await setup({ belowRec: true });
  const { calls, peekFn, loadFloorFn } = makeStubs(s.project, s.store);
  const active = freshActive(s.project, s.store.get('p2'));
  const aymId = [...active.edges].find(e => e.masterType === 'INTERIOR_WALL')?.axisCLId;
  assert.ok(aymId, '候補の内壁CLがあること（空でない確認）');
  assert.equal(active.clEccentricities.has(aymId), false);
  await pullCLEccentricities(s.project, active, { materialMap: s.materialMap, loadFloorFn, peekFn });
  assert.equal(calls.peek, 1);
  assert.equal(active.clEccentricities.has(aymId), true, '連動先の指定が取り込まれる');
});

test('pull(c): 自階だけにレコードがあり他階は0件 → peek 0回で変更なし', async () => {
  const s = await setup({ belowRec: false, aboveRec: true });
  const { calls, peekFn, loadFloorFn } = makeStubs(s.project, s.store);
  const active = freshActive(s.project, s.store.get('p2'));
  const before = hex(active);
  await pullCLEccentricities(s.project, active, { materialMap: s.materialMap, loadFloorFn, peekFn });
  assert.equal(calls.peek, 0);
  assert.equal(hex(active), before);
});

test('pull(d)【失敗系】: loadFloorFn が throw → 上へ伝わり自階は無変更', async () => {
  const s = await setup({ belowRec: true });
  const { calls, peekFn } = makeStubs(s.project, s.store);
  const active = freshActive(s.project, s.store.get('p2'));
  const before = hex(active);
  const loadFloorFn = async () => { throw new Error('読込み失敗'); };
  await assert.rejects(
    pullCLEccentricities(s.project, active, { materialMap: s.materialMap, loadFloorFn, peekFn }),
    /読込み失敗/);
  assert.equal(calls.peek, 0);
  assert.equal(hex(active), before);
});

test('pull(e): バイト列が null の階は0件扱い（peek 0回）', async () => {
  const s = await setup({ belowRec: true });
  s.store.delete('p1');
  const { calls, peekFn, loadFloorFn } = makeStubs(s.project, s.store);
  const active = freshActive(s.project, s.store.get('p2'));
  const before = hex(active);
  await pullCLEccentricities(s.project, active, { materialMap: s.materialMap, loadFloorFn, peekFn });
  assert.equal(calls.peek, 0);
  assert.equal(hex(active), before);
});

for (const belowRec of [false, true]) {
  test(`pull(f): 新経路（loadFloorFn あり）と旧経路（loadFloorFn: null 明示）の結果が同じ（他階レコード${belowRec ? 'あり' : 'なし'}）`, async () => {
    const s = await setup({ belowRec });
    const aboveBytes = s.store.get('p2');
    const run = async (loadFloorFnOf) => {
      const stubs = makeStubs(s.project, s.store);
      const active = freshActive(s.project, aboveBytes);
      const ret = await pullCLEccentricities(s.project, active, {
        materialMap: s.materialMap, loadFloorFn: loadFloorFnOf(stubs), peekFn: stubs.peekFn,
      });
      return { dump: hex(active), ret, calls: stubs.calls };
    };
    const neu = await run(st => st.loadFloorFn);
    const old = await run(() => null);
    assert.ok(old.calls.peek >= 1, '旧経路では peek が実際に呼ばれる（空振り防止）');
    assert.equal(neu.calls.peek, belowRec ? 1 : 0);
    assert.equal(neu.dump, old.dump);
    assert.equal(neu.ret, old.ret);
    assert.equal(neu.dump === hex(freshActive(s.project, aboveBytes)), !belowRec, '取り込みの有無が入力どおり');
  });
}

test('pull(g): loadFloorFn 省略時は peek が従来どおり呼ばれる（旧経路・他階0件でも）', async () => {
  const s = await setup({ belowRec: false });
  const { calls, peekFn } = makeStubs(s.project, s.store);
  const active = freshActive(s.project, s.store.get('p2'));
  await pullCLEccentricities(s.project, active, { materialMap: s.materialMap, peekFn });
  assert.equal(calls.peek, 1);
  assert.equal(calls.load, 0);
});

test('pull: peekFn 省略時は呼び出し時の floorSwapManager.peek を使う（後から差し替えた stub が効く）', async () => {
  const s = await setup({ belowRec: false });
  const active = freshActive(s.project, s.store.get('p2'));
  const orig = floorSwapManager.peek;
  let n = 0;
  floorSwapManager.peek = async (plane, structGraph) => {
    n++;
    const g = new PlanGraph(plane);
    g._structGraph = structGraph;
    restoreGraph(g, s.store.get(plane.id));
    return g;
  };
  try {
    await pullCLEccentricities(s.project, active, { materialMap: s.materialMap });
  } finally {
    floorSwapManager.peek = orig;
  }
  assert.equal(n, 1);
});

test('pull: 他階の階データが旧JSON文字列（restoreGraph が受ける形）でレコードあり → 新経路でも peek へ進んで取り込み、旧経路と結果が同じ', async () => {
  const s = await setup({ belowRec: true });
  const json = JSON.stringify(decodeFloorSnapshot(s.store.get('p1')));
  assert.equal(typeof json, 'string');
  s.store.set('p1', json);
  const aboveBytes = s.store.get('p2');
  const run = async (useNew) => {
    const stubs = makeStubs(s.project, s.store);
    const active = freshActive(s.project, aboveBytes);
    await pullCLEccentricities(s.project, active, {
      materialMap: s.materialMap, loadFloorFn: useNew ? stubs.loadFloorFn : null, peekFn: stubs.peekFn,
    });
    return { dump: hex(active), calls: stubs.calls, ecc: active.clEccentricities.size };
  };
  const neu = await run(true);
  const old = await run(false);
  assert.equal(neu.calls.peek, 1);
  assert.equal(old.calls.peek, 1);
  assert.equal(neu.ecc, 1, '文字列の階のレコードが取り込まれる（count=0 と誤判定して取りこぼさない）');
  assert.equal(neu.dump, old.dump);
});

// 3階建て: 全階の ym 位置の下側に階段（feature=STAIR）の部屋＋内壁。階段規則（設置階〜最上階）で全階が連動する。
async function makeThreeFloorStairFixture() {
  const project = new Project('proj', 'test');
  const gs = [1, 2, 3].map(i => project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`).graph);
  project.activePlaneId = 'p1';
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => gs.find(g => g.plane.id === plane.id);
  try {
    const yms = [];
    for (const g of gs) {
      const x0 = g.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
      const x1 = g.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
      const y0 = g.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
      const ym = g.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
      const y1 = g.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH });
      g.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`]), '階段').setFeature(RoomFeature.STAIR);
      g.addRoom(new Set([`${x0.id}:${ym.id}:${x1.id}:${y1.id}`]), '部屋B');
      g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
      await runFinishEntryBoundary(g, project);
      yms.push(ym);
    }
    const materialMap = await loadMaterialMap();
    return { project, gs, yms, materialMap };
  } finally {
    floorSwapManager.peek = orig;
  }
}

// recIdx 階（0始まり）にだけ偏芯レコード、activeIdx 階が自階。新経路と旧経路（loadFloorFn: null）を比べる。
async function runThreeFloor(recIdx, activeIdx) {
  const f = await makeThreeFloorStairFixture();
  f.gs[recIdx].setCLEccentricity(f.yms[recIdx].id, REC);
  const store = new Map(f.gs.map((g, i) => [`p${i + 1}`, serializeGraph(g)]));
  const activeId = `p${activeIdx + 1}`;
  const activeBytes = store.get(activeId);
  const mk = () => {
    const plane = f.project.planes.find(p => p.id === activeId);
    const g = new PlanGraph(plane);
    g._structGraph = f.project.structGraph;
    restoreGraph(g, activeBytes);
    return g;
  };
  const run = async (useNew) => {
    const stubs = makeStubs(f.project, store);
    const active = mk();
    const cand = [...active.edges].find(e => e.masterType === 'INTERIOR_WALL')?.axisCLId;
    assert.ok(cand, '自階に候補の内壁CLがあること（空でない確認）');
    await pullCLEccentricities(f.project, active, {
      materialMap: f.materialMap, loadFloorFn: useNew ? stubs.loadFloorFn : null, peekFn: stubs.peekFn,
    });
    return { dump: hex(active), calls: stubs.calls, has: active.clEccentricities.has(cand) };
  };
  return { neu: await run(true), old: await run(false) };
}

test('pull(T1): 3階建てでレコードが最上階だけにあり自階が最下階 → 新経路でも取り込む（最上階を見落とさない）', async () => {
  const { neu, old } = await runThreeFloor(2, 0);
  assert.equal(old.has, true, '旧経路は取り込む（前提）');
  assert.equal(neu.has, true, '新経路も最上階のレコードを取り込む');
  assert.equal(neu.calls.peek, 2);
  assert.equal(old.calls.peek, 2);
  assert.equal(neu.dump, old.dump);
});

test('pull(T1対称): 3階建てでレコードが最下階だけにあり自階が最上階 → 新経路でも取り込む（最初の階を見落とさない）', async () => {
  const { neu, old } = await runThreeFloor(0, 2);
  assert.equal(old.has, true, '旧経路は取り込む（前提）');
  assert.equal(neu.has, true, '新経路も最下階のレコードを取り込む');
  assert.equal(neu.calls.peek, 2);
  assert.equal(neu.dump, old.dump);
});

test('runFinishEntryBoundary(T2): 受け取った loadFloorFn で pull の事前確認をする（他階0件なら pull 由来の peek が減る）', async () => {
  const { project, below, above } = await makeFixture();
  const orig = floorSwapManager.peek;
  let peeks = 0;
  floorSwapManager.peek = async (plane) => { peeks++; return plane.id === below.plane.id ? below : above; };
  try {
    await runFinishEntryBoundary(above, project);
    const withoutFn = peeks;
    peeks = 0;
    let loads = 0;
    const spy = async () => { loads++; return null; };
    await runFinishEntryBoundary(above, project, { loadFloorFn: spy });
    assert.equal(loads, 1, '他階（1階）の分だけ読み手が呼ばれる');
    assert.equal(withoutFn - peeks, 1, '引数なしより peek が pull の他階1回ぶん少ない');
  } finally {
    floorSwapManager.peek = orig;
  }
});
