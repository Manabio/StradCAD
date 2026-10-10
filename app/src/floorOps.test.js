import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorBytesEqual, computeFloorReorder, computeFloorChangeReorder, computeAltReorder, resolveChipReorderTarget,
  reconcilePlanes, blocksFloorRemoval, renumberPlanesFrom, computeFloorDeleteReorder,
  computeFloorInsert, applyFloorInsert, collectPlaneMetas, applyPlaneMetas, diffFloorOpSnapshot, setPlanCutHeightMm, setCeilingCutHeightMm,
} from './floorOps.js';
import { Project } from './core/project.js';

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

// ---- blocksFloorRemoval（削除して良いかの判定。QA指摘F1・2026-09-27）----
test('blocksFloorRemoval: アクティブ階本体が対象なら削除を止める（true）', () => {
  const project = { activePlaneId: 'p1', activePlane: { id: 'p1', isAlternative: false } };
  assert.equal(blocksFloorRemoval(project, 'p1'), true);
});

test('blocksFloorRemoval: アクティブ階の検討案（referenceId=対象）がアクティブでも削除を止める（true）', () => {
  const project = {
    activePlaneId: 'p1-alt',
    activePlane: { id: 'p1-alt', isAlternative: true, referenceId: 'p1' },
  };
  assert.equal(blocksFloorRemoval(project, 'p1'), true);
});

test('【失敗系】blocksFloorRemoval: 無関係な階がアクティブなら削除してよい（false）', () => {
  const project = { activePlaneId: 'p2', activePlane: { id: 'p2', isAlternative: false } };
  assert.equal(blocksFloorRemoval(project, 'p1'), false);
});

test('【失敗系】blocksFloorRemoval: アクティブ階が対象の検討案（逆方向。対象=検討・アクティブ=採用元）なら削除してよい（false）', () => {
  // 対象planeId自体が検討案で、アクティブは別の採用階のケース——isActiveAnAltOfはreferenceId一致のみ見るため
  // false（対象と無関係な採用階がアクティブなだけ）。
  const project = { activePlaneId: 'p1', activePlane: { id: 'p1', isAlternative: false, referenceId: null } };
  assert.equal(blocksFloorRemoval(project, 'p1-alt'), false);
});

// ================================================================
// 途中階の上階追加と階移動の振り直し一本化（261001_途中階の上階追加と階移動の振り直し一本化.md）
// ステップ0: 再現テスト（製品コード非変更）。ステップ1: 振り直しの純関数。
// ================================================================

// ---- computeFloorInsert / applyFloorInsert（途中階の上階追加。ステップ2）----

