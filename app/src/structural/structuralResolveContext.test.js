// structuralResolveContext.js の単体テスト。peek/save は注入し、世代は実モジュール
// （storage/floorWriteGeneration.js）を使う——「保存はMapへ記録しつつnoteFloorWriteを呼ぶ版と
// 呼ばない版」を作り分けるため、生成物ではなく実際の書込み世代の挙動で検証する。
// peekスタブは本番同型（FloorSwapManager.peekの手順に合わせる）: new PlanGraph(plane)→
// g._structGraph = structGraph→restoreGraph(g, store.get(plane.id))。生きたグラフをそのまま返す
// スタブは使わない（保存→peekの往復を経ない限り「新しい内容」を作れない設計にするため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLine, CenterLineType, Discipline } from '../core.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { noteFloorWrite, noteAllFloorsWritten } from '../storage/floorWriteGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { createStructuralResolveContext } from './structuralResolveContext.js';
import { peekVia, saveVia } from './structuralPeek.js';

// structGraph は project.structGraph と同じ「全階共通の通り芯専用PlanGraph」実体で代用する
// （core/planGraph.js の centerLines 等のcomputedゲッターが _structGraph.shapeMap を読むため、
// 素の {} では TypeError になる。core/project.js Project コンストラクタと同じ作り方）。
function makeStructGraph() { return new PlanGraph(new Plane('struct', 0, '__struct__')); }

let uid = 0;
function uniquePlaneId(label) { return `${label}-${++uid}`; }

// store: planeId → bytes（本番のIDB floorsストア相当。テストごとに独立したMapを使う）。
function makeStore() { return new Map(); }

// markerValue で内容を区別できる最小限のfloor-local CenterLine（意匠中心線・非通り芯）を1本だけ持つ
// graphをシリアライズしてstoreへ書く（IDBの実データ形式は問わない・区別できれば足りる）。
function writeContent(store, plane, structGraph, markerValue) {
  const g = new PlanGraph(plane);
  g._structGraph = structGraph;
  g.addCenterLine(CenterLineType.VERTICAL, markerValue, { labeled: false, discipline: Discipline.ARCH });
  store.set(plane.id, serializeGraph(g));
}

