// 外付け引き戸の建具一式（組込み df-builtin-fitting-sliding。C4）: 部品 6 個の fit 点列・基準の割当て・置き場（戸先端／戸尻側の短い縦枠／端材）・
// 詳細 LOD の平面記号（openingPlanSymbol.js slideFittingPrimitives）・天伏（direction 'up'）・縮退・同梱・配線。
// fixture は原点からずらす: 横壁＝軸 y=3000（面 2940〜3060＝壁厚 120）・縦壁＝軸 x=3000。建具 along 1000〜2550（W=1550・DW=800・穴 750）。
// 世界座標の期待値は手計算（局所の s＝戸尻へ向かう along・t＝走る面から壁の中へ。図は問題1.md C4 §1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OpeningCategory } from '@core';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { collectUsedKeys } from '../catalog/usedEntries.js';
import {
  DetailSlot, DetailCategory, DetailDatumRole, DetailDatumKind, DetailAxis, DetailParam, FittingPartRole,
  DETAIL_BUILTIN_FITTING_SLIDING_KEY as KEY, DETAIL_PRIM_SOURCE, SLIDE_OUTSET_SUBTYPE, FRAME_OVERHANG_MM,
} from '../core/constants.js';
import { detailBuiltinFigures, fitLocal, DetailFitError } from '../detail/detailPlacement.js';
import { normalizeDetailFigure, validateDetailFigure, isSupportedDetailFigure, fittingPartFigure } from '../detail/detailModel.js';
import { LodLevel } from '../viewport.js';
import { OpeningMechanism, detailFigureEntry, fitDetailLocalMemo } from './openingCatalog.js';
import { buildOpeningPlanSymbol, planSymbolWeightMm } from './openingPlanSymbol.js';
import { resolveSlideFittingParts, fittingDefaultKey } from './openingDetailFit.js';
import { detailSlidePlanTargets, placeSlidePart, DetailFrameError } from './openingDetailFrame.js';

test.afterEach(() => clearOverlays());

const ROLE = FittingPartRole;
const ENTRY = { mechanism: OpeningMechanism.SLIDE_SINGLE };
const DASH = [10, 6];
const DF = CatalogKind.DETAIL_FIGURE;

// ---- fit の寸法（壁厚だけ変える）と部品の fit ----
const dimsOf = wallThickness => ({ wallThickness, projection: FRAME_OVERHANG_MM, doorWidth: 800, width: 1550, clearWidth: 750, faceWidth: 30 });
const fitPart = (role, wallThickness) => fitDetailLocalMemo({
  figureKey: `${KEY}#${role}`, slot: DetailSlot.FITTING, dims: dimsOf(wallThickness), targetsOf: detailSlidePlanTargets,
});
const pts = fitted => fitted.strokes.map(s => s.points.map(p => [p.s, p.t]));

// ---- 組込みの図そのもの ----

test('組込み: 一式 1 件（FITTING・PLAN・OPENING・label）・部品 6 個（id＝role）・最上位は形を持たない', () => {
  const set = detailBuiltinFigures.find(e => e.key === KEY);
  assert.equal(set.category, DetailCategory.FITTING);
  assert.equal(set.label, '引き戸 一式（外付け・欠き込み 50）');
  assert.deepEqual([set.strokes, set.datums, set.anchors], [[], [], []]);
  assert.deepEqual(set.parts.map(p => p.id), set.parts.map(p => p.role));
  assert.deepEqual(set.parts.map(p => p.role),
    [ROLE.SLIDE_LATCH, ROLE.SLIDE_INNER, ROLE.SLIDE_TAIL, ROLE.SLIDE_LATCH_UP, ROLE.SLIDE_INNER_UP, ROLE.SLIDE_TAIL_UP]);
});

test('組込み: 一式は validate を通り isSupported 真・カタログ登録の検証も通る・正規化は冪等・部品の合成図も validate を通る', () => {
  const set = detailBuiltinFigures.find(e => e.key === KEY);
  assert.deepEqual(validateDetailFigure(set), { ok: true, errors: [] });
  assert.equal(isSupportedDetailFigure(set), true);
  assert.doesNotThrow(() => kindDef(DF).validate(set));
  assert.deepEqual(normalizeDetailFigure(normalizeDetailFigure(set)), normalizeDetailFigure(set));
  for (const role of Object.values(ROLE).filter(r => r.startsWith('slide'))) {
    const part = fittingPartFigure(set, role);
    assert.deepEqual(validateDetailFigure(part), { ok: true, errors: [] }, role);
  }
});

