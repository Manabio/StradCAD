// 読込み後の初期表示（initialView.js・viewport.js fitScaleDenominator/fitToBounds・layout.js drawingAreaRect）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_FIT_SCALE_DENOMS, INITIAL_FIT_MARGIN_PX } from './core/constants.js';
import { INSET, drawingAreaRect } from './layout.js';
import { Viewport, fitScaleDenominator } from './viewport.js';
import { initialViewPlane, gridBoundsMm, fitViewportToInitialView } from './initialView.js';

const PX_PER_MM = 4; // 校正値（テスト用に丸い値）

function makeViewport() {
  const vp = new Viewport(1000, 800);
  vp.pxPerMmX = PX_PER_MM;
  vp.pxPerMmY = PX_PER_MM;
  return vp;
}

test('drawingAreaRect: INSET の内側（4 辺の内端オフセットぶん縮む）', () => {
  const r = drawingAreaRect({ width: 1000, height: 800 });
  assert.deepEqual(r, {
    x: INSET.left, y: INSET.top,
    width: 1000 - INSET.left - INSET.right, height: 800 - INSET.top - INSET.bottom,
  });
});

test('drawingAreaRect: 画面が INSET より小さくても幅・高さは負にならない', () => {
  const r = drawingAreaRect({ width: 10, height: 10 });
  assert.equal(r.width, 0);
  assert.equal(r.height, 0);
});

test('fitScaleDenominator: 余白込みで収まる最小の分母を候補の昇順から選ぶ', () => {
  // 10m×8m を 1000×800px に。pxPerMm=4: 1/50 → 800×640px（収まる）、1/30 → 1333px（収まらない）
  const bounds = { minX: 0, maxX: 10000, minY: 0, maxY: 8000 };
  assert.equal(fitScaleDenominator(bounds, { width: 1000, height: 800 }, PX_PER_MM, PX_PER_MM, INITIAL_FIT_SCALE_DENOMS, 0), 50);
  // 余白 100px を取ると 1/50 は横 800 > 800−200 で溢れ、1/100（400×320）になる
  assert.equal(fitScaleDenominator(bounds, { width: 1000, height: 800 }, PX_PER_MM, PX_PER_MM, INITIAL_FIT_SCALE_DENOMS, 100), 100);
});

test('fitScaleDenominator: 縦だけ溢れても次の分母へ進む（縦横の両方で判定）', () => {
  const bounds = { minX: 0, maxX: 1000, minY: 0, maxY: 8000 }; // 細長い
  // 1/20: 高さ 1600px > 800 → 1/30: 1067 → 1/50: 640 収まる
  assert.equal(fitScaleDenominator(bounds, { width: 1000, height: 800 }, PX_PER_MM, PX_PER_MM, INITIAL_FIT_SCALE_DENOMS, 0), 50);
});

test('fitScaleDenominator: どの候補でも収まらなければ最大の分母を返す', () => {
  const bounds = { minX: 0, maxX: 1_000_000, minY: 0, maxY: 1_000_000 };
  assert.equal(fitScaleDenominator(bounds, { width: 1000, height: 800 }, PX_PER_MM, PX_PER_MM, INITIAL_FIT_SCALE_DENOMS, 0), 1000);
});

test('fitScaleDenominator: 範囲が点（通り芯が各軸 1 本）なら最小の分母', () => {
  const bounds = { minX: 500, maxX: 500, minY: 0, maxY: 0 };
  assert.equal(fitScaleDenominator(bounds, { width: 1000, height: 800 }, PX_PER_MM, PX_PER_MM, INITIAL_FIT_SCALE_DENOMS, 0), INITIAL_FIT_SCALE_DENOMS[0]);
});

test('Viewport.fitToBounds: 範囲の中心が描画エリアの中心へ来て、縮尺分母は選んだ候補になる', () => {
  const vp = makeViewport();
  const bounds = { minX: 1000, maxX: 11000, minY: -2000, maxY: 6000 }; // 中心 (6000, 2000)
  const area = { x: 48, y: 88, width: 904, height: 656 };
  vp.fitToBounds(bounds, area, INITIAL_FIT_SCALE_DENOMS, INITIAL_FIT_MARGIN_PX);
  const c = vp.worldToScreen(6000, 2000);
  assert.ok(Math.abs(c.x - (area.x + area.width / 2)) < 1e-9, `cx=${c.x}`);
  assert.ok(Math.abs(c.y - (area.y + area.height / 2)) < 1e-9, `cy=${c.y}`);
  // 10m×8m・pxPerMm=4・余白 40: 1/50 は 800×640 ≤ (904−80)×(656−80)=824×576 → 高さが溢れて 1/100
  assert.equal(vp.scaleDenominator, 100);
  // 四隅が描画エリア（余白込み）の内側に入る
  for (const [x, y] of [[1000, -2000], [11000, 6000]]) {
    const s = vp.worldToScreen(x, y);
    assert.ok(s.x >= area.x + INITIAL_FIT_MARGIN_PX && s.x <= area.x + area.width - INITIAL_FIT_MARGIN_PX, `x=${s.x}`);
    assert.ok(s.y >= area.y + INITIAL_FIT_MARGIN_PX && s.y <= area.y + area.height - INITIAL_FIT_MARGIN_PX, `y=${s.y}`);
  }
});