test('computeFloorInsert: 1〜5階の3階へ挿入すると1・2・3・4・5・6階になり、高さは3000刻み・重複が無い', () => {
  const project = new Project('proj', 'test');
  for (let i = 1; i <= 5; i++) {
    project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`, i, 1);
  }
  const insert = computeFloorInsert(project.planes, 'p3', 1);
  assert.ok(insert);
  assert.deepEqual(insert.newPlane, { name: '4階', startFloor: 4, elevation: 9000, stories: 1, planCutHeightMm: 1500, ceilingCutHeightMm: 1500 });
  // 挿入で旧4階・5階がそれぞれ1つずつ繰り上がる
  assert.deepEqual(insert.updates, [
    { id: 'p4', name: '5階', startFloor: 5, elevation: 12000 },
    { id: 'p5', name: '6階', startFloor: 6, elevation: 15000 },
  ]);

  applyFloorInsert(project, insert.updates,
    () => project.addPlane(insert.newPlane.elevation, insert.newPlane.name, 'new', insert.newPlane.startFloor, insert.newPlane.stories));

  const startFloors = project.planes.map(p => p.startFloor);
  assert.deepEqual(startFloors, [1, 2, 3, 4, 5, 6]);
  const elevations = project.planes.map(p => p.elevation);
  assert.deepEqual(elevations, [0, 3000, 6000, 9000, 12000, 15000]);
  assert.equal(new Set(startFloors).size, startFloors.length, '同じstartFloorの階が無い');
  assert.equal(new Set(elevations).size, elevations.length, '同じelevationの階が無い');
});

// ---- 地階での上階追加（表示中の階とその下をずらす。地上階は動かさない。ユーザー裁定2026-10-01）----

test('computeFloorInsert: 地下の途中階（B2）から挿入すると、B2とそれより下（無し）だけが下へずれ、地上階（1階）は動かない', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '地下2階', 'B2', -2, 1);
  project.addPlane(3000, '地下1階', 'B1', -1, 1);
  project.addPlane(6000, '1階',    'F1', 1,  1);

  const insert = computeFloorInsert(project.planes, 'B2', 1);
  // n=1なので新階はB2の元の番号・高さをそのまま受け取る
  assert.deepEqual(insert.newPlane, { name: '地下2階', startFloor: -2, elevation: 0, stories: 1, planCutHeightMm: 1500, ceilingCutHeightMm: 1500 });
  assert.deepEqual(insert.updates, [
    { id: 'B2', name: '地下3階', startFloor: -3, elevation: -3000 },
  ]);
  applyFloorInsert(project, insert.updates,
    () => project.addPlane(insert.newPlane.elevation, insert.newPlane.name, 'newB2', insert.newPlane.startFloor, insert.newPlane.stories));

  const startFloors = project.planes.map(p => p.startFloor);
  assert.deepEqual(startFloors, [-3, -2, -1, 1]);
  assert.equal(new Set(startFloors).size, startFloors.length, '同じstartFloorの階が無い');

  const names = project.planes.map(p => p.name);
  assert.deepEqual(names, ['地下3階', '地下2階', '地下1階', '1階']);
  assert.equal(new Set(names).size, names.length, '同じ名前の階が無い');
});

test('computeFloorInsert: 地下の最上の地階（B1）から挿入すると、B1とそれより下（B2）が下へずれ、地上階（1階）は動かない', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '地下2階', 'B2', -2, 1);
  project.addPlane(3000, '地下1階', 'B1', -1, 1);
  project.addPlane(6000, '1階',    'F1', 1,  1);

  const insert = computeFloorInsert(project.planes, 'B1', 1);
  assert.deepEqual(insert.newPlane, { name: '地下1階', startFloor: -1, elevation: 3000, stories: 1, planCutHeightMm: 1500, ceilingCutHeightMm: 1500 });
  assert.deepEqual(insert.updates, [
    { id: 'B2', name: '地下3階', startFloor: -3, elevation: -3000 },
    { id: 'B1', name: '地下2階', startFloor: -2, elevation: 0 },
  ]);
  applyFloorInsert(project, insert.updates,
    () => project.addPlane(insert.newPlane.elevation, insert.newPlane.name, 'newB1', insert.newPlane.startFloor, insert.newPlane.stories));

  const startFloors = project.planes.map(p => p.startFloor);
  assert.deepEqual(startFloors, [-3, -2, -1, 1]);
  const names = project.planes.map(p => p.name);
  assert.deepEqual(names, ['地下3階', '地下2階', '地下1階', '1階']);
});

test('computeFloorInsert: 全階地下（B2・B1のみ）でB1から挿入すると、B1・B2がともに下へずれる', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '地下2階', 'B2', -2, 1);
  project.addPlane(3000, '地下1階', 'B1', -1, 1);

  const insert = computeFloorInsert(project.planes, 'B1', 1);
  assert.deepEqual(insert.newPlane, { name: '地下1階', startFloor: -1, elevation: 3000, stories: 1, planCutHeightMm: 1500, ceilingCutHeightMm: 1500 });
  assert.deepEqual(insert.updates, [
    { id: 'B2', name: '地下3階', startFloor: -3, elevation: -3000 },
    { id: 'B1', name: '地下2階', startFloor: -2, elevation: 0 },
  ]);
});

test('computeFloorInsert: 地下の途中階（B2）から一般階2階分を挿入すると、新階がstories=2で挿入され、B2は2階分下へずれる', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '地下2階', 'B2', -2, 1);
  project.addPlane(3000, '地下1階', 'B1', -1, 1);
  project.addPlane(6000, '1階',    'F1', 1,  1);

  const insert = computeFloorInsert(project.planes, 'B2', 2);
  assert.deepEqual(insert.newPlane, { name: '一般階', startFloor: -3, elevation: -3000, stories: 2, planCutHeightMm: 1500, ceilingCutHeightMm: 1500 });
  assert.deepEqual(insert.updates, [
    { id: 'B2', name: '地下4階', startFloor: -4, elevation: -6000 },
  ]);
});

// 【重大・QA指摘】複層の地階（stories>1）から追加すると新階が表示中の階と重なっていた不良の回帰防止。
// 新階は表示中の階の最上段に合わせる（newStartFloor=current最上段-(n-1)・newElevation=current.elevation+(current.stories-n)*3000）。
test('computeFloorInsert: 複層の地階（G: -3〜-2, stories2）から挿入すると、新階はGの最上段(-2,3000)に重ならず、Gは最上段基準で下へずれる', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '一般階', 'G', -3, 2); // -3・-2の2階分（最上段は-2）
  project.addPlane(6000, '地下1階', 'B1', -1, 1);
  project.addPlane(9000, '1階',    'F1', 1,  1);

  const insert = computeFloorInsert(project.planes, 'G', 1);
  assert.deepEqual(insert.newPlane, { name: '地下2階', startFloor: -2, elevation: 3000, stories: 1, planCutHeightMm: 1500, ceilingCutHeightMm: 1500 });
  assert.deepEqual(insert.updates, [
    { id: 'G', name: '一般階', startFloor: -4, elevation: -3000 }, // Gの最上段は-3(旧-2から1つ下)
  ]);
  const touchedIds = insert.updates.map(u => u.id);
  assert.ok(!touchedIds.includes('B1'), 'B1（地階より上）が更新一覧に含まれている');
  assert.ok(!touchedIds.includes('F1'), '1階（地上階）が更新一覧に含まれている');

  // 全階の[startFloor, startFloor+stories-1]の範囲が互いに重ならない
  applyFloorInsert(project, insert.updates,
    () => project.addPlane(insert.newPlane.elevation, insert.newPlane.name, 'newB2', insert.newPlane.startFloor, insert.newPlane.stories));
  const ranges = project.planes.map(p => [p.startFloor, p.startFloor + p.stories - 1]);
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const overlap = ranges[i][0] <= ranges[j][1] && ranges[j][0] <= ranges[i][1];
      assert.ok(!overlap, `range ${ranges[i]} と ${ranges[j]} が重なっている`);
    }
  }
});

// 【失敗系】地階挿入で地上階（B1・1階）はupdatesに含まれない（上の階は触らない）
test('【失敗系】computeFloorInsert: 地階挿入では地階より上の採用階（B1・1階）はupdatesに含まれない', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '地下2階', 'B2', -2, 1);
  project.addPlane(3000, '地下1階', 'B1', -1, 1);
  project.addPlane(6000, '1階',    'F1', 1,  1);

  const insert = computeFloorInsert(project.planes, 'B2', 1);
  const touchedIds = insert.updates.map(u => u.id);
  assert.ok(!touchedIds.includes('B1'), 'B1（地階より上）が更新一覧に含まれている');
  assert.ok(!touchedIds.includes('F1'), '1階（地上階）が更新一覧に含まれている');
});

// 【対照】地上階（3階建ての2階）からの挿入は現行どおり上をずらし、下は触らない（地階分岐の対照）
test('【対照】computeFloorInsert: 地上階（2階）からの挿入は上（3階）をずらし、下（1階）は触らない', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'F1', 1, 1);
  project.addPlane(3000, '2階', 'F2', 2, 1);
  project.addPlane(6000, '3階', 'F3', 3, 1);

  const insert = computeFloorInsert(project.planes, 'F2', 1);
  assert.deepEqual(insert.newPlane, { name: '3階', startFloor: 3, elevation: 6000, stories: 1, planCutHeightMm: 1500, ceilingCutHeightMm: 1500 });
  assert.deepEqual(insert.updates, [
    { id: 'F3', name: '4階', startFloor: 4, elevation: 9000 },
  ]);
  const touchedIds = insert.updates.map(u => u.id);
  assert.ok(!touchedIds.includes('F1'), '1階（挿入位置より下）が更新一覧に含まれている');
});

// applyFloorInsertの順序（上の階をずらしてから新階を足す）を地階版でも固定する。
// B1は挿入前の高さ(3000)が新階の高さ(3000)と同じ——addNewFloor呼出し時点でB1がすでに
// 旧B2の位置(0)へずれていること（新階の高さと一瞬でも重ならないこと）も確認する。
test('applyFloorInsert（地階版）: addNewFloor が呼ばれた時点で既存のB2・B1はすでに下へずれている（新階の高さと重ならない）', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '地下2階', 'B2', -2, 1);
  project.addPlane(3000, '地下1階', 'B1', -1, 1);
  const insert = computeFloorInsert(project.planes, 'B1', 1);

  let b2ElevationDuringAdd = null;
  let b1ElevationDuringAdd = null;
  applyFloorInsert(project, insert.updates, () => {
    b2ElevationDuringAdd = project.planeMap.get('B2').elevation;
    b1ElevationDuringAdd = project.planeMap.get('B1').elevation;
    return project.addPlane(insert.newPlane.elevation, insert.newPlane.name, 'newB1', insert.newPlane.startFloor, insert.newPlane.stories);
  });

  assert.equal(b2ElevationDuringAdd, -3000, '新階を足す前に既存のB2はすでに-3000へずれている必要がある');
  assert.equal(b1ElevationDuringAdd, 0, '新階を足す前に既存のB1（旧3000＝新階と同じ高さだった階）はすでに0へずれている必要がある');
  const elevations = project.planes.map(p => p.elevation);
  assert.equal(new Set(elevations).size, elevations.length, '同じelevationの階が一瞬も並ばない');
});

test('【失敗系】computeFloorInsert: 表示中の階が最上階なら updates は空配列で、newPlane は従来の上階追加と同じ計算', () => {
  const project = new Project('proj', 'test');
  for (let i = 1; i <= 3; i++) project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`, i, 1);
  const insert = computeFloorInsert(project.planes, 'p3', 1);
  assert.deepEqual(insert.updates, []);
  assert.deepEqual(insert.newPlane, { name: '4階', startFloor: 4, elevation: 9000, stories: 1, planCutHeightMm: 1500, ceilingCutHeightMm: 1500 });
});

