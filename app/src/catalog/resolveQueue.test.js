import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResolveRows, applyResolveDecisions, candidatesForUnresolved, replaceRowsByScenario, defaultResolveDecision,
} from './resolveQueue.js';
import { CatalogKind } from './catalogKinds.js';

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

// ---- candidatesForUnresolved ----
test('candidatesForUnresolved: removedEntryがあれば内容一致検索（matchByContent→rankCandidates）で候補を返す', () => {
  const removedEntry = { name: 'アスファルトプライマー', spec: '溶剤系アスファルトプライマー（吸水・接着性向上）', x: 0, y: 0, thickness: null, category: 'finish' };
  const hit = material({ code: '401000000099', name: 'アスファルトプライマー', spec: '溶剤系アスファルトプライマー（吸水・接着性向上）', thickness: null });
  const unrelated = material({ code: '999999999998', name: '無関係の材' });
  const candidates = candidatesForUnresolved('111111111211', { removedEntry, appEntries: [hit, unrelated] });
  assert.deepEqual(candidates.map(c => c.code), ['401000000099']);
});

test('candidatesForUnresolved: removedEntryが無ければ大分類・中分類が同じ材（suggestByClass）を候補にする', () => {
  const sameClass = material({ code: '301000000005', name: '同分類材' });
  const otherClass = material({ code: '401000000001', name: '別分類材' });
  const candidates = candidatesForUnresolved('301000000099', { appEntries: [sameClass, otherClass] });
  assert.deepEqual(candidates.map(c => c.code), ['301000000005']);
});

test('【失敗系】candidatesForUnresolved: 旧1111コード（旧体系＝未分類）はmajor/minorがMATERIAL_CLASSESに無いため候補0（候補なし）', () => {
  const candidates = candidatesForUnresolved('111111111500', { appEntries: [material()] });
  assert.deepEqual(candidates, []);
});

// ---- buildResolveRows ----
test('buildResolveRows: unresolvedはcodeでグルーピングされ、usageに複数の参照箇所が積まれる', () => {
  const unresolved = [
    { code: '111111111500', location: 'room', roomId: 'r1', key: 'wallMaterial' },
    { code: '111111111500', location: 'edge', edgeKey: 'e1', key: 'wallFinish' },
  ];
  const rows = buildResolveRows({ unresolved, appEntries: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenario, 'unresolved-code');
  assert.equal(rows[0].id, `unresolved-code:${CatalogKind.MATERIAL}:111111111500`);
  assert.equal(rows[0].usage.length, 2);
  assert.deepEqual(rows[0].allowedActions, ['approve', 'pick', 'defer']);
});

test('buildResolveRows: libraryConflictsはuserEntriesからtargetEntryを引き、同keyを除いた候補を持つ', () => {
  const userEntry = material({ code: '301000000001', name: 'ユーザー版' });
  const similar = material({ code: '301000000002', name: 'ユーザー版' }); // name一致（matchFieldsの一部）
  const rows = buildResolveRows({
    libraryConflicts: [{ key: '301000000001', diffFields: ['name'] }],
    userEntries: [userEntry],
    appEntries: [userEntry, similar],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenario, 'library-conflict');
  assert.equal(rows[0].targetEntry, userEntry);
  assert.equal(rows[0].renumberTo, '301000000003', '既知コード(001,002)の次の空き番');
  assert.deepEqual(rows[0].allowedActions, ['approve', 'pick', 'markOverride', 'defer']);
});

test('buildResolveRows: unsupportedはdocエントリそのものを対象にした行になる', () => {
  const entry = material({ code: '999999999999', name: '未対応材' });
  const rows = buildResolveRows({ unsupported: [entry] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenario, 'unsupported');
  assert.equal(rows[0].targetEntry, entry);
  assert.deepEqual(rows[0].allowedActions, ['approve', 'pick', 'defer']);
});

test('buildResolveRows: proposalsはfrom/candidates/entryをそのまま行へ運ぶ', () => {
  const entry = material({ code: '999999999999' });
  const candidate = material({ code: '301000000001' });
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenario, 'propose');
  assert.equal(rows[0].targetKey, '999999999999');
  assert.deepEqual(rows[0].candidates, [candidate]);
  // コーディネーター裁定（2026-09-23）: 'defer'（保留）は全場面で選べる。propose既定decisionが
  // deferになったことに合わせ、ラジオボタンにも表示されるようallowedActionsへ追加した。
  assert.deepEqual(rows[0].allowedActions, ['approve', 'pick', 'addToLibrary', 'defer']);
});

test('buildResolveRows: 同じ入力から再構築すると同じ行（内容・順序）が出る', () => {
  const args = {
    proposals: [{ from: '999999999999', candidates: [material({ code: '301000000001' })], entry: material({ code: '999999999999' }) }],
    unresolved: [{ code: '111111111500', location: 'room', roomId: 'r1' }],
  };
  const rows1 = buildResolveRows(args);
  const rows2 = buildResolveRows(args);
  assert.deepEqual(rows1, rows2);
});

// ---- defaultResolveDecision（コーディネーター裁定・2026-09-23）: propose行は候補数に関わらず
// 既定defer（R10「自動では置きかえない」の徹底）。unresolved-code/library-conflictは現行どおり
// （候補があれば先頭候補をapprove）。ui/CatalogResolveDialog.jsxのdefaultDecisionはこれを経由する
// （唯一の定義箇所。変異=propose行をapproveに戻す、で下の1本目が赤くなる）。----
test('defaultResolveDecision: propose行は候補があっても既定defer（自動承認しない）', () => {
  const candidate = material({ code: '301000000001' });
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry: material({ code: '999999999999' }) }] });
  assert.equal(rows[0].scenario, 'propose');
  assert.deepEqual(defaultResolveDecision(rows[0]), { action: 'defer', pick: null });
});

