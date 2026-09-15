// renderer/StructuralLayer.jsx のソース走査による不変条件テスト（QA指摘F1回帰の再発防止）。
// StructuralLayer.jsx は react-konva に依存するため import して実行できず、node:test から直接
// 検証できるのはソーステキストの構造だけ——「材種色の直接参照が colorOf 経由に統一されているか」
// 「柱グループの描画が framingColumnGroups の配列駆動になっているか」を、実装を1文字戻したら
// 検出できる形でここに固定する（team-lessons「抽出モジュールは呼び出し側もテストで守る」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource() {
  return fs.readFileSync(path.resolve(import.meta.dirname, 'StructuralLayer.jsx'), 'utf8');
}

// 行コメントを落として判定する（コメント中の言及を「コード上の参照」と誤検知しないため。
// structureRules.test.js の scanOffenders と同じ簡易化方針）。
function codeLines(src) {
  return src.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, ''));
}

test('【不変条件】StructuralLayer.jsx: COLOR_BY_MATERIAL[ の直接参照は ColumnsLayer 本体の材種色フォールバックと colorOf の2箇所だけ、かつ colorOf は framingColor を経由する', () => {
  const lines = codeLines(readSource());
  const hits = [];
  lines.forEach((code, i) => { if (/COLOR_BY_MATERIAL\[/.test(code)) hits.push({ line: i + 1, code }); });
  assert.equal(hits.length, 2, `COLOR_BY_MATERIAL[ の直接参照が2箇所以外になっている:\n${hits.map(h => `${h.line}: ${h.code}`).join('\n')}`);
  const colorOfHit = hits.find(h => /colorOf/.test(h.code));
  assert.ok(colorOfHit, 'colorOf の定義行が見つからない（COLOR_BY_MATERIAL[ の2箇所目のはず）');
  assert.ok(/framingColor\(/.test(colorOfHit.code), 'colorOf が framingColor を経由していない（恒等化の回帰・QA指摘E相当）');
});

test('【不変条件】StructuralLayer.jsx: 柱グループは framingColumnGroups の配列を map して描く（resolveCategory(group.category) の graph・group.symbol・colorOverride・group.outline をすべて橋渡しし、diaphragm は columnMap 判定で渡す）', () => {
  const src = readSource();
  const defMatch = /const\s+(\w+)\s*=\s*framingColumnGroups\(/.exec(src);
  assert.ok(defMatch, 'framingColumnGroups(...) の呼び出し・代入が見つからない（柱グループの判断が structural/framingDrawing.js に無い＝回帰）');
  const groupsVar = defMatch[1];
  const mapMatch = new RegExp(`${groupsVar}\\.map\\(\\s*\\(?\\s*(\\w+)`).exec(src);
  assert.ok(mapMatch, `${groupsVar}.map(...) の呼び出しが見つからない（配列をmapして描いていない）`);
  const itemVar = mapMatch[1];
  const resolveRe = new RegExp(`resolveCategory\\(\\s*${itemVar}\\.category\\s*\\)`);
  assert.ok(resolveRe.test(src), `resolveCategory(${itemVar}.category) 相当の呼び出しが見つからない（カテゴリごとの解決を配列に委ねていない）`);
  // resolveCategory(...) の代入先変数（graph の取得元）を捕まえる——ハードコードした別変数（例: 常に
  // columnMap側の resolved を使い回す）へ取り違えていないかを、実際に使われている変数名で確認する。
  const resolvedMatch = new RegExp(`const\\s+(\\w+)\\s*=\\s*composition\\.resolveCategory\\(\\s*${itemVar}\\.category\\s*\\)`).exec(src);
  assert.ok(resolvedMatch, `composition.resolveCategory(${itemVar}.category) の代入先変数が見つからない`);
  const resolvedVar = resolvedMatch[1];
  const outlinePropRe = new RegExp(`outline=\\{\\s*${itemVar}\\.outline\\s*\\}`);
  assert.ok(outlinePropRe.test(src), `outline={${itemVar}.outline} が渡されていない（輪郭強制の可否を配列から props へ橋渡ししていない）`);
  // QA指摘F6: graph・framingSymbol・colorOverride も group（resolveCategoryの結果・framingColorOverrideの
  // 代入先）からそのまま橋渡ししているかをソース走査で固定する。
  const graphPropRe = new RegExp(`graph=\\{\\s*${resolvedVar}\\?\\.graph\\s*\\}`);
  assert.ok(graphPropRe.test(src), `graph={${resolvedVar}?.graph} が渡されていない（下階柱・自階柱で異なるグラフを解決した結果を使っていない回帰）`);
  const framingSymbolPropRe = new RegExp(`framingSymbol=\\{\\s*${itemVar}\\.symbol\\s*\\}`);
  assert.ok(framingSymbolPropRe.test(src), `framingSymbol={${itemVar}.symbol} が渡されていない（記号の選択を配列から橋渡ししていない）`);
  const colorOverrideDefMatch = /const\s+(\w+)\s*=\s*framingColorOverride\(/.exec(src);
  assert.ok(colorOverrideDefMatch, 'framingColorOverride(...) の呼び出し・代入が見つからない');
  const colorOverrideVar = colorOverrideDefMatch[1];
  const colorOverridePropRe = new RegExp(`colorOverride=\\{\\s*${colorOverrideVar}\\s*\\}`);
  assert.ok(colorOverridePropRe.test(src), `colorOverride={${colorOverrideVar}} が渡されていない`);
  // QA指摘F7: diaphragm は「配列の先頭」という位置ではなく category==='columnMap'（下階柱）で判定する。
  const diaphragmPropRe = new RegExp(`diaphragm=\\{\\s*${itemVar}\\.category\\s*===\\s*'columnMap'\\s*&&`);
  assert.ok(diaphragmPropRe.test(src), `diaphragm が ${itemVar}.category === 'columnMap' で判定されていない（配列の位置(index===0)依存の回帰）`);
});

// QA指摘F1（ブロッカー・非在来の回帰）の再発防止: ColumnsLayer 自身の outline 判定が framingSymbol
// （記号の有無。非在来でも 'section' という非null値を持つ）を見てはならない——輪郭強制は必ず
// 呼び出し側が渡す outline props（framingColumnGroups 由来）だけで決める。
test('【不変条件・F1回帰】StructuralLayer.jsx: ColumnsLayer の輪郭線判定（outline算出）は framingSymbol を参照しない', () => {
  const lines = codeLines(readSource());
  const outlineDefLine = lines.find(l => /^\s*const outline = /.test(l));
  assert.ok(outlineDefLine, 'ColumnsLayer 内の `const outline = ...` 定義行が見つからない');
  assert.ok(!/framingSymbol/.test(outlineDefLine),
    `outline の算出が framingSymbol を参照している（非在来の下階柱にも 'section'（非null）が渡り輪郭が強制される回帰）: ${outlineDefLine.trim()}`);
});
