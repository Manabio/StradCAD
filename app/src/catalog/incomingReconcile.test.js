import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIncomingReconcile, formatReconcileNotice, applyReconcilePlan } from './incomingReconcile.js';
import { CatalogKind } from './catalogKinds.js';
import { setOverlay, clearOverlays, overlayFor, composeCatalog } from './catalogRegistry.js';
import { applyDocumentCodeNormalization, clearDocumentAliases } from './codeNormalization.js';
import { buildResolveRows } from './resolveQueue.js';

test.afterEach(() => { clearOverlays(); clearDocumentAliases(); });

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

// ---- planIncomingReconcile ----
test('planIncomingReconcile: id一致・内容一致 → same（aliases/adoptDoc/adds/proposalsには積まない）', () => {
  const existing = material();
  const plan = planIncomingReconcile({
    kind: CatalogKind.MATERIAL, docEntries: [material()], appEntries: [existing],
  });
  assert.deepEqual(plan.same, [existing.code]);
  assert.deepEqual(plan.adoptDoc, []);
  assert.deepEqual(plan.aliases, []);
  assert.deepEqual(plan.adds, []);
  assert.deepEqual(plan.proposals, []);
});

test('planIncomingReconcile: idは不一致だが内容が完全一致 → aliasesに積む・proposalsは空', () => {
  const existing = material({ code: '301000000001' });
  const doc = material({ code: '999999999999' }); // 5項目同じ・codeだけ違う
  const plan = planIncomingReconcile({
    kind: CatalogKind.MATERIAL, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.aliases, [{ from: '999999999999', to: '301000000001' }]);
  assert.deepEqual(plan.proposals, []);
  assert.deepEqual(plan.adds, []);
});

test('planIncomingReconcile: id一致・内容不一致 → adoptDocへ{key,diffFields,notify,label}を積む', () => {
  const existing = material();
  const doc = material({ note: '別の備考' });
  const plan = planIncomingReconcile({
    kind: CatalogKind.MATERIAL, docEntries: [doc], appEntries: [existing],
  });
  assert.equal(plan.adoptDoc.length, 1);
  assert.equal(plan.adoptDoc[0].key, existing.code);
  assert.deepEqual(plan.adoptDoc[0].diffFields, ['note']);
  assert.equal(plan.adoptDoc[0].notify, true);
  assert.equal(plan.adoptDoc[0].label, doc.name);
});

test('planIncomingReconcile: 部分一致（類似） → proposalsへ候補付きで積む', () => {
  const existing = material({ code: '301000000001' });
  const doc = material({ code: '999999999999', thickness: 15 }); // thicknessだけ違う=段1
  const plan = planIncomingReconcile({
    kind: CatalogKind.MATERIAL, docEntries: [doc], appEntries: [existing],
  });
  assert.equal(plan.proposals.length, 1);
  assert.equal(plan.proposals[0].from, '999999999999');
  assert.equal(plan.proposals[0].candidates[0].code, '301000000001');
  assert.deepEqual(plan.adds, []);
});

test('planIncomingReconcile: 一致なし → addsへdocEntry本体を積む', () => {
  const existing = material({ code: '301000000001' });
  const doc = material({ code: '999999999999', name: '無関係の材' });
  const plan = planIncomingReconcile({
    kind: CatalogKind.MATERIAL, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.adds, [doc]);
});

test('planIncomingReconcile: 複数docEntriesを種類ごとに振り分ける', () => {
  const same = material({ code: '301000000001' });
  const aliasTarget = material({ code: '301000000002', name: '別の材' });
  const aliasDoc = material({ code: '999999999998', name: '別の材' }); // aliasTargetと内容完全一致
  const addDoc = material({ code: '999999999999', name: '本当に新規' });
  const plan = planIncomingReconcile({
    kind: CatalogKind.MATERIAL,
    docEntries: [material({ code: '301000000001' }), aliasDoc, addDoc],
    appEntries: [same, aliasTarget],
  });
  assert.deepEqual(plan.same, ['301000000001']);
  assert.deepEqual(plan.aliases, [{ from: '999999999998', to: '301000000002' }]);
  assert.deepEqual(plan.adds, [addDoc]);
});

// ---- formatReconcileNotice: R12 通知文の4ケース ----
test('formatReconcileNotice: 不一致のみ（adds無し）→ 件数を含む1文', () => {
  const plan = { adoptDoc: [{ key: 'k', diffFields: ['name'], notify: true, label: 'A材' }], adds: [] };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL });
  assert.match(msg, /1件/);
  assert.match(msg, /A材/);
});

test('formatReconcileNotice: 追加のみ（不一致無し）→ addedCountで件数を含む1文', () => {
  const plan = { adoptDoc: [], adds: [material({ code: '999999999999', name: 'B材' })] };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL, addedCount: 1 });
  assert.match(msg, /1件/);
  assert.match(msg, /B材/);
});