test('defaultResolveDecision: 候補ありのunresolved-code行は現行どおり先頭候補をapprove', () => {
  // 未解決コード '301099999999'（major=30,minor=10）と candidate '301000000001'（同じmajor=30,minor=10）
  // ——suggestByClass（大分類・中分類が同じ材を候補にする）が候補を拾える組合せにする。
  const candidate = material({ code: '301000000001' });
  const rows = buildResolveRows({ unresolved: [{ code: '301099999999', location: 'floor' }], appEntries: [candidate] });
  assert.equal(rows[0].scenario, 'unresolved-code');
  assert.ok(rows[0].candidates.length > 0, '前提: candidatesForUnresolved(suggestByClass)で同分類の候補が拾える');
  assert.deepEqual(defaultResolveDecision(rows[0]), { action: 'approve', pick: '301000000001' });
});

test('defaultResolveDecision: 候補ありのlibrary-conflict行も現行どおり先頭候補をapprove', () => {
  const target = material({ code: '301000000001', name: '競合材' });
  const other = material({ code: '301000000002', name: '競合材' }); // targetと内容一致（matchByContent対象）
  const rows = buildResolveRows({
    libraryConflicts: [{ key: '301000000001', diffFields: [] }],
    userEntries: [target],
    appEntries: [other],
  });
  assert.equal(rows[0].scenario, 'library-conflict');
  assert.ok(rows[0].candidates.length > 0, '前提: 内容一致するotherが候補に入る');
  assert.deepEqual(defaultResolveDecision(rows[0]), { action: 'approve', pick: '301000000002' });
});

test('defaultResolveDecision: 候補が無ければ場面を問わず保留（defer）', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '999999999999', location: 'floor' }], appEntries: [] });
  assert.deepEqual(defaultResolveDecision(rows[0]), { action: 'defer', pick: null });
});

// ---- applyResolveDecisions ----
test('applyResolveDecisions: approve（propose/unresolved-code/unsupported）は候補先頭へのaliasを積む', () => {
  const candidate = material({ code: '301000000001' });
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry: material({ code: '999999999999' }) }] });
  const { aliasPairs, userOps, deferredRowIds } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'approve' }]]));
  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.MATERIAL, from: '999999999999', to: '301000000001' }]);
  assert.deepEqual(userOps, []);
  assert.deepEqual(deferredRowIds, []);
});

test('applyResolveDecisions: pick（代替材を指示）はcandidatesに縛られず任意のキーへaliasする（自由ピッカー対応）', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const { aliasPairs } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'pick', pick: '301000000009' }]]));
  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.MATERIAL, from: '111111111500', to: '301000000009' }]);
});

