// StairLayer.jsx の配線不変条件。.jsx は node:test から単体 import できないためソース走査で固定する。
// 判断（upper エントリは表示中の階の壁で判定）は finish/stair/stairEntries.js にあり、
// ここは e.wallGraph を resolveStairSideLines の第4引数へ渡すだけであることを見る。
// 1行まるごと一致（m フラグ＋行頭行末アンカー）なので、行頭コメント・行末コメントには一致しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(import.meta.dirname, 'StairLayer.jsx'), 'utf8');

test('【不変条件】StairLayer は e.wallGraph を resolveStairSideLines の第4引数 { wallGraph } として渡す', () => {
  assert.ok(
    /^\s*const resolve = \(g\) => \(graph \? resolveStairSideLines\(stair, graph, g, \{ wallGraph \}\) : g\);\s*$/m.test(src),
    'resolve 行が見つからない',
  );
  assert.ok(
    /^\s*const \{ stair, bounds: b, riser, spans, view, graph, wallGraph \} = e;\s*$/m.test(src),
    'e から wallGraph を取り出す行が見つからない',
  );
});