test('formatReconcileNotice: addedCountを渡さなければ（既定0）plan.adds非空でも「追加」文は出ない', () => {
  const plan = { adoptDoc: [], adds: [material({ code: '999999999999', name: 'B材' })] };
  assert.equal(formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL }), null, 'addedCount省略時は0扱い（R17で全て弾かれた場合に「追加されました」と誤報しないため）');
});

test('formatReconcileNotice: 不一致＋追加の両方 → 2文をまとめて1本にする', () => {
  const plan = {
    adoptDoc: [{ key: 'k', diffFields: ['name'], notify: true, label: 'A材' }],
    adds: [material({ code: '999999999999', name: 'B材' })],
  };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL, addedCount: 1 });
  assert.match(msg, /A材/);
  assert.match(msg, /B材/);
});

test('formatReconcileNotice: 全セクション0件（不一致・追加・スキップ・読み替え）ならnull', () => {
  assert.equal(formatReconcileNotice({ adoptDoc: [], adds: [], aliases: [] }, { kind: CatalogKind.MATERIAL }), null);
  assert.equal(formatReconcileNotice({ adoptDoc: [], adds: [], aliases: [] }, { kind: CatalogKind.MATERIAL, addedCount: 0, skippedCount: 0 }), null);
});

test('formatReconcileNotice: notify:falseの不一致は数えない（他セクションも0ならnull）', () => {
  const plan = { adoptDoc: [{ key: 'k', diffFields: ['spec'], notify: false, label: 'A材' }], adds: [] };
  assert.equal(formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL }), null);
});

test('formatReconcileNotice: 名称は最大2件＋「ほかN件」', () => {
  const plan = {
    adoptDoc: [],
    adds: [
      material({ code: '999999999991', name: '材1' }),
      material({ code: '999999999992', name: '材2' }),
      material({ code: '999999999993', name: '材3' }),
    ],
  };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL, addedCount: 3 });
  assert.match(msg, /材1・材2ほか1件/);
});

// ---- QA指摘2: skippedCountの補足文 ----
test('formatReconcileNotice: skippedCountが非空なら「N件は同じ内容の材料が既にあるため追加しませんでした」を1文足す', () => {
  const plan = { adoptDoc: [], adds: [material({ code: '999999999999', name: 'B材' })] };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL, addedCount: 1, skippedCount: 1 });
  assert.match(msg, /1件.*追加されました/);
  assert.match(msg, /1件は同じ内容の材料が既にあるため追加しませんでした/);
});

test('formatReconcileNotice: addedCount=0でもskippedCountが非空ならスキップ文だけ出る', () => {
  const plan = { adoptDoc: [], adds: [] };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL, addedCount: 0, skippedCount: 2 });
  assert.equal(msg, '2件は同じ内容の材料が既にあるため追加しませんでした');
});

// ---- QA指摘3: aliasのみ適用のときも通知する ----
test('formatReconcileNotice: aliasのみ（不一致・追加・スキップ無し）→ 読み替え適用の1文だけ出る', () => {
  const plan = { adoptDoc: [], adds: [], aliases: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }] };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL });
  assert.equal(msg, '材料コードの読み替えを2件適用しました（保存すると確定します）');
});

test('formatReconcileNotice: alias0件なら読み替え文は省略される（他セクションで確認）', () => {
  const plan = { adoptDoc: [], adds: [material({ code: '999999999999', name: 'B材' })], aliases: [] };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL, addedCount: 1 });
  assert.doesNotMatch(msg, /読み替え/);
});

test('formatReconcileNotice: 不一致・追加・スキップ・読み替えの全部あり → 4文すべてを1本にまとめる', () => {
  const plan = {
    adoptDoc: [{ key: 'k', diffFields: ['name'], notify: true, label: 'A材' }],
    adds: [material({ code: '999999999999', name: 'B材' })],
    aliases: [{ from: 'a', to: 'b' }],
  };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.MATERIAL, addedCount: 1, skippedCount: 1 });
  assert.match(msg, /A材/);
  assert.match(msg, /B材/);
  assert.match(msg, /1件は同じ内容の材料が既にあるため追加しませんでした/);
  assert.match(msg, /材料コードの読み替えを1件適用しました/);
});

// ---- ステップ7d QA指摘Minor-1: kind省略は例外（7aの「既定でmaterialに落とさない」規約と統一）----
test('【失敗系・ステップ7d QA指摘Minor-1】formatReconcileNotice: kind省略は日本語例外', () => {
  const plan = { adoptDoc: [], adds: [], aliases: [{ from: 'a', to: 'b' }] };
  assert.throws(() => formatReconcileNotice(plan), /kindの指定が必須/);
  assert.throws(() => formatReconcileNotice(plan, {}), /kindの指定が必須/);
});

