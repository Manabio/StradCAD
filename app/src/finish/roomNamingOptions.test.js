import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature, SHAFT_FEATURES } from '@core';
import {
  ROOM_KIND_OPTIONS, ROOM_FEATURE_OPTIONS, CARD_FEATURE_OPTIONS,
  featureToSelectValue, selectValueToFeature,
} from './roomNamingOptions.js';

test('ROOM_FEATURE_OPTIONS は7つで、value集合が [null, STAIR, VOID, EV, DW, FREIGHT_EV, VEHICLE_EV] に一致する（重複なし）', () => {
  assert.equal(ROOM_FEATURE_OPTIONS.length, 7);
  const values = ROOM_FEATURE_OPTIONS.map(o => o.value);
  const expected = [null, RoomFeature.STAIR, RoomFeature.VOID,
    RoomFeature.EV, RoomFeature.DW, RoomFeature.FREIGHT_EV, RoomFeature.VEHICLE_EV];
  assert.deepEqual(values, expected);
  assert.equal(new Set(values).size, values.length, '重複がある');
});

test('ROOM_FEATURE_OPTIONS は SHAFT_FEATURES（core側の実体Set）の全要素を含む（将来PS等が足されてもダイアログで選べないまま緑にならないよう、実装のSetを読んで照合する）', () => {
  const optionValues = new Set(ROOM_FEATURE_OPTIONS.map(o => o.value));
  for (const feature of SHAFT_FEATURES) {
    assert.ok(optionValues.has(feature), `SHAFT_FEATURES の ${feature} が ROOM_FEATURE_OPTIONS に無い`);
  }
});

test('ROOM_KIND_OPTIONS は屋内・屋外の2つ', () => {
  assert.equal(ROOM_KIND_OPTIONS.length, 2);
  assert.deepEqual(ROOM_KIND_OPTIONS.map(o => o.value), [RoomKind.INTERIOR, RoomKind.EXTERIOR]);
});

test('featureToSelectValue / selectValueToFeature は往復する（null⇄\'\'、\'ev\'⇄\'ev\'）', () => {
  assert.equal(featureToSelectValue(null), '');
  assert.equal(selectValueToFeature(''), null);
  assert.equal(featureToSelectValue(RoomFeature.EV), 'ev');
  assert.equal(selectValueToFeature('ev'), RoomFeature.EV);
});

// ---- ステップ1（部屋編集の導線変更）: 内部タブのカード用属性選択肢は昇降路を含まない ----
test('CARD_FEATURE_OPTIONS は [null, STAIR, VOID] の3つ（なし/階段/吹抜け）で、昇降路（SHAFT_FEATURES）を含まない', () => {
  const values = CARD_FEATURE_OPTIONS.map(o => o.value);
  assert.deepEqual(values, [null, RoomFeature.STAIR, RoomFeature.VOID]);
  for (const feature of SHAFT_FEATURES) {
    assert.ok(!values.includes(feature), `SHAFT_FEATURES の ${feature} が CARD_FEATURE_OPTIONS に含まれている`);
  }
});