test('applyResolveDecisions: pick（library-conflict）はaliasに加えてユーザーエントリのremoveを積む', () => {
  const userEntry = material({ code: '301000000001' });
  const rows = buildResolveRows({
    libraryConflicts: [{ key: '301000000001', diffFields: ['name'] }],
    userEntries: [userEntry], appEntries: [userEntry],
  });
  const { aliasPairs, userOps } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'pick', pick: '301000000099' }]]));
  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.MATERIAL, from: '301000000001', to: '301000000099' }]);
  assert.deepEqual(userOps, [{ op: 'remove', kind: CatalogKind.MATERIAL, key: '301000000001' }]);
});

test('applyResolveDecisions: addToLibrary（propose）はdocエントリをそのままupsertする（置きかえない）', () => {
  const entry = material({ code: '999999999999' });
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [material({ code: '301000000001' })], entry }] });
  const { aliasPairs, userOps } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'addToLibrary' }]]));
  assert.deepEqual(aliasPairs, [], 'addToLibraryは置きかえない＝aliasを積まない');
  assert.deepEqual(userOps, [{ op: 'upsert', kind: CatalogKind.MATERIAL, entry }]);
});

test('applyResolveDecisions: renumber（library-conflictのapprove）は同分類の空き番へのuserOpsを積む', () => {
  const userEntry = material({ code: '301000000001', name: 'ユーザー版' });
  const rows = buildResolveRows({
    libraryConflicts: [{ key: '301000000001', diffFields: ['name'] }],
    userEntries: [userEntry], appEntries: [userEntry],
  });
  const { aliasPairs, userOps } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'approve' }]]));
  assert.deepEqual(aliasPairs, [], 'renumberはaliasを積まない（カタログ内の採番替えのみ）');
  assert.deepEqual(userOps, [{ op: 'renumber', kind: CatalogKind.MATERIAL, from: '301000000001', to: rows[0].renumberTo }]);
});

test('applyResolveDecisions: markOverride（library-conflict）はoverridesBuiltin:trueを立てたupsertを積む', () => {
  const userEntry = material({ code: '301000000001', name: 'ユーザー版' });
  const rows = buildResolveRows({
    libraryConflicts: [{ key: '301000000001', diffFields: ['name'] }],
    userEntries: [userEntry], appEntries: [userEntry],
  });
  const { userOps } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'markOverride' }]]));
  assert.equal(userOps.length, 1);
  assert.equal(userOps[0].op, 'upsert');
  assert.equal(userOps[0].entry.overridesBuiltin, true);
  assert.equal(userOps[0].entry.code, '301000000001');
});

test('applyResolveDecisions: defer（明示・省略の両方）はaliasPairs/userOpsに出ずdeferredRowIdsに残る', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const explicit = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'defer' }]]));
  assert.deepEqual(explicit.aliasPairs, []);
  assert.deepEqual(explicit.userOps, []);
  assert.deepEqual(explicit.deferredRowIds, [rows[0].id]);

  const omitted = applyResolveDecisions(rows, new Map()); // 決定なし＝省略も保留と同じ扱い
  assert.deepEqual(omitted.deferredRowIds, [rows[0].id]);
});

test('applyResolveDecisions: プレーンオブジェクト形式の decisions（{[rowId]: {action}}）も受け付ける', () => {
  const candidate = material({ code: '301000000001' });
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry: material({ code: '999999999999' }) }] });
  const { aliasPairs } = applyResolveDecisions(rows, { [rows[0].id]: { action: 'approve' } });
  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.MATERIAL, from: '999999999999', to: '301000000001' }]);
});

// ---- 失敗系 ----
test('【失敗系】applyResolveDecisions: 候補が無い状態でapproveすると保留（deferredRowIds）にフォールバックする', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '999999999500', location: 'room' }] }); // 候補が見つからない大分類外コード
  assert.deepEqual(rows[0].candidates, []);
  const { aliasPairs, deferredRowIds } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'approve' }]]));
  assert.deepEqual(aliasPairs, []);
  assert.deepEqual(deferredRowIds, [rows[0].id]);
});

test('【失敗系】applyResolveDecisions: その場面で許可されていない操作を指定すると例外', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  assert.throws(() => applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'markOverride' }]])), /許可されていない操作/);
});