// ---- applyReconcilePlan ----
function makePlan(overrides) {
  return { same: [], adoptDoc: [], aliases: [], proposals: [], adds: [], unsupported: [], ...overrides };
}

test('applyReconcilePlan: 一致なし(adds)→ nextUserへ積みcommitUserFnが1回呼ばれる', async () => {
  const addEntry = material({ code: '999999999999', name: '新規材' });
  const plan = makePlan({ adds: [addEntry] });
  const commitCalls = [];
  const result = await applyReconcilePlan(plan, {
    kind: CatalogKind.MATERIAL,
    currentUser: [],
    commitUserFn: async (nextUser) => { commitCalls.push(nextUser); },
    addAliasesFn: () => {},
  });
  assert.equal(commitCalls.length, 1, 'commitUserFnは1回だけ呼ばれる契約');
  assert.deepEqual(commitCalls[0], [addEntry]);
  assert.deepEqual(result.addedKeys, ['999999999999']);
  assert.deepEqual(result.skipped, []);
});

// 2026-09-22 指示: 「2回読込みで adds=[] かつ commitUserFn 0回」——1回目の結果をuserへ反映して
// 再planすると、既にuser側に存在するためaddsが空になる（classifyIncomingが同キーでsame判定）。
test('2回読込みで adds=[] かつ commitUserFn 0回（1回目の結果を反映して再planすると重複が増えない）', async () => {
  const addEntry = material({ code: '999999999999', name: '新規材' });

  // 1回目: appEntriesにまだ無いのでadd
  const firstPlan = planIncomingReconcile({
    kind: CatalogKind.MATERIAL, docEntries: [addEntry], appEntries: [],
  });
  assert.deepEqual(firstPlan.adds, [addEntry]);

  let userLib = [];
  const commitCalls = [];
  await applyReconcilePlan(firstPlan, {
    kind: CatalogKind.MATERIAL,
    currentUser: userLib,
    commitUserFn: async (nextUser) => { commitCalls.push(nextUser); userLib = nextUser; },
    addAliasesFn: () => {},
  });
  assert.equal(commitCalls.length, 1);

  // 2回目: 同じdocEntries（同じ.stqを再度開いた想定）をuserLibを含むappEntriesに対して再plan
  const secondPlan = planIncomingReconcile({
    kind: CatalogKind.MATERIAL, docEntries: [addEntry], appEntries: userLib,
  });
  assert.deepEqual(secondPlan.adds, [], '2回目はuserライブラリに既にあるのでaddsは空');
  assert.deepEqual(secondPlan.same, [addEntry.code]);

  const commitCalls2 = [];
  const result2 = await applyReconcilePlan(secondPlan, {
    kind: CatalogKind.MATERIAL,
    currentUser: userLib,
    commitUserFn: async (nextUser) => { commitCalls2.push(nextUser); },
    addAliasesFn: () => {},
  });
  assert.equal(commitCalls2.length, 0, '2回目はaddsが空なのでcommitUserFnは呼ばれない');
  assert.deepEqual(result2.addedKeys, []);
});

test('【失敗系】applyReconcilePlan: R17（同一内容の重複登録禁止）に弾かれた追加はskippedへ積みcommitUserFnには渡らない', async () => {
  const dupA = material({ code: '999999999991', name: '同じ内容' });
  const dupB = material({ code: '999999999992', name: '同じ内容' }); // dedupeFields(name/spec/x/y/thickness)完全一致
  const plan = makePlan({ adds: [dupA, dupB] });
  const skippedCalls = [];
  const commitCalls = [];
  const result = await applyReconcilePlan(plan, {
    kind: CatalogKind.MATERIAL,
    currentUser: [],
    commitUserFn: async (nextUser) => { commitCalls.push(nextUser); },
    addAliasesFn: () => {},
    onSkipped: (entry, err) => skippedCalls.push({ entry, err }),
  });
  assert.deepEqual(result.addedKeys, ['999999999991'], '先勝ちの1件だけ追加される');
  assert.equal(result.skipped.length, 1, '2件目はR17で弾かれてskippedへ積まれる');
  assert.equal(result.skipped[0].entry, dupB);
  assert.match(result.skipped[0].reason, /既に登録されています/);
  assert.equal(skippedCalls.length, 1, 'onSkippedが1回呼ばれる');
  assert.equal(commitCalls.length, 1, '弾かれなかった1件についてはcommitUserFnが呼ばれる');
  assert.deepEqual(commitCalls[0], [dupA]);
});

