import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodeTable, normalizeSnapshotCodes, SNAPSHOT_REF_WALKERS,
  setDocumentCodeTable, currentCodeTable, applyDocumentCodeNormalization, takeUnresolvedCodes,
  setDocumentAliases, currentDocumentAliases, addDocumentAliases, peekUnresolvedCodes,
  clearDocumentAliases,
} from './codeNormalization.js';
import { normalizeMaterialCode } from './legacyMaterialCodes.js';
import { CatalogKind } from './catalogKinds.js';

function baseSnapshot(overrides) {
  return {
    exteriorWallBacking: '111111111150',
    interiorWallBacking: '111111111160',
    ceilingBacking: '111111111170',
    floorBacking: '111111111180',
    rooms: [{ id: 'r1', overrides: [{ key: 'wallMaterial', value: '111111111150' }, { key: 'other', value: 'x' }] }],
    edges: [{ id: 'e1', overrides: [{ key: 'k', value: '111111111150' }, { key: 'k2', value: 'not-a-code' }] }],
    clEccentricities: [{ clId: 'cl1', backing: '111111111150' }, { clId: 'cl2', backing: '' }],
    ...overrides,
  };
}

// ---- buildCodeTable: 連鎖の潰し・循環 ----
test('buildCodeTable: a→b, b→c の連鎖を a→c へ潰す', () => {
  const table = buildCodeTable({ legacy: { a: 'b', b: 'c' } });
  assert.equal(table.get('a'), 'c');
  assert.equal(table.get('b'), 'c');
});

test('buildCodeTable: 文書側(aliases)が本体表(legacy)より後勝ち', () => {
  const table = buildCodeTable({ legacy: { a: 'b' }, aliases: { a: 'c' } });
  assert.equal(table.get('a'), 'c');
});

test('【失敗系】buildCodeTable: 循環（a→b, b→a）は例外を投げる', () => {
  assert.throws(() => buildCodeTable({ legacy: { a: 'b', b: 'a' } }), /循環/);
});

test('buildCodeTable: nullは削除・廃止として保持する', () => {
  const table = buildCodeTable({ legacy: { a: null } });
  assert.equal(table.get('a'), null);
});

// ---- normalizeSnapshotCodes: 4フィールドすべて ----
test('normalizeSnapshotCodes: 4フィールド（exterior/interior/ceiling/floorBacking）すべて正規化する', () => {
  const table = buildCodeTable({ legacy: {
    '111111111150': '102000000001',
    '111111111160': '102000000002',
    '111111111170': '102000000003',
    '111111111180': '102000000004',
  } });
  const { snapshot } = normalizeSnapshotCodes(baseSnapshot(), table);
  assert.equal(snapshot.exteriorWallBacking, '102000000001');
  assert.equal(snapshot.interiorWallBacking, '102000000002');
  assert.equal(snapshot.ceilingBacking, '102000000003');
  assert.equal(snapshot.floorBacking, '102000000004');
});

test('normalizeSnapshotCodes: rooms[].overridesはkey∈{wallMaterial,wallFinish}のvalueだけ正規化する', () => {
  const table = buildCodeTable({ legacy: { '111111111150': '102000000001' } });
  const { snapshot } = normalizeSnapshotCodes(baseSnapshot(), table);
  assert.equal(snapshot.rooms[0].overrides[0].value, '102000000001'); // wallMaterial
  assert.equal(snapshot.rooms[0].overrides[1].value, 'x'); // key='other'は対象外・不変
});

// wallFinish単体（上のテストはwallMaterialしか対象にしていなかったので別途固定する）
test('normalizeSnapshotCodes: rooms[].overridesのkey=wallFinishも正規化する', () => {
  const table = buildCodeTable({ legacy: { '111111111150': '102000000001' } });
  const snapshot = baseSnapshot({
    rooms: [{ id: 'r1', overrides: [{ key: 'wallFinish', value: '111111111150' }] }],
  });
  const { snapshot: result } = normalizeSnapshotCodes(snapshot, table);
  assert.equal(result.rooms[0].overrides[0].value, '102000000001');
});