// ステップ7d QA指摘Major-1（2026-09-23）: pickキー省略はもう例外にしない——1行の入力漏れが
// まとめて承認の適用全体（他の行の決定）を巻き込んで失敗させないため、rejected＋保留へ回す。
test('【失敗系・ステップ7d QA指摘Major-1】applyResolveDecisions: pickでpickキー省略は例外を投げずrejected（理由「代替を指定してください」）＋保留に回る', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'pick' }]]));
  assert.deepEqual(aliasPairs, []);
  assert.deepEqual(deferredRowIds, [rows[0].id]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].rowId, rows[0].id);
  assert.equal(rejected[0].reason, '代替を指定してください');
});

test('【失敗系】applyResolveDecisions: 未知の操作は例外', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  assert.throws(() => applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'nope' }]])));
});

// ---- QA指摘Major-1（2026-09-22）→ステップ7d QA指摘Major-2（2026-09-23）: pick/approveの
// 代替キーはvalidKeysByKind（Map<kind,Set>）で行のkindごとに実在確認し、無ければ保留へ戻す ----
function validKeysByKindOf(kind, keys) {
  return new Map([[kind, new Set(keys)]]);
}

test('【失敗系・QA指摘Major-1】applyResolveDecisions: pickで未知のキーを指定するとaliasPairsに積まれず保留＋rejectedに理由が入る', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const validKeysByKind = validKeysByKindOf(CatalogKind.MATERIAL, ['301000000001']); // '999999999999'は含まれない
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: '999999999999' }]]), { validKeysByKind },
  );
  assert.deepEqual(aliasPairs, [], '未知コードはaliasPairsに積まれない（文書の参照が実体の無いコードへ書き換わらない）');
  assert.deepEqual(deferredRowIds, [rows[0].id], '弾かれた行は保留に戻る');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].rowId, rows[0].id);
  assert.equal(rejected[0].key, '999999999999');
  assert.ok(rejected[0].reason, '理由文言が入る');
});

test('【失敗系・QA指摘Major-1】applyResolveDecisions: pickで空白のみのキーを指定するとaliasPairsに積まれず保留＋rejectedに理由が入る', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const validKeysByKind = validKeysByKindOf(CatalogKind.MATERIAL, ['301000000001']);
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: '   ' }]]), { validKeysByKind },
  );
  assert.deepEqual(aliasPairs, [], '空白のみのキーはaliasPairsに積まれない');
  assert.deepEqual(deferredRowIds, [rows[0].id]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].key, '   ');
});

test('applyResolveDecisions: pickで実在するキー（validKeysByKindに含まれる）を指定すればaliasPairsに積まれる', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const validKeysByKind = validKeysByKindOf(CatalogKind.MATERIAL, ['301000000001']);
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: '301000000001' }]]), { validKeysByKind },
  );
  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.MATERIAL, from: '111111111500', to: '301000000001' }]);
  assert.deepEqual(deferredRowIds, []);
  assert.deepEqual(rejected, []);
});

test('【失敗系・QA指摘Major-1】applyResolveDecisions: approveの候補先頭がvalidKeysByKindに無ければaliasPairsに積まれず保留＋rejectedに理由が入る', () => {
  const candidate = material({ code: '301000099999' }); // validKeysByKindに含めない（存在しない想定）
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry: material({ code: '999999999999' }) }] });
  const validKeysByKind = validKeysByKindOf(CatalogKind.MATERIAL, ['301000000001']); // candidate.codeを含まない
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'approve' }]]), { validKeysByKind },
  );
  assert.deepEqual(aliasPairs, []);
  assert.deepEqual(deferredRowIds, [rows[0].id]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].key, '301000099999');
});

test('applyResolveDecisions: approveの候補先頭がvalidKeysByKindに実在すればaliasPairsに積まれる', () => {
  const candidate = material({ code: '301000000001' });
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry: material({ code: '999999999999' }) }] });
  const validKeysByKind = validKeysByKindOf(CatalogKind.MATERIAL, ['301000000001']);
  const { aliasPairs, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'approve' }]]), { validKeysByKind },
  );
  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.MATERIAL, from: '999999999999', to: '301000000001' }]);
  assert.deepEqual(rejected, []);
});

