// 復路下の仕上げ空間（木造の復路下の壁。.claude/data-model.md「復路下の壁」）を階段帯の seq5（復路レーンを縦断する面）に描く。
// ユーザー指摘 2026-10-15「moku4-3.stq 1階展開図 階段 B2: 復路下天井仕上げ断面・Y4から910に壁断面・床断面が正解。
// 1階天井と1階床の断面線が途中で切れて完結していない」。
// フィクスチャは elevationStairSequence.test.js の折返し階段（3 セル）を木造にして復路下の壁を立てたもの。flip=true/false の両回転で回す
// （flip=true は landingEnd='right'・dirSign=−1〔moku4-3 と同じ向き〕、flip=false は landingEnd='left'・dirSign=+1〔stair-ports-test5〕）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { generateStairUnderReturnWalls } from '../finish/stair/stairPartitionWalls.js';
import { stairUnderReturnGeometry, isStairUnderReturnWall } from '../finish/stair/stairPartition.js';
import { cellsBeyondBreak } from '../finish/stair/stairGeometry.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { composeRoomFaces } from './elevationFaceList.js';
import {
  stairFaceSequence, upperFloorEndLines, floorProfileWithFloorOn, underReturnSpaceOf, clipContentInsideStairBody,
} from './elevationStairSequence.js';
import { buildBandLayers } from './section/sectionBandLayers.js';
import { drawnFloorProfileZAt } from './elevationFloorProfile.js';
import { ElevationLineRole, weightForRole } from './elevationStyle.js';

const OPTS = { floorHeight: 2400, chUpperAbsMm: 4800, chLowerMm: 2400 };
const CUT = weightForRole(ElevationLineRole.CUT);
const SIL = weightForRole(ElevationLineRole.SILHOUETTE);
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

