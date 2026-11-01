// 建具の姿図（正面図）の部分詳細図による差し替え（S6b）のテスト。
// buildOpeningElevation の内部で図を解決・fit・写像する（引数は増えない）。期待値は fixture（openingDetailTestFixtures.js
// elevationFigure）の寸法から手で書いた定数。座標は FL を y=0・上方は負。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '@core';
import { clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DetailDatumRole, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { findCatalogEntry, detailFitKey, fitDetailLocalMemo, subTypeDetailFigureRefsFor } from './openingCatalog.js';
import { buildOpeningElevation } from './openingElevationFigure.js';
import { resolveDetailFigure, resolveDetailElevation } from './openingDetailFit.js';
import { detailElevationTargets } from './openingDetailFrame.js';
import { collectDetailFigureFailures, collectDetailFitFailures } from './openingDetailFitCheck.js';
import { elevationFigure, subTypeEntry, installElevationFigures } from './openingDetailTestFixtures.js';

test.afterEach(() => clearOverlays());

const FIGURE = DetailSlot.FIGURE;
const pts = list => list.map(p => p.map(v => v + 0)); // -0 を +0 へ（deepStrictEqual は両者を区別する）

function door(over = {}) {
  return {
    category: OpeningCategory.FITTING, subType: 'singleSwing', width: 800, height: 2000, hingeSide: -1, swingSide: 1,
    ...over,
  };
}
function windowOpening(over = {}) {
  return {
    category: OpeningCategory.WINDOW, subType: 'doubleSliding', width: 800, height: 1200, sillHeight: 900, hingeSide: -1, swingSide: 1,
    ...over,
  };
}
const entryOf = o => findCatalogEntry(o.category, o.subType);
const detailPrims = prims => prims.filter(p => p.source === DETAIL_PRIM_SOURCE);
const withRef = (o, key) => ({ ...o, detailRefs: { [FIGURE]: key } });

// 期待する図形（幅 W・高さ H・窓台 S）。lt/br は実線の折れ線（weight=medium）、dash は破線の線分 2 本（weight=thin）。
function expected(W, H, S = 0, dashX = 100) {
  const base = 0 - S; // S=0 でも +0（-S だと -0 になり deepStrictEqual が区別する）
  const src = { source: 'detail' };
  return [
    { type: 'polyline', points: [[0, base], [0, base - H], [W, base - H]], weight: 'medium', ...src },
    { type: 'polyline', points: [[0, base], [W, base], [W, base - H]], weight: 'medium', ...src },
    { type: 'line', x1: 0, y1: base, x2: dashX, y2: base, weight: 'thin', dash: 'dashed', ...src },
    { type: 'line', x1: dashX, y1: base, x2: dashX, y2: base - H, weight: 'thin', dash: 'dashed', ...src },
  ];
}
const normPrim = p => (p.type === 'polyline' ? { ...p, points: pts(p.points) } : { ...p, x1: p.x1 + 0, y1: p.y1 + 0, x2: p.x2 + 0, y2: p.y2 + 0 });

// ---- 置換 ----

test('置換: 姿図の詳細図があれば枠(rect)・機構(吊元V・FIX文字)・ハンドルを置き換え、source:detail の polyline／破線の line だけが図になる。dim・FL線・tag は残る', () => {
  installElevationFigures([elevationFigure('df-a')]);
  const o = withRef(door(), 'df-a');
  const prims = buildOpeningElevation(o, { tag: 'D-1', entry: entryOf(o) });
  assert.deepEqual(detailPrims(prims).map(normPrim), expected(800, 2000));
  assert.equal(prims.filter(p => p.type === 'rect').length, 0, '枠・ハンドルの rect は無い');
  assert.equal(prims.filter(p => p.dash === 'center').length, 0, '吊元の一点鎖線 V は無い');
  assert.deepEqual(prims.filter(p => p.type === 'dim').map(p => p.target).sort(), ['handleHeight', 'height', 'width'], '寸法は従来どおり（ハンドル高さの寸法も残る）');
  assert.ok(prims.some(p => p.type === 'levelLine'), 'FL 線は残る');
  assert.ok(prims.some(p => p.type === 'text' && p.text === 'D-1'), 'tag は残る');
  // 対照: 割当てなしは従来の姿図（rect・V・ハンドル）で source:detail は無い
  const base = buildOpeningElevation(door(), { tag: 'D-1', entry: entryOf(door()) });
  assert.equal(detailPrims(base).length, 0);
  assert.ok(base.some(p => p.type === 'rect') && base.some(p => p.dash === 'center'));
});

test('置換: 三方枠（threeSidedFrame）でも外周・内法の line 6 本は出ず、source:detail だけが図になる。割当てなしは従来の 6 本', () => {
  installElevationFigures([elevationFigure('df-a')]);
  const frame = over => ({ category: OpeningCategory.FITTING, subType: 'threeSidedFrame', fixtureType: 'WF', width: 800, height: 2000, ...over });
  const solidFrameLines = prims => prims.filter(p => p.type === 'line' && p.source !== 'detail' && (p.weight === 'thin' || p.weight === 'medium'));
  const o = frame({ detailRefs: { [FIGURE]: 'df-a' } });
  const prims = buildOpeningElevation(o, { tag: null, entry: entryOf(o), includeDims: false, includeLevelLine: false });
  assert.equal(solidFrameLines(prims).length, 0, '従来の外周（細線 3）・内法（中線 3）は出ない');
  assert.deepEqual(prims.map(normPrim), expected(800, 2000));
  const base = buildOpeningElevation(frame(), { tag: null, entry: entryOf(frame()), includeDims: false, includeLevelLine: false });
  assert.equal(solidFrameLines(base).length, 6, '対照: 割当てなしは従来の三方の線 6 本');
});

test('置換: 抑制フラグ（寸法・動作線・FL線なし）は従来どおり効き、図は残る', () => {
  installElevationFigures([elevationFigure('df-a')]);
  const o = withRef(door(), 'df-a');
  const prims = buildOpeningElevation(o, {
    tag: null, entry: entryOf(o), includeDims: false, includeMotionArrows: false, includeLevelLine: false,
  });
  assert.equal(prims.filter(p => ['dim', 'arrow', 'levelLine'].includes(p.type)).length, 0);
  assert.deepEqual(prims.map(normPrim), expected(800, 2000));
});

test('置換: 窓（引違い）は機構の FIX 文字・矢印も置き換わる', () => {
  installElevationFigures([elevationFigure('df-a')]);
  const o = withRef(windowOpening(), 'df-a');
  const prims = buildOpeningElevation(o, { tag: null, entry: entryOf(o), includeDims: false, includeLevelLine: false });
  assert.deepEqual(prims.map(normPrim), expected(800, 1200, 900));
  const base = buildOpeningElevation(windowOpening(), { tag: null, entry: entryOf(windowOpening()), includeDims: false, includeLevelLine: false });
  assert.ok(base.some(p => p.type === 'arrow' || p.type === 'text'), '対照: 従来は機構の矢印か文字がある');
});

// ---- 寸法への追従（targets） ----

test('targets: 幅 800→1000 で s の伸縮だけ・高さ 2000→2100 で t の伸縮だけが伸び、固定寸法（破線の 100）は動かない', () => {
  installElevationFigures([elevationFigure('df-a')]);
  const o = withRef(door({ width: 1000, height: 2100 }), 'df-a');
  const prims = detailPrims(buildOpeningElevation(o, { tag: null, entry: entryOf(o), includeDims: false, includeLevelLine: false }));
  assert.deepEqual(prims.map(normPrim), expected(1000, 2100));
});

test('targets: SILL を原点にした図と FL を原点にした図は、窓台 900 の窓で FL の図が窓台ぶん下（−900）まで伸びる。建具（窓台なし）では同じ', () => {
  // 同内容の図は重複禁止なので、df-fl は破線の位置（固定 150）だけ変える
  installElevationFigures([elevationFigure('df-sill'), elevationFigure('df-fl', { originRole: DetailDatumRole.FL, dashX: 150 })]);
  const win = key => windowOpening({ detailRefs: { [FIGURE]: key } });
  const ofSill = detailPrims(buildOpeningElevation(win('df-sill'), { tag: null, entry: entryOf(win('df-sill')) }));
  const ofFl = detailPrims(buildOpeningElevation(win('df-fl'), { tag: null, entry: entryOf(win('df-fl')) }));
  // SILL: 窓台上端（−900）から上端（−2100）まで
  assert.deepEqual(pts(ofSill[0].points), [[0, -900], [0, -2100], [800, -2100]]);
  // FL: FL（0）から上端（−2100）まで。高さ方向の伸縮が窓台ぶん（900）大きい
  assert.deepEqual(pts(ofFl[0].points), [[0, 0], [0, -2100], [800, -2100]]);
  const d = door();
  const doorSill = detailPrims(buildOpeningElevation(withRef(d, 'df-sill'), { tag: null, entry: entryOf(d) }));
  const doorFl = detailPrims(buildOpeningElevation(withRef(d, 'df-fl'), { tag: null, entry: entryOf(d) }));
  const polylines = list => list.filter(p => p.type === 'polyline').map(normPrim);
  assert.deepEqual(polylines(doorSill), polylines(doorFl), '建具は窓台 0 なので SILL と FL は同じ');
  assert.equal(polylines(doorFl).length, 2);
});

test('detailElevationTargets: 基準の値（s: 0／幅・t: SILL 0／FL 窓台高さ／HEAD −高さ）を図の Datum.id で返す。未対応の role は UNSUPPORTED_DATUM', () => {
  const fig = elevationFigure('x', { originRole: DetailDatumRole.FL });
  const r = detailElevationTargets(fig, { width: 800, height: 1200, sill: 900 });
  assert.deepEqual(r.targets.datums, { so: 0, se: 800, to: 900, te: -1200 });
  assert.deepEqual(r.targets.params, {});
  const bad = detailElevationTargets({ datums: [{ id: 'w', role: DetailDatumRole.WALL_FINISH_FACE, axis: 't', kind: 'origin' }] }, { width: 1, height: 1, sill: 0 });
  assert.equal(bad.error.code, 'unsupportedDatum');
  assert.match(bad.error.message, /建具の姿図では使えません/);
  // 組が違う（HEAD を origin・OPENING_OUTER を t 軸）も未対応
  const badKind = detailElevationTargets({ datums: [{ id: 'h', role: DetailDatumRole.HEAD, axis: 't', kind: 'origin' }] }, { width: 1, height: 1, sill: 0 });
  assert.equal(badKind.error.code, 'unsupportedDatum');
});

// ---- 解決順 ----

test('解決順: opening.detailRefs.figure ＞ 建具種別の detailFigures.figure ＞ 既定の姿図。明示 null は「なし」（建具種別へ進まない）', () => {
  installElevationFigures(
    [elevationFigure('df-op'), elevationFigure('df-st', { dashX: 300 })],
    [subTypeEntry('user1', 'df-st')],
  );
  const base = { category: OpeningCategory.FITTING, subType: 'user1', width: 800, height: 2000, hingeSide: -1 };
  const dashEnd = o => detailPrims(buildOpeningElevation(o, { tag: null, entry: entryOf(o), includeDims: false, includeLevelLine: false }))
    .filter(p => p.type === 'line')[0].x2;
  assert.equal(entryOf(base).detailFigures.figure, 'df-st', '前提: 建具種別エントリの detailFigures がカタログ合成を通って読める');
  assert.equal(dashEnd(base), 300, '建具種別の図');
  assert.equal(dashEnd({ ...base, detailRefs: { [FIGURE]: 'df-op' } }), 100, '建具個別の上書きが勝つ');
  const none = buildOpeningElevation({ ...base, detailRefs: { [FIGURE]: null } }, { tag: null, entry: entryOf(base) });
  assert.equal(detailPrims(none).length, 0, '明示 null は建具種別の図も使わず既定の姿図');
  assert.ok(none.some(p => p.type === 'rect'));
  // 参照なしの建具種別
  const plain = door();
  assert.equal(detailPrims(buildOpeningElevation(plain, { tag: null, entry: entryOf(plain) })).length, 0);
});

test('resolveDetailFigure（姿図）: 上書きの図が実在しなければ建具種別の図を流用し、intended は上書きのまま（通知の主語）', () => {
  installElevationFigures([elevationFigure('df-st')]);
  const r = resolveDetailFigure({ detailRefs: { [FIGURE]: 'df-gone' }, slot: FIGURE, subTypeRefs: { [FIGURE]: 'df-st' } });
  assert.deepEqual(r.intended, { slot: FIGURE, key: 'df-gone', source: 'opening' });
  assert.equal(r.drawn.key, 'df-st');
  assert.equal(r.drawn.source, 'subType');
  assert.equal(resolveDetailFigure({ slot: FIGURE }), null, '参照なし');
  assert.deepEqual(subTypeDetailFigureRefsFor('fitting', 'singleSwing'), null);
  assert.deepEqual(subTypeDetailFigureRefsFor('x', 'y', { detailFigures: { [FIGURE]: 'k', jamb: 'j' } }), { [FIGURE]: 'k' }, 'figure だけ読む');
});

// ---- 失敗系: fit できなければ従来の姿図 ----

const FIT_FAILURES = [
  ['基準が未対応（壁仕上面）', () => elevationFigure('df-bad', {
    over: { datums: [{ id: 'so', role: DetailDatumRole.WALL_FINISH_FACE, axis: 's', kind: 'origin', offsetMm: 0 }, ...elevationFigure('z').datums.slice(1)] },
  }), 'unsupportedDatum'],
  ['固定寸法が目標幅を超える', () => elevationFigure('df-bad', { sFixed: 900 }), 'fixedExceedsTarget'],
];
for (const [name, make, code] of FIT_FAILURES) {
  test(`【失敗系】fit できない（${name}）と従来の姿図に戻り、source:detail は 1 つも出ない。エラーは ${code}`, () => {
    installElevationFigures([make()]);
    const o = withRef(door(), 'df-bad');
    const r = resolveDetailElevation({ opening: o, entry: entryOf(o) });
    assert.equal(r.error.code, code);
    const prims = buildOpeningElevation(o, { tag: null, entry: entryOf(o) });
    assert.deepEqual(prims, buildOpeningElevation(door(), { tag: null, entry: entryOf(door()) }), '割当てなしと同一の従来の姿図');
  });
}

test('【失敗系】参照先の図がカタログに無ければ従来の姿図（resolveDetailElevation は null）', () => {
  installElevationFigures([]);
  const o = withRef(door(), 'df-none');
  assert.equal(resolveDetailElevation({ opening: o, entry: entryOf(o) }), null);
  assert.equal(detailPrims(buildOpeningElevation(o, { tag: null, entry: entryOf(o) })).length, 0);
});

// ---- メモの鍵 ----

test('detailFitKey: 従来の（壁厚・出幅・見付）の並びは不変、姿図は（幅・高さ・窓台）。1e-6 mm 丸め・図のキーと slot が鍵に入る', () => {
  assert.equal(detailFitKey({ figureKey: 'k', slot: 'jamb', wallThickness: 105, projection: 12, faceWidth: 20 }), 'k|jamb|105|12|20');
  assert.equal(detailFitKey({ figureKey: 'k', slot: 'jamb', dims: { faceWidth: 20, wallThickness: 105, projection: 12 } }), 'k|jamb|105|12|20', 'dims の挿入順に依らない');
  assert.equal(detailFitKey({ figureKey: 'k', slot: FIGURE, dims: { sill: 900, height: 1200, width: 800 } }), 'k|figure|800|1200|900');
  assert.equal(detailFitKey({ figureKey: 'k', slot: FIGURE, dims: { width: 800 + 1e-9, height: 1200, sill: 900 } }), 'k|figure|800|1200|900');
  assert.notEqual(detailFitKey({ figureKey: 'k', slot: FIGURE, dims: { width: 800, height: 1200, sill: 0 } }), 'k|figure|800|1200|900');
});

test('fitDetailLocalMemo（姿図）: 同じ（図・寸法）は fit し直さず、寸法が違えば別の結果', () => {
  installElevationFigures([elevationFigure('df-memo')]);
  const dims = { width: 800, height: 2000, sill: 0 };
  const a = fitDetailLocalMemo({ figureKey: 'df-memo', slot: FIGURE, dims });
  assert.equal(fitDetailLocalMemo({ figureKey: 'df-memo', slot: FIGURE, dims: { ...dims } }), a);
  assert.notEqual(fitDetailLocalMemo({ figureKey: 'df-memo', slot: FIGURE, dims: { ...dims, width: 900 } }), a);
  assert.equal(fitDetailLocalMemo({ figureKey: 'df-none', slot: FIGURE, dims }).error.code, 'noFigure');
});

// ---- 通知（建具モード・展開モード・立面の入口が共有する集計） ----

test('通知: fit できない姿図は 1 件（同じ図×寸法は重複排除）。文言は「詳細図 <図の呼称> を <建具種別> の姿図に合わせられません: <理由>」', () => {
  installElevationFigures([elevationFigure('df-bad', { sFixed: 900 })]);
  const a = withRef(door(), 'df-bad'), b = withRef(door(), 'df-bad');
  const rows = collectDetailFigureFailures([a, b]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot, FIGURE);
  assert.equal(rows[0].symbolKey, 'singleSwing');
  assert.deepEqual(rows[0].dims, { width: 800, height: 2000, sill: 0 });
  assert.match(rows[0].message, /^詳細図 テスト姿図 を singleSwing の姿図に合わせられません: 固定寸法の和が目標を超える/);
  // 寸法違いは別の組
  const c = withRef(door({ width: 850 }), 'df-bad');
  assert.equal(collectDetailFigureFailures([a, c]).length, 2);
  // seen を共有すれば階をまたいで 1 回
  const seen = new Set();
  assert.equal(collectDetailFigureFailures([a], seen).length, 1);
  assert.equal(collectDetailFigureFailures([b], seen).length, 0);
});

test('【失敗系】通知: 参照先の図が無い姿図は「見つかりません」の行（上書きの主語は建具個別の指定・建具種別の主語は建具種別キー）', () => {
  installElevationFigures([], [subTypeEntry('user1', 'df-gone-st')]);
  const op = withRef(door(), 'df-gone-op');
  const st = { category: OpeningCategory.FITTING, subType: 'user1', width: 800, height: 2000 };
  const rows = collectDetailFigureFailures([op, st]);
  assert.equal(rows.length, 2);
  assert.match(rows[0].message, /建具個別の指定 の姿図の詳細図がカタログに見つかりません/);
  assert.match(rows[1].message, /user1 の姿図の詳細図がカタログに見つかりません/);
});

test('通知: 正常に合わせられる・参照なしの建具は 0 件。collectDetailFitFailures は既定で姿図も数え、slots で絞れる', () => {
  installElevationFigures([elevationFigure('df-ok'), elevationFigure('df-bad', { sFixed: 900 })]);
  assert.deepEqual(collectDetailFigureFailures([withRef(door(), 'df-ok'), door(), null].filter(Boolean)), []);
  const graph = { openings: [withRef(door(), 'df-bad')] };
  assert.equal(collectDetailFitFailures(graph).length, 1, '既定の slots に姿図を含む（建具モード init）');
  assert.equal(collectDetailFitFailures(graph, undefined, { slots: [DetailSlot.JAMB, DetailSlot.HEAD] }).length, 0, '方立・上枠だけなら数えない');
  assert.equal(collectDetailFitFailures(graph, undefined, { slots: [DetailSlot.HEAD, FIGURE] }).length, 1, '展開 init の slots');
  assert.deepEqual(collectDetailFigureFailures(null), []);
});
