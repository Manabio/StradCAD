// 柱の仕上げ包み（columnWrap.js）の単体テスト。展開図・平面図が共有する単一の情報源のため、
// ここで固定した値がそのまま両図面の見え方になる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from './wallGeneration.js';
import {
  bareColumnRect, wallFinishCoverMm, columnMeetsWall, isColumnInsideWall,
  wrapColumnWithFinish, columnWrapSolids, columnWallCuts,
} from './columnWrap.js';
import { resolveFinVisibility } from './wallFinishJoin.js';
import { columnWrapEdgePrimitives, columnWrapFinKey } from '../structural/columnWrapLineJoin.js';

function makeGridRoom() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  const addGrid = (type, value, label) =>
    graph.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT, label });
  const x0 = addGrid(CenterLineType.VERTICAL, 0, 'X1');
  const x1 = addGrid(CenterLineType.VERTICAL, 4000, 'X2');
  const y0 = addGrid(CenterLineType.HORIZONTAL, 0, 'Y1');
  const y1 = addGrid(CenterLineType.HORIZONTAL, 3000, 'Y2');
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'いま');
  generateRoomWallsFromOutline(graph, room);
  return { graph, room, x0, x1, y0, y1 };
}

// ---- 素の外形（断面＋ダイヤフラム出） ----
test('bareColumnRect: 断面寸法をそのまま矩形にする（矩形断面はダイヤフラム出0）', () => {
  const rect = bareColumnRect({ x: 1000, y: 500, sectionDefId: 'RC-300x300' });
  assert.deepEqual(
    { xLo: rect.xLo, xHi: rect.xHi, yLo: rect.yLo, yHi: rect.yHi },
    { xLo: 850, xHi: 1150, yLo: 350, yHi: 650 });
  assert.equal(rect.diaphragmMm, 0);
});

test('bareColumnRect: 角形鋼管はダイヤフラム出（板厚9<28 → 25mm）を外形に含める', () => {
  const rect = bareColumnRect({ x: 0, y: 0, sectionDefId: 'STEEL-SQ200x200x9.0' });
  assert.equal(rect.xHi - rect.xLo, 250, '200＋25×2＝250のはず');
  assert.equal(rect.diaphragmMm, 25);
});

test('bareColumnRect: rotation 90°は width/height を入れ替える。断面未登録は既定105角', () => {
  const rotated = bareColumnRect({ x: 0, y: 0, sectionDefId: 'STEEL-H400x200', rotation: 90 });
  assert.equal(rotated.xHi - rotated.xLo, 400, '90°回転でX方向が成(400)になるはず');
  assert.equal(rotated.yHi - rotated.yLo, 200);
  const unknown = bareColumnRect({ x: 0, y: 0, sectionDefId: 'NOPE' });
  assert.equal(unknown.xHi - unknown.xLo, 105, 'カタログに無い断面は既定105角へフォールバック');
});

// ---- 覆い厚 ----
test('wallFinishCoverMm: 下地帯＋仕上げ厚。壁一覧を渡さなければ壁自身の値だけ', () => {
  assert.equal(wallFinishCoverMm({ backingRange: { lo: -45, hi: 45 }, wallFinish: 12.5 }), 102.5);
  assert.equal(wallFinishCoverMm({ backingRange: null, wallFinish: 12.5 }), 12.5, '単独の薄壁は仕上げのみ');
  assert.equal(wallFinishCoverMm({ backingRange: null, wallFinish: null }), 0, '寸法不明は0＝覆わない');
});

// 実機フィードバック2026-08「柱周りに壁下地材がない」: 部屋境界の壁は下地オーナー壁＋仕上げ薄壁の
// ペアで、柱に面するのは薄壁。薄壁だけを見ると下地0になり包みが仕上げ12.5mmに潰れていた。
test('wallFinishCoverMm: 仕上げのみの薄壁は同じ軸CLのオーナー壁から下地厚を採る', () => {
  const axisCL = { id: 'cl-1', effectiveValue: 0 };
  const thin  = { isVertical: false, axisCL, backingRange: null, wallFinish: 12.5, coord1: 0, coord2: 4000 };
  const owner = { isVertical: false, axisCL, backingRange: { lo: -45, hi: 45 }, wallFinish: 12.5, coord1: 0, coord2: 4000 };
  assert.equal(wallFinishCoverMm(thin, [thin, owner]), 102.5, '下地90はオーナー壁が持っている');
});

