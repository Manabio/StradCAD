// 仮想断面線の位置が抽出結果を決めることを、**同じ平面・同じ面で位置だけを変えて**直接示す。
//
// ユーザー指摘「「6」は正しく「5」は誤った出力」の根本原因の固定テスト。旧`elevationVoid.js`は
// 切断線を面自身の壁の中心線ちょうど（offset=0）に置いていた——切断面が壁の中を通るため
//   (a) 見えがかり候補が全て室外の壁になり`withinViewRoom`に落とされる
//   (b) 所有Roomの1点プローブが室の外へ落ちてroom=nullになり、床スラブ・天井懐の分類ごと消える
// 結果、面が丸ごと`open`（＝何も抽出されない）になっていた。階段帯（正しく出ている方）は切断線を
// レーン位置＝**室の中**に置いており、両者の違いはこの1点だけだった。
//
// offset=0 と offset=cutPlaneOffsetMm を並べて検証するので、**このテスト自身が旧実装の症状を
// 再現し続ける**（git履歴を辿らなくても、位置を戻せば壊れることが読んで分かる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { roomBounds } from '../../finish/gridCells.js';
import { composeRoomFaces } from '../elevationFaceList.js';
import { makeProbeContext, probeColumn, collectCutBreaks } from './sectionProbe.js';
import { buildColumns } from './sectionEngine.js';
import { cutPlaneOffsetMm, faceCutLine, faceViewSign } from './sectionCutPlane.js';

const CH = 2400;
const FLOOR_HEIGHT = 3000;
const TOP_Z = FLOOR_HEIGHT + CH; // 上階天井 = 5400

function makeGraph(name, level) {
  return new PlanGraph(new Plane(name, level, name, 1, 1));
}
function makeRectRoom(graph, x0v, y0v, x1v, y1v, name, feature = null) {
  const cl = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, x0v), x1 = cl(CenterLineType.VERTICAL, x1v);
  const y0 = cl(CenterLineType.HORIZONTAL, y0v), y1 = cl(CenterLineType.HORIZONTAL, y1v);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  if (feature) room.setFeature(feature);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

// 実機「5」相当の構成: 1階LDK(0..4000 × 0..6000)、その北半分の真上が2階の吹抜け、南半分の上は実部屋。
function fixture() {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph('2階', FLOOR_HEIGHT);
  makeRectRoom(g2, 0, 0, 4000, 3000, '吹抜け', RoomFeature.VOID);
  makeRectRoom(g2, 0, 3000, 4000, 6000, '洋室');
  const layers = [
    { graph: g1, floorZMm: 0, role: 'self' },
    { graph: g2, floorZMm: FLOOR_HEIGHT, role: 'above' },
  ];
  return { g1, g2, room, layers, bandRoomBounds: roomBounds(room.cells, g1) };
}

// 面 + 断面位置のオフセット → その面の中央付近の列のZBand列。
function bandsAt(face, fx, offsetMm) {
  const cut = {
    seqNo: face.label, dirSign: face.dirSign, face,
    viewSign: faceViewSign(face),
    line: faceCutLine(face, offsetMm),
    layers: fx.layers, zRange: { loZ: 0, hiZ: TOP_Z }, baseFloorZ: 0,
    bandRoomBounds: fx.bandRoomBounds,
  };
  const probeCtx = makeProbeContext(fx.layers);
  const breaks = collectCutBreaks(cut, probeCtx);
  const mid = (breaks[0] + breaks[breaks.length - 1]) / 2;
  return probeColumn(cut, mid, probeCtx);
}

function facesOf(fx) {
  return composeRoomFaces(fx.room, fx.g1).filter(f => f.kind !== 'step');
}

test('【根本原因の再現】切断線を面の壁芯ちょうど(offset=0)に置くと、面が丸ごとopen＝何も抽出されない', () => {
  const fx = fixture();
  const faceA = facesOf(fx).find(f => f.letter === 'A');
  const bands = bandsAt(faceA, fx, 0);
  assert.ok(bands.every(b => b.kind === 'open'),
    `壁芯上に置くと全てopenになる（旧実装の症状）。実際:${JSON.stringify(bands.map(b => b.kind))}`);
});

test('【修正】切断線を室内側へ下げると、A面（真上が吹抜け）の壁がFLから上階天井まで1本で抽出される', () => {
  const fx = fixture();
  const faceA = facesOf(fx).find(f => f.letter === 'A');
  const bands = bandsAt(faceA, fx, cutPlaneOffsetMm(faceA, fx.layers));
  assert.deepEqual(bands.map(b => [b.kind, b.z0, b.z1]), [['wall', 0, TOP_Z]],
    '上が吹抜けなので壁は1階天井でキャップされず上階天井まで続く（見えがかり1本）');
});