test('normalizeSnapshotCodes: edges[].overridesは12桁コード形式のvalueだけ正規化する', () => {
  const table = buildCodeTable({ legacy: { '111111111150': '102000000001' } });
  const { snapshot } = normalizeSnapshotCodes(baseSnapshot(), table);
  assert.equal(snapshot.edges[0].overrides[0].value, '102000000001');
  assert.equal(snapshot.edges[0].overrides[1].value, 'not-a-code'); // コード形式でない値は不変
});

test("normalizeSnapshotCodes: clEccentricities[].backing==='' は触らない", () => {
  const table = buildCodeTable({ legacy: { '111111111150': '102000000001', '': '999999999999' } });
  const { snapshot } = normalizeSnapshotCodes(baseSnapshot(), table);
  assert.equal(snapshot.clEccentricities[0].backing, '102000000001');
  assert.equal(snapshot.clEccentricities[1].backing, ''); // per-floor既定の合図。正規化しない
});

// ---- 変化なしは同一参照 ----
test('normalizeSnapshotCodes: 変化が無ければsnapshotは同一参照を返す', () => {
  const table = buildCodeTable({ legacy: { '999999999999': '102000000001' } }); // どのコードにも該当しない表
  const snapshot = baseSnapshot();
  const result = normalizeSnapshotCodes(snapshot, table);
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.snapshot.rooms, snapshot.rooms);
  assert.equal(result.snapshot.edges, snapshot.edges);
  assert.equal(result.snapshot.clEccentricities, snapshot.clEccentricities);
  assert.deepEqual(result.unresolved, []);
});

test('normalizeSnapshotCodes: 表が空/nullなら常に同一参照', () => {
  const snapshot = baseSnapshot();
  assert.equal(normalizeSnapshotCodes(snapshot, new Map()).snapshot, snapshot);
  assert.equal(normalizeSnapshotCodes(snapshot, null).snapshot, snapshot);
  assert.equal(normalizeSnapshotCodes(snapshot, undefined).snapshot, snapshot);
});

test('【失敗系・Minor指摘】normalizeSnapshotCodes: tableがMap以外（null/undefined以外）なら例外を投げる', () => {
  const snapshot = baseSnapshot();
  assert.throws(() => normalizeSnapshotCodes(snapshot, {}), /Mapである必要/);
  assert.throws(() => normalizeSnapshotCodes(snapshot, [['a', 'b']]), /Mapである必要/);
  assert.throws(() => normalizeSnapshotCodes(snapshot, 'not-a-map'), /Mapである必要/);
});

// ---- null（削除材）は据え置き＋unresolved ----
test('normalizeSnapshotCodes: 表の値がnull（削除材）なら値は据え置き、unresolvedへ積む', () => {
  const table = buildCodeTable({ legacy: { '111111111150': null } });
  const { snapshot, unresolved } = normalizeSnapshotCodes(baseSnapshot(), table);
  assert.equal(snapshot.exteriorWallBacking, '111111111150'); // 据え置き
  assert.ok(unresolved.some(u => u.code === '111111111150'));
  assert.ok(unresolved.length >= 3); // exterior backing + room override + edge override + clEccentricity の複数箇所
});

// ---- 冪等性 ----
test('normalizeSnapshotCodes: 2回適用しても結果が同じ（冪等）', () => {
  const table = buildCodeTable({ legacy: {
    '111111111150': '102000000001', '111111111160': '102000000002',
    '111111111170': '102000000003', '111111111180': '102000000004',
  } });
  const once = normalizeSnapshotCodes(baseSnapshot(), table).snapshot;
  const twice = normalizeSnapshotCodes(once, table).snapshot;
  assert.deepEqual(once, twice);
  // 2回目は変化が無いので同一参照になる
  const twiceResult = normalizeSnapshotCodes(once, table);
  assert.equal(twiceResult.snapshot, once);
});

