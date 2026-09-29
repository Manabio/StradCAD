// finish/equipment/equipmentNumbering.js（昇降機器具の採番・記号。graph非依存の純関数）の単体テスト。
// react／store.js／snap.js／.jsx を静的importしない——node:testから直接importできることが証拠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selfFloorEquipmentCatalog, nextEquipmentNo, equipmentSymbols, renumberEquipment, equipmentFloorSpanLabel,
} from './equipmentNumbering.js';

test('selfFloorEquipmentCatalog: 同じidの行が複数階ぶん渡されても1件にまとめる', () => {
  const rows = [
    { id: 'a', category: 'ev', no: 1 },
    { id: 'a', category: 'ev', no: 1 }, // 別階の同じ器具の行（全階共通id/no）
    { id: 'b', category: 'ev', no: 2 },
  ];
  const catalog = selfFloorEquipmentCatalog(rows);
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog.map(r => r.id).sort(), ['a', 'b']);
});

test('nextEquipmentNo: 0件なら1、既存の最大+1になる（欠番があっても最大+1）', () => {
  assert.equal(nextEquipmentNo([], 'ev'), 1);
  const catalog = [{ id: 'a', category: 'ev', no: 1 }, { id: 'b', category: 'ev', no: 3 }];
  assert.equal(nextEquipmentNo(catalog, 'ev'), 4);
  // 他分類は無視する。
  const mixed = [{ id: 'a', category: 'ev', no: 1 }, { id: 'c', category: 'escalator', no: 9 }];
  assert.equal(nextEquipmentNo(mixed, 'ev'), 2);
});

// QA指摘（ステップ3全体・T8）: selfFloorEquipmentCatalogだけでなく、equipmentSymbols・
// renumberEquipment・nextEquipmentNoも「同じidは内部で1件にまとめる」（設計§4(b)）を
// 満たすはず（全階分の行を直接渡されても壊れないように）。dedupeByIdを共有する。
test('equipmentSymbols: 同じidの行が2件（別の階の行を想定）渡されても1件として扱い"EV"になる', () => {
  const catalog = [
    { id: 'a', category: 'ev', no: 1 },
    { id: 'a', category: 'ev', no: 1 }, // 別階の同じ器具の行
  ];
  const symbols = equipmentSymbols(catalog);
  assert.equal(symbols.get('a'), 'EV', '1基として扱われ"EV2"にならないはず');
  assert.equal(symbols.size, 1);
});

test('renumberEquipment: 同じidの行が2件渡されても1件として扱い1になる', () => {
  const catalog = [
    { id: 'a', category: 'ev', no: 1 },
    { id: 'a', category: 'ev', no: 1 },
  ];
  const renumbered = renumberEquipment(catalog);
  assert.equal(renumbered.get('a'), 1);
  assert.equal(renumbered.size, 1);
});

test('nextEquipmentNo: 同じidの行が2件渡されても1件として扱い次の番号は2になる', () => {
  const catalog = [
    { id: 'a', category: 'ev', no: 1 },
    { id: 'a', category: 'ev', no: 1 },
  ];
  assert.equal(nextEquipmentNo(catalog, 'ev'), 2);
});

test('equipmentSymbols: 1基なら接頭辞のみ、2基以上は設置順(no,id)に接頭辞+順位', () => {
  const one = equipmentSymbols([{ id: 'a', category: 'ev', no: 1 }]);
  assert.equal(one.get('a'), 'EV');

  const two = equipmentSymbols([
    { id: 'b', category: 'ev', no: 2 },
    { id: 'a', category: 'ev', no: 1 },
  ]);
  assert.equal(two.get('a'), 'EV1');
  assert.equal(two.get('b'), 'EV2');
});

test('equipmentSymbols: 欠番があっても no 昇順→id昇順で順位が振られる', () => {
  const catalog = [
    { id: 'z', category: 'ev', no: 5 },
    { id: 'a', category: 'ev', no: 2 },
  ];
  const symbols = equipmentSymbols(catalog);
  assert.equal(symbols.get('a'), 'EV1');
  assert.equal(symbols.get('z'), 'EV2');
});

test('equipmentSymbols: no が同値なら id 昇順で決定的に順位が振られる', () => {
  const catalog = [
    { id: 'b', category: 'ev', no: 1 },
    { id: 'a', category: 'ev', no: 1 },
  ];
  const symbols = equipmentSymbols(catalog);
  assert.equal(symbols.get('a'), 'EV1');
  assert.equal(symbols.get('b'), 'EV2');
});

test('equipmentSymbols: 未知の分類は接頭辞なし（分類の文字列そのまま）', () => {
  const symbols = equipmentSymbols([{ id: 'a', category: 'escalator', no: 1 }]);
  assert.equal(symbols.get('a'), 'escalator');
});

test('renumberEquipment: 分類ごとに (no,id) 順で 1..n に詰め直す', () => {
  const catalog = [
    { id: 'z', category: 'ev', no: 5 },
    { id: 'a', category: 'ev', no: 2 },
    { id: 'c', category: 'ev', no: 9 },
  ];
  const renumbered = renumberEquipment(catalog);
  assert.equal(renumbered.get('a'), 1);
  assert.equal(renumbered.get('z'), 2);
  assert.equal(renumbered.get('c'), 3);
});

test('equipmentFloorSpanLabel: 1件ならその階名だけ、複数件なら最小〜最大の階名', () => {
  assert.equal(equipmentFloorSpanLabel([{ label: '1階', order: 0 }]), '1階');
  const label = equipmentFloorSpanLabel([
    { label: '3階', order: 2 },
    { label: '1階', order: 0 },
    { label: '2階', order: 1 },
  ]);
  assert.equal(label, '1階〜3階');
});

test('【失敗系】equipmentFloorSpanLabel: 空配列は throw する', () => {
  assert.throws(() => equipmentFloorSpanLabel([]));
});
