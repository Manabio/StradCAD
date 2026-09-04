// 実機2026-09「22」2階 A1×X2の回帰テスト（問題修正）。
// 「X2通りの壁エッジはCL右側が正解」「X2通り2FLから上に腰壁の残骸のようなものの描画は不要」。
//
// 実機の構成（世界座標）: 室22の北壁A1（y=-3500・X1..X2）は隅の取り合いでX2通りを57.5mm越えて
// 隣接壁の仕上げ面（-2942.5）まで出る。同じ通りのX2..X3区間には階段下り口まわりの腰壁800の指定が
// あり、X2..-1500は下り口（壁なし）、-1500..X3だけ腰壁が立つ。
// 旧実装は壁ごとのz範囲を「点クエリ」だけで引いていたため、A1の食い込み部57.5mm（-3000..-2942.5）
// の列がX2..X3区間の腰壁指定を拾って高さ800の帯になり、
//   (1) 全高の壁がCL(-3000)で終わったことになって見えがかりエッジがCL上に立ち（正解は壁端-2942.5）、
//   (2) その先57.5mmが腰壁の残骸（天端800＋端部の縦線）として描かれていた。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, edgeKey } from '@core';
import { makeProbeContext, probeColumn } from './sectionProbe.js';
import { buildCutContent } from './sectionContent.js';

const CH = 2400;
const KNEE = 800;
const ARCH = { labeled: false, discipline: Discipline.ARCH };