// ---- 文書単位の正規化表（setDocumentCodeTable/currentCodeTable/apply/takeUnresolved）----
// ステップ7a: kindが必須引数になった（署名変更の追従。挙動そのものは従来どおりmaterialに
// CatalogKind.MATERIALを渡すだけ）。
test('setDocumentCodeTable/currentCodeTable/applyDocumentCodeNormalization/takeUnresolvedCodes', () => {
  const table = buildCodeTable({ legacy: { '111111111150': '102000000001' } });
  setDocumentCodeTable(CatalogKind.MATERIAL, table);
  assert.equal(currentCodeTable(CatalogKind.MATERIAL), table);
  const applied = applyDocumentCodeNormalization(baseSnapshot());
  assert.equal(applied.exteriorWallBacking, '102000000001');
  const taken = takeUnresolvedCodes();
  assert.deepEqual(taken, []); // 今回は全て解決できたのでunresolvedは無い
  assert.deepEqual(takeUnresolvedCodes(), []); // 取り出し後はリセットされる
  setDocumentCodeTable(CatalogKind.MATERIAL, null); // 後始末（他テストへ影響させない）
});

// 2026-09-22 ステップ3裁定: 文書固有の表(aliases)が無くても、既定＝本体の振り直し表
// （LEGACY_MATERIAL_CODE_ALIASES）だけで正規化が効く（「未設定＝正規化しない」ではない）。
// baseSnapshot()の4コード（150/160/170/180）は本体表に実在する旧コードなので変化する。
test('applyDocumentCodeNormalization: 文書固有表が未設定でも既定＝本体の振り直し表で正規化する', () => {
  setDocumentCodeTable(CatalogKind.MATERIAL, null);
  const snapshot = baseSnapshot();
  const applied = applyDocumentCodeNormalization(snapshot);
  assert.notEqual(applied, snapshot);
  assert.notEqual(applied.exteriorWallBacking, '111111111150'); // 本体表に実在する旧コードは正規化される
  assert.equal(applied.exteriorWallBacking, normalizeMaterialCode('111111111150'));
});

test('applyDocumentCodeNormalization: 本体表に無いコードのみのsnapshotはそのまま返す（本体表適用でも変化なし）', () => {
  setDocumentCodeTable(CatalogKind.MATERIAL, null);
  const snapshot = baseSnapshot({
    exteriorWallBacking: '999999999999', interiorWallBacking: '999999999999',
    ceilingBacking: '999999999999', floorBacking: '999999999999',
    rooms: [], edges: [], clEccentricities: [],
  });
  assert.equal(applyDocumentCodeNormalization(snapshot), snapshot);
});

// ---- QA指摘M3→2026-09-22改訂: unresolvedはkind+code+locationで重複排除する（ステップ6の消費者が
// 付くまで単調増加させない）。同じ形のsnapshot（同じroomId/edgeKey/clId）を繰り返し適用しても、
// 箇所種別（location）ごとに1件しか積まれない。----
test('takeUnresolvedCodes: 削除材(null)を含む階を2回適用→kind+code+locationで重複排除され4件（exteriorWallBacking/room/edge/clEccentricity）、2回目のtakeは[]', () => {
  const table = buildCodeTable({ legacy: { '111111111150': null } }); // 削除・廃止
  setDocumentCodeTable(CatalogKind.MATERIAL, table);
  takeUnresolvedCodes(); // 前のテストの蓄積が残っていないようにリセットしておく

  applyDocumentCodeNormalization(baseSnapshot()); // 1階目（4箇所が'111111111150'を参照）
  applyDocumentCodeNormalization(baseSnapshot()); // 2階目相当（同じ形のsnapshotを再適用）

  const taken = takeUnresolvedCodes();
  assert.equal(taken.length, 4, `重複排除後の件数が想定と異なる: ${taken.length}`);
  assert.ok(taken.every(u => u.code === '111111111150'), '該当コード以外が混入している');
  assert.ok(taken.every(u => u.kind === CatalogKind.MATERIAL), 'レコードにkind:material が付いていない');
  assert.deepEqual(
    taken.map(u => u.location).sort(),
    ['clEccentricity', 'edge', 'exteriorWallBacking', 'room'],
  );

  assert.deepEqual(takeUnresolvedCodes(), []); // 取り出し後はリセットされ、2回目は空

  setDocumentCodeTable(CatalogKind.MATERIAL, null); // 後始末
});

