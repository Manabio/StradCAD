import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ColumnOrigin, formatColumnOrigins, parseColumnOrigins, mergeSlot } from './columnOrigins.js';

test('formatColumnOrigins: 空集合・null はいずれも null', () => {
  assert.equal(formatColumnOrigins(new Set()), null);
  assert.equal(formatColumnOrigins(null), null);
});

test('formatColumnOrigins: ソートして","連結する（Setの挿入順に依存しない決定的な文字列）', () => {
  assert.equal(formatColumnOrigins(new Set([ColumnOrigin.WALL, ColumnOrigin.ABOVE])), 'above,wall');
  assert.equal(formatColumnOrigins(new Set([ColumnOrigin.ABOVE, ColumnOrigin.WALL])), 'above,wall',
    '挿入順が逆でも同じ文字列になる');
});

test('parseColumnOrigins: null・空文字は空集合、それ以外は","で分割したSet', () => {
  assert.deepEqual(parseColumnOrigins(null), new Set());
  assert.deepEqual(parseColumnOrigins(''), new Set());
  assert.deepEqual(parseColumnOrigins('above,wall'), new Set([ColumnOrigin.ABOVE, ColumnOrigin.WALL]));
});

test('formatColumnOrigins/parseColumnOrigins: 往復する', () => {
  const origins = new Set([ColumnOrigin.SUPPORT_SPAN, ColumnOrigin.FREE_END]);
  assert.deepEqual(parseColumnOrigins(formatColumnOrigins(origins)), origins);
});

test('mergeSlot: 新規キーは {...entry, origins:new Set(origins)} をsetする', () => {
  const slots = new Map();
  mergeSlot(slots, 'k1', { verticalCL: 'v1', horizontalCL: 'h1' }, [ColumnOrigin.WALL]);
  assert.deepEqual(slots.get('k1'), { verticalCL: 'v1', horizontalCL: 'h1', origins: new Set([ColumnOrigin.WALL]) });
});

test('mergeSlot: 同じキーへの2回目の呼び出しは origins を和集合にし、他フィールドは後勝ちで上書きする', () => {
  const slots = new Map();
  mergeSlot(slots, 'k1', { verticalCL: 'v1', horizontalCL: 'h1' }, [ColumnOrigin.WALL]);
  mergeSlot(slots, 'k1', { verticalCL: 'v2', horizontalCL: 'h2' }, [ColumnOrigin.ABOVE]);
  const entry = slots.get('k1');
  assert.equal(entry.verticalCL, 'v2', '後勝ちで上書き');
  assert.equal(entry.horizontalCL, 'h2', '後勝ちで上書き');
  assert.deepEqual(entry.origins, new Set([ColumnOrigin.WALL, ColumnOrigin.ABOVE]), 'originsは和集合');
});

test('mergeSlot: 0件のoriginsを渡しても既存のoriginsは保持される（袖柱のように空集合を足す場合）', () => {
  const slots = new Map();
  mergeSlot(slots, 'k1', { verticalCL: 'v1' }, [ColumnOrigin.WALL]);
  mergeSlot(slots, 'k1', { verticalCL: 'v1' }, []);
  assert.deepEqual(slots.get('k1').origins, new Set([ColumnOrigin.WALL]));
});

test('mergeSlot: Mapの挿入位置は既存キーのまま変わらない（slots.setの意味論を変えない）', () => {
  const slots = new Map();
  mergeSlot(slots, 'k1', {}, []);
  mergeSlot(slots, 'k2', {}, []);
  mergeSlot(slots, 'k1', {}, [ColumnOrigin.WALL]); // k1を更新してもMapの反復順は変わらない
  assert.deepEqual([...slots.keys()], ['k1', 'k2']);
});
