// centerLineOps.test.js 等と同じ方針: ダックタイピングでは effectiveValue・centerLines・
// structGraph連携の実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, centerLineKind } from '../core.js';
import {
  isEndpointAt, findExtendBoundary, findShortenBoundary,
  canExtendCenterLine, canShortenCenterLine, extendCenterLine, shortenCenterLine,
} from './centerLineExtend.js';
import { composeUndoWithMergeChain } from './centerLineMerge.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

function makeProjectWithGraph() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// ---- 3階再現: 通り芯X1(0)・X2(1820)・梁芯のみ(2730)・X3(3640)。主体は水平の中心線 extent [X1,X2]。
// 梁芯(2730)は平面モードでは非表示（下階の壁から自階へ自動生成される想定）だが、種別無差別走査
// （移行前のcrossingPerpCLs）だとこれが延長・短縮の境界に選ばれてしまっていた不良の再現。

test('findExtendBoundary/extendCenterLine: 中心線のhi延長は非表示の梁芯(2730)を素通りし通り芯X3(3640)まで届く（3階再現）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT }); // X1
  graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT }); // X2
  graph.addCenterLine(CenterLineType.VERTICAL, 2730, { // 梁芯のみ。extentが主体のyを含む
    labeled: false, discipline: Discipline.FUSE, extentLo: -20000, extentHi: 20000,
  });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, -8190, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 1820,
  });

  const boundary = findExtendBoundary(graph, cl, 'hi');
  assert.equal(boundary.type, 'cl');
  assert.equal(boundary.item.id, x3.id);
  assert.equal(centerLineKind(boundary.item), 'struct');

  const result = extendCenterLine(graph, cl, 'hi', null);
  assert.equal(result.extended, true);
  assert.equal(cl.extentHiRef?.clId, x3.id);
  assert.equal(cl.extentHi, 3640);
});

test('findShortenBoundary/shortenCenterLine: [X1,X3]の中心線のhi短縮は梁芯(2730)で止まらずX2(1820)になる（短縮の同型）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT }); // X1
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 2730, {
    labeled: false, discipline: Discipline.FUSE, extentLo: -20000, extentHi: 20000,
  });
  graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT }); // X3
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, -8190, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 3640,
  });

  const boundary = findShortenBoundary(graph, cl, 'hi');
  assert.equal(boundary.type, 'cl');
  assert.equal(boundary.item.id, x2.id);

  const result = shortenCenterLine(graph, cl, 'hi', null);
  assert.equal(result.shortened, true);
  assert.equal(cl.extentHiRef?.clId, x2.id);
  assert.equal(cl.extentHi, 1820);
});

// ---- 参照先優先: 既に梁芯まで延長済みのデータが「端点」に固定されず、次の延長操作で可視の線へ移る自己修復。

test('isEndpointAt/canExtendCenterLine: 端が既に梁芯を参照済み（extentHiRef=梁芯id, extentHi=2730）の中心線は端点でなく、延長すると通り芯X3へ移る（参照先優先）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT }); // X1
  const beamOnly = graph.addCenterLine(CenterLineType.VERTICAL, 2730, {
    labeled: false, discipline: Discipline.FUSE, extentLo: -20000, extentHi: 20000,
  });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });

  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, -8190, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHiRef: { clId: beamOnly.id, offset: 0 },
  });
  assert.equal(cl.extentHi, 2730, '前提: 既に梁芯まで延長済み');
  assert.equal(cl._extentHiCL, beamOnly, '前提: 参照先が解決済み');

  assert.equal(isEndpointAt(graph, cl, 'hi'), false, '参照先優先: 生きた梁芯まで届いているので端点ではない');
  assert.equal(canExtendCenterLine(graph, cl, 'hi'), true);

  const result = extendCenterLine(graph, cl, 'hi', null);
  assert.equal(result.extended, true);
  assert.equal(cl.extentHiRef?.clId, x3.id, '延長すると通り芯X3へ移る');
  assert.equal(cl.extentHi, 3640);
});

test('【対照・端点ルールの回帰】isEndpointAt: 参照先が無く直交する候補も無い端は従来どおり端点(true)になる', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 遠い（9999には無関係）
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, -8190, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 9999, // 9999には何も無い
  });
  assert.equal(isEndpointAt(graph, cl, 'hi'), true);
  assert.equal(canExtendCenterLine(graph, cl, 'hi'), false, '外側に境界が無いので延長不可');
});

