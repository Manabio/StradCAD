// finish/floorCLMap.js の単体テスト。
// findCounterpartCL は種別条件の無い素の graph.centerLines 走査を
// centerLineKindPolicy.sameCoordCounterparts（走査API）経由に移行済み（ステップ7、2026-09-20）——
// 挙動（type:value のみで照合し種別を見ない・tolMm=1e-6・最初の1件）は変えない。
//
// collectNeededCLs・addMissingCLs・translateCellSet は finish/stair/stairFloorSync.js から
// 本体を変えずに移した（昇降機の仕様追加 ステップ4 S1・2026-09-29）。挙動（階段の上階自動同期）は
// 不変——既存の stairFloorSync.test.js 等が引き続き緑であることで確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline } from '../core.js';
import {
  findCounterpartCL, translateCLId, collectNeededCLs, addMissingCLs, translateCellSet,
  extendDividerExtents, retargetKeysToCoveringCLs,
} from './floorCLMap.js';
import { isFinishCellDivider } from '../core/centerLineKindPolicy.js';
import { RoomKind } from '../core.js';
import { generateExteriorWalls, healDerivedGeometry } from './wallGeneration.js';
import { mergeAdjacentDividers } from './floorCLMap.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

function makeProjectWithTwoFloors() {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(1, '2階', 'p2');
  return { project, g1, g2 };
}

test('findCounterpartCL: type・valueが一致するCLを返す（種別は問わない）', () => {
  const graph = makeGraph();
  const center = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 1000)?.id, center.id);
});

test('findCounterpartCL: 種別が違っても同type:valueなら最初に見つかったものを返す（既知の限界。種別を見ない）', () => {
  const graph = makeGraph();
  // 通り芯・中心線が同座標に共存するのはCOEXISTENCE上ありえないが、findCounterpartCL自体は
  // graph.centerLinesの中身を種別で絞らない——中心線・補助線・梁芯が同座標にある構成（ありうる）で
  // 「最初に見つかったもの」をそのまま返す現行挙動を固定する。
  const aux = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' });
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const result = findCounterpartCL(graph, CenterLineType.VERTICAL, 1000);
  assert.equal(result?.id, aux.id, '走査順で先に追加されたaux(先頭)が選ばれる（種別による優先はしない）');
  assert.notEqual(result?.id, beam.id);
});

test('findCounterpartCL: tolMmは1e-6（CL_OVERLAP_TOL_MMの既定0.5mmより厳しい）——境界の両側を確認する', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 1000.001)?.id, undefined, '差0.001mmは1e-6より粗いため不一致（sameCoordCounterpartsの既定tolMm=0.5を使っていたら誤ってマッチしてしまう）');
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 1000.0000001)?.id, cl.id, '差1e-7は1e-6未満なので一致する');
});

// QA指摘（Minor E）: tolMm境界が開区間（`<`であって`<=`ではない）であることを直接固定する。
// 浮動小数の丸め誤差で不安定にならないよう、CL位置は0・照合値はEPS自体（=1e-6）を使う——
// `Math.abs(0 - 1e-6)`は加減算の丸め誤差を経由せず厳密に`1e-6`になるため、`1e-6 < 1e-6`の判定が
// 決定的にfalseになる（1000を基準にすると加算の丸めで厳密な1e-6にならず不安定になる）。
test('【失敗系】findCounterpartCL: 差がちょうどtolMm(1e-6)のCLは一致しない（開区間。`<`であって`<=`ではない）', () => {
  const graph = makeGraph();
  const EPS = 1e-6;
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, EPS), null, '差がちょうどEPS（開区間の境界そのもの）は不一致');
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, EPS / 2)?.id, cl.id, '差がEPS未満なら一致');
});

test('findCounterpartCL: centerLineTypeが異なれば見つからない', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, CenterLineType.HORIZONTAL, 1000), null);
});

test('findCounterpartCL: 該当なしはnull', () => {
  const graph = makeGraph();
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 12345), null);
});