// 折返し階段（踊り場 y0..1500 全幅・往路/復路レーン y1500..4500。flip=true＝往路が x 大側・復路が x 0..1000、flip=false はその逆）。
// openReturnSide: 復路レーンの外側の壁（seq5 が見る壁）の到達辺側 y 3500..4500 を開口にして、その向こうに隣室を置く
// （stair-ports-test5 の構成。仕上げ空間の奥の開放辺に隣室の天井線・壁端の縦線・アキが現れる）。
// hallBaseboard: 到達辺（y=4500）の外側に部屋「ホール」（y4500..6500）を置き、その RoomFinish.baseboardHeight に入れる文字列
// （null＝部屋を置かない）。openArrival: 到達辺（y=4500）の壁を外して空間がホールへ開く（moku4-3 と同じ。既定は壁あり）。
// stairBaseboard: 階段室自身の RoomFinish.baseboardHeight（null＝未設定）。
// wallBeyondMm: 復路の外側の壁（面の壁）を到達辺（y=4500）の外へこの長さだけ延ばす（openArrival と併用。null＝延ばさない）。
function makeFixture(structure, { flip = true, withRoomUnder = false, floorLevel = null, openReturnSide = false, chLowerMm = OPTS.chLowerMm, hallBaseboard = null, openArrival = false, stairBaseboard = null, wallBeyondMm = null } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure === StructuralMaterialType.WOOD ? TRADITIONAL_WOOD_STRUCTURE : structure;
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), xm = cl(CenterLineType.VERTICAL, 1000), x1 = cl(CenterLineType.VERTICAL, 2000);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), ym = cl(CenterLineType.HORIZONTAL, 1500), y1 = cl(CenterLineType.HORIZONTAL, 4500);
  const cells = new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`, `${x0.id}:${ym.id}:${xm.id}:${y1.id}`, `${xm.id}:${ym.id}:${x1.id}:${y1.id}`]);
  const room = graph.addRoom(new Set(cells), '階段');
  if (floorLevel != null) room.setFloorLevel(floorLevel);
  if (openReturnSide) {
    // 復路の外側の壁（flip=true は x=0、false は x=2000）の 3500..4500 を開け、向こうに隣室
    const outer = flip ? x0 : x1;
    const beyond = cl(CenterLineType.VERTICAL, flip ? -1000 : 3000);
    const yo = cl(CenterLineType.HORIZONTAL, 3500);
    const [a, b] = flip ? [beyond, outer] : [outer, beyond];
    const side = graph.addRoom(new Set([`${a.id}:${yo.id}:${b.id}:${y1.id}`]), '隣室');
    generateRoomWallsFromOutline(graph, room);
    generateRoomWallsFromOutline(graph, side);
    for (const w of [...graph.walls]) {
      if (!(w.isVertical && Math.abs(w.axisCL.effectiveValue - outer.effectiveValue) < 1e-6)) continue;
      const props = { isRoomWall: w.isRoomWall, wallFinish: w.wallFinish, backingOffset: w.backingOffset, backingDepth: w.backingDepth, finishSide: w.finishSide };
      const off = w.axisValue - w.axisCL.effectiveValue;
      const lo = Math.min(w.coord1, w.coord2);
      graph.removeShape(w.id);
      if (lo < 3000) graph.addWall(outer, off, true, y0, 57.5, yo, 0, props); // 階段室の外壁は y 57.5..3500 だけ残す
    }
  } else generateRoomWallsFromOutline(graph, room);
  if (hallBaseboard != null) {
    const yh = cl(CenterLineType.HORIZONTAL, 6500);
    const hall = graph.addRoom(new Set([`${x0.id}:${y1.id}:${x1.id}:${yh.id}`]), 'ホール');
    hall.finish.setField('baseboardHeight', hallBaseboard);
  }
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], riser: null, upDirection: 'up', flip,
  });
  stair.setField('structure', structure);
  if (withRoomUnder) {
    const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
    assert.ok(beyond.size > 0, '破れ線先のセルがある');
    graph.addRoom(new Set(beyond), '階段下');
  }
  const underWalls = generateStairUnderReturnWalls(graph, { structure: graph.structureOverride });
  // 直上の層（階高 2400）: 復路下の壁の天端（sectionProbe.js addUnderReturnTops）は直上の層の階高から蹴上を決める
  const upperGraph = new PlanGraph(new Plane('p2', OPTS.floorHeight, '2階', 2, 1));
  const layers = buildBandLayers(graph, { above: [{ graph: upperGraph, floorHeightMm: OPTS.floorHeight }] });
  if (stairBaseboard != null) room.finish.setField('baseboardHeight', stairBaseboard);
  if (openArrival) {
    for (const w of [...graph.walls]) {
      if (!w.isVertical && Math.abs(w.axisCL.effectiveValue - 4500) < 1e-6) graph.removeShape(w.id);
    }
  }
  if (wallBeyondMm != null) {
    const outer = flip ? x0 : x1;
    const base = graph.walls.find(w => w.isVertical && Math.abs(w.axisCL.effectiveValue - outer.effectiveValue) < 1e-6);
    const props = { isRoomWall: base.isRoomWall, wallFinish: base.wallFinish, backingOffset: base.backingOffset, backingDepth: base.backingDepth, finishSide: base.finishSide };
    graph.addWall(outer, base.axisValue - outer.effectiveValue, true, y1, -57.5, cl(CenterLineType.HORIZONTAL, 4500 + wallBeyondMm), 0, props);
  }
  const entries = stairFaceSequence(stair, composeRoomFaces(room, graph, { keepWallLessFaces: openArrival }), graph, { ...OPTS, chLowerMm, upperGraph, layers });
  return { graph, room, stair, underWalls, entries, chLowerMm, seq5: entries.find(e => e.seqNo === '5') };
}

const verticalsAt = (e, x, weight) => e.content.filter(p => p.type === 'line' && weight.includes(p.weight)
  && Math.abs(p.x1 - x) < 1e-6 && Math.abs(p.x2 - x) < 1e-6);

// 復路下の壁の両面の断面ローカル x と、仕上げ空間の端（到達辺側の面の端）・壁の空間側／踊り場側の面
function wallLocals(fx) {
  const { graph, stair, seq5 } = fx;
  const g = stairUnderReturnGeometry(stair, graph);
  const line = { isVertical: g.isVertical, axisValue: g.axisValue, lo: g.lo, hi: g.hi };
  const walls = graph.walls.filter(w => isStairUnderReturnWall(w, [line]));
  const face = seq5.face;
  const xs = walls.flatMap(w => [w.materialRange.lo, w.materialRange.hi]).map(v => (v - face.originWorld) * face.dirSign);
  const wallLoX = Math.min(...xs), wallHiX = Math.max(...xs);
  const landingLeft = seq5.landingEnd === 'left';
  return {
    wallLoX, wallHiX,
    spaceEnd: landingLeft ? face.run : 0,
    spaceInner: landingLeft ? wallHiX : wallLoX,
    spaceOuter: landingLeft ? wallLoX : wallHiX,
  };
}

// 裏面の断面線＝床と上階 FL の間に収まる中線の折れ線（段板の裏のジグザグは上階 FL に達する）
// （段板の裏のジグザグは垂直の片を持ち上階 FL に達する。天井仕上げの線は x が単調で床と CH の間）
const soffitLinesOf = seq5 => seq5.content.filter(p => p.type === 'polyline' && p.weight === SIL && p.points.length >= 2
  && p.points.every(([, y]) => -y > 0 && -y <= OPTS.chLowerMm + 1e-6)
  && p.points.every(([x], i) => i === 0 || Math.abs(x - p.points[i - 1][0]) > 1e-6));

for (const flip of [true, false]) {
  test(`木造（flip=${flip}）: seq5 の断面線は到達辺から復路下の壁の仕上げ空間側の面まで床（0）で、壁の断面線はその面の縦線だけ（踊り場側の面・天端は描かない）`, () => {
    const fx = makeFixture(StructuralMaterialType.WOOD, { flip });
    const { underWalls, seq5 } = fx;
    assert.equal(underWalls.length, 2, '復路下の壁（オーナー壁＋薄壁）が立つ');
    assert.ok(seq5?.floorProfile?.length > 0, 'seq5 は断面線を持つ');
    assert.equal(seq5.landingEnd, flip ? 'right' : 'left', '回転方向で踊り場側の端が変わる（両経路を踏む）');
    const { wallLoX, wallHiX, spaceEnd, spaceInner, spaceOuter } = wallLocals(fx);
    near(wallHiX - wallLoX, 115, '壁の厚み（下地 90＋仕上げ 12.5×2）');
    for (const t of [0.1, 0.5, 0.9]) {
      const x = spaceEnd + (spaceInner - spaceEnd) * t;
      near(drawnFloorProfileZAt(seq5.floorProfile, x), 0, `仕上げ空間（x=${x}）の断面線は床`);
    }
    assert.ok(drawnFloorProfileZAt(seq5.floorProfile, (spaceInner + spaceOuter) / 2) > 1000, '壁の厚みの中は段の裏の断面線のまま（描かない側）');
    const landingX = seq5.landingEnd === 'left' ? 1 : seq5.face.run - 1;
    assert.ok(drawnFloorProfileZAt(seq5.floorProfile, landingX) >= 1200 - 1e-6, '踊り場側の断面線は踊り場の高さ以上');
    // 床線は壁の仕上げ空間側の面まで（flatLineSpanX）
    const seg = seq5.floorSegments[0];
    const floorEnd = seq5.landingEnd === 'left' ? (seg.flatLineSpanX?.lo ?? seg.loX) : (seg.flatLineSpanX?.hi ?? seg.hiX);
    near(floorEnd, spaceInner, '床線は壁の仕上げ空間側の面まで');
    // 壁の断面線: 仕上げ空間側の面の縦線だけ（床から天井仕上げの断面線の端まで。断面エンジンの縦線＋天端からの延長）
    const edgeIn = verticalsAt(seq5, spaceInner, [CUT]), edgeOut = verticalsAt(seq5, spaceOuter, [CUT]);
    assert.ok(edgeIn.length >= 1, `壁の仕上げ空間側の面 x=${spaceInner} に断面の縦線がある（実際 ${JSON.stringify(edgeIn)}）`);
    assert.equal(edgeOut.length, 0, `壁の踊り場側の面 x=${spaceOuter} には縦線を描かない`);
    const zLo = Math.min(...edgeIn.map(p => Math.min(-p.y1, -p.y2))), zHi = Math.max(...edgeIn.map(p => Math.max(-p.y1, -p.y2)));
    near(zLo, 0, '壁の断面線は床から');
    const soffit = soffitLinesOf(seq5);
    assert.equal(soffit.length, 1, '天井仕上げの断面線');
    const wallPt = [...soffit[0].points].sort((a, b) => a[0] - b[0])[seq5.landingEnd === 'left' ? 0 : soffit[0].points.length - 1];
    near(wallPt[0], spaceInner, '天井仕上げの断面線の壁側の端は仕上げ空間側の面の上');
    near(zHi, -wallPt[1], '壁の縦線の上端＝天井仕上げの断面線の端（隙間なし）');
    // 縦線は連続（断面エンジンの天端までの縦線と、そこから天井仕上げまでの延長が切れ目なく並ぶ）
    const sorted = edgeIn.map(p => [Math.min(-p.y1, -p.y2), Math.max(-p.y1, -p.y2)]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) near(sorted[i][0], sorted[i - 1][1], '縦線に隙間がない');
    // 天端の水平線は無い（壁の厚みは描かない側）
    const top = seq5.content.filter(p => p.type === 'line' && Math.abs(p.y1 - p.y2) < 1e-6
      && Math.abs(Math.min(p.x1, p.x2) - wallLoX) < 1e-6 && Math.abs(Math.max(p.x1, p.x2) - wallHiX) < 1e-6);
    assert.equal(top.length, 0, '壁の天端の線は描かない');
  });

  test(`木造（flip=${flip}）: seq5 の天井仕上げの断面線（中線）は Y4＋壁厚/2 と FL＋CH の交点から壁の仕上げ空間側の面まで 1 本で、垂直の段は無い。本体の中に壁の content は無い`, () => {
    // この fixture の裏面の始まりは約 1993（階高 2400・蹴上 200）なので、CH 1800 で「交点」が裏面より下になる構成
    const fx = makeFixture(StructuralMaterialType.WOOD, { flip, chLowerMm: 1800 });
    const { seq5 } = fx;
    const face = seq5.face;
    const soffit = soffitLinesOf(seq5);
    assert.equal(soffit.length, 1, `裏面の断面線（中線の折れ線）が 1 本（実際 ${JSON.stringify(soffit)}）`);
    const pts = [...soffit[0].points].sort((a, b) => a[0] - b[0]);
    const first = pts[0], last = pts[pts.length - 1];
    const wallPt = seq5.landingEnd === 'left' ? first : last;
    const arrivalEnd = seq5.landingEnd === 'left' ? last : first;
    const wallEdge = verticalsAt(seq5, wallPt[0], [CUT]);
    assert.ok(wallEdge.length >= 1, '裏面の線の壁側の端は壁の面の上');
    assert.ok(-arrivalEnd[1] > -wallPt[1], '裏面は到達辺へ向かって上がる');
    near(-arrivalEnd[1], fx.chLowerMm, '到達辺側の端の高さは FL＋CH（階段室の CH）');
    // 到達辺側の端の x は Y4＋壁厚/2＝裏面の始まり（最上段の段板の前縁）。この fixture の面は到達辺の壁の内面（通り芯＋57.5）を
    // 原点にするので、面の端（0 または run）と一致する（moku4-3 のように到達辺に壁が無い面では面の端＋57.5）
    const arrivalX = seq5.landingEnd === 'left' ? face.run : 0;
    near(arrivalEnd[0], arrivalX, '到達辺側の端は Y4＋壁厚/2（＝この面の端）');
    // 垂直の段（CH→裏面の実高）は無い（面端の壁の縦線 recess〔床から上階天井まで〕とは別）
    const joint = verticalsAt(seq5, arrivalEnd[0], [SIL]).filter(p =>
      Math.abs(Math.max(-p.y1, -p.y2) - fx.chLowerMm) < 1e-6 && Math.min(-p.y1, -p.y2) > 0);
    assert.equal(joint.length, 0, `到達辺側に CH からの垂直の段は無い（実際 ${JSON.stringify(joint)}）`);
    // 復路の本体（裏面〜段板の上面）の中に壁の断面・見えがかり・アキ（階段自身の線以外の line）の点は無い
    const soffitZAt = x => -drawnFloorProfileZAt(pts, x); // 折れ線の点は図座標（y = −z）
    const bodyTopAt = x => drawnFloorProfileZAt(seq5.stairFloorProfile, x);
    const x0 = first[0], x1 = last[0];
    for (const p of seq5.content) {
      if (p.type !== 'line' || p.weight === CUT) continue; // 階段自身の断面（太線）は本体そのもの
      for (const [x, y] of [[p.x1, p.y1], [p.x2, p.y2]]) {
        if (x <= x0 + 1 || x >= x1 - 1) continue;
        const z = -y;
        assert.ok(z <= soffitZAt(x) + 1e-6 || z >= bodyTopAt(x) - 1e-6, `本体の中の点 (${x}, ${z}): 裏面 ${soffitZAt(x)}・上面 ${bodyTopAt(x)}`);
      }
    }
  });
}

for (const flip of [true, false]) {
  test(`【開放辺（flip=${flip}）】仕上げ空間の奥の開放辺の向こう（隣室の天井線・壁端の縦線・アキ）は復路の本体（裏面〜段板の上面）の中を通らない`, () => {
    const fx = makeFixture(StructuralMaterialType.WOOD, { flip, openReturnSide: true });
    const { seq5 } = fx;
    const soffit = soffitLinesOf(seq5);
    assert.equal(soffit.length, 1, '裏面の断面線');
    const pts = [...soffit[0].points].sort((a, b) => a[0] - b[0]);
    const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    const soffitZAt = x => -drawnFloorProfileZAt(pts, x);
    const bodyTopAt = x => drawnFloorProfileZAt(seq5.stairFloorProfile, x);
    const inBody = (x, z) => x > x0 + 1 && x < x1 - 1 && z > soffitZAt(x) + 1e-6 && z < bodyTopAt(x) - 1e-6;
    // 前提: 開放辺の向こうの content（壁端の縦線 recess）が裏面の範囲の中にある（本体をまたいで引かれうる構成）
    const recess = seq5.content.filter(p => p.type === 'line' && p.weight === SIL && Math.abs(p.x1 - p.x2) < 1e-6
      && p.x1 > x0 + 1 && p.x1 < x1 - 1);
    assert.ok(recess.length >= 2, `壁端の縦線が本体の下と上に分かれている（実際 ${JSON.stringify(recess)}）`);
    for (const p of seq5.content) {
      if (p.type !== 'line' || p.weight === CUT) continue;
      if (Math.abs(p.x1 - p.x2) < 1e-6) {
        const zLo = Math.min(-p.y1, -p.y2), zHi = Math.max(-p.y1, -p.y2);
        if (p.x1 > x0 + 1 && p.x1 < x1 - 1) {
          assert.ok(!(zLo < soffitZAt(p.x1) - 1e-6 && zHi > bodyTopAt(p.x1) + 1e-6), `x=${p.x1} の縦線 ${zLo}..${zHi} が本体を貫く`);
          assert.ok(!inBody(p.x1, (zLo + zHi) / 2) || zHi - zLo < 1e-6, `x=${p.x1} の縦線 ${zLo}..${zHi} が本体の中`);
        }
        continue;
      }
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const x = p.x1 + (p.x2 - p.x1) * t, z = -(p.y1 + (p.y2 - p.y1) * t);
        assert.ok(!inBody(x, z), `線 (${p.x1},${-p.y1})-(${p.x2},${-p.y2}) の点 (${x}, ${z}) が本体の中`);
      }
    }
  });
}

test('【階段下部屋あり】帯の床が踊り場でも、仕上げ空間の床区間は階段室の床（0）で、踊り場の高さの床線が空間の上に浮かない', () => {
  const fx = makeFixture(StructuralMaterialType.WOOD, { withRoomUnder: true });
  const { seq5 } = fx;
  const { spaceEnd, spaceInner, spaceOuter } = wallLocals(fx);
  const inSpace = x => Math.min(spaceEnd, spaceOuter) - 1e-6 <= x && x <= Math.max(spaceEnd, spaceOuter) + 1e-6;
  const landingAbs = 6 * (OPTS.floorHeight / 12);
  const spaceSeg = seq5.floorSegments.find(s => inSpace((s.loX + s.hiX) / 2) && Math.abs(s.hiX - s.loX) > 115 + 1);
  assert.ok(spaceSeg, `仕上げ空間の床区間がある（実際 ${JSON.stringify(seq5.floorSegments)}）`);
  near(spaceSeg.floorDeltaMm, 0, '空間の床は階段室の床');
  const other = seq5.floorSegments.filter(s => s !== spaceSeg);
  assert.ok(other.length >= 1 && other.every(s => Math.abs(s.floorDeltaMm - landingAbs) < 1e-6), '空間の外は従来どおり踊り場の高さ');
  // 空間の外の区間の床線（踊り場の高さ）は空間の中へ入らない
  for (const s of other) {
    const lo = s.flatLineSpanX?.lo ?? s.loX, hi = s.flatLineSpanX?.hi ?? s.hiX;
    if (hi - lo <= 1e-6) continue;
    assert.ok(!inSpace((lo + hi) / 2) || Math.abs(hi - lo) < 1e-6, `踊り場の床線 ${lo}..${hi} が空間の中に出ている`);
  }
  near(drawnFloorProfileZAt(seq5.floorProfile, spaceEnd + (spaceInner - spaceEnd) * 0.5), 0, '空間の断面線は床');
});

test('【床段差】階段室の floorLevel が 300 なら、仕上げ空間の断面線・壁の断面の下端は 300 で、壁の天端は裏面の線の壁側の端と一致する', () => {
  const fx = makeFixture(StructuralMaterialType.WOOD, { floorLevel: 300 });
  const { seq5 } = fx;
  const { wallLoX, wallHiX, spaceEnd, spaceInner } = wallLocals(fx);
  void wallHiX;
  const z = drawnFloorProfileZAt(seq5.floorProfile, spaceEnd + (spaceInner - spaceEnd) * 0.5);
  near(z, 300, '空間の断面線は階段室の床（段差込み）');
  const edges = verticalsAt(seq5, spaceInner, [CUT]);
  assert.ok(edges.length >= 1, '壁の仕上げ空間側の面の断面');
  near(Math.min(...edges.map(e => Math.min(-e.y1, -e.y2))), 300, '壁の断面の下端は床');
  assert.equal(verticalsAt(seq5, wallLoX === spaceInner ? wallHiX : wallLoX, [CUT]).length, 0, '踊り場側の面は描かない');
  const soffit = soffitLinesOf(seq5);
  assert.equal(soffit.length, 1, '裏面の断面線');
  const pts = [...soffit[0].points].sort((a, b) => a[0] - b[0]);
  const wallPt = seq5.landingEnd === 'left' ? pts[0] : pts[pts.length - 1];
  near(-wallPt[1], Math.max(...edges.map(e => Math.max(-e.y1, -e.y2))), '壁の縦線の上端＝裏面の線の壁側の端（同じ床の基準）');
  assert.ok(-wallPt[1] > 300, '端は床より上');
});

test('【失敗系】CH が裏面の始まりより高い（天井仕上げが段板の中に入る）ときは、到達辺側の端は裏面の実高のまま（CH へ上げない）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), xm = cl(CenterLineType.VERTICAL, 1000), x1 = cl(CenterLineType.VERTICAL, 2000);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), ym = cl(CenterLineType.HORIZONTAL, 1500), y1 = cl(CenterLineType.HORIZONTAL, 4500);
  const cells = new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`, `${x0.id}:${ym.id}:${xm.id}:${y1.id}`, `${xm.id}:${ym.id}:${x1.id}:${y1.id}`]);
  const room = graph.addRoom(new Set(cells), '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], riser: null, upDirection: 'up', flip: true });
  stair.setField('structure', StructuralMaterialType.WOOD);
  generateStairUnderReturnWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE });
  // 復路レーン（x 0..1000）を縦断する切断。局所 x＝世界 y（原点 0・dirSign +1）。踊り場は y 0..1500＝左端（landingEnd 'left'）、
  // 到達辺は y 4500＝右端なので、仕上げ空間は壁（y 1500 付近）から右へ、到達辺側の節は x 最大
  const cut = { line: { isVertical: true, axisValue: 500, lo: 0, hi: 4500 }, dirSign: 1, landingEnd: 'left' };
  const low = underReturnSpaceOf(stair, graph, cut, OPTS.floorHeight, 0, 1000);
  const high = underReturnSpaceOf(stair, graph, cut, OPTS.floorHeight, 0, 9000);
  const none = underReturnSpaceOf(stair, graph, cut, OPTS.floorHeight, 0, null);
  const arrival = s => s.soffit.reduce((a, n) => (n.x > a.x ? n : a), s.soffit[0]);
  near(arrival(low).z, 1000, 'CH が裏面より低ければ CH');
  near(arrival(high).z, arrival(none).z, 'CH が裏面より高ければ裏面の実高のまま');
  assert.ok(arrival(none).z < 9000 && arrival(none).z > 1000, '前提: 裏面の実高は 1000 と 9000 の間');
});