test('applyResolveDecisions: validKeysByKind省略時は検証しない（後方互換。既存の自由ピッカーテストと同じ挙動）', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const { aliasPairs, rejected } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'pick', pick: '000000000000' }]]));
  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.MATERIAL, from: '111111111500', to: '000000000000' }]);
  assert.deepEqual(rejected, []);
});

// ---- ステップ7d QA指摘Major-2: validKeysByKindは種別ごとに合流する（単一Setへ潰さない）----
test('【失敗系・ステップ7d QA指摘Major-2】applyResolveDecisions: interiorMaster行にmaterialの実在コードをpickしても、種別が違うのでrejected（変異=単一Setへ合流すると通ってしまう）', () => {
  const rows = buildResolveRows({
    kind: CatalogKind.INTERIOR_MASTER,
    unresolved: [{ code: 'GHOST_ROOM', location: 'room', roomId: 'r1' }],
  });
  const validKeysByKind = new Map([
    [CatalogKind.MATERIAL, new Set(['301000000001'])], // interiorMasterには実在しないキー
    [CatalogKind.INTERIOR_MASTER, new Set(['LIVING_ROOM'])],
  ]);
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: '301000000001' }]]), { validKeysByKind },
  );
  assert.deepEqual(aliasPairs, [], 'material側にだけ実在するキーはinteriorMaster行には通らない');
  assert.deepEqual(deferredRowIds, [rows[0].id]);
  assert.equal(rejected.length, 1);
});

// ---- ステップ7d QA指摘Major-1: 混在行（候補0件のinteriorMaster行にpick未指定＋material行にapprove）----
test('【ステップ7d QA指摘Major-1】applyResolveDecisions: 候補0件のinteriorMaster行にpick未指定＋material行にapprove → 例外なし・materialのaliasは適用・interiorMaster行はrejected/deferred', () => {
  const materialCandidate = material({ code: '301000000001' });
  const materialRows = buildResolveRows({
    kind: CatalogKind.MATERIAL,
    proposals: [{ from: '999999999999', candidates: [materialCandidate], entry: material({ code: '999999999999' }) }],
  });
  const interiorRows = buildResolveRows({
    kind: CatalogKind.INTERIOR_MASTER,
    unresolved: [{ code: 'GHOST_ROOM', location: 'room', roomId: 'r1' }], // 候補0件（材料コード専用のsuggestByClassのため）
  });
  assert.deepEqual(interiorRows[0].candidates, []);
  const rows = [...materialRows, ...interiorRows];
  const validKeysByKind = new Map([[CatalogKind.MATERIAL, new Set(['301000000001'])]]);

  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows,
    new Map([
      [materialRows[0].id, { action: 'approve' }],
      [interiorRows[0].id, { action: 'pick' }], // pick未指定
    ]),
    { validKeysByKind },
  );

  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.MATERIAL, from: '999999999999', to: '301000000001' }],
    'materialのapproveは適用される（interiorMaster行のpick未指定に巻き込まれない）');
  assert.deepEqual(deferredRowIds, [interiorRows[0].id]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].rowId, interiorRows[0].id);
  assert.equal(rejected[0].reason, '代替を指定してください');
});

// ---- QA指摘Minor-1（2026-09-22・D1）: 候補を持つpropose行をdeferしてもaliasPairsに出ない ----
test('【D1】applyResolveDecisions: 候補を持つpropose行をdeferしてもaliasPairs/userOpsに出ずdeferredRowIdsに残る', () => {
  const candidate = material({ code: '301000000001' });
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry: material({ code: '999999999999' }) }] });
  const { aliasPairs, userOps, deferredRowIds } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'defer' }]]));
  assert.deepEqual(aliasPairs, [], 'deferした行の候補がaliasPairsへ漏れてはいけない');
  assert.deepEqual(userOps, []);
  assert.deepEqual(deferredRowIds, [rows[0].id]);
});

