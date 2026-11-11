// 外付け引き戸の純関数（slideOutset.js）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningMechanism, findCatalogEntry } from './openingCatalog.js';
import { swingOpenPerpDir } from './openingPlanSymbolGeometry.js';
import {
  isOutsetSlide, slideDoorWidth, slideClearWidth, slideTailSide, outsetSlideLayout, openingCutSpan, slideRecessBand,
  openingFootprint, openingFootprintExtraHalf, openingFootprintExtraHalfOf, openingEditExtraHalfOf, openingMinWidthOf, footprintResolver,
} from './slideOutset.js';
import { SLIDE_OUTSET_RECESS_DEPTH_MM } from '../core/constants.js';

const SLIDE = OpeningMechanism.SLIDE_SINGLE;
const op = over => ({ coord1: 1000, coord2: 2550, hingeSide: -1, swingSide: 1, isVertical: false, ...over });

test('isOutsetSlide: SLIDE_SINGLE だけ true', () => {
  assert.equal(isOutsetSlide(SLIDE), true);
  assert.equal(isOutsetSlide(OpeningMechanism.SWING), false);
  assert.equal(isOutsetSlide(OpeningMechanism.SLIDE_DOUBLE), false);
  assert.equal(isOutsetSlide(undefined), false);
});

test('カタログの引き戸の既定幅は W＝2×800−50＝1550（扉幅 800）', () => {
  const e = findCatalogEntry('fitting', 'sliding');
  assert.equal(e.defaultWidth, 1550);
  assert.equal(slideDoorWidth(e.defaultWidth), 800);
});

test('layout: W1550・hingeSide −1 → doorWidth 800・cutLength 750・戸先端 A=hi・cut=[A−780,A+30]・pull=[lo,hi−750]（pull は J ずれない）', () => {
  const l = outsetSlideLayout(op(), SLIDE);
  assert.equal(l.doorWidth, 800);
  assert.equal(l.cutLength, 750);
  assert.equal(l.tailSide, -1);
  assert.equal(l.latchAlong, 2550);
  assert.equal(l.jambWidth, 30);
  assert.deepEqual(l.cut, [1770, 2580]);
  assert.deepEqual(l.pull, [1000, 1800]);
  assert.deepEqual(l.footprint, [970, 2580]);
});

test('layout: hingeSide +1 で左右が入れ替わる（戸先端 A=lo・cut=[A−30,A+780]）', () => {
  const l = outsetSlideLayout(op({ hingeSide: 1 }), SLIDE);
  assert.equal(l.latchAlong, 1000);
  assert.deepEqual(l.cut, [970, 1780]);
  assert.deepEqual(l.pull, [1750, 2550]);
  assert.deepEqual(l.footprint, [970, 2580]);
});

test('S3c: 穴・欠き込みは縦枠の外面まで J 広がる。cut∪recess は [lo−J,hi+J] を隙間なく覆い、cut の長さ＝DW−50+2J・recess＝DW（左右とも）', () => {
  for (const hingeSide of [-1, 1]) {
    const l = outsetSlideLayout(op({ hingeSide }), SLIDE);
    const [rLo, rHi] = l.recess.span;
    assert.ok(l.cut[0] === rHi || l.cut[1] === rLo, `hingeSide=${hingeSide}: 接している`);
    assert.equal(Math.min(l.cut[0], rLo), 970);
    assert.equal(Math.max(l.cut[1], rHi), 2580);
    assert.equal(l.cut[1] - l.cut[0], 750 + 60);
    assert.equal(rHi - rLo, 800);
  }
  assert.deepEqual(outsetSlideLayout(op(), SLIDE).recess.span, [970, 1770]);
  assert.deepEqual(outsetSlideLayout(op({ hingeSide: 1 }), SLIDE).recess.span, [1780, 2580]);
});

test('S3c: openingFootprint は引き戸（W+2J）だけ広がり、引き戸でない・外壁ホスト・W≤50 は開口全幅（恒等）・coord 非有限は null', () => {
  assert.deepEqual(openingFootprint(op(), SLIDE), [970, 2580]);
  assert.deepEqual(openingFootprint(op({ coord1: 2550, coord2: 1000 }), SLIDE), [970, 2580]);
  assert.deepEqual(openingFootprint(op(), OpeningMechanism.SWING), [1000, 2550]);
  assert.deepEqual(openingFootprint(op(), SLIDE, { isExteriorWall: true }), [1000, 2550]);
  assert.deepEqual(openingFootprint(op({ coord2: 1050 }), SLIDE), [1000, 1050]);
  assert.equal(openingFootprint(op({ coord2: NaN }), SLIDE), null);
  assert.equal(openingFootprint(null, SLIDE), null);
});