test('【対照】鉄骨（復路下の壁なし）: seq5 の断面線は復路の段板の裏のままで、裏面の線・床への切替えは無い', () => {
  const { underWalls, seq5 } = makeFixture(StructuralMaterialType.STEEL);
  assert.equal(underWalls.length, 0, '鉄骨には復路下の壁が立たない');
  assert.equal(seq5.stairFloorProfile, undefined, '仕上げ空間なし＝断面線の差し替えなし');
  assert.equal(soffitLinesOf(seq5).length, 0, '裏面の断面線は無い');
});

test('【失敗系】underReturnSpaceOf: 切断線が復路下の壁の区間の外・壁と平行・階段なし・cut なしは null', () => {
  const { graph, stair, seq5 } = makeFixture(StructuralMaterialType.WOOD);
  const base = { line: { isVertical: true, axisValue: 500, lo: 0, hi: 4500 }, dirSign: 1, landingEnd: 'right', face: seq5.face };
  assert.ok(underReturnSpaceOf(stair, graph, { ...base, landingEnd: 'right' }, OPTS.floorHeight, 0), '壁の区間（x 0..1057.5）を横切る切断線は空間あり');
  assert.equal(underReturnSpaceOf(stair, graph, { ...base, line: { ...base.line, axisValue: 1500 } }, OPTS.floorHeight, 0), null, '壁の区間の外（x=1500）');
  assert.equal(underReturnSpaceOf(stair, graph, { ...base, line: { isVertical: false, axisValue: 1500, lo: 0, hi: 2000 } }, OPTS.floorHeight, 0), null, '壁と平行な切断線');
  assert.equal(underReturnSpaceOf(null, graph, base, OPTS.floorHeight, 0), null, '階段なし');
  assert.equal(underReturnSpaceOf(stair, graph, null, OPTS.floorHeight, 0), null, 'cut なし');
  assert.equal(underReturnSpaceOf(stair, graph, base, null, 0), null, '階高不明（蹴上が決まらない）');
});

