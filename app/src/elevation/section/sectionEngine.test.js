// sectionEngine.js（WP-E4: buildSectionFigure）の単体テスト。
// 完了条件: floorSegmentsが隙間なく面全幅・hiX>loX／ceilingProfile昇順。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { makeProbeContext } from './sectionProbe.js';
import { buildSectionFigure, mergeColumns } from './sectionEngine.js';

const CH = 2400;

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

function frontCut(graph, overrides = {}) {
  return {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1, layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0, ...overrides,
  };
}

test('【WP-E4】buildSectionFigure: floorSegmentsは隙間なく面全幅を覆い、hiX>loX', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const fig = buildSectionFigure(cut, probeCtx);

  assert.ok(Array.isArray(fig.floorSegments) && fig.floorSegments.length > 0);
  for (const seg of fig.floorSegments) assert.ok(seg.hiX > seg.loX, `hiX(${seg.hiX})>loX(${seg.loX})のはず`);
  // 隙間なく面全幅を覆う: 隣接区間のhiX===次のloX、先頭loX===0、末尾hiX===face.run。
  const sorted = [...fig.floorSegments].sort((a, b) => a.loX - b.loX);
  assert.equal(sorted[0].loX, 0, '先頭区間のloXは面のローカル原点0のはず');
  assert.equal(sorted[sorted.length - 1].hiX, fig.face.run, '末尾区間のhiXは面全幅(face.run)のはず');
  for (let i = 0; i + 1 < sorted.length; i++) {
    assert.equal(sorted[i].hiX, sorted[i + 1].loX, '隣接区間は隙間なく連続するはず');
  }
});

test('【WP-E4】buildSectionFigure: ceilingProfileはlocalX昇順', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const fig = buildSectionFigure(cut, probeCtx);

  assert.ok(Array.isArray(fig.ceilingProfile) && fig.ceilingProfile.length >= 2);
  for (let i = 0; i + 1 < fig.ceilingProfile.length; i++) {
    assert.ok(fig.ceilingProfile[i][0] <= fig.ceilingProfile[i + 1][0],
      `ceilingProfileはlocalX昇順のはず（${JSON.stringify(fig.ceilingProfile)}）`);
  }
});

test('【WP-E4】buildSectionFigure: skipBaseboard/skipWallLabelは常にtrue（階段の下は原則描かない規約）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const fig = buildSectionFigure(cut, probeCtx);
  assert.equal(fig.skipBaseboard, true);
  assert.equal(fig.skipWallLabel, true);
  assert.equal(fig.seqNo, '1');
});

test('【WP-E4】mergeColumns: bandsが完全一致する隣接列は1列に統合される', () => {
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
    { x0: 1000, x1: 1500, worldLo: 1000, worldHi: 1500, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 999 }] },
  ];
  const merged = mergeColumns(columns);
  assert.equal(merged.length, 2, '先頭2列は同一bandsのため統合され、3列目だけ独立するはず');
  assert.equal(merged[0].x0, 0);
  assert.equal(merged[0].x1, 1000);
  assert.equal(merged[1].x0, 1000);
  assert.equal(merged[1].x1, 1500);
});

// ---- 失敗系 ----
test('【失敗系・WP-E4】buildSectionFigure: layers=[]（候補ゼロ）でも例外を投げずfloorSegments/ceilingProfileが返る', () => {
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext([]);
  const fig = buildSectionFigure(cut, probeCtx);
  assert.ok(fig.floorSegments.length > 0);
  assert.ok(fig.floorSegments[0].hiX > fig.floorSegments[0].loX);
  assert.ok(fig.ceilingProfile.length >= 2);
});

test('【失敗系・WP-E4】mergeColumns: 列0件でも例外を投げず空配列を返す', () => {
  assert.deepEqual(mergeColumns([]), []);
});