test('【失敗系】applyReconcilePlan: commitUserFnがrejectしたら例外がそのまま伝播する', async () => {
  const plan = makePlan({ adds: [material({ code: '999999999999' })] });
  await assert.rejects(
    () => applyReconcilePlan(plan, {
      kind: CatalogKind.MATERIAL,
      currentUser: [],
      commitUserFn: async () => { throw new Error('保存失敗テスト用'); },
      addAliasesFn: () => {},
    }),
    /保存失敗テスト用/,
  );
});

test('applyReconcilePlan: aliasesが非空ならaddAliasesFnが1回呼ばれ、aliasPairsとして返る', async () => {
  const plan = makePlan({ aliases: [{ from: 'a', to: 'b' }] });
  const addAliasesCalls = [];
  const result = await applyReconcilePlan(plan, {
    kind: CatalogKind.MATERIAL,
    currentUser: [],
    commitUserFn: async () => {},
    addAliasesFn: (kind, pairs) => addAliasesCalls.push({ kind, pairs }),
  });
  assert.equal(addAliasesCalls.length, 1);
  assert.deepEqual(addAliasesCalls[0], { kind: CatalogKind.MATERIAL, pairs: [{ from: 'a', to: 'b' }] });
  assert.deepEqual(result.aliasPairs, [{ from: 'a', to: 'b' }]);
});

test('applyReconcilePlan: aliases/adds両方空ならaddAliasesFn・commitUserFnとも呼ばれない', async () => {
  const plan = makePlan();
  const addAliasesCalls = [];
  const commitCalls = [];
  const result = await applyReconcilePlan(plan, {
    kind: CatalogKind.MATERIAL,
    currentUser: [],
    commitUserFn: async (nextUser) => commitCalls.push(nextUser),
    addAliasesFn: (kind, pairs) => addAliasesCalls.push({ kind, pairs }),
  });
  assert.equal(addAliasesCalls.length, 0);
  assert.equal(commitCalls.length, 0);
  assert.deepEqual(result, { addedKeys: [], aliasPairs: [], skipped: [] });
});

// ---- QA指摘Major-1（2026-09-23）: alias確定したdocエントリはoverlayから外す ----
// 根本原因: 6-1の自動alias（内容完全一致・別コード）は参照だけ読み替えてdocエントリを
// overlayに残していたため、composeCatalogのR17合成後検査が「同内容がbuiltinとdocに併存」で
// 例外になり、仕上げモードinit・壁再生成・保存が止まっていた（step6-1-test.stqを本番起動経路
// で読むと再現。修正後は再現しないことをrepro-major1.mjs相当の手順で実測——報告参照）。

test('applyReconcilePlan: aliasを確定したdocエントリはoverlayのdocから外れる（変異=removeDocEntry呼び出し除去で赤）', async () => {
  const docEntry = material({ code: '999999999999' });
  const otherDoc = material({ code: '999999999998', name: '他の同梱材' });
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry, otherDoc] });
  const plan = makePlan({ aliases: [{ from: '999999999999', to: '301000000001' }] });

  await applyReconcilePlan(plan, {
    kind: CatalogKind.MATERIAL,
    currentUser: [],
    commitUserFn: async () => {},
    addAliasesFn: () => {},
  });

  assert.deepEqual(
    overlayFor(CatalogKind.MATERIAL).doc.map(e => e.code), ['999999999998'],
    'alias確定した999999999999だけがdocから外れ、無関係な999999999998は残る',
  );
});

test('applyReconcilePlan: fromがdocに無いaliasはremoveDocEntryFnを呼ばない（場面(b)=unresolved-code由来。無いキーの例外を投げさせない）', async () => {
  setOverlay(CatalogKind.MATERIAL, { doc: [material({ code: '999999999998' })] });
  const removeDocEntryCalls = [];
  // docに無いキー（グラフ参照の旧コード相当）をfromに持つalias
  const plan = makePlan({ aliases: [{ from: '999999999999', to: '301000000001' }] });

  await assert.doesNotReject(() => applyReconcilePlan(plan, {
    kind: CatalogKind.MATERIAL,
    currentUser: [],
    commitUserFn: async () => {},
    addAliasesFn: () => {},
    removeDocEntryFn: (kind, key) => removeDocEntryCalls.push(key),
  }));

  assert.deepEqual(removeDocEntryCalls, [], 'docに無いfromではremoveDocEntryFnを呼ばない');
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).doc.map(e => e.code), ['999999999998'], 'docの中身は変わらない');
});

