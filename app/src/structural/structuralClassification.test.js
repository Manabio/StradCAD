// structuralClassification.js の単体テスト。memberKindOf（ステップC2a: 小屋梁 role:'roofBeam' は表A対象外）と、
// C 節＝同一平面の複数スロット（基礎伏図／1階伏図）での見せ分け。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  memberKindOf, MEMBER_KIND, STRUCTURES, structureHasMemberKind,
  FIGURE_TYPE, SLOT_TYPE, slotPresent,
  SHARED_PLANE_MEMBER_OVERRIDES, resolveSharedPlaneView,
  sharedPlaneDrawsKind, sharedPlaneDrawsMember, sharedPlaneListsMember, sharedPlaneDrawsRoofFraming,
} from './structuralClassification.js';
import { buildStructuralFigureSlots } from './structuralFigureSlots.js';

test('【C2a】memberKindOf: 小屋梁(roofBeam)・軒桁(eaves)・屋根架構(roof)は表A対象外(null)＝ゲートしない', () => {
  for (const role of ['roofBeam', 'eaves', 'roof']) {
    assert.equal(memberKindOf('beamMap', { role }), null, `role:${role}`);
  }
});

test('【C2a】memberKindOf: 既存の梁roleの分類は不変（基礎梁=FOUNDATION_BEAM、それ以外=BEAM）', () => {
  assert.equal(memberKindOf('beamMap', { role: 'foundation' }), MEMBER_KIND.FOUNDATION_BEAM);
  for (const role of ['primary', 'secondary', 'floor', 'landing', 'sill']) {
    assert.equal(memberKindOf('beamMap', { role }), MEMBER_KIND.BEAM, `role:${role}`);
  }
});

test('【C2a】失敗系: 表Aで梁が×の主構造（RC造(壁式)・木造2×4）でも、小屋梁は null のため構造ゲートの削除対象にならない（secondaryは×で削除対象）', () => {
  const noBeam = STRUCTURES.filter(s => !structureHasMemberKind(MEMBER_KIND.BEAM, s));
  assert.ok(noBeam.length > 0, '梁が×の主構造が表Aに存在する（このテストの前提）');
  for (const s of noBeam) {
    assert.equal(structureHasMemberKind(memberKindOf('beamMap', { role: 'secondary' }), s), false, `${s}: 小梁は×`);
    // null（表外）は呼び出し側（deleteClassificationOverflow）が「!kind なら保持」で扱う
    assert.equal(memberKindOf('beamMap', { role: 'roofBeam' }), null);
  }
});

// ---------------------------------------------------------------
// C. 同一平面の複数スロットでの見せ分け
// ---------------------------------------------------------------

// 最小の project 相当（buildStructuralFigureSlots が読む: structuralInfo.mainStructure・planes[].{id,startFloor,name}・roofPlane）。
function makeProject(mainStructure, startFloors = [1, 2]) {
  const planes = startFloors.map((sf, i) => ({ id: `p${i}`, startFloor: sf, name: `f${sf}` }));
  return { structuralInfo: { mainStructure }, planes, roofPlane: { id: 'roof', startFloor: 99, name: 'R' } };
}
const slotOf = (slots, slotType) => slots.find(s => s.slotType === slotType);
const woodStructures = () => STRUCTURES.filter(s => slotPresent(SLOT_TYPE.GROUND_FLOOR, s));

// 2 つの視点（木造の基礎伏図・1階伏図）を実物のスロット列から作る。
function makeViews() {
  const wood = woodStructures()[0];
  const slots = buildStructuralFigureSlots(makeProject(wood));
  const f = slotOf(slots, SLOT_TYPE.FOUNDATION);
  const g = slotOf(slots, SLOT_TYPE.GROUND_FLOOR);
  return {
    slots,
    fView: resolveSharedPlaneView(f, slots, f.planeId),
    gView: resolveSharedPlaneView(g, slots, g.planeId),
  };
}

// [名前, mapName, entity, 基礎で描く, 1階で描く, 基礎でリスト, 1階でリスト]
const T = true, F = false;
const SHARED_TABLE = [
  ['基礎梁',             'beamMap',    { role: 'foundation' }, T, F, T, F],
  ['土台',               'beamMap',    { role: 'sill' },       F, F, T, F],
  ['柱',                 'columnMap',  { role: 'primary' },    F, T, F, T],
  ['柱(roleなし)',       'columnMap',  {},                     F, T, F, T],
  ['独立フーチング',     'footingMap', {},                     T, F, T, F],
  ['柱脚',               'footingMap', { baseType: 'x' },      T, F, T, F],
  ['マットスラブ',       'slabMap',    { role: 'mat_foundation' }, T, F, T, F],
  ['一般スラブ',         'slabMap',    { role: 'slab' },       F, T, F, T],
  ['屋根面スラブ',       'slabMap',    { role: 'roof_panel' }, F, T, F, T],
  ['壁',                 'wallMap',    {},                     F, T, F, T],
  ['大梁',               'beamMap',    { role: 'primary' },    F, T, F, T],
  ['小梁',               'beamMap',    { role: 'secondary' },  F, T, F, T],
  ['床梁',               'beamMap',    { role: 'floor' },      F, T, F, T],
  ['杭(柱グループと同じ図)', 'columnMap', { role: 'foundation' }, F, T, F, T],
  ['軒桁(表A対象外)',    'beamMap',    { role: 'eaves' },      T, T, T, T],
  ['屋根架構(表A対象外)', 'beamMap',   { role: 'roof' },       T, T, T, T],
  ['小屋梁(例外表で1階伏図)', 'beamMap', { role: 'roofBeam' }, F, T, F, T],
];