// ---- 2026-09-22 QAコメント: 同じsnapshotを50回適用しても件数が増えない（単調増加させない）----
test('applyDocumentCodeNormalization: 同じ削除材参照のsnapshotを50回適用しても未解決の蓄積件数が増えない', () => {
  const table = buildCodeTable({ legacy: { '111111111150': null } });
  setDocumentCodeTable(CatalogKind.MATERIAL, table);
  takeUnresolvedCodes(); // リセット

  for (let i = 0; i < 50; i++) applyDocumentCodeNormalization(baseSnapshot());

  const taken = takeUnresolvedCodes();
  assert.equal(taken.length, 4, `50回適用しても4件（location種別ごと）から増えないはず: ${taken.length}`);

  setDocumentCodeTable(CatalogKind.MATERIAL, null); // 後始末
});

// ---- ステップ6-1→7a: 文書単位の読み替え（setDocumentAliases/currentDocumentAliases/addDocumentAliases/peekUnresolvedCodes）----
// kindが必須引数になった（署名変更の追従）。
test('setDocumentAliases/currentDocumentAliases: 生のaliasesを保持し、内部でbuildCodeTableした表を即座に反映する', () => {
  setDocumentAliases(CatalogKind.MATERIAL, { '111111111150': '102000000001' });
  assert.deepEqual(currentDocumentAliases(CatalogKind.MATERIAL), { '111111111150': '102000000001' });
  assert.equal(currentCodeTable(CatalogKind.MATERIAL).get('111111111150'), '102000000001');
  setDocumentAliases(CatalogKind.MATERIAL, null); // 後始末
});

test('setDocumentAliases(kind, null): 文書固有の読み替えを解除する（currentDocumentAliasesは空オブジェクトに戻る）', () => {
  setDocumentAliases(CatalogKind.MATERIAL, { '111111111150': '102000000001' });
  setDocumentAliases(CatalogKind.MATERIAL, null);
  assert.deepEqual(currentDocumentAliases(CatalogKind.MATERIAL), {});
  assert.equal(currentCodeTable(CatalogKind.MATERIAL), null);
});

test('setDocumentAliases: 冪等（同じaliasesを2回設定しても結果は同じ）', () => {
  setDocumentAliases(CatalogKind.MATERIAL, { '111111111150': '102000000001' });
  const once = currentCodeTable(CatalogKind.MATERIAL);
  setDocumentAliases(CatalogKind.MATERIAL, { '111111111150': '102000000001' });
  const twice = currentCodeTable(CatalogKind.MATERIAL);
  assert.deepEqual([...once.entries()], [...twice.entries()]);
  setDocumentAliases(CatalogKind.MATERIAL, null); // 後始末
});

// 後効き: 先にsnapshot（旧コード）を作っておき、addDocumentAliases後にapplyDocumentCodeNormalization
// すると新コードへ変換される——documentCodeTableは呼び出しのたびに実効表を引く（スナップショット
// された表を固定で使い回さない）ことの確認。
test('addDocumentAliases: 後効き（先に作った旧コードsnapshotがaddDocumentAliases後に新コードへ正規化される）', () => {
  setDocumentAliases(CatalogKind.MATERIAL, null);
  const snapshot = baseSnapshot({
    exteriorWallBacking: '999999999998',
    interiorWallBacking: null, ceilingBacking: null, floorBacking: null,
    rooms: [], edges: [], clEccentricities: [],
  });
  // addDocumentAliases前: 未知コードなので変化なし
  assert.equal(applyDocumentCodeNormalization(snapshot), snapshot);

  addDocumentAliases(CatalogKind.MATERIAL, [{ from: '999999999998', to: '102000000009' }]);
  const applied = applyDocumentCodeNormalization(snapshot); // 同じsnapshot（旧コードのまま）を再適用
  assert.equal(applied.exteriorWallBacking, '102000000009');

  setDocumentAliases(CatalogKind.MATERIAL, null); // 後始末
});