// ---- 部品ごとの fit 点列（壁厚 100・150。局所 [s, t]。手計算）----

const FIT_CASES = [
  // [role, 壁厚, ストロークごとの点列]
  [ROLE.SLIDE_LATCH, 100, [
    [[0, -12], [-30, -12], [-30, 0], [-30, 100], [-30, 112], [0, 112]],
    [[0, 5], [800, 5], [800, 35], [0, 35]],
  ]],
  [ROLE.SLIDE_LATCH, 150, [
    [[0, -12], [-30, -12], [-30, 0], [-30, 150], [-30, 162], [0, 162]],
    [[0, 5], [800, 5], [800, 35], [0, 35]],
  ]],
  [ROLE.SLIDE_INNER, 100, [
    [[0, 50], [0, 38], [30, 38], [30, 50], [30, 100], [30, 112], [0, 112]],
  ]],
  [ROLE.SLIDE_INNER, 150, [
    [[0, 50], [0, 38], [30, 38], [30, 50], [30, 150], [30, 162], [0, 162]],
  ]],
  [ROLE.SLIDE_TAIL, 100, [
    [[0, 0], [0, -12], [30, -12], [30, 0], [30, 50], [0, 50]],
    [[0, 5], [-800, 5], [-800, 35], [0, 35]],
  ]],
  [ROLE.SLIDE_TAIL, 150, [ // 端材は壁厚に追従しない
    [[0, 0], [0, -12], [30, -12], [30, 0], [30, 50], [0, 50]],
    [[0, 5], [-800, 5], [-800, 35], [0, 35]],
  ]],
  [ROLE.SLIDE_LATCH_UP, 100, [
    [[0, -12], [-30, -12], [-30, 0], [-30, 100], [-30, 112], [0, 112]],
    [[0, 5], [800, 5], [800, 35], [0, 35]],
    [[0, -12], [1550, -12]], // 上レール（W 全長）
  ]],
  [ROLE.SLIDE_INNER_UP, 100, [
    [[0, 50], [30, 50], [30, 100], [30, 112], [0, 112], [-750, 112]], // 縦枠は t 50 で止め、上枠の外の線は穴の全長
    [[0, 50], [0, 100], [0, 112]],
  ]],
  [ROLE.SLIDE_INNER_UP, 150, [
    [[0, 50], [30, 50], [30, 150], [30, 162], [0, 162], [-750, 162]],
    [[0, 50], [0, 150], [0, 162]],
  ]],
  [ROLE.SLIDE_TAIL_UP, 100, [
    [[0, 0], [0, -12], [30, -12], [30, 0], [30, 50], [0, 50]],
    [[0, 5], [-800, 5], [-800, 35], [0, 35]],
  ]],
];

for (const [role, wall, expected] of FIT_CASES) {
  test(`fit: ${role}・壁厚 ${wall} → 局所の点列が手計算どおり`, () => {
    const fitted = fitPart(role, wall);
    assert.equal(fitted.error, undefined, fitted.error?.message);
    assert.deepEqual(pts(fitted), expected);
  });
}

test('fit: 破線は開けた扉（slideTail の 2 本目）だけ・他は実線', () => {
  const tail = fitPart(ROLE.SLIDE_TAIL, 100);
  assert.deepEqual(tail.strokes.map(s => s.line.dashRole), ['solid', 'dashed']);
  assert.ok(fitPart(ROLE.SLIDE_LATCH, 100).strokes.every(s => s.line.dashRole === 'solid'));
});

test('fit 失敗: slideInner は壁厚 50（欠き込みの深さ）で伸縮が尽き FIXED_EXCEEDS_TARGET（この部品だけ描かれない）。50.5 は fit できる', () => {
  const r = fitPart(ROLE.SLIDE_INNER, 50);
  assert.equal(r.error.code, DetailFitError.FIXED_EXCEEDS_TARGET);
  assert.equal(fitPart(ROLE.SLIDE_INNER, 50.5).error, undefined);
  // 他の部品は壁厚 50 でも fit できる（slideLatch は壁の外へ出る縦枠で壁厚に依らず伸びる）
  assert.equal(fitPart(ROLE.SLIDE_LATCH, 50).error, undefined);
});

