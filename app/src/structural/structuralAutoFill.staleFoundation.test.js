// removeStaleFoundationMembers（階追加 S5c-1）: 基礎伏図でなくなった階（下に階が足された）に残る
// 自動生成の基礎梁(role:'foundation')・独立フーチングを構造の再計算で撤去し、床梁(primary)を生めるようにする。
// 手動／locked は残す。地階を消して再び最下階に戻れば基礎梁・フーチングは作り直される（Q-A4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { autoFillStructuralGrid, removeStaleFoundationMembers, removeStaleFloorBeams } from './structuralAutoFill.js';

// 4000角グリッドを持つ1階。project.planes を差し替えて「下に階が足された／消えた」を模す（実体階は elevation 昇順）。
function makeScene() {
  const plane1F = new Plane('p1', 0, '1階', 1, 1);
  const planeB1 = new Plane('pb1', -2400, '地下1階', -1, 1);
  const graph = new PlanGraph(plane1F);
  graph.structureOverride = 'S造';
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const project = { planes: [plane1F], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  return { graph, project, plane1F, planeB1, x1, x2, y1, y2 };
}
const roleCount = (graph, role) => graph.beams.filter(b => b.role === role).length;

test('【S5c-1】最下階の1階で基礎梁4・フーチング4が生まれ、下に地階が足されて再計算すると auto の基礎梁・フーチングは撤去され床梁(primary)4が生まれる', () => {
  const { graph, project, plane1F, planeB1 } = makeScene();
  const first = autoFillStructuralGrid(graph, project, 'S造');
  assert.equal(roleCount(graph, 'foundation'), 4, '最下階＝基礎伏図: 基礎梁4');
  assert.equal(roleCount(graph, 'primary'), 0);
  assert.equal(graph.footings.length, 4, '基礎伏図: フーチング4');
  assert.equal(first.removedBeams.length, 0);

  const oldBeamIds = graph.beams.map(b => b.id);
  const oldFootingIds = graph.footings.map(f => f.id);
  project.planes = [planeB1, plane1F]; // 地下1階が足された＝1階はもう最下階でない
  const second = autoFillStructuralGrid(graph, project, 'S造');
  assert.equal(roleCount(graph, 'foundation'), 0, '基礎梁は撤去');
  assert.equal(graph.footings.length, 0, 'フーチングは撤去');
  assert.equal(roleCount(graph, 'primary'), 4, '同じ辺の床梁(primary)が生まれた（残骸に塞がれない）');
  assert.deepEqual([...second.removedBeams].sort(), [...oldBeamIds].sort(), '撤去した基礎梁のidが removedBeams に載る');
  assert.deepEqual([...second.removedFootings].sort(), [...oldFootingIds].sort(), '撤去したフーチングのidが removedFootings に載る');
  // 通常階になった S造の2.5m超のベイにはスラブ小梁の梁芯1本＋子梁1本も同じパスで生まれる（slabSecondaryBeamAxes.js）。
  assert.equal(second.newBeams.filter(b => b.role === 'primary').length, 4, '床梁4は newBeams に載る');
  assert.equal(second.newBeams.length, 6, '床梁4＋スラブ小梁の梁芯1・子梁1');

  const third = autoFillStructuralGrid(graph, project, 'S造');
  assert.equal(third.removedBeams.length + third.newBeams.length + third.removedFootings.length, 0, '2回目は変化なし（冪等）');
});

test('【S5c-1】locked／手動固定の基礎梁・フーチングは残る（auto だけ撤去）。残った基礎梁の辺には床梁を作らない', () => {
  const { graph, project, plane1F, planeB1 } = makeScene();
  autoFillStructuralGrid(graph, project, 'S造');
  const lockedBeam = graph.beams.find(b => b.role === 'foundation');
  const lockedFooting = graph.footings[0];
  lockedBeam.setDimensionStatus('locked');
  lockedFooting.setDimensionStatus('locked');

  project.planes = [planeB1, plane1F];
  const r = autoFillStructuralGrid(graph, project, 'S造');
  assert.equal(roleCount(graph, 'foundation'), 1, 'locked の基礎梁1本だけ残る');
  assert.equal(graph.beamMap.has(lockedBeam.id), true);
  assert.equal(graph.footings.length, 1);
  assert.equal(graph.footingMap.has(lockedFooting.id), true);
  assert.equal(r.removedBeams.length, 3, 'auto の3本だけ撤去');
  assert.equal(r.removedFootings.length, 3);
  assert.equal(roleCount(graph, 'primary'), 3, 'locked の基礎梁の辺（同spanKey）を除く3辺に床梁');
});

test('【S5c-1】最下階（基礎伏図）の auto 基礎梁・フーチングは再計算しても撤去されない', () => {
  const { graph, project } = makeScene();
  autoFillStructuralGrid(graph, project, 'S造');
  const ids = graph.beams.map(b => b.id);
  const r = autoFillStructuralGrid(graph, project, 'S造');
  assert.equal(r.removedBeams.length, 0);
  assert.equal(r.removedFootings.length, 0);
  assert.deepEqual(graph.beams.map(b => b.id), ids, '基礎梁は同じ実体のまま');
  assert.equal(graph.footings.length, 4);
});

// Q-A4/Q-A4b: 残った auto の床梁(primary)が同じ spanKey を塞ぐため、基礎伏図に戻った階では床梁系の auto 梁を先に撤去する。
test('【S5c-1・Q-A4】地階を消して1階が再び最下階に戻ると、基礎梁4・フーチング4が作り直され、床梁(primary)は0になる', () => {
  const { graph, project, plane1F, planeB1 } = makeScene();
  autoFillStructuralGrid(graph, project, 'S造');
  project.planes = [planeB1, plane1F];
  autoFillStructuralGrid(graph, project, 'S造');
  assert.equal(roleCount(graph, 'foundation'), 0);
  assert.equal(roleCount(graph, 'primary'), 4);

  project.planes = [plane1F]; // 地下1階を削除
  const r = autoFillStructuralGrid(graph, project, 'S造');
  assert.equal(roleCount(graph, 'foundation'), 4, '基礎梁が作り直された');
  assert.equal(roleCount(graph, 'primary'), 0, '床梁(primary)は撤去された');
  assert.equal(graph.footings.length, 4, 'フーチングが作り直された');
  assert.equal(r.newFootings.length, 4);
  assert.equal(r.removedBeams.length, 4, '撤去した primary 4本のidが removedBeams に載る');
  assert.equal(r.newBeams.length, 4);
});

test('【S5c-1・Q-A4b】基礎伏図の階の locked の primary は残り、auto の primary・landing だけ撤去される。基礎伏図でも生成しうる secondary・floor は触らない', () => {
  const { graph, x1, x2, y1, y2 } = makeScene();
  const mk = (role, cl, status) => {
    const b = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', cl, false, x1, x2, { role });
    if (status) b.setDimensionStatus(status);
    return b;
  };
  const lockedPrimary = mk('primary', y1, 'locked');
  const lockedSecondary = mk('secondary', y2, 'locked');
  const autos = [mk('primary', y1), mk('landing', y1)];
  const keep = [mk('secondary', y2), mk('floor', y2)]; // 生成しうる role は auto でも撤去しない（再生成の繰り返しを避ける）
  const removed = removeStaleFloorBeams(graph);
  assert.deepEqual([...removed].sort(), autos.map(b => b.id).sort(), 'auto の primary・landing の2本だけ撤去');
  assert.equal(graph.beamMap.has(lockedPrimary.id), true);
  assert.equal(graph.beamMap.has(lockedSecondary.id), true);
  for (const b of keep) assert.equal(graph.beamMap.has(b.id), true, `${b.role} は残る`);
});

test('【S5c-1・Q-A4b・冪等】基礎伏図の階で再計算を2回続けても、2回目の removedBeams・newBeams・removedFootings・newFootings は空で梁のidは不変', () => {
  const { graph, project } = makeScene();
  autoFillStructuralGrid(graph, project, 'S造');
  const ids = graph.beams.map(b => b.id).sort();
  const r = autoFillStructuralGrid(graph, project, 'S造');
  assert.deepEqual([r.removedBeams, r.newBeams, r.removedFootings, r.newFootings], [[], [], [], []]);
  assert.deepEqual(graph.beams.map(b => b.id).sort(), ids);
  // locked の primary が基礎伏図に残る場合も、再計算を重ねて撤去・再生成を繰り返さない
  const locked = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', graph.gridYs[0], false, graph.gridXs[0], graph.gridXs[1], { role: 'primary' });
  locked.setDimensionStatus('locked');
  autoFillStructuralGrid(graph, project, 'S造');
  const ids2 = graph.beams.map(b => b.id).sort();
  const r2 = autoFillStructuralGrid(graph, project, 'S造');
  assert.deepEqual([r2.removedBeams, r2.newBeams], [[], []]);
  assert.deepEqual(graph.beams.map(b => b.id).sort(), ids2);
  assert.equal(graph.beamMap.has(locked.id), true);
});

test('【S5c-1・Q-A4b・失敗系】床梁系の梁が無い基礎伏図の階では何もしない。基礎梁・土台は撤去しない', () => {
  const { graph, x1, x2, y1 } = makeScene();
  assert.deepEqual(removeStaleFloorBeams(graph), [], '空の階');
  const fg = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y1, false, x1, x2, { role: 'foundation' });
  const sill = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'sill' });
  assert.deepEqual(removeStaleFloorBeams(graph), []);
  assert.equal(graph.beamMap.has(fg.id), true);
  assert.equal(graph.beamMap.has(sill.id), true);
});