test('【失敗系】computeFloorInsert: currentPlaneId が未検出なら null', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  assert.equal(computeFloorInsert(project.planes, 'zzz', 1), null);
});

test('【失敗系】applyFloorInsert: addNewFloor が投げたら、updates を書く前の全Planeメタへ戻してから再throwする', () => {
  const project = new Project('proj', 'test');
  for (let i = 1; i <= 3; i++) project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`, i, 1);
  const before = collectPlaneMetas(project);
  const insert = computeFloorInsert(project.planes, 'p2', 1); // p3が繰り上がるはず
  assert.ok(insert.updates.length > 0);

  assert.throws(() => applyFloorInsert(project, insert.updates, () => { throw new Error('boom'); }), /boom/);

  assert.deepEqual(collectPlaneMetas(project), before, 'updatesを書く前の全Planeメタに戻っている');
});

// QA指摘2: 変異（updatesを書く前にaddNewFloorを呼んでしまう＝順序の入替え）を検出する。
// 「上の階をずらしてから新階を足す」順序なので、addNewFloorのコールバックが走る時点で
// 既存の上階はもうずれている（同じ高さが一瞬でも並ばない）はず。
test('applyFloorInsert: addNewFloor が呼ばれた時点で既存の上階はすでにずれている（上→新の順序）', () => {
  const project = new Project('proj', 'test');
  for (let i = 1; i <= 5; i++) project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`, i, 1);
  const insert = computeFloorInsert(project.planes, 'p3', 1);

  let p4ElevationDuringAdd = null;
  applyFloorInsert(project, insert.updates, () => {
    p4ElevationDuringAdd = project.planeMap.get('p4').elevation;
    return project.addPlane(insert.newPlane.elevation, insert.newPlane.name, 'new', insert.newPlane.startFloor, insert.newPlane.stories);
  });

  assert.equal(p4ElevationDuringAdd, 12000, '新階を足す前に既存の上階（p4）はすでに12000へずれている必要がある');
  const elevations = project.planes.map(p => p.elevation);
  assert.equal(new Set(elevations).size, elevations.length, '同じelevationの階が一瞬も並ばない');
});

