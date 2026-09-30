import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorBytesEqual, computeFloorReorder, computeFloorChangeReorder, computeAltReorder, resolveChipReorderTarget,
  reconcilePlanes, blocksFloorRemoval, renumberPlanesFrom, computeFloorDeleteReorder,
  computeFloorInsert, applyFloorInsert, collectPlaneMetas, applyPlaneMetas,
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
  assert.deepEqual(insert.newPlane, { name: '4階', startFloor: 4, elevation: 9000, stories: 1 });
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

test('computeFloorInsert: 地下の途中階（B2）から挿入してもB1が2つにならない（B2・B1・1階・2階に振り直る）', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '地下2階', 'B2', -2, 1);
  project.addPlane(3000, '地下1階', 'B1', -1, 1);
  project.addPlane(6000, '1階',    'F1', 1,  1);

  const insert = computeFloorInsert(project.planes, 'B2', 1);
  assert.deepEqual(insert.newPlane, { name: '地下1階', startFloor: -1, elevation: 3000, stories: 1 });
  applyFloorInsert(project, insert.updates,
    () => project.addPlane(insert.newPlane.elevation, insert.newPlane.name, 'newB1', insert.newPlane.startFloor, insert.newPlane.stories));

  const startFloors = project.planes.map(p => p.startFloor);
  assert.deepEqual(startFloors, [-2, -1, 1, 2]);
  assert.equal(new Set(startFloors).size, startFloors.length, '同じstartFloorの階が無い');

  // QA指摘: 符号またぎ（地下→地上）でrenameFloorが部分一致し「地下1階」が2つ残っていた不良の回帰防止
  const names = project.planes.map(p => p.name);
  assert.deepEqual(names, ['地下2階', '地下1階', '1階', '2階']);
  assert.equal(new Set(names).size, names.length, '同じ名前の階が無い');
});

test('【失敗系】computeFloorInsert: 表示中の階が最上階なら updates は空配列で、newPlane は従来の上階追加と同じ計算', () => {
  const project = new Project('proj', 'test');
  for (let i = 1; i <= 3; i++) project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`, i, 1);
  const insert = computeFloorInsert(project.planes, 'p3', 1);
  assert.deepEqual(insert.updates, []);
  assert.deepEqual(insert.newPlane, { name: '4階', startFloor: 4, elevation: 9000, stories: 1 });
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

// §5-5相当: undo/redoでPlaneメタがbefore/afterへ戻る（App.jsxのwithFloorAddUndoが
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