test('isEndpointAt: 参照先CLが（自グラフから見て）届いていない場合は参照先優先をスキップし通常の述語走査に落ちる（削除済み/クロスグラフの再現）', () => {
  const { project, graph } = makeProjectWithGraph();
  // 自階での削除は必ず _extentLoCL/_extentHiCL をクリアする（planGraph.js の
  // detachFromCenterLine → setCenterLineExtentRef(ref:null) が同一graph内の依存CLを即座に
  // 書き換えるため）。ここで再現しているのは「通り芯（project.structGraph側で共有）の削除は
  // アクティブ階の detachFromCenterLine しか即時反映されない」既存挙動（非アクティブ階は取り残される。
  // transform/centerLineConvert.js:65 コメント「通り芯削除の既存挙動＝アクティブ階の
  // detachFromCenterLineのみが即時反映される」参照）——この graph を「非アクティブ階」に見立て、
  // project.structGraph 側だけで削除することで、cl._extentHiCLが古いオブジェクト参照のまま
  // 残る状態を再現する。
  const orphan = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 2730, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, -8190, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHiRef: { clId: orphan.id, offset: 0 },
  });
  assert.equal(cl._extentHiCL, orphan, '前提: 参照先が解決済み');

  project.structGraph.removeCenterLine(orphan.id);
  assert.equal(graph.centerLines.some(c => c.id === orphan.id), false, '前提: orphanはgraph.centerLinesから消えている');
  assert.equal(cl._extentHiCL, orphan, '前提: _extentHiCLは自動クリアされず古いオブジェクト参照を保持したまま');

  assert.equal(isEndpointAt(graph, cl, 'hi'), true, '参照先優先をスキップし、通常の述語走査（候補なし）でtrue');
});

// ---- 移行による意図的な端点判定の変化: 端が梁芯としか交差しない中心線は、参照が無ければ
// 端点(true)になる（梁芯はorthoAnchorKinds(center)の候補外のため）。renderer/wallDrawPlan.js の
// wrapEnds（detail LODの壁描画で仕上げ材の端部回り込みを判定する）が isEndpointAt を使っており、
// この変化が実際の描画に影響する。

test('isEndpointAt: 端が梁芯としか交差しない中心線（参照なし・静的extent）は端点になる（移行による意図的変化。wallDrawPlanのwrapEndsに効く）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 通り芯
  graph.addCenterLine(CenterLineType.VERTICAL, 1820, { // 梁芯。extentが主体のyを含む
    labeled: false, discipline: Discipline.FUSE, extentLo: -20000, extentHi: 20000,
  });
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, -100, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 1820, // 参照なし・静的extent
  });

  assert.equal(isEndpointAt(graph, cl, 'hi'), true, '梁芯はorthoAnchorKinds(center)の候補外のため端点になる（移行前はfalseだった）');
  assert.equal(isEndpointAt(graph, cl, 'lo'), false, 'lo側は通り芯(0)と交差しているため端点ではない');
  assert.equal(canExtendCenterLine(graph, cl, 'hi'), false, '外側に境界が無いので延長不可（端点だからではない）');
});

test('isEndpointAt: 同じ端が extentHiRef で梁芯を参照済みなら参照先優先でfalseのまま（上のテストとの対比）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const beamOnly = graph.addCenterLine(CenterLineType.VERTICAL, 1820, {
    labeled: false, discipline: Discipline.FUSE, extentLo: -20000, extentHi: 20000,
  });
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, -100, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHiRef: { clId: beamOnly.id, offset: 0 },
  });
  assert.equal(cl.extentHi, 1820, '前提: 梁芯を参照済み');

  assert.equal(isEndpointAt(graph, cl, 'hi'), false, '参照先優先: 生きた梁芯まで届いているので端点ではない（静的extentの場合と結果が割れる）');
});

// ---- 梁芯の延長・短縮は通り芯のみ（2026-09-18裁定。追加extentと同じ規約に揃える）。

test('findExtendBoundary: 梁芯を主体にした延長は手前の中心線・補助線・他の梁芯を素通りし通り芯のみで止まる', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 1000,
  });
  graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH }); // 中心線（手前・素通り）
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, lineType: 'dashed' });           // 補助線（手前・素通り）
  graph.addCenterLine(CenterLineType.VERTICAL, 2500, { labeled: false, discipline: Discipline.FUSE });  // 他の梁芯（手前・素通り）
  const structFar = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });

  const boundary = findExtendBoundary(graph, cl, 'hi');
  assert.equal(boundary.type, 'cl');
  assert.equal(boundary.item.id, structFar.id);
});

