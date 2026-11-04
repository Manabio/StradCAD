// AutoScaledFigure.jsx の配線の不変条件: 縦寸法の値（labelVertical）は -90 度回し、寸法線の左右へ置く。
// 部分詳細図ヘルパーのプレビュー（縦の寸法値は「左を上」＝下から上へ読む）。labelVertical を渡さない寸法は従来の式のまま。
// .jsx は node:test から import できないため、ソース文字列をコメント除去のうえ検査する（team-lessons の流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(import.meta.dirname, 'AutoScaledFigure.jsx'), 'utf8').replace(/\r\n/g, '\n');

function stripCommentLines(text) {
  return text.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

function bodyOf(text, startMark, endMark) {
  const start = text.indexOf(startMark);
  assert.ok(start >= 0, `${startMark} が見つからない`);
  const end = text.indexOf(endMark, start);
  assert.ok(end > start, `${endMark} が見つからない`);
  return text.slice(start, end);
}

const editable = src => bodyOf(stripCommentLines(src), 'function EditableDimLabel', '  return (');
const staticDim = src => bodyOf(stripCommentLines(src), 'const vlx =', 'return (');

// 回転ラベルの式は続く「: isH ?」まで固定する（末尾に項を足されると偽）
const ROTATED_PX = /const px = \(rotated \? t\.tx\(dim\.at\) \+ \(labelLeft \? -\(6 \+ 8\) : 6 \+ 8\)\n\s*: isH \?/;
const ROTATED_PY = /const py = \(rotated \? t\.ty\(\(dim\.from \+ dim\.to\) \/ 2\)\n\s*: isH \?/;
const ROTATED_TF = /const transform = rotated \? 'translate\(-50%, -50%\) rotate\(-90deg\)'/;
const OLD_V = /t\.tx\(dim\.at\) \+ \(labelLeft \? -6 : 6\)\) \+ ldx;/;

test('【不変条件】EditableDimLabel: 縦の labelVertical は中心を (線 ∓14, 中点) に置き -90 度回す。それ以外は従来の式', () => {
  const body = editable(SRC);
  assert.match(body, /const rotated = !!dim\.labelVertical && !isH;/);
  assert.match(body, ROTATED_PX);
  assert.match(body, ROTATED_PY);
  assert.match(body, ROTATED_TF);
  // 従来の式（横・labelVertical 無しの縦）が残っている
  assert.match(body, OLD_V);
  assert.match(body, /: isH \? t\.ty\(dim\.at\) - 19 : t\.ty\(\(dim\.from \+ dim\.to\) \/ 2\) - 8\) \+ ldy;/);
  assert.match(body, /: isH \? 'translateX\(-50%\)' : \(labelLeft \? 'translateX\(-100%\)' : 'translateX\(0\)'\)/);
});

test('【不変条件】静的な縦の text: labelSide left のとき x を 8 左へ寄せる（labelSide 無しは従来どおり）', () => {
  const body = staticDim(SRC);
  assert.match(body, /const vlx = a\.x1 \+ \(labelLeft \? -\(6 \+ 8\) : 0\) \+ \(p\.labelDX \? t\.sx\(p\.labelDX\) : 0\);/);
});

test('【検出力】回転の符号・左右・分岐を壊した文字列では落ちる', () => {
  const body = editable(SRC);
  assert.doesNotMatch(body.replace('rotate(-90deg)', 'rotate(90deg)'), ROTATED_TF);
  assert.doesNotMatch(body.replace('-(6 + 8) : 6 + 8', '6 + 8 : -(6 + 8)'), ROTATED_PX);
  assert.doesNotMatch(body.replace('const rotated = !!dim.labelVertical && !isH;', 'const rotated = false;'), /const rotated = !!dim\.labelVertical && !isH;/);
  assert.doesNotMatch(body.replace('(labelLeft ? -6 : 6)) + ldx;', '(labelLeft ? -14 : 14)) + ldx;'), OLD_V);
  assert.doesNotMatch(body.replace('const py = (rotated ? t.ty((dim.from + dim.to) / 2)', 'const py = (rotated ? t.ty((dim.from + dim.to) / 2) - 8'), ROTATED_PY);
  assert.doesNotMatch(body.replace('(labelLeft ? -(6 + 8) : 6 + 8)', '(labelLeft ? -(6 + 8) : 6 + 8) + 3'), ROTATED_PX);
  assert.doesNotMatch(staticDim(SRC).replace('-(6 + 8)', '-8'), /\(labelLeft \? -\(6 \+ 8\)/);
  const commentOnly = editable('function EditableDimLabel() {\n  // const rotated = !!dim.labelVertical && !isH;\n  return (');
  assert.doesNotMatch(commentOnly, /const rotated = /);
});
