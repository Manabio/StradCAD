// structural/sectionFigure/svgFigureLineJoin.js（AutoScaledFigure.jsx＝SVGレンダラが実際に呼ぶ
// 配線関数。L字の角の外角を閉じる。renderer/figureLineJoin.js案2・第5弾）の回帰テスト。
//
// resolveSvgFigureLinePoints はAutoScaledFigure.jsxの本番呼び出し（`resolveSvgFigureLinePoints(
// primitives, t)`→`linePts[i]`）と同じ形で primitives⇄px座標 の配線判断（どの配列を渡すか・
// indexをどう引くか）を行う——figureLineJoin.js自体（resolveJoinedLinePoints/linePointsPx。
// 17本の既存テスト）は変更しない。内部でlineWeightsPxを渡さないため、SVG側がweight語彙を
// 解釈せずp.width??1を幅として使う（sectionGeometry.jsヘッダ規約）ことも同時に固定される。
//
// 実機で線幅1.5pxが使われるのはfinish/stair/stairFigure.js（階段模式図の外形）のみ（構造断面図の
// X線memberFigures.js:496-497は交差する2本の4端点が相異なりL字の角にならない）。したがって
// 本弾の見た目の効果は階段模式図に限られる——実データ経路のテストはfinish/stair/stairFigure.test.jsに置く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSvgFigureLinePoints } from './svgFigureLineJoin.js';

// 恒等変換（mm=px）。
const idT = { tx: x => x, ty: y => y };

test('resolveSvgFigureLinePoints: 戻り値はprimitivesと同じ長さ・並びで、typeがlineでなければnull', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 1.5 },
    { type: 'rect', x: 0, y: 0, w: 10, h: 10 },
    { type: 'text', x: 0, y: 0, text: 'x' },
  ];
  const result = resolveSvgFigureLinePoints(primitives, idT);
  assert.equal(result.length, 3);
  assert.equal(result[1], null);
  assert.equal(result[2], null);
  assert.ok(Array.isArray(result[0]));
});

test('resolveSvgFigureLinePoints（lineWeightsPx無し）: 1.5px×1.5pxの直交角は相手半幅0.75pxぶん閉じる（階段外形相当）', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 1.5 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 1.5 },
  ];
  const [a, b] = resolveSvgFigureLinePoints(primitives, idT);
  const [, , ax2, ay2] = a;
  assert.ok(Math.abs(ax2 - 100.75) < 1e-9, `期待100.75, 実際${ax2}`);
  assert.equal(ay2, 0);
  const [, by1] = b;
  assert.ok(Math.abs(by1 - -0.75) < 1e-9, `期待-0.75, 実際${by1}`);
});

test('resolveSvgFigureLinePoints: 1px×1px（width省略の既定）の直交角は延長せず素のmm→px変換のまま', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100 },
  ];
  const [a, b] = resolveSvgFigureLinePoints(primitives, idT);
  assert.deepEqual(a, [0, 0, 100, 0]);
  assert.deepEqual(b, [100, 0, 100, 100]);
});

test('resolveSvgFigureLinePoints: 1.5px×1pxの直交角は両方延長する（1.5px側+0.5px／1px側+0.75px）', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 1.5 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 1 },
  ];
  const [a, b] = resolveSvgFigureLinePoints(primitives, idT);
  const [, , ax2] = a;
  assert.ok(Math.abs(ax2 - 100.5) < 1e-9, `1.5px側は相手半幅0.5pxのはず、実際${ax2 - 100}`);
  const [, by1] = b;
  assert.ok(Math.abs(by1 - -0.75) < 1e-9, `1px側は相手半幅0.75pxのはず、実際${-by1}`);
});

test('resolveSvgFigureLinePoints: dash:"dashed"が絡む角は1.5px同士でも延長しない', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 1.5 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 1.5, dash: 'dashed' },
  ];
  const [a, b] = resolveSvgFigureLinePoints(primitives, idT);
  assert.deepEqual(a, [0, 0, 100, 0]);
  assert.deepEqual(b, [100, 0, 100, 100]);
});

test('resolveSvgFigureLinePoints: weight:"thick"はp.widthが無ければp.width??1のまま扱われ、weight語彙としては解釈されない', () => {
  // sectionGeometry.jsヘッダの規約そのものの検証: 内部でlineWeightsPxを渡さないため、
  // weight:'thick'を「太い線」として解釈しない（p.widthが無ければ既定1扱い）。
  // 直交角で「相手の半幅」＝自分の延長量になる非対称性を使い、weightが数値解釈されていないことを
  // 具体的な延長量の食い違いとして検出する（もしKonvaのようにlineWeightsPx.thick=3等で解釈されて
  // いたら、B側の延長量は0.5ではなく1.5になるはず）。
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'thick' }, // widthなし→SVGでは1扱い
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 5 },
  ];
  const [a, b] = resolveSvgFigureLinePoints(primitives, idT);
  const [, , ax2] = a;
  assert.ok(Math.abs(ax2 - 102.5) < 1e-9, `A(weight:thick)側は相手(width5)半幅2.5pxのはず、実際${ax2 - 100}`);
  const [, by1] = b;
  assert.ok(Math.abs(by1 - -0.5) < 1e-9,
    `B側はA(weight:thick)を幅1扱いした半幅0.5pxのはず（thick=3等で解釈されていれば-1.5になる）、実際${-by1}`);
});

test('resolveSvgFigureLinePoints: 角を作る2本（index0,1）はヒット値、孤立した1本（index2）は素のmm→px変換', () => {
  // 「差分マップに載る線はマップ値、載らない線は素の変換」という分岐を、手作りMapではなく
  // resolveJoinedLinePointsが実際に検出する角（1.5px×1.5px直交）で通す——手作りMapだとヒット
  // 分岐が実際の角検出ロジックを経由せず、配線側の変異（indexの取り違え等）を見逃す。
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 1.5 },      // index0: 角を作る
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 1.5 },  // index1: 角を作る
    { type: 'line', x1: 5, y1: 5, x2: 20, y2: 30, width: 1 },        // index2: 孤立（誰とも角を作らない）
  ];
  const [a, b, c] = resolveSvgFigureLinePoints(primitives, idT);
  assert.deepEqual(a, [0, 0, 100.75, 0], 'index0はヒットして相手半幅0.75px延長されているはず');
  assert.deepEqual(b, [100, -0.75, 100, 100], 'index1はヒットして相手半幅0.75px延長されているはず');
  assert.deepEqual(c, [5, 5, 20, 30], 'index2は角を作らないため素のmm→px変換のはず');
});