test('結合【QA指摘Major-1の再現ケース】: 内容完全一致・別コードのdocを含む束をoverlayに立て、reconcile(plan→apply)後はcomposeCatalogが例外にならない', async () => {
  const builtinEntry = material({ code: '301000000001', name: 'せっこうボード t=9.5' });
  // builtinと内容完全一致（name/spec/x/y/thickness）・codeだけ違うdocエントリ
  const docEntry = material({ code: '999900000001', name: 'せっこうボード t=9.5' });
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry] });

  const plan = planIncomingReconcile({
    kind: CatalogKind.MATERIAL, docEntries: [docEntry], appEntries: [builtinEntry],
  });
  assert.deepEqual(plan.aliases, [{ from: '999900000001', to: '301000000001' }]);

  await applyReconcilePlan(plan, {
    kind: CatalogKind.MATERIAL,
    currentUser: [],
    commitUserFn: async () => {},
    addAliasesFn: () => {},
  });

  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).doc, [], 'aliasを確定したdocエントリがoverlayから外れている');
  assert.doesNotThrow(
    () => composeCatalog(CatalogKind.MATERIAL, [builtinEntry]),
    'reconcile後はR17（合成後の重複禁止検査）に引っかからず composeCatalog が通る（QA指摘Major-1）',
  );
});

// ---- 結合: store.jsの実際の呼び出し方（applyReconcilePlanの結果をformatReconcileNoticeへ渡す）----
// ---- ステップ7d: kind別の挙動（内装・境界マスターは完全一致のみ・通知文の種別名出し分け） ----
function interiorMaster(overrides) {
  return { key: 'LIVING_ROOM', label: 'リビング', wallMaterial: 'クロス', wallFinish: 'AEP', ceilingHeight: 2400, ...overrides };
}

test('planIncomingReconcile: kind=interiorMasterは1項目違いでもproposalsに積まれずadds（完全一致のみ。段を外さない契約）', () => {
  const existing = interiorMaster({ key: 'LIVING_ROOM' });
  // ceilingHeightだけ違う（matchFields=wallMaterial/wallFinish/ceilingHeightの3つでminMatchFields=3
  // ＝段を外さない。部分一致でも候補が出ない設計）
  const doc = interiorMaster({ key: 'GUEST_ROOM', ceilingHeight: 2600 });
  const plan = planIncomingReconcile({
    kind: CatalogKind.INTERIOR_MASTER, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.proposals, [], '1項目違いはproposeではなくadd（内装マスターは完全一致のみ）');
  assert.deepEqual(plan.adds, [doc]);
});

test('planIncomingReconcile: kind=interiorMasterは内容完全一致・別キーならaliasesへ（proposalsではなく自動読み替え）', () => {
  const existing = interiorMaster({ key: 'LIVING_ROOM' });
  const doc = interiorMaster({ key: 'GUEST_ROOM' }); // wallMaterial/wallFinish/ceilingHeight完全一致・keyだけ違う
  const plan = planIncomingReconcile({
    kind: CatalogKind.INTERIOR_MASTER, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.aliases, [{ from: 'GUEST_ROOM', to: 'LIVING_ROOM' }]);
  assert.deepEqual(plan.proposals, []);
});

test('applyReconcilePlan: kind=interiorMasterの追加を2回reconcileしてもuserが増えない（1回目の結果を反映して再planすると重複しない）', async () => {
  const addEntry = interiorMaster({ key: 'USER_ROOM', label: 'ユーザー部屋' });

  const firstPlan = planIncomingReconcile({
    kind: CatalogKind.INTERIOR_MASTER, docEntries: [addEntry], appEntries: [],
  });
  assert.deepEqual(firstPlan.adds, [addEntry]);

  let userLib = [];
  await applyReconcilePlan(firstPlan, {
    kind: CatalogKind.INTERIOR_MASTER,
    currentUser: userLib,
    commitUserFn: async (nextUser) => { userLib = nextUser; },
    addAliasesFn: () => {},
  });
  assert.deepEqual(userLib, [addEntry]);

  const secondPlan = planIncomingReconcile({
    kind: CatalogKind.INTERIOR_MASTER, docEntries: [addEntry], appEntries: userLib,
  });
  assert.deepEqual(secondPlan.adds, [], '2回目はuserライブラリに既にあるのでaddsは空');
  const commitCalls2 = [];
  await applyReconcilePlan(secondPlan, {
    kind: CatalogKind.INTERIOR_MASTER,
    currentUser: userLib,
    commitUserFn: async (nextUser) => { commitCalls2.push(nextUser); },
    addAliasesFn: () => {},
  });
  assert.equal(commitCalls2.length, 0, '2回目はcommitUserFnが呼ばれずuserは増えない');
});

test('formatReconcileNotice: kind=interiorMasterは名詞が「内装マスター」・読み替え文は「キー」（コードではない）', () => {
  const plan = { adoptDoc: [], adds: [], aliases: [{ from: 'a', to: 'b' }] };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.INTERIOR_MASTER });
  assert.equal(msg, '内装マスターキーの読み替えを1件適用しました（保存すると確定します）');
});

