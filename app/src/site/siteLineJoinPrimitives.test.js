// siteLineJoinPrimitives.js（敷地モード線→figureLineJoin.js primitives写像・世界mm解決）の
// 回帰テスト。resolveSiteLinePointsMm は「実スクリーンpxへ持ち上げてjoinし、世界mmへ戻す」
// 往復をviewportLike（duck-type。store.js/appViewportは静的importしない）経由で行う——
// この往復自体がテストで守られていることを示すため、統合テストは常に非恒等（offset/scale≠1）の
// fakeViewportを使う（idT等の恒等変換だけで検証すると、往復判断が丸ごと欠落しても検出できない）。
// 幅・dash の規則は site/siteLineStyle.js: 外周=中線の一点鎖線（選択 thick）／内側=細線の実線（選択 medium）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSiteLinesToJoinPrimitives, resolveSiteLinePointsMm } from './siteLineJoinPrimitives.js';
import { SITE_BOUNDARY_DASH } from './siteLineStyle.js';
import { resolveJoinedLinePoints, linePointsPx } from '../renderer/figureLineJoin.js';

// THIN_PX(=1)を超える細線幅にして、内側の細線どうしのjoinが効くことを検証できるようにする。
const WEIGHTS = { thin: 2, medium: 3, thick: 4 };
const NO_OUTER = new Set();

// site.lines を模した最小限のオブジェクト（SitePoint/SiteLineのmobx部分には依存しない）。
function line(id, x1, y1, x2, y2) {
  return { id, startPoint: { id: `${id}-s`, x: x1, y: y1 }, endPoint: { id: `${id}-e`, x: x2, y: y2 } };
}

// viewport.js の worldToScreen/screenToWorld と同じ式のduck-type実装（非恒等・非0オフセット）。
function fakeViewport(scaleX, scaleY = scaleX, offsetX = 37, offsetY = -52) {
  return {
    worldToScreen: (x, y) => ({ x: x * scaleX + offsetX, y: y * scaleY + offsetY }),
    screenToWorld: (x, y) => ({ x: (x - offsetX) / scaleX, y: (y - offsetY) / scaleY }),
  };
}

test('mapSiteLinesToJoinPrimitives: 内側の線は非選択=thin・選択=mediumの実線（dashなし）で写像される', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const prims = mapSiteLinesToJoinPrimitives(lines, 'b', WEIGHTS, NO_OUTER);
  assert.equal(prims.length, 2);
  for (const p of prims) {
    assert.equal(p.type, 'line');
    assert.equal(p.dash, undefined);
  }
  assert.equal(prims[0].width, 2, '非選択の内側=thin');
  assert.equal(prims[1].width, 3, '選択中の内側=medium');
});

test('mapSiteLinesToJoinPrimitives: 外周の線は非選択=medium・選択=thickで、一点鎖線dashが付く', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const prims = mapSiteLinesToJoinPrimitives(lines, 'b', WEIGHTS, new Set(['a', 'b']));
  assert.equal(prims[0].width, 3, '非選択の外周=medium');
  assert.equal(prims[1].width, 4, '選択中の外周=thick');
  assert.deepEqual([...prims[0].dash], [40, 4, 2, 4]);
  assert.equal(prims[0].dash, SITE_BOUNDARY_DASH);
  assert.equal(prims[1].dash, SITE_BOUNDARY_DASH);
});

test('mapSiteLinesToJoinPrimitives: 外周と内側が混在すると線ごとに幅・dashが分かれる', () => {
  const lines = [line('outer', 0, 0, 100, 0), line('inner', 100, 0, 100, 100)];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS, new Set(['outer']));
  assert.equal(prims[0].width, 3);
  assert.ok(prims[0].dash);
  assert.equal(prims[1].width, 2);
  assert.equal(prims[1].dash, undefined);
});

test('mapSiteLinesToJoinPrimitives: lines配列に無い要素（三斜バッジ・プレビュー線等）は入力チャネルが無く出力に混入しない', () => {
  // site.triangleMap や mode.siteDrawState はこの関数の引数に存在しないため、
  // 呼び出し側が誤って混ぜない限り出力はlinesと1:1の長さを超えない。
  const lines = [line('a', 0, 0, 100, 0)];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS, NO_OUTER);
  assert.equal(prims.length, 1);
});

test('mapSiteLinesToJoinPrimitives: 同じPointを共有する2線の端点は同値になる（mm厳密一致の前提）', () => {
  const shared = { id: 'p1', x: 100, y: 0 };
  const lines = [
    { id: 'a', startPoint: { id: 'p0', x: 0, y: 0 }, endPoint: shared },
    { id: 'b', startPoint: shared, endPoint: { id: 'p2', x: 100, y: 100 } },
  ];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS, NO_OUTER);
  assert.equal(prims[0].x2, prims[1].x1);
  assert.equal(prims[0].y2, prims[1].y1);
});