test('基準の割当て: 未対応の基準（FL）は UNSUPPORTED_DATUM。図の無いキーは NO_FIGURE で例外にならない', () => {
  const fig = { datums: [{ id: 'dx', role: DetailDatumRole.FL, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 }] };
  assert.equal(detailSlidePlanTargets(fig, dimsOf(100)).error.code, DetailFrameError.UNSUPPORTED_DATUM);
  assert.deepEqual(detailSlidePlanTargets(null, dimsOf(100)).targets.datums, {}); // 形の不正な図は例外にせず fit の検証へ回す
  const none = fitDetailLocalMemo({ figureKey: 'df-none#slideLatch', slot: DetailSlot.FITTING, dims: dimsOf(100), targetsOf: detailSlidePlanTargets });
  assert.equal(none.error.code, DetailFrameError.NO_FIGURE);
});

test('基準の割当て: param 5 つ（出幅・扉幅・穴の幅・壁厚・見付）と s の end＝W・t の end＝壁厚', () => {
  const up = detailFigureEntry(`${KEY}#slideLatchUp`);
  const t = detailSlidePlanTargets(up, dimsOf(120)).targets;
  assert.deepEqual(t.params, {
    [DetailParam.FRAME_PROJECTION]: 12, [DetailParam.DOOR_WIDTH]: 800, [DetailParam.OPENING_CLEAR_WIDTH]: 750,
    [DetailParam.WALL_THICKNESS]: 120, [DetailParam.FRAME_FACE_WIDTH]: 30,
  });
  assert.deepEqual(t.datums, { ds0: 0, ds1: 1550, dt0: 0, dt1: 120 });
  assert.equal(DetailParam.OPENING_CLEAR_WIDTH, 'clearWidth');
  // 局所図そのものも他の経路（fitLocal 直）で同じ点列になる
  assert.deepEqual(pts(fitLocal(up, t)), pts(fitPart(ROLE.SLIDE_LATCH_UP, 120)));
});

// ---- 置き場の写像 placeSlidePart ----

test('placeSlidePart: 横の壁 (ox=refAlong, oy=facePerp, sx, ty)・縦の壁は along と perp が入れ替わる（局所 (s=10, t=20)）', () => {
  const fitted = { strokes: [{ id: 'a', points: [{ s: 10, t: 20 }], closed: false, line: {} }] };
  const at = p => placeSlidePart(fitted, p)[0].points[0];
  assert.deepEqual(at({ refAlong: 100, sx: 1, facePerp: 500, ty: 1, isVertical: false }), [110, 520]);
  assert.deepEqual(at({ refAlong: 100, sx: -1, facePerp: 500, ty: -1, isVertical: false }), [90, 480]);
  assert.deepEqual(at({ refAlong: 100, sx: 1, facePerp: 500, ty: -1, isVertical: true }), [480, 110]);
  assert.deepEqual(at({ refAlong: 100, sx: -1, facePerp: 500, ty: 1, isVertical: true }), [520, 90]);
  assert.equal(placeSlidePart(fitted, { refAlong: 0, sx: 1, facePerp: 0, ty: 1, isVertical: false })[0].source, DETAIL_PRIM_SOURCE);
});

// ---- 解決（既定・明示・天伏）----

const sliding = (over = {}) => ({ category: OpeningCategory.FITTING, subType: SLIDE_OUTSET_SUBTYPE, ...over });
const keyOf = role => `${KEY}#${role}`;

test('解決: 引き戸は既定の組込み一式の 3 部品（source default）。天伏は *Up。引き戸でない建具は全部 null・既定キーも null', () => {
  assert.equal(fittingDefaultKey(sliding()), KEY);
  assert.equal(fittingDefaultKey({ subType: 'singleSwing' }), null);
  assert.equal(fittingDefaultKey({}), null);
  assert.deepEqual(resolveSlideFittingParts(sliding(), null), {
    latch: { key: keyOf('slideLatch'), source: 'default' },
    inner: { key: keyOf('slideInner'), source: 'default' },
    tail: { key: keyOf('slideTail'), source: 'default' },
  });
  assert.deepEqual(resolveSlideFittingParts(sliding(), null, 'up'), {
    latch: { key: keyOf('slideLatchUp'), source: 'default' },
    inner: { key: keyOf('slideInnerUp'), source: 'default' },
    tail: { key: keyOf('slideTailUp'), source: 'default' },
  });
  assert.deepEqual(resolveSlideFittingParts({ subType: 'singleSwing' }, null), { latch: null, inner: null, tail: null });
});

