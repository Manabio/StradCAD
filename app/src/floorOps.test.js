import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorBytesEqual, computeFloorReorder, computeFloorChangeReorder, computeAltReorder, resolveChipReorderTarget,
  reconcilePlanes,
} from './floorOps.js';

// ---- floorBytesEqual ----
test('floorBytesEqual: null 同士は等しい', () => {
  assert.equal(floorBytesEqual(null, null), true);
});

test('floorBytesEqual: 片方が null なら等しくない', () => {
  assert.equal(floorBytesEqual(null, new Uint8Array([1, 2])), false);
  assert.equal(floorBytesEqual(new Uint8Array([1, 2]), null), false);
});

test('floorBytesEqual: 長さが違えば等しくない', () => {
  assert.equal(floorBytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

test('floorBytesEqual: 内容が同じなら等しい（別インスタンスでも）', () => {
  assert.equal(floorBytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
});

test('floorBytesEqual: 内容が違えば等しくない', () => {
  assert.equal(floorBytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
});

// ---- computeFloorReorder（フロアタブのドラッグ割り込み・再採番）----
function makePlanes() {
  return [
    { id: 'a', startFloor: 1, stories: 1, elevation: 0,    name: '1階' },
    { id: 'b', startFloor: 2, stories: 1, elevation: 3000, name: '2階' },
    { id: 'c', startFloor: 3, stories: 1, elevation: 6000, name: '3階' },
  ];
}

test('computeFloorReorder: 3階を2階の前へ移動すると、入替わった2階・3階だけ再採番される（最下階は不変）', () => {
  const planes = makePlanes();
  const updates = computeFloorReorder(planes, 'c', 1);
  assert.deepEqual(updates, [
    { id: 'c', name: '2階', startFloor: 2, elevation: 3000 },
    { id: 'b', name: '3階', startFloor: 3, elevation: 6000 },
  ]);
});

test('computeFloorReorder: 最下階（index 0）はドラッグ不可で null', () => {
  const planes = makePlanes();
  assert.equal(computeFloorReorder(planes, 'a', 2), null);
});

test('computeFloorReorder: 最下階の前へのドロップ（toZone<=0）は null', () => {
  const planes = makePlanes();
  assert.equal(computeFloorReorder(planes, 'b', 0), null);
});

test('computeFloorReorder: 隣接位置への移動（no-op）は null', () => {
  const planes = makePlanes();
  assert.equal(computeFloorReorder(planes, 'b', 1), null); // 自分の位置そのまま
  assert.equal(computeFloorReorder(planes, 'b', 2), null); // 直後＝隣接
});

// ---- computeFloorChangeReorder（階変更・再採番）----
test('computeFloorChangeReorder: 指定階以降が新startFloor起点で再採番される（下の階は不変）', () => {
  const planes = makePlanes();
  const updates = computeFloorChangeReorder(planes, 'b', 5);
  assert.deepEqual(updates, [
    { id: 'b', name: '5階', startFloor: 5, elevation: 3000 },
    { id: 'c', name: '6階', startFloor: 6, elevation: 6000 },
  ]);
});

test('computeFloorChangeReorder: newStartFloor=0 は null', () => {
  const planes = makePlanes();
  assert.equal(computeFloorChangeReorder(planes, 'b', 0), null);
});

test('computeFloorChangeReorder: 存在しない planeId は null', () => {
  const planes = makePlanes();
  assert.equal(computeFloorChangeReorder(planes, 'zzz', 5), null);
});

test('computeFloorChangeReorder: 最下階（index 0）変更時は elevation が prevElev=自身の元elevationへフォールバックする', () => {
  const planes = makePlanes();
  const updates = computeFloorChangeReorder(planes, 'a', 10);
  assert.deepEqual(updates, [
    { id: 'a', name: '10階', startFloor: 10, elevation: 0 }, // 最下階自身のelevationは動かない
    { id: 'b', name: '11階', startFloor: 11, elevation: 3000 },
    { id: 'c', name: '12階', startFloor: 12, elevation: 6000 },
  ]);
});

// ---- computeAltReorder（検討案の並替・altIndex再採番）----
function makeAlts() {
  return [
    { id: 'x', altIndex: 0 },
    { id: 'y', altIndex: 1 },
    { id: 'z', altIndex: 2 },
  ];
}

test('computeAltReorder: 末尾案を先頭へ移動すると altIndex が振り直される', () => {
  const alts = makeAlts();
  const updates = computeAltReorder(alts, 'z', 0);
  assert.deepEqual(updates, [
    { id: 'z', altIndex: 0 },
    { id: 'x', altIndex: 1 },
    { id: 'y', altIndex: 2 },
  ]);
});

test('computeAltReorder: 同位置・隣接位置への移動（no-op）は null', () => {
  const alts = makeAlts();
  assert.equal(computeAltReorder(alts, 'y', 1), null); // 自分の位置そのまま
  assert.equal(computeAltReorder(alts, 'y', 2), null); // 直後＝隣接
});

test('computeAltReorder: 存在しない fromId は null', () => {
  const alts = makeAlts();
  assert.equal(computeAltReorder(alts, 'zzz', 0), null);
});

// ---- resolveChipReorderTarget（検討チップのロングタップ・メニューによる並替対象の判定）----
test('resolveChipReorderTarget: 検討チップ（isAlternative）は kind=alt・refId・alts内でのtoZoneを返す', () => {
  const plane = { id: 'y', isAlternative: true, referenceId: 'ref1' };
  const alts = makeAlts();
  const target = resolveChipReorderTarget(plane, alts, [], 1); // direction>0 → i+2
  assert.deepEqual(target, { kind: 'alt', refId: 'ref1', toZone: 3 }); // yのindex=1 → 1+2=3
});

test('resolveChipReorderTarget: 採用チップ（非isAlternative）は kind=floor・planes内でのtoZoneを返す', () => {
  const plane = { id: 'b', isAlternative: false };
  const planes = makePlanes();
  const target = resolveChipReorderTarget(plane, [], planes, -1); // direction<0 → i-1
  assert.deepEqual(target, { kind: 'floor', toZone: 0 }); // bのindex=1 → 1-1=0
});

test('resolveChipReorderTarget: plane が null（planeMapに無いid）は null', () => {
  assert.equal(resolveChipReorderTarget(null, [], [], 1), null);
});

// ---- reconcilePlanes（plane一覧の復元差分計算）----
function makeMeta(overrides) {
  return {
    id: 'a', elevation: 0, name: '1階', startFloor: 1, stories: 1,
    isAlternative: false, referenceId: null, altIndex: 0,
    isRoofPlane: false, roofForPlaneId: null,
    ...overrides,
  };
}

test('reconcilePlanes: 正常系（複数階+検討階）— bootPlaneIdはtoUpdate、他はtoAdd、activePlaneIdはmetas通り', () => {
  const metas = {
    planes: [
      makeMeta({ id: 'a', elevation: 0,    name: '1階' }),
      makeMeta({ id: 'b', elevation: 3000, name: '2階' }),
      makeMeta({ id: 'alt1', elevation: 0, name: '検討A', isAlternative: true, referenceId: 'a', altIndex: 0 }),
    ],
    activePlaneId: 'b',
  };
  const result = reconcilePlanes(metas, ['a'], 'a');
  assert.deepEqual(result.toUpdate.map(p => p.id), ['a']);
  assert.deepEqual(result.toAdd.map(p => p.id).sort(), ['alt1', 'b']);
  assert.deepEqual(result.toRemove, []);
  assert.equal(result.activePlaneId, 'b');
});

test('reconcilePlanes: 参照先を失った検討階（referenceIdが最終集合に不在）は破棄される', () => {
  const metas = {
    planes: [
      makeMeta({ id: 'a', elevation: 0 }),
      makeMeta({ id: 'alt1', isAlternative: true, referenceId: 'ghost', altIndex: 0 }), // 'ghost' はmetas.planesに不在
    ],
    activePlaneId: 'a',
  };
  const result = reconcilePlanes(metas, ['a'], 'a');
  assert.deepEqual([...result.toAdd, ...result.toUpdate].map(p => p.id).sort(), ['a']);
  assert.equal(result.toRemove.length, 0); // 孤児検討はtoAdd対象から除外されるだけ（既存集合には無いのでtoRemoveにも現れない）
});

test('reconcilePlanes: activePlaneIdが最終集合に不在なら最下階（elevation最小の採用フロア）へフォールバック', () => {
  const metas = {
    planes: [
      makeMeta({ id: 'a', elevation: 0 }),
      makeMeta({ id: 'b', elevation: 3000 }),
    ],
    activePlaneId: 'ghost', // 最終集合に無い
  };
  const result = reconcilePlanes(metas, ['a'], 'a');
  assert.equal(result.activePlaneId, 'a'); // elevation最小
});

test('reconcilePlanes: bootPlaneIdがmetasに無ければtoRemoveに入る', () => {
  const metas = {
    planes: [makeMeta({ id: 'saved-1', elevation: 0 })],
    activePlaneId: 'saved-1',
  };
  const result = reconcilePlanes(metas, ['boot-1'], 'boot-1');
  assert.deepEqual(result.toAdd.map(p => p.id), ['saved-1']);
  assert.deepEqual(result.toRemove, ['boot-1']);
});

test('reconcilePlanes: metasが空（文書なし）はnullを返す', () => {
  assert.equal(reconcilePlanes(null, ['a'], 'a'), null);
  assert.equal(reconcilePlanes({ planes: [], activePlaneId: null }, ['a'], 'a'), null);
});

// ---- QA Finding 2: activePlaneIdが屋根planeを指す場合は採用しない ----
test('reconcilePlanes: activePlaneIdが屋根planeなら最下階（採用フロア）へフォールバックする', () => {
  const metas = {
    planes: [
      makeMeta({ id: 'a', elevation: 0 }),
      makeMeta({ id: 'b', elevation: 3000 }),
      makeMeta({ id: 'roof1', elevation: 6000, name: '小屋伏', isRoofPlane: true, roofForPlaneId: 'b' }),
    ],
    activePlaneId: 'roof1', // 構造モードの小屋伏図表示中に保存したケース
  };
  const result = reconcilePlanes(metas, ['a'], 'a');
  assert.equal(result.activePlaneId, 'a', '屋根planeではなく最下階（elevation最小の採用フロア）が採用される');
});

test('reconcilePlanes: 屋根planeはactiveに採用されないだけで最終集合（toAdd/toUpdate）には残る', () => {
  const metas = {
    planes: [
      makeMeta({ id: 'a', elevation: 0 }),
      makeMeta({ id: 'roof1', elevation: 6000, name: '小屋伏', isRoofPlane: true, roofForPlaneId: 'a' }),
    ],
    activePlaneId: 'roof1',
  };
  const result = reconcilePlanes(metas, ['a'], 'a');
  const finalIds = [...result.toAdd, ...result.toUpdate].map(p => p.id).sort();
  assert.deepEqual(finalIds, ['a', 'roof1'], '屋根planeは除外されず生き残る（構造モードの図面合成に必要）');
  assert.deepEqual(result.toRemove, []);
});

// savedActive の解決は finalMetas（孤児検討階を除外した後の集合）から行う必要がある。
// raw list（metas.planes）から解決すると、孤児検討階を指す activePlaneId をそのまま採用してしまい、
// 当該 plane は planeMap に存在しない → activate(undefined, undefined) で起動が落ちる。
test('reconcilePlanes: activePlaneIdが孤児検討階を指す場合も最下階へフォールバックする（activePlaneIdは必ず最終集合に存在する）', () => {
  const metas = {
    planes: [
      makeMeta({ id: 'a', elevation: 0 }),
      makeMeta({ id: 'orphan', isAlternative: true, referenceId: 'gone', altIndex: 0 }), // 親 'gone' は不在
    ],
    activePlaneId: 'orphan',
  };
  const result = reconcilePlanes(metas, ['a'], 'a');
  assert.equal(result.activePlaneId, 'a');
  assert.ok(
    [...result.toAdd, ...result.toUpdate].some(p => p.id === result.activePlaneId),
    'activePlaneId は必ず最終集合（planeMapに実在することになる集合）に含まれる',
  );
});

// ---- 失敗パス: metas.planes が undefined（想定外の入力形状）----
test('reconcilePlanes: metas.planesがundefined（想定外の入力）はnullを返し例外を投げない', () => {
  assert.doesNotThrow(() => reconcilePlanes({ activePlaneId: 'a' }, ['a'], 'a'));
  assert.equal(reconcilePlanes({ activePlaneId: 'a' }, ['a'], 'a'), null);
});
