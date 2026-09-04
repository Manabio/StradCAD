// renderer/planLineJoin.js（figureLineJoin.jsのL字の角の外角閉じをpx往復込みで適用する共通処理。
// site/siteLineJoinPrimitives.js第2弾からの切り出し・第3弾）の回帰テスト。
// 統合テストは常に非恒等（offset/scale≠1）のfakeViewportを使う——往復判断自体が
// テストで守られていることを示すため（site/siteLineJoinPrimitives.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlanLinePointsMm, resolvePlanLinePointsMmScaledStroke } from './planLineJoin.js';

const WEIGHTS = { thin: 1, medium: 2, thick: 3, ultraThick: 4 };

function fakeViewport(scaleX, scaleY = scaleX, offsetX = 37, offsetY = -52) {
  return {
    scaleX, scaleY,
    worldToScreen: (x, y) => ({ x: x * scaleX + offsetX, y: y * scaleY + offsetY }),
    screenToWorld: (x, y) => ({ x: (x - offsetX) / scaleX, y: (y - offsetY) / scaleY }),
  };
}

test('直交に取り合う2本（medium×medium）の角が閉じる', () => {
  const prims = [
    { key: 'a', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'medium' },
    { key: 'b', x1: 100, y1: 0, x2: 100, y2: 100, weight: 'medium' },
  ];
  const vp = fakeViewport(0.0378);
  const resolved = resolvePlanLinePointsMm(prims, WEIGHTS, vp);
  const [, , ax2, ay2] = resolved.get('a').points;
  assert.ok(Math.abs(ax2 - 100) > 1e-6, '角の外側へ延びるはず');
  assert.ok(Math.abs(ay2 - 0) < 1e-6);
  assert.equal(resolved.get('a').width, 2);
  assert.equal(resolved.get('b').width, 2);
});

test('thin(踏面線)×medium(外周線)の角は両方延長する', () => {
  const prims = [
    { key: 'thinLine', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'thin' },
    { key: 'mediumLine', x1: 100, y1: 0, x2: 100, y2: 100, weight: 'medium' },
  ];
  const vp = fakeViewport(0.0378);
  const resolved = resolvePlanLinePointsMm(prims, WEIGHTS, vp);
  const [, , tx2] = resolved.get('thinLine').points;
  const [, my1] = resolved.get('mediumLine').points;
  assert.ok(Math.abs(tx2 - 100) > 1e-6, 'thin側も延長される');
  assert.ok(Math.abs(my1 - 0) > 1e-6, 'medium側も延長される');
});

test('thin×thinは延長しない（細線同士は対象外）', () => {
  const prims = [
    { key: 'a', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'thin' },
    { key: 'b', x1: 100, y1: 0, x2: 100, y2: 100, weight: 'thin' },
  ];
  const vp = fakeViewport(0.0378);
  const resolved = resolvePlanLinePointsMm(prims, WEIGHTS, vp);
  const [, , ax2, ay2] = resolved.get('a').points;
  assert.ok(Math.abs(ax2 - 100) < 1e-6);
  assert.ok(Math.abs(ay2 - 0) < 1e-6);
});

test('破線（dash指定あり）は対象外——端点座標は不変（roundtripのみ）', () => {
  const prims = [
    { key: 'a', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'medium', dash: [3, 3] },
    { key: 'b', x1: 100, y1: 0, x2: 100, y2: 100, weight: 'medium' },
  ];
  const vp = fakeViewport(0.0378);
  const resolved = resolvePlanLinePointsMm(prims, WEIGHTS, vp);
  const [, , ax2, ay2] = resolved.get('a').points;
  assert.ok(Math.abs(ax2 - 100) < 1e-6, '破線側は延長されない');
  assert.ok(Math.abs(ay2 - 0) < 1e-6);
  const [bx1, by1] = resolved.get('b').points;
  assert.ok(Math.abs(bx1 - 100) < 1e-6, '相手が破線なら自分も延長しない');
  assert.ok(Math.abs(by1 - 0) < 1e-6);
});

test('3本が集まる頂点は延長しない', () => {
  const prims = [
    { key: 'a', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'medium' },
    { key: 'b', x1: 100, y1: 0, x2: 100, y2: 100, weight: 'medium' },
    { key: 'c', x1: 100, y1: 0, x2: 200, y2: 0, weight: 'medium' },
  ];
  const vp = fakeViewport(0.0378);
  const resolved = resolvePlanLinePointsMm(prims, WEIGHTS, vp);
  for (const p of prims) {
    const [x1, y1, x2, y2] = resolved.get(p.key).points;
    assert.ok(Math.abs(x1 - p.x1) < 1e-6);
    assert.ok(Math.abs(y1 - p.y1) < 1e-6);
    assert.ok(Math.abs(x2 - p.x2) < 1e-6);
    assert.ok(Math.abs(y2 - p.y2) < 1e-6);
  }
});

test('ズーム非依存: 延長量(mm)×scaleはscaleが変わっても一定', () => {
  const prims = [
    { key: 'a', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'medium' },
    { key: 'b', x1: 100, y1: 0, x2: 100, y2: 100, weight: 'medium' },
  ];
  const results = [0.0378, 0.001].map(scale => {
    const resolved = resolvePlanLinePointsMm(prims, WEIGHTS, fakeViewport(scale));
    const [, , ax2] = resolved.get('a').points;
    return (ax2 - 100) * scale;
  });
  assert.ok(Math.abs(results[0] - results[1]) < 1e-9, `期待:一定, 実際:${results}`);
});

