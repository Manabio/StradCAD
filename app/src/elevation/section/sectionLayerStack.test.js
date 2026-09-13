// sectionLayerStack.js の単体テスト。層スタックの一般規則（所有層・帯自身の階・上位層・
// 優先順位・見えがかり壁のz上限）を、graphを介さない素のLayerInfoリテラルで直接固定する。
// 「role名と配列順に依存しない」ことがこのモジュールの存在理由なので、**層数と入力順を
// 変えても答えが変わらない**ことを中心に検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature } from '@core';
import {
  isRealRoom, orderLayerStack, baseLayerOf, layerOwningZ,
  layersAboveOf, compareLayerPriority, resolveSightlineTopZ, layerDirectlyAboveSelf,
} from './sectionLayerStack.js';

// LayerInfo（probeColumnが層ごとに作る「その列でのその層の床天井」）の最小リテラル。
function info(floorZMm, { room = null, ch = 2400, role } = {}) {
  return { layer: { graph: {}, floorZMm, role }, room, floorZ: floorZMm, ceilZ: floorZMm + ch };
}
const realRoom = { feature: undefined };
const voidRoom = { feature: RoomFeature.VOID };
const stairVoidRoom = { feature: RoomFeature.STAIR_VOID };

// ---- isRealRoom ----
test('isRealRoom: VOID/STAIR_VOIDのRoomは「実床が無い」ため実Roomとみなさない', () => {
  assert.equal(isRealRoom(realRoom), true);
  assert.equal(isRealRoom(voidRoom), false);
  assert.equal(isRealRoom(stairVoidRoom), false);
  assert.equal(isRealRoom(null), false, 'Roomが無い（部屋外）のも実Roomではない');
});

// ---- orderLayerStack ----
test('orderLayerStack: floorZMm昇順へ整列し、入力順が違っても同じ並びになる', () => {
  const a = info(0), b = info(2900), c = info(5800);
  const zs = arr => orderLayerStack(arr).map(i => i.layer.floorZMm);
  assert.deepEqual(zs([a, b, c]), [0, 2900, 5800]);
  assert.deepEqual(zs([c, a, b]), [0, 2900, 5800], '入力順に依存しないこと自体が本モジュールの目的');
  assert.deepEqual(zs([]), [], '層0件でも例外を投げない');
});

test('orderLayerStack: floorZMmが同値の層は入力順を保つ（安定ソート）', () => {
  const a = info(0, { role: 'self' }), b = info(0, { role: 'twin' });
  assert.deepEqual(orderLayerStack([a, b]).map(i => i.layer.role), ['self', 'twin']);
  assert.deepEqual(orderLayerStack([b, a]).map(i => i.layer.role), ['twin', 'self']);
});

// ---- baseLayerOf ----
test('baseLayerOf: z原点（帯のFL）に最も近い層が帯自身の階になる（role名を見ない）', () => {
  const self = info(0), above = info(2900), below = info(-2900);
  assert.equal(baseLayerOf(orderLayerStack([above, below, self])), self);
  assert.equal(baseLayerOf(orderLayerStack([above, self])), self);
  assert.equal(baseLayerOf(orderLayerStack([])), null, '層0件はnull（呼び出し側で分岐できる）');
});

test('baseLayerOf: z原点から等距離なら上側（地上側）を優先する（旧ROLE_ORDERのself<above<belowと同順）', () => {
  const above = info(2900), below = info(-2900);
  assert.equal(baseLayerOf(orderLayerStack([below, above])), above);
});

// ---- layerOwningZ ----
test('layerOwningZ: floorZMmがz以下で最も高い層がその高さを所有する', () => {
  const self = info(0), above = info(2900), above2 = info(5800);
  const stack = orderLayerStack([self, above, above2]);
  assert.equal(layerOwningZ(stack, 1200), self);
  assert.equal(layerOwningZ(stack, 2900), above, '層の床ちょうどはその層が所有する');
  assert.equal(layerOwningZ(stack, 4000), above);
  assert.equal(layerOwningZ(stack, 7000), above2, '3層目を飛ばして2層目を返してはいけない（旧findの誤り）');
});

test('layerOwningZ: 最下層の床より下は最下層へフォールバックする', () => {
  const stack = orderLayerStack([info(0), info(2900)]);
  assert.equal(layerOwningZ(stack, -500).layer.floorZMm, 0);
  assert.equal(layerOwningZ([], 0), null, '層0件はnull');
});