test('findShortenBoundary: 梁芯を主体にした短縮も手前の中心線・補助線・他の梁芯を素通りし通り芯のみで止まる', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH }); // 中心線（内側・素通り）
  graph.addCenterLine(CenterLineType.VERTICAL, 800, { labeled: false, lineType: 'dashed' });           // 補助線（内側・素通り）
  graph.addCenterLine(CenterLineType.VERTICAL, 900, { labeled: false, discipline: Discipline.FUSE });  // 他の梁芯（内側・素通り）
  const structNear = graph.addCenterLine(CenterLineType.VERTICAL, 200, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 1000,
  });

  const boundary = findShortenBoundary(graph, cl, 'hi'); // hi側の内側=coordより小さい値
  assert.equal(boundary.type, 'cl');
  assert.equal(boundary.item.id, structNear.id);
});

// ---- 補助線: 壁が境界候補になる現行動作の維持、梁芯は境界にならない。

test('findExtendBoundary: 補助線の延長は壁を境界候補に含め、手前の梁芯は候補にしない（現行動作の維持）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, lineType: 'dashed', extentLo: 0, extentHi: 1000,
  });
  graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.FUSE }); // 梁芯（手前・候補にならない）

  const wallAxis  = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const wallStart = graph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const wallEnd   = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000,  { labeled: true, discipline: Discipline.STRUCT });
  const wall = graph.addWall(wallAxis, 0, true, wallStart, 0, wallEnd, 0, { isExteriorWall: false });

  const boundary = findExtendBoundary(graph, cl, 'hi');
  assert.equal(boundary.type, 'wall');
  assert.equal(boundary.item.id, wall.id);
});

test('extendCenterLine: 延長先CLが既に別の補助線から参照済みならref化される（はね出しにならない）', () => {
  const graph = makeGraph();
  const boundary = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT }); // 通り芯X3
  // 既に別の補助線がboundaryをextentHiRefで参照している状態を作る（cl自身とは別方向=HORIZONTALにして
  // cl自身の直交候補探索には混ざらないようにする——isReferencedByAuxの走査対象になることだけが目的）。
  graph.addCenterLine(CenterLineType.HORIZONTAL, -3000, {
    labeled: false, lineType: 'dashed', extentHiRef: { clId: boundary.id, offset: 0 }, extentLo: -4000,
  });
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, -8190, {
    labeled: false, lineType: 'dashed', extentLo: 0, extentHi: 1820,
  });

  const result = extendCenterLine(graph, cl, 'hi', null);
  assert.equal(result.extended, true);
  assert.deepEqual(cl.extentHiRef, { clId: boundary.id, offset: 0 }, '境界CLが既に別のauxから参照済みなのでref化される');
  assert.equal(cl.extentHi, 3640, 'boundaryの値そのまま（overhangを足していない）');
});

// ---- 旧データ（labeled:trueなのに種別が通り芯でないCL。通常のAddCLDialog経路では作られない異常値）の
// 扱いが移行前後で変わる2通り（ファイル冒頭コメント参照。現行の生成経路は0件の理論上の差分）。

test('【旧データ】findExtendBoundary: labeled:trueな非通り芯CLは相手にならない（旧実装は無条件に届いている扱いだった）', () => {
  // (i) 主体が中心線、相手が labeled:true な梁芯（本来discipline:'fuse'）という異常値。
  {
    const graph = makeGraph();
    graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: true, discipline: Discipline.FUSE }); // 近い（異常値）
    const structFar = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
    const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
      labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 200,
    });
    const boundary = findExtendBoundary(graph, cl, 'hi');
    assert.equal(boundary.type, 'cl');
    assert.equal(boundary.item.id, structFar.id, '(i) labeled:trueな梁芯(500)ではなく通り芯(2000)が選ばれる');
  }
  // (ii) 主体が梁芯、相手が labeled:true な中心線（本来discipline:'arch'）という異常値。
  {
    const graph = makeGraph();
    graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: true, discipline: Discipline.ARCH }); // 近い（異常値）
    const structFar = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
    const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
      labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 200,
    });
    const boundary = findExtendBoundary(graph, cl, 'hi');
    assert.equal(boundary.type, 'cl');
    assert.equal(boundary.item.id, structFar.id, '(ii) labeled:trueな中心線(500)ではなく通り芯(2000)が選ばれる');
  }
});

// ================================================================
// 【失敗系】
// ================================================================

