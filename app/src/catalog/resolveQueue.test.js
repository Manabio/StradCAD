import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolveRows, applyResolveDecisions, candidatesForUnresolved, replaceRowsByScenario } from './resolveQueue.js';
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
  assert.deepEqual(rows[0].allowedActions, ['approve', 'pick', 'addToLibrary']);
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

// ---- applyResolveDecisions ----
test('applyResolveDecisions: approve（propose/unresolved-code/unsupported）は候補先頭へのaliasを積む', () => {
  const candidate = material({ code: '301000000001' });
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry: material({ code: '999999999999' }) }] });
  const { aliasPairs, userOps, deferredRowIds } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'approve' }]]));
  assert.deepEqual(aliasPairs, [{ from: '999999999999', to: '301000000001' }]);
  assert.deepEqual(userOps, []);
  assert.deepEqual(deferredRowIds, []);
});

test('applyResolveDecisions: pick（代替材を指示）はcandidatesに縛られず任意のキーへaliasする（自由ピッカー対応）', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const { aliasPairs } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'pick', pick: '301000000009' }]]));
  assert.deepEqual(aliasPairs, [{ from: '111111111500', to: '301000000009' }]);
});

test('applyResolveDecisions: pick（library-conflict）はaliasに加えてユーザーエントリのremoveを積む', () => {
  const userEntry = material({ code: '301000000001' });
  const rows = buildResolveRows({
    libraryConflicts: [{ key: '301000000001', diffFields: ['name'] }],
    userEntries: [userEntry], appEntries: [userEntry],
  });
  const { aliasPairs, userOps } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'pick', pick: '301000000099' }]]));
  assert.deepEqual(aliasPairs, [{ from: '301000000001', to: '301000000099' }]);
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
  assert.deepEqual(aliasPairs, [{ from: '999999999999', to: '301000000001' }]);
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

test('【失敗系】applyResolveDecisions: pickでpickキー省略は例外', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  assert.throws(() => applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'pick' }]])), /pick/);
});

test('【失敗系】applyResolveDecisions: 未知の操作は例外', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  assert.throws(() => applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'nope' }]])));
});

// ---- QA指摘Major-1（2026-09-22）: pick/approveの代替材キーはvalidKeysに実在しなければ保留へ戻す ----
test('【失敗系・QA指摘Major-1】applyResolveDecisions: pickで未知のキーを指定するとaliasPairsに積まれず保留＋rejectedに理由が入る', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const validKeys = new Set(['301000000001']); // '999999999999'は含まれない
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: '999999999999' }]]), { validKeys },
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
  const validKeys = new Set(['301000000001']);
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: '   ' }]]), { validKeys },
  );
  assert.deepEqual(aliasPairs, [], '空白のみのキーはaliasPairsに積まれない');
  assert.deepEqual(deferredRowIds, [rows[0].id]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].key, '   ');
});

test('applyResolveDecisions: pickで実在するキー（validKeysに含まれる）を指定すればaliasPairsに積まれる', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const validKeys = new Set(['301000000001']);
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'pick', pick: '301000000001' }]]), { validKeys },
  );
  assert.deepEqual(aliasPairs, [{ from: '111111111500', to: '301000000001' }]);
  assert.deepEqual(deferredRowIds, []);
  assert.deepEqual(rejected, []);
});

test('【失敗系・QA指摘Major-1】applyResolveDecisions: approveの候補先頭がvalidKeysに無ければaliasPairsに積まれず保留＋rejectedに理由が入る', () => {
  const candidate = material({ code: '301000099999' }); // validKeysに含めない（存在しない想定）
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry: material({ code: '999999999999' }) }] });
  const validKeys = new Set(['301000000001']); // candidate.codeを含まない
  const { aliasPairs, deferredRowIds, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'approve' }]]), { validKeys },
  );
  assert.deepEqual(aliasPairs, []);
  assert.deepEqual(deferredRowIds, [rows[0].id]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].key, '301000099999');
});

test('applyResolveDecisions: approveの候補先頭がvalidKeysに実在すればaliasPairsに積まれる', () => {
  const candidate = material({ code: '301000000001' });
  const rows = buildResolveRows({ proposals: [{ from: '999999999999', candidates: [candidate], entry: material({ code: '999999999999' }) }] });
  const validKeys = new Set(['301000000001']);
  const { aliasPairs, rejected } = applyResolveDecisions(
    rows, new Map([[rows[0].id, { action: 'approve' }]]), { validKeys },
  );
  assert.deepEqual(aliasPairs, [{ from: '999999999999', to: '301000000001' }]);
  assert.deepEqual(rejected, []);
});

test('applyResolveDecisions: validKeys省略時は検証しない（後方互換。既存の自由ピッカーテストと同じ挙動）', () => {
  const rows = buildResolveRows({ unresolved: [{ code: '111111111500', location: 'room' }] });
  const { aliasPairs, rejected } = applyResolveDecisions(rows, new Map([[rows[0].id, { action: 'pick', pick: '000000000000' }]]));
  assert.deepEqual(aliasPairs, [{ from: '111111111500', to: '000000000000' }]);
  assert.deepEqual(rejected, []);
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
