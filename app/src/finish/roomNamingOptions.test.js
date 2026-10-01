import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature, SHAFT_FEATURES } from '@core';
import {
  ROOM_KIND_OPTIONS, ROOM_FEATURE_OPTIONS, CARD_FEATURE_OPTIONS, featureOptionsForDialog,
  featureToSelectValue, selectValueToFeature, effectiveDialogKind, isKindLockedByFeature,
} from './roomNamingOptions.js';

test('ROOM_FEATURE_OPTIONS は5つで、value集合が [null, STAIR, VOID, ELEVATOR_EQUIPMENT, ROOF] に一致し、ラベルは なし/階段/吹抜け/昇降機/屋根（重複なし）', () => {
  assert.equal(ROOM_FEATURE_OPTIONS.length, 5);
  const values = ROOM_FEATURE_OPTIONS.map(o => o.value);
  const expected = [null, RoomFeature.STAIR, RoomFeature.VOID, RoomFeature.ELEVATOR_EQUIPMENT, RoomFeature.ROOF];
  assert.deepEqual(values, expected);
  assert.equal(new Set(values).size, values.length, '重複がある');
  assert.deepEqual(ROOM_FEATURE_OPTIONS.map(o => o.label), ['なし', '階段', '吹抜け', '昇降機', '屋根']);
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

test('featureToSelectValue / selectValueToFeature は往復する（null⇄\'\'、\'elevatorEquipment\'⇄\'elevatorEquipment\'、\'roof\'⇄\'roof\'）', () => {
  assert.equal(featureToSelectValue(null), '');
  assert.equal(selectValueToFeature(''), null);
  assert.equal(featureToSelectValue(RoomFeature.ELEVATOR_EQUIPMENT), 'elevatorEquipment');
  assert.equal(selectValueToFeature('elevatorEquipment'), RoomFeature.ELEVATOR_EQUIPMENT);
  assert.equal(featureToSelectValue(RoomFeature.ROOF), 'roof');
  assert.equal(selectValueToFeature('roof'), RoomFeature.ROOF);
});

// ---- ステップ1（部屋編集の導線変更）: 内部タブのカード用属性選択肢は昇降路・屋根を含まない ----
test('CARD_FEATURE_OPTIONS は [null, STAIR, VOID] の3つ（なし/階段/吹抜け）で、昇降路（SHAFT_FEATURES）・屋根を含まない', () => {
  const values = CARD_FEATURE_OPTIONS.map(o => o.value);
  assert.deepEqual(values, [null, RoomFeature.STAIR, RoomFeature.VOID]);
  for (const feature of SHAFT_FEATURES) {
    assert.ok(!values.includes(feature), `SHAFT_FEATURES の ${feature} が CARD_FEATURE_OPTIONS に含まれている`);
  }
  assert.ok(!values.includes(RoomFeature.ROOF), '屋根が CARD_FEATURE_OPTIONS に含まれている');
});

// ---- 昇降機の仕様追加ステップ2: 部屋名ダイアログの選択肢は部分指定かどうかで変わる ----
test('featureOptionsForDialog: 通常の新規部屋（referenceRoomIdsが空）はROOM_FEATURE_OPTIONSそのまま5つ', () => {
  const room = { referenceRoomIds: new Set() };
  assert.deepEqual(featureOptionsForDialog(room), ROOM_FEATURE_OPTIONS);
  assert.equal(featureOptionsForDialog(room).length, 5);
});

test('featureOptionsForDialog: 部分指定（referenceRoomIds非空）は昇降機（SHAFT_FEATURES）・屋根を除いた3つ', () => {
  const room = { referenceRoomIds: new Set(['parent-id']) };
  const values = featureOptionsForDialog(room).map(o => o.value);
  assert.deepEqual(values, [null, RoomFeature.STAIR, RoomFeature.VOID]);
  for (const feature of SHAFT_FEATURES) {
    assert.ok(!values.includes(feature), `SHAFT_FEATURES の ${feature} が部分指定の選択肢に含まれている`);
  }
  assert.ok(!values.includes(RoomFeature.ROOF), '屋根が部分指定の選択肢に含まれている');
});

// ---- QA指摘（ステップ3全体・T5）: isNew===falseの統合ダイアログは昇降機・屋根を出さない ----
test('featureOptionsForDialog: isNew===false（判定2の統合ダイアログ）は昇降機・屋根を除いた3つ（部分指定でなくても）', () => {
  const room = { referenceRoomIds: new Set() }; // 部分指定ではない
  const values = featureOptionsForDialog(room, { isNew: false }).map(o => o.value);
  assert.deepEqual(values, [null, RoomFeature.STAIR, RoomFeature.VOID]);
  for (const feature of SHAFT_FEATURES) {
    assert.ok(!values.includes(feature), `SHAFT_FEATURES の ${feature} が isNew:false の選択肢に含まれている`);
  }
  assert.ok(!values.includes(RoomFeature.ROOF), '屋根が isNew:false の選択肢に含まれている');
});

test('featureOptionsForDialog: isNew===true・引数省略は（部分指定でなければ）ROOM_FEATURE_OPTIONSそのまま5つ（昇降機・屋根を含む）', () => {
  const room = { referenceRoomIds: new Set() };
  assert.deepEqual(featureOptionsForDialog(room, { isNew: true }), ROOM_FEATURE_OPTIONS);
  assert.deepEqual(featureOptionsForDialog(room), ROOM_FEATURE_OPTIONS, '第2引数省略は従来どおり5つのはず');
});

// ---- 失敗系: referenceRoomIds が undefined/null（想定外の入力）でも例外にならず通常の5つを返す ----
test('【失敗系】featureOptionsForDialog: referenceRoomIdsがundefinedでも例外にならず5つ', () => {
  const room = { referenceRoomIds: undefined };
  assert.equal(featureOptionsForDialog(room).length, 5);
});

test('【失敗系】featureOptionsForDialog: referenceRoomIdsがnullでも例外にならず5つ', () => {
  const room = { referenceRoomIds: null };
  assert.equal(featureOptionsForDialog(room).length, 5);
});

test('【失敗系】featureOptionsForDialog: room自体がnull/undefinedでも例外にならず5つ', () => {
  assert.equal(featureOptionsForDialog(null).length, 5);
  assert.equal(featureOptionsForDialog(undefined).length, 5);
});

// ---- B1a: 屋根は区分を屋外に固定する ----
test('【B1a】effectiveDialogKind / isKindLockedByFeature: 屋根は区分が屋外に固定、他の属性は選んだ区分のまま', () => {
  assert.equal(effectiveDialogKind(RoomKind.INTERIOR, RoomFeature.ROOF), RoomKind.EXTERIOR);
  assert.equal(effectiveDialogKind(RoomKind.EXTERIOR, RoomFeature.ROOF), RoomKind.EXTERIOR);
  assert.equal(effectiveDialogKind(RoomKind.INTERIOR, null), RoomKind.INTERIOR);
  assert.equal(effectiveDialogKind(RoomKind.INTERIOR, RoomFeature.STAIR), RoomKind.INTERIOR);
  assert.equal(isKindLockedByFeature(RoomFeature.ROOF), true);
  assert.equal(isKindLockedByFeature(null), false);
  assert.equal(isKindLockedByFeature(RoomFeature.VOID), false);
});