// ---- layersAboveOf ----
test('layersAboveOf: その層より上に積まれた層だけを下から順に返す', () => {
  const self = info(0), above = info(2900), above2 = info(5800);
  const stack = orderLayerStack([self, above, above2]);
  assert.deepEqual(layersAboveOf(stack, self).map(i => i.layer.floorZMm), [2900, 5800]);
  assert.deepEqual(layersAboveOf(stack, above).map(i => i.layer.floorZMm), [5800]);
  assert.deepEqual(layersAboveOf(stack, above2), [], '最上層の上は空（最上階の壁は自層天井のまま）');
});

// ---- compareLayerPriority ----
test('compareLayerPriority: 帯自身の階→上階→下階の順（旧ROLE_ORDER表と2層構成で同値）', () => {
  const self = info(0), above = info(2900), below = info(-2900);
  assert.ok(compareLayerPriority(self, above) < 0);
  assert.ok(compareLayerPriority(above, below) < 0, '同距離なら上側を優先');
  assert.ok(compareLayerPriority(above, info(5800)) < 0, '近い階を優先（層数に依らない一般形）');
});

// ---- resolveSightlineTopZ ----
// ユーザー明示指示2026-08の点4「天井から上階FLまでの間にある面も『壁』扱い」で規則変更。
// 上限は自層の天井ではなく**上階のFL**——天井裏の壁も同じ面として続くため、CHに見えがかり線が
// 立たなくなる（emitColumnsの「距離が変わるところにだけ描く」一般規則が自動的にそう導く）。
test('resolveSightlineTopZ: 上階に実床があれば自層の天井まで（天井裏は見えない）', () => {
  const self = info(0), above = info(2900, { room: realRoom });
  const stack = orderLayerStack([self, above]);
  // 上階に実床があれば、その手前の**自層の天井**で見えがかりは終わる（ユーザー実機指摘2026-08
  // 「「5」D1: 1F天井見えがかり（細線）が…1FL天井断面に衝突するまで」）。天井裏にも壁の実体は
  // あるが、見えがかりは**見えるもの**だけで、天井に隠れて見えない。点4「天井裏も壁」は
  // 上が吹抜けで壁が実際に見え続ける場合の規則としてそのまま残る（下のVOIDのテスト）。
  assert.equal(resolveSightlineTopZ(stack, self, () => realRoom, 9999), 2400,
    '自層の天井(2400)で終わる——天井裏(2400〜2900)は天井に隠れて見えない');
});

test('resolveSightlineTopZ: 上が吹抜けなら上階の天井まで延びる', () => {
  const self = info(0), above = info(2900, { room: voidRoom });
  const stack = orderLayerStack([self, above]);
  assert.equal(resolveSightlineTopZ(stack, self, () => voidRoom, 9999), 5300);
});

test('resolveSightlineTopZ: 吹抜けが続く限り何層でも登る（多層の一般化。旧実装は上階1段で止まっていた）', () => {
  const self = info(0), above = info(2900, { room: voidRoom }), above2 = info(5800, { room: voidRoom });
  const stack = orderLayerStack([self, above, above2]);
  assert.equal(resolveSightlineTopZ(stack, self, () => voidRoom, 9999), 8200);
});

test('resolveSightlineTopZ: 吹抜けは通り抜け、その上に実床があればその階の天井で止まる', () => {
  const self = info(0), above = info(2900), above2 = info(5800);
  const stack = orderLayerStack([self, above, above2]);
  const roomAt = upper => (upper.layer.floorZMm === 2900 ? voidRoom : realRoom);
  assert.equal(resolveSightlineTopZ(stack, self, roomAt, 9999), 5300,
    '2階は吹抜けなので通り抜けるが、その天井(5300)より上は3階の床に隠れて見えない');
});

test('resolveSightlineTopZ: 上階側の層の壁にも同じ規則が適用される（旧実装はself層限定だった）', () => {
  const self = info(0), above = info(2900), above2 = info(5800, { room: voidRoom });
  const stack = orderLayerStack([self, above, above2]);
  assert.equal(resolveSightlineTopZ(stack, above, () => voidRoom, 9999), 8200);
});

test('【失敗系】resolveSightlineTopZ: 上位層のceilZが無ければfallbackZを使う', () => {
  const self = info(0);
  const broken = { layer: { graph: {}, floorZMm: 2900 }, room: voidRoom, floorZ: 2900, ceilZ: null };
  const stack = orderLayerStack([self, broken]);
  assert.equal(resolveSightlineTopZ(stack, self, () => voidRoom, 7777), 7777);
});

