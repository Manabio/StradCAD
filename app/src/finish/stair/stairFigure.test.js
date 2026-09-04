// finish/stair/stairFigure.js（階段模式図プリミティブ生成）× structural/sectionFigure/
// svgFigureLineJoin.js（L字の角の外角閉じ。案2・第5弾＝SVGレンダラAutoScaledFigure.jsxへの適用）
// の実データ経路テスト。
//
// StairPanel.jsxは stairFigurePrimitives(stair, b, {...}) の戻り値を AutoScaledFigure へ渡す
// （AutoScaledFigure.jsxは resolveSvgFigureLinePoints(primitives, t) を呼ぶだけ——
// AutoScaledFigureLineJoin.test.jsと同じ本番関数を、ここでは実データに対して固定する）。
// 外形（width:1.5・破線なし）は直進階段の矩形4辺で、隣り合う辺の端点がmm厳密一致する角を持つ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType } from '@core';
import { stairFigurePrimitives } from './stairFigure.js';
import { resolveJoinedLinePoints, linePointsPx } from '../../renderer/figureLineJoin.js';
import { resolveSvgFigureLinePoints } from '../../structural/sectionFigure/svgFigureLineJoin.js';

const BOUNDS = { x1: 0, y1: 0, x2: 2000, y2: 4000 };
const idT = { tx: x => x, ty: y => y };

function straightStairPrimitives() {
  const stair = { type: StairType.STRAIGHT, upDirection: 'up', flip: false, tread: 250, totalSteps: 14, nosing: 20 };
  return stairFigurePrimitives(stair, BOUNDS, { riser: 180 });
}

test('直進階段の模式図: 外形（width:1.5・矩形4辺）の4角すべてが相手半幅0.75pxぶん閉じる', () => {
  const prims = straightStairPrimitives();
  const outline = prims.filter(p => p.type === 'line' && p.width === 1.5 && !p.dash);
  assert.equal(outline.length, 4, '直進階段の外形は矩形4辺のはず');

  const joined = resolveJoinedLinePoints(prims, idT); // AutoScaledFigure.jsxと同じくlineWeightsPxを渡さない
  assert.equal(joined.size, 4, '矩形4角すべてが対象になるはず');

  for (const p of outline) {
    const idx = prims.indexOf(p);
    const [rx1, ry1, rx2, ry2] = [p.x1, p.y1, p.x2, p.y2]; // raw（素のmm→px。idTなので数値も同じ）
    const [jx1, jy1, jx2, jy2] = linePointsPx(p, idx, idT, joined);
    // 各辺は両端とも隣接辺と直交して角を作るため、両端とも0.75pxぶん外側へ延びる
    // （相手幅=自分と同じ1.5px→相手半幅0.75px）。
    const d1 = Math.hypot(jx1 - rx1, jy1 - ry1);
    const d2 = Math.hypot(jx2 - rx2, jy2 - ry2);
    assert.ok(Math.abs(d1 - 0.75) < 1e-9, `始端の延長量が0.75pxのはず、実際${d1}`);
    assert.ok(Math.abs(d2 - 0.75) < 1e-9, `終端の延長量が0.75pxのはず、実際${d2}`);
  }
});

test('直進階段の模式図: 踏面線（width:1、外形との交点はT字接触）は座標不変', () => {
  const prims = straightStairPrimitives();
  const treads = prims.filter(p => p.type === 'line' && p.width === 1 && !p.dash);
  assert.ok(treads.length > 0, '踏面線が生成されているはず');

  const joined = resolveJoinedLinePoints(prims, idT);
  for (const p of treads) {
    const idx = prims.indexOf(p);
    assert.equal(joined.has(idx), false, '踏面線は角の対象にならず差分マップに載らないはず');
    const [jx1, jy1, jx2, jy2] = linePointsPx(p, idx, idT, joined);
    assert.equal(jx1, p.x1); assert.equal(jy1, p.y1);
    assert.equal(jx2, p.x2); assert.equal(jy2, p.y2);
  }
});