// QA指摘3: 変異（振り直しの基準を常にindex1に固定する等）で、挿入位置より下の既存階まで
// 触ってしまうのを検出する。下の階の値が規則から外れていても（不整合データでも）触らないことを確認する。
test('computeFloorInsert: 挿入位置より下の階は、規則から外れていても触らない', () => {
  const planes = [
    { id: 'p1', startFloor: 1, stories: 1, elevation: 500,  name: '1階' },     // 規則から外れた仮値
    { id: 'p2', startFloor: 2, stories: 1, elevation: 3000, name: '中2階' },   // 規則から外れた仮値
    { id: 'p3', startFloor: 3, stories: 1, elevation: 6000, name: '3階' },
  ];
  const insert = computeFloorInsert(planes, 'p3', 1);
  const touchedIds = insert.updates.map(u => u.id);
  assert.ok(!touchedIds.includes('p1'), 'p1（挿入位置より下）が更新一覧に含まれている');
  assert.ok(!touchedIds.includes('p2'), 'p2（挿入位置より下）が更新一覧に含まれている');
});

// §5-5相当: undo/redoでPlaneメタがbefore/afterへ戻る（App.jsxのwithFloorOpUndoが
// collectPlaneMetas/applyPlaneMetasを使う組み立てをfloorOps単体で固定する）。
test('挿入→undo相当（removePlane＋applyPlaneMetas(before)）→redo相当（applyPlaneMetas(after)＋addPlane）でメタがbefore/afterと一致する', () => {
  const project = new Project('proj', 'test');
  for (let i = 1; i <= 5; i++) project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`, i, 1);
  const before = collectPlaneMetas(project);

  const insert = computeFloorInsert(project.planes, 'p3', 1);
  const newId = 'new';
  applyFloorInsert(project, insert.updates,
    () => project.addPlane(insert.newPlane.elevation, insert.newPlane.name, newId, insert.newPlane.startFloor, insert.newPlane.stories));
  const after = collectPlaneMetas(project);
  assert.ok(after.some(m => m.id === newId), '挿入直後は新階がメタに含まれる');

  // undo相当: 新階を削除し、全採用階のメタをbeforeへ戻す
  project.removePlane(newId);
  applyPlaneMetas(project, before);
  assert.deepEqual(collectPlaneMetas(project), before, 'undo相当でbeforeと一致する');
  assert.equal(project.planeMap.has(newId), false, '新階が消えている');

  // redo相当: 全採用階のメタをafterへ先に戻してから、同じidで新階を作り直す
  applyPlaneMetas(project, after);
  project.addPlane(insert.newPlane.elevation, insert.newPlane.name, newId, insert.newPlane.startFloor, insert.newPlane.stories);
  assert.deepEqual(collectPlaneMetas(project), after, 'redo相当でafterと一致する');
});

// ---- collectPlaneMetas / applyPlaneMetas（階操作のundo/redoが使う全採用階メタの往復。ステップ2）----

test('collectPlaneMetas / applyPlaneMetas: 採ったメタを書き戻すと元に戻る（往復で一致）', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  const before = collectPlaneMetas(project);

  const p2 = project.planeMap.get('p2');
  p2.name = '書き換え後';
  p2.startFloor = 99;
  p2.elevation = 12345;
  p2.stories = 3;

  applyPlaneMetas(project, before);
  assert.equal(p2.name, '2階');
  assert.equal(p2.startFloor, 2);
  assert.equal(p2.elevation, 3000);
  assert.equal(p2.stories, 1);
});

test('【失敗系】applyPlaneMetas: project.planeMap に存在しない id は無視する（削除済み階のメタが残っていても落ちない）', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  const metas = [
    { id: 'p1', name: '1階', startFloor: 1, elevation: 0, stories: 1 },
    { id: 'gone', name: '消えた階', startFloor: 2, elevation: 3000, stories: 1 },
  ];
  assert.doesNotThrow(() => applyPlaneMetas(project, metas));
  assert.equal(project.planeMap.get('p1').name, '1階');
  assert.equal(project.planeMap.has('gone'), false);
});

// ---- 平面の切断高（S1。階の属性 planCutHeightMm）----

function makeThreeFloorsWithCutHeights() {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  project.planeMap.get('p1').planCutHeightMm = 1100;
  project.planeMap.get('p2').planCutHeightMm = 1200;
  project.planeMap.get('p3').planCutHeightMm = 1300;
  return project;
}

test('collectPlaneMetas / applyPlaneMetas: planCutHeightMm が往復する（3階建て・階ごとに別値）', () => {
  const project = makeThreeFloorsWithCutHeights();
  const before = collectPlaneMetas(project);
  assert.deepEqual(before.map(m => m.planCutHeightMm), [1100, 1200, 1300]);
  project.planeMap.get('p2').planCutHeightMm = 900;
  applyPlaneMetas(project, before);
  assert.equal(project.planeMap.get('p2').planCutHeightMm, 1200);
});

test('applyPlaneMetas: planCutHeightMm が undefined のエントリでは切断高を触らない', () => {
  const project = makeThreeFloorsWithCutHeights();
  applyPlaneMetas(project, [{ id: 'p2', name: '2階', startFloor: 2, elevation: 3000 }]);
  assert.equal(project.planeMap.get('p2').planCutHeightMm, 1200);
});

test('diffFloorOpSnapshot: 切断高だけの変化も metasChanged になる', () => {
  const project = makeThreeFloorsWithCutHeights();
  const metasBefore = collectPlaneMetas(project);
  project.planeMap.get('p3').planCutHeightMm = 1400;
  const d = diffFloorOpSnapshot({ before: new Map(), after: new Map(), metasBefore, metasAfter: collectPlaneMetas(project) });
  assert.equal(d.metasChanged, true);
});

test('computeFloorInsert: 新階は表示中の階の切断高を複製する（途中階 p2・地下の分岐も）', () => {
  const project = makeThreeFloorsWithCutHeights();
  assert.equal(computeFloorInsert(project.planes, 'p2', 1).newPlane.planCutHeightMm, 1200);
  const b = new Project('proj', 'test');
  b.addPlane(0, '地下2階', 'B2', -2, 1);
  b.addPlane(3000, '地下1階', 'B1', -1, 1);
  b.addPlane(6000, '1階', 'F1', 1, 1);
  b.planeMap.get('B2').planCutHeightMm = 1000;
  assert.equal(computeFloorInsert(b.planes, 'B2', 1).newPlane.planCutHeightMm, 1000);
});

test('setPlanCutHeightMm: 変更すると { before, after } を返し、同値・不正値・未検出 plane は null で何も変えない', () => {
  const project = makeThreeFloorsWithCutHeights();
  assert.deepEqual(setPlanCutHeightMm(project, 'p2', 1000), { before: 1200, after: 1000 });
  assert.equal(project.planeMap.get('p2').planCutHeightMm, 1000);
  assert.equal(setPlanCutHeightMm(project, 'p2', 1000), null);
  for (const bad of [0, -5, NaN, Infinity, undefined]) {
    assert.equal(setPlanCutHeightMm(project, 'p2', bad), null);
  }
  assert.equal(setPlanCutHeightMm(project, 'gone', 1000), null);
  assert.equal(project.planeMap.get('p2').planCutHeightMm, 1000);
  assert.equal(project.planeMap.get('p1').planCutHeightMm, 1100); // 他階は不変
});

// ---- 天伏の切断高（ceilingCutHeightMm。planCutHeightMm と同型）----

function makeThreeFloorsWithCeilingCutHeights() {
  const project = makeThreeFloorsWithCutHeights();
  project.planeMap.get('p1').ceilingCutHeightMm = 2100;
  project.planeMap.get('p2').ceilingCutHeightMm = 2200;
  project.planeMap.get('p3').ceilingCutHeightMm = 2300;
  return project;
}

test('collectPlaneMetas / applyPlaneMetas: ceilingCutHeightMm が往復する（平面の切断高とは独立）', () => {
  const project = makeThreeFloorsWithCeilingCutHeights();
  const before = collectPlaneMetas(project);
  assert.deepEqual(before.map(m => m.ceilingCutHeightMm), [2100, 2200, 2300]);
  assert.deepEqual(before.map(m => m.planCutHeightMm), [1100, 1200, 1300]);
  project.planeMap.get('p2').ceilingCutHeightMm = 900;
  applyPlaneMetas(project, before);
  assert.equal(project.planeMap.get('p2').ceilingCutHeightMm, 2200);
});

test('applyPlaneMetas: ceilingCutHeightMm が undefined のエントリでは天伏の切断高を触らない（平面の切断高だけ書いても同様）', () => {
  const project = makeThreeFloorsWithCeilingCutHeights();
  applyPlaneMetas(project, [{ id: 'p2', name: '2階', startFloor: 2, elevation: 3000 }]);
  assert.equal(project.planeMap.get('p2').ceilingCutHeightMm, 2200);
  applyPlaneMetas(project, [{ id: 'p2', name: '2階', startFloor: 2, elevation: 3000, planCutHeightMm: 800 }]);
  assert.equal(project.planeMap.get('p2').ceilingCutHeightMm, 2200);
  assert.equal(project.planeMap.get('p2').planCutHeightMm, 800);
});

test('diffFloorOpSnapshot: 天伏の切断高だけの変化も metasChanged になる', () => {
  const project = makeThreeFloorsWithCeilingCutHeights();
  const metasBefore = collectPlaneMetas(project);
  project.planeMap.get('p3').ceilingCutHeightMm = 2400;
  const d = diffFloorOpSnapshot({ before: new Map(), after: new Map(), metasBefore, metasAfter: collectPlaneMetas(project) });
  assert.equal(d.metasChanged, true);
});

test('computeFloorInsert: 新階は表示中の階の天伏の切断高を複製する（途中階 p2・地下の分岐も）', () => {
  const project = makeThreeFloorsWithCeilingCutHeights();
  assert.equal(computeFloorInsert(project.planes, 'p2', 1).newPlane.ceilingCutHeightMm, 2200);
  const b = new Project('proj', 'test');
  b.addPlane(0, '地下2階', 'B2', -2, 1);
  b.addPlane(3000, '地下1階', 'B1', -1, 1);
  b.addPlane(6000, '1階', 'F1', 1, 1);
  b.planeMap.get('B2').ceilingCutHeightMm = 1900;
  assert.equal(computeFloorInsert(b.planes, 'B2', 1).newPlane.ceilingCutHeightMm, 1900);
});

test('setCeilingCutHeightMm: 変更すると { before, after } を返し、undo/redo の往復ができる。同値・不正値・未検出 plane は null で何も変えない。平面の切断高は不変', () => {
  const project = makeThreeFloorsWithCeilingCutHeights();
  const changed = setCeilingCutHeightMm(project, 'p2', 1000);
  assert.deepEqual(changed, { before: 2200, after: 1000 });
  assert.equal(project.planeMap.get('p2').ceilingCutHeightMm, 1000);
  assert.equal(project.planeMap.get('p2').planCutHeightMm, 1200, '平面の切断高は不変');
  setCeilingCutHeightMm(project, 'p2', changed.before); // undo
  assert.equal(project.planeMap.get('p2').ceilingCutHeightMm, 2200);
  setCeilingCutHeightMm(project, 'p2', changed.after); // redo
  assert.equal(project.planeMap.get('p2').ceilingCutHeightMm, 1000);
  assert.equal(setCeilingCutHeightMm(project, 'p2', 1000), null);
  for (const bad of [0, -5, NaN, Infinity, undefined]) {
    assert.equal(setCeilingCutHeightMm(project, 'p2', bad), null);
  }
  assert.equal(setCeilingCutHeightMm(project, 'gone', 1000), null);
  assert.equal(project.planeMap.get('p2').ceilingCutHeightMm, 1000);
  assert.equal(project.planeMap.get('p1').ceilingCutHeightMm, 2100); // 他階は不変
});

// ---- ステップ1: renumberPlanesFrom（振り直しの純関数）----

function makeFourFloors() {
  return [
    { id: 'a', startFloor: 1, stories: 1, elevation: 0,     name: '1階' },
    { id: 'b', startFloor: 2, stories: 1, elevation: 3000,  name: '2階' },
    { id: 'c', startFloor: 3, stories: 1, elevation: 6000,  name: '3階' },
    { id: 'd', startFloor: 4, stories: 1, elevation: 9000,  name: '4階' },
  ];
}

test('renumberPlanesFrom: 変化しない階（全階を1つずつ上へ差し込む前提無し）は空配列——同一配列を渡すとno-op', () => {
  const planes = makeFourFloors();
  assert.deepEqual(renumberPlanesFrom(planes, 2), []);
});

test('renumberPlanesFrom: fromIndex以降で値が変わる階だけを返す（挿入直後の未振り直し階を模す）', () => {
  // 挿入直後、xだけがまだ振り直されていない（1階の直後にx=9階が差し込まれ、
  // 以降のc・dは「振り直せばたまたま元と同じ値になる」位置に置かれている形を模す）。
  const planes = [
    { id: 'a', startFloor: 1, stories: 1, elevation: 0,    name: '1階' },
    { id: 'x', startFloor: 9, stories: 1, elevation: 99000, name: '9階' }, // 挿入直後でまだ振っていない階
    { id: 'c', startFloor: 3, stories: 1, elevation: 6000,  name: '3階' },
    { id: 'd', startFloor: 4, stories: 1, elevation: 9000,  name: '4階' },
  ];
  const updates = renumberPlanesFrom(planes, 1);
  // xはstartFloor9→2・elevation99000→3000・name9階→2階と変化するが、
  // c・dは振り直し後も元の値（3階/6000・4階/9000）と一致するため「変化する階のみ」から除外される。
  assert.deepEqual(updates, [
    { id: 'x', name: '2階', startFloor: 2, elevation: 3000 },
  ]);
});

test('renumberPlanesFrom: 0階を飛ばす（B1の直後はF1でなく地下側をまたがない限りaddSkipZeroに従う）', () => {
  const planes = [
    { id: 'a', startFloor: -2, stories: 1, elevation: 0,    name: '地下2階' },
    { id: 'b', startFloor: -5, stories: 1, elevation: 3000, name: '地下5階' }, // 未振り直しの仮値
  ];
  const updates = renumberPlanesFrom(planes, 1);
  assert.deepEqual(updates, [
    { id: 'b', name: '地下1階', startFloor: -1, elevation: 3000 },
  ]);
});

test('renumberPlanesFrom: stories>1の階名はmakeFloorName、それ以外はrenameFloorで書式を保つ', () => {
  const planes = [
    { id: 'a', startFloor: 1, stories: 1, elevation: 0,    name: '1階' },
    { id: 'b', startFloor: 9, stories: 3, elevation: 99000, name: '一般階' }, // 未振り直しの仮値
  ];
  const updates = renumberPlanesFrom(planes, 1);
  assert.deepEqual(updates, [
    { id: 'b', name: '一般階', startFloor: 2, elevation: 3000 },
  ]);
});

test('renumberPlanesFrom: fromIndexが末尾（範囲外）なら空配列', () => {
  const planes = makeFourFloors();
  assert.deepEqual(renumberPlanesFrom(planes, 4), []);
  assert.deepEqual(renumberPlanesFrom(planes, 10), []);
});

test('【失敗系】renumberPlanesFrom: planesが空・1件・fromIndexが負なら空配列', () => {
  assert.deepEqual(renumberPlanesFrom([], 1), []);
  assert.deepEqual(renumberPlanesFrom([makeFourFloors()[0]], 1), []);
  assert.deepEqual(renumberPlanesFrom(makeFourFloors(), -1), renumberPlanesFrom(makeFourFloors(), 0));
});

// ---- ステップ1: 階削除の振り直し（computeFloorDeleteReorder）。旧App.jsxインラインループと同じ結果----
// 旧ループ: anchor=newAdopted[idx-1]??newAdopted[0]、start=anchorがnewAdopted[idx-1]ならidx、
// そうでなければidx+1（削除位置が先頭のとき）。

test('computeFloorDeleteReorder: 中間削除（1,2,3,4階からb=2階を削除）→ c,dが1つずつ繰り上がる（旧ループと同じ結果）', () => {
  // 削除前: a(1,0) b(2,3000) c(3,6000) d(4,9000)。bを削除した後の配列（旧idx=1）。
  const afterRemoval = [
    { id: 'a', startFloor: 1, stories: 1, elevation: 0,    name: '1階' },
    { id: 'c', startFloor: 3, stories: 1, elevation: 6000, name: '3階' },
    { id: 'd', startFloor: 4, stories: 1, elevation: 9000, name: '4階' },
  ];
  const updates = computeFloorDeleteReorder(afterRemoval, 1);
  assert.deepEqual(updates, [
    { id: 'c', name: '2階', startFloor: 2, elevation: 3000 },
    { id: 'd', name: '3階', startFloor: 3, elevation: 6000 },
  ]);
});

test('computeFloorDeleteReorder: 先頭削除（1階=aを削除）→ 旧ループでは新しい最下階(b)は自身の番号を保ち、以降も変化しない', () => {
  // 削除前: a(1,0) b(2,3000) c(3,6000) d(4,9000)。aを削除した後の配列（旧idx=0）。
  const afterRemoval = [
    { id: 'b', startFloor: 2, stories: 1, elevation: 3000, name: '2階' },
    { id: 'c', startFloor: 3, stories: 1, elevation: 6000, name: '3階' },
    { id: 'd', startFloor: 4, stories: 1, elevation: 9000, name: '4階' },
  ];
  // 旧ループ: anchor=newAdopted[-1]??newAdopted[0]=b（自身）。start=idx+1=1。
  // b自身は据え置き、c・dもbの元の値から導くと元の値と一致するため変化なし。
  const updates = computeFloorDeleteReorder(afterRemoval, 0);
  assert.deepEqual(updates, []);
});

test('computeFloorDeleteReorder: 末尾削除（最上階=dを削除）→ 削除位置が末尾なら空配列（旧ループのidx<newAdopted.lengthガードと同じ）', () => {
  // 削除前: a(1,0) b(2,3000) c(3,6000) d(4,9000)。dを削除した後の配列（旧idx=3）。
  const afterRemoval = [
    { id: 'a', startFloor: 1, stories: 1, elevation: 0,    name: '1階' },
    { id: 'b', startFloor: 2, stories: 1, elevation: 3000, name: '2階' },
    { id: 'c', startFloor: 3, stories: 1, elevation: 6000, name: '3階' },
  ];
  assert.deepEqual(computeFloorDeleteReorder(afterRemoval, 3), []);
});

// QA指摘3（削除側）: 変異（振り直しの基準を常にindex1に固定する等）で、削除位置より下の
// 既存階まで触ってしまうのを検出する。下の階（a）の値が規則から外れていても触らないことを確認する。
test('computeFloorDeleteReorder: 削除位置より下の階（a）は、規則から外れていても触らない', () => {
  const afterRemoval = [
    { id: 'a', startFloor: 1, stories: 1, elevation: 500,  name: '1階' },   // 規則から外れた仮値
    { id: 'c', startFloor: 3, stories: 1, elevation: 6000, name: '3階' },
    { id: 'd', startFloor: 4, stories: 1, elevation: 9000, name: '4階' },
  ];
  const updates = computeFloorDeleteReorder(afterRemoval, 1); // bを削除した後（旧idx=1）
  const touchedIds = updates.map(u => u.id);
  assert.ok(!touchedIds.includes('a'), 'a（削除位置より下）が更新一覧に含まれている');
});

// ---- ステップ4: diffFloorOpSnapshot（階操作のundoに積むべき差分。App.jsxのwithFloorOpUndoが使う）----

function metasFromPlanes(planes) {
  return planes.map(p => ({ id: p.id, name: p.name, startFloor: p.startFloor, elevation: p.elevation, stories: p.stories }));
}

test('diffFloorOpSnapshot: 追加階があれば addedPlanes に入り、hasChanges は true（挿入相当）', () => {
  const metasBefore = metasFromPlanes(makeFourFloors());
  const before = new Map(metasBefore.map(m => [m.id, new Uint8Array([1])]));
  const after  = new Map(before);
  after.set('new', new Uint8Array([9]));
  const metasAfter = [...metasBefore, { id: 'new', name: '5階', startFloor: 5, elevation: 12000, stories: 1 }];

  const result = diffFloorOpSnapshot({ before, after, metasBefore, metasAfter });
  assert.deepEqual(result.addedPlanes, [{ id: 'new', name: '5階', startFloor: 5, elevation: 12000, stories: 1 }]);
  assert.deepEqual(result.changedSiblings, []);
  assert.equal(result.metasChanged, true, 'metasAfterの件数が増えているのでmetasChangedもtrue');
  assert.equal(result.hasChanges, true);
});

test('diffFloorOpSnapshot: 追加階が無くてもPlaneメタだけ変化していれば hasChanges は true（ドラッグ移動・階変更相当）', () => {
  const planes = makeFourFloors();
  const metasBefore = metasFromPlanes(planes);
  const before = new Map(metasBefore.map(m => [m.id, new Uint8Array([1])]));
  const after  = new Map(before); // bytesは変化しない（メタの書換えだけ）
  const metasAfter = metasBefore.map(m => (m.id === 'b' ? { ...m, name: '5階', startFloor: 5, elevation: 12000 } : m));

  const result = diffFloorOpSnapshot({ before, after, metasBefore, metasAfter });
  assert.deepEqual(result.addedPlanes, [], '追加階は無い');
  assert.deepEqual(result.changedSiblings, [], 'bytesは変化していない');
  assert.equal(result.metasChanged, true);
  assert.equal(result.hasChanges, true, 'メタだけの変化でもhasChangesはtrueである必要がある（旧来はaddedPlanesのみで判定していた）');
});

test('diffFloorOpSnapshot: メタ不変でもbytesだけ変化していれば changedSiblings に入り hasChanges は true', () => {
  const metasBefore = metasFromPlanes(makeFourFloors());
  const metasAfter  = metasBefore; // メタは不変
  const before = new Map(metasBefore.map(m => [m.id, new Uint8Array([1])]));
  const after  = new Map(before);
  after.set('c', new Uint8Array([2])); // cのbytesだけ変化（同期・自動補完等）

  const result = diffFloorOpSnapshot({ before, after, metasBefore, metasAfter });
  assert.deepEqual(result.addedPlanes, []);
  assert.deepEqual(result.changedSiblings, [{ planeId: 'c', before: before.get('c'), after: after.get('c') }]);
  assert.equal(result.metasChanged, false);
  assert.equal(result.hasChanges, true);
});

test('【失敗系】diffFloorOpSnapshot: 追加・メタ・bytesのいずれも変化が無ければ hasChanges は false（undoを積まない）', () => {
  const metasBefore = metasFromPlanes(makeFourFloors());
  const metasAfter  = metasBefore;
  const before = new Map(metasBefore.map(m => [m.id, new Uint8Array([1])]));
  const after  = new Map(before);

  const result = diffFloorOpSnapshot({ before, after, metasBefore, metasAfter });
  assert.deepEqual(result.addedPlanes, []);
  assert.deepEqual(result.changedSiblings, []);
  assert.equal(result.metasChanged, false);
  assert.equal(result.hasChanges, false);
});

test('【失敗系】diffFloorOpSnapshot: IDB未保存（bytesがnull）の階が変化してもnull同士は等しいとみなされ変化扱いにしない', () => {
  const metasBefore = metasFromPlanes(makeFourFloors());
  const metasAfter  = metasBefore;
  const before = new Map(metasBefore.map(m => [m.id, null]));
  const after  = new Map(before); // 両方ともIDB未保存のまま

  const result = diffFloorOpSnapshot({ before, after, metasBefore, metasAfter });
  assert.deepEqual(result.changedSiblings, []);
  assert.equal(result.hasChanges, false);
});