test('clipContentInsideStairBody: 裏面〜段板の上面（本体の中）の content だけを落とし、本体の上・裏面の下・範囲の外は残す', () => {
  // 裏面 z=1000（x=0）→2000（x=1000）、上面 z=2400（x=0）→3000（x=1000）。範囲は x 0..1000
  const space = { soffit: [{ x: 0, z: 1000 }, { x: 1000, z: 2000 }], bodyTop: [[0, 2400], [1000, 3000]] };
  const line = (x1, z1, x2, z2, extra = {}) => ({ type: 'line', x1, y1: -z1, x2, y2: -z2, weight: 'medium', ...extra });
  const out = clipContentInsideStairBody([
    line(0, 1500, 1000, 1500),     // 水平 1500: 裏面（1000→2000）が 1500 より低い x<500 では本体の中 → 裏面より下になる 500..1000 だけ残る
    line(500, 0, 500, 5000),       // 縦線: 裏面 1500 〜 上面 2700 の間が落ちて 2 本になる
    line(2000, 0, 3000, 5000),     // 範囲の外 → そのまま
    line(0, 2600, 1000, 2600),     // 水平 2600: 上面（2400→3000）が 2600 を超える x>333.3 で本体の中
  ], space);
  const horizontal1500 = out.filter(p => Math.abs(-p.y1 - 1500) < 1e-6 && Math.abs(-p.y2 - 1500) < 1e-6);
  assert.equal(horizontal1500.length, 1);
  near(Math.min(horizontal1500[0].x1, horizontal1500[0].x2), 500, '裏面との交点で切れる');
  near(Math.max(horizontal1500[0].x1, horizontal1500[0].x2), 1000, '裏面より下の側は範囲の端まで残る');
  const verticals = out.filter(p => Math.abs(p.x1 - 500) < 1e-6 && Math.abs(p.x2 - 500) < 1e-6).sort((a, b) => -a.y1 - -b.y1);
  assert.equal(verticals.length, 2, '本体の中を抜く');
  near(Math.max(-verticals[0].y1, -verticals[0].y2), 1500, '下の片は裏面まで');
  near(Math.min(-verticals[1].y1, -verticals[1].y2), 2700, '上の片は上面から');
  assert.ok(out.some(p => p.x1 === 2000 && p.x2 === 3000 && -p.y2 === 5000), '範囲の外は不変');
  const horizontal2600 = out.filter(p => Math.abs(-p.y1 - 2600) < 1e-6 && Math.abs(-p.y2 - 2600) < 1e-6);
  assert.equal(horizontal2600.length, 1);
  near(Math.max(horizontal2600[0].x1, horizontal2600[0].x2), 1000 / 3, '上面との交点で切れる（本体の上だけ残る）', 1e-3);
  assert.deepEqual(clipContentInsideStairBody([line(0, 1500, 1000, 1500)], null), [line(0, 1500, 1000, 1500)], '空間なしは不変');
  // 範囲の端をまたぐ rect（建具の姿）: 範囲の外の片はそのまま、中の片は裏面より下だけ（二重に出ない・本体の中に掛からない）
  const rect = { type: 'rect', x: -50, y: -3000, w: 150, h: 3000 }; // z 0..3000、x −50..100
  const rects = clipContentInsideStairBody([rect], space).filter(p => p.type === 'rect');
  assert.equal(rects.length, 2, `範囲の外の片と中の片の 2 個（実際 ${JSON.stringify(rects)}）`);
  const outside = rects.find(p => p.x < 0), inside = rects.find(p => p.x >= 0);
  assert.deepEqual([outside.x, outside.w, outside.y, outside.h], [-50, 50, -3000, 3000], '範囲の外の片は不変');
  near(inside.x, 0, '中の片は x0 から'); near(inside.w, 100, '中の片は範囲の中だけ');
  assert.ok(-inside.y <= 1000 + 1e-6, `中の片の上端は裏面（x 0..100 の最低 1000）以下（実際 ${-inside.y}）`);
  // line/polyline/rect/text 以外の型は 1 回だけ素通し
  const tri = { type: 'miterTriangle', x: 500, y: 0, dir: 1 };
  assert.deepEqual(clipContentInsideStairBody([tri], space), [tri], '注記系は 1 個のまま');
  // bodyTop が無ければ裏面より上を全部落とす
  const noTop = clipContentInsideStairBody([line(500, 0, 500, 5000)], { soffit: space.soffit });
  assert.equal(noTop.length, 1); near(Math.max(-noTop[0].y1, -noTop[0].y2), 1500, '裏面まで');
});

