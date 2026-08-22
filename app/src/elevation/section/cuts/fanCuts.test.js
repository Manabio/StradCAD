// fanCuts.js（WP-E6: 扇形レーンを持つ階段タイプの未対応明示）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType } from '@core';
import { fanLaneCuts, UNSUPPORTED_FAN_LANE_TYPES } from './fanCuts.js';

test('【WP-E6】UNSUPPORTED_FAN_LANE_TYPES: WINDING/L_TURN/FLARED/OPEN_WELLの4種を含む', () => {
  assert.deepEqual([...UNSUPPORTED_FAN_LANE_TYPES].sort(), [
    StairType.FLARED, StairType.L_TURN, StairType.OPEN_WELL, StairType.WINDING,
  ].sort());
});

test('【失敗系・WP-E6】fanLaneCuts: WINDING/L_TURN/FLARED/OPEN_WELLはいずれもnullを返す', () => {
  for (const type of UNSUPPORTED_FAN_LANE_TYPES) {
    assert.equal(fanLaneCuts({ type }), null, `${type}はnullのはず`);
  }
});

test('【失敗系・WP-E6】fanLaneCuts: 対象外の値（未定義stair・null）でも例外を投げずnullを返す', () => {
  assert.equal(fanLaneCuts(null), null);
  assert.equal(fanLaneCuts(undefined), null);
});