// ---- 純粋な角度式の検証（figureLineJoin.js単体。恒等変換で式そのものを確認する） ----

const idT = { tx: x => x, ty: y => y };

test('mapPrimitives→resolveJoinedLinePoints→linePointsPx: 直交に取り合う2本の内側の線（同太さthin）は式どおり角の外側へ延びる', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS, NO_OUTER);
  const joined = resolveJoinedLinePoints(prims, idT, WEIGHTS);
  const [, , ax2, ay2] = linePointsPx(prims[0], 0, idT, joined);
  assert.ok(Math.abs(ax2 - 101) < 1e-9, `期待101, 実際${ax2}`); // 相手半幅thin/2=1px
  assert.equal(ay2, 0);
  const [bx1, by1] = linePointsPx(prims[1], 1, idT, joined);
  assert.equal(bx1, 100);
  assert.ok(Math.abs(by1 - -1) < 1e-9, `期待-1, 実際${by1}`);
});

test('mapPrimitives→resolveJoinedLinePoints: 外周の一点鎖線どうしはdash付きでjoin対象外（延長なし）', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS, new Set(['a', 'b']));
  const joined = resolveJoinedLinePoints(prims, idT, WEIGHTS);
  assert.equal(joined.size, 0);
});

test('mapPrimitives→resolveJoinedLinePoints: 3本が集まる頂点では何もしない', () => {
  const lines = [
    line('a', 0, 0, 100, 0),
    line('b', 100, 0, 100, 100),
    line('c', 100, 0, 200, 0),
  ];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS, NO_OUTER);
  const joined = resolveJoinedLinePoints(prims, idT, WEIGHTS);
  assert.equal(joined.size, 0);
});

// ---- resolveSiteLinePointsMm（最終出力レベル）の統合テスト ----
// すべて非恒等fakeViewport（offset≠0）を使う——SiteLinesLayer.jsxがscreenT/screenToWorldの
// 往復を実際に行っているかを検証するため（恒等変換の変異が赤化することをこのテストで示す）。

test('resolveSiteLinePointsMm: ズーム非依存——延長量(mm)×scaleは異なるscaleでも常に1px相当（内側thin）', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  for (const scale of [0.0378, 0.001]) {
    const vp = fakeViewport(scale);
    const resolved = resolveSiteLinePointsMm(lines, null, WEIGHTS, NO_OUTER, vp);
    const [ax1, ay1, ax2, ay2] = resolved.get('a').points;
    assert.ok(Math.abs(ax1 - 0) < 1e-6); assert.ok(Math.abs(ay1 - 0) < 1e-6); // 他端は不変
    const extendMmA = ax2 - 100;
    assert.ok(Math.abs(extendMmA * scale - 1) < 1e-9,
      `scale=${scale}: 期待1px, 実際${extendMmA * scale}px`);
    assert.ok(Math.abs(ay2 - 0) < 1e-6);

    const [bx1, by1, bx2, by2] = resolved.get('b').points;
    const extendMmB = by1 - 0;
    assert.ok(Math.abs(extendMmB * scale - -1) < 1e-9,
      `scale=${scale}: 期待-1px, 実際${extendMmB * scale}px`);
    assert.ok(Math.abs(bx1 - 100) < 1e-6);
    assert.ok(Math.abs(bx2 - 100) < 1e-6); assert.ok(Math.abs(by2 - 100) < 1e-6); // 他端は不変

    assert.equal(resolved.get('a').width, 2);
    assert.equal(resolved.get('b').width, 2);
    assert.equal(resolved.get('a').dash, undefined);
  }
});

test('resolveSiteLinePointsMm: 延長が入らない線（3本集合の頂点）は全座標がモデル値と一致する', () => {
  const lines = [
    line('a', 0, 0, 100, 0),
    line('b', 100, 0, 100, 100),
    line('c', 100, 0, 200, 0),
  ];
  const vp = fakeViewport(0.0378, 0.0378, 37, -52);
  const resolved = resolveSiteLinePointsMm(lines, null, WEIGHTS, NO_OUTER, vp);
  for (const l of lines) {
    const [x1, y1, x2, y2] = resolved.get(l.id).points;
    assert.ok(Math.abs(x1 - l.startPoint.x) < 1e-6, `${l.id}.x1: 期待${l.startPoint.x}, 実際${x1}`);
    assert.ok(Math.abs(y1 - l.startPoint.y) < 1e-6, `${l.id}.y1: 期待${l.startPoint.y}, 実際${y1}`);
    assert.ok(Math.abs(x2 - l.endPoint.x) < 1e-6, `${l.id}.x2: 期待${l.endPoint.x}, 実際${x2}`);
    assert.ok(Math.abs(y2 - l.endPoint.y) < 1e-6, `${l.id}.y2: 期待${l.endPoint.y}, 実際${y2}`);
  }
});