test('【失敗系】upperFloorEndLines: 床へ下げた断面線（floorProfile）に最終段の天端が無くても、stairFloorProfile があればそちらで上階 FL のはね出しを引く', () => {
  const face = { run: 1000, hasWallAtLocal0: false, hasWallAtLocalRun: true, hiddenWallAtLocal0: false, hiddenWallAtLocalRun: false };
  const stairProfile = [[0, 0], [40, 0], [40, 2400], [60, 2400], [300, 2000], [1000, 1200]];
  const flat = [[0, 0], [600, 0], [600, 1800], [1000, 1200]];
  const withFull = upperFloorEndLines({ face, floorProfile: flat, stairFloorProfile: stairProfile }, 2400, 150);
  assert.equal(withFull.length, 1, 'stairFloorProfile の天端（x=40）から外へ');
  near(withFull[0].x1, -150, 'はね出しの外端'); near(withFull[0].x2, 40, '天端の外側の点'); near(-withFull[0].y1, 2400, '上階 FL');
  const without = upperFloorEndLines({ face, floorProfile: flat }, 2400, 150);
  assert.equal(without.length, 0, '床へ下げた断面線だけでは天端が見つからない（従来の判定）');
});

test('floorProfileWithFloorOn: 範囲を床の高さに置き換え、境目は垂直の段。範囲の外は不変。輪郭の外へはみ出す範囲・段と一致する端・空の輪郭', () => {
  const prof = [[0, 1400], [500, 1400], [500, 2000], [1000, 2000]];
  const out = floorProfileWithFloorOn(prof, 0, 700, 0);
  near(drawnFloorProfileZAt(out, 100), 0, '範囲の中は床');
  near(drawnFloorProfileZAt(out, 699), 0, '範囲の端の内側は床');
  near(drawnFloorProfileZAt(out, 701), 2000, '範囲の外は元の輪郭');
  assert.deepEqual(out, [[0, 0], [700, 0], [700, 2000], [1000, 2000]]);
  assert.deepEqual(floorProfileWithFloorOn(prof, 200, 600, 0), [[0, 1400], [200, 1400], [200, 0], [600, 0], [600, 2000], [1000, 2000]]);
  // 範囲の端が輪郭の段（x=500）と一致: 段の左右の値はそれぞれ元の輪郭のまま
  assert.deepEqual(floorProfileWithFloorOn(prof, 0, 500, 0), [[0, 0], [500, 0], [500, 2000], [1000, 2000]]);
  assert.deepEqual(floorProfileWithFloorOn(prof, 500, 1000, 0), [[0, 1400], [500, 1400], [500, 0], [1000, 0]]);
  // 範囲が輪郭の外へはみ出す: 輪郭の始点より前・終点より後ろは範囲の端まで床
  assert.deepEqual(floorProfileWithFloorOn([[100, 1400], [500, 1400]], 0, 700, 0), [[0, 0], [700, 0]]);
  assert.deepEqual(floorProfileWithFloorOn([[100, 1400], [500, 1400]], 0, 300, 300), [[0, 300], [300, 300], [300, 1400], [500, 1400]]);
  assert.equal(floorProfileWithFloorOn(null, 0, 10, 0), null);
  assert.deepEqual(floorProfileWithFloorOn([], 0, 10, 0), []);
});