test('S3c: openingFootprintExtraHalfOf は footprint 幅から導く（layout が引けない引き戸＝W≤50・外壁ホストは 0）。編集用 extra は機構から・下限は引き戸だけ 50', () => {
  const wide = { ...op(), category: 'fitting', subType: 'sliding' };
  const tiny = { ...op({ coord2: 1040 }), category: 'fitting', subType: 'sliding' };
  const door = { ...op(), category: 'fitting', subType: 'singleSwing' };
  assert.equal(openingFootprintExtraHalfOf(wide, { isExteriorWall: false }), 30);
  assert.equal(openingFootprintExtraHalfOf(tiny, { isExteriorWall: false }), 0, 'W 40: footprint は恒等');
  assert.equal(openingFootprintExtraHalfOf(wide, { isExteriorWall: true }), 0);
  assert.equal(openingFootprintExtraHalfOf(door, null), 0);
  assert.equal(openingEditExtraHalfOf(tiny, { isExteriorWall: false }), 30, '編集後の占有は機構から（今 W が小さくても J）');
  assert.equal(openingMinWidthOf(tiny, { isExteriorWall: false }), 50);
  assert.equal(openingMinWidthOf(wide, { isExteriorWall: true }), 0);
  assert.equal(openingMinWidthOf(door, null), 0);
});

test('【失敗系】S3c: footprintResolver は coord 非有限の建具で null を返さず、比較が常に false になる区間を返す', () => {
  const resolver = footprintResolver({ walls: [] });
  const o = { category: 'fitting', subType: 'sliding', coord1: NaN, coord2: NaN, isVertical: false, axisCL: { id: 'x' }, wallSide: 1 };
  const span = resolver(o);
  assert.ok(Array.isArray(span) && span.length === 2);
  const [f1, f2] = span;
  assert.equal(1000 < f2 && 2000 > f1, false);
  assert.deepEqual(resolver({ ...o, coord1: 100, coord2: 1650 }), [70, 1680], '有限なら通常どおり（host が引けなければ外壁扱いにならず外付け＝J 広がり）');
});

test('S3c: openingFootprintExtraHalf は引き戸かつ host 非外壁のときだけ J（30）・他は 0', () => {
  assert.equal(openingFootprintExtraHalf(SLIDE), 30);
  assert.equal(openingFootprintExtraHalf(SLIDE, { isExteriorWall: false }), 30);
  assert.equal(openingFootprintExtraHalf(SLIDE, { isExteriorWall: true }), 0);
  assert.equal(openingFootprintExtraHalf(OpeningMechanism.SWING), 0);
  assert.equal(openingFootprintExtraHalf(undefined), 0);
});

test('layout: coord1 > coord2 の順でも同じ', () => {
  assert.deepEqual(outsetSlideLayout(op({ coord1: 2550, coord2: 1000 }), SLIDE), outsetSlideLayout(op(), SLIDE));
});

test('layout: 奇数 W 1551 → doorWidth 800.5（裁定 R5 で 0.5 mm 許容）', () => {
  const l = outsetSlideLayout(op({ coord2: 2551 }), SLIDE);
  assert.equal(l.doorWidth, 800.5);
  assert.equal(l.cutLength, 750.5);
});

test('不変条件: pull は [lo,hi] 内の引き代（長さ DW）・cut∪recess が [lo−J,hi+J] を覆う（W 全域は cut の J 内側＋pull で覆う）', () => {
  for (const hingeSide of [-1, 1]) {
    for (const w of [100, 1550, 1551, 2000]) {
      const l = outsetSlideLayout(op({ hingeSide, coord2: 1000 + w }), SLIDE);
      assert.equal(l.pull[1] - l.pull[0], l.doorWidth);
      assert.ok(l.pull[0] >= 1000 && l.pull[1] <= 1000 + w);
      assert.equal(l.cut[1] - l.cut[0], l.cutLength + 60);
      assert.equal(Math.min(l.cut[0], l.recess.span[0]), 970);
      assert.equal(Math.max(l.cut[1], l.recess.span[1]), 1000 + w + 30);
    }
  }
});