test('解決: 明示（建具個別 detailRefs.fitting・建具種別の detailFigures.fitting）は source explicit。参照切れ・明示 null は全部 null（既定へ落とさない）', () => {
  const set = fittingSetOf('set-x', ['slideLatch', 'slideTail']);
  setOverlay(DF, { user: [set] });
  const own = resolveSlideFittingParts(sliding({ detailRefs: { fitting: 'set-x' } }), null);
  assert.deepEqual(own, { latch: { key: 'set-x#slideLatch', source: 'explicit' }, inner: null, tail: { key: 'set-x#slideTail', source: 'explicit' } });
  const viaType = resolveSlideFittingParts(sliding(), { detailFigures: { fitting: 'set-x' } });
  assert.equal(viaType.latch.source, 'explicit');
  assert.equal(resolveSlideFittingParts(sliding({ detailRefs: { fitting: 'set-gone' } }), null).latch, null);
  assert.deepEqual(resolveSlideFittingParts(sliding({ detailRefs: { fitting: null } }), null), { latch: null, inner: null, tail: null });
});

// ---- 詳細 LOD の平面記号 ----

function makeOpening(over = {}) {
  return {
    category: OpeningCategory.FITTING, subType: SLIDE_OUTSET_SUBTYPE,
    coord1: 1000, coord2: 2550, centerCoord: 1775, isVertical: false,
    width: 1550, frameDepth: 0, lineWeight: 0.5, hingeSide: -1, swingSide: 1,
    ...over,
  };
}
function makeCtx(over = {}) {
  return { entry: ENTRY, lodLevel: LodLevel.DETAIL, axisValue: 3000, faceLo: 2940, faceHi: 3060, exteriorDirOf: () => 1, ...over };
}
const plan = (over, ctx) => buildOpeningPlanSymbol(makeOpening(over), makeCtx(ctx));

/** 建具一式 setKey（既存の組込みの部品から role だけ抜き出した別キーの一式）。 */
function fittingSetOf(setKey, roles) {
  const builtin = detailBuiltinFigures.find(e => e.key === KEY);
  return { ...builtin, key: setKey, label: `試験用${setKey}`, parts: builtin.parts.filter(p => roles.includes(p.role)) };
}

// bbox を (along, perp) で返す
function box(prims, isVertical) {
  const xs = [], ys = [];
  for (const p of prims) {
    if (p.type === 'polyline') p.points.forEach((v, i) => (i % 2 === 0 ? xs : ys).push(v));
    else { xs.push(p.x1, p.x2); ys.push(p.y1, p.y2); }
  }
  const x = [Math.min(...xs), Math.max(...xs)];
  const y = [Math.min(...ys), Math.max(...ys)];
  return isVertical ? { along: y, perp: x } : { along: x, perp: y };
}

// tailSide（hingeSide）ごとの along の区間・走る面（runPerpDir）ごとの perp の区間。手計算（壁厚 120・faceLo 2940・faceHi 3060）。
//   tailSide −1: 戸先端 A=2550・sx=−1 → 戸先枠 [2550,2580]・閉じた扉 [1750,2550]・短い縦枠 [A−750−30, A−750]＝[1770,1800]・端材 [970,1000]（W の外）・開けた扉 [1000,1800]
//   tailSide +1: A=1000・sx=+1 → 戸先枠 [970,1000]・閉じた扉 [1000,1800]・短い縦枠 [1750,1780]・端材 [2550,2580]・開けた扉 [1750,2550]
const ALONG = {
  '-1': { latch: [2550, 2580], door: [1750, 2550], inner: [1770, 1800], tail: [970, 1000], open: [1000, 1800] },
  1: { latch: [970, 1000], door: [1000, 1800], inner: [1750, 1780], tail: [2550, 2580], open: [1750, 2550] },
};
//   runPerpDir +1（走る面 faceHi 3060・t は −perp）: 枠は t −12〜132 → [2928,3072]・扉 t 5〜35 → [3025,3055]・短い縦枠 t 38〜132 → [2928,3022]・端材 t −12〜50 → [3010,3072]
//   runPerpDir −1（走る面 faceLo 2940・t は +perp）: 枠 [2928,3072]・扉 [2945,2975]・短い縦枠 [2978,3072]・端材 [2928,2990]
const PERP = {
  1: { latch: [2928, 3072], door: [3025, 3055], inner: [2928, 3022], tail: [3010, 3072], open: [3025, 3055] },
  '-1': { latch: [2928, 3072], door: [2945, 2975], inner: [2978, 3072], tail: [2928, 2990], open: [2945, 2975] },
};