test('【失敗系】wallFinishCoverMm: 別の軸CL・スパンが重ならないオーナー壁は拾わない', () => {
  const axisCL = { id: 'cl-1', effectiveValue: 0 };
  const thin = { isVertical: false, axisCL, backingRange: null, wallFinish: 12.5, coord1: 0, coord2: 1000 };
  const otherAxis = { isVertical: false, axisCL: { id: 'cl-2', effectiveValue: 3000 },
    backingRange: { lo: 2955, hi: 3045 }, wallFinish: 12.5, coord1: 0, coord2: 4000 };
  const apart = { isVertical: false, axisCL, backingRange: { lo: -45, hi: 45 }, wallFinish: 12.5,
    coord1: 2000, coord2: 4000 };
  const perpendicular = { isVertical: true, axisCL, backingRange: { lo: -45, hi: 45 }, wallFinish: 12.5,
    coord1: 0, coord2: 4000 };
  assert.equal(wallFinishCoverMm(thin, [thin, otherAxis, apart, perpendicular]), 12.5,
    '軸CL違い・スパン非重複・向き違いはどれもオーナーではない');
  assert.equal(wallFinishCoverMm({ ...thin, axisCL: undefined }, [thin]), 12.5, '軸CLが無ければ探索しない');
});

// ---- 干渉判定・壁埋まり判定 ----
test('columnMeetsWall: 材厚・スパンの両方に正の幅で重なるときだけ干渉', () => {
  const wall = { isVertical: false, materialRange: { lo: 0, hi: 57.5 }, coord1: 0, coord2: 4000 };
  const meets = { xLo: 1850, xHi: 2150, yLo: -150, yHi: 150 };
  assert.equal(columnMeetsWall(meets, wall), true);
  assert.equal(columnMeetsWall({ ...meets, yLo: 100, yHi: 400 }, wall), false, '材厚を外れれば干渉しない');
  assert.equal(columnMeetsWall({ ...meets, xLo: 5000, xHi: 5300 }, wall), false, 'スパン外は干渉しない');
  assert.equal(columnMeetsWall(meets, { ...wall, materialRange: null }), false, '材厚不明の壁は干渉扱いしない');
});

test('isColumnInsideWall: 材厚に完全に収まる柱だけ真（はみ出す柱は室内へ出るので偽）', () => {
  const wall = { isVertical: false, materialRange: { lo: 0, hi: 200 }, coord1: 0, coord2: 4000 };
  assert.equal(isColumnInsideWall({ xLo: 0, xHi: 105, yLo: 47.5, yHi: 152.5 }, [wall]), true);
  assert.equal(isColumnInsideWall({ xLo: 0, xHi: 105, yLo: -50, yHi: 250 }, [wall]), false);
  assert.equal(isColumnInsideWall({ xLo: 0, xHi: 105, yLo: 0, yHi: 100 }, []), false, '壁が無ければ偽');
});

// ---- 包み ----
// 壁1枚を作るヘルパ（材厚・スパン・層構成・軸CL）。
// axisValue（仕上げ面）・faceDir は実Wallと同じ関係で導く——材(materialRange)の遠位端が
// 常に仕上げ面（core/wall.js。renderer/wallJunctionResolve.js ヘッダの「faceDir方向の遠位端が
// 常にfaceValue」）。柱壁と壁仕上げ材の取り合い（finish/wallFinishJoin.js）はこの2値から
// 相手の内側線を求めるため、ダブルにも持たせないと取り合い経路が動かない。
const mkWall = (isVertical, mr, axis, { finish = 12.5, backing = null, span = [-9000, 9000] } = {}) => {
  const face = Math.abs(mr.lo - axis) > Math.abs(mr.hi - axis) ? mr.lo : mr.hi;
  return {
    isVertical, materialRange: mr, coord1: span[0], coord2: span[1],
    axisValue: face, faceDir: Math.sign(face - axis) || 1,
    backingRange: backing, wallFinish: finish, axisCL: { effectiveValue: axis },
  };
};

test('wrapColumnWithFinish: 向き合う壁との隙間が150以下ならその隙間ぶん伸ばして壁面と揃える（トリム）', () => {
  // 実機ログの構成: 壁の仕上げ面 -6942.5 に対し柱の外面 -6900（隙間42.5mm）。
  const wall = mkWall(false, { lo: -6955, hi: -6942.5 }, -7000);
  const wrapped = wrapColumnWithFinish(
    { xLo: -7900, xHi: -7650, yLo: -6900, yHi: -6650, baseZ: 0 }, [wall]);
  assert.equal(wrapped.covers.yLo, 42.5, '隙間ぶんだけ伸ばすはず');
  assert.equal(wrapped.trimmed.yLo, true);
  assert.equal(wrapped.yLo, -6942.5, '包みの面が壁の仕上げ面と揃うはず');
  assert.deepEqual(wrapped.wallAxes, [{ isVertical: false, axisValue: -7000 }],
    'トリムで接続した壁は索引に積まれるはず');
});