test('【失敗系】findExtendBoundary: 境界が無ければnull、extendCenterLineはextended:falseを返す', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 1000,
  });
  // 直交CL・壁を一切置かない

  assert.equal(findExtendBoundary(graph, cl, 'hi'), null);
  assert.deepEqual(extendCenterLine(graph, cl, 'hi', null), { extended: false });
});

test('中心線の端点(isEndpointAt:true)は外側に境界があれば延長できる（短縮はshortened:falseのまま）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 9999, // 9999に何も無い＝端点
  });
  const far = graph.addCenterLine(CenterLineType.VERTICAL, 20000, { labeled: true, discipline: Discipline.STRUCT }); // 外側の境界

  assert.equal(isEndpointAt(graph, cl, 'hi'), true);
  assert.equal(canExtendCenterLine(graph, cl, 'hi'), true);
  assert.deepEqual(shortenCenterLine(graph, cl, 'hi', null), { shortened: false });
  const result = extendCenterLine(graph, cl, 'hi', null);
  assert.equal(result.extended, true);
  assert.equal(cl.extentHiRef?.clId, far.id);
  assert.equal(cl.extentHi, 20000);
});

// 端が梁芯としか交差しない中心線（参照なし・静的extent）。hi端 1820 は梁芯上＝端点。外側 3000 に直交の中心線。
function makeBeamOnlyEndGraph() {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 通り芯
  graph.addCenterLine(CenterLineType.VERTICAL, 1820, { // 梁芯。extentが主体のyを含む
    labeled: false, discipline: Discipline.FUSE, extentLo: -20000, extentHi: 20000,
  });
  const outer = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { // 外側の中心線。extentが主体のyを含む
    labeled: false, discipline: Discipline.ARCH, extentLo: -1000, extentHi: 1000,
  });
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, -100, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 1820, // 参照なし・静的extent
  });
  return { graph, cl, outer };
}

test('端が梁芯としか交差しない中心線の端点は延長でき、baseUndo/baseRedoで往復する（報告の再現）', () => {
  const { graph, cl, outer } = makeBeamOnlyEndGraph();
  assert.equal(isEndpointAt(graph, cl, 'hi'), true, '前提: 端点');
  assert.equal(cl.extentHiRef, null, '前提: 参照なし');
  assert.equal(cl._extentHi, 1820, '前提: 静的値');

  assert.equal(canExtendCenterLine(graph, cl, 'hi'), true);
  const result = extendCenterLine(graph, cl, 'hi', null);
  assert.equal(result.extended, true);
  assert.equal(cl.extentHiRef?.clId, outer.id);
  assert.equal(cl.extentHi, 3000);
  assert.equal(isEndpointAt(graph, cl, 'hi'), false, '延長後は直交CLに乗る＝端点でない');

  result.baseUndo();
  assert.equal(cl.extentHiRef, null);
  assert.equal(cl._extentHi, 1820);
  assert.equal(cl.extentHi, 1820);
  assert.equal(isEndpointAt(graph, cl, 'hi'), true, 'undoで端点に戻る');

  result.baseRedo();
  assert.equal(cl.extentHiRef?.clId, outer.id);
  assert.equal(cl.extentHi, 3000);
});

test('【失敗系】中心線の端点でも外側に境界が無ければcanExtend:false・extended:false', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 9999,
  });
  graph.addCenterLine(CenterLineType.VERTICAL, -500, { labeled: true, discipline: Discipline.STRUCT }); // 内側（lo側）にしか無い

  assert.equal(isEndpointAt(graph, cl, 'hi'), true);
  assert.equal(findExtendBoundary(graph, cl, 'hi'), null);
  assert.equal(canExtendCenterLine(graph, cl, 'hi'), false);
  assert.deepEqual(extendCenterLine(graph, cl, 'hi', null), { extended: false });
});

test('【失敗系】梁芯の端点は外側に通り芯があっても延長不可（端点からの延長は中心線のみ）', () => {
  const graph = makeGraph();
  const beam = graph.addCenterLine(CenterLineType.HORIZONTAL, -100, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 9999, // 9999に何も無い＝端点
  });
  graph.addCenterLine(CenterLineType.VERTICAL, 20000, { labeled: true, discipline: Discipline.STRUCT }); // 外側に通り芯

  assert.equal(centerLineKind(beam), 'beam');
  assert.equal(isEndpointAt(graph, beam, 'hi'), true);
  assert.notEqual(findExtendBoundary(graph, beam, 'hi'), null, '前提: 外側に境界はある');
  assert.equal(canExtendCenterLine(graph, beam, 'hi'), false);
  assert.deepEqual(extendCenterLine(graph, beam, 'hi', null), { extended: false });
  assert.equal(beam.extentHi, 9999, '無変更');
});