for (const isVertical of [false, true]) {
  for (const hingeSide of [-1, 1]) {
    for (const swingSide of [1, -1]) {
      // 開き戸の開く側と同じ積（slideOutset.js runPerpDir の文書）: (縦ならば +1・横ならば −1) × swingSide × hingeSide
      const runPerpDir = (isVertical ? 1 : -1) * swingSide * hingeSide;
      test(`詳細 LOD の置き場: ${isVertical ? '縦' : '横'}壁・hingeSide ${hingeSide}・swingSide ${swingSide}（走る面 ${runPerpDir > 0 ? '大' : '小'}側）→ 戸先枠・閉じた扉・短い縦枠・端材・開けた扉の along/perp`, () => {
        const prims = plan({ isVertical, hingeSide, swingSide });
        // 順: 戸先枠・閉じた扉・短い縦枠・端材（以上 polyline）・開けた扉（破線 4 本）
        assert.deepEqual(prims.map(p => p.type), ['polyline', 'polyline', 'polyline', 'polyline', 'line', 'line', 'line', 'line']);
        const along = ALONG[hingeSide], perp = PERP[runPerpDir];
        const got = [box([prims[0]], isVertical), box([prims[1]], isVertical), box([prims[2]], isVertical), box([prims[3]], isVertical), box(prims.slice(4), isVertical)];
        ['latch', 'door', 'inner', 'tail', 'open'].forEach((name, i) => {
          assert.deepEqual(got[i].along, along[name], `${name} の along`);
          assert.deepEqual(got[i].perp, perp[name], `${name} の perp`);
        });
      });
    }
  }
}

test('詳細 LOD の世界座標（横壁・hingeSide −1・swingSide 1）: 戸先枠・閉じた扉・短い縦枠・端材・開けた扉の頂点が手計算どおり', () => {
  const prims = plan({});
  // runPerpDir +1・A=2550・sx=−1・走る面 3060・t は −y（壁厚 120）
  assert.deepEqual(prims[0].points, [2550, 3072, 2580, 3072, 2580, 3060, 2580, 2940, 2580, 2928, 2550, 2928]);
  assert.deepEqual(prims[1].points, [2550, 3055, 1750, 3055, 1750, 3025, 2550, 3025]);
  assert.deepEqual(prims[2].points, [1800, 3010, 1800, 3022, 1770, 3022, 1770, 3010, 1770, 2940, 1770, 2928, 1800, 2928]);
  assert.deepEqual(prims[3].points, [1000, 3060, 1000, 3072, 970, 3072, 970, 3060, 970, 3010, 1000, 3010]);
  assert.deepEqual(prims.slice(4).map(l => [l.x1, l.y1, l.x2, l.y2]), [
    [1000, 3055, 1800, 3055], [1800, 3055, 1800, 3025], [1800, 3025, 1000, 3025], [1000, 3025, 1000, 3055],
  ]);
  assert.deepEqual(prims.slice(0, 4).map(p => p.closed), [true, true, true, true]);
});

test('詳細 LOD: 既定で 3 部品が描かれ、S4 のフォールバックの穴の枠（rect）は描かない。source・太さ・破線の規則', () => {
  const opening = makeOpening();
  const prims = buildOpeningPlanSymbol(opening, makeCtx());
  assert.equal(prims.some(p => p.type === 'rect'), false);
  assert.ok(prims.every(p => p.source === DETAIL_PRIM_SOURCE));
  const frameW = planSymbolWeightMm('frame', opening, true);
  for (const p of prims.filter(q => q.type === 'polyline')) { assert.equal(p.role, 'frame'); assert.equal(p.weightMm, frameW); }
  for (const l of prims.filter(q => q.type === 'line')) { assert.equal(l.role, 'symbol'); assert.equal(l.weightMm, 0.5); assert.deepEqual(l.dash, DASH); }
});