// ---- 【失敗系】QA指摘: sameCoordCounterparts（走査API）はcenterLineType未指定・valueが非数値でthrowする
// が、findCounterpartCL自体は移行前（素のgraph.centerLines.find）と同じ「該当なしはnull」の契約を
// 保つ（throwしない）——translateCLIdがCL以外のshapeMap要素からcenterLineType/valueを渡す退化ケース
// （下のtranslateCLId系テスト参照）を安全に処理するためのガード。 ----

test('【失敗系】findCounterpartCL: typeがnull/undefined・valueが非数値（undefined/NaN/文字列）でもthrowせずnullを返す', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, null, 1000), null);
  assert.equal(findCounterpartCL(graph, undefined, 1000), null);
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, undefined), null);
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, NaN), null);
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, '1000'), null);
});

test('translateCLId: 通り芯（structGraph側）は全階共通idのためそのまま返る', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const structCl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(translateCLId(structCl.id, g1, project.structGraph, g2), structCl.id);
});

test('translateCLId: per-floor CL（中心線）は対象階の同type:value CLのidへ変換される。無ければnull', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const srcCl = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const dstCl = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(translateCLId(srcCl.id, g1, project.structGraph, g2), dstCl.id);

  const srcOnly = g1.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(translateCLId(srcOnly.id, g1, project.structGraph, g2), null, '対象階に対応するCLが無ければnull');
});

// 天井芯（S8a）は階固有の天伏だけの線——他階の対応CL探索（findCounterpartCL の述語なし呼び出し）で掴まない。
// 上階に同座標の天井芯が先に並んでいても、translateCLId は中心線を返す。
test('天井芯: 上階に同座標の天井芯と中心線があるとき translateCLId は中心線を返す（天井芯を掴まない）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const srcCl = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const ceiling = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.CEILING }); // 先に並ぶ
  const dstCl = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(g2.centerLines[0].id, ceiling.id, '前提: 天井芯が配列の先頭（素の find なら天井芯を返してしまう）');
  assert.equal(translateCLId(srcCl.id, g1, project.structGraph, g2), dstCl.id);
  assert.equal(findCounterpartCL(g2, CenterLineType.VERTICAL, 1000)?.id, dstCl.id);
});

test('【失敗系】天井芯: 上階に同座標の天井芯しかないとき translateCLId は null（対応する中心線が無い）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const srcCl = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.CEILING });
  assert.equal(translateCLId(srcCl.id, g1, project.structGraph, g2), null);
  assert.equal(findCounterpartCL(g2, CenterLineType.VERTICAL, 1000), null);
});

// ---- 【失敗系】QA指摘: shapeMap.get(id) がCLでない形状（壁等）を返すケース。
// 「解決できなければnull」というtranslateCLIdの契約が、findCounterpartCLの引数ガード追加後も
// 保たれることを確認する（cl.centerLineType/cl.valueがundefinedのままfindCounterpartCLへ渡っても
// throwせずnullに収束する）。 ----

test('【失敗系】translateCLId: idがCLでない形状（壁）を指すとnullを返す（throwしない）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const axisCL  = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = g1.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = g1.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const wall = g1.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  assert.doesNotThrow(() => translateCLId(wall.id, g1, project.structGraph, g2));
  assert.equal(translateCLId(wall.id, g1, project.structGraph, g2), null);
});

test('【失敗系】translateCLId: 存在しないidはnullを返す', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  assert.equal(translateCLId('no-such-id', g1, project.structGraph, g2), null);
});

// ---- collectNeededCLs（finish/stair/stairFloorSync.js から本体を変えずに移した。S1） ----