test('addDocumentAliases: 既存のdocumentAliasesへ後勝ちでマージする（連鎖はbuildCodeTableが潰す）', () => {
  setDocumentAliases(CatalogKind.MATERIAL, { a: 'b' });
  addDocumentAliases(CatalogKind.MATERIAL, [{ from: 'b', to: 'c' }]);
  assert.deepEqual(currentDocumentAliases(CatalogKind.MATERIAL), { a: 'b', b: 'c' });
  assert.equal(currentCodeTable(CatalogKind.MATERIAL).get('a'), 'c'); // a→b, b→c の連鎖がa→cへ潰れる
  setDocumentAliases(CatalogKind.MATERIAL, null); // 後始末
});

test('【失敗系】addDocumentAliases: 循環（a→b, b→a）を追記すると例外を投げる', () => {
  setDocumentAliases(CatalogKind.MATERIAL, { a: 'b' });
  assert.throws(() => addDocumentAliases(CatalogKind.MATERIAL, [{ from: 'b', to: 'a' }]), /循環/);
  setDocumentAliases(CatalogKind.MATERIAL, null); // 後始末
});

test('peekUnresolvedCodes: 非破壊（呼んでも蓄積をリセットしない。takeUnresolvedCodesと違う）', () => {
  const table = buildCodeTable({ legacy: { '111111111150': null } });
  setDocumentCodeTable(CatalogKind.MATERIAL, table);
  takeUnresolvedCodes(); // リセット

  applyDocumentCodeNormalization(baseSnapshot());
  const peeked1 = peekUnresolvedCodes();
  assert.ok(peeked1.length > 0);
  const peeked2 = peekUnresolvedCodes();
  assert.deepEqual(peeked1, peeked2, 'peekを2回呼んでも同じ内容（リセットされていない）');

  const taken = takeUnresolvedCodes(); // 実際に取り出す
  assert.deepEqual(taken, peeked2, 'peekの内容はtakeの内容と一致する');
  assert.deepEqual(takeUnresolvedCodes(), []); // takeAfterはリセット済み

  setDocumentCodeTable(CatalogKind.MATERIAL, null); // 後始末
});

// ================================================================
// ステップ7a: 種別化（kind必須・SNAPSHOT_REF_WALKERS・種別独立・templateKey/masterTypeの書換え・
// clearDocumentAliases・rewrite:null例外・kind省略/未知例外・unresolvedへのkind付与）
// ================================================================

function interiorBoundarySnapshot(overrides) {
  return {
    rooms: [{ id: 'r1', templateKey: 'LIVING' }, { id: 'r2', templateKey: null }],
    edges: [{ key: 'e1', masterType: 'EXTERIOR_WALL' }, { key: 'e2', masterType: null }],
    ...overrides,
  };
}

test.afterEach(() => { clearDocumentAliases(); takeUnresolvedCodes(); }); // 後始末（他テストへ持ち越さない）

// ---- kind必須引数: 省略・未知は例外 ----
test('【失敗系】setDocumentAliases: kind省略は例外', () => {
  assert.throws(() => setDocumentAliases(undefined, {}), /kind|種別/);
});

test('【失敗系】currentDocumentAliases: 未知のkindは例外', () => {
  assert.throws(() => currentDocumentAliases('no-such-kind'), /未知のカタログ種別/);
});

test('【失敗系】addDocumentAliases/setDocumentCodeTable/currentCodeTable: kind省略・未知は例外', () => {
  assert.throws(() => addDocumentAliases(undefined, []), /kind|種別/);
  assert.throws(() => setDocumentCodeTable('no-such-kind', null), /未知のカタログ種別/);
  assert.throws(() => currentCodeTable(undefined), /kind|種別/);
});

// ---- rewrite:null（openingSubType。section はステップ8bで実装済み）に非空aliasesを積むと例外 ----
test('【失敗系】setDocumentAliases: rewrite:nullの種別（openingSubType）に非空aliasesを積むと例外', () => {
  assert.throws(() => setDocumentAliases(CatalogKind.OPENING_SUB_TYPE, { S1: 'S2' }), /openingSubType|対応していません/);
});