test('【失敗系】短縮は中心線の端点でもcanShorten:false・shortened:falseのまま（延長を許す表は短縮に効かない）', () => {
  const { graph, cl } = makeBeamOnlyEndGraph();
  assert.equal(isEndpointAt(graph, cl, 'hi'), true);
  assert.notEqual(findShortenBoundary(graph, cl, 'hi'), null, '前提: 端点でなければ短縮境界はある');
  assert.equal(canShortenCenterLine(graph, cl, 'hi'), false);
  assert.deepEqual(shortenCenterLine(graph, cl, 'hi', null), { shortened: false });
  assert.equal(cl.extentHi, 1820, '無変更');
});

test('【失敗系】findShortenBoundary: extentLo===extentHi（1点線分）はnull（短縮不可）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 500, extentHi: 500,
  });
  assert.equal(findShortenBoundary(graph, cl, 'lo'), null);
  assert.equal(findShortenBoundary(graph, cl, 'hi'), null);
});

test('【失敗系】canShortenCenterLine: 1点線分は短縮不可（false）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 500, extentHi: 500,
  });
  assert.equal(canShortenCenterLine(graph, cl, 'hi'), false);
});

// ---- 延長の重なり禁止（2026-10-03 裁定）: 現在の端から延長先までに同軸・同種別の別ピースが掛かる延長は不可。
// 理由: 延長後の mergeCenterLineChain は端が1組だけ一致すれば隣接とみなし、重なった相手を吸収して消すため。

const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;

// type 方向の線（line）と、それに直交する通り芯（grid）を足せる小道具。
function axisKit(type) {
  const graph = makeGraph();
  const perp = type === V ? H : V;
  const grid = (v) => graph.addCenterLine(perp, v, { labeled: true, discipline: Discipline.STRUCT });
  const line = (value, lo, hi, discipline = Discipline.ARCH, extra = {}) =>
    graph.addCenterLine(type, value, { labeled: false, discipline, extentLo: lo, extentHi: hi, ...extra });
  return { graph, grid, line };
}
const stateOf = (cl) => ({ lo: cl.extentLo, hi: cl.extentHi, loRef: cl.extentLoRef, hiRef: cl.extentHiRef, _lo: cl._extentLo, _hi: cl._extentHi });

test('【ガード(a)】水平: 同軸の別ピースBが現在の端ちょうど(B.lo==A.hi)から延長方向へ伸びる（QAの再現）と延長不可・無変更・Bは生存', () => {
  const { graph, grid, line } = axisKit(H);
  const x0 = grid(0); // 1820 の位置には直交線を置かない（A の hi は端点）
  const x2 = grid(3640);
  const a = line(0, 0, 1820); graph.setCenterLineExtentRef(a, 'lo', { clId: x0.id, offset: 0 }, null);
  const b = line(0, 1820, 3640); graph.setCenterLineExtentRef(b, 'hi', { clId: x2.id, offset: 0 }, null);
  const beforeA = stateOf(a), beforeB = stateOf(b);

  assert.equal(isEndpointAt(graph, a, 'hi'), true, '前提: A の hi は端点（ステップ1で延長は許される状態）');
  assert.notEqual(findExtendBoundary(graph, a, 'hi'), null, '前提: 境界（X2）はある');
  assert.equal(canExtendCenterLine(graph, a, 'hi'), false);
  assert.deepEqual(extendCenterLine(graph, a, 'hi', null), { extended: false });
  assert.deepEqual(stateOf(a), beforeA);
  assert.deepEqual(stateOf(b), beforeB);
  assert.ok(graph.centerLines.includes(b), 'B は消えない');
});

test('【ガード(a)】垂直・lo側: 同軸の別ピースBが現在の端ちょうど(B.hi==A.lo)から延長方向へ伸びると延長不可・無変更', () => {
  const { graph, grid, line } = axisKit(V);
  grid(0); const yFar = grid(-3640);
  const a = line(0, -1820, 0);
  const b = line(0, -3640, -1820); graph.setCenterLineExtentRef(b, 'lo', { clId: yFar.id, offset: 0 }, null);
  const beforeA = stateOf(a), beforeB = stateOf(b);

  assert.equal(isEndpointAt(graph, a, 'lo'), true);
  assert.equal(canExtendCenterLine(graph, a, 'lo'), false);
  assert.deepEqual(extendCenterLine(graph, a, 'lo', null), { extended: false });
  assert.deepEqual(stateOf(a), beforeA);
  assert.deepEqual(stateOf(b), beforeB);
  assert.ok(graph.centerLines.includes(b));
});