test('【修正・点4】上階に実床がある側の面では、壁が天井で切れず1FLから上階天井まで通しで抽出される', () => {
  const fx = fixture();
  // B/D面（東西の壁）は南北に走るので、北半分＝吹抜け・南半分＝実部屋の両方に跨る。
  const faceB = facesOf(fx).find(f => f.letter === 'B');
  const bands = bandsAt(faceB, fx, cutPlaneOffsetMm(faceB, fx.layers));
  const kinds = bands.map(b => b.kind);
  assert.ok(kinds.includes('wall'), `1階の壁が見えがかりとして出るはず（実際:${JSON.stringify(kinds)}）`);
  // 点4「天井から上階FLまでの間にある面も『壁』扱い」により、天井裏はslabではなく壁になり、
  // CH（1階天井=2400）で終わる帯が無い＝CHに見えがかり線が立たない（断面線のみ）。
  assert.ok(!bands.some(b => b.kind === 'slab' && Math.abs(b.z1 - FLOOR_HEIGHT) < 1e-6),
    '天井裏は床構造(slab)ではなく壁として扱われる');
  assert.ok(!bands.some(b => Math.abs(b.z1 - CH) < 1e-6),
    `CH(${CH})で終わる帯は無いはず（実際:${JSON.stringify(bands.map(b => [b.kind, b.z0, b.z1]))}）`);
  assert.ok(bands.some(b => b.z1 > FLOOR_HEIGHT), '上階ぶんの帯があるはず');
});

test('【回帰ガード】切断線を室内側へ下げても、面のローカルx（描画範囲）は動かない', () => {
  const fx = fixture();
  for (const face of facesOf(fx)) {
    const line = faceCutLine(face, cutPlaneOffsetMm(face, fx.layers));
    assert.equal(line.lo, face.lo, `${face.label}: 走り方向の下限は動かない`);
    assert.equal(line.hi, face.hi, `${face.label}: 走り方向の上限は動かない`);
  }
});

// ---- ユーザー明示指示2026-08「展開図では、断面の中は描画しない」（実機「5」A面の左3200エリア）----
// 天井断面線の向こう（天井裏・上階の躯体）には何も描かない。天井断面の高さは区間ごとに違うので、
// 天井断面線を実際に引いている値（cut.ceilProfile）で列を打ち切る。
test('【明示指示2026-08】buildColumns: 天井の低い区間では、その天井より上の帯を持たない', () => {
  const fx = fixture();
  const faceA = facesOf(fx).find(f => f.letter === 'A');
  const base = {
    seqNo: 'A', dirSign: faceA.dirSign, face: faceA, viewSign: faceViewSign(faceA),
    line: faceCutLine(faceA, cutPlaneOffsetMm(faceA, fx.layers)),
    layers: fx.layers, zRange: { loZ: 0, hiZ: TOP_Z }, baseFloorZ: 0,
    bandRoomBounds: fx.bandRoomBounds,
  };
  const probeCtx = makeProbeContext(fx.layers);
  // 面の左半分は天井2400・右半分は吹抜けで上階天井5400、という区間構成。
  const half = faceA.run / 2;
  const withProfile = buildColumns({ ...base, ceilProfile: [
    { loX: 0, hiX: half, ceilZ: CH }, { loX: half, hiX: faceA.run, ceilZ: TOP_Z },
  ] }, probeCtx);

  const left = withProfile.filter(c => (c.x0 + c.x1) / 2 < half);
  assert.ok(left.length > 0, `左半分に列があるはず（実際の列:${JSON.stringify(withProfile.map(c => [c.x0, c.x1]))}）`);
  assert.ok(left.every(c => c.bands.every(b => b.z1 <= CH + 1e-6)),
    `天井2400の区間に、天井より上の帯が残っている（実際:${JSON.stringify(left.flatMap(c => c.bands.map(b => [b.kind, b.z0, b.z1])))}）`);
  const right = withProfile.filter(c => (c.x0 + c.x1) / 2 > half);
  assert.ok(right.some(c => c.bands.some(b => b.z1 > CH + 1e-6)),
    '吹抜けの区間は上階天井まで残る');
});

test('【失敗系】buildColumns: ceilProfile未指定（階段帯など）は従来どおり打ち切らない', () => {
  const fx = fixture();
  const faceA = facesOf(fx).find(f => f.letter === 'A');
  const cut = {
    seqNo: 'A', dirSign: faceA.dirSign, face: faceA, viewSign: faceViewSign(faceA),
    line: faceCutLine(faceA, cutPlaneOffsetMm(faceA, fx.layers)),
    layers: fx.layers, zRange: { loZ: 0, hiZ: TOP_Z }, baseFloorZ: 0,
    bandRoomBounds: fx.bandRoomBounds,
  };
  const cols = buildColumns(cut, makeProbeContext(fx.layers));
  assert.ok(cols.some(c => c.bands.some(b => b.z1 > CH + 1e-6)),
    'ceilProfileが無ければzRange全域のまま（既存の呼び出し側の挙動を変えない）');
});