// mergedWall=true: A1壁がX1..X3の1本（mergeSegmentsで結合された壁）。X2..X3区間の構成壁でもあるため、
// 従来どおりX2から先は腰壁指定が効かなければならない（対照実験）。
function buildFixture({ mergedWall = false } = {}) {
  const graph = new PlanGraph(new Plane('p2', 3000, '2階', 2, 1));
  const V = v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  const H = v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const X1 = V(-8000), X2 = V(-3000), X3 = V(0);
  const Y2 = H(-7000), Ym = H(-3500), Y1 = H(-2000);
  const cell = (x0, y0, x1, y1) => `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room22 = graph.addRoom(new Set([cell(X1, Ym, X2, Y1), cell(X2, Ym, X3, Y1)]), '22');
  graph.addRoom(new Set([cell(X2, Y2, X3, Ym)]), '').setFeature(RoomFeature.STAIR_VOID);
  graph.addRoom(new Set([cell(X1, Y2, X2, Ym)]), '21');
  const opts = { isRoomWall: true, wallFinish: 12.5, backingDepth: 90 };
  // A1壁（室22側の面。実機 -7942.5..-2942.5 ＝ X2を57.5mm越える）
  const a1 = mergedWall
    ? graph.addWall(Ym, 57.5, false, X1, 57.5, X3, 57.5, opts)
    : graph.addWall(Ym, 57.5, false, X1, 57.5, X2, 57.5, opts);
  // X2..X3区間の腰壁（実機 -1500..57.5。X2..-1500は階段の下り口で壁なし）
  const knee = mergedWall ? null : graph.addWall(Ym, 57.5, false, X2, 1500, X3, 57.5, opts);
  // 階段吹抜け側のX2壁（東面。実機 -6942.5..-3442.5）
  graph.addWall(X2, 57.5, true, Y2, 57.5, Ym, 57.5, opts);
  graph.setKneeDropWall(edgeKey(Ym.id, X2.id, X3.id), { knee: { topHeight: KNEE }, drop: null });
  return { graph, room22, a1, knee };
}

// 室22の中（y=-3200）に置いた仮想断面線から北（viewSign=-1）のA1面を見る。
function a1Cut(graph) {
  return {
    seqNo: '0',
    line: { isVertical: false, axisValue: -3200, lo: -7942.5, hi: 57.5, faceAxisValue: -3500, buttToleranceMm: 0 },
    viewSign: -1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
    ceilProfile: [{ x0: 0, x1: 8000, ceilZ: CH }],
  };
}

const wallBandsOf = (bands, wall) => bands.filter(b => b.kind === 'wall' && b.wall === wall);

test('【実機「22」A1×X2】A1壁のX2への食い込み部(57.5mm)は隣区間の腰壁指定を拾わず、全高のまま', () => {
  const { graph, a1 } = buildFixture();
  const cut = a1Cut(graph);
  const bands = probeColumn(cut, -2971.25, makeProbeContext(cut.layers)); // -3000..-2942.5 の列
  const own = wallBandsOf(bands, a1);
  assert.equal(own.length, 1, `A1壁の帯が1本のはず（実際:${JSON.stringify(bands)}）`);
  assert.equal(own[0].z0, 0);
  assert.equal(own[0].z1, CH, '腰壁800ではなく天井までの全高のはず');
  assert.equal(own[0].isKneeDrop, false);
});

test('【失敗系】区間本来の腰壁（-1500..X3）は従来どおり高さ800の帯になる', () => {
  const { graph, knee } = buildFixture();
  const cut = a1Cut(graph);
  const bands = probeColumn(cut, -700, makeProbeContext(cut.layers));
  const own = wallBandsOf(bands, knee);
  assert.equal(own.length, 1);
  assert.equal(own[0].z1, KNEE);
  assert.equal(own[0].isKneeDrop, true);
});

test('【対照】X1..X3の1本に結合された壁はX2..X3区間の構成壁でもあるため、X2の先は腰壁指定が効く', () => {
  const { graph, a1 } = buildFixture({ mergedWall: true });
  const cut = a1Cut(graph);
  const ctx = makeProbeContext(cut.layers);
  assert.equal(wallBandsOf(probeColumn(cut, -2971.25, ctx), a1)[0].z1, KNEE, 'X2の先は腰壁');
  assert.equal(wallBandsOf(probeColumn(cut, -5000, ctx), a1)[0].z1, CH, 'X1..X2は全高のまま');
});

// 帯の出力で症状そのものを固定する: 天端(z=800)の線がX2の食い込み部に出ない／壁端の縦線が
// 壁端(-2942.5＝CL右側)に立ち、CL(-3000)には立たない。
test('【実機「22」A1×X2】断面content: X2の食い込み部に腰壁の天端は出ず、壁のエッジは壁端(CL右側)に立つ', () => {
  const { graph } = buildFixture();
  const cut = a1Cut(graph);
  const { content } = buildCutContent(cut, makeProbeContext(cut.layers), { endExtendMm: 0 });
  const toWorld = x => x + cut.line.lo; // ローカルx=0 ＝ line.lo（dirSign=+1）
  const lines = content.filter(p => p.type === 'line');
  const isV = p => Math.abs(p.x1 - p.x2) < 1e-6;
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const kneeTopsAtX2 = lines.filter(p => !isV(p) && near(p.y1, -KNEE) && near(p.y2, -KNEE)
    && toWorld(Math.max(p.x1, p.x2)) <= -2942.5 + 1e-6 && toWorld(Math.min(p.x1, p.x2)) >= -3000 - 1e-6);
  assert.deepEqual(kneeTopsAtX2, [], '食い込み部(-3000..-2942.5)に天端800の線が出てはいけない');
  const vAt = wx => lines.filter(p => isV(p) && near(toWorld(p.x1), wx));
  const spanOf = p => [Math.min(p.y1, p.y2), Math.max(p.y1, p.y2)];
  assert.ok(vAt(-2942.5).some(p => spanOf(p)[0] <= -CH + 1e-6 && spanOf(p)[1] >= -1e-6),
    `壁端(-2942.5)に床〜天井の縦線が立つはず（実際:${JSON.stringify(vAt(-2942.5).map(spanOf))}）`);
  assert.ok(!vAt(-3000).some(p => spanOf(p)[0] < -KNEE - 1e-6),
    `CL(-3000)には腰壁天端より上へ伸びる縦線が立ってはいけない（実際:${JSON.stringify(vAt(-3000).map(spanOf))}）`);
});