test('破線外形（dash指定）が混ざっても、破線側は延長しない（widthは階段の到達辺想定=1.5・dashed）', () => {
  // stairFigure.jsのoutline写像は s.dashed で dash:'dashed' を付けるが、stairGeometry.js の
  // seg() が常に dashed:false を返すため、現状どの view でも true にならない（outline[].dashed は
  // 将来の到達辺表現のための予約フィールド）。その実装時の防御として、ここでは直進階段の実データに
  // 人為的にdashedな外形辺を1本混ぜ、破線除外規則が実データ経路でも保たれることを固定する。
  const prims = straightStairPrimitives();
  const outline = prims.filter(p => p.type === 'line' && p.width === 1.5 && !p.dash);
  const target = outline[0];
  const dashedPrims = prims.map(p => (p === target ? { ...p, dash: 'dashed' } : p));
  const idx = prims.indexOf(target); // mapはindexを保つため、prims内のtarget位置とdashedPrims内の位置は一致する
  const joined = resolveJoinedLinePoints(dashedPrims, idT);
  assert.equal(joined.has(idx), false, '破線化した外形辺は差分マップに載らないはず');
});

test('resolveSvgFigureLinePoints: 実データでもprimitivesと1:1対応し、line以外はnull', () => {
  const prims = straightStairPrimitives();
  const result = resolveSvgFigureLinePoints(prims, idT);
  assert.equal(result.length, prims.length, '戻り値はprimitivesと同じ長さのはず');
  for (let i = 0; i < prims.length; i++) {
    if (prims[i].type === 'line') assert.ok(Array.isArray(result[i]), `index${i}はline: 配列のはず`);
    else assert.equal(result[i], null, `index${i}は${prims[i].type}: nullのはず`);
  }
  const outlineIdxs = prims.map((p, i) => (p.type === 'line' && p.width === 1.5 && !p.dash ? i : -1)).filter(i => i >= 0);
  assert.equal(outlineIdxs.length, 4, '直進階段の外形は矩形4辺のはず');
  for (const i of outlineIdxs) {
    const p = prims[i];
    const [jx1, jy1, jx2, jy2] = result[i];
    const d1 = Math.hypot(jx1 - p.x1, jy1 - p.y1);
    const d2 = Math.hypot(jx2 - p.x2, jy2 - p.y2);
    assert.ok(Math.abs(d1 - 0.75) < 1e-9, `始端の延長量が0.75pxのはず、実際${d1}`);
    assert.ok(Math.abs(d2 - 0.75) < 1e-9, `終端の延長量が0.75pxのはず、実際${d2}`);
  }
});

test('階段模式図: 延長対象は1.5px外形のみ。width<=1の線は全StairTypeで座標不変', () => {
  // 「見た目の効果は階段模式図の1.5px外形に限られる」という報告事実そのものを、
  // 全StairType（直進・踊場付直進・折返し・回り・矩折・曲がり・中空き）を回して固定する。
  // stair.sections未指定＝stairGeometry.jsのdefaultSections(stair)が totalSteps から
  // 各タイプの既定区間割りを合成する（stairLaneGap.test.js等と異なりsectionsを明示しない経路）。
  for (const type of Object.values(StairType)) {
    const stair = { type, upDirection: 'up', flip: false, tread: 250, totalSteps: 14, nosing: 20 };
    const bounds = { x1: 0, y1: 0, x2: 3000, y2: 5000 }; // 折返し・中空き等は2000×4000だと逃げが足りないため広めに取る
    const prims = stairFigurePrimitives(stair, bounds, { riser: 180 });
    // 本番の配線関数（resolveSvgFigureLinePoints）を通し、素の変換と異なる（＝延長された）index を集める。
    const result = resolveSvgFigureLinePoints(prims, idT);
    const extended = [];
    result.forEach((pts, idx) => {
      if (!pts) return;
      const p = prims[idx];
      const raw = [p.x1, p.y1, p.x2, p.y2];
      if (pts.some((v, k) => Math.abs(v - raw[k]) > 1e-9)) extended.push(idx);
    });
    assert.ok(extended.length > 0, `${type}: 1.5px外形の角が少なくとも1つは延長されるはず`);
    const widths = extended.map(idx => prims[idx].width);
    assert.deepEqual(widths.filter(w => w !== 1.5), [], `${type}: 延長された線はすべてwidth1.5のはず（実際${JSON.stringify(widths)}）`);
  }
});