test('【ガード(b)】区間の途中から始まる同軸ピースは延長不可（水平hi側・垂直lo側）', () => {
  const h = axisKit(H);
  h.grid(3000);
  const ah = h.line(0, 0, 1000); h.line(0, 2000, 5000);
  assert.equal(canExtendCenterLine(h.graph, ah, 'hi'), false);
  assert.deepEqual(extendCenterLine(h.graph, ah, 'hi', null), { extended: false });
  assert.equal(ah.extentHi, 1000);

  const v = axisKit(V);
  v.grid(-3000);
  const av = v.line(0, -1000, 0); v.line(0, -5000, -2000);
  assert.equal(canExtendCenterLine(v.graph, av, 'lo'), false);
  assert.deepEqual(extendCenterLine(v.graph, av, 'lo', null), { extended: false });
  assert.equal(av.extentLo, -1000);
});

test('【ガード(b)】extent が null（全軸）の同軸・同種別ピースがあれば安全側で延長不可', () => {
  const { graph, grid, line } = axisKit(H);
  grid(3000);
  const a = line(0, 0, 1000);
  const b = line(0, null, null); // 全軸扱い（extent を持たない）
  assert.equal(b.extentLo, null, '前提: extent が null');
  assert.equal(canExtendCenterLine(graph, a, 'hi'), false);
  const r = extendCenterLine(graph, a, 'hi', null);
  assert.equal(r.extended, false);
  assert.equal(a.extentHi, 1000, '延長されず無変更');
  assert.ok(graph.centerLines.includes(b), 'B は消えない');
});

test('【ガード(c)】境界ちょうどから始まる同軸ピースBは延長でき、隣接結合で1本になる。composeUndoWithMergeChain の undo/redo で往復する', () => {
  const { graph, grid, line } = axisKit(H);
  const x0 = grid(0); const x3 = grid(3000); const x6 = grid(6000);
  const a = line(-100, 0, 1820); graph.setCenterLineExtentRef(a, 'lo', { clId: x0.id, offset: 0 }, null);
  const b = line(-100, 3000, 6000);
  graph.setCenterLineExtentRef(b, 'lo', { clId: x3.id, offset: 0 }, null);
  graph.setCenterLineExtentRef(b, 'hi', { clId: x6.id, offset: 0 }, null);
  const beforeA = stateOf(a);

  assert.equal(canExtendCenterLine(graph, a, 'hi'), true);
  const r = extendCenterLine(graph, a, 'hi', null);
  assert.equal(r.extended, true);
  assert.equal(r.chainResult.merged, true);
  assert.equal(r.chainResult.survivorId, a.id);
  assert.equal(graph.centerLines.some(c => c.id === b.id), false, 'B は吸収されて消える');
  assert.equal(a.extentHi, 6000);
  assert.equal(a.extentHiRef?.clId, x6.id);
  const afterA = stateOf(a);

  const [undo, redo] = composeUndoWithMergeChain(r.baseUndo, r.baseRedo, r.chainResult);
  undo();
  assert.deepEqual(stateOf(a), beforeA, 'A は端点・静的値に戻る');
  const b2 = graph.centerLines.find(c => c.id === b.id);
  assert.ok(b2, 'B が復活する');
  assert.equal(b2.extentLo, 3000);
  assert.equal(b2.extentHi, 6000);
  redo();
  assert.deepEqual(stateOf(a), afterA, 'redo で延長後と一致');
  assert.equal(graph.centerLines.some(c => c.id === b.id), false);
});

test('【ガード(d)】区間の内側に厳密にある1点線分は延長不可。現在の端ちょうど・境界ちょうどの1点線分は影響なし', () => {
  const inner = axisKit(H);
  inner.grid(3000);
  const a1 = inner.line(0, 0, 1000); inner.line(0, 2000, 2000);
  assert.equal(canExtendCenterLine(inner.graph, a1, 'hi'), false);
  assert.deepEqual(extendCenterLine(inner.graph, a1, 'hi', null), { extended: false });

  const innerV = axisKit(V);
  innerV.grid(-3000);
  const a1v = innerV.line(0, -1000, 0); innerV.line(0, -2000, -2000);
  assert.equal(canExtendCenterLine(innerV.graph, a1v, 'lo'), false);

  const edge = axisKit(H);
  edge.grid(3000);
  const a2 = edge.line(0, 0, 1000);
  edge.line(0, 1000, 1000); // 現在の端ちょうど
  edge.line(0, 3000, 3000); // 境界ちょうど
  assert.equal(canExtendCenterLine(edge.graph, a2, 'hi'), true);
  assert.equal(extendCenterLine(edge.graph, a2, 'hi', null).extended, true);
});

