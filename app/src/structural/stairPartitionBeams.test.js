// 在来木造・折返し階段の隔て梁（隔て壁 S5。role:'partitionBeam'）の生成・撤去・除外・配線。
// フィクスチャは finish/stair/stairPartitionWalls.test.js の EQUAL_UP（階段の隔て壁 x=1000・区間 y1000〜4000）を
// 2階建てにしたもの。下階（1階）に隔て壁を生成し、上階（2階）に同じ位置の階段を置く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { beamExclusionKey, spanKey } from '../core.js';
import { generateStairPartitionWalls } from '../finish/stair/stairPartitionWalls.js';
import { stairPartitionEnds } from './wallFreeEnds.js';
import { stairPartitionBeamSpans, autoFillStairPartitionBeams, PARTITION_BEAM_ROLE } from './stairPartitionBeams.js';
import { conformWoodSections, autoFillWoodBeamDepths } from './woodAutoFill.js';
import { autoFillStructuralGrid, convertMembersToEffectiveMaterial } from './structuralAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { MEMBER_GROUPS, memberSymbol } from './memberCatalog.js';
import { columnSeedBeamSegments, selfWallSegments } from './wallBeamAxes.js';
import { structuralContribution } from '../elevation/section/sectionStructure.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

// rects の各 [x1,y1,x2,y2] を1セルとする SWITCHBACK 階段を、project の新しい階に作る。clProps で CL の属性を上書きできる。
function addStairFloor(project, elevation, name, id, rects, { clProps = () => ({}) } = {}) {
  const { graph } = project.addPlane(elevation, name, id);
  graph.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH, ...clProps(type, v) })).get(v);
  const V = (v) => mk(CenterLineType.VERTICAL, vs, v);
  const H = (v) => mk(CenterLineType.HORIZONTAL, hs, v);
  const cells = new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up' });
  return { graph, V, H };
}

/** 下階（隔て壁あり）＋上階（同位置の階段）。lower2a で下階の2a差し引きを指定できる。 */
function build({ lowerOpts = {}, upperOpts = {}, lowerUnderEdges = [], lowerExtra = () => {} } = {}) {
  const project = new Project('proj', 'test');
  const lower = addStairFloor(project, 0, '1階', 'p1', EQUAL_UP, lowerOpts);
  lowerExtra(lower);
  generateStairPartitionWalls(lower.graph, { structure: WOOD, underEdges: lowerUnderEdges });
  const upper = addStairFloor(project, 3000, '2階', 'p2', EQUAL_UP, upperOpts);
  const belowEnds = stairPartitionEnds(lower.graph, project);
  return { project, lower, upper, g1: lower.graph, g2: upper.graph, belowEnds };
}
const partitionBeams = (g) => g.beams.filter(b => b.role === PARTITION_BEAM_ROLE);
const clCount = (g) => g.centerLines.length;

test('正常系: 下階の隔て壁の両端があり自階に同位置の階段があれば、隔て梁が1本。role・beamType・WOOD-90x90・軸 x=1000・端 y1000/4000・auto', () => {
  const { project, g2, belowEnds } = build();
  assert.equal(belowEnds.length, 2, '前提: 下階の隔て壁の端が2つ');
  const { created, removed } = autoFillStairPartitionBeams(g2, project, belowEnds);
  assert.equal(created.length, 1);
  assert.deepEqual(removed, []);
  const [b] = partitionBeams(g2);
  assert.equal(b.beamType, '隔て梁');
  assert.equal(b.sectionDefId, 'WOOD-90x90');
  assert.equal(b.materialType, StructuralMaterialType.WOOD);
  assert.equal(b.isVertical, true);
  assert.equal(b.axisCL.effectiveValue, 1000);
  assert.deepEqual([b.clStart.effectiveValue, b.clEnd.effectiveValue].sort((a, c) => a - c), [1000, 4000]);
  assert.equal(b.dimensionStatus, 'auto');
  assert.equal(b.levelOffset, 0, 'levelOffset は書かない（既定）');
});

test('冪等: 2回目は生成・撤去が空で id が変わらない', () => {
  const { project, g2, belowEnds } = build();
  autoFillStairPartitionBeams(g2, project, belowEnds);
  const id = partitionBeams(g2)[0].id;
  const r = autoFillStairPartitionBeams(g2, project, belowEnds);
  assert.deepEqual([r.created.length, r.removed.length], [0, 0]);
  assert.equal(partitionBeams(g2)[0].id, id);
});

