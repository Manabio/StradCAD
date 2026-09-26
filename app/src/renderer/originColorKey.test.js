import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centerLineOriginColorKey } from './originColorKey.js';
import { originColor, ORIGIN_LIGHTNESS, ORIGIN_LIGHT_LIFT, ORIGIN_NONE_COLOR } from './canvasStyle.js';
import { CenterLine } from '../core/centerLine.js';
import { CenterLineType, Discipline } from '../core/constants.js';

// centerLineKind の4種別（app/src/core/centerLine.js centerLineKind）を実物のCenterLineで再現し、
// 由来キーへの写像を確認する（app/src/core/beamJoint.test.js の CenterLine 生成方法に合わせる）。
function makeCL(props) {
  return new CenterLine('cl-1', CenterLineType.HORIZONTAL, 0, props);
}

test('centerLineOriginColorKey: 通り芯(discipline:struct)は grid', () => {
  const cl = makeCL({ discipline: Discipline.STRUCT });
  assert.equal(centerLineOriginColorKey(cl), 'grid');
});

test('centerLineOriginColorKey: 中心線(既定discipline:arch, lineType:center)は center', () => {
  const cl = makeCL({});
  assert.equal(centerLineOriginColorKey(cl), 'center');
});

test('centerLineOriginColorKey: 補助線(lineType:dashed)は aux', () => {
  const cl = makeCL({ lineType: 'dashed' });
  assert.equal(centerLineOriginColorKey(cl), 'aux');
});

test('centerLineOriginColorKey: 梁芯(discipline:fuse)は generated', () => {
  const cl = makeCL({ discipline: Discipline.FUSE });
  assert.equal(centerLineOriginColorKey(cl), 'generated');
});

// 2026-09-26 裁定: 旧データ {labeled:false, discipline:STRUCT}（本来labeled:trueのはずの通り芯が
// labeled:falseのまま残る旧データ）も centerLineKind どおり 'struct'→'grid'（赤）とする——種別ベース
// 統一の既存方針（core/centerLineKindPolicy.js 冒頭コメント）に揃え、旧見た目のグレーには戻さない。
test('centerLineOriginColorKey: 旧データ{labeled:false, discipline:STRUCT}もcenterLineKindどおりgrid（2026-09-26裁定: 種別ベースに揃える）', () => {
  const cl = makeCL({ discipline: Discipline.STRUCT, labeled: false });
  assert.equal(centerLineOriginColorKey(cl), 'grid');
});

test('centerLineOriginColorKey: lineType:dashedはdiscipline（STRUCT/FUSE）より先に aux と判定される', () => {
  const structDashed = makeCL({ discipline: Discipline.STRUCT, lineType: 'dashed' });
  assert.equal(centerLineOriginColorKey(structDashed), 'aux');
  const fuseDashed = makeCL({ discipline: Discipline.FUSE, lineType: 'dashed' });
  assert.equal(centerLineOriginColorKey(fuseDashed), 'aux');
});

test('originColor: grid/center/aux/supportSpan/above は ORIGIN_LIGHTNESS の明度でhsl文字列を返す', () => {
  assert.equal(originColor('grid'), `hsl(0, 75%, ${ORIGIN_LIGHTNESS}%)`);
  assert.equal(originColor('center'), `hsl(190, 90%, ${ORIGIN_LIGHTNESS}%)`);
  assert.equal(originColor('aux'), `hsl(0, 0%, ${ORIGIN_LIGHTNESS}%)`);
  assert.equal(originColor('above'), `hsl(28, 95%, ${ORIGIN_LIGHTNESS}%)`);
  assert.equal(originColor('supportSpan'), `hsl(120, 70%, ${ORIGIN_LIGHTNESS}%)`);
});

test('originColor: generated は ORIGIN_LIGHTNESS + ORIGIN_LIGHT_LIFT の明度（やや明るい）', () => {
  assert.equal(originColor('generated'), `hsl(217, 91%, ${ORIGIN_LIGHTNESS + ORIGIN_LIGHT_LIFT}%)`);
});

test('originColor: lightness引数を明示すると既定のORIGIN_LIGHTNESSではなくその値を使う', () => {
  assert.equal(originColor('grid', 50), 'hsl(0, 75%, 50%)');
});

test('originColor: \'none\'・未知キー・null はいずれも黒(ORIGIN_NONE_COLOR)', () => {
  assert.equal(originColor('none'), ORIGIN_NONE_COLOR);
  assert.equal(originColor('unknown-key'), ORIGIN_NONE_COLOR);
  assert.equal(originColor(null), ORIGIN_NONE_COLOR);
});