test('詳細 LOD: hingeSide だけでなく両方反転（flipped）すると走る面は不変・along は左右入れ替わる', () => {
  const a = plan({ hingeSide: -1, swingSide: 1 });
  const b = plan({ hingeSide: 1, swingSide: -1 });
  assert.deepEqual(box([a[1]], false).perp, box([b[1]], false).perp);
  assert.deepEqual(box([a[1]], false).along, [1750, 2550]);
  assert.deepEqual(box([b[1]], false).along, [1000, 1800]);
});

test('詳細 LOD: 一式の無い subType は S4 のフォールバック（穴の枠＋実寸の扉矩形）で、subType 無しと deepEqual', () => {
  const noFitting = plan({ subType: 'someOther' });
  assert.deepEqual(noFitting, plan({ subType: undefined }));
  assert.deepEqual(noFitting.map(p => p.type), ['polyline', 'polyline', 'rect', 'rect', 'rect']);
  assert.ok(noFitting.every(p => p.source === undefined));
});

test('詳細 LOD: detailRefs.fitting の明示 null（なし）・参照切れの明示は S4 のフォールバック', () => {
  const fallback = plan({ subType: 'someOther' });
  assert.deepEqual(plan({ detailRefs: { fitting: null } }), fallback);
  assert.deepEqual(plan({ detailRefs: { fitting: 'set-gone' } }), fallback);
});

test('詳細 LOD: 部品欠け（明示の一式が戸尻側の短い縦枠を持たない）は残りの部品だけ描く', () => {
  setOverlay(DF, { user: [fittingSetOf('set-no-inner', ['slideLatch', 'slideTail'])] });
  const prims = plan({ detailRefs: { fitting: 'set-no-inner' } });
  assert.deepEqual(prims.map(p => p.type), ['polyline', 'polyline', 'polyline', 'line', 'line', 'line', 'line']);
  assert.deepEqual(box([prims[0]], false).along, [2550, 2580]);
  assert.deepEqual(box([prims[2]], false).along, [970, 1000]); // 端材。短い縦枠 [1770,1800] は無い
  // 部品が 1 つも無い一式は S4 のフォールバック
  setOverlay(DF, { user: [fittingSetOf('set-empty', ['jamb'])] });
  assert.deepEqual(plan({ detailRefs: { fitting: 'set-empty' } }), plan({ subType: 'someOther' }));
});

// 寸法がプレビュー値（W 1550・DW 800・穴 750）以外でも param・置き場が建具の寸法に追従する（プレビュー値の固定を検出する）。
test('詳細 LOD の世界座標（W 1750・DW 900・穴 850。横壁・hingeSide 1・swingSide 1）: 戸先枠・閉じた扉・短い縦枠・端材・開けた扉の along', () => {
  const prims = plan({ coord1: 1000, coord2: 2750, centerCoord: 1875, width: 1750, hingeSide: 1, swingSide: 1 });
  assert.deepEqual(prims.map(p => p.type), ['polyline', 'polyline', 'polyline', 'polyline', 'line', 'line', 'line', 'line']);
  const along = { latch: [970, 1000], door: [1000, 1900], inner: [1850, 1880], tail: [2750, 2780], open: [1850, 2750] };
  const got = [box([prims[0]], false), box([prims[1]], false), box([prims[2]], false), box([prims[3]], false), box(prims.slice(4), false)];
  ['latch', 'door', 'inner', 'tail', 'open'].forEach((name, i) => {
    assert.deepEqual(got[i].along, along[name], `${name} の along`);
    assert.deepEqual(got[i].perp, PERP['-1'][name], `${name} の perp`);
  });
});