test('【C】見せ分け: 表の全行を基礎伏図・1階伏図の両視点で描く／リストに出すを確かめる', () => {
  const { fView, gView } = makeViews();
  assert.equal(fView.figureType, FIGURE_TYPE.FOUNDATION);
  assert.equal(gView.figureType, FIGURE_TYPE.ABOVEGROUND);
  for (const [name, map, ent, fd, gd, fl, gl] of SHARED_TABLE) {
    assert.equal(sharedPlaneDrawsMember(fView, map, ent), fd, `${name}: 基礎で描く`);
    assert.equal(sharedPlaneDrawsMember(gView, map, ent), gd, `${name}: 1階で描く`);
    assert.equal(sharedPlaneListsMember(fView, map, ent), fl, `${name}: 基礎でリスト`);
    assert.equal(sharedPlaneListsMember(gView, map, ent), gl, `${name}: 1階でリスト`);
  }
});

test('【C】見せ分け: 例外表に無く表Aの対象になる部材は、2つの視点のちょうど一方でだけ描く（重ならず漏れない）', () => {
  const { fView, gView } = makeViews();
  const reps = [
    ['beamMap', { role: 'foundation' }], ['beamMap', { role: 'primary' }], ['beamMap', { role: 'floor' }],
    ['columnMap', { role: 'primary' }], ['footingMap', {}], ['footingMap', { baseType: 'x' }],
    ['slabMap', { role: 'slab' }], ['wallMap', {}],
    ['columnMap', { role: 'foundation' }], // 杭は柱グループと同じ図（一般規則に補完される）
  ];
  for (const [map, ent] of reps) {
    const n = Number(sharedPlaneDrawsMember(fView, map, ent)) + Number(sharedPlaneDrawsMember(gView, map, ent));
    assert.equal(n, 1, `${map}:${ent.role ?? ''} draw`);
    const m = Number(sharedPlaneListsMember(fView, map, ent)) + Number(sharedPlaneListsMember(gView, map, ent));
    assert.equal(m, 1, `${map}:${ent.role ?? ''} list`);
  }
});

test('【C】見せ分け: sharedPlaneDrawsKind は種別の所属図面と一致する視点だけ true。null・未知の種別は絞らない', () => {
  const { fView, gView } = makeViews();
  assert.equal(sharedPlaneDrawsKind(fView, MEMBER_KIND.FOUNDATION_BEAM), true);
  assert.equal(sharedPlaneDrawsKind(gView, MEMBER_KIND.FOUNDATION_BEAM), false);
  assert.equal(sharedPlaneDrawsKind(fView, MEMBER_KIND.WALL), false);
  assert.equal(sharedPlaneDrawsKind(gView, MEMBER_KIND.WALL), true);
  assert.equal(sharedPlaneDrawsKind(fView, null), true);
  assert.equal(sharedPlaneDrawsKind(gView, 'unknownKind'), true);
});

test('【C】見せ分け: view が null なら全述語が表の全エンティティで true', () => {
  for (const [name, map, ent] of SHARED_TABLE) {
    assert.equal(sharedPlaneDrawsMember(null, map, ent), true, `${name}: draw`);
    assert.equal(sharedPlaneListsMember(null, map, ent), true, `${name}: list`);
  }
  assert.equal(sharedPlaneDrawsKind(null, MEMBER_KIND.WALL), true);
  assert.equal(sharedPlaneDrawsRoofFraming(null), true);
});

test('【C】sharedPlaneDrawsRoofFraming: 小屋組は1階伏図だけに描く（基礎伏図は false）。view が null なら true', () => {
  const { fView, gView } = makeViews();
  assert.equal(sharedPlaneDrawsRoofFraming(fView), false);
  assert.equal(sharedPlaneDrawsRoofFraming(gView), true);
  assert.equal(sharedPlaneDrawsRoofFraming(null), true);
});

test('【C】memberKindOf は杭の補完の影響を受けない（杭は null のまま。見せ分けだけが柱グループへ寄せる）', () => {
  assert.equal(memberKindOf('columnMap', { role: 'foundation' }), null);
  assert.equal(memberKindOf('columnMap', { role: 'primary' }), MEMBER_KIND.COLUMN);
});