test('【失敗系】自階に階段が無い（最上層）・足元が違う階段は0本。既存の auto は撤去される', () => {
  const { project, g2, belowEnds } = build();
  autoFillStairPartitionBeams(g2, project, belowEnds);
  assert.equal(partitionBeams(g2).length, 1, '前提');
  // 最上階相当: 階段の無い階（別の階）には作らない
  const noStair = project.addPlane(6000, '3階', 'p3').graph;
  noStair.structureOverride = WOOD;
  assert.equal(autoFillStairPartitionBeams(noStair, project, belowEnds).created.length, 0);
  // 足元が違う（階段が x 方向に 100mm ずれた）→ 線の座標が下階の端と一致しない
  const shifted = project.addPlane(9000, '4階', 'p4');
  shifted.graph.structureOverride = WOOD;
  const sv = new Map(), sh = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, shifted.graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const V = (v) => mk(CenterLineType.VERTICAL, sv, v), H = (v) => mk(CenterLineType.HORIZONTAL, sh, v);
  const rects = EQUAL_UP.map(([x1, y1, x2, y2]) => [x1 + 100, y1, x2 + 100, y2]);
  shifted.graph.addStair({ type: StairType.SWITCHBACK, cells: new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`)), sections: [6, 1, 6], flip: false, upDirection: 'up' });
  assert.equal(stairPartitionBeamSpans(shifted.graph, project, belowEnds).length, 0);
  assert.equal(autoFillStairPartitionBeams(shifted.graph, project, belowEnds).created.length, 0);
  // 既存 auto は、入力が無くなれば撤去
  const r = autoFillStairPartitionBeams(g2, project, []);
  assert.equal(r.removed.length, 1);
  assert.equal(partitionBeams(g2).length, 0);
});

test('【失敗系】上下で線の長さが違う（上階の階段が長い）と生成しない', () => {
  const { project, g2, belowEnds } = build({ lowerOpts: {} });
  // 下階の端の y 座標を 100mm ずらした入力＝上下で tRun が違う状況と同じ
  const skewed = belowEnds.map(e => ({ ...e, along: e.along + 100 }));
  assert.equal(stairPartitionBeamSpans(g2, project, skewed).length, 0);
  assert.equal(autoFillStairPartitionBeams(g2, project, skewed).created.length, 0);
});

test('【失敗系】自階の線端に CL が解決できない（補助線）なら生成しない。CL は作らない', () => {
  const { project, g2, belowEnds } = build({
    upperOpts: { clProps: (type, v) => (type === CenterLineType.VERTICAL && v === 1000 ? { lineType: 'dashed' } : {}) },
  });
  const before = clCount(g2);
  assert.equal(stairPartitionBeamSpans(g2, project, belowEnds).length, 1, '前提: 候補にはなる');
  assert.equal(autoFillStairPartitionBeams(g2, project, belowEnds).created.length, 0);
  assert.equal(clCount(g2), before, 'CL を作らない');
});

test('手動削除: removeBeam すると再生成しない。除外キーは partitionBeam: 名前空間で、同 spanKey の primary の生成は止めない', () => {
  const { project, g2, belowEnds } = build();
  autoFillStairPartitionBeams(g2, project, belowEnds);
  const b = partitionBeams(g2)[0];
  const key = spanKey(b.axisCL, b.clStart, b.clEnd);
  g2.removeBeam(b.id);
  assert.equal(partitionBeams(g2).length, 0);
  assert.ok(g2.excludedBeamSlots.has(`partitionBeam:${key}`), '名前空間つきの除外キー');
  assert.equal(g2.excludedBeamSlots.has(key), false, '素の spanKey は除外されない（同スロットの大梁・床梁を止めない）');
  assert.equal(beamExclusionKey('primary', b.axisCL, b.clStart, b.clEnd), key);
  const r = autoFillStairPartitionBeams(g2, project, belowEnds);
  assert.equal(r.created.length, 0, '再生成しない');
  assert.equal(partitionBeams(g2).length, 0);
});

test('主構造: 自階が S造なら0本・既存の auto は撤去。下階が非在来なら下階の端が空で0本', () => {
  const { project, g1, g2, belowEnds } = build();
  autoFillStairPartitionBeams(g2, project, belowEnds);
  assert.equal(partitionBeams(g2).length, 1, '前提');
  g2.structureOverride = 'S造';
  assert.equal(stairPartitionBeamSpans(g2, project, belowEnds).length, 0);
  const r = autoFillStairPartitionBeams(g2, project, belowEnds);
  assert.equal(r.removed.length, 1);
  assert.equal(partitionBeams(g2).length, 0);
  g2.structureOverride = WOOD;
  g1.structureOverride = 'S造';
  assert.deepEqual(stairPartitionEnds(g1, project), [], '下階が非在来なら端が空');
  assert.equal(autoFillStairPartitionBeams(g2, project, stairPartitionEnds(g1, project)).created.length, 0);
});

test('belowGraph なし（[]）なら auto は撤去・locked は残る', () => {
  const { project, g2, belowEnds } = build();
  autoFillStairPartitionBeams(g2, project, belowEnds);
  const [auto] = partitionBeams(g2);
  // locked の同種の梁（別スパン＝ y1000〜4000 でなく端を変えた梁）を手で足す
  const clH = g2.centerLines.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.value === 0);
  const clH2 = g2.centerLines.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.value === 1000);
  const locked = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-90x90', auto.axisCL, true, clH, clH2, { role: PARTITION_BEAM_ROLE, beamType: '隔て梁' });
  locked.setField('dimensionStatus', 'locked');
  const r = autoFillStairPartitionBeams(g2, project, []);
  assert.deepEqual(r.removed, [auto.id]);
  assert.deepEqual(partitionBeams(g2).map(b => b.id), [locked.id]);
});

test('下階の上り口端が 2a で切れている（線端でない）と生成しない', () => {
  const { project, g2, belowEnds } = build({
    lowerExtra: ({ H }) => H(2500),
    lowerUnderEdges: [{ isVertical: true, value: 1000, lo: 1000, hi: 2500 }],
  });
  assert.deepEqual(belowEnds.map(e => e.along), [4000], '前提: 下階の端は y=4000 の1つだけ（y=2500 は線端でない）');
  assert.equal(stairPartitionBeamSpans(g2, project, belowEnds).length, 0);
  assert.equal(autoFillStairPartitionBeams(g2, project, belowEnds).created.length, 0);
});

test('【失敗系】下階の端が片方だけ（上り口側だけ・踊り場側だけ）でも生成しない。両方そろえば生成する（対照）', () => {
  const { project, g2, belowEnds } = build();
  assert.equal(belowEnds.length, 2, '前提');
  for (const only of belowEnds) {
    assert.equal(stairPartitionBeamSpans(g2, project, [only]).length, 0, `along=${only.along} だけでは生成しない`);
  }
  assert.equal(stairPartitionBeamSpans(g2, project, belowEnds).length, 1, '対照: 両端そろえば候補になる');
});

test('conformWoodSections: 階柱寸が120でも auto の隔て梁は 90×90 のまま。locked は触らない', () => {
  const { project, g2, belowEnds } = build();
  g2.setWoodColumnWidthMm(120);
  autoFillStairPartitionBeams(g2, project, belowEnds);
  const [b] = partitionBeams(g2);
  b.setField('sectionDefId', 'WOOD-120x120'); // 何かが書き換えた状態
  assert.deepEqual(conformWoodSections(g2, project).filter(id => id === b.id), [b.id]);
  assert.equal(b.sectionDefId, 'WOOD-90x90', 'auto は 90×90 へ戻る');
  b.setField('dimensionStatus', 'locked');
  b.setField('sectionDefId', 'WOOD-105x105');
  conformWoodSections(g2, project);
  assert.equal(b.sectionDefId, 'WOOD-105x105', 'locked は触らない');
});

test('配線: autoFillStructuralGrid（belowGraph あり）の newBeams に入り、belowGraph なしで removedBeams に入る。梁成の算定・柱の種・材種変換・構造リスト・展開の対象外', () => {
  const { project, g1, g2 } = build();
  const run = (below) => autoFillStructuralGrid(g2, project, WOOD, null, [], selfWallSegments(g2), [], [], [], undefined, undefined, undefined, [], below);
  const r1 = run(g1);
  const made = r1.newBeams.filter(b => b.role === PARTITION_BEAM_ROLE);
  assert.equal(made.length, 1, 'newBeams に入る（changed・undo に乗る）');
  assert.equal(partitionBeams(g2).length, 1);

  // 梁成の算定は隔て梁の断面を変えない
  autoFillWoodBeamDepths(g2, project, []);
  assert.equal(partitionBeams(g2)[0].sectionDefId, 'WOOD-90x90');
  // 柱の種（primary|floor だけ）に現れない
  assert.equal(columnSeedBeamSegments(g2, { framing: true, beamPlacement: 'wallRuns' }).some(s => s.coord === 1000 && s.lo === 1000 && s.hi === 4000), false);
  // 材種変換の対象外
  g2.structureOverride = 'S造';
  convertMembersToEffectiveMaterial(g2, project, 'S造');
  assert.equal(partitionBeams(g2)[0].materialType, StructuralMaterialType.WOOD, 'S造へ切替えても材種変換しない（撤去は生成側が担う）');
  assert.equal(partitionBeams(g2)[0].sectionDefId, 'WOOD-90x90');
  g2.structureOverride = WOOD;
  // 構造リストのグループ・記号
  const beam = partitionBeams(g2)[0];
  assert.equal(memberSymbol(beam, 'beamMap'), 'PG');
  const groups = MEMBER_GROUPS.filter(g => g.mapName === 'beamMap' && (g.filter ? g.filter(beam) : true)).map(g => g.key);
  assert.deepEqual(groups, ['beamPartition'], '「梁」グループには入らず、隔て梁グループだけ');
  const allowManual = MEMBER_GROUPS.find(g => g.key === 'beamPartition');
  assert.equal(allowManual.allowManualAdd, false);
  assert.equal(allowManual.hideWhenEmpty, true);

  // belowGraph が無ければ撤去が removedBeams に入る
  const r2 = run(null);
  assert.deepEqual(r2.removedBeams.filter(id => id === beam.id), [beam.id]);
  assert.equal(partitionBeams(g2).length, 0);
});

test('新役割は他の点源に入らない: 隔て梁のある上階を aboveBeamSegments（columnSeedBeamSegments）で渡して下階を再計算しても、x=1000・y1000〜4000 の中間に柱が増えない', () => {
  const { project, lower, g1, g2 } = build();
  // 下階の外周壁（隔て壁の端を自由端にする。壁が無いと柱の生成が走らない）。下辺は省く＝両端とも自由端
  const own = { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 };
  const { V, H } = lower;
  g1.addWall(V(0), 57.5, true, H(0), 0, H(4000), 0, own);
  g1.addWall(V(2000), -57.5, true, H(0), 0, H(4000), 0, { ...own, finishSide: -1 });
  g1.addWall(H(0), 57.5, false, V(0), 0, V(2000), 0, own);
  autoFillStairPartitionBeams(g2, project, stairPartitionEnds(g1, project));
  assert.equal(partitionBeams(g2).length, 1, '前提: 上階に隔て梁がある');
  const rules = { framing: true, beamPlacement: 'wallRuns' };
  const seeds = columnSeedBeamSegments(g2, rules);
  assert.equal(seeds.length, 0, '柱の種は primary|floor だけ（隔て梁は含まれない）');
  const sig = () => g1.columns.map(c => `${c.verticalCL.effectiveValue}:${c.horizontalCL.effectiveValue}`).sort();
  const run = (above) => autoFillStructuralGrid(g1, project, WOOD, null, [], selfWallSegments(g1), [], [], above, undefined, undefined, undefined, [], null);
  run([]);
  const before = sig();
  assert.ok(before.includes('1000:1000') && before.includes('1000:4000'), '前提: 隔て壁の両端の柱は立っている');
  run(seeds);
  assert.deepEqual(sig(), before, '柱の集合は変わらない');
  assert.equal(g1.columns.some(c => c.verticalCL.effectiveValue === 1000 && c.horizontalCL.effectiveValue > 1000 && c.horizontalCL.effectiveValue < 4000), false);
});

test('展開・断面の梁収集（structuralContribution）は隔て梁を含めない。対照: 同じ梁を role:floor にすると含まれる', () => {
  const { project, g2, belowEnds } = build();
  autoFillStairPartitionBeams(g2, project, belowEnds);
  const layers = [{ graph: g2, floorZMm: 3000, role: 'self' }];
  assert.equal(structuralContribution(layers).length, 0, '隔て梁は寄与しない');
  const [b] = partitionBeams(g2);
  b.setField('role', 'floor');
  assert.equal(structuralContribution(layers).length, 1, '対照: floor なら寄与する（収集自体は動いている）');
});

test('同じスロットに別 role の梁（primary）があれば隔て梁は作らず、primary は残る。primary を消せば作る（対照）', () => {
  const { project, g2, belowEnds } = build();
  autoFillStairPartitionBeams(g2, project, belowEnds);
  const [pb] = partitionBeams(g2);
  const { axisCL, clStart, clEnd } = pb;
  g2.beamMap.delete(pb.id);
  const primary = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', axisCL, true, clStart, clEnd, { role: 'primary' });
  const r = autoFillStairPartitionBeams(g2, project, belowEnds);
  assert.equal(r.created.length, 0);
  assert.equal(partitionBeams(g2).length, 0);
  assert.ok(g2.beamMap.has(primary.id), 'primary は残る');
  g2.beamMap.delete(primary.id);
  assert.equal(autoFillStairPartitionBeams(g2, project, belowEnds).created.length, 1, '対照: 占有が無ければ作る');
});