test('formatReconcileNotice: kind=boundaryMasterは不一致・追加の文にも「境界マスター」が入る', () => {
  const plan = {
    adoptDoc: [{ key: 'k', diffFields: ['layers'], notify: true, label: '外壁' }],
    adds: [{ key: 'X', label: '新境界' }],
  };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.BOUNDARY_MASTER, addedCount: 1 });
  assert.match(msg, /同梱カタログと内容が異なる境界マスターが1件あります/);
  assert.match(msg, /ライブラリに新しい境界マスターが1件追加されました/);
});

// ---- ステップ8f: kind=section（断面）の照合。matchFields=['materialType','shape','width',
// 'height','webThickness','flangeThickness','wallThickness']・minMatchFields=2（catalogKinds.js
// 登録表）。8bで実装済みのsection.rewrite（SECTION_MEMBER_LISTSを回すcopy-on-write）がaliasを
// 効かせるため、この段の8fではRECONCILE_KINDS/BUNDLED_KINDSへの追加とplanIncomingReconcile側の
// 純ロジックの疎通だけを確認する。 ----
function section(overrides) {
  return { key: 'WOOD-120x120', materialType: 'WOOD', shape: 'rect', width: 120, height: 120, label: '120×120', ...overrides };
}

test('planIncomingReconcile: kind=sectionは内容完全一致・別キーならaliasesへ（自動読み替え。8bのrewriteが効く）', () => {
  const existing = section({ key: 'WOOD-120x120' });
  const doc = section({ key: 'WOOD-999x999', label: '120×120（同梱）' }); // materialType/shape/width/height完全一致・keyだけ違う
  const plan = planIncomingReconcile({
    kind: CatalogKind.SECTION, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.aliases, [{ from: 'WOOD-999x999', to: 'WOOD-120x120' }]);
  assert.deepEqual(plan.proposals, []);
  assert.deepEqual(plan.adds, []);
});

test('planIncomingReconcile: kind=sectionは同materialType・shapeで寸法だけ違えばproposalsへ（minMatchFields:2で段を外せる）', () => {
  const existing = section({ key: 'WOOD-120x120', width: 120, height: 120 });
  const doc = section({ key: 'WOOD-150x150', width: 150, height: 150, label: '150×150' }); // materialType/shapeだけ一致
  const plan = planIncomingReconcile({
    kind: CatalogKind.SECTION, docEntries: [doc], appEntries: [existing],
  });
  assert.equal(plan.proposals.length, 1, '寸法違いは完全一致ではないためproposalsへ（builtinに無いユーザー断面の想定経路）');
  assert.equal(plan.proposals[0].from, 'WOOD-150x150');
  assert.equal(plan.proposals[0].candidates[0].key, 'WOOD-120x120');
  assert.deepEqual(plan.adds, []);
});

test('planIncomingReconcile: kind=sectionはmaterialType/shapeとも一致しなければ（minMatchFields未満）addsへ', () => {
  const existing = section({ key: 'WOOD-120x120' });
  const doc = { key: 'STEEL-H100x100', materialType: 'STEEL', shape: 'hSection', width: 100, height: 100, webThickness: 6, flangeThickness: 8, label: 'H-100×100×6×8' };
  const plan = planIncomingReconcile({
    kind: CatalogKind.SECTION, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.proposals, []);
  assert.deepEqual(plan.adds, [doc]);
});

test('formatReconcileNotice: kind=sectionは名詞が「断面」', () => {
  const plan = { adoptDoc: [], adds: [], aliases: [{ from: 'a', to: 'b' }] };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.SECTION });
  assert.equal(msg, '断面キーの読み替えを1件適用しました（保存すると確定します）');
});

// ---- ステップ10d: kind=openingSubType（建具種別）の照合。matchFields=['category','mechanism',
// 'childRatio','fireLeaves','fireAngle','slideLayout','wallKinds','defaultWidth','defaultHeight',
// 'label']・minMatchFields=2（catalogKinds.js登録表）。silentDiffFields=['label']（Q-B裁定・
// 2026-09-23。呼称差は通知しない）。isSupportedフックが未知mechanismを場面(c)unsupportedへ回す。 ----
function openingSubType(overrides) {
  return {
    category: 'fitting', key: 'singleSwing', label: '片開き戸',
    mechanism: 'swing', defaultWidth: 800, defaultHeight: 2000,
    ...overrides,
  };
}