test('【S5c-1・失敗系】基礎伏図でない階の removeStaleFoundationMembers は土台(sill)・柱脚(ColumnBase)を撤去しない', () => {
  const { graph, x1, x2, y1, y2 } = makeScene();
  const fg = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y1, false, x1, x2, { role: 'foundation' });
  const sill = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'sill' }); // 同じ区間・auto
  // 柱脚は auto のまま作れる（dimensionStatus の既定が 'auto'）ので、auto の ColumnBase が残ることを確かめる
  const base = graph.addFooting('base', 'RC-300x300', x1, y2, { materialType: StructuralMaterialType.RC });
  assert.equal(sill.dimensionStatus, 'auto');
  assert.equal(base.dimensionStatus, 'auto');
  const r = removeStaleFoundationMembers(graph);
  assert.deepEqual(r.removedBeams, [fg.id], '撤去は foundation 梁だけ');
  assert.deepEqual(r.removedFootings, [], '柱脚は撤去しない');
  assert.equal(graph.beamMap.has(sill.id), true, '土台は残る');
  assert.equal(graph.footingMap.has(base.id), true, '柱脚は残る');
});

test('【S5c-1・失敗系】基礎梁もフーチングも無い階・梁も無い空の階では removeStaleFoundationMembers は何もしない。別roleの梁も触らない', () => {
  const { graph, x1, x2, y1 } = makeScene();
  assert.deepEqual(removeStaleFoundationMembers(graph), { removedBeams: [], removedFootings: [] }, '空の階');
  const primary = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', y1, false, x1, x2, { role: 'primary' });
  const r = removeStaleFoundationMembers(graph);
  assert.deepEqual(r, { removedBeams: [], removedFootings: [] }, '基礎梁が無ければ何も消さない');
  assert.equal(graph.beamMap.has(primary.id), true, '別roleの梁は残る');
});
