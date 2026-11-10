// 外付け引き戸の純関数（slideOutset.js）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningMechanism, findCatalogEntry } from './openingCatalog.js';
import { swingOpenPerpDir } from './openingPlanSymbolGeometry.js';
import {
  isOutsetSlide, slideDoorWidth, slideTailSide, outsetSlideLayout, openingCutSpan,
} from './slideOutset.js';

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

test('layout: W1550・hingeSide −1 → doorWidth 800・cutLength 750・cut=[hi−750,hi]・pull=[lo,hi−750]', () => {
  const l = outsetSlideLayout(op(), SLIDE);
  assert.equal(l.doorWidth, 800);
  assert.equal(l.cutLength, 750);
  assert.equal(l.tailSide, -1);
  assert.deepEqual(l.cut, [1800, 2550]);
  assert.deepEqual(l.pull, [1000, 1800]);
});

test('layout: hingeSide +1 で左右が入れ替わる', () => {
  const l = outsetSlideLayout(op({ hingeSide: 1 }), SLIDE);
  assert.deepEqual(l.cut, [1000, 1750]);
  assert.deepEqual(l.pull, [1750, 2550]);
});

test('layout: coord1 > coord2 の順でも同じ', () => {
  assert.deepEqual(outsetSlideLayout(op({ coord1: 2550, coord2: 1000 }), SLIDE), outsetSlideLayout(op(), SLIDE));
});

test('layout: 奇数 W 1551 → doorWidth 800.5（裁定 R5 で 0.5 mm 許容）', () => {
  const l = outsetSlideLayout(op({ coord2: 2551 }), SLIDE);
  assert.equal(l.doorWidth, 800.5);
  assert.equal(l.cutLength, 750.5);
});

test('不変条件: cut と pull は [lo,hi] を隙間なく覆う', () => {
  for (const hingeSide of [-1, 1]) {
    for (const w of [100, 1550, 1551, 2000]) {
      const l = outsetSlideLayout(op({ hingeSide, coord2: 1000 + w }), SLIDE);
      assert.ok(l.cut[0] === l.pull[1] || l.cut[1] === l.pull[0]);
      assert.equal(Math.min(l.cut[0], l.pull[0]), 1000);
      assert.equal(Math.max(l.cut[1], l.pull[1]), 1000 + w);
      assert.equal((l.cut[1] - l.cut[0]) + (l.pull[1] - l.pull[0]), w);
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
  assert.equal(slideDoorWidth(NaN), null);
  assert.equal(slideDoorWidth(Infinity), null);
  assert.equal(slideDoorWidth(50), null);
  assert.equal(slideDoorWidth(51), 50.5);
  assert.equal(outsetSlideLayout(op({ coord2: NaN }), SLIDE), null);
  assert.equal(outsetSlideLayout(op({ coord1: Infinity }), SLIDE), null);
  assert.equal(openingCutSpan(op({ coord2: NaN }), SLIDE), null);
  assert.equal(openingCutSpan(op({ coord1: undefined }), OpeningMechanism.SWING), null);
});

test('cutSpan: 引き戸は穴 cut を返す', () => {
  assert.deepEqual(openingCutSpan(op(), SLIDE), [1800, 2550]);
  assert.deepEqual(openingCutSpan(op({ coord1: 2550, coord2: 1000, hingeSide: 1 }), SLIDE), [1000, 1750]);
});

test('tailSide: hingeSide 0・undefined・null は −1、±1 はそのまま', () => {
  assert.equal(slideTailSide({ hingeSide: 0 }), -1);
  assert.equal(slideTailSide({}), -1);
  assert.equal(slideTailSide({ hingeSide: null }), -1);
  assert.equal(slideTailSide({ hingeSide: 1 }), 1);
  assert.equal(slideTailSide({ hingeSide: -1 }), -1);
  assert.deepEqual(outsetSlideLayout(op({ hingeSide: undefined }), SLIDE).cut, [1800, 2550]);
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

test('非整数 W でも DW の誤差は 1e-9 以下', () => {
  const l = outsetSlideLayout(op({ coord1: 1000.1, coord2: 2550.1 }), SLIDE);
  assert.ok(Math.abs(l.doorWidth - 800) < 1e-9);
});
