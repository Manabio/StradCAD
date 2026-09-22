import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIncomingReconcile, formatReconcileNotice, applyReconcilePlan } from './incomingReconcile.js';
import { CatalogKind } from './catalogKinds.js';

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
  const msg = formatReconcileNotice(plan);
  assert.match(msg, /1件/);
  assert.match(msg, /A材/);
});

test('formatReconcileNotice: 追加のみ（不一致無し）→ addedCountで件数を含む1文', () => {
  const plan = { adoptDoc: [], adds: [material({ code: '999999999999', name: 'B材' })] };
  const msg = formatReconcileNotice(plan, { addedCount: 1 });
  assert.match(msg, /1件/);
  assert.match(msg, /B材/);
});

test('formatReconcileNotice: addedCountを渡さなければ（既定0）plan.adds非空でも「追加」文は出ない', () => {
  const plan = { adoptDoc: [], adds: [material({ code: '999999999999', name: 'B材' })] };
  assert.equal(formatReconcileNotice(plan), null, 'addedCount省略時は0扱い（R17で全て弾かれた場合に「追加されました」と誤報しないため）');
});

test('formatReconcileNotice: 不一致＋追加の両方 → 2文をまとめて1本にする', () => {
  const plan = {
    adoptDoc: [{ key: 'k', diffFields: ['name'], notify: true, label: 'A材' }],
    adds: [material({ code: '999999999999', name: 'B材' })],
  };
  const msg = formatReconcileNotice(plan, { addedCount: 1 });
  assert.match(msg, /A材/);
  assert.match(msg, /B材/);
});

test('formatReconcileNotice: 全セクション0件（不一致・追加・スキップ・読み替え）ならnull', () => {
  assert.equal(formatReconcileNotice({ adoptDoc: [], adds: [], aliases: [] }), null);
  assert.equal(formatReconcileNotice({ adoptDoc: [], adds: [], aliases: [] }, { addedCount: 0, skippedCount: 0 }), null);
});

test('formatReconcileNotice: notify:falseの不一致は数えない（他セクションも0ならnull）', () => {
  const plan = { adoptDoc: [{ key: 'k', diffFields: ['spec'], notify: false, label: 'A材' }], adds: [] };
  assert.equal(formatReconcileNotice(plan), null);
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
  const msg = formatReconcileNotice(plan, { addedCount: 3 });
  assert.match(msg, /材1・材2ほか1件/);
});

// ---- QA指摘2: skippedCountの補足文 ----
test('formatReconcileNotice: skippedCountが非空なら「N件は同じ内容の材料が既にあるため追加しませんでした」を1文足す', () => {
  const plan = { adoptDoc: [], adds: [material({ code: '999999999999', name: 'B材' })] };
  const msg = formatReconcileNotice(plan, { addedCount: 1, skippedCount: 1 });
  assert.match(msg, /1件.*追加されました/);
  assert.match(msg, /1件は同じ内容の材料が既にあるため追加しませんでした/);
});

test('formatReconcileNotice: addedCount=0でもskippedCountが非空ならスキップ文だけ出る', () => {
  const plan = { adoptDoc: [], adds: [] };
  const msg = formatReconcileNotice(plan, { addedCount: 0, skippedCount: 2 });
  assert.equal(msg, '2件は同じ内容の材料が既にあるため追加しませんでした');
});

// ---- QA指摘3: aliasのみ適用のときも通知する ----
test('formatReconcileNotice: aliasのみ（不一致・追加・スキップ無し）→ 読み替え適用の1文だけ出る', () => {
  const plan = { adoptDoc: [], adds: [], aliases: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }] };
  const msg = formatReconcileNotice(plan);
  assert.equal(msg, '材料コードの読み替えを2件適用しました（保存すると確定します）');
});

test('formatReconcileNotice: alias0件なら読み替え文は省略される（他セクションで確認）', () => {
  const plan = { adoptDoc: [], adds: [material({ code: '999999999999', name: 'B材' })], aliases: [] };
  const msg = formatReconcileNotice(plan, { addedCount: 1 });
  assert.doesNotMatch(msg, /読み替え/);
});

test('formatReconcileNotice: 不一致・追加・スキップ・読み替えの全部あり → 4文すべてを1本にまとめる', () => {
  const plan = {
    adoptDoc: [{ key: 'k', diffFields: ['name'], notify: true, label: 'A材' }],
    adds: [material({ code: '999999999999', name: 'B材' })],
    aliases: [{ from: 'a', to: 'b' }],
  };
  const msg = formatReconcileNotice(plan, { addedCount: 1, skippedCount: 1 });
  assert.match(msg, /A材/);
  assert.match(msg, /B材/);
  assert.match(msg, /1件は同じ内容の材料が既にあるため追加しませんでした/);
  assert.match(msg, /材料コードの読み替えを1件適用しました/);
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
    addAliasesFn: (pairs) => addAliasesCalls.push(pairs),
  });
  assert.equal(addAliasesCalls.length, 1);
  assert.deepEqual(addAliasesCalls[0], [{ from: 'a', to: 'b' }]);
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
    addAliasesFn: (pairs) => addAliasesCalls.push(pairs),
  });
  assert.equal(addAliasesCalls.length, 0);
  assert.equal(commitCalls.length, 0);
  assert.deepEqual(result, { addedKeys: [], aliasPairs: [], skipped: [] });
});

// ---- 結合: store.jsの実際の呼び出し方（applyReconcilePlanの結果をformatReconcileNoticeへ渡す）----
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
    addedCount: result.addedKeys.length,
    skippedCount: result.skipped.length,
  });
  assert.match(msg, /1件.*追加されました/);
  assert.match(msg, /1件は同じ内容の材料が既にあるため追加しませんでした/);
});
