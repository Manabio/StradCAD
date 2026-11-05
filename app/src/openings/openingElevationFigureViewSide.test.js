import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '../core.js';
import { OpeningMechanism } from './openingCatalog.js';
import { buildOpeningElevation } from './openingElevationFigure.js';

// 見る側（towardViewer）による開き線の線種の切替（ユーザー裁定 2026-11-05: 手前＝実線・向こう＝一点鎖線）。
// 姿図が読む最小限のプロパティだけを持つダックタイピングの代役。
function makeOpening(overrides = {}) {
  return {
    width: 1690, height: 1170, sillHeight: 800, category: OpeningCategory.WINDOW, subType: 'x',
    hingeSide: 1, swingSide: -1,
    ...overrides,
  };
}
const entryOf = (mechanism, extra = {}) => ({ mechanism, label: 'テスト', ...extra });
const figure = (mechanism, towardViewer, extra) =>
  buildOpeningElevation(makeOpening(), { entry: entryOf(mechanism, extra), includeDims: false, towardViewer });
// towardViewer を渡さない（既定）従来の出力
const baseline = (mechanism, extra) =>
  buildOpeningElevation(makeOpening(), { entry: entryOf(mechanism, extra), includeDims: false });
const stripDash = prims => prims.map(p => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'dash')));
const isVeeLine = p => p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2;

// 開き線（V 字）を持つ機構（openingElevationFigure.js の mechanismPrimitives で dashOf を通す機構の全て）。
const SWING_LINE_MECHANISMS = [
  OpeningMechanism.SWING, OpeningMechanism.SWING_DOUBLE, OpeningMechanism.SWING_CHILD, OpeningMechanism.FIRE_DOOR,
  OpeningMechanism.SWING_IN, OpeningMechanism.TILT, OpeningMechanism.DREH_KIPP,
  OpeningMechanism.PROJECT_V, OpeningMechanism.PROJECT_OUT, OpeningMechanism.TILT_OUT, OpeningMechanism.AWNING_MULTI,
  OpeningMechanism.FIRE_FOLD,
];
// 開き線（V 字）を持つが開く向きが一意でない（両方向・折れ・回転）ため判定が null＝見る側に依らず従来の線種のままの機構。
// 斜線 1 本の AWNING や線を持たない SLIDE_DOUBLE・FIXED・未知も含む。
const NO_SWING_LINE_MECHANISMS = [
  OpeningMechanism.FREE, OpeningMechanism.FREE_DOUBLE, OpeningMechanism.FOLD, OpeningMechanism.PIVOT,
  OpeningMechanism.SLIDE_DOUBLE, OpeningMechanism.FIXED, OpeningMechanism.AWNING, 'unknownMechanism',
];
const EXTRAS = { [OpeningMechanism.SWING_CHILD]: { childRatio: 0.3 }, [OpeningMechanism.FIRE_DOOR]: { fireLeaves: 2 } };

test('機構の一覧は OpeningMechanism の値（前提）', () => {
  const values = new Set(Object.values(OpeningMechanism));
  for (const m of SWING_LINE_MECHANISMS) assert.ok(values.has(m), `${m} は OpeningMechanism の値ではない`);
  assert.equal(new Set(SWING_LINE_MECHANISMS).size, 12);
});

// towardViewer 未指定（建具モードの姿図・建具表・カタログ）の開き線の線種＝従来の正準図（実出力から採った固定値）。
const CANONICAL_DASH = {
  [OpeningMechanism.SWING]: 'center', [OpeningMechanism.SWING_DOUBLE]: 'center',
  [OpeningMechanism.SWING_CHILD]: 'center', [OpeningMechanism.FIRE_DOOR]: 'center',
  [OpeningMechanism.SWING_IN]: 'dashed', [OpeningMechanism.TILT]: 'dashed', [OpeningMechanism.DREH_KIPP]: 'dashed',
  [OpeningMechanism.PROJECT_V]: undefined, [OpeningMechanism.PROJECT_OUT]: undefined,
  [OpeningMechanism.TILT_OUT]: undefined, [OpeningMechanism.AWNING_MULTI]: undefined,
  [OpeningMechanism.FIRE_FOLD]: 'dashed',
};

test('towardViewer 未指定・null の開き線の線種は従来の正準（機構ごとの固定値。見る側の規則に引きずられない）', () => {
  for (const m of SWING_LINE_MECHANISMS) {
    for (const f of [baseline(m, EXTRAS[m]), figure(m, null, EXTRAS[m]), figure(m, undefined, EXTRAS[m])]) {
      const vee = f.filter(isVeeLine);
      assert.ok(vee.length >= 2, m);
      assert.ok(vee.every(p => p.dash === CANONICAL_DASH[m]), `${m}: ${vee.map(p => p.dash)}`);
    }
  }
});

test('towardViewer を渡さない・null は従来の出力と完全に一致（開き線を持つ全機構）', () => {
  for (const m of SWING_LINE_MECHANISMS) {
    assert.deepEqual(figure(m, null, EXTRAS[m]), baseline(m, EXTRAS[m]), m);
    assert.deepEqual(figure(m, undefined, EXTRAS[m]), baseline(m, EXTRAS[m]), m);
  }
});