// ---- QA指摘Minor-1（2026-09-22・D3）: replaceRowsByScenarioは他場面の行・保留行を残す ----
test('【D3】replaceRowsByScenario: 置き換え対象外の場面の行・置き換え対象外に残るべき行はそのまま保たれる', () => {
  const libraryConflictRow = { id: 'library-conflict:material:301000000001', scenario: 'library-conflict' };
  const oldUnresolvedRow1 = { id: 'unresolved-code:material:111111111211', scenario: 'unresolved-code' };
  const oldUnresolvedRow2 = { id: 'unresolved-code:material:111111111212', scenario: 'unresolved-code' };
  const existingRows = [libraryConflictRow, oldUnresolvedRow1, oldUnresolvedRow2];

  const newUnresolvedRow = { id: 'unresolved-code:material:111111111211', scenario: 'unresolved-code' }; // 再計算後（同一コードが未解決のまま=同id）
  const result = replaceRowsByScenario(existingRows, [newUnresolvedRow], ['unresolved-code']);

  assert.equal(result.length, 2, '他場面1件＋置き換え後1件の計2件のはず');
  assert.ok(result.includes(libraryConflictRow), '他場面（library-conflict）の行はそのまま残る');
  assert.ok(result.includes(newUnresolvedRow), '置き換え後の新しい行が入っている');
  assert.ok(!result.includes(oldUnresolvedRow2), '置き換え対象の場面の古い行（再計算で消えたコード）は残らない');
});

// ---- ステップ8g: kinds スコープ（FinishModeState/StructuralModeStateが同じ場面
// unresolved-codeで別種別の行を積むため、片方のモード突入がもう片方の行を消さないことを固定する） ----
test('【8g】replaceRowsByScenario: kinds指定時は場面が一致してもkindsに無い種別の行は残る（material行はsection突入で消えない）', () => {
  const materialRow = { id: 'unresolved-code:material:111111111211', scenario: 'unresolved-code', kind: 'material' };
  const oldSectionRow = { id: 'unresolved-code:section:STEEL-OLD', scenario: 'unresolved-code', kind: 'section' };
  const existingRows = [materialRow, oldSectionRow];

  const newSectionRow = { id: 'unresolved-code:section:STEEL-NEW', scenario: 'unresolved-code', kind: 'section' };
  const result = replaceRowsByScenario(existingRows, [newSectionRow], ['unresolved-code'], { kinds: ['section'] });

  assert.ok(result.includes(materialRow), 'kinds=[section]のときmaterial行は場面が同じでも残る');
  assert.ok(result.includes(newSectionRow), '置き換え後のsection行が入っている');
  assert.ok(!result.includes(oldSectionRow), 'kindsに含まれるsectionの古い行は置き換えられる');
});

test('【8g】replaceRowsByScenario: 逆方向（kinds=[material,interiorMaster,boundaryMaster]）でもsection行は残る', () => {
  const sectionRow = { id: 'unresolved-code:section:STEEL-OLD', scenario: 'unresolved-code', kind: 'section' };
  const oldMaterialRow = { id: 'unresolved-code:material:111111111211', scenario: 'unresolved-code', kind: 'material' };
  const existingRows = [sectionRow, oldMaterialRow];

  const newMaterialRow = { id: 'unresolved-code:material:111111111212', scenario: 'unresolved-code', kind: 'material' };
  const result = replaceRowsByScenario(existingRows, [newMaterialRow], ['unresolved-code'], {
    kinds: ['material', 'interiorMaster', 'boundaryMaster'],
  });

  assert.ok(result.includes(sectionRow), 'kindsに無いsection行はFinishModeState突入のマージでも残る');
  assert.ok(result.includes(newMaterialRow));
  assert.ok(!result.includes(oldMaterialRow));
});

test('【8g】replaceRowsByScenario: kinds省略時は従来どおりkindを問わず場面だけで置き換える（後方互換）', () => {
  const materialRow = { id: 'unresolved-code:material:111111111211', scenario: 'unresolved-code', kind: 'material' };
  const sectionRow = { id: 'unresolved-code:section:STEEL-OLD', scenario: 'unresolved-code', kind: 'section' };
  const result = replaceRowsByScenario([materialRow, sectionRow], [], ['unresolved-code']);
  assert.deepEqual(result, [], 'kinds省略時は種別を問わず場面一致の行を全て置き換える');
});

