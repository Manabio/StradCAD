// planCrossSplit.js（階段吹抜けの×を階段下の部屋で分割する）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCrossRects } from './planCrossSplit.js';

const r = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const hull = rs => r(Math.min(...rs.map(a => a.x1)), Math.min(...rs.map(a => a.y1)), Math.max(...rs.map(a => a.x2)), Math.max(...rs.map(a => a.y2)));
// 壁の面 = CL 値から 57.5 内側（innerRect の簡易合成）
const innerOf = c => r(c.x1 + 57.5, c.y1 + 57.5, c.x2 - 57.5, c.y2 - 57.5);

// 13.stq 相当: 踊り場 X-3000..0 × Y-7000..-6000、復路 X-3000..-1500 × Y-6000..-3500、往路 X-1500..0 × Y-6000..-3500
const landing = r(-3000, -7000, 0, -6000);
const back = r(-3000, -6000, -1500, -3500);
const fore = r(-1500, -6000, 0, -3500);
const group13 = { cellRects: [landing, back, fore], cellRect: hull([landing, back, fore]) };
group13.innerRect = r(-2942.5, -6942.5, -57.5, -3557.5);

test('13 相当: 復路の下の部屋を除くと 踊り場＋往路 の 2 矩形（内側の辺は CL 値・外周は壁の面）', () => {
  const out = splitCrossRects({ ...group13, coverRects: [back] });
  assert.deepEqual(out, [r(-2942.5, -6942.5, -57.5, -6000), r(-1500, -6000, -57.5, -3557.5)]);
});

test('覆いなし: innerRect 1 枚（従来どおり）', () => {
  assert.deepEqual(splitCrossRects({ ...group13, coverRects: [] }), [group13.innerRect]);
  assert.deepEqual(splitCrossRects({ ...group13, coverRects: undefined }), [group13.innerRect]);
  assert.deepEqual(splitCrossRects({ ...group13, coverRects: [r(5000, 5000, 6000, 6000)] }), [group13.innerRect], '重ならない覆い');
});

test('全部覆われる: []', () => {
  assert.deepEqual(splitCrossRects({ ...group13, coverRects: [hull([landing, back, fore])] }), []);
});

test('L 字の根元: 踊り場が 2 セルで根元セルが往路（縦）と踊り場（横）の両方に入る → 大きい縦の群へ吸収', () => {
  const a = r(-3000, -7000, -1500, -6000), b = r(-1500, -7000, 0, -6000);
  const cells = [a, b, back, fore];
  const cellRect = hull(cells);
  const out = splitCrossRects({ cellRects: cells, coverRects: [back], cellRect, innerRect: innerOf(cellRect) });
  // a は単独、b＋往路は縦に結合（x -1500..0 × y -7000..-3500）
  assert.deepEqual(out, [r(-2942.5, -6942.5, -1500, -6000), r(-1500, -6942.5, -57.5, -3557.5)]);
});

test('L 字の根元: 横の群が大きければ横へ吸収', () => {
  const a = r(0, 0, 3000, 1000), b = r(3000, 0, 4000, 1000), c = r(3000, 1000, 4000, 3000), d = r(0, 1000, 3000, 3000);
  const cellRect = hull([a, b, c, d]);
  const out = splitCrossRects({ cellRects: [a, b, c, d], coverRects: [d], cellRect, innerRect: innerOf(cellRect) });
  // 横 {a,b}=4M・縦 {b,c}=3M → b は横。c は単独
  assert.deepEqual(out, [r(57.5, 57.5, 3942.5, 1000), r(3000, 1000, 3942.5, 2942.5)]);
});

test('同面積は横の群', () => {
  const a = r(0, 0, 1000, 1000), b = r(1000, 0, 2000, 1000), c = r(1000, 1000, 2000, 2000), d = r(0, 1000, 1000, 2000);
  // a-b が横、b-c が縦、b は両方に入り面積 2M 対 2M の同面積 → 横（a+b）。c は単独
  const cellRect = hull([a, b, c, d]);
  const out = splitCrossRects({ cellRects: [a, b, c, d], coverRects: [d], cellRect, innerRect: r(0, 0, 2000, 2000) });
  assert.deepEqual(out, [r(0, 0, 2000, 1000), r(1000, 1000, 2000, 2000)]);
});