test('【失敗系】addDocumentAliases: rewrite:nullの種別（openingSubType）に非空pairsを積むと例外', () => {
  assert.throws(
    () => addDocumentAliases(CatalogKind.OPENING_SUB_TYPE, [{ from: 'fitting:a', to: 'fitting:b' }]),
    /openingSubType|対応していません/,
  );
});

test('setDocumentAliases: rewrite:nullの種別でも空/null aliasesは例外にならない（解除操作は許す）', () => {
  setDocumentAliases(CatalogKind.OPENING_SUB_TYPE, {});
  setDocumentAliases(CatalogKind.OPENING_SUB_TYPE, null);
});

// ---- 種別独立: material の alias が templateKey に効かない・逆も ----
test('種別独立: materialのaliasはinteriorMaster(templateKey)に効かない', () => {
  setDocumentAliases(CatalogKind.MATERIAL, { LIVING: 'SHOULD_NOT_APPLY' }); // codeが偶然一致していても種別が違う
  const snapshot = interiorBoundarySnapshot();
  const applied = applyDocumentCodeNormalization(snapshot);
  assert.equal(applied.rooms[0].templateKey, 'LIVING', 'material表はinteriorMasterのtemplateKeyへ波及しない');
});

test('種別独立: interiorMasterのaliasはmaterialの4フィールドに効かない', () => {
  setDocumentAliases(CatalogKind.INTERIOR_MASTER, { '111111111150': 'SHOULD_NOT_APPLY' });
  const snapshot = baseSnapshot();
  const applied = applyDocumentCodeNormalization(snapshot);
  assert.equal(applied.exteriorWallBacking, normalizeMaterialCode('111111111150'), 'material本体表だけが効く（interiorMasterのaliasは無関係）');
});

// ---- templateKey・masterTypeの書換え ----
test('SNAPSHOT_REF_WALKERS.interiorMaster: rooms[].templateKeyを列挙・書換えする', () => {
  const refs = SNAPSHOT_REF_WALKERS.interiorMaster.enumerate(interiorBoundarySnapshot());
  assert.deepEqual(refs, [{ code: 'LIVING', location: 'room', roomId: 'r1' }]);

  addDocumentAliases(CatalogKind.INTERIOR_MASTER, [{ from: 'LIVING', to: 'LDK' }]);
  const applied = applyDocumentCodeNormalization(interiorBoundarySnapshot());
  assert.equal(applied.rooms[0].templateKey, 'LDK');
  assert.equal(applied.rooms[1].templateKey, null, 'templateKey:nullの部屋は触らない');
});

test('SNAPSHOT_REF_WALKERS.boundaryMaster: edges[].masterTypeを列挙・書換えする', () => {
  const refs = SNAPSHOT_REF_WALKERS.boundaryMaster.enumerate(interiorBoundarySnapshot());
  assert.deepEqual(refs, [{ code: 'EXTERIOR_WALL', location: 'edge', edgeKey: 'e1' }]);

  addDocumentAliases(CatalogKind.BOUNDARY_MASTER, [{ from: 'EXTERIOR_WALL', to: 'EXTERIOR_WALL_V2' }]);
  const applied = applyDocumentCodeNormalization(interiorBoundarySnapshot());
  assert.equal(applied.edges[0].masterType, 'EXTERIOR_WALL_V2');
  assert.equal(applied.edges[1].masterType, null, 'masterType:nullの辺は触らない');
});

// ---- 冪等 ----
test('interiorMaster/boundaryMasterの書換えは冪等（2回適用で結果が同じ・変化が無くなれば同一参照）', () => {
  addDocumentAliases(CatalogKind.INTERIOR_MASTER, [{ from: 'LIVING', to: 'LDK' }]);
  addDocumentAliases(CatalogKind.BOUNDARY_MASTER, [{ from: 'EXTERIOR_WALL', to: 'EXTERIOR_WALL_V2' }]);
  const once = applyDocumentCodeNormalization(interiorBoundarySnapshot());
  const twice = applyDocumentCodeNormalization(once);
  assert.deepEqual(once, twice);
  assert.equal(applyDocumentCodeNormalization(once), once, '2回目は変化が無いので同一参照');
});