test('fit: W 1750（DW 900・穴 850）の slideLatchUp・slideInnerUp は上レール W 全長・上枠の外の線 穴の全長・閉じた扉 DW', () => {
  const dims = { ...dimsOf(100), doorWidth: 900, width: 1750, clearWidth: 850 };
  const fit = role => fitDetailLocalMemo({ figureKey: `${KEY}#${role}`, slot: DetailSlot.FITTING, dims, targetsOf: detailSlidePlanTargets });
  const latch = pts(fit(ROLE.SLIDE_LATCH_UP));
  assert.deepEqual(latch[2], [[0, -12], [1750, -12]]);
  assert.deepEqual(latch[1], [[0, 5], [900, 5], [900, 35], [0, 35]]);
  assert.deepEqual(pts(fit(ROLE.SLIDE_INNER_UP))[0].at(-1), [-850, 112]);
  assert.deepEqual(pts(fit(ROLE.SLIDE_TAIL))[1], [[0, 5], [-900, 5], [-900, 35], [0, 35]]);
});

test('部品の fit 失敗はその部品だけ描かない（未対応の基準 FL → UNSUPPORTED_DATUM。例外にならない）。全部品が fit 不能なら S4 と deepEqual', () => {
  const badSet = (setKey, badRoles) => {
    const set = fittingSetOf(setKey, ['slideLatch', 'slideInner', 'slideTail']);
    return {
      ...set,
      parts: set.parts.map(p => (badRoles.includes(p.role)
        ? { ...p, figure: { ...p.figure, datums: p.figure.datums.map(d => (d.id === 'dt0' ? { ...d, role: DetailDatumRole.FL } : d)) } }
        : p)),
    };
  };
  setOverlay(DF, { user: [badSet('set-bad-inner', ['slideInner']), badSet('set-bad-all', ['slideLatch', 'slideInner', 'slideTail'])] });
  assert.equal(fitDetailLocalMemo({ figureKey: 'set-bad-inner#slideInner', slot: DetailSlot.FITTING, dims: dimsOf(120), targetsOf: detailSlidePlanTargets }).error.code, DetailFrameError.UNSUPPORTED_DATUM);
  const prims = plan({ detailRefs: { fitting: 'set-bad-inner' } });
  assert.deepEqual(prims.map(p => p.type), ['polyline', 'polyline', 'polyline', 'line', 'line', 'line', 'line']);
  assert.deepEqual(box([prims[0]], false).along, [2550, 2580]); // 戸先枠
  assert.deepEqual(box([prims[2]], false).along, [970, 1000]); // 端材。短い縦枠は無い
  assert.deepEqual(plan({ detailRefs: { fitting: 'set-bad-all' } }), plan({ subType: 'someOther' }));
});

test('詳細 LOD: 一般 LOD（STANDARD）は subType が引き戸でも S4 の記号のまま（一式を使わない）', () => {
  const std = plan({}, { lodLevel: LodLevel.STANDARD });
  assert.deepEqual(std, plan({ subType: 'someOther' }, { lodLevel: LodLevel.STANDARD }));
  assert.equal(std.length, 3);
});

// ---- 縮退（S4 と deepEqual）----

test('縮退: 外壁ホスト（R12）・runPerpDir 0（swingSide 0）・壁厚 ≤ 50・面が非有限は一式を使わず S4 と deepEqual', () => {
  const cases = [
    [{}, { host: { isExteriorWall: true } }],
    [{ swingSide: 0 }, {}],
    [{}, { faceLo: 2975, faceHi: 3025 }], // 壁厚ちょうど 50
    [{}, { faceLo: 2987.5, faceHi: 3012.5 }],
    [{}, { faceLo: NaN, faceHi: 3060 }],
    [{}, { faceLo: undefined, faceHi: undefined }],
  ];
  for (const [over, ctx] of cases) {
    const withFitting = plan(over, ctx);
    assert.deepEqual(withFitting, plan({ ...over, subType: 'someOther' }, ctx), JSON.stringify([over, ctx]));
    assert.ok(withFitting.every(p => p.source === undefined && p.type !== undefined), '一式の prim が混じっていない');
  }
  // 壁厚 50.5 は欠き込む＝一式で描く（短い縦枠は伸縮 0.5 で描かれる）
  assert.equal(plan({}, { faceLo: 2974.75, faceHi: 3025 }).filter(p => p.type === 'polyline').length, 4);
});

// ---- 天伏（direction 'up'）----