// ---- 案A（ユーザー承認2026-08）: 天端・下端が露出した切断壁は天井の打ち切りの例外 ----
// 「断面の中は描画しない」の唯一の例外。腰壁の天端・垂れ壁の下端は吹抜け側の空間に面していて
// 実際に見えるため、天井の向こうにあっても断面を描く。上下いっぱいに立つ切断壁は隣室との
// 仕切りで天井に隠れるので従来どおり落とす（実機「5」A面左3200・C1面右400）。
// 実機「5」D1の「2階Y1から2000＝2FL+800の腰壁断面」が消えていた不具合の修正。

// 2階の y=3000 の壁に腰壁/垂れ壁を指定した構成で、B面（東の壁を見る面）の列を作る。
function kneeFixture(spec) {
  const fx = fixture();
  const wall = fx.g2.walls.find(w => !w.isVertical && Math.abs(w.axisCL.effectiveValue - 3000) < 1e-6);
  assert.ok(wall, '2階のy=3000の壁があること（フィクスチャの前提）');
  fx.g2.setKneeDropWall(edgeKey(wall.axisCL.id, wall.clStart.id, wall.clEnd.id), spec);
  return fx;
}

// 面Bの切断を、y=3000（腰壁の位置）が「天井2400の区間」に入るceilProfileで作る。
function bColumnsWithLowCeilAtWall(fx) {
  const faceB = facesOf(fx).find(f => f.letter === 'B');
  const wallLocalX = Math.abs(3000 - Math.abs(faceB.originWorld)); // 面ローカルでの壁位置の目安
  const cut = {
    seqNo: 'B', dirSign: faceB.dirSign, face: faceB, viewSign: faceViewSign(faceB),
    line: faceCutLine(faceB, cutPlaneOffsetMm(faceB, fx.layers)),
    layers: fx.layers, zRange: { loZ: 0, hiZ: TOP_Z }, baseFloorZ: 0,
    bandRoomBounds: fx.bandRoomBounds,
    // 壁より手前（吹抜け側）だけ天井5400・以降は2400。壁は天井2400の側に入る。
    ceilProfile: [
      { loX: 0, hiX: wallLocalX - 200, ceilZ: TOP_Z },
      { loX: wallLocalX - 200, hiX: faceB.run, ceilZ: CH },
    ],
  };
  return buildColumns(cut, makeProbeContext(fx.layers));
}

test('【承認2026-08・案A】buildColumns: 腰壁（天端が露出）の切断壁は天井の打ち切りから除外される', () => {
  const cols = bColumnsWithLowCeilAtWall(kneeFixture({ knee: { topHeight: 800 }, drop: null }));
  const kneeCuts = cols.flatMap(c => c.bands.filter(b => b.kind === 'cut' && b.isKneeDrop));
  assert.ok(kneeCuts.length > 0, '腰壁の断面が残るはず（天井2400の区間にあっても）');
  assert.ok(kneeCuts.every(b => Math.abs(b.z1 - (FLOOR_HEIGHT + 800)) < 1e-6),
    `天端は2FL+800のはず（実際:${JSON.stringify(kneeCuts.map(b => [b.z0, b.z1]))}）`);
});

test('【承認2026-08・案A】buildColumns: 垂れ壁（下端が露出）の切断壁も打ち切られない', () => {
  const cols = bColumnsWithLowCeilAtWall(kneeFixture({ knee: null, drop: { bottomHeight: 700 } }));
  const dropCuts = cols.flatMap(c => c.bands.filter(b => b.kind === 'cut' && b.isKneeDrop));
  assert.ok(dropCuts.length > 0, '垂れ壁の断面が残るはず');
  assert.ok(dropCuts.every(b => b.z0 > FLOOR_HEIGHT + 1e-6),
    `下端は2FLより上（宙に浮く）はず（実際:${JSON.stringify(dropCuts.map(b => [b.z0, b.z1]))}）`);
});

test('【失敗系・承認2026-08・案A】buildColumns: 上下いっぱいに立つ切断壁は従来どおり打ち切られる', () => {
  const cols = bColumnsWithLowCeilAtWall(fixture()); // 腰壁・垂れ壁の指定なし
  const above = cols.flatMap(c => (c.ceilZ === CH ? c.bands : []))
    .filter(b => b.z1 > CH + 1e-6);
  assert.equal(above.length, 0,
    `天井2400の区間に、天井より上の帯が残っている（実際:${JSON.stringify(above.map(b => [b.kind, b.z0, b.z1]))}）`);
});
