// AutoScaledFigure.jsx（SVG レンダラ）の配線の不変条件: closed の polyline は <polygon> で描く。
// 背景: 部分詳細図の閉じたストロークは「始点へ戻る手を書かない」規約（detail/detailModel.js）で、閉じる責務は
// 描画側にある。SVG の <polyline> は fill しか閉じず線が閉じないため、DXF から写した矩形が
// ヘルパーのプレビューで開いて見えた（2026-11-01 ユーザー目視で発覚）。renderer/figurePrimitivesKonva.jsx の
// Line closed（平面）・openingSection の始点追加（展開）は閉じるので、差はプレビューだけだった。
// .jsx は node:test から import できないため、ソース文字列をコメント除去のうえ検査する（team-lessons の流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentLikeLines } from '../../uiBusySourceScan.js';

const SRC = fs.readFileSync(path.join(import.meta.dirname, 'AutoScaledFigure.jsx'), 'utf8').replace(/\r\n/g, '\n');

function polylineCaseBody(text) {
  const start = text.indexOf("case 'polyline':");
  assert.ok(start >= 0, "case 'polyline': が見つからない");
  const end = text.indexOf("case 'hSection':", start);
  assert.ok(end > start, "case 'hSection': が見つからない");
  return text.slice(start, end);
}

test('【不変条件】AutoScaledFigure: closed の polyline は <polygon>、開いたものは <polyline> で描く', () => {
  const body = polylineCaseBody(stripCommentLikeLines(SRC));
  assert.match(body, /const Tag = p\.closed \? 'polygon' : 'polyline';/, 'closed で polygon/polyline を切り替える');
  assert.match(body, /<Tag key=\{i\} points=/, '切り替えた Tag で描く');
  assert.doesNotMatch(body, /<polyline key=/, '固定の <polyline> が残っている（closed が線で閉じない）');
});

test('【検出力】本体を <polyline> 固定に戻した文字列では落ちる・コメントに書いただけでは通らない', () => {
  const body = polylineCaseBody(stripCommentLikeLines(SRC));
  const broken = body.replace("const Tag = p.closed ? 'polygon' : 'polyline';", '').replace('<Tag key={i} points=', '<polyline key={i} points=');
  assert.doesNotMatch(broken, /const Tag = p\.closed \? 'polygon' : 'polyline';/);
  assert.match(broken, /<polyline key=/);
  const commentOnly = stripCommentLikeLines("case 'polyline':\n      // const Tag = p.closed ? 'polygon' : 'polyline';\n      return <polyline key={i} points={x} />;\n    case 'hSection':");
  assert.doesNotMatch(polylineCaseBody(commentOnly), /const Tag = p\.closed/);
});