test("天伏: direction 'up' で *Up の部品（上レール・縦枠の短縮・上枠の外の線）。世界座標が手計算どおり", () => {
  const prims = plan({}, { direction: 'up' });
  assert.deepEqual(prims.map(p => p.type), ['polyline', 'polyline', 'polyline', 'polyline', 'polyline', 'polyline', 'line', 'line', 'line', 'line']);
  // 順: 戸先枠・閉じた扉・上レール（開いた線）・短い縦枠の枠線・短い縦枠の壁内の線・端材・開けた扉（破線 4 本）
  assert.deepEqual(prims[0].points, [2550, 3072, 2580, 3072, 2580, 3060, 2580, 2940, 2580, 2928, 2550, 2928]);
  assert.deepEqual(prims[2].points, [2550, 3072, 1000, 3072]); // W 全長（上レール t −12）
  assert.equal(prims[2].closed, false);
  assert.deepEqual(prims[3].points, [1800, 3010, 1770, 3010, 1770, 2940, 1770, 2928, 1800, 2928, 2550, 2928]); // 穴の全長ぶん戸先側へ
  assert.deepEqual(prims[4].points, [1800, 3010, 1800, 2940, 1800, 2928]);
  assert.deepEqual(prims[5].points, [1000, 3060, 1000, 3072, 970, 3072, 970, 3060, 970, 3010, 1000, 3010]);
  assert.equal(prims.some(p => p.type === 'rect'), false);
});

test("天伏: *Up の無い一式は平面の部品へ落ちる（'down' と同じ出力）。一部だけ *Up があればその部品だけ *Up", () => {
  setOverlay(DF, { user: [fittingSetOf('set-plain', ['slideLatch', 'slideInner', 'slideTail']), fittingSetOf('set-mixed', ['slideLatch', 'slideInner', 'slideTail', 'slideInnerUp'])] });
  const down = plan({ detailRefs: { fitting: 'set-plain' } });
  assert.deepEqual(plan({ detailRefs: { fitting: 'set-plain' } }, { direction: 'up' }), down);
  const mixed = plan({ detailRefs: { fitting: 'set-mixed' } }, { direction: 'up' });
  assert.equal(mixed.length, down.length + 1); // 短い縦枠だけ 2 ストローク（枠線＋壁内の線）になる
  assert.deepEqual(mixed[0], down[0]);
  assert.deepEqual(mixed[1], down[1]);
});

test("天伏: direction 省略は 'down' と同じ", () => {
  assert.deepEqual(plan({}), plan({}, { direction: 'down' }));
  assert.notDeepEqual(plan({}), plan({}, { direction: 'up' }));
});

// ---- 同梱 ----

test('同梱: subType が引き戸の建具があれば一式 1 件（複数あっても 1 件・外壁でも同じ）。引き戸が無ければ入らない', () => {
  const some = collectUsedKeys({ openings: [{ id: 'o1', category: 'fitting', subType: SLIDE_OUTSET_SUBTYPE }, { id: 'o2', category: 'fitting', subType: SLIDE_OUTSET_SUBTYPE }] });
  assert.deepEqual([...some.detailFigure], [KEY]);
  assert.deepEqual([...collectUsedKeys({ openings: [{ id: 'o3', category: 'fitting', subType: 'swingIn' }] }).detailFigure], []);
});

// ---- 配線 ----

function codeOnly(file) {
  return fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8').split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
}

test('配線: OpeningsLayer は buildOpeningPlanSymbol の ctx に direction を渡す（天伏で *Up の部品に切り替わる）', () => {
  const src = codeOnly('../renderer/OpeningsLayer.jsx');
  const call = src.slice(src.indexOf('buildOpeningPlanSymbol(opening, {'));
  const ctxBody = call.slice(0, call.indexOf('});'));
  assert.match(ctxBody, /\bdirection\b\s*,/, 'ctx に direction が無い（天伏でも平面の部品が描かれる）');
  assert.match(src, /direction = 'down'/);
});

test('配線: 詳細 LOD の一式は走る面が決まったときだけ（runsOnFace）・detail の分岐の中で slideFittingPrimitives を呼ぶ', () => {
  const src = codeOnly('openingPlanSymbol.js');
  assert.match(src, /if \(detail && runsOnFace\) \{\s*const fitted = slideFittingPrimitives\(/);
  assert.match(src, /const runsOnFace = runPerpDir !== 0 && !!faceRange && slideRecessBand\(layout\.recess, faceRange\) !== null;/);
});