test('Viewport.fitToBounds: 校正比率（pxPerMmX≠pxPerMmY）を維持する', () => {
  const vp = makeViewport();
  vp.pxPerMmY = 5;
  vp.fitToBounds({ minX: 0, maxX: 5000, minY: 0, maxY: 5000 }, { x: 0, y: 0, width: 1000, height: 1000 }, INITIAL_FIT_SCALE_DENOMS, 0);
  assert.ok(Math.abs(vp.scaleX / vp.scaleY - PX_PER_MM / 5) < 1e-12);
});

test('initialViewPlane: startFloor===1 の採用階、無ければ最下階、採用階が無ければ null', () => {
  const b1 = { id: 'b1', startFloor: -1 }, f1 = { id: 'f1', startFloor: 1 }, f2 = { id: 'f2', startFloor: 2 };
  assert.equal(initialViewPlane({ planes: [b1, f1, f2] }), f1);
  assert.equal(initialViewPlane({ planes: [f2, { id: 'f3', startFloor: 3 }] }), f2);
  assert.equal(initialViewPlane({ planes: [] }), null);
});

test('gridBoundsMm: gridXs/gridYs の値の最小・最大。片方の軸が空なら null', () => {
  const cl = v => ({ value: v });
  assert.deepEqual(gridBoundsMm({ gridXs: [cl(0), cl(9100), cl(-910)], gridYs: [cl(3640), cl(0)] }),
    { minX: -910, maxX: 9100, minY: 0, maxY: 3640 });
  assert.equal(gridBoundsMm({ gridXs: [cl(0)], gridYs: [] }), null);
  assert.equal(gridBoundsMm({ gridXs: [], gridYs: [cl(0)] }), null);
});

test('fitViewportToInitialView: 1階のグラフの通り芯範囲で合わせ、true を返す', () => {
  const cl = v => ({ value: v });
  const g1 = { gridXs: [cl(0), cl(10000)], gridYs: [cl(0), cl(8000)] };
  const g2 = { gridXs: [cl(0), cl(100000)], gridYs: [cl(0), cl(100000)] }; // 2階は無関係（倍率に影響しない）
  const project = {
    planes: [{ id: 'f1', startFloor: 1 }, { id: 'f2', startFloor: 2 }],
    graphMap: new Map([['f1', g1], ['f2', g2]]),
    activeGraph: g2,
  };
  const vp = makeViewport();
  assert.equal(fitViewportToInitialView(vp, project, { width: 1000, height: 800 }), true);
  const area = drawingAreaRect({ width: 1000, height: 800 });
  const c = vp.worldToScreen(5000, 4000);
  assert.ok(Math.abs(c.x - (area.x + area.width / 2)) < 1e-9);
  assert.ok(Math.abs(c.y - (area.y + area.height / 2)) < 1e-9);
  assert.equal(vp.scaleDenominator,
    fitScaleDenominator({ minX: 0, maxX: 10000, minY: 0, maxY: 8000 }, area, PX_PER_MM, PX_PER_MM, INITIAL_FIT_SCALE_DENOMS, INITIAL_FIT_MARGIN_PX));
});

test('fitViewportToInitialView: 通り芯の無い文書・採用階の無い project は viewport を変えず false', () => {
  const vp = makeViewport();
  const before = { scaleX: vp.scaleX, scaleY: vp.scaleY, offsetX: vp.offsetX, offsetY: vp.offsetY };
  const empty = { gridXs: [], gridYs: [] };
  assert.equal(fitViewportToInitialView(vp, { planes: [{ id: 'f1', startFloor: 1 }], graphMap: new Map([['f1', empty]]), activeGraph: empty }, { width: 1000, height: 800 }), false);
  assert.equal(fitViewportToInitialView(vp, { planes: [], graphMap: new Map(), activeGraph: undefined }, { width: 1000, height: 800 }), false);
  assert.deepEqual({ scaleX: vp.scaleX, scaleY: vp.scaleY, offsetX: vp.offsetX, offsetY: vp.offsetY }, before);
});