// ---- unresolvedにkindが付く ----
test('unresolved: interiorMasterの削除済みtemplateKeyはkind:interiorMasterでunresolvedに積まれる', () => {
  addDocumentAliases(CatalogKind.INTERIOR_MASTER, [{ from: 'LIVING', to: null }]); // 削除・廃止
  applyDocumentCodeNormalization(interiorBoundarySnapshot());
  const taken = takeUnresolvedCodes();
  assert.deepEqual(taken, [{ kind: CatalogKind.INTERIOR_MASTER, code: 'LIVING', location: 'room', roomId: 'r1' }]);
});

// ---- unresolvedの重複排除キーはkindを含む（同じcode+locationが種別をまたいで衝突しても
// 片方が消えない）。material（location:'room'の室overrides）とinteriorMaster（location:'room'の
// templateKey）が同じcode・同じroomIdで両方削除材化するケースで固定する。----
test('unresolved: 重複排除キーはkindを含む（material/interiorMasterが同じcode+location:roomでも両方積まれる）', () => {
  addDocumentAliases(CatalogKind.MATERIAL, [{ from: 'DUPCODE', to: null }]);
  addDocumentAliases(CatalogKind.INTERIOR_MASTER, [{ from: 'DUPCODE', to: null }]);
  const snapshot = {
    rooms: [{ id: 'r1', templateKey: 'DUPCODE', overrides: [{ key: 'wallMaterial', value: 'DUPCODE' }] }],
  };
  applyDocumentCodeNormalization(snapshot);
  const taken = takeUnresolvedCodes();
  const byKind = new Map(taken.map(u => [u.kind, u]));
  assert.deepEqual(byKind.get(CatalogKind.MATERIAL), { kind: CatalogKind.MATERIAL, code: 'DUPCODE', location: 'room', roomId: 'r1', key: 'wallMaterial' });
  assert.deepEqual(byKind.get(CatalogKind.INTERIOR_MASTER), { kind: CatalogKind.INTERIOR_MASTER, code: 'DUPCODE', location: 'room', roomId: 'r1' });
  assert.equal(taken.length, 2, 'kindを落として重複排除すると片方が消えて1件になってしまう退行を検知する');
});

// ---- ステップ8b: section（columns/beams/structuralWalls/slabs/footings[].sectionDefId）の
// 書換え実装（interiorMaster/boundaryMasterと同型）----
function sectionSnapshot(overrides) {
  return {
    columns: [{ id: 'c1', sectionDefId: 'WOOD-120x120' }, { id: 'c2', sectionDefId: null }],
    beams: [{ id: 'b1', sectionDefId: 'STEEL-H300x150' }],
    structuralWalls: [{ id: 'w1', sectionDefId: 'WOOD-120x120' }],
    slabs: [{ id: 's1', sectionDefId: 'WOOD-120x120' }],
    footings: [{ id: 'f1', sectionDefId: 'WOOD-120x120' }],
    ...overrides,
  };
}

test('SNAPSHOT_REF_WALKERS.section: columns/beams/structuralWalls/slabs/footingsのsectionDefIdを列挙する', () => {
  const refs = SNAPSHOT_REF_WALKERS.section.enumerate(sectionSnapshot());
  assert.deepEqual(refs, [
    { code: 'WOOD-120x120', location: 'columns', memberId: 'c1' },
    { code: 'STEEL-H300x150', location: 'beams', memberId: 'b1' },
    { code: 'WOOD-120x120', location: 'structuralWalls', memberId: 'w1' },
    { code: 'WOOD-120x120', location: 'slabs', memberId: 's1' },
    { code: 'WOOD-120x120', location: 'footings', memberId: 'f1' },
  ]);
});

test('setDocumentAliases: sectionは今後rewriteに対応しているので非空aliasesでも例外にならない（8bの実装確認）', () => {
  assert.doesNotThrow(() => setDocumentAliases(CatalogKind.SECTION, { 'WOOD-120x120': 'WOOD-120x120-V2' }));
  setDocumentAliases(CatalogKind.SECTION, null); // 後始末
});