test('【C】resolveSharedPlaneView: STRUCTURES 全構造。木造は両スロットで非 null、それ以外は基礎伏図でも null', () => {
  const woods = woodStructures();
  assert.ok(woods.length >= 1, '木造系の構造が1つ以上ある（このテストの前提）');
  for (const s of STRUCTURES) {
    const slots = buildStructuralFigureSlots(makeProject(s));
    const f = slotOf(slots, SLOT_TYPE.FOUNDATION);
    assert.ok(f, `${s}: 基礎伏図スロットがある`);
    const fv = resolveSharedPlaneView(f, slots, f.planeId);
    if (woods.includes(s)) {
      const g = slotOf(slots, SLOT_TYPE.GROUND_FLOOR);
      const gv = resolveSharedPlaneView(g, slots, g.planeId);
      assert.deepEqual({ slotKey: fv.slotKey, planeId: fv.planeId, figureType: fv.figureType },
        { slotKey: f.key, planeId: f.planeId, figureType: 'foundation' }, `${s}: 基礎`);
      assert.deepEqual({ slotKey: gv.slotKey, planeId: gv.planeId, figureType: gv.figureType },
        { slotKey: g.key, planeId: g.planeId, figureType: 'aboveground' }, `${s}: 1階`);
      assert.equal(Object.isFrozen(fv), true);
      assert.equal(Object.isFrozen(gv), true);
    } else {
      assert.equal(fv, null, `${s}: 見せ分けなし`);
    }
  }
});

test('【C】resolveSharedPlaneView: 2階以上・屋根スロットは null。地階ありの建物は全スロット null', () => {
  const wood = woodStructures()[0];
  const slots = buildStructuralFigureSlots(makeProject(wood, [1, 2, 3]));
  const others = slots.filter(s => s.slotType !== SLOT_TYPE.FOUNDATION && s.slotType !== SLOT_TYPE.GROUND_FLOOR);
  assert.ok(others.some(s => s.slotType === SLOT_TYPE.FLOOR), '前提: FLOOR スロットがある');
  assert.ok(others.some(s => s.slotType === SLOT_TYPE.ROOF_FRAME), '前提: 屋根スロットがある');
  for (const s of others) assert.equal(resolveSharedPlaneView(s, slots, s.planeId), null, s.key);

  const bSlots = buildStructuralFigureSlots(makeProject(wood, [-1, 1, 2]));
  assert.ok(bSlots.length > 0);
  for (const s of bSlots) assert.equal(resolveSharedPlaneView(s, bSlots, s.planeId), null, `地階あり ${s.key}`);
});

test('【C】resolveSharedPlaneView: subjectPlaneId が slot.planeId と違えば null、slot が null/undefined でも null', () => {
  const { slots } = makeViews();
  const f = slotOf(slots, SLOT_TYPE.FOUNDATION);
  assert.equal(resolveSharedPlaneView(f, slots, 'other-plane'), null);
  assert.equal(resolveSharedPlaneView(f, slots, undefined), null);
  assert.equal(resolveSharedPlaneView(null, slots, f.planeId), null);
  assert.equal(resolveSharedPlaneView(undefined, slots, f.planeId), null);
});

test('【C】失敗系: resolveSharedPlaneView は slots が配列でなければ throw、figureType 不正でも throw', () => {
  const { slots } = makeViews();
  const f = slotOf(slots, SLOT_TYPE.FOUNDATION);
  assert.throws(() => resolveSharedPlaneView(f, null, f.planeId), /resolveSharedPlaneView/);
  assert.throws(() => resolveSharedPlaneView(f, undefined, f.planeId), /resolveSharedPlaneView/);
  const bad = { key: 'k', planeId: 'x', slotType: SLOT_TYPE.FOUNDATION, figureType: 'bogus' };
  const mate = { key: 'k2', planeId: 'x', slotType: SLOT_TYPE.GROUND_FLOOR, figureType: 'aboveground' };
  assert.throws(() => resolveSharedPlaneView(bad, [bad, mate], 'x'), /resolveSharedPlaneView/);
  // 単独スロットなら figureType 不正でも検査前に null（見せ分けなし）
  assert.equal(resolveSharedPlaneView(bad, [bad], 'x'), null);
});

test('【C】失敗系: 未知の mapName・entity が null/undefined でも例外にならず true（view 非 null でも）', () => {
  const { fView, gView } = makeViews();
  for (const v of [fView, gView]) {
    assert.equal(sharedPlaneDrawsMember(v, 'unknownMap', { role: 'x' }), true);
    assert.equal(sharedPlaneListsMember(v, 'unknownMap', { role: 'x' }), true);
    assert.equal(sharedPlaneDrawsMember(v, 'unknownMap', null), true);
    assert.equal(sharedPlaneListsMember(v, 'unknownMap', undefined), true);
  }
});

test('【C】SHARED_PLANE_MEMBER_OVERRIDES は内側まで frozen', () => {
  assert.equal(Object.isFrozen(SHARED_PLANE_MEMBER_OVERRIDES), true);
  for (const byRole of Object.values(SHARED_PLANE_MEMBER_OVERRIDES)) {
    assert.equal(Object.isFrozen(byRole), true);
    for (const o of Object.values(byRole)) assert.equal(Object.isFrozen(o), true);
  }
});
