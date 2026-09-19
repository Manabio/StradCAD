// transform/centerLineMerge.js の単体テスト。
// findCenterLineMergeMatch の相手選択は centerLineKindPolicy.mergeCandidates（走査API）経由——
// centerLineOps.test.js の「同座標に複数種別が同時にある」テスト（M-1）は「重ねた配置」「離した配置」の
// 2パターンのみで、「隣接して結合する」経路は別途ここで検証する（ステップ7、2026-09-20）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import {
  getCenterLineSegment, segmentsCollinearTouching, findCenterLineMergeMatch, mergeCenterLineChain,
} from './centerLineMerge.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

test('findCenterLineMergeMatch: kindが一致し隣接（端点一致）する候補だけを返す（種別違いは隣接していても無視）', () => {
  const graph = makeGraph();
  const auxNeighbor = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, lineType: 'dashed', extentLo: 1000, extentHi: 2000,
  });
  // 同じ位置に隣接する center 種別（kind='aux'では無視されるはず）
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -1000, extentHi: 0,
  });
  const segment = { p1: { x: 1000, y: 0 }, p2: { x: 1000, y: 1000 } };

  const match = findCenterLineMergeMatch(graph, segment, CenterLineType.VERTICAL, 'aux');
  assert.ok(match, '隣接するaux候補が見つかるはず');
  assert.equal(match.candidate.id, auxNeighbor.id, 'center種別（種別違い）は無視され、aux候補だけが選ばれる');
});

test('findCenterLineMergeMatch: labeled:trueの候補（通り芯相当）は同種別・隣接でも除外する', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: true, discipline: Discipline.ARCH, extentLo: 1000, extentHi: 2000,
  });
  const segment = { p1: { x: 1000, y: 0 }, p2: { x: 1000, y: 1000 } };
  const match = findCenterLineMergeMatch(graph, segment, CenterLineType.VERTICAL, 'center');
  assert.equal(match, null, 'labeled:trueの候補はmergeCandidatesが除外するためマッチしない');
});

test('findCenterLineMergeMatch: excludeIdsに含まれる候補は隣接・種別一致でも除外する', () => {
  const graph = makeGraph();
  const self = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, lineType: 'dashed', extentLo: 1000, extentHi: 2000,
  });
  const segment = { p1: { x: 1000, y: 0 }, p2: { x: 1000, y: 1000 } };
  const match = findCenterLineMergeMatch(graph, segment, CenterLineType.VERTICAL, 'aux', [self.id]);
  assert.equal(match, null, '自分自身（excludeIds）は候補から外れる');
});

test('mergeCenterLineChain: 隣接するaux同士は1本に結合される（survivorのextentが延伸、loserは削除）', () => {
  const graph = makeGraph();
  const subject = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, lineType: 'dashed', extentLo: 0, extentHi: 1000,
  });
  const neighbor = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, lineType: 'dashed', extentLo: 1000, extentHi: 2000,
  });

  const result = mergeCenterLineChain(graph, subject, { kind: 'aux' });
  assert.equal(result.merged, true);
  assert.equal(result.survivorId, subject.id);
  assert.equal(subject.extentHi, 2000, 'survivorのextentHiがloser側まで延伸される');
  assert.equal(graph.shapeMap.has(neighbor.id), false, 'loserは削除される');
});

// ---- 仮想候補（centerLineOps.js virtualCandidate と同型: discipline/lineTypeを持たない）----
// virtualCandidateは discipline/lineType を持たないため、centerLineKind(virtualCandidate) は常に
// 既定値 'center' になる（core/centerLine.js centerLineKind参照）。findCenterLineMergeMatch の kind
// 引数を無視して centerLineKind(subject) から種別を導出する実装に戻すと、kind='beam'/'aux' の
// virtualCandidate が誤って center 候補と結合してしまう（またはaux/beam候補を無視してしまう）——
// これを検出する回帰テスト。

test('mergeCenterLineChain: 仮想候補（discipline/lineType無し）でもkind引数どおりの種別だけを結合相手に選ぶ（beam）', () => {
  const graph = makeGraph();
  // 仮想候補と同じ位置に隣接する center 種別（centerLineKind(virtualCandidate)が誤って'center'に
  // なった場合はこちらが選ばれてしまう）。
  const wrongNeighborCenter = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 1000, extentHi: 1500,
  });
  const beamNeighbor = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 1000, extentHi: 2000,
  });
  // virtualCandidate: centerLineOps.js addCenterLineFromDialogのextentProps同型（discipline/lineType無し、
  // labeled:falseのみ）。id を持たないため mergeCenterLineChain は「延伸のみ」経路に入る。
  const virtualCandidate = {
    centerLineType: CenterLineType.VERTICAL, value: 1000,
    labeled: false, extentLoRef: null, extentHiRef: null, extentLo: 0, extentHi: 1000,
  };

  const result = mergeCenterLineChain(graph, virtualCandidate, { kind: 'beam' });
  assert.equal(result.merged, true);
  assert.equal(result.survivorId, beamNeighbor.id, 'beam候補（beamNeighbor）が延伸されて生き残る');
  assert.equal(beamNeighbor.extentLo, 0, 'beamNeighborのextentLoが仮想候補側まで延伸される');
  assert.equal(graph.shapeMap.has(wrongNeighborCenter.id), true, 'center種別の候補は結合されず残ったまま');
});

// ---- getCenterLineSegment / segmentsCollinearTouching（純ジオメトリ関数）の直接テスト ----

test('getCenterLineSegment: RADIAL・extent未確定・ゼロ長はnull', () => {
  const graph = makeGraph();
  const radial = graph.addCenterLine(CenterLineType.RADIAL, 30, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(getCenterLineSegment(radial), null);

  const unresolved = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: false, lineType: 'dashed', extentLo: 0, extentHi: null,
  });
  assert.equal(getCenterLineSegment(unresolved), null);

  const zeroLen = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: false, lineType: 'dashed', extentLo: 500, extentHi: 500,
  });
  assert.equal(getCenterLineSegment(zeroLen), null);
});

test('segmentsCollinearTouching: 2組以上一致（重複）は安全側でnull', () => {
  const seg = { p1: { x: 0, y: 0 }, p2: { x: 0, y: 100 } };
  const same = { p1: { x: 0, y: 0 }, p2: { x: 0, y: 100 } };
  assert.equal(segmentsCollinearTouching(seg, same), null, '完全重複（2組一致）は不一致として扱う');
});