// ---- 復路下の仕上げ空間の巾木（ユーザー指示 2026-10-15「階段下スペースは『ホール』なので巾木が見える」）----
const DETAIL = weightForRole(ElevationLineRole.DETAIL);
const baseboardLines = (seq5, z) => seq5.content.filter(p => p.type === 'line' && p.weight === DETAIL
  && Math.abs(p.y1 + z) < 1e-6 && Math.abs(p.y2 + z) < 1e-6);

for (const flip of [true, false]) {
  test(`【巾木（flip=${flip}）】到達辺の外側の部屋（ホール h=60）の巾木が、面の端から復路下の壁の仕上げ空間側の面まで床+60 に細線で引かれる`, () => {
    const fx = makeFixture(StructuralMaterialType.WOOD, { flip, hallBaseboard: 'h=60', openArrival: true });
    assert.equal(fx.seq5.face[flip ? 'hasWallAtLocal0' : 'hasWallAtLocalRun'], false, '前提: 到達辺に壁が無い');
    const { spaceEnd, spaceInner } = wallLocals(fx);
    const lines = baseboardLines(fx.seq5, 60);
    assert.equal(lines.length, 1, `巾木は 1 本（実際 ${JSON.stringify(lines)}）`);
    const [lo, hi] = [Math.min(lines[0].x1, lines[0].x2), Math.max(lines[0].x1, lines[0].x2)];
    near(lo, Math.min(spaceEnd, spaceInner), '巾木の端（面の端か壁の面）');
    near(hi, Math.max(spaceEnd, spaceInner), '巾木のもう一方の端（面の端か壁の面）');
    // 面の端（はね出しへ伸ばさない）と、壁の仕上げ空間側の面で止まる（壁の厚みの中へは入らない）
    assert.ok(lo >= -1e-6 && hi <= fx.seq5.face.run + 1e-6, '面の範囲 0..run の内側');
  });
}