test('【ガード(e)】交点からの延長（端点でない端）でも、区間に同軸の中心線ピースが掛かれば延長不可（垂直・lo側／水平・hi側）', () => {
  const v = axisKit(V);
  const y1 = v.grid(-1820); v.grid(-3640); const y0 = v.grid(0);
  const a = v.line(0, -1820, 0);
  v.graph.setCenterLineExtentRef(a, 'lo', { clId: y1.id, offset: 0 }, null);
  v.graph.setCenterLineExtentRef(a, 'hi', { clId: y0.id, offset: 0 }, null);
  v.line(0, -3000, -2500);
  assert.equal(isEndpointAt(v.graph, a, 'lo'), false, '前提: 端点でない端（交点）');
  assert.notEqual(findExtendBoundary(v.graph, a, 'lo'), null, '前提: 境界（-3640）はある');
  assert.equal(canExtendCenterLine(v.graph, a, 'lo'), false);
  assert.deepEqual(extendCenterLine(v.graph, a, 'lo', null), { extended: false });
  assert.equal(a.extentLo, -1820);

  const h = axisKit(H);
  const x0 = h.grid(0); const x1 = h.grid(1820); h.grid(3640);
  const ah = h.line(0, 0, 1820);
  h.graph.setCenterLineExtentRef(ah, 'lo', { clId: x0.id, offset: 0 }, null);
  h.graph.setCenterLineExtentRef(ah, 'hi', { clId: x1.id, offset: 0 }, null);
  h.line(0, 2500, 3000);
  assert.equal(isEndpointAt(h.graph, ah, 'hi'), false);
  assert.equal(canExtendCenterLine(h.graph, ah, 'hi'), false);
});

test('【ガード(f)対照】反対側のピース・value が違う平行線・同軸の梁芯／補助線（種別違い）があっても延長できる', () => {
  const { graph, grid, line } = axisKit(H);
  grid(3000);
  const a = line(-100, 0, 1000);
  line(-100, -3000, -1000);                                                  // 反対側の同軸同種別
  line(400, 1500, 2500);                                                     // value が違う平行線
  line(-100, 2000, 2500, Discipline.FUSE);                                   // 同軸の梁芯
  line(-100, 2000, 2500, Discipline.ARCH, { lineType: 'dashed' });           // 同軸の補助線
  assert.equal(canExtendCenterLine(graph, a, 'hi'), true);
  const r = extendCenterLine(graph, a, 'hi', null);
  assert.equal(r.extended, true);
  assert.equal(a.extentHi, 3000);
});

test('【ガード(f)対照】垂直・lo側でも value 違い／反対側のピースは影響なし', () => {
  const { graph, grid, line } = axisKit(V);
  grid(-3000);
  const a = line(0, -1000, 0);
  line(0, 500, 2500);           // 反対側
  line(300, -2500, -1500);      // value 違い
  assert.equal(canExtendCenterLine(graph, a, 'lo'), true);
  assert.equal(extendCenterLine(graph, a, 'lo', null).extended, true);
  assert.equal(a.extentLo, -3000);
});

test('【ガード(f)対照】直交方向で value が同じ中心線は掛からない（centerLineType が違えば同軸ではない）', () => {
  const { graph, grid, line } = axisKit(H);
  const x0 = grid(0); grid(3000);
  const a = line(0, 0, 1000); graph.setCenterLineExtentRef(a, 'lo', { clId: x0.id, offset: 0 }, null);
  // 垂直の中心線（value=0、extent [1500,2500]）。a と value は同じだが直交方向
  graph.addCenterLine(V, 0, { labeled: false, discipline: Discipline.ARCH, extentLo: 1500, extentHi: 2500 });
  assert.equal(canExtendCenterLine(graph, a, 'hi'), true);
});

