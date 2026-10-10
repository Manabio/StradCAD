// ceilingShapeFields.js（形状・寸法の入力欄の表と検証）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CeilingShape, CEILING_SHAPE_DIM_COUNT, SLOPE_DIRS_DEG, ARC_AXES_DEG } from '../core.js';
import {
  CEILING_SHAPE_OPTIONS, CEILING_BASE_LABEL, CEILING_DIM_FIELDS, UP_DIRECTION_TO_DEG, parseCeilingZoneDraft,
} from './ceilingShapeFields.js';

test('表の網羅: 全形状に ラベル・基準高ラベル・寸法欄があり、寸法欄の個数は CEILING_SHAPE_DIM_COUNT と一致する', () => {
  for (const shape of Object.values(CeilingShape)) {
    assert.ok(CEILING_SHAPE_OPTIONS.some(o => o.value === shape), `選択肢: ${shape}`);
    assert.ok(typeof CEILING_BASE_LABEL[shape] === 'string' && CEILING_BASE_LABEL[shape] !== '', `基準高ラベル: ${shape}`);
    assert.equal(CEILING_DIM_FIELDS[shape].length, CEILING_SHAPE_DIM_COUNT[shape], `寸法欄の個数: ${shape}`);
    for (const f of CEILING_DIM_FIELDS[shape]) {
      assert.ok(f.label && (f.input === 'number' || f.input === 'select'), `${shape}/${f.label}`);
      if (f.input === 'select') assert.ok(f.options.length > 0);
    }
  }
  assert.equal(CEILING_SHAPE_OPTIONS.length, Object.values(CeilingShape).length);
});

test('S6a: 平面・傾斜は選べて、円弧・ドームは disabled（S6b で解禁）', () => {
  const dis = Object.fromEntries(CEILING_SHAPE_OPTIONS.map(o => [o.value, !!o.disabled]));
  assert.deepEqual(dis, { flat: false, slope: false, arc: true, dome: true });
});

test('選択欄の選択肢は core の列挙（向き・軸）と一致する', () => {
  assert.deepEqual(CEILING_DIM_FIELDS.slope[1].options.map(o => o.value), [...SLOPE_DIRS_DEG]);
  assert.deepEqual(CEILING_DIM_FIELDS.arc[1].options.map(o => o.value), [...ARC_AXES_DEG]);
  assert.deepEqual(CEILING_DIM_FIELDS.slope[1].options.map(o => o.label), ['→ 右', '↓ 下', '← 左', '↑ 上']);
});

test('UP_DIRECTION_TO_DEG: 階段の upDirection 4方向が度に対応する（y 下向き座標で 右0・下90・左180・上270）', () => {
  assert.deepEqual({ ...UP_DIRECTION_TO_DEG }, { right: 0, down: 90, left: 180, up: 270 });
  for (const deg of Object.values(UP_DIRECTION_TO_DEG)) assert.ok(SLOPE_DIRS_DEG.includes(deg));
});

test('parseCeilingZoneDraft 成功: 平面（空の基準高→null＝部屋の CH）／傾斜／ドーム／円弧', () => {
  assert.deepEqual(parseCeilingZoneDraft({ shape: 'flat', height: '', dims: [] }),
    { ok: true, value: { heightMm: null, shape: 'flat', dims: [] } });
  assert.deepEqual(parseCeilingZoneDraft({ shape: 'flat', height: ' 2400 ', dims: [] }),
    { ok: true, value: { heightMm: 2400, shape: 'flat', dims: [] } });
  assert.deepEqual(parseCeilingZoneDraft({ shape: 'slope', height: '2300', dims: ['1200', '270'] }),
    { ok: true, value: { heightMm: 2300, shape: 'slope', dims: [1200, 270] } });
  assert.deepEqual(parseCeilingZoneDraft({ shape: 'slope', height: '', dims: [800, 0] }),
    { ok: true, value: { heightMm: null, shape: 'slope', dims: [800, 0] } });
  assert.deepEqual(parseCeilingZoneDraft({ shape: 'dome', height: '2400', dims: ['500'] }),
    { ok: true, value: { heightMm: 2400, shape: 'dome', dims: [500] } });
  assert.deepEqual(parseCeilingZoneDraft({ shape: 'arc', height: '2400', dims: ['500', '90'] }, { spanMm: 4000 }),
    { ok: true, value: { heightMm: 2400, shape: 'arc', dims: [500, 90] } });
  // 平面で余分な寸法の下書きが残っていても無視する
  assert.equal(parseCeilingZoneDraft({ shape: 'flat', height: '2400', dims: ['', '0'] }).ok, true);
  // 天端が切断高・階高を超えても弾かない
  assert.equal(parseCeilingZoneDraft({ shape: 'slope', height: '2800', dims: ['5000', '0'] }).ok, true);
});

