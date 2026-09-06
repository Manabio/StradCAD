// 線の太さの解決（viewport.js）。
// 確定仕様2026-09: **線の太さの指定は実画面上の絶対太さ**であり、ズーム倍率の影響を受けない。
// どの描画モード（LOD）で描くかは倍率で変わるが、指定された太さ自体は変わらない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { LINE_WEIGHT_MM } from './core/constants.js';
import {
  resolveStrokeWidth, resolveLineWeightsPx, lineWeightPx, DEFAULT_PX_PER_MM,
} from './viewport.js';

const PX = resolveLineWeightsPx(DEFAULT_PX_PER_MM);

test('resolveLineWeightsPx: 4段階は常に1px以上の差で単調増加する', () => {
  for (const pxPerMm of [1, DEFAULT_PX_PER_MM, 11.6, 40]) {
    const w = resolveLineWeightsPx(pxPerMm);
    assert.ok(w.thin >= 1, `pxPerMm=${pxPerMm} thin>=1`);
    assert.ok(w.medium > w.thin, `pxPerMm=${pxPerMm} medium>thin`);
    assert.ok(w.thick > w.medium, `pxPerMm=${pxPerMm} thick>medium`);
    assert.ok(w.ultraThick > w.thick, `pxPerMm=${pxPerMm} ultraThick>thick`);
  }
});

test('lineWeightPx: 4段階の標準値は太さ表をそのまま引く（注記も壁も同じ太さになる）', () => {
  assert.equal(lineWeightPx(LINE_WEIGHT_MM.thin, PX), PX.thin);
  assert.equal(lineWeightPx(LINE_WEIGHT_MM.medium, PX), PX.medium);
  assert.equal(lineWeightPx(LINE_WEIGHT_MM.thick, PX), PX.thick);
  assert.equal(lineWeightPx(LINE_WEIGHT_MM.ultraThick, PX), PX.ultraThick);
});

test('lineWeightPx: 表に無いmm（旧データの0.15など）は表と同じ式で換算する', () => {
  assert.equal(lineWeightPx(0.15, PX, 40), Math.max(1, Math.round(0.15 * 40)));
  assert.equal(lineWeightPx(0.15, PX), Math.max(1, Math.round(0.15 * DEFAULT_PX_PER_MM)));
});

test('resolveStrokeWidth: 画面上の太さは指定pxちょうどで、ズーム倍率に依らない', () => {
  // ワールドGroup（scale継承）へ渡す値なので、Konvaが掛け直すscaleを掛けると実px値になる。
  for (const weight of Object.values(LINE_WEIGHT_MM)) {
    const expected = lineWeightPx(weight, PX);
    for (const scale of [0.0378, 0.063, 0.5, 3.78, 20]) {
      const w = resolveStrokeWidth(weight, scale, PX);
      assert.ok(Math.abs(w * scale - expected) < 1e-9,
        `weight=${weight} scale=${scale}: 期待${expected}px, 実際${w * scale}px`);
    }
  }
});

test('resolveStrokeWidth: 段の大小関係はどのズームでも保たれる（太線が中線より細くならない）', () => {
  for (const scale of [0.0378, 0.5, 20]) {
    const thin = resolveStrokeWidth(LINE_WEIGHT_MM.thin, scale, PX);
    const medium = resolveStrokeWidth(LINE_WEIGHT_MM.medium, scale, PX);
    const thick = resolveStrokeWidth(LINE_WEIGHT_MM.thick, scale, PX);
    assert.ok(medium > thin && thick > medium, `scale=${scale}`);
  }
});