test('【ガード】境界側の許容誤差(ENDPOINT_EPS=0.5): 同軸ピースB.lo が境界-0.4 なら延長可、境界-0.6 なら不可（hi側）', () => {
  const mk = (bLo) => {
    const { graph, grid, line } = axisKit(H);
    const x1 = grid(1000); grid(3000);
    const a = line(0, 0, 1000); graph.setCenterLineExtentRef(a, 'hi', { clId: x1.id, offset: 0 }, null);
    line(0, bLo, 5000);
    return { graph, a };
  };
  const ok = mk(2999.6);
  assert.equal(canExtendCenterLine(ok.graph, ok.a, 'hi'), true);
  const ng = mk(2999.4);
  assert.equal(canExtendCenterLine(ng.graph, ng.a, 'hi'), false);
});

test('【ガード】境界側の許容誤差: lo側の鏡像（B.hi が境界+0.4 なら延長可、+0.6 なら不可）', () => {
  const mk = (bHi) => {
    const { graph, grid, line } = axisKit(H);
    grid(-3000); const x1 = grid(0);
    const a = line(0, 0, 1000); graph.setCenterLineExtentRef(a, 'lo', { clId: x1.id, offset: 0 }, null);
    line(0, -5000, bHi);
    return { graph, a };
  };
  const ok = mk(-3000 + 0.4);
  assert.equal(canExtendCenterLine(ok.graph, ok.a, 'lo'), true);
  const ng = mk(-3000 + 0.6);
  assert.equal(canExtendCenterLine(ng.graph, ng.a, 'lo'), false);
});

test('【ガード】現在端側の許容誤差: 同軸の1点線分が現在の端(1000)から+0.4 なら延長可、+0.6 なら不可', () => {
  const mk = (p) => {
    const { graph, grid, line } = axisKit(H);
    const x1 = grid(1000); grid(3000);
    const a = line(0, 0, 1000); graph.setCenterLineExtentRef(a, 'hi', { clId: x1.id, offset: 0 }, null);
    line(0, p, p);
    return { graph, a };
  };
  const ok = mk(1000.4);
  assert.equal(canExtendCenterLine(ok.graph, ok.a, 'hi'), true);
  const ng = mk(1000.6);
  assert.equal(canExtendCenterLine(ng.graph, ng.a, 'hi'), false);
});

test('【ガード】value の許容誤差: 平行な同種別ピースの value が a+0.4 なら同軸扱い（不可）、+0.6 なら別軸（可）', () => {
  const mk = (bValue) => {
    const { graph, grid, line } = axisKit(H);
    grid(3000);
    const a = line(0, 0, 1000);
    line(bValue, 1500, 2500);
    return { graph, a };
  };
  const ng = mk(0.4);
  assert.equal(canExtendCenterLine(ng.graph, ng.a, 'hi'), false);
  const ok = mk(0.6);
  assert.equal(canExtendCenterLine(ok.graph, ok.a, 'hi'), true);
});

test('【ガード(g)固定】補助線の延長は同軸・同種別ピースが区間に掛かっていてもガードの対象外（ステップ1と同じ結果）', () => {
  const { graph, grid, line } = axisKit(H);
  grid(3000);
  const a = line(0, 0, 1000, Discipline.ARCH, { lineType: 'dashed' });
  line(0, 2000, 5000, Discipline.ARCH, { lineType: 'dashed' });
  assert.equal(centerLineKind(a), 'aux');
  assert.equal(canExtendCenterLine(graph, a, 'hi'), true);
  assert.equal(extendCenterLine(graph, a, 'hi', { scaleDenominator: 100 }).extended, true);
});

test('【ガード(g)固定】梁芯の延長（端点でない端・通り芯が境界）は同軸・同種別ピースが区間に掛かっていてもガードの対象外', () => {
  const { graph, grid, line } = axisKit(H);
  const x0 = grid(0); const x1 = grid(1820); grid(3640);
  const a = line(-100, 0, 1820, Discipline.FUSE);
  graph.setCenterLineExtentRef(a, 'lo', { clId: x0.id, offset: 0 }, null);
  graph.setCenterLineExtentRef(a, 'hi', { clId: x1.id, offset: 0 }, null);
  line(-100, 2500, 3000, Discipline.FUSE);
  assert.equal(centerLineKind(a), 'beam');
  assert.equal(isEndpointAt(graph, a, 'hi'), false);
  assert.equal(canExtendCenterLine(graph, a, 'hi'), true);
  assert.equal(extendCenterLine(graph, a, 'hi', null).extended, true);
  assert.equal(a.extentHi, 3640);
});
