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

// 裁定2026-10-06 項目4: 開口の縁の見上げ破線は廃止。縁の入力（prop・App の算出・トリム・dash）を持たない。
// 出現数0なので、コメントへ書いただけの残骸にも反応する（意図的に厳しい）。
test('【不変条件】開口の縁（見上げ破線）の配線が StairLayer・SceneLayers・App に残っていない', () => {
  const read = (p) => fs.readFileSync(path.resolve(import.meta.dirname, p), 'utf8');
  const count = (s, re) => (s.match(re) ?? []).length;
  assert.equal(count(src, /slabOpeningEdges|trimOpeningEdgesAgainstStair|stairUpperOpeningDashPx|upperOpeningDash|openingEdges/g), 0, 'StairLayer');
  assert.equal(count(read('SceneLayers.jsx'), /slabOpeningEdges|stairSlabOpeningEdges/g), 0, 'SceneLayers');
  assert.equal(count(read('../App.jsx'), /slabOpeningEdges|slabOpeningFrames|stairSlabOpeningEdges|upperSlabFrames/gi), 0, 'App');
});

// 破線は上り部分（install 側の破れ先 beyondLines）だけ。見下げの踏面線・外周線は stairLineRenderProps が実線で返す。
test('【不変条件】StairLayer の dash は beyondLines（downviewDash）と stairLineRenderProps の返り値だけが消費する', () => {
  assert.equal((src.match(/downviewDash/g) ?? []).length, 2, 'downviewDash の出現は定義とbeyondLinesの2つだけ');
  assert.match(src, /^\s*dash=\{downviewDash\}\s*$/m);
  assert.equal((src.match(/^\s*dash=\{p\.dash\}\s*$/gm) ?? []).length, 2, '踏面線・外周線は p.dash をそのまま渡す');
});

test('【不変条件】StairLayer は矢じり chevronPoints を ./chevron.js から import し、ローカル定義（function chevronPoints・CHEVRON_ANGLE）を持たない', () => {
  assert.match(src, /^import \{ chevronPoints \} from '\.\/chevron\.js';\s*$/m);
  assert.ok(!/function chevronPoints/.test(src), 'ローカル定義が残っている');
  assert.ok(!/CHEVRON_ANGLE/.test(src), '角度の定数が残っている');
  assert.match(src, /^\s*points=\{chevronPoints\(pts, px\(10\)\)\}\s*$/m);
});
