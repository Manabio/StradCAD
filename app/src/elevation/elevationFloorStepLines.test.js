// 段差見付け面（kind 'step'）に引く床の段差の部位図（floorStep）の派生線の仕様（elevation/elevationJunction.js floorStepLineSpecs。部分詳細図 S8b-3）。
// 合成 fixture（面のスタブ）で固定する。描画への配線は modes/ElevationModeState.floorStep.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DetailEdgeMark, PenDir } from '../core/constants.js';
import { floorStepLineSpecs } from './elevationJunction.js';
import { floorStepEnvelope } from '../finish/partDetail.js';
import { ElevationLineRole } from './elevationStyle.js';
import { stepNoseFigure, floorStepFigure, move, fixedLen, stretchLen } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { FLOOR_STEP } = DetailSlot;

test.afterEach(() => clearOverlays());

const stepFace = (over = {}) => ({ kind: 'step', stepHeightMm: 300, highOwnerRoom: { id: 'r', detailRefs: { [FLOOR_STEP]: 'k' } }, ...over });
const install = (...figs) => setOverlay(DF, { user: figs });

test('段差 t（40・70）が高い側の床から下向きの細線（DETAIL）になる。縮尺 1/60 は実寸のまま・1/100 は最小描画幅 50 へ調整（40→50）', () => {
  install(stepNoseFigure('k'));
  assert.deepEqual(floorStepLineSpecs(stepFace(), { scaleDenom: 60 }), [
    { t: 40, role: ElevationLineRole.DETAIL }, { t: 70, role: ElevationLineRole.DETAIL },
  ]);
  assert.deepEqual(floorStepLineSpecs(stepFace(), {}).map(s => s.t), [50, 70], '分母未指定＝100＝最小描画幅 50');
});

test('空気との境目の印（air）の辺の端点は中線（SILHOUETTE）。同じ t の auto は air に置き換わる', () => {
  const moves = [
    move(PenDir.RIGHT, fixedLen(120)), { ...move(PenDir.DOWN, fixedLen(40)), edge: DetailEdgeMark.AIR }, move(PenDir.LEFT, fixedLen(90)),
    move(PenDir.DOWN, fixedLen(30)), move(PenDir.LEFT, fixedLen(30)), move(PenDir.DOWN, stretchLen(100)),
  ];
  install(floorStepFigure('k', moves));
  assert.deepEqual(floorStepLineSpecs(stepFace(), { scaleDenom: 60 }), [
    { t: 40, role: ElevationLineRole.SILHOUETTE }, { t: 70, role: ElevationLineRole.DETAIL },
  ]);
});

test('高い側の床（t≈0）と低い側の床（t≈段差高）に一致する t は引かない。最小描画幅への調整後に段差高以上になる t も引かない', () => {
  // 下端（t=段差高）に出のある図: 包絡線は t=段差高で外側へ戻る段差を持つが、低い側の床の線は引かない
  install(floorStepFigure('k', [move(PenDir.RIGHT, fixedLen(100)), move(PenDir.DOWN, stretchLen(100)), move(PenDir.LEFT, fixedLen(100))], { closed: false, endVertex: 2 }));
  const env = floorStepEnvelope({ room: stepFace().highOwnerRoom, stepHeightMm: 300 });
  assert.deepEqual(env.steps.map(s => s.t), [300], '前提: 包絡線は t=段差高に段差を持つ');
  assert.deepEqual(floorStepLineSpecs(stepFace(), { scaleDenom: 60 }), []);
  install(stepNoseFigure('k'));
  assert.deepEqual(floorStepLineSpecs(stepFace(), { scaleDenom: 800 }), [], '最小描画幅 400 ≥ 段差高 300 は床の線に重なるので引かない');
  assert.deepEqual(floorStepLineSpecs(stepFace({ stepHeightMm: 500 }), { scaleDenom: 800 }).map(s => s.t), [400], '調整後に同じ t へ畳まれて 1 本');
});

test('【失敗系】段差見付け面でない・高い側の部屋が無い・割当て無し・参照切れ・段差高に合わない図は空（従来の描き方）。例外にしない', () => {
  install(stepNoseFigure('k'));
  assert.deepEqual(floorStepLineSpecs(stepFace({ kind: undefined })), []);
  assert.deepEqual(floorStepLineSpecs(stepFace({ highOwnerRoom: undefined })), []);
  assert.deepEqual(floorStepLineSpecs(stepFace({ highOwnerRoom: { detailRefs: null } })), []);
  assert.deepEqual(floorStepLineSpecs(stepFace({ highOwnerRoom: { detailRefs: { [FLOOR_STEP]: 'df-gone' } } })), [], '参照切れ');
  assert.deepEqual(floorStepLineSpecs(stepFace({ stepHeightMm: 60 }), { scaleDenom: 60 }), [], '固定寸法の和（70）以下の段差高');
  assert.deepEqual(floorStepLineSpecs(null), []);
  assert.deepEqual(floorStepLineSpecs(stepFace({ highOwnerRoom: { detailRefs: { floorWall: 'k' } } })), [], 'floorWall の割当ては使わない');
});
