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
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { roomBounds } from '../../finish/gridCells.js';
import { composeRoomFaces } from '../elevationFaceList.js';
import { makeProbeContext, probeColumn, collectCutBreaks } from './sectionProbe.js';
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