test('collectNeededCLs: 通り芯（structGraph側のid）はsourceGraph.shapeMapに無いため自然にスキップされる', () => {
  const { project, g1 } = makeProjectWithTwoFloors();
  const grid = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const center = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${grid.id}:x:x:x`; // 通り芯id + 存在しないid3つ（split(':')で個別に解決を試みるだけなので問題ない）
  const needed = collectNeededCLs([key, `${center.id}:y:y:y`], g1);
  assert.equal(needed.has(`${CenterLineType.VERTICAL}:0`), false, '通り芯（structGraph側）はneededに含まれない');
  assert.equal(needed.get(`${CenterLineType.VERTICAL}:1000`)?.id, center.id);
});

test('collectNeededCLs: 同じ型・座標のCLが複数キーに現れても1件にまとまる（Mapキーはtype:value）', () => {
  const { g1 } = makeProjectWithTwoFloors();
  const a = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const needed = collectNeededCLs([`${a.id}:p:q:r`, `s:${a.id}:t:u`], g1);
  assert.equal(needed.size, 1);
  assert.equal(needed.get(`${CenterLineType.VERTICAL}:1000`)?.id, a.id);
});

// ---- addMissingCLs（同上。S1） ----

test('addMissingCLs: 上階に既に対応CLがあるものは足さない（無いものだけ足し、追加件数を返す）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const existing = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const missing  = g1.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 既に対応先あり

  const needed = collectNeededCLs([`${existing.id}:a:b:c`, `${missing.id}:a:b:c`], g1);
  const added = addMissingCLs(needed, g1, project.structGraph, g2);

  assert.equal(added, 1, '既に対応先のあるexisting(1000)は足さず、missing(2000)だけ足す');
  assert.ok(findCounterpartCL(g2, CenterLineType.VERTICAL, 2000), 'missing側は上階に追加されている');
});

test('addMissingCLs: extentの写し方（1）通り芯参照はそのまま維持する', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const gridLo = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: gridLo.id, offset: 0 },
  });
  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);
  addMissingCLs(needed, g1, project.structGraph, g2);

  const nc = findCounterpartCL(g2, CenterLineType.VERTICAL, 1000);
  assert.equal(nc.extentLoRef?.clId, gridLo.id, '通り芯参照はidそのままで上階へ写る');
});

test('addMissingCLs: extentの写し方（2）設置階per-floor CLへの参照は上階の同type:value CLへ付け替える', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const srcRef = g1.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const dstRef = g2.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH }); // 上階に既に対応先あり
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: srcRef.id, offset: 10 },
  });
  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);
  addMissingCLs(needed, g1, project.structGraph, g2);

  const nc = findCounterpartCL(g2, CenterLineType.VERTICAL, 1000);
  assert.equal(nc.extentLoRef?.clId, dstRef.id, '設置階側の参照先(srcRef)ではなく上階の対応CL(dstRef)を指す');
  assert.equal(nc.extentLoRef?.offset, 10, 'offsetはそのまま維持');
});

test('addMissingCLs: extentの写し方（3）壁参照・付け替え先なしは解決済み座標を静的値として持たせる', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const axisCL  = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = g1.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = g1.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const wall = g1.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { wallId: wall.id },
  });
  const resolvedLo = src.extentLo;
  assert.ok(typeof resolvedLo === 'number', '前提: 壁参照は解決済みの数値を返す');

  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);
  addMissingCLs(needed, g1, project.structGraph, g2);

  const nc = findCounterpartCL(g2, CenterLineType.VERTICAL, 1000);
  assert.equal(nc.extentLoRef, null, '壁参照は上階では参照化しない（壁は階固有）');
  assert.equal(nc.extentLo, resolvedLo, '解決済み座標を静的値として持つ');
});

// ---- translateCellSet（同上。S1） ----

test('translateCellSet: 全キーが解決できればtype:value照合で変換したキー集合を返す', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const a1 = g1.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const b1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const c1 = g1.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const d1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const a2 = g2.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const b2 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const c2 = g2.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const d2 = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const key = `${a1.id}:${b1.id}:${c1.id}:${d1.id}`;
  const result = translateCellSet(new Set([key]), g1, project.structGraph, g2);
  assert.deepEqual(result, new Set([`${a2.id}:${b2.id}:${c2.id}:${d2.id}`]));
});

// ---- findCounterpartCL: predicate引数（省略可。ステップ4 S2で追加） ----

test('findCounterpartCL: predicate省略時は従来どおり種別を問わず最初の1件を返す（梁芯が先でも梁芯を返す）', () => {
  const graph = makeGraph();
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // center（後から追加）
  const result = findCounterpartCL(graph, CenterLineType.VERTICAL, 1000);
  assert.equal(result?.id, beam.id, '省略時は先頭（梁芯）が返る——旧経路のまま');
});

test('findCounterpartCL: predicate指定時は述語を満たす最初の1件だけを返す（isFinishCellDividerで梁芯を除外し中心線を返す）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // beam（分割線ではない）
  const center = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // center
  const result = findCounterpartCL(graph, CenterLineType.VERTICAL, 1000, isFinishCellDivider);
  assert.equal(result?.id, center.id, 'predicate指定時は梁芯を除外し中心線が返る——明示時だけ新経路を通る');
});

test('findCounterpartCL: predicateを満たす候補が無ければnull', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // beamのみ
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 1000, isFinishCellDivider), null);
});

// ---- addMissingCLs: opts.isCounterpart（省略可。ステップ4 S2で追加）。
// 「明示 vs 省略」で結果が変わる入力（上階の同座標に梁芯だけがある）を使う——
// 対照側は「引数なし（従来）」と「{isCounterpart: isFinishCellDivider}」で固定する
// （team-lessons「明示vs省略のA/B等価テストが既定生成で恒真化する」対応）。 ----

test('addMissingCLs: 省略時は上階の梁芯を「対応先あり」とみなし、中心線を足さない（階段の既存挙動を固定）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 上階に梁芯のみ
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);

  const added = addMissingCLs(needed, g1, project.structGraph, g2);

  assert.equal(added, 0, '省略時は梁芯を対応先とみなすため足さない');
  assert.equal(g2.centerLines.filter(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000).length, 1, '梁芯1本のまま増えない');
});

test('addMissingCLs: {isCounterpart: isFinishCellDivider}指定時は上階の梁芯だけでは対応先とみなさず、中心線を足す', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 上階に梁芯のみ
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);

  const added = addMissingCLs(needed, g1, project.structGraph, g2, { isCounterpart: isFinishCellDivider });

  assert.equal(added, 1, '明示時は梁芯を対応先とみなさず中心線を新規に足す');
  const dividerCounterpart = findCounterpartCL(g2, CenterLineType.VERTICAL, 1000, isFinishCellDivider);
  assert.ok(dividerCounterpart, '分割線として解決できる中心線が上階に追加されている');
});

test('translateCellSet: 1つでも解決できないキーがあればnullを返す（安全側）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const a1 = g1.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const b1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const c1 = g1.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const d1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  // g2側にはc1(1000)の対応先を作らない → このキーは解決不能
  g2.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  g2.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  g2.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const key = `${a1.id}:${b1.id}:${c1.id}:${d1.id}`;
  assert.equal(translateCellSet(new Set([key]), g1, project.structGraph, g2), null);
});

// ---- extendDividerExtents / retargetKeysToCoveringCLs（足元の辺を上階の格子で割る） ----
// 設置階の1セル [0,1000]x[0,1000]（per-floor 中心線4本）。上階は同座標の中心線を持つが、区間を指定して作る。
const ARCH = { labeled: false, discipline: Discipline.ARCH };
function cellFixture(upperExtents = {}) {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const s = {
    left:   g1.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH),
    top:    g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH),
    right:  g1.addCenterLine(CenterLineType.VERTICAL,   1000, ARCH),
    bottom: g1.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH),
  };
  const up = {};
  for (const [side, [type, value]] of Object.entries({
    left: [CenterLineType.VERTICAL, 0], top: [CenterLineType.HORIZONTAL, 0],
    right: [CenterLineType.VERTICAL, 1000], bottom: [CenterLineType.HORIZONTAL, 1000],
  })) {
    up[side] = g2.addCenterLine(type, value, { ...ARCH, ...(upperExtents[side] ?? {}) });
  }
  const key = `${s.left.id}:${s.top.id}:${s.right.id}:${s.bottom.id}`;
  return { project, g1, g2, up, keys: new Set([key]) };
}

test('extendDividerExtents: 上階の同座標の中心線の区間が足元の辺に届かなければ、辺まで延びる（延ばした本数を返す）', () => {
  const { project, g1, g2, up, keys } = cellFixture({ right: { extentLo: 0, extentHi: 300 } });
  const n = extendDividerExtents(keys, g1, project.structGraph, g2);
  assert.equal(n, 1);
  assert.equal(up.right.extentLo, 0);
  assert.equal(up.right.extentHi, 1000, '右辺（x=1000, y 0..1000）を覆うまで延びる');
});

test('extendDividerExtents: 区間が既に辺を覆っていれば何も変えない（延びるのは覆うまでだけ）', () => {
  const { project, g1, g2, up, keys } = cellFixture({ right: { extentLo: -500, extentHi: 1500 } });
  assert.equal(extendDividerExtents(keys, g1, project.structGraph, g2), 0);
  assert.deepEqual([up.right.extentLo, up.right.extentHi], [-500, 1500], '広い区間も縮めない');
  const bytesBefore = JSON.stringify(g2.centerLines.map(c => [c.id, c.extentLo, c.extentHi]));
  extendDividerExtents(keys, g1, project.structGraph, g2);
  assert.equal(JSON.stringify(g2.centerLines.map(c => [c.id, c.extentLo, c.extentHi])), bytesBefore);
});

test('extendDividerExtents（明示 vs 省略）: 区間が届かない上階では、addMissingCLs だけでは区間は延びず、extendDividerExtents を足すと延びる', () => {
  const { project, g1, g2, up, keys } = cellFixture({ right: { extentLo: 0, extentHi: 300 } });
  addMissingCLs(collectNeededCLs(keys, g1), g1, project.structGraph, g2);
  assert.equal(up.right.extentHi, 300, 'addMissingCLs は同座標の中心線があれば区間を見ない（既存挙動のまま）');
  extendDividerExtents(keys, g1, project.structGraph, g2);
  assert.equal(up.right.extentHi, 1000);
});

test('extendDividerExtents: 同座標の中心線が無い辺は何もしない（足すのは addMissingCLs の担当）', () => {
  const { project, g1, g2, keys } = cellFixture();
  for (const cl of [...g2.centerLines].filter(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000)) g2.removeCenterLine(cl.id);
  const before = g2.centerLines.length;
  assert.equal(extendDividerExtents(keys, g1, project.structGraph, g2), 0);
  assert.equal(g2.centerLines.length, before, '中心線は増えない');
});

test('extendDividerExtents: 同座標が梁芯だけなら（addMissingCLs が対応先ありとみなした辺）、辺の区間だけの分割線を足す', () => {
  const { project, g1, g2, keys } = cellFixture();
  for (const cl of [...g2.centerLines].filter(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000)) g2.removeCenterLine(cl.id);
  g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  assert.equal(extendDividerExtents(keys, g1, project.structGraph, g2), 1);
  const div = findCounterpartCL(g2, CenterLineType.VERTICAL, 1000, isFinishCellDivider);
  assert.ok(div, '分割線が追加された');
  assert.deepEqual([div.extentLo, div.extentHi], [0, 1000]);
});

// 同座標・同種別の分割線の区間が互いに素（重ならない）か
function dividerSpansDisjoint(graph, type, value) {
  const spans = graph.centerLines.filter(c => c.centerLineType === type && c.value === value && isFinishCellDivider(c))
    .map(c => [c.extentLo, c.extentHi]).sort((a, b) => a[0] - b[0]);
  return spans.every((s, i) => i === 0 || s[0] >= spans[i - 1][1]);
}

test('extendDividerExtents: 辺まで延ばした先で別ピースにちょうど接したら1本に結合し、同座標の区間は互いに素のまま（重なりを作らない）', () => {
  const { project, g1, g2, up, keys } = cellFixture({ right: { extentLo: -500, extentHi: 300 } });
  const other = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { ...ARCH, extentLo: 1000, extentHi: 2500 });
  extendDividerExtents(keys, g1, project.structGraph, g2);
  const rights = g2.centerLines.filter(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000);
  assert.equal(rights.length, 1, '接した2本は1本に結合された');
  assert.equal(rights[0].id, up.right.id, '下側のピースの id が残る');
  assert.deepEqual([rights[0].extentLo, rights[0].extentHi], [-500, 2500]);
  assert.equal(g2.shapeMap.has(other.id), false, '吸収されたピースの id は無い');
  assert.ok(dividerSpansDisjoint(g2, CenterLineType.VERTICAL, 1000));
});

test('mergeAdjacentDividers: 結合して復元した後の壁は、読み込み経路と同じ補修（healDerivedGeometry）を通した状態と一致する', () => {
  // 出隅が未補修の壁（generateExteriorWalls 直後）を持つ階。同座標の接する2本（x=1500 の [0,1500]・[1500,3000]）を結合する
  const make = () => {
    const g = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
    const A = { labeled: false, discipline: Discipline.ARCH };
    const x0 = g.addCenterLine(CenterLineType.VERTICAL, 0, A), x3 = g.addCenterLine(CenterLineType.VERTICAL, 3000, A);
    const yN = g.addCenterLine(CenterLineType.HORIZONTAL, -3000, A), y0 = g.addCenterLine(CenterLineType.HORIZONTAL, 0, A);
    const y3 = g.addCenterLine(CenterLineType.HORIZONTAL, 3000, A);
    g.addRoom(new Set([`${x0.id}:${y0.id}:${x3.id}:${y3.id}`]), 'A');
    g.addRoom(new Set([`${x0.id}:${yN.id}:${x3.id}:${y0.id}`]), '庭').setKind(RoomKind.EXTERIOR);
    const lo = g.addCenterLine(CenterLineType.VERTICAL, 1500, { ...A, extentLo: 0, extentHi: 1500 });
    const hi = g.addCenterLine(CenterLineType.VERTICAL, 1500, { ...A, extentLo: 1500, extentHi: 3000 });
    generateExteriorWalls(g, { wallBase: 120, wallFinish: 12.5 });
    return { g, lo, hi };
  };
  const coords = (g) => g.walls.map(w => `${w.isVertical}:${Math.round(w.axisValue)}:${Math.round(w.coord1)}:${Math.round(w.coord2)}`).sort();
  const ref = make();
  assert.ok(healDerivedGeometry(ref.g) > 0, '前提: 未補修の出隅がある（補修で端が動く）');
  const t = make();
  const before = coords(t.g);
  assert.equal(mergeAdjacentDividers(t.g, t.lo.id, t.hi.id), true);
  assert.notDeepEqual(coords(t.g), before, '結合後の復元で出隅が補修された（未補修のままではない）');
  assert.deepEqual(coords(t.g), coords(ref.g), '補修のみを通した状態と一致');
  assert.equal(healDerivedGeometry(t.g), 0, '冪等');
});

test('extendDividerExtents: 吸収されたピースを参照するキー（部屋のセル・壁の軸・他の線の区間参照）は結合後の id へ付け替わる', () => {
  const { project, g1, g2, up, keys } = cellFixture({ right: { extentLo: -500, extentHi: 300 } });
  const other = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { ...ARCH, extentLo: 1000, extentHi: 2500 });
  const h = g2.addCenterLine(CenterLineType.HORIZONTAL, 700, { ...ARCH, extentLoRef: { clId: other.id, offset: 0 }, extentHiRef: { clId: other.id, offset: 500 } });
  const room = g2.addRoom(new Set([`${up.left.id}:${up.top.id}:${other.id}:${up.bottom.id}`]), '部屋');
  extendDividerExtents(keys, g1, project.structGraph, g2);
  assert.equal(g2.shapeMap.has(other.id), false);
  assert.equal(g2.roomMap.get(room.id).cells.has(`${up.left.id}:${up.top.id}:${up.right.id}:${up.bottom.id}`), true, '部屋のセルキーが結合後の id へ');
  const h2 = g2.shapeMap.get(h.id);
  assert.equal(h2.extentLoRef.clId, up.right.id, '他の線の extent 参照も付け替わる');
  assert.equal(h2.extentHiRef.clId, up.right.id);
});

test('extendDividerExtents: 吸収されるピースと生き残るピースの両方に偏芯レコードがあるときは結合せず、接した2本のまま（衝突を黙って決めない）', () => {
  const { project, g1, g2, up, keys } = cellFixture({ right: { extentLo: -500, extentHi: 300 } });
  const other = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { ...ARCH, extentLo: 1000, extentHi: 2500 });
  g2.setCLEccentricity(up.right.id, { finishSide: 'both' });
  g2.setCLEccentricity(other.id, { finishSide: 'both' });
  extendDividerExtents(keys, g1, project.structGraph, g2);
  const rights = g2.centerLines.filter(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000);
  assert.equal(rights.length, 2, '結合されない');
  assert.equal(g2.shapeMap.get(up.right.id).extentHi, 1000, '延長だけは行われ、接している');
  assert.ok(dividerSpansDisjoint(g2, CenterLineType.VERTICAL, 1000));
});

test('extendDividerExtents: 足元どうしの内部の辺（隣のセルも足元）には分割線の区間を延ばさない', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const mk = (g, t, v, ext) => g.addCenterLine(t, v, { ...ARCH, ...(ext ?? {}) });
  const a = mk(g1, CenterLineType.VERTICAL, 0), b = mk(g1, CenterLineType.HORIZONTAL, 0);
  const c = mk(g1, CenterLineType.VERTICAL, 1000), d = mk(g1, CenterLineType.HORIZONTAL, 1000);
  const e = mk(g1, CenterLineType.VERTICAL, 2000);
  mk(g2, CenterLineType.VERTICAL, 0); mk(g2, CenterLineType.HORIZONTAL, 0); mk(g2, CenterLineType.HORIZONTAL, 1000);
  mk(g2, CenterLineType.VERTICAL, 2000);
  const mid = mk(g2, CenterLineType.VERTICAL, 1000, { extentLo: 0, extentHi: 100 }); // 2セルの境界
  const keys = new Set([`${a.id}:${b.id}:${c.id}:${d.id}`, `${c.id}:${b.id}:${e.id}:${d.id}`]);
  extendDividerExtents(keys, g1, project.structGraph, g2);
  assert.deepEqual([mid.extentLo, mid.extentHi], [0, 100], '内部の辺の分割線は延ばさない');
});

test('retargetKeysToCoveringCLs: 同座標に区間の違うピースが複数あるとき、辺を覆うピースの id へ付け替える。覆っていれば不変・覆うものが無ければ元のまま', () => {
  const { project, g1, g2, up } = cellFixture({ right: { extentLo: 2000, extentHi: 3000 } }); // translate が拾う先頭は覆わない
  const covering = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { ...ARCH, extentLo: 0, extentHi: 1000 });
  const keys = translateCellSet(new Set([...cellFixtureKeys(g1)]), g1, project.structGraph, g2);
  const [translated] = keys;
  assert.ok(translated.split(':')[2] === up.right.id, '前提: 最初の1本（覆わない方）がキーに入っている');
  const [fixed] = retargetKeysToCoveringCLs(keys, g2, project.structGraph);
  assert.equal(fixed.split(':')[2], covering.id, '覆うピースへ付け替わる');
  assert.equal(retargetKeysToCoveringCLs(new Set([fixed]), g2, project.structGraph).has(fixed), true, '覆っていれば不変');
  g2.removeCenterLine(covering.id);
  assert.equal(retargetKeysToCoveringCLs(keys, g2, project.structGraph).has(translated), true, '覆うものが無ければ元のまま');
});
function cellFixtureKeys(g1) {
  const [l, t, r, b] = [
    [CenterLineType.VERTICAL, 0], [CenterLineType.HORIZONTAL, 0], [CenterLineType.VERTICAL, 1000], [CenterLineType.HORIZONTAL, 1000],
  ].map(([ty, v]) => g1.centerLines.find(c => c.centerLineType === ty && c.value === v));
  return [`${l.id}:${t.id}:${r.id}:${b.id}`];
}
