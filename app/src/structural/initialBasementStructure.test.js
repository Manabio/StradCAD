// initialBasementStructureFor: 下階追加で地階が初めて生まれるときの地階構造の初期値（問題.md Q17・Q19。S5c-2）。
// 明示引数の純関数（仮の graph を組んで effectiveStructure に通さない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRUCTURES } from './structuralClassification.js';
import { initialBasementStructureFor, BASEMENT_STRUCTURE_OPTIONS, normalizeBasementStructure } from './structureRules.js';

const RAHMEN = 'RC造(ラーメン)';
const WALL = 'RC造(壁式)';

test('全構造の対応: RC造(ラーメン)・S造・SRC造→ラーメン、RC造(壁式)・木造（在来・2"×4"）→壁式', () => {
  const table = Object.fromEntries(STRUCTURES.map(s => [s, initialBasementStructureFor(s)]));
  assert.deepEqual(table, {
    'RC造(ラーメン)': RAHMEN,
    'RC造(壁式)': WALL,
    'S造': RAHMEN,
    'SRC造': RAHMEN,
    '木造（在来）': WALL,
    '木造（2"×4"）': WALL,
  });
});

test('戻り値は常に地階構造として保存できる値（BASEMENT_STRUCTURE_OPTIONS の要素）', () => {
  for (const s of [...STRUCTURES, '未定', null, undefined, '', 'XYZ']) {
    const v = initialBasementStructureFor(s);
    assert.ok(BASEMENT_STRUCTURE_OPTIONS.includes(v), `${String(s)} → ${v}`);
    assert.equal(normalizeBasementStructure(v), v);
  }
});

test('【失敗系】未指定・未知の値は throw せず壁式（階追加の途中で throw して追従処理を止めない）', () => {
  for (const s of ['未定', null, undefined, '', 'XYZ', 'constructor', 'toString']) {
    assert.equal(initialBasementStructureFor(s), WALL, `${String(s)} は壁式`);
  }
});
