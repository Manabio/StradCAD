// finish/equipment/equipmentOptions.js（機械器具タブの画面文言。純モジュール）の単体テスト。
// node:test から直接importできること自体が「react/store.js/snap.js/.jsxを静的importしない」証拠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvUsage } from '@core';
import { EV_USAGE_OPTIONS, CATEGORY_LABEL } from './equipmentOptions.js';

test('EV_USAGE_OPTIONS: 乗用／人荷用／荷物用の3件をEvUsageの値で持つ', () => {
  assert.deepEqual(EV_USAGE_OPTIONS.map(o => o.value), [EvUsage.PASSENGER, EvUsage.PASSENGER_FREIGHT, EvUsage.FREIGHT]);
  assert.deepEqual(EV_USAGE_OPTIONS.map(o => o.label), ['乗用', '人荷用', '荷物用']);
});

test('CATEGORY_LABEL.ev は EV', () => {
  assert.equal(CATEGORY_LABEL.ev, 'EV');
});
