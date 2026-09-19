// centerLineOps.test.js 等と同じ方針: ダックタイピングでは effectiveValue・centerLines・
// structGraph連携の実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, centerLineKind } from '../core.js';
import {
  isEndpointAt, findExtendBoundary, findShortenBoundary,
  canExtendCenterLine, canShortenCenterLine, extendCenterLine, shortenCenterLine,
} from './centerLineExtend.js';

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
  assert.equal(canExtendCenterLine(graph, cl, 'hi'), false, '端点なので延長不可');
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
  assert.equal(canExtendCenterLine(graph, cl, 'hi'), false, '端点なので延長不可');
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

test('【失敗系】端点(isEndpointAt:true)の延長・短縮は境界の有無に関わらずextended:false/shortened:falseになる', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 9999, // 9999に何も無い＝端点
  });
  graph.addCenterLine(CenterLineType.VERTICAL, 20000, { labeled: true, discipline: Discipline.STRUCT }); // 遠くに通り芯はあるが端点判定には無関係

  assert.equal(isEndpointAt(graph, cl, 'hi'), true);
  assert.deepEqual(extendCenterLine(graph, cl, 'hi', null), { extended: false });
  assert.deepEqual(shortenCenterLine(graph, cl, 'hi', null), { shortened: false });
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