test('wrapColumnWithFinish: 150を超えて離れた面は壁面へ揃えず、その壁の層構成ぶんだけ覆う', () => {
  const wall = mkWall(false, { lo: -6955, hi: -6942.5 }, -7000);
  const wrapped = wrapColumnWithFinish(
    { xLo: -7900, xHi: -7650, yLo: -6700, yHi: -6450, baseZ: 0 }, [wall]); // 隙間242.5mm
  assert.equal(wrapped.covers.yLo, 12.5, '層構成（下地0＋仕上げ12.5）ぶんだけ覆うはず');
  assert.equal(wrapped.trimmed.yLo, false);
  assert.deepEqual(wrapped.wallAxes, [], '接続していない壁は索引に積まない（展開図に出さない）');
});

test('【実機修正】wrapColumnWithFinish: 柱に面するのが薄壁でも、下地材＋仕上げ材で覆う', () => {
  // 実機構成: 柱に面するのは仕上げ薄壁（材厚12.5）。下地はペアのオーナー壁が持つ。
  const axisCL = { id: 'cl-1', effectiveValue: 0 };
  const thin  = { isVertical: false, axisCL, materialRange: { lo: -12.5, hi: 0 },
    backingRange: null, wallFinish: 12.5, coord1: -9000, coord2: 9000 };
  const owner = { isVertical: false, axisCL, materialRange: { lo: -102.5, hi: -12.5 },
    backingRange: { lo: -102.5, hi: -12.5 }, wallFinish: 12.5, coord1: -9000, coord2: 9000 };
  // 柱は薄壁から500mm離れた室内側（トリム範囲外＝層構成ぶんの包み）。
  const wrapped = wrapColumnWithFinish({ xLo: 0, xHi: 300, yLo: 500, yHi: 800, baseZ: 0 }, [thin, owner]);
  assert.equal(wrapped.covers.yLo, 102.5, '下地90＋仕上げ12.5で覆うはず（薄壁の12.5だけではない）');
  assert.equal(wrapped.finishes.yLo, 12.5, 'うち仕上げ材12.5＝残り90mmが柱回りの下地材');
});

test('wrapColumnWithFinish: 柱は原則覆う——両側に壁がある部屋なら4面すべてに包みが付く', () => {
  const walls = [
    mkWall(false, { lo: -57.5, hi: -45 }, 0),        // 北の壁（柱の-Y側、遠い）
    mkWall(false, { lo: 2945, hi: 2957.5 }, 3000),   // 南の壁（+Y側、遠い）
    mkWall(true, { lo: -57.5, hi: -45 }, 0),         // 西の壁（-X側、遠い）
    mkWall(true, { lo: 3945, hi: 3957.5 }, 4000),    // 東の壁（+X側、遠い）
  ];
  const wrapped = wrapColumnWithFinish({ xLo: 1850, xHi: 2150, yLo: 1350, yHi: 1650, baseZ: 0 }, walls);
  for (const k of ['xLo', 'xHi', 'yLo', 'yHi']) {
    assert.equal(wrapped.covers[k], 12.5, `${k}面も覆われるはず（原則、仕上げ材で覆う）`);
  }
  assert.deepEqual(wrapped.wallAxes, [], '遠い壁とは接続しない');
});

test('wrapColumnWithFinish: 壁内の面は覆わない（下地材・壁仕上げ材ともになし）', () => {
  // 柱が壁を貫いている構成: -Y面(-150)は壁の材厚[-200,0]の中、+Y面(150)は室内。
  const wall = mkWall(false, { lo: -200, hi: 0 }, -100, { finish: 12.5, backing: { lo: -200, hi: 0 } });
  const wrapped = wrapColumnWithFinish({ xLo: 1850, xHi: 2150, yLo: -150, yHi: 150, baseZ: 0 }, [wall]);
  assert.equal(wrapped.covers.yLo, 0, '壁の材厚の中にある面は覆わないはず');
  assert.equal(wrapped.yLo, -150, '素の位置のまま');
  assert.ok(wrapped.wallAxes.some(a => a.axisValue === -100), '食い込んでいる壁とは接続する');
});