test('【失敗系・巾木】到達辺の外側に部屋が無い・巾木が解釈できない・空のときは引かない（同じ構成で h=60 なら引かれる対照つき）', () => {
  const open = o => makeFixture(StructuralMaterialType.WOOD, { openArrival: true, ...o }).seq5;
  assert.equal(baseboardLines(open({ hallBaseboard: 'h=60' }), 60).length, 1, '対照');
  assert.equal(baseboardLines(open({}), 60).length, 0, '外側に部屋なし');
  assert.equal(baseboardLines(open({ hallBaseboard: '既製品' }), 60).length, 0, '解釈不能');
  assert.equal(baseboardLines(open({ hallBaseboard: '' }), 60).length, 0, '空');
});

test('【失敗系・巾木】到達辺に壁がある: 外側のホールの巾木は使わず、階段室自身の巾木だけ（無ければ引かない）', () => {
  const closed = o => makeFixture(StructuralMaterialType.WOOD, o).seq5;
  const withHall = closed({ hallBaseboard: 'h=60' });
  assert.equal(withHall.face.hasWallAtLocal0 !== false && withHall.face.hasWallAtLocalRun !== false, true, '前提: 到達辺に壁がある');
  assert.equal(baseboardLines(withHall, 60).length, 0, 'ホールの巾木 60 は使わない');
  const own = closed({ hallBaseboard: 'h=60', stairBaseboard: 'h=80' });
  assert.equal(baseboardLines(own, 80).length, 1, '階段室自身の巾木 80 は引く');
  assert.equal(baseboardLines(own, 60).length, 0, 'ホールの巾木 60 は引かない');
  assert.equal(baseboardLines(closed({ stairBaseboard: '既製品' }), 60).length, 0, '階段室の巾木が解釈不能なら引かない');
});