test('planIncomingReconcile: kind=openingSubTypeは同キー・全内容一致→same', () => {
  const existing = openingSubType();
  const plan = planIncomingReconcile({
    kind: CatalogKind.OPENING_SUB_TYPE, docEntries: [openingSubType()], appEntries: [existing],
  });
  assert.deepEqual(plan.same, ['fitting:singleSwing']);
  assert.deepEqual(plan.adoptDoc, []);
  assert.deepEqual(plan.unsupported, []);
});

test('planIncomingReconcile: kind=openingSubTypeは同キー・label違いのみ→adoptDocだがnotify:false（silentDiffFields=label。Q-B裁定）', () => {
  const existing = openingSubType({ label: '片開き戸(本体)' });
  const plan = planIncomingReconcile({
    kind: CatalogKind.OPENING_SUB_TYPE, docEntries: [openingSubType({ label: '片開き戸(同梱)' })], appEntries: [existing],
  });
  assert.equal(plan.adoptDoc.length, 1);
  assert.deepEqual(plan.adoptDoc[0].diffFields, ['label']);
  assert.equal(plan.adoptDoc[0].notify, false, 'labelだけの差は通知しない契約（Q-B）');
});

test('planIncomingReconcile: kind=openingSubTypeは同キー・defaultHeight違い→adoptDocでnotify:true（silentDiffFields対象外）', () => {
  const existing = openingSubType({ defaultHeight: 2000 });
  const plan = planIncomingReconcile({
    kind: CatalogKind.OPENING_SUB_TYPE, docEntries: [openingSubType({ defaultHeight: 1800 })], appEntries: [existing],
  });
  assert.deepEqual(plan.adoptDoc[0].diffFields, ['defaultHeight']);
  assert.equal(plan.adoptDoc[0].notify, true, 'defaultHeightの差は通知する契約（未設定の旧建具が既定値へ落ちる実害があるため）');
});

