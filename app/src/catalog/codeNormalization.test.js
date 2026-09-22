import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodeTable, normalizeSnapshotCodes,
  setDocumentCodeTable, currentCodeTable, applyDocumentCodeNormalization, takeUnresolvedCodes,
} from './codeNormalization.js';

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
test('setDocumentCodeTable/currentCodeTable/applyDocumentCodeNormalization/takeUnresolvedCodes', () => {
  const table = buildCodeTable({ legacy: { '111111111150': '102000000001' } });
  setDocumentCodeTable(table);
  assert.equal(currentCodeTable(), table);
  const applied = applyDocumentCodeNormalization(baseSnapshot());
  assert.equal(applied.exteriorWallBacking, '102000000001');
  const taken = takeUnresolvedCodes();
  assert.deepEqual(taken, []); // 今回は全て解決できたのでunresolvedは無い
  assert.deepEqual(takeUnresolvedCodes(), []); // 取り出し後はリセットされる
  setDocumentCodeTable(null); // 後始末（他テストへ影響させない）
});

test('applyDocumentCodeNormalization: 表が未設定ならsnapshotをそのまま返す', () => {
  setDocumentCodeTable(null);
  const snapshot = baseSnapshot();
  assert.equal(applyDocumentCodeNormalization(snapshot), snapshot);
});

// ---- QA指摘M3: unresolved蓄積・リセットの空振り（削除材を含む階を2回適用）----
test('takeUnresolvedCodes: 削除材(null)を含む階を2回適用→件数≥6で全て該当コード、2回目のtakeは[]', () => {
  const table = buildCodeTable({ legacy: { '111111111150': null } }); // 削除・廃止
  setDocumentCodeTable(table);
  takeUnresolvedCodes(); // 前のテストの蓄積が残っていないようにリセットしておく

  applyDocumentCodeNormalization(baseSnapshot()); // 1階目（4箇所が'111111111150'を参照）
  applyDocumentCodeNormalization(baseSnapshot()); // 2階目（別階の同じ形のsnapshotを想定）

  const taken = takeUnresolvedCodes();
  assert.ok(taken.length >= 6, `unresolvedの件数が想定より少ない: ${taken.length}`);
  assert.ok(taken.every(u => u.code === '111111111150'), '該当コード以外が混入している');

  assert.deepEqual(takeUnresolvedCodes(), []); // 取り出し後はリセットされ、2回目は空

  setDocumentCodeTable(null); // 後始末
});