test('runPerpDir: isVertical・swingSide・hingeSide 8 通りの積', () => {
  for (const isVertical of [true, false]) {
    for (const swingSide of [-1, 1]) {
      for (const hingeSide of [-1, 1]) {
        const l = outsetSlideLayout(op({ isVertical, swingSide, hingeSide }), SLIDE);
        assert.equal(l.runPerpDir, (isVertical ? 1 : -1) * swingSide * hingeSide);
      }
    }
  }
});

test('runPerpDir: 蝶番系の swingOpenPerpDir と同値（同式）', () => {
  const entry = findCatalogEntry('fitting', 'singleSwing');
  for (const isVertical of [true, false]) {
    for (const swingSide of [-1, 1]) {
      for (const hingeSide of [-1, 1]) {
        const l = outsetSlideLayout(op({ isVertical, swingSide, hingeSide }), SLIDE);
        assert.equal(l.runPerpDir, swingOpenPerpDir(isVertical, hingeSide, swingSide, OpeningMechanism.SWING, entry));
      }
    }
  }
});

test('失敗側: 引き戸以外は layout null・cutSpan 恒等', () => {
  for (const m of [OpeningMechanism.SWING, OpeningMechanism.SLIDE_DOUBLE]) {
    assert.equal(outsetSlideLayout(op(), m), null);
    assert.deepEqual(openingCutSpan(op(), m), [1000, 2550]);
  }
});

test('失敗側: W ≤ 50・W 非有限は layout null・cutSpan 恒等（coord 非有限は null）', () => {
  for (const coord2 of [1000, 1050, 1020]) {
    assert.equal(outsetSlideLayout(op({ coord2 }), SLIDE), null);
    assert.deepEqual(openingCutSpan(op({ coord2 }), SLIDE), [1000, coord2]);
  }
  // 穴の幅＝DW−50（null 伝播。layout の cutLength と同じ値）
  assert.equal(slideClearWidth(1550), 750);
  assert.equal(slideClearWidth(1750), 850);
  assert.equal(slideClearWidth(50), null);
  assert.equal(slideClearWidth(NaN), null);
  assert.equal(outsetSlideLayout(op({ coord2: 1750 + 1000 }), SLIDE).cutLength, slideClearWidth(1750));
  assert.equal(slideDoorWidth(NaN), null);
  assert.equal(slideDoorWidth(Infinity), null);
  assert.equal(slideDoorWidth(50), null);
  assert.equal(slideDoorWidth(51), 50.5);
  assert.equal(outsetSlideLayout(op({ coord2: NaN }), SLIDE), null);
  assert.equal(outsetSlideLayout(op({ coord1: Infinity }), SLIDE), null);
  assert.equal(openingCutSpan(op({ coord2: NaN }), SLIDE), null);
  assert.equal(openingCutSpan(op({ coord1: undefined }), OpeningMechanism.SWING), null);
});

test('cutSpan: 引き戸は穴 cut（枠の外面まで J 広がる）を返す', () => {
  assert.deepEqual(openingCutSpan(op(), SLIDE), [1770, 2580]);
  assert.deepEqual(openingCutSpan(op({ coord1: 2550, coord2: 1000, hingeSide: 1 }), SLIDE), [970, 1780]);
});

test('tailSide: hingeSide 0・undefined・null は −1、±1 はそのまま', () => {
  assert.equal(slideTailSide({ hingeSide: 0 }), -1);
  assert.equal(slideTailSide({}), -1);
  assert.equal(slideTailSide({ hingeSide: null }), -1);
  assert.equal(slideTailSide({ hingeSide: 1 }), 1);
  assert.equal(slideTailSide({ hingeSide: -1 }), -1);
  assert.deepEqual(outsetSlideLayout(op({ hingeSide: undefined }), SLIDE).cut, [1770, 2580]);
});

test('runPerpDir: swingSide 0・undefined・null は 0（走る面が決まらない）', () => {
  assert.equal(outsetSlideLayout(op({ swingSide: 0 }), SLIDE).runPerpDir, 0);
  assert.equal(outsetSlideLayout(op({ swingSide: undefined }), SLIDE).runPerpDir, 0);
  assert.equal(outsetSlideLayout(op({ swingSide: null }), SLIDE).runPerpDir, 0);
});

test('runPerpDir: isVertical undefined は水平扱い', () => {
  assert.equal(outsetSlideLayout(op({ isVertical: undefined, swingSide: 1, hingeSide: -1 }), SLIDE).runPerpDir, 1);
});

test('失敗側: opening が null・undefined は null', () => {
  assert.equal(outsetSlideLayout(null, SLIDE), null);
  assert.equal(outsetSlideLayout(undefined, SLIDE), null);
  assert.equal(openingCutSpan(null, SLIDE), null);
  assert.equal(openingCutSpan(undefined, OpeningMechanism.SWING), null);
});