test('【失敗系】parseCeilingZoneDraft: ライズ 0・負・非数・空は error。例外は投げない', () => {
  for (const rise of ['0', '-100', 'abc', '', 'NaN', 'Infinity']) {
    const r = parseCeilingZoneDraft({ shape: 'slope', height: '2300', dims: [rise, '0'] });
    assert.equal(r.ok, false, `slope ライズ ${rise}`);
    assert.match(r.error, /ライズ/);
  }
  assert.equal(parseCeilingZoneDraft({ shape: 'dome', height: '2300', dims: ['0'] }).ok, false);
});

test('【失敗系】parseCeilingZoneDraft: 向き 45・空・軸 180 は error', () => {
  for (const dir of ['45', '', 'x', '360']) {
    const r = parseCeilingZoneDraft({ shape: 'slope', height: '2300', dims: ['1200', dir] });
    assert.equal(r.ok, false, `向き ${dir}`);
  }
  const axis = parseCeilingZoneDraft({ shape: 'arc', height: '2300', dims: ['300', '180'] });
  assert.equal(axis.ok, false);
  assert.match(axis.error, /軸/);
});

test('【失敗系】parseCeilingZoneDraft: 基準高が負・0・非数は error（空欄だけが部屋の CH）。形状が未知なら error', () => {
  for (const h of ['-1', '0', 'abc', 'Infinity']) {
    const r = parseCeilingZoneDraft({ shape: 'flat', height: h, dims: [] });
    assert.equal(r.ok, false, `基準高 ${h}`);
    assert.match(r.error, /天井高/);
  }
  assert.match(parseCeilingZoneDraft({ shape: 'slope', height: '-1', dims: ['100', '0'] }).error, /低い側/);
  assert.equal(parseCeilingZoneDraft({ shape: 'pyramid', height: '', dims: [] }).ok, false);
  assert.equal(parseCeilingZoneDraft(null).ok, false);
});

test('【失敗系】parseCeilingZoneDraft: 円弧のライズが幅/2 を超えると error。幅は軸に直交する側（軸0=x 平行→y 幅）。幅が無ければ検査しない', () => {
  const draft = axis => ({ shape: 'arc', height: '2400', dims: ['1500', String(axis)] });
  const span = { xMm: 6000, yMm: 2000 };
  assert.equal(parseCeilingZoneDraft(draft(0), { spanMm: span }).ok, false, '軸0: 幅=y=2000 → 上限1000');
  assert.equal(parseCeilingZoneDraft(draft(90), { spanMm: span }).ok, true, '軸90: 幅=x=6000 → 上限3000');
  assert.equal(parseCeilingZoneDraft({ shape: 'arc', height: '', dims: ['1000', '0'] }, { spanMm: span }).ok, true, 'ちょうど幅/2 は可');
  assert.equal(parseCeilingZoneDraft(draft(0), { spanMm: 2000 }).ok, false, '数値の幅はそのまま');
  assert.equal(parseCeilingZoneDraft(draft(0)).ok, true, '幅が無ければ検査しない');
  assert.match(parseCeilingZoneDraft(draft(0), { spanMm: span }).error, /幅/);
});
