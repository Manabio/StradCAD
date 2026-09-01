// sectionVisibility.js（断面面内の可視領域＝「断面の中」でない領域の判定）のテスト。
// ユーザー明示指示2026-08「展開図では断面の中は描画しない」「断面の中とは、連続した断面線で
// 切り取られた向こう側全て（壁の中も隣の部屋も含む）」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { composeRoomFaces } from '../elevationFaceList.js';
import { makeProbeContext } from './sectionProbe.js';
import { cutPlaneOffsetMm, faceCutLine, faceViewSign } from './sectionCutPlane.js';
import { structuralColumnContribution } from './sectionStructure.js';
import { buildColumns } from './sectionEngine.js';
import { airIntervalsOf, reachableLocalRanges } from './sectionVisibility.js';

// ---- airIntervalsOf: 1列の空気区間 ----

test('airIntervalsOf: 上下いっぱいの切断壁がある列に空気は無い', () => {
  assert.deepEqual(airIntervalsOf([{ kind: 'cut', z0: 0, z1: 2400 }], 0, 2400), []);
});

test('airIntervalsOf: 腰壁（天端800）の列は天端の上だけが空気になる', () => {
  assert.deepEqual(airIntervalsOf([{ kind: 'cut', z0: 0, z1: 800 }], 0, 2400),
    [{ z0: 800, z1: 2400 }]);
});

test('airIntervalsOf: アキ（腰壁＋垂れ壁）の列は穴のぶんだけ空気になる', () => {
  assert.deepEqual(airIntervalsOf(
    [{ kind: 'cut', z0: 0, z1: 800 }, { kind: 'cut', z0: 1800, z1: 2400 }], 0, 2400),
  [{ z0: 800, z1: 1800 }]);
});

test('airIntervalsOf: 見えがかり壁（wall）は切断面内の空気を削らない', () => {
  // 見えがかりは切断面の**向こう**にある実体なので、切断面内の横の連結は遮らない。
  assert.deepEqual(airIntervalsOf([{ kind: 'wall', z0: 0, z1: 2400 }], 0, 2400),
    [{ z0: 0, z1: 2400 }]);
});

// ---- reachableLocalRanges: 連結成分 ----

const FLOOR_HEIGHT = 3000, CH = 2400;
function makeGraph(name, elevation) { return new PlanGraph(new Plane(name, elevation, name, 1, 1)); }
function clOf(graph, type, value) {
  return graph.centerLines.find(cl => cl.centerLineType === type && cl.value === value)
    ?? graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
}
function makeRectRoom(graph, x0v, y0v, x1v, y1v, name) {
  const x0 = clOf(graph, CenterLineType.VERTICAL, x0v);
  const x1 = clOf(graph, CenterLineType.VERTICAL, x1v);
  const y0 = clOf(graph, CenterLineType.HORIZONTAL, y0v);
  const y1 = clOf(graph, CenterLineType.HORIZONTAL, y1v);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

// 1階0..6600の1室に対し、2階はX2(=3200)で左右に分かれる（右を種＝見えている側とする）。
// kneeTopMm を与えるとX2の壁を腰壁にする。
function reachableOnFaceA({ kneeTopMm = null } = {}) {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 6600, 3000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  makeRectRoom(g2, 0, 0, 3200, 3000, '21');
  makeRectRoom(g2, 3200, 0, 6600, 3000, '22');
  if (kneeTopMm != null) {
    const cls = [...g2.centerLines];
    const vCL = cls.find(c => c.centerLineType === CenterLineType.VERTICAL && c.effectiveValue === 3200);
    const h0 = cls.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.effectiveValue === 0);
    const h1 = cls.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.effectiveValue === 3000);
    g2.setKneeDropWall(`${vCL.id}:${h0.id}:${h1.id}`, { knee: { topHeight: kneeTopMm }, drop: null });
  }
  const face = composeRoomFaces(room, g1).find(f => f.label === 'A');
  const layers = [{ graph: g2, floorZMm: FLOOR_HEIGHT, role: 'self' }];
  const probeCtx = makeProbeContext(layers);
  const cut = {
    seqNo: 'A', dirSign: face.dirSign, face, viewSign: faceViewSign(face),
    line: faceCutLine(face, cutPlaneOffsetMm(face, layers, { columnSolids: structuralColumnContribution(layers) })),
    layers, baseFloorZ: FLOOR_HEIGHT,
    zRange: { loZ: FLOOR_HEIGHT, hiZ: FLOOR_HEIGHT + CH },
  };
  // 種＝X2より右（面ローカル3142.5以上）。実運用では吹抜けの範囲。
  const ranges = reachableLocalRanges(buildColumns(cut, probeCtx),
    { loZ: FLOOR_HEIGHT, ceilOf: () => FLOOR_HEIGHT + CH }, [{ lo: 3142.5, hi: face.run }]);
  return { face, ranges };
}

test('【明示指示】reachableLocalRanges: 上下いっぱいの切断壁の向こうへは到達しない（＝断面の中）', () => {
  const { ranges } = reachableOnFaceA();
  assert.ok(ranges.length > 0, '種の側は到達できるはず');
  assert.ok(ranges.every(r => r.lo >= 3200 - 1e-6),
    `X2の壁(面ローカル3085..3200)より左へは到達しないはず（実際:${JSON.stringify(ranges)}）`);
});

test('【明示指示】reachableLocalRanges: 腰壁なら天端の上で連結するので向こう側へ到達する', () => {
  const { face, ranges } = reachableOnFaceA({ kneeTopMm: 800 });
  assert.ok(ranges.some(r => r.lo < 3085 - 1e-6),
    `腰壁越しに左まで到達するはず（実際:${JSON.stringify(ranges)}）`);
  assert.ok(ranges.some(r => r.hi > face.run - 1e-6), '種の側も引き続き到達できるはず');
});

// 独立検算（ユーザー案の「分割された左右どちらが中か」）: 図を完全に分断する断面線については、
// その左右のうち到達可能なのは必ず片側だけになる。連結成分の答えをこの性質で照合する。
test('【不変条件】図を分断する断面線の左右で、到達可能なのは片側だけ', () => {
  const { ranges } = reachableOnFaceA();
  const left = ranges.some(r => r.hi <= 3085 + 1e-6);
  const right = ranges.some(r => r.lo >= 3200 - 1e-6);
  assert.equal(left && right, false, '分断する断面線の両側が同時に到達可能になってはいけない');
  assert.equal(right, true, '種を置いた側が到達可能な側');
});
