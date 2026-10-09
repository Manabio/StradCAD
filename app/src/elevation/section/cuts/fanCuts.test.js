// fanCuts.js（WP-E6: 扇形レーンを持つ階段タイプの未対応明示）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType } from '@core';
import { fanLaneCuts, UNSUPPORTED_FAN_LANE_TYPES } from './fanCuts.js';

test('【WP-E6】UNSUPPORTED_FAN_LANE_TYPES: L_TURN/FLARED/OPEN_WELLの3種を含み、WINDINGは含まない（2026-10-09: 回転部を段付きの踊り場として折返しのエンジンへ通す）', () => {
  assert.deepEqual([...UNSUPPORTED_FAN_LANE_TYPES].sort(), [
    StairType.FLARED, StairType.L_TURN, StairType.OPEN_WELL,
  ].sort());
  assert.ok(!UNSUPPORTED_FAN_LANE_TYPES.includes(StairType.WINDING), 'WINDINGは対象外（switchbackCutsが担当）');
});

test('【失敗系・WP-E6】fanLaneCuts: L_TURN/FLARED/OPEN_WELLはいずれもnullを返す', () => {
  for (const type of UNSUPPORTED_FAN_LANE_TYPES) {
    assert.equal(fanLaneCuts({ type }), null, `${type}はnullのはず`);
  }
});

test('【失敗系・WP-E6】fanLaneCuts: 対象外の値（未定義stair・null）でも例外を投げずnullを返す', () => {
  assert.equal(fanLaneCuts(null), null);
  assert.equal(fanLaneCuts(undefined), null);
});