test('【失敗系・巾木】巾木の高さが裏面より高いときは引かない／鉄骨（復路下の壁なし）は仕上げ空間が無いので引かない', () => {
  assert.equal(baseboardLines(makeFixture(StructuralMaterialType.WOOD, { hallBaseboard: 'h=9000', openArrival: true }).seq5, 9000).length, 0);
  const steel = makeFixture(StructuralMaterialType.STEEL, { hallBaseboard: 'h=60', openArrival: true });
  assert.equal(baseboardLines(steel.seq5, 60).length, 0);
});

// ---- 巾木は壁面に沿う部材（ユーザー指示 2026-10-15「B2: Y4 側は左側中線まで」）----
// 到達辺に壁が無いとき、面の壁が到達辺の外へ続く範囲だけ、巾木をその小口まで（壁のない端部の延長量 150 を上限に）伸ばす。
for (const flip of [true, false]) {
  test(`【巾木・壁面に沿う（flip=${flip}）】面の壁が到達辺の外へ 72.5 続くと、巾木は面の端の外 72.5（小口）から。延長量を超える壁でも 150 まで`, () => {
    const startOf = fx => {
      const lines = baseboardLines(fx.seq5, 60);
      assert.equal(lines.length, 1);
      const { spaceEnd } = wallLocals(fx);
      const xs = [lines[0].x1, lines[0].x2];
      // 到達辺側の端（面の端 spaceEnd から外へ何 mm 出ているか。外＝面の外側）
      return flip ? spaceEnd - Math.min(...xs) : Math.max(...xs) - spaceEnd;
    };
    const mk = o => makeFixture(StructuralMaterialType.WOOD, { flip, hallBaseboard: 'h=60', openArrival: true, ...o });
    near(startOf(mk({ wallBeyondMm: 72.5 })), 72.5, '壁が 72.5 続く→小口まで');
    near(startOf(mk({ wallBeyondMm: 400 })), 150, '延長量 150 が上限');
    near(startOf(mk({})), 0, '壁が続かない→面の端（0 または run）から');
  });
}
