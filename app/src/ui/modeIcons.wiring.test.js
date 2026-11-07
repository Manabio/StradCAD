// モードバーのアイコン化の配線不変条件。.jsx は node:test から単体 import できないため
// ソーステキスト検査で固定する（facadeModeWiring.test.js と同じ流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const barSrc = readSrc('ModeBar.jsx');
const iconSrc = readSrc('modeIcons.jsx');

const modeValues = [...barSrc.matchAll(/mode:\s*'([a-z]+)'/g)].map(m => m[1]);
const iconKeys = [...iconSrc.matchAll(/^\s*([a-z]+):\s+[A-Z][A-Za-z]+Icon,\s*$/gm)].map(m => m[1]);

test('【配線】modeIcons.jsx: MODE_ICONS は ModeBar.jsx の MODES の mode 値と1対1', () => {
  assert.ok(modeValues.length >= 4, 'ModeBar.jsx から mode 値を抽出できなかった');
  assert.deepEqual([...iconKeys].sort(), [...modeValues].sort());
});

test('【配線】modeIcons.jsx: アイコンに文字を入れない（<text> なし・SVG の中身は図形要素だけ）', () => {
  assert.doesNotMatch(iconSrc, /<text[\s>]/);
  const bodies = [...iconSrc.matchAll(/<svg[^>]*>([\s\S]*?)<\/svg>/g)].map(m => m[1]);
  assert.equal(bodies.length, iconKeys.length, 'アイコン1つにつき <svg> が1つ');
  for (const body of bodies) {
    const tags = [...body.matchAll(/<([a-zA-Z]+)[\s/>]/g)].map(m => m[1]);
    assert.ok(tags.length > 0);
    for (const t of tags) assert.ok(['path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'ellipse'].includes(t), `文字要素や未知の要素: <${t}>`);
  }
});

test('【配線】ModeBar.jsx: ボタンの中身は <ModeIcon mode={mode} />。label は title と aria-label に残す', () => {
  assert.match(barSrc, /^import \{ ModeIcon \} from '\.\/modeIcons\.jsx';\s*$/m);
  assert.match(iconSrc, /^export function ModeIcon\(\{ mode \}\) \{\s*$/m);
  assert.match(barSrc, /^\s*aria-label=\{label\}\s*$/m);
  assert.match(barSrc, /^\s*title=\{label\}\s*$/m);
  assert.match(barSrc, /^\s*<ModeIcon mode=\{mode\} \/>\s*$/m);
  assert.doesNotMatch(barSrc, /^\s*\{label\}\s*$/m, 'ボタンの中身に文字ラベルが残っている');
});