// FloorSwapManager.peek と同じ手順（heal等の導出処理はここでは省く——本テストの対象外）。
function makePeek(store) {
  return async (plane, structGraph) => {
    const g = new PlanGraph(plane);
    g._structGraph = structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
}

// peekの await 中に他者の書込みが割り込む状況を再現する版（interfereは復元前に呼ぶ＝
// 「読み取り中に更新された」を意味する）。
function makePeekWithInterference(store, interfere) {
  return async (plane, structGraph) => {
    await interfere(plane.id);
    const g = new PlanGraph(plane);
    g._structGraph = structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
}

// storage/db.js saveFloor と同じ契約（同期区間でnoteFloorWrite相当を呼んでからI/Oする）を持つsave。
// note:false は「世代を進めない注入（テスト用スタブ）」を再現する。
// `await Promise.resolve()` を noteFloorWrite の直後に挟むのは、saveAndNote側の
// 「呼び出し直後（awaitの前）に読む genAfterOwnWrite」が、onDuringIO（割込みシミュレート）より
// 確実に先に走るようにするため——onDuringIO が同期的に完結する関数（例: 内部でnoteFloorWriteを
// 呼ぶだけのasync関数）だと、await無しでは save() 呼び出しの同一同期区間内で先に実行されてしまい、
// 「保存の完了までの間（awaitをまたいで）割り込んだ」状況を再現できない。
function makeSave(store, { note = true, onDuringIO } = {}) {
  return async (planeId, bytes) => {
    if (note) noteFloorWrite(planeId);
    await Promise.resolve();
    if (onDuringIO) await onDuringIO();
    store.set(planeId, bytes);
  };
}

function markerOf(graph) {
  const cl = [...graph.shapeMap.values()].find(s => s instanceof CenterLine);
  return cl ? cl._value : null;
}

// ---- 1. 同一planeを2回graphFor → peek1回・同一インスタンス・stats.hitが増える ----
test('graphFor: 同一planeを2回読むとpeekは1回だけ・同一インスタンスが返り・stats.hitが増える', async () => {
  const planeId = uniquePlaneId('p-hit');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx = createStructuralResolveContext({ peek: makePeek(store) });

  const g1 = await ctx.graphFor(plane, structGraph);
  const g2 = await ctx.graphFor(plane, structGraph);

  assert.equal(g1, g2, '同一インスタンスが返る');
  assert.equal(ctx.stats.peek, 1, 'peekは1回だけ');
  assert.equal(ctx.stats.hit, 1, '2回目はhit');
});

// ---- 2.【失敗系】他者の書込み後は古いコピーを返さず、peekし直して新しい内容が返る ----
test('【失敗系】graphFor: 他者の書込み（noteFloorWrite）の後は再peekし、新しい内容が返り、stats.invalidatedが増える', async () => {
  const planeId = uniquePlaneId('p-other-write');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx = createStructuralResolveContext({ peek: makePeek(store) });

  const g1 = await ctx.graphFor(plane, structGraph);
  assert.equal(markerOf(g1), 100);

  // 他者（このコンテキストを介さない書込み経路）が同じ階の内容を書き換える。
  writeContent(store, plane, structGraph, 200);
  noteFloorWrite(planeId);

  const g2 = await ctx.graphFor(plane, structGraph);
  assert.notEqual(g2, g1, '古いコピーを返さない');
  assert.equal(markerOf(g2), 200, '新しい内容が返る');
  assert.equal(ctx.stats.peek, 2, '2回目も実際にpeekしている');
  assert.equal(ctx.stats.invalidated, 1, '保持していたエントリが無効化された');
});

// ---- 3.【失敗系】saveAndNote の後は読み直さない（peekが増えない）・同一インスタンス ----
test('【失敗系】saveAndNote: 割込みが無ければ保持をそのまま新鮮とマークし、直後のgraphForは読み直さない', async () => {
  const planeId = uniquePlaneId('p-save-no-reread');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx = createStructuralResolveContext({ peek: makePeek(store), save: makeSave(store) });

  const g1 = await ctx.graphFor(plane, structGraph);
  await ctx.saveAndNote(planeId, serializeGraph(g1), g1);
  const g2 = await ctx.graphFor(plane, structGraph);

  assert.equal(g2, g1, '同一インスタンスのまま（保持を捨てていない）');
  assert.equal(ctx.stats.peek, 1, 'saveAndNote後のgraphForはpeekし直さない');
});

// ---- 3b.【失敗系】保持インスタンス以外のgraphを保存したら、保持を新鮮扱いにしない ----
test('【失敗系】saveAndNote: 保持インスタンス以外のgraph由来の保存（編集可能peek等）では保持を捨て、次のgraphForは保存された内容を読み直す', async () => {
  const planeId = uniquePlaneId('p-save-other-instance');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx = createStructuralResolveContext({ peek: makePeek(store), save: makeSave(store) });

  const held = await ctx.graphFor(plane, structGraph);
  // 別インスタンス（同じ階の別コピー）を変えて保存する。
  const other = new PlanGraph(plane);
  other._structGraph = structGraph;
  other.addCenterLine(CenterLineType.VERTICAL, 777, { labeled: false, discipline: Discipline.ARCH });
  await ctx.saveAndNote(planeId, serializeGraph(other), other);
  const reread = await ctx.graphFor(plane, structGraph);

  assert.notEqual(reread, held, '古い保持インスタンスを返さない');
  assert.equal(markerOf(reread), 777, '保存された内容が返る');
  assert.equal(ctx.stats.peek, 2);
});

// ---- 3c. 同じ階への並行graphForは1つの読みを共有する（別インスタンスを2つ流通させない） ----
test('graphFor: 同じ階への並行呼び出しはpeek1回・同一インスタンスを共有する', async () => {
  const planeId = uniquePlaneId('p-concurrent');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx = createStructuralResolveContext({ peek: makePeek(store) });

  const [a, b] = await Promise.all([ctx.graphFor(plane, structGraph), ctx.graphFor(plane, structGraph)]);

  assert.equal(a, b, '同一インスタンス');
  assert.equal(ctx.stats.peek, 1, 'peekは1回だけ');
  assert.equal(await ctx.graphFor(plane, structGraph), a, '以後も同じ保持が返る');
});

// ---- 3d.【失敗系】peekのthrow/nullで保持・進行中の読みが壊れない。dropは明示的に手放す ----
test('【失敗系】graphFor: peekがthrowしたら例外を伝え、次回は読み直せる（進行中の読みが残らない）', async () => {
  const planeId = uniquePlaneId('p-peek-throw');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const real = makePeek(store);
  let fail = true;
  const ctx = createStructuralResolveContext({
    peek: async (p, s) => { if (fail) throw new Error('peek失敗'); return real(p, s); },
  });

  await assert.rejects(ctx.graphFor(plane, structGraph), /peek失敗/);
  fail = false;
  const g = await ctx.graphFor(plane, structGraph);
  assert.equal(markerOf(g), 100, '失敗の後でも読み直せる');
});

test('【失敗系】graphFor: peekがnullを返したら保持せず、次回も読み直す', async () => {
  const plane = new Plane(uniquePlaneId('p-peek-null'), 0, '1階');
  let calls = 0;
  const ctx = createStructuralResolveContext({ peek: async () => { calls++; return null; } });

  assert.equal(await ctx.graphFor(plane, makeStructGraph()), null);
  assert.equal(await ctx.graphFor(plane, makeStructGraph()), null);
  assert.equal(calls, 2, 'nullは保持されない');
});

test('drop: 指定した階の保持だけを手放し、次のgraphForは読み直す', async () => {
  const structGraph = makeStructGraph();
  const store = makeStore();
  const p1 = new Plane(uniquePlaneId('p-drop-1'), 0, '1階');
  const p2 = new Plane(uniquePlaneId('p-drop-2'), 3000, '2階');
  writeContent(store, p1, structGraph, 100);
  writeContent(store, p2, structGraph, 200);
  const ctx = createStructuralResolveContext({ peek: makePeek(store) });
  const g1 = await ctx.graphFor(p1, structGraph);
  const g2 = await ctx.graphFor(p2, structGraph);

  ctx.drop(p1.id);

  assert.notEqual(await ctx.graphFor(p1, structGraph), g1, '手放した階は読み直す');
  assert.equal(await ctx.graphFor(p2, structGraph), g2, '他の階の保持はそのまま');
});

// ---- 4.【失敗系】saveAndNote の保存中に他者が割り込んだら保持を捨てる ----
test('【失敗系】saveAndNote: 保存の完了までの間に他者が割り込んだら保持を捨て、次のgraphForは再peekする', async () => {
  const planeId = uniquePlaneId('p-save-interfered');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  // 保存のI/O待ち中に「別の誰か」が同じ階へ書き込む（saveFloorの2回目相当）。
  const save = makeSave(store, { onDuringIO: async () => { noteFloorWrite(planeId); } });
  const ctx = createStructuralResolveContext({ peek: makePeek(store), save });

  const g1 = await ctx.graphFor(plane, structGraph);
  await ctx.saveAndNote(planeId, serializeGraph(g1), g1);

  const g2 = await ctx.graphFor(plane, structGraph);
  assert.notEqual(g2, g1, '保持が捨てられ、再peekされた別インスタンスが返る');
  assert.equal(ctx.stats.peek, 2, 'saveAndNote後のgraphForが再peekしている');
  assert.equal(ctx.stats.invalidated, 1, '割込みにより保持が無効化された');
});

// saveAndNote: saveが世代を進めない注入（テスト用スタブ）でも、割込みが無ければ保持は保たれる。
test('saveAndNote: saveが世代を進めないスタブでも、割込みが無ければ保持は保たれる（同一インスタンス）', async () => {
  const planeId = uniquePlaneId('p-save-no-note');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx = createStructuralResolveContext({ peek: makePeek(store), save: makeSave(store, { note: false }) });

  const g1 = await ctx.graphFor(plane, structGraph);
  await ctx.saveAndNote(planeId, serializeGraph(g1), g1);
  const g2 = await ctx.graphFor(plane, structGraph);

  assert.equal(g2, g1, '世代を進めないsaveでも、割込みが無ければ保持は保たれる');
  assert.equal(ctx.stats.peek, 1);
});

// ---- 5.【失敗系】peek の await 中に他者が書いた場合、その読みを「最新」として保持し続けない ----
test('【失敗系】graphFor: peekのawait中に他者が書いた場合、その結果を保持せず次回も再peekする', async () => {
  const planeId = uniquePlaneId('p-peek-race');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const peek = makePeekWithInterference(store, async (pid) => {
    writeContent(store, plane, structGraph, 200);
    noteFloorWrite(pid);
  });
  const ctx = createStructuralResolveContext({ peek });

  const g1 = await ctx.graphFor(plane, structGraph);
  assert.equal(markerOf(g1), 200, '割込み後の最新内容自体は読めている');

  const g2 = await ctx.graphFor(plane, structGraph);
  assert.notEqual(g2, g1, '1回目の結果を「最新」として保持し続けていない（再peekされた）');
  assert.equal(ctx.stats.peek, 2, '2回ともpeekが実際に呼ばれている（1回目はヒットしていない）');
  assert.equal(ctx.stats.hit, 0);
});

// ---- 6.【失敗系】noteAllFloorsWritten() で全階の保持が無効になる ----
test('【失敗系】graphFor: noteAllFloorsWritten()（floorsストア全体の作り直し）で複数階の保持がまとめて無効になる', async () => {
  const planeIdA = uniquePlaneId('p-all-a');
  const planeIdB = uniquePlaneId('p-all-b');
  const planeA = new Plane(planeIdA, 0, '1階');
  const planeB = new Plane(planeIdB, 3000, '2階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, planeA, structGraph, 1);
  writeContent(store, planeB, structGraph, 2);
  const ctx = createStructuralResolveContext({ peek: makePeek(store) });

  const a1 = await ctx.graphFor(planeA, structGraph);
  const b1 = await ctx.graphFor(planeB, structGraph);
  assert.equal(ctx.stats.peek, 2);

  noteAllFloorsWritten();

  const a2 = await ctx.graphFor(planeA, structGraph);
  const b2 = await ctx.graphFor(planeB, structGraph);
  assert.notEqual(a2, a1, 'A階の保持も無効化されている');
  assert.notEqual(b2, b1, 'B階の保持も無効化されている');
  assert.equal(ctx.stats.peek, 4, '両階とも再peekされている');
});

// ---- 7.【失敗系】dispose 後の graphFor は保持を返さず注入peekを呼び、console.warnは1回だけ。
//         dispose 後の saveAndNote は保存だけ行う ----
test('【失敗系】dispose: 破棄後のgraphForは保持を無視して注入peekへフォールバックし、console.warnは複数回呼んでも1回だけ', async () => {
  const planeId = uniquePlaneId('p-disposed');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx = createStructuralResolveContext({ peek: makePeek(store) });

  const g1 = await ctx.graphFor(plane, structGraph);
  ctx.dispose();

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const g2 = await ctx.graphFor(plane, structGraph);
    const g3 = await ctx.graphFor(plane, structGraph);
    assert.notEqual(g2, g1, '破棄後は保持を返さない（注入peekへフォールバック）');
    assert.notEqual(g3, g2, '破棄後は毎回フォールバックのpeekを呼ぶ（保持しない）');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, 'console.warnは複数回使っても1回だけ');
});

test('【失敗系】dispose: 破棄後のsaveAndNoteは保存だけ行う（世代の記帳・保持更新はしない）', async () => {
  const planeId = uniquePlaneId('p-disposed-save');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx = createStructuralResolveContext({ peek: makePeek(store), save: makeSave(store) });

  await ctx.graphFor(plane, structGraph);
  ctx.dispose();

  const bytes = serializeGraph((() => { const g = new PlanGraph(plane); g._structGraph = structGraph; g.addCenterLine(CenterLineType.VERTICAL, 999, { labeled: false, discipline: Discipline.ARCH }); return g; })());
  await ctx.saveAndNote(planeId, bytes);

  assert.equal(store.get(planeId), bytes, '破棄後もsave自体は実行される（保存だけ行う）');
});

// ---- 8. 別コンテキスト同士で保持・cacheが共有されない。peekVia(null/undefined,...)はfloorSwapManager.peekへ ----
test('createStructuralResolveContext: 別コンテキスト同士で保持・wallSourceCache・footprintCacheが共有されない', async () => {
  const planeId = uniquePlaneId('p-isolated');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx1 = createStructuralResolveContext({ peek: makePeek(store) });
  const ctx2 = createStructuralResolveContext({ peek: makePeek(store) });

  const g1 = await ctx1.graphFor(plane, structGraph);
  const g2 = await ctx2.graphFor(plane, structGraph);

  assert.notEqual(g1, g2, '別コンテキストは保持を共有しない（それぞれ自分でpeekする）');
  assert.notEqual(ctx1.wallSourceCache, ctx2.wallSourceCache, 'wallSourceCacheはコンテキストごとに別インスタンス');
  assert.notEqual(ctx1.footprintCache, ctx2.footprintCache, 'footprintCacheはコンテキストごとに別インスタンス');
});

test('peekVia: ctxがnull/undefinedならfloorSwapManager.peekへ直接委ねる', async () => {
  const planeId = uniquePlaneId('p-peekvia-fallback');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  let calls = 0;
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (...args) => { calls++; return original.call(floorSwapManager, ...args); };
  try {
    // floorSwapManager.peek は実IDBへ到達するため待たず投げっぱなしにはできない——ここではnullを
    // 返すダミーIDB経路を通らせず、呼ばれたことだけを確認する（loadFloorは未モックのため実IDBに
    // 到達しうるが、node環境ではindexedDB未定義でthrowする。呼ばれたこと自体をrejectで確認する）。
    await assert.rejects(peekVia(null, plane, structGraph));
    await assert.rejects(peekVia(undefined, plane, structGraph));
  } finally {
    floorSwapManager.peek = original;
  }
  assert.equal(calls, 2, 'ctx未指定はfloorSwapManager.peekへ委ねている（2回呼ばれた）');
});

// ---- 9. saveVia: ctx指定時はctx.saveAndNoteへ、ctx省略時（null/undefined）はsaveFloorへ ----
test('saveVia: ctx指定時はctx.saveAndNoteへ委ね、直後のgraphForが同一インスタンスを返す', async () => {
  const planeId = uniquePlaneId('p-savevia-ctx');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const store = makeStore();
  writeContent(store, plane, structGraph, 100);
  const ctx = createStructuralResolveContext({ peek: makePeek(store), save: makeSave(store) });

  const g1 = await ctx.graphFor(plane, structGraph);
  await saveVia(ctx, planeId, serializeGraph(g1), g1);
  const g2 = await ctx.graphFor(plane, structGraph);

  assert.equal(g2, g1, 'saveVia経由の保存はctx.saveAndNoteに委ねられ、直後のgraphForは読み直さない（同一インスタンス）');
  assert.equal(ctx.stats.peek, 1, 'saveVia後のgraphForはpeekし直さない');
});

test('saveVia: ctxがnull/undefinedならsaveFloorへ直接委ねる', async () => {
  const planeId = uniquePlaneId('p-savevia-fallback');
  const plane = new Plane(planeId, 0, '1階');
  const structGraph = makeStructGraph();
  const g = new PlanGraph(plane);
  g._structGraph = structGraph;
  const bytes = serializeGraph(g);
  // saveFloor（storage/db.js）はESM importバインディングのため差し替えられない（peekViaの既存
  // テストと同じ制約）——node環境ではindexedDB未定義のため、saveFloorへ到達すればrejectする。
  // 到達すること自体が「ctxへ委ねずsaveFloorへ直接委ねた」ことの確認になる。
  await assert.rejects(saveVia(null, planeId, bytes, g), 'ctx:nullはsaveFloorへ直接委ねる（実IDB未定義でreject）');
  await assert.rejects(saveVia(undefined, planeId, bytes, g), 'ctx省略はsaveFloorへ直接委ねる（実IDB未定義でreject）');
});