test('【失敗系】wrapColumnWithFinish: 覆い厚0の壁でもトリムで接すれば軸CLを記録する', () => {
  // 寸法の判らない手動壁（wallFinish=null → 覆い厚0）。隙間50mmはトリム対象。
  const wall = mkWall(false, { lo: -120, hi: 0 }, 0, { finish: null });
  const wrapped = wrapColumnWithFinish({ xLo: 1850, xHi: 2150, yLo: 50, yHi: 350, baseZ: 0 }, [wall]);
  assert.equal(wrapped.covers.yLo, 50, '隙間ぶんのトリムは覆い厚が0でも効く');
  assert.deepEqual(wrapped.wallAxes, [{ isVertical: false, axisValue: 0 }]);
});

test('wrapColumnWithFinish: trimGapMm は差し替えられる（既定150）', () => {
  const wall = mkWall(false, { lo: -12.5, hi: 0 }, 0);
  const rect = { xLo: 0, xHi: 300, yLo: 100, yHi: 400, baseZ: 0 }; // 隙間100mm
  assert.equal(wrapColumnWithFinish(rect, [wall]).covers.yLo, 100, '既定150ではトリムされる');
  assert.equal(wrapColumnWithFinish(rect, [wall], { trimGapMm: 50 }).covers.yLo, 12.5,
    '閾値を下げるとトリムされず層構成ぶんの包みになる');
});

test('【失敗系】wrapColumnWithFinish: 壁が空・軸CLを持たない壁でも例外を投げない', () => {
  const rect = { xLo: 0, xHi: 100, yLo: 0, yHi: 100, baseZ: 0 };
  assert.deepEqual(wrapColumnWithFinish(rect, []).wallAxes, []);
  assert.deepEqual(wrapColumnWithFinish(rect, undefined).wallAxes, []);
  const noAxis = { isVertical: false, materialRange: { lo: -50, hi: -10 }, coord1: -100, coord2: 200,
    backingRange: null, wallFinish: 10 };
  assert.deepEqual(wrapColumnWithFinish(rect, [noAxis]).wallAxes, [], '軸CLが無い壁は索引に積まない');
});

// ---- graph 全体の解決（平面図の入口） ----
test('columnWrapSolids: 壁と干渉する柱の包みを解決し、杭は除外・壁に埋まる柱はhiddenで返す', () => {
  const { graph, y0, x0, x1 } = makeGridRoom();
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, {});          // 壁と干渉
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', x0, y0, { role: 'foundation' }); // 杭
  const thick = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(y0, 400, false, x0, 0, x1, 0, {});                                // 厚い手動壁
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', thick, y0, { eccentricity: { x: 0, y: 200 } });

  const solids = columnWrapSolids(graph);
  assert.equal(solids.length, 2, '杭は除外され、柱2本が残るはず');
  const wrapped = solids.find(s => Math.abs(s.column.x - 2000) < 1);
  assert.equal(wrapped.hidden, false);
  assert.equal(wrapped.wrapped.xHi - wrapped.wrapped.xLo, 505, '干渉柱は覆い込み後の見付けになる');
  const buried = solids.find(s => Math.abs(s.column.x - 3000) < 1);
  assert.equal(buried.hidden, true, '厚さ400の壁に収まる105角柱は hidden のはず');
});

test('【失敗系】columnWrapSolids: graphがnull・柱を持たない相手でも空配列', () => {
  assert.deepEqual(columnWrapSolids(null), []);
  assert.deepEqual(columnWrapSolids({}), []);
});

// ---- 層の内訳（平面図が包みを下地材・仕上げ材の2層で描くのに使う） ----
test('wrapColumnWithFinish: 各面の仕上げ材厚を記録する（残りが下地材）', () => {
  const wall = mkWall(false, { lo: -102.5, hi: 0 }, -57.5, { finish: 12.5, backing: { lo: -102.5, hi: -12.5 } });
  const wrapped = wrapColumnWithFinish({ xLo: 0, xHi: 300, yLo: 500, yHi: 800, baseZ: 0 }, [wall]);
  assert.equal(wrapped.covers.yLo, 102.5, '層構成（下地90＋仕上げ12.5）ぶん覆うはず');
  assert.equal(wrapped.finishes.yLo, 12.5, 'うち仕上げ材は12.5mm（残り90mmが下地材）');
});

