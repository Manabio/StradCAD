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
const DETAIL = weightForRole(ElevationLineRole.DETAIL);
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

// 折返し階段（踊り場 y0..1500 全幅・往路/復路レーン y1500..4500。flip=true＝往路が x 大側・復路が x 0..1000、flip=false はその逆）。
// openReturnSide: 復路レーンの外側の壁（seq5 が見る壁）の到達辺側 y 3500..4500 を開口にして、その向こうに隣室を置く
// （stair-ports-test5 の構成。仕上げ空間の奥の開放辺に隣室の天井線・壁端の縦線・アキが現れる）。
function makeFixture(structure, { flip = true, withRoomUnder = false, floorLevel = null, openReturnSide = false } = {}) {
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
  const entries = stairFaceSequence(stair, composeRoomFaces(room, graph), graph, { ...OPTS, upperGraph, layers });
  return { graph, room, stair, underWalls, entries, seq5: entries.find(e => e.seqNo === '5') };
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
const soffitLinesOf = seq5 => seq5.content.filter(p => p.type === 'polyline' && p.weight === SIL && p.points.length >= 2
  && p.points.every(([, y]) => -y > 0 && -y < OPTS.floorHeight));

for (const flip of [true, false]) {
  test(`木造（flip=${flip}）: seq5 の断面線は到達辺から復路下の壁の向こうの面まで床（0）で、壁の断面（両面の太線＋細線の天端）が描かれる`, () => {
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
    near(drawnFloorProfileZAt(seq5.floorProfile, (spaceInner + spaceOuter) / 2), 0, '壁の厚みの中も床');
    const landingX = seq5.landingEnd === 'left' ? 1 : seq5.face.run - 1;
    assert.ok(drawnFloorProfileZAt(seq5.floorProfile, landingX) >= 1200 - 1e-6, '踊り場側の断面線は踊り場の高さ以上');
    // 床線は壁の踊り場側の面まで（flatLineSpanX）
    const seg = seq5.floorSegments[0];
    const floorEnd = seq5.landingEnd === 'left' ? (seg.flatLineSpanX?.lo ?? seg.loX) : (seg.flatLineSpanX?.hi ?? seg.hiX);
    near(floorEnd, spaceOuter, '床線は壁の踊り場側の面まで');
    // 壁の断面: 両面の太線（床から天端まで）と、天端の細線（階段の裏面との取り合い＝自由な縁ではない）
    const edgeLo = verticalsAt(seq5, wallLoX, [CUT]), edgeHi = verticalsAt(seq5, wallHiX, [CUT]);
    assert.equal(edgeLo.length, 1, `壁の面 x=${wallLoX} の断面の縦線が 1 本（実際 ${JSON.stringify(edgeLo)}）`);
    assert.equal(edgeHi.length, 1, `壁の面 x=${wallHiX} の断面の縦線が 1 本`);
    near(Math.max(-edgeLo[0].y1, -edgeLo[0].y2), Math.max(-edgeHi[0].y1, -edgeHi[0].y2), '両面の上端は同じ高さ（平らな天端）');
    near(Math.min(-edgeLo[0].y1, -edgeLo[0].y2), 0, '壁の断面は床から');
    const topZ = Math.max(-edgeLo[0].y1, -edgeLo[0].y2);
    assert.ok(topZ > 0 && topZ < 1200, `天端は床と踊り場の間（実際 ${topZ}）`);
    const top = seq5.content.filter(p => p.type === 'line' && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - topZ) < 1e-6
      && Math.abs(Math.min(p.x1, p.x2) - wallLoX) < 1e-6 && Math.abs(Math.max(p.x1, p.x2) - wallHiX) < 1e-6);
    assert.equal(top.length, 1, '天端の線が 1 本');
    assert.equal(top[0].weight, DETAIL, '天端の線は細線（junctionTop）');
  });

  test(`木造（flip=${flip}）: seq5 に復路の裏面＝天井仕上げの断面線（中線）が到達辺から壁の踊り場側の面まで引かれ、手前の天井（CH）から垂直の段でつながる。本体の中に壁の content は無い`, () => {
    const fx = makeFixture(StructuralMaterialType.WOOD, { flip });
    const { seq5 } = fx;
    const face = seq5.face;
    const soffit = soffitLinesOf(seq5);
    assert.equal(soffit.length, 1, `裏面の断面線（中線の折れ線）が 1 本（実際 ${JSON.stringify(soffit)}）`);
    const pts = [...soffit[0].points].sort((a, b) => a[0] - b[0]);
    const first = pts[0], last = pts[pts.length - 1];
    const wallPt = seq5.landingEnd === 'left' ? first : last;
    const arrivalEnd = seq5.landingEnd === 'left' ? last : first;
    const wallEdge = verticalsAt(seq5, wallPt[0], [CUT]);
    assert.equal(wallEdge.length, 1, '裏面の線の壁側の端は壁の面の上');
    near(-wallPt[1], Math.max(-wallEdge[0].y1, -wallEdge[0].y2), '裏面の線の壁側の端＝壁の天端');
    assert.ok(-arrivalEnd[1] > -wallPt[1], '裏面は到達辺へ向かって上がる');
    assert.ok(-arrivalEnd[1] < OPTS.floorHeight, '到達辺側の端は上階 FL より下（裏面の厚みぶん）');
    near(arrivalEnd[0], seq5.landingEnd === 'left' ? face.run : 0, '到達辺側の端は面の端（到達辺）');
    // 手前の天井（階段室の CH 2400）から裏面の端までの垂直の段
    const joint = verticalsAt(seq5, arrivalEnd[0], [SIL]).filter(p =>
      Math.abs(Math.max(-p.y1, -p.y2) - OPTS.chLowerMm) < 1e-6 && Math.abs(Math.min(-p.y1, -p.y2) - -arrivalEnd[1]) < 1e-6);
    assert.equal(joint.length, 1, `CH(${OPTS.chLowerMm})→裏面の端の垂直の段が 1 本`);
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
  const z = drawnFloorProfileZAt(seq5.floorProfile, spaceEnd + (spaceInner - spaceEnd) * 0.5);
  near(z, 300, '空間の断面線は階段室の床（段差込み）');
  const edges = [...verticalsAt(seq5, wallLoX, [CUT]), ...verticalsAt(seq5, wallHiX, [CUT])];
  assert.equal(edges.length, 2, '壁の両面の断面');
  for (const e of edges) near(Math.min(-e.y1, -e.y2), 300, '壁の断面の下端は床');
  const soffit = soffitLinesOf(seq5);
  assert.equal(soffit.length, 1, '裏面の断面線');
  const pts = [...soffit[0].points].sort((a, b) => a[0] - b[0]);
  const wallPt = seq5.landingEnd === 'left' ? pts[0] : pts[pts.length - 1];
  near(-wallPt[1], Math.max(-edges[0].y1, -edges[0].y2), '壁の天端＝裏面の線の壁側の端（同じ床の基準）');
  assert.ok(-wallPt[1] > 300, '天端は床より上');
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