test('resolveSiteLinePointsMm: 不等倍(scaleX=0.05,scaleY=0.03)でも延長はpx基準——水平・垂直とも1px、mmでは非対称', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const vp = fakeViewport(0.05, 0.03);
  const resolved = resolveSiteLinePointsMm(lines, null, WEIGHTS, NO_OUTER, vp);
  const [, , ax2] = resolved.get('a').points; // 水平線は x方向にscaleX基準で延びる
  const extendMmA = ax2 - 100;
  assert.ok(Math.abs(extendMmA * 0.05 - 1) < 1e-9, `期待1px, 実際${extendMmA * 0.05}px`);
  const [, by1] = resolved.get('b').points; // 垂直線は y方向にscaleY基準で延びる
  const extendMmB = by1 - 0;
  assert.ok(Math.abs(extendMmB * 0.03 - -1) < 1e-9, `期待-1px, 実際${extendMmB * 0.03}px`);
  assert.notEqual(Math.abs(extendMmA), Math.abs(extendMmB), 'mm換算では不等倍のため非対称になるはず');
});

test('resolveSiteLinePointsMm【失敗系】: lineWeightsPx={}でも例外にならず延長なし（幅はNaN/undefinedにならない）', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const vp = fakeViewport(0.0378);
  assert.doesNotThrow(() => {
    const resolved = resolveSiteLinePointsMm(lines, null, {}, NO_OUTER, vp);
    const [, , ax2, ay2] = resolved.get('a').points;
    assert.ok(Math.abs(ax2 - 100) < 1e-6); // 延長なし
    assert.ok(Math.abs(ay2 - 0) < 1e-6);
  });
});

// 幅・dash の唯一の供給源は resolveSiteLinePointsMm の返り値（.jsx はそれを strokeWidth/dash にするだけ）。
// 最終出力レベルで選択線の幅・dashと、異太さの角の非対称な延長を固定する（写像レベルだけだと
// 返り値の width を固定にする変異が素通りする——QA指摘）。
test('resolveSiteLinePointsMm: 内側の選択線はmedium幅で返り、角は異太さの式どおり非対称に延びる', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const scale = 0.0378;
  const resolved = resolveSiteLinePointsMm(lines, 'b', WEIGHTS, NO_OUTER, fakeViewport(scale));
  assert.equal(resolved.get('b').width, 3, '選択線(内側)はmedium');
  assert.equal(resolved.get('a').width, 2, '非選択線(内側)はthin');
  const a = resolved.get('a').points, b = resolved.get('b').points;
  // a（thin 2px）は相手＝選択線の半幅 3/2=1.5px ぶん、b（medium 3px）は相手＝非選択線の半幅 2/2=1.0px ぶん延びる
  assert.ok(Math.abs((a[2] - 100) * scale - 1.5) < 1e-9, `aの延長は1.5pxのはず（実際:${(a[2] - 100) * scale}）`);
  assert.ok(Math.abs(b[1] * scale - (-1.0)) < 1e-9, `bの延長は1.0px（角の外側＝y負方向）のはず（実際:${b[1] * scale}）`);
});

test('resolveSiteLinePointsMm: 外周はmedium（選択thick）の一点鎖線dashで返り、角の延長は入らない', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const outer = new Set(['a', 'b']);
  const resolved = resolveSiteLinePointsMm(lines, 'b', WEIGHTS, outer, fakeViewport(0.0378));
  assert.equal(resolved.get('a').width, 3, '非選択の外周=medium');
  assert.equal(resolved.get('b').width, 4, '選択中の外周=thick');
  assert.deepEqual([...resolved.get('a').dash], [40, 4, 2, 4]);
  assert.deepEqual([...resolved.get('b').dash], [40, 4, 2, 4]);
  const [, , ax2] = resolved.get('a').points;
  assert.ok(Math.abs(ax2 - 100) < 1e-6, 'dash付きはjoin対象外＝延長なし');
});

test('resolveSiteLinePointsMm【失敗系】: site.lines空→空Map／存在しないselectedLineId→全線非選択幅／長さ0→座標不変', () => {
  const vp = fakeViewport(0.0378);
  assert.equal(resolveSiteLinePointsMm([], null, WEIGHTS, NO_OUTER, vp).size, 0);

  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const resolved = resolveSiteLinePointsMm(lines, 'no-such-id', WEIGHTS, NO_OUTER, vp);
  assert.equal(resolved.get('a').width, 2);
  assert.equal(resolved.get('b').width, 2);

  const zeroLen = [line('z', 50, 50, 50, 50)];
  const resolvedZero = resolveSiteLinePointsMm(zeroLen, null, WEIGHTS, NO_OUTER, vp);
  const [zx1, zy1, zx2, zy2] = resolvedZero.get('z').points;
  assert.ok(Math.abs(zx1 - 50) < 1e-6); assert.ok(Math.abs(zy1 - 50) < 1e-6);
  assert.ok(Math.abs(zx2 - 50) < 1e-6); assert.ok(Math.abs(zy2 - 50) < 1e-6);
});