test('【失敗系】planIncomingReconcile: kind=openingSubTypeはlabel＋defaultHeightが同時に違う同梱もnotify:false（silentが1つでもあれば無音になるR12既存規約。Minor-1）', () => {
  const existing = openingSubType({ label: '片開き戸(本体)', defaultHeight: 2000 });
  const doc = openingSubType({ label: '片開き戸(同梱)', defaultHeight: 1800 });
  const plan = planIncomingReconcile({
    kind: CatalogKind.OPENING_SUB_TYPE, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.adoptDoc[0].diffFields, ['label', 'defaultHeight']);
  assert.equal(plan.adoptDoc[0].notify, false, 'silentDiffFields(label)が混ざると非silent項目(defaultHeight)の差も一緒に無音化する（R12規約。規約変更は別途裁定）');
  assert.equal(formatReconcileNotice(plan, { kind: CatalogKind.OPENING_SUB_TYPE }), null, '通知するものが無いのでformatReconcileNoticeはnull');
});

test('planIncomingReconcile: kind=openingSubTypeは別キー・全内容一致→aliasesへ（自動読み替え）', () => {
  const existing = openingSubType({ key: 'singleSwing' });
  const doc = openingSubType({ key: 'myDoor', label: '片開き戸' }); // 全matchFields一致・keyだけ違う
  const plan = planIncomingReconcile({
    kind: CatalogKind.OPENING_SUB_TYPE, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.aliases, [{ from: 'fitting:myDoor', to: 'fitting:singleSwing' }]);
  assert.deepEqual(plan.proposals, []);
  assert.deepEqual(plan.adds, []);
});

test('planIncomingReconcile: kind=openingSubTypeは寸法だけ違えばproposalsへ（minMatchFields:2で段を外せる。builtinに無いユーザー建具の想定経路）', () => {
  const existing = openingSubType({ key: 'singleSwing', defaultWidth: 800, defaultHeight: 2000 });
  const doc = openingSubType({ key: 'wideSwing', defaultWidth: 900, defaultHeight: 2100, label: '広幅片開き戸' });
  const plan = planIncomingReconcile({
    kind: CatalogKind.OPENING_SUB_TYPE, docEntries: [doc], appEntries: [existing],
  });
  assert.equal(plan.proposals.length, 1, '寸法違いは完全一致ではないためproposalsへ');
  assert.equal(plan.proposals[0].from, 'fitting:wideSwing');
  assert.equal(plan.proposals[0].candidates[0].key, 'singleSwing');
  assert.deepEqual(plan.adds, []);
});

test('planIncomingReconcile: kind=openingSubTypeはcategory/mechanismとも一致しなければ（minMatchFields未満）addsへ', () => {
  const existing = openingSubType({ key: 'singleSwing', category: 'fitting', mechanism: 'swing' });
  const doc = { category: 'window', key: 'myWindow', label: '窓', mechanism: 'fixed', defaultWidth: 600, defaultHeight: 600 };
  const plan = planIncomingReconcile({
    kind: CatalogKind.OPENING_SUB_TYPE, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.proposals, []);
  assert.deepEqual(plan.adds, [doc]);
});

test('【失敗系】planIncomingReconcile: kind=openingSubTypeは未知mechanismのdocエントリをunsupportedへ回し、同一/alias/propose/addの分類対象から外す（isSupportedフック）', () => {
  const existing = openingSubType();
  const doc = openingSubType({ key: 'teleportDoor', mechanism: 'teleport' });
  const plan = planIncomingReconcile({
    kind: CatalogKind.OPENING_SUB_TYPE, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.unsupported, [doc]);
  assert.deepEqual(plan.same, []);
  assert.deepEqual(plan.aliases, []);
  assert.deepEqual(plan.proposals, []);
  assert.deepEqual(plan.adds, []);
});

// Minor-3（QA指摘・2026-09-23）: unsupported行が複合キー（`${category}:${key}`）を運ぶことを固定する
// （catalog/resolveQueue.js buildResolveRows は読むだけ——10eが編集中のresolveQueue.test.js側は触らない）。
test('buildResolveRows: kind=openingSubTypeのunsupported行はtargetKeyに複合キーを運び、allowedActionsにpick/deferを持つ', () => {
  const doc = openingSubType({ key: 'teleportDoor', mechanism: 'teleport' });
  const rows = buildResolveRows({ kind: CatalogKind.OPENING_SUB_TYPE, unsupported: [doc] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenario, 'unsupported');
  assert.equal(rows[0].targetKey, 'fitting:teleportDoor');
  assert.ok(rows[0].allowedActions.includes('pick'), 'unsupported行はpick（代替を指示）を許可するはず');
  assert.ok(rows[0].allowedActions.includes('defer'), 'unsupported行はdefer（保留）を許可するはず');
});

test('formatReconcileNotice: kind=openingSubTypeは名詞が「建具種別」', () => {
  const plan = { adoptDoc: [], adds: [], aliases: [{ from: 'a', to: 'b' }] };
  const msg = formatReconcileNotice(plan, { kind: CatalogKind.OPENING_SUB_TYPE });
  assert.equal(msg, '建具種別キーの読み替えを1件適用しました（保存すると確定します）');
});

// ---- 結合（10bと接続する縦の1本）: reconcile由来のaliasが文書固有の読み替え表へ入り、
// applyDocumentCodeNormalizationがopenings[].subTypeを実際に書換えることを確認する。
// 10bはcodeNormalization.test.js側でaddDocumentAliasesを直接呼ぶ形で固定済み——ここでは
// planIncomingReconcile→applyReconcilePlan（既定のaddAliasesFn=addDocumentAliases）という
// 本番の呼び出し経路を通しても同じ結果になることを固定する。 ----
test('結合(10b接続): kind=openingSubTypeのalias確定後、applyDocumentCodeNormalizationがopenings[].subTypeを書換える', async () => {
  const existing = openingSubType({ key: 'singleSwing' });
  const doc = openingSubType({ key: 'myDoor' }); // 全matchFields一致・keyだけ違う
  const plan = planIncomingReconcile({
    kind: CatalogKind.OPENING_SUB_TYPE, docEntries: [doc], appEntries: [existing],
  });
  assert.deepEqual(plan.aliases, [{ from: 'fitting:myDoor', to: 'fitting:singleSwing' }]);

  await applyReconcilePlan(plan, {
    kind: CatalogKind.OPENING_SUB_TYPE,
    currentUser: [],
    commitUserFn: async () => {},
  });

  const snapshot = { openings: [{ id: 'o1', category: 'fitting', subType: 'myDoor' }] };
  const normalized = applyDocumentCodeNormalization(snapshot);
  assert.equal(normalized.openings[0].subType, 'singleSwing', 'alias確定後は文書固有の読み替え表でsubTypeが書換わるはず');
});

test('結合: R17で1件skipされた場合、applyReconcilePlanの結果(addedKeys.length/skipped.length)をformatReconcileNoticeへ渡すと追加文＋スキップ文が出る', async () => {
  const dupA = material({ code: '999999999991', name: '同じ内容' });
  const dupB = material({ code: '999999999992', name: '同じ内容' });
  const plan = makePlan({ adds: [dupA, dupB] });
  const result = await applyReconcilePlan(plan, {
    kind: CatalogKind.MATERIAL,
    currentUser: [],
    commitUserFn: async () => {},
    addAliasesFn: () => {},
  });
  const msg = formatReconcileNotice(plan, {
    kind: CatalogKind.MATERIAL,
    addedCount: result.addedKeys.length,
    skippedCount: result.skipped.length,
  });
  assert.match(msg, /1件.*追加されました/);
  assert.match(msg, /1件は同じ内容の材料が既にあるため追加しませんでした/);
});