test('【失敗系】resolveSightlineTopZ: 上位層が無い（最上階）なら自層の天井のまま', () => {
  const self = info(0);
  assert.equal(resolveSightlineTopZ(orderLayerStack([self]), self, () => null, 9999), 2400);
});

// ---- layerDirectlyAboveSelf（Phase 7b-2是正・QA指摘F1: baseLayerOf/layersAboveOfを合成する
// 薄いアダプタ。role名は見ない・εはlayersAboveOf経由） ----
// 生の層（{graph, floorZMm, role?}）のリテラル。roleは記録用の識別子でしかなく、
// layerDirectlyAboveSelf自身はrole名を一切読まない（自階の特定はbaseLayerOf＝z原点最近傍）。
function rawLayer(floorZMm, role) {
  return { graph: {}, floorZMm, role };
}

test('layerDirectlyAboveSelf: above2層のうちfloorZMmが小さい方（自階の直上）を選ぶ', () => {
  const self = rawLayer(0, 'self');
  const above1 = rawLayer(2900, 'above');
  const above2 = rawLayer(5800, 'above2');
  assert.equal(layerDirectlyAboveSelf([self, above1, above2]), above1);
});

test('layerDirectlyAboveSelf: 配列の並び順を入れ替えても同じ層を選ぶ（role名・配列順に依存しない）', () => {
  const self = rawLayer(0, 'self');
  const above1 = rawLayer(2900, 'above');
  const above2 = rawLayer(5800, 'above2');
  const perms = [
    [self, above1, above2], [self, above2, above1], [above1, self, above2],
    [above2, above1, self], [above1, above2, self], [above2, self, above1],
  ];
  for (const perm of perms) {
    assert.equal(layerDirectlyAboveSelf(perm), above1, `並び[${perm.map(l => l.floorZMm)}]で結果が変わった`);
  }
});

test('layerDirectlyAboveSelf: below層しか無ければnull（自階より上の層が無い）', () => {
  const self = rawLayer(0, 'self');
  const below = rawLayer(-2900, 'below');
  assert.equal(layerDirectlyAboveSelf([self, below]), null);
});

test('layerDirectlyAboveSelf: above/below混在でも自階より上だけから選ぶ', () => {
  const self = rawLayer(0, 'self');
  const below = rawLayer(-2900, 'below');
  const above = rawLayer(2900, 'above');
  assert.equal(layerDirectlyAboveSelf([below, self, above]), above);
});

// role名を見ないため「self層が無い」という概念自体が無い——1層しかない配列は、その1層が
// baseLayerOf（z原点最近傍）として自階役を担い、自階より上の層が無い＝nullになる
// （どの層をroleで'self'と呼んでいても答えは変わらない）。
test('【失敗系】layerDirectlyAboveSelf: 層が1件しかなければ（自階より上の層が無い）null', () => {
  const above = rawLayer(2900, 'above');
  assert.equal(layerDirectlyAboveSelf([above]), null);
});

test('【失敗系】layerDirectlyAboveSelf: 層が0件・未指定でも例外を投げずnull', () => {
  assert.equal(layerDirectlyAboveSelf([]), null);
  assert.equal(layerDirectlyAboveSelf(undefined), null);
});

// QA指摘5-2: 自階より上に同一floorZMmの層が2つあるとき、決めた規則（入力配列内で先に現れた
// ものを返す＝orderLayerStackの安定ソートが同値を入力順のまま残す）を固定する。
test('【決めた規則】layerDirectlyAboveSelf: 自階より上に同一floorZMmの層が2つあれば、入力配列内で先に現れた方を返す', () => {
  const self = rawLayer(0, 'self');
  const aboveFirst = rawLayer(2900, 'above-first');
  const aboveSecond = rawLayer(2900, 'above-second'); // 同一floorZMm・別オブジェクト
  assert.equal(layerDirectlyAboveSelf([self, aboveFirst, aboveSecond]), aboveFirst,
    '入力配列で先に現れたaboveFirstを返すはず');
  // 入力順を入れ替えると「先に現れた方」も入れ替わる（この規則自体は入力順に依存することの明示。
  // 一般のINV2「配列順不変」はfloorZMmが相異なる場合の話で、この退化例（同一floorZMm）は対象外）。
  assert.equal(layerDirectlyAboveSelf([self, aboveSecond, aboveFirst]), aboveSecond,
    '入れ替えれば先に現れるaboveSecondを返すはず（同一floorZMmの退化例は入力順で決まる）');
});