// 相手のfin線が描かれない壁（内側線が材の外へ出る退化形。resolveFinVisibility参照）とは
// 取り合えないため、トリムしても「自前の仕上げ厚で内側へ入れる」式へフォールバックする。
test('wrapColumnWithFinish: 包みが仕上げ厚より薄い（トリム量が小さい）面は全部を仕上げ材とみなす', () => {
  const wall = mkWall(false, { lo: -12.5, hi: 0 }, 0, { finish: 30 });
  assert.equal(resolveFinVisibility(wall).finVisible, false, '前提: この壁のfin線は描かれない');
  const wrapped = wrapColumnWithFinish({ xLo: 0, xHi: 300, yLo: 5, yHi: 300, baseZ: 0 }, [wall]);
  assert.equal(wrapped.covers.yLo, 5, 'トリム量は隙間の5mm');
  assert.equal(wrapped.finishes.yLo, 5, '下地を入れる余地が無いので全部が仕上げ材');
});

// ユーザー実機指摘2026-09「内壁と柱包みの壁仕上げ材の取り合いが誤って離れている」。
// 取り合う面の内側境界は**相手壁の内側線の位置**（finish/wallFinishJoin.js。壁同士の
// 取り合い＝wallJunctionResolve.js パス2 と同じ経路）に置く——自前の仕上げ厚ぶん内側へ
// 入れると、トリム量に関わらず常に「仕上げ厚2枚ぶん」食い違って離れる。
test('【実機修正2026-09】wrapColumnWithFinish: トリムした面の内側境界は相手壁の内側線に合う', () => {
  const wall = mkWall(false, { lo: -6955, hi: -6942.5 }, -7000); // 仕上げ面-6942.5・内側線-6955
  const wrapped = wrapColumnWithFinish(
    { xLo: -7900, xHi: -7650, yLo: -6900, yHi: -6650, baseZ: 0 }, [wall]); // 隙間42.5mm
  assert.equal(wrapped.trimmed.yLo, true);
  assert.equal(wrapped.finishes.yLo, -12.5,
    '内側境界は面より外（壁の材の中）にある＝見込み量は負');
  assert.equal(wrapped.yLo + wrapped.finishes.yLo, resolveFinVisibility(wall).finBoundary,
    '柱壁の内側境界が壁の内側線とちょうど同じ位置に来るはず（離れない）');
});

// 描かれる線どうしが本当に1点で出会うことまで確かめる（壁側=columnWallCuts の切り欠き端、
// 柱側=columnWrapEdgePrimitives の内側線の端点）。実機の不良「取り合いが離れている」は
// この2つが仕上げ厚2枚ぶん食い違う形で現れた。
test('【実機修正2026-09】柱壁の内側線の端点が、壁のfin線の切り欠き端とちょうど一致する', () => {
  const { graph, x1 } = makeGridRoom();
  // 内壁（x=4000通り）の室内側に、隙間92.5mmで立つ柱。
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', x1, ym, { eccentricity: { x: -300, y: 0 } });

  const solid = columnWrapSolids(graph)[0];
  assert.equal(solid.wrapped.trimmed.xHi, true, '前提: 柱の東面が内壁の仕上げ面までトリムされる');

  // 柱側の壁（材が柱側にある垂直壁）と、そのfin線の切り欠き。
  const wall = graph.walls.find(w => w.isVertical && Math.abs(w.materialRange.hi - 4000) < 1);
  const fb = resolveFinVisibility(wall).finBoundary; // 壁のfin線（縦線）のx位置
  const [cutLo, cutHi] = columnWallCuts(graph).get(wall.id).fin[0];

  // 柱側の内側線（yLo/yHi の横線）。壁と取り合う xHi の辺自体は描かない（壁側に任せる）。
  const prims = columnWrapEdgePrimitives(solid.column, solid.wrapped, true);
  const keyOf = edge => columnWrapFinKey(solid.column.id, edge);
  assert.equal(prims.some(p => p.key === keyOf('xHi')), false, 'トリム面の内側線は描かない');
  for (const [edge, cutEnd] of [['yLo', cutLo], ['yHi', cutHi]]) {
    const line = prims.find(p => p.key === keyOf(edge));
    assert.equal(line.y1, cutEnd, `${edge}の内側線は壁のfin線が切れる位置にあるはず`);
    assert.equal(Math.max(line.x1, line.x2), fb,
      `${edge}の内側線の端点が壁の内側線(${fb})まで届くはず（届かないと離れて見える）`);
  }
});

