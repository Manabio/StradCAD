// renderer/ShapesLayer.jsx のソース走査による不変条件テスト（QA指摘2026-09-19: 腰壁・垂れ壁の
// 端部材の描画配線がテストで守られていなかった再発防止）。ShapesLayer.jsx は react-konva に依存
// するため import して実行できず、node:test から直接検証できるのはソーステキストの構造だけ
// ——StructuralLayer.invariants.test.js と同じ方式（team-lessons「抽出モジュールは呼び出し側も
// テストで守る」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource() {
  return fs.readFileSync(path.resolve(import.meta.dirname, 'ShapesLayer.jsx'), 'utf8');
}

function codeLines(src) {
  return src.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, ''));
}

test('【不変条件】ShapesLayer.jsx: 壁下地材（間柱・端部材）の矩形は studRects(shape.isVertical, shape.backingRange, studs) から得て、そのままRectへ写すだけ（studs.centers/studs.endMembersの直接幾何計算をJSX側へ書き戻さない）', () => {
  const src = readSource();
  assert.ok(/from '\.\/wallStudLayout\.js'/.test(src) && /studRects/.test(src),
    'wallStudLayout.js から studRects を import していない');
  const callMatch = /for \(const (\w+) of studRects\(\s*shape\.isVertical,\s*shape\.backingRange,\s*studs\s*\)\)/.exec(src);
  assert.ok(callMatch, 'studRects(shape.isVertical, shape.backingRange, studs) を for-of で回している箇所が見つからない');
  const itemVar = callMatch[1];
  // <Rect>のx/y/width/heightがループ変数（studRectsの1件）のプロパティをそのまま渡しているか
  // （isVertical分岐やbackingCenterVの再計算をJSX側へ書き戻すと、このパターンから外れて検出される）。
  const rectPropsRe = new RegExp(
    `x=\\{${itemVar}\\.x\\}\\s*\\n\\s*y=\\{${itemVar}\\.y\\}\\s*\\n\\s*width=\\{${itemVar}\\.width\\}\\s*\\n\\s*height=\\{${itemVar}\\.height\\}`);
  assert.ok(rectPropsRe.test(src),
    `<Rect x={${itemVar}.x} y={${itemVar}.y} width={${itemVar}.width} height={${itemVar}.height}> の形が見つからない（幾何をJSX側で再計算している回帰）`);
  // 重複実装の再発防止: studs.centers/studs.endMembers を直接読む行が残っていれば、studRects経由に
  // 一本化されていない（間柱・端部材のどちらかをJSX側で個別に幾何計算する二系統に戻っている）。
  const lines = codeLines(src);
  const directHits = lines.filter(l => /studs\.centers\b/.test(l) || /studs\.endMembers\b/.test(l));
  assert.equal(directHits.length, 0,
    `studs.centers/studs.endMembers への直接参照が残っている（studRects経由に一本化されていない）:\n${directHits.join('\n')}`);
});