test('自階のセルが上階より細かい: 部分的に覆われた片だけ残る', () => {
  const cell = r(0, 0, 3000, 2000);
  const covers = [r(0, 0, 1000, 2000), r(1000, 0, 2000, 1000)]; // 左 1/3 と中央の上半分
  const out = splitCrossRects({ cellRects: [cell], coverRects: covers, cellRect: cell, innerRect: r(10, 10, 2990, 1990) });
  assert.deepEqual(out, [r(2000, 10, 2990, 1000), r(1000, 1000, 2990, 1990)]);
});

test('失敗系: innerRect が非有限・無い → []。cellRects が空・非有限のみ → innerRect。退化片は捨てる', () => {
  assert.deepEqual(splitCrossRects({ cellRects: [landing], coverRects: [], cellRect: landing, innerRect: r(NaN, 0, 1, 1) }), []);
  assert.deepEqual(splitCrossRects({}), []);
  assert.deepEqual(splitCrossRects({ cellRects: [], coverRects: [back], cellRect: landing, innerRect: landing }), [landing]);
  assert.deepEqual(splitCrossRects({ cellRects: [r(NaN, 0, 1, 1)], coverRects: [], cellRect: landing, innerRect: landing }), [landing]);
  // 退化矩形（幅 0）のセルは無視
  assert.deepEqual(splitCrossRects({ cellRects: [r(0, 0, 0, 100)], coverRects: [], cellRect: landing, innerRect: landing }), [landing]);
});

test('併合パス: 3×2 の右列を覆った残り 2×2 は 1 矩形。13 相当の L は 2 矩形のまま', () => {
  const cells = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) cells.push(r(i * 1000, j * 1000, (i + 1) * 1000, (j + 1) * 1000));
  const cellRect = r(0, 0, 3000, 2000);
  const cover = r(2000, 0, 3000, 2000);
  assert.deepEqual(splitCrossRects({ cellRects: cells, coverRects: [cover], cellRect, innerRect: cellRect }), [r(0, 0, 2000, 2000)]);
  assert.equal(splitCrossRects({ ...group13, coverRects: [back] }).length, 2);
});

test('T 字の根元: 横 3 片の中央が縦の群（大きい）へ → 左・右・縦の 3 矩形', () => {
  const L = r(0, 0, 1000, 1000), M = r(1000, 0, 2000, 1000), Rr = r(2000, 0, 3000, 1000), B = r(1000, 1000, 2000, 4000);
  const lo1 = r(0, 1000, 1000, 4000), lo2 = r(2000, 1000, 3000, 4000);
  const cellRect = r(0, 0, 3000, 4000);
  const out = splitCrossRects({ cellRects: [L, M, Rr, B, lo1, lo2], coverRects: [lo1, lo2], cellRect, innerRect: cellRect });
  assert.deepEqual(out, [r(0, 0, 1000, 1000), r(2000, 0, 3000, 1000), r(1000, 0, 2000, 4000)].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1));
});

test('細い矩形(幅・高さ < 150)は捨てる: 外周から 60mm だけ残る片は捨て、1442.5 幅は残る', () => {
  const cell = r(0, 0, 1000, 1000);
  assert.deepEqual(splitCrossRects({ cellRects: [cell], coverRects: [r(0, 0, 940, 1000)], cellRect: cell, innerRect: cell }), []);
  const wide = r(0, 0, 3000, 1000);
  assert.deepEqual(splitCrossRects({ cellRects: [wide], coverRects: [r(0, 0, 1557.5, 1000)], cellRect: wide, innerRect: wide }), [r(1557.5, 0, 3000, 1000)]);
  assert.deepEqual(splitCrossRects({ cellRects: [cell], coverRects: [r(0, 0, 1000, 940)], cellRect: cell, innerRect: cell }), [], '高さ 60 も捨てる');
});

test('極小の覆い: 3mm² は innerRect 1 枚・6mm² は分割', () => {
  const cell = r(0, 0, 1000, 1000);
  assert.deepEqual(splitCrossRects({ cellRects: [cell], coverRects: [r(0, 0, 1, 3)], cellRect: cell, innerRect: cell }), [cell]);
  // 分割経路に入る（細い片 高さ 3 は捨てられ、残りの辺は CL 値 y=3 のまま＝innerRect とは別物）
  assert.deepEqual(splitCrossRects({ cellRects: [cell], coverRects: [r(0, 0, 2, 3)], cellRect: cell, innerRect: cell }), [r(0, 3, 1000, 1000)]);
});