// ---- 壁との取り合い（壁側を落とす区間） ----
test('columnWallCuts: 仕上げ面線と仕上げ境界線で切り欠き幅が違う（境界線は仕上げ厚ぶん狭い）', () => {
  const { graph, y0 } = makeGridRoom();
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, {});
  const cuts = columnWallCuts(graph);
  const wallA = graph.walls.find(w => !w.isVertical && Math.abs(w.axisCL.effectiveValue) < 1);
  const entry = cuts.get(wallA.id);
  assert.ok(entry, 'A面の壁に切り欠きが出るはず');
  assert.equal(entry.face.length, 1);
  assert.equal(entry.fin.length, 1);
  const [fLo, fHi] = entry.face[0], [bLo, bHi] = entry.fin[0];
  assert.equal(Math.round(fHi - fLo), 505, '仕上げ面線の切り欠きは柱壁の外形幅（300＋102.5×2）');
  assert.equal(Math.round(bHi - bLo), 505 - 2 * 12.5,
    '境界線の切り欠きは内側境界の幅（外形−仕上げ厚×2）＝柱側の境界線と端が揃う');
  assert.ok(fLo < 2000 && fHi > 2000, '柱の位置(x=2000)を含むはず');
});

// ユーザー指示2026-08「削除候補の壁下地を使っている壁仕上げ材（例えば反対側の部屋の壁）が
// あったら、削除しない」。下地オーナー壁の下地は両側の部屋の仕上げ材が乗る共有の下地で、
// 柱は片側にしか出っ張らない。
test('columnWallCuts: 反対側の部屋の仕上げ材が残る下地は削除しない（仕上げ・境界線は切る）', () => {
  const axisCL = { id: 'cl-1', effectiveValue: 0 };
  // 部屋A側（柱がある側）のオーナー壁と、部屋B側（反対）の仕上げ薄壁のペア。
  const owner = { id: 'w-owner', isVertical: false, axisCL, coord1: -4000, coord2: 4000,
    materialRange: { lo: -102.5, hi: 0 }, backingRange: { lo: -102.5, hi: -12.5 }, wallFinish: 12.5 };
  const farThin = { id: 'w-thin', isVertical: false, axisCL, coord1: -4000, coord2: 4000,
    materialRange: { lo: -115, hi: -102.5 }, backingRange: null, wallFinish: 12.5 };
  const column = { id: 'c1', sectionDefId: 'RC-300x300', x: 0, y: 150, rotation: 0 };
  const graph = { walls: [owner, farThin], columns: [column] };

  const cuts = columnWallCuts(graph);
  const entry = cuts.get('w-owner');
  assert.ok(entry, '柱側のオーナー壁は切り欠かれるはず');
  assert.equal(entry.face.length, 1, '仕上げ面線は切る');
  assert.equal(entry.fin.length, 1, '仕上げ境界線も切る');
  assert.deepEqual(entry.backing, [],
    '反対側（部屋B）の仕上げ材がこの下地に乗っているので下地は削除しないはず');
  assert.equal(cuts.get('w-thin'), undefined, '柱が接していない反対側の薄壁は切り欠かない');
});

test('columnWallCuts: 反対側に仕上げ材が無ければ下地を削除する', () => {
  const axisCL = { id: 'cl-1', effectiveValue: 0 };
  const owner = { id: 'w-owner', isVertical: false, axisCL, coord1: -4000, coord2: 4000,
    materialRange: { lo: -102.5, hi: 0 }, backingRange: { lo: -102.5, hi: -12.5 }, wallFinish: 12.5 };
  const column = { id: 'c1', sectionDefId: 'RC-300x300', x: 0, y: 150, rotation: 0 };
  const cuts = columnWallCuts({ walls: [owner], columns: [column] });
  assert.equal(cuts.get('w-owner').backing.length, 1,
    'この下地に乗る仕上げ材は柱側の1枚だけなので削除してよいはず');
});

test('【失敗系】columnWallCuts: 柱から遠い壁・柱の無いgraphでは切り欠きを返さない', () => {
  const { graph, y0 } = makeGridRoom();
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, {});
  const cuts = columnWallCuts(graph);
  const wallC = graph.walls.find(w => !w.isVertical && w.axisCL.effectiveValue > 2000);
  assert.equal(cuts.get(wallC?.id), undefined, '反対側（3000側）の壁は切り欠かれないはず');
  assert.equal(columnWallCuts(makeGridRoom().graph).size, 0, '柱が無ければ空');
  assert.equal(columnWallCuts(null).size, 0);
});