// ---- ステップ10e申し送り（10b QA指摘Minor-3）: openingSubType行のpickはcategory（fitting/window）
// が一致しない代替をrejectする（カテゴリを跨ぐと採番・記号・wallKindsの意味が変わるため。
// codeNormalization.js normalizeOpeningsのカテゴリ跨ぎ据え置きと同じ理由）----
test('【失敗系・ステップ10e申し送り】applyResolveDecisions: openingSubType行はpickのcategoryがrow.targetKeyと違うとrejected（同カテゴリはaccepted）', () => {
  const rows = buildResolveRows({
    kind: CatalogKind.OPENING_SUB_TYPE,
    unresolved: [{ code: 'fitting:x', location: 'opening', openingId: 'o1' }],
  });
  const validKeysByKind = validKeysByKindOf(CatalogKind.OPENING_SUB_TYPE, ['window:fixed', 'fitting:sliding']);

  const crossCategory = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: 'window:fixed' }]]), { validKeysByKind },
  );
  assert.deepEqual(crossCategory.aliasPairs, [], 'カテゴリを跨ぐ代替（window→fitting行）はaliasPairsに積まれない');
  assert.deepEqual(crossCategory.deferredRowIds, [rows[0].id]);
  assert.equal(crossCategory.rejected.length, 1);
  assert.equal(crossCategory.rejected[0].key, 'window:fixed');
  assert.match(crossCategory.rejected[0].reason, /カテゴリ/);

  const sameCategory = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: 'fitting:sliding' }]]), { validKeysByKind },
  );
  assert.deepEqual(sameCategory.aliasPairs, [{ kind: CatalogKind.OPENING_SUB_TYPE, from: 'fitting:x', to: 'fitting:sliding' }]);
  assert.deepEqual(sameCategory.deferredRowIds, []);
  assert.deepEqual(sameCategory.rejected, []);
});

test('applyResolveDecisions: openingSubType以外の種別はcategoryチェックの対象外（コロンを含まないkeyでも通る）', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] }); // kind既定=material
  const validKeysByKind = validKeysByKindOf(CatalogKind.MATERIAL, ['301000000001']);
  const { aliasPairs, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: '301000000001' }]]), { validKeysByKind },
  );
  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.MATERIAL, from: '111111111500', to: '301000000001' }]);
  assert.deepEqual(rejected, []);
});

// ---- QA指摘Minor-3（ステップ10e）: approve（候補先頭を自動採用）でもopeningSubTypeの
// カテゴリ跨ぎ候補はaliasに積まない（pickだけでなくapproveも同じガードが必要——matchFieldsの
// フォールバックでcategoryを落とした類似候補がcandidates[0]に来うるため）----
test('【失敗系・ステップ10e QA指摘Minor-3】applyResolveDecisions: approveでもopeningSubTypeのカテゴリ跨ぎ候補（candidates[0]がwindow側）はaliasに積まない', () => {
  const crossCategoryCandidate = { category: 'window', key: 'fixed', label: 'FIX窓' };
  const rows = buildResolveRows({
    kind: CatalogKind.OPENING_SUB_TYPE,
    proposals: [{ from: 'fitting:x', candidates: [crossCategoryCandidate], entry: { category: 'fitting', key: 'x', label: '旧ドア' } }],
  });
  const validKeysByKind = validKeysByKindOf(CatalogKind.OPENING_SUB_TYPE, ['window:fixed']);

  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'approve' }]]), { validKeysByKind },
  );
  assert.deepEqual(aliasPairs, [], 'approveの候補先頭がカテゴリ跨ぎならaliasPairsに積まれない');
  assert.deepEqual(deferredRowIds, [rows[0].id]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].key, 'window:fixed');
  assert.match(rejected[0].reason, /カテゴリ/);
});

test('applyResolveDecisions: approveでopeningSubTypeの候補先頭が同カテゴリならaliasPairsに積まれる', () => {
  const sameCategoryCandidate = { category: 'fitting', key: 'sliding', label: '引き戸' };
  const rows = buildResolveRows({
    kind: CatalogKind.OPENING_SUB_TYPE,
    proposals: [{ from: 'fitting:x', candidates: [sameCategoryCandidate], entry: { category: 'fitting', key: 'x', label: '旧ドア' } }],
  });
  const validKeysByKind = validKeysByKindOf(CatalogKind.OPENING_SUB_TYPE, ['fitting:sliding']);

  const { aliasPairs, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'approve' }]]), { validKeysByKind },
  );
  assert.deepEqual(aliasPairs, [{ kind: CatalogKind.OPENING_SUB_TYPE, from: 'fitting:x', to: 'fitting:sliding' }]);
  assert.deepEqual(rejected, []);
});