test('手前に開く（true）は開き線が全部実線・向こうへ開く（false）は全部一点鎖線（機構・扉／窓の区別なし）', () => {
  for (const m of SWING_LINE_MECHANISMS) {
    for (const category of [OpeningCategory.WINDOW, OpeningCategory.FITTING]) {
      const make = toward => buildOpeningElevation(makeOpening({ category }), {
        entry: entryOf(m, EXTRAS[m]), includeDims: false, towardViewer: toward,
      });
      const near = make(true).filter(isVeeLine);
      const far = make(false).filter(isVeeLine);
      assert.ok(near.length >= 2, `${m}/${category}: 開き線がある`);
      assert.equal(far.length, near.length, `${m}/${category}`);
      assert.ok(near.every(p => p.dash === undefined), `${m}/${category}: 手前＝実線 ${near.map(p => p.dash)}`);
      assert.ok(far.every(p => p.dash === 'center'), `${m}/${category}: 向こう＝一点鎖線 ${far.map(p => p.dash)}`);
    }
  }
});

test('true／false で変わるのは開き線の dash だけ（枠・ガラス・動作線等は不変）', () => {
  for (const m of SWING_LINE_MECHANISMS) {
    const near = figure(m, true, EXTRAS[m]);
    const far = figure(m, false, EXTRAS[m]);
    const base = baseline(m, EXTRAS[m]);
    assert.equal(near.length, base.length, m);
    assert.equal(far.length, base.length, m);
    assert.deepEqual(stripDash(near), stripDash(base), `${m}: 手前は dash 以外不変`);
    assert.deepEqual(stripDash(far), stripDash(base), `${m}: 向こうは dash 以外不変`);
    // dash が従来と違い得るのは開き線だけ
    for (let i = 0; i < base.length; i++) {
      if (!isVeeLine(base[i])) {
        assert.equal(near[i].dash, base[i].dash, `${m}[${i}] 手前`);
        assert.equal(far[i].dash, base[i].dash, `${m}[${i}] 向こう`);
      }
    }
  }
});

test('扉の両袖・単袖・DREH_KIPP の代表: 向こう＝一点鎖線のみ・手前＝開き線に dash なし', () => {
  for (const [m, extra] of [
    [OpeningMechanism.SWING_DOUBLE, {}], [OpeningMechanism.SWING_CHILD, { childRatio: 0.3 }],
    [OpeningMechanism.FIRE_DOOR, { fireLeaves: 2 }], [OpeningMechanism.FIRE_DOOR, { fireLeaves: 1 }],
  ]) {
    assert.ok(figure(m, true, extra).filter(isVeeLine).every(p => !('dash' in p) || p.dash === undefined), `${m} 手前`);
    const away = figure(m, false, extra).filter(isVeeLine).map(p => p.dash);
    assert.ok(away.length >= 2 && away.every(d => d === 'center'), `${m} 向こう: ${away}`);
  }
  // DREH_KIPP: 縦の V と上辺の V の 4 本が同じ向きで一緒に変わる
  const kip = OpeningMechanism.DREH_KIPP;
  assert.equal(figure(kip, true).filter(isVeeLine).length, 4);
  assert.deepEqual(figure(kip, false).filter(isVeeLine).map(p => p.dash), ['center', 'center', 'center', 'center']);
});

test('FIRE_FOLD（防火折戸 90／180 度。扉カテゴリ）: 手前＝V 8 本全部実線・向こう＝全部一点鎖線・null＝従来の破線', () => {
  for (const fireAngle of [90, 180]) {
    const make = toward => buildOpeningElevation(makeOpening({ category: OpeningCategory.FITTING }), {
      entry: entryOf(OpeningMechanism.FIRE_FOLD, { fireAngle }), includeDims: false, towardViewer: toward,
    });
    assert.deepEqual(make(true).filter(isVeeLine).map(p => p.dash), Array(8).fill(undefined), `${fireAngle} 手前`);
    assert.deepEqual(make(false).filter(isVeeLine).map(p => p.dash), Array(8).fill('center'), `${fireAngle} 向こう`);
    assert.deepEqual(make(null).filter(isVeeLine).map(p => p.dash), Array(8).fill('dashed'), `${fireAngle} null`);
  }
});

test('【失敗系】開き線を持つが向きが一意でない機構（自由扉・折れ戸・回転）や線の無い機構（引き戸・FIX・未知）は towardViewer の影響を受けない', () => {
  for (const m of NO_SWING_LINE_MECHANISMS) {
    assert.deepEqual(figure(m, true), baseline(m), `${m} toward`);
    assert.deepEqual(figure(m, false), baseline(m), `${m} away`);
  }
});

test('【失敗系】entry が無い（機構不明）でも towardViewer を渡して例外にならず従来と同じ', () => {
  const opening = makeOpening();
  assert.deepEqual(
    buildOpeningElevation(opening, { entry: null, includeDims: false, towardViewer: false }),
    buildOpeningElevation(opening, { entry: null, includeDims: false }),
  );
});