test('失敗系: 空配列 → 空Map', () => {
  assert.equal(resolvePlanLinePointsMm([], WEIGHTS, fakeViewport(0.0378)).size, 0);
});

test('失敗系: lineWeightsPxに該当キーなし → 例外にならず延長なし（widthはfallback既定1）', () => {
  const prims = [
    { key: 'a', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'medium' },
    { key: 'b', x1: 100, y1: 0, x2: 100, y2: 100, weight: 'medium' },
  ];
  assert.doesNotThrow(() => {
    const resolved = resolvePlanLinePointsMm(prims, {}, fakeViewport(0.0378));
    assert.equal(resolved.get('a').width, 1);
    const [, , ax2] = resolved.get('a').points;
    assert.ok(Math.abs(ax2 - 100) < 1e-6, 'thin(既定1)同士扱いのため延長なし');
  });
});

test('失敗系: 長さ0の線分 → 座標不変', () => {
  const prims = [{ key: 'z', x1: 50, y1: 50, x2: 50, y2: 50, weight: 'medium' }];
  const resolved = resolvePlanLinePointsMm(prims, WEIGHTS, fakeViewport(0.0378));
  const [x1, y1, x2, y2] = resolved.get('z').points;
  assert.ok(Math.abs(x1 - 50) < 1e-6);
  assert.ok(Math.abs(y1 - 50) < 1e-6);
  assert.ok(Math.abs(x2 - 50) < 1e-6);
  assert.ok(Math.abs(y2 - 50) < 1e-6);
});

// ---- resolvePlanLinePointsMmScaledStroke（strokeScaleEnabled未指定＝Group拡縮継承レイヤ向け姉妹関数。第6弾） ----
// widthは世界mm相当値（実pxではない）で渡す。往復（×scaleX→resolvePlanLinePointsMm→÷scaleX）を
// 通しても、延長量は「実px基準」で決まる（世界mm相当ぶんではない）ことを確認する。

test('世界mm相当widthを渡すと、延長量は実px基準で決まる（延長mm×scaleがscale∈{0.0378,0.001,20}で一定）', () => {
  const results = [0.0378, 0.001, 20].map(scaleX => {
    const vp = fakeViewport(scaleX);
    // width=3/scaleX（世界mm相当）は常に実3pxに相当する（Group拡縮継承の想定どおり）。
    const prims = [
      { key: 'a', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 / scaleX },
      { key: 'b', x1: 100, y1: 0, x2: 100, y2: 100, width: 3 / scaleX },
    ];
    const resolved = resolvePlanLinePointsMmScaledStroke(prims, vp);
    const [, , ax2] = resolved.get('a').points;
    return (ax2 - 100) * scaleX;
  });
  assert.ok(Math.abs(results[0] - results[1]) < 1e-9, `期待:一定, 実際:${results}`);
  assert.ok(Math.abs(results[0] - results[2]) < 1e-9, `期待:一定, 実際:${results}`);
});

// (v*s)/s === v は一般には1ULPずれ得るが、本番形状（width = thick/scaleX）では往復がビット一致する
// （QA実測: thick∈{3..12}×scaleX∈[0.001,20] の200万点で不一致0）。ここでは本番形状で固定する。
test('返り値widthは本番形状（thick/scaleX）で往復ビット一致し、非等方ズームでもscaleX基準', () => {
  for (const [sx, sy] of [[2.6, 2.6], [0.0378, 0.05]]) {
    const vp = fakeViewport(sx, sy);
    const width = 3 / vp.scaleX;
    const prims = [
      { key: 'a', x1: 0, y1: 0, x2: 100, y2: 0, width },
      { key: 'b', x1: 100, y1: 0, x2: 100, y2: 100, width },
    ];
    const resolved = resolvePlanLinePointsMmScaledStroke(prims, vp);
    assert.equal(resolved.get('a').width, width, `scale=${sx}/${sy}`);
    assert.equal(resolved.get('b').width, width, `scale=${sx}/${sy}`);
  }
});

test('実px関数(resolvePlanLinePointsMm)との等価性: width×scaleXを実px関数へ渡した結果とpointsが一致する', () => {
  const vp = fakeViewport(2.6);
  const prims = [
    { key: 'a', x1: 0, y1: 0, x2: 100, y2: 0, width: 5 },
    { key: 'b', x1: 100, y1: 0, x2: 100, y2: 100, width: 7 },
  ];
  const scaled = resolvePlanLinePointsMmScaledStroke(prims, vp);
  const scaledPrims = prims.map(p => ({ ...p, width: p.width * vp.scaleX }));
  const rawPx = resolvePlanLinePointsMm(scaledPrims, undefined, vp);
  for (const p of prims) {
    assert.deepEqual(scaled.get(p.key).points, rawPx.get(p.key).points);
  }
});

test('失敗系(ScaledStroke): 空配列 → 空Map', () => {
  assert.equal(resolvePlanLinePointsMmScaledStroke([], fakeViewport(0.0378)).size, 0);
});