test('R12: host が外壁（isExteriorWall true）なら layout null・cutSpan は開口全幅（恒等）', () => {
  const o = op();
  assert.equal(outsetSlideLayout(o, SLIDE, { isExteriorWall: true }), null);
  assert.deepEqual(openingCutSpan(o, SLIDE, { isExteriorWall: true }), [1000, 2550]);
});

test('R12: host が内壁・null・undefined・省略なら従来どおり（穴 cut を返す）', () => {
  const o = op();
  for (const host of [{ isExteriorWall: false }, {}, null, undefined]) {
    assert.ok(outsetSlideLayout(o, SLIDE, host), `host=${JSON.stringify(host)}`);
    assert.deepEqual(openingCutSpan(o, SLIDE, host), [1770, 2580]);
  }
  assert.ok(outsetSlideLayout(o, SLIDE));
});

test('layout.recess: span は cut の隣から W+J まで（pull より J 外側へずれる）・perpSide は runPerpDir・depth は 50（SLIDE_OUTSET_RECESS_DEPTH_MM）', () => {
  const l = outsetSlideLayout(op(), SLIDE);
  assert.deepEqual(l.recess, { span: [970, 1770], perpSide: l.runPerpDir, depth: SLIDE_OUTSET_RECESS_DEPTH_MM });
  assert.equal(l.recess.depth, 50);
  const r = outsetSlideLayout(op({ hingeSide: 1 }), SLIDE);
  assert.deepEqual(r.recess.span, [1780, 2580], 'hingeSide +1 は引き代が hi 側');
  assert.equal(r.recess.perpSide, -l.recess.perpSide, '引き代の左右を替えると走る面（積）も替わる');
});

test('【失敗系】layout.recess: swingSide 0（走る面不定）・引き戸以外・host 外壁は null', () => {
  assert.equal(outsetSlideLayout(op({ swingSide: 0 }), SLIDE).recess, null);
  assert.equal(outsetSlideLayout(op({ swingSide: 0 }), SLIDE).runPerpDir, 0);
  assert.equal(outsetSlideLayout(op(), OpeningMechanism.SWING), null);
  assert.equal(outsetSlideLayout(op(), SLIDE, { isExteriorWall: true }), null);
});

test('slideRecessBand: perpSide +1 は大きい側の面から d 内側・−1 は小さい側の面から d 内側（位置をずらした壁 y 1000〜1150）', () => {
  const span = [1000, 1800];
  assert.deepEqual(slideRecessBand({ span, perpSide: 1, depth: 50 }, [1000, 1150]), { along: [1000, 1800], across: [1100, 1150] });
  assert.deepEqual(slideRecessBand({ span, perpSide: -1, depth: 50 }, [1000, 1150]), { along: [1000, 1800], across: [1000, 1050] });
  assert.deepEqual(slideRecessBand(outsetSlideLayout(op(), SLIDE).recess, [-75, 75]), { along: [970, 1770], across: [25, 75] }, 'layout 経由（swingSide 1・hingeSide −1・水平＝+側）');
});

test('【失敗系】slideRecessBand: 壁厚が d 以下（T3）・recess null・perpSide 0・faceRange 非有限は null', () => {
  const rec = { span: [1000, 1800], perpSide: 1, depth: 50 };
  assert.equal(slideRecessBand(rec, [1000, 1050]), null, '壁厚 50＝d');
  assert.equal(slideRecessBand(rec, [1000, 1025]), null, '壁厚 25<d');
  assert.ok(slideRecessBand(rec, [1000, 1050.5]), '壁厚が d を超えれば欠き込む');
  assert.equal(slideRecessBand(null, [1000, 1150]), null);
  assert.equal(slideRecessBand(undefined, [1000, 1150]), null);
  assert.equal(slideRecessBand({ ...rec, perpSide: 0 }, [1000, 1150]), null);
  assert.equal(slideRecessBand(rec, [NaN, 1150]), null);
  assert.equal(slideRecessBand(rec, [1000, Infinity]), null);
  assert.equal(slideRecessBand(rec, null), null);
  assert.equal(slideRecessBand(rec, undefined), null);
});

test('非整数 W でも DW の誤差は 1e-9 以下', () => {
  const l = outsetSlideLayout(op({ coord1: 1000.1, coord2: 2550.1 }), SLIDE);
  assert.ok(Math.abs(l.doorWidth - 800) < 1e-9);
});