test('addDocumentAliases: sectionも例外を投げなくなる（8bの実装確認）', () => {
  assert.doesNotThrow(() => addDocumentAliases(CatalogKind.SECTION, [{ from: 'WOOD-120x120', to: 'WOOD-120x120-V2' }]));
  setDocumentAliases(CatalogKind.SECTION, null); // 後始末
});

test('SNAPSHOT_REF_WALKERS.section: rewriteは全5系統のsectionDefIdを書換える', () => {
  addDocumentAliases(CatalogKind.SECTION, [{ from: 'WOOD-120x120', to: 'WOOD-105x105' }]);
  const applied = applyDocumentCodeNormalization(sectionSnapshot());
  assert.equal(applied.columns[0].sectionDefId, 'WOOD-105x105');
  assert.equal(applied.columns[1].sectionDefId, null, 'sectionDefId:nullの部材は触らない');
  assert.equal(applied.beams[0].sectionDefId, 'STEEL-H300x150', '対象外コードは不変');
  assert.equal(applied.structuralWalls[0].sectionDefId, 'WOOD-105x105');
  assert.equal(applied.slabs[0].sectionDefId, 'WOOD-105x105');
  assert.equal(applied.footings[0].sectionDefId, 'WOOD-105x105');
});

test('section: 変化が無ければ同一参照（copy-on-write）。変化した系統のリストだけ新しい配列になる', () => {
  addDocumentAliases(CatalogKind.SECTION, [{ from: 'WOOD-120x120', to: 'WOOD-105x105' }]);
  const snapshot = sectionSnapshot();
  const applied = applyDocumentCodeNormalization(snapshot);
  assert.notEqual(applied, snapshot);
  assert.notEqual(applied.columns, snapshot.columns, '書換えのあったcolumnsは新しい配列');
  assert.equal(applied.beams, snapshot.beams, '書換えの無いbeamsは同一参照');
});

test('section: aliasesが無いsectionDefIdのみのsnapshotは完全に同一参照を返す', () => {
  setDocumentAliases(CatalogKind.SECTION, null);
  const snapshot = sectionSnapshot();
  const result = applyDocumentCodeNormalization(snapshot);
  assert.equal(result, snapshot);
});

test('section: 書換えは冪等（2回適用で結果が同じ・2回目は変化が無いので同一参照）', () => {
  addDocumentAliases(CatalogKind.SECTION, [{ from: 'WOOD-120x120', to: 'WOOD-105x105' }]);
  const once = applyDocumentCodeNormalization(sectionSnapshot());
  const twice = applyDocumentCodeNormalization(once);
  assert.deepEqual(once, twice);
  assert.equal(applyDocumentCodeNormalization(once), once);
});

test('section: 削除済みsectionDefId(null)は値を据え置き、kind:sectionでunresolvedに積む', () => {
  addDocumentAliases(CatalogKind.SECTION, [{ from: 'WOOD-120x120', to: null }]);
  applyDocumentCodeNormalization(sectionSnapshot());
  const taken = takeUnresolvedCodes();
  const columnsEntry = taken.find(u => u.location === 'columns');
  assert.deepEqual(columnsEntry, { kind: CatalogKind.SECTION, code: 'WOOD-120x120', location: 'columns', memberId: 'c1' });
  assert.equal(taken.filter(u => u.code === 'WOOD-120x120').length, 4, 'columns/structuralWalls/slabs/footingsの4箇所');
});

// ---- clearDocumentAliases: 全種別解除 ----
test('clearDocumentAliases: material・interiorMasterの両方のaliasesを解除する（全種別解除）', () => {
  setDocumentAliases(CatalogKind.MATERIAL, { a: 'b' });
  setDocumentAliases(CatalogKind.INTERIOR_MASTER, { LIVING: 'LDK' });
  clearDocumentAliases();
  assert.deepEqual(currentDocumentAliases(CatalogKind.MATERIAL), {});
  assert.deepEqual(currentDocumentAliases(CatalogKind.INTERIOR_MASTER), {});
  assert.equal(currentCodeTable(CatalogKind.MATERIAL), null);
  assert.equal(currentCodeTable(CatalogKind.INTERIOR_MASTER), null);
});
