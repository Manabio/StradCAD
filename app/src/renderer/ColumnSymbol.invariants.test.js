// renderer/ColumnSymbol.jsx のソース走査による不変条件テスト（QA指摘2・ステップ4）。
// react-konva に依存するため import して実行できず、StructuralLayer.invariants.test.js と同じ流儀で
// ソーステキストの構造だけを検証する——hitPropsの既定値・全分岐への配線を、実装を1文字戻したら
// 検出できる形でここに固定する（team-lessons「抽出モジュールは呼び出し側もテストで守る」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource() {
  return fs.readFileSync(path.resolve(import.meta.dirname, 'ColumnSymbol.jsx'), 'utf8');
}

// ColumnSymbol関数本体だけを取り出す（ColumnCrossMarkの`listening={false}`直書き——こちらは
// hitPropsを持たない別コンポーネントで正当——を誤検知しないため）。
function columnSymbolBody(src) {
  const start = src.indexOf('export const ColumnSymbol = observer(');
  const end = src.indexOf('export const ColumnCrossMark');
  assert.ok(start >= 0 && end > start, 'ColumnSymbol〜ColumnCrossMarkの範囲切り出しに失敗した（テスト自体の前提が崩れている）');
  return src.slice(start, end);
}

test('【不変条件・QA指摘2】ColumnSymbol.jsx: hitPropsの既定値はモジュールスコープ定数DEFAULT_HIT_PROPS（{ listening: false }）で、関数シグネチャがそれを参照する', () => {
  const src = readSource();
  const constMatch = /const\s+(\w+)\s*=\s*\{\s*listening:\s*false\s*\};/.exec(src);
  assert.ok(constMatch, 'hitPropsの既定値を持つモジュールスコープ定数（{ listening: false }）が見つからない');
  const constVar = constMatch[1];
  const sigRe = new RegExp(`function ColumnSymbol\\(\\{[^)]*hitProps\\s*=\\s*${constVar}[^)]*\\}\\)`);
  assert.ok(sigRe.test(src), `ColumnSymbolの関数シグネチャがhitProps既定値として${constVar}を参照していない`);
});

test('【不変条件・QA指摘2】ColumnSymbol.jsx: 全5分岐（sectionDefIdフォールバックRect・Circle・SQUARE_PIPE Rect・H_SECTION Path・既定RECT Rect）すべてが{...hitProps}を受け取り、listening={false}の直書きは残っていない', () => {
  const body = columnSymbolBody(readSource());
  const hitPropsSpreads = body.match(/\{\.\.\.hitProps\}/g) ?? [];
  assert.equal(hitPropsSpreads.length, 5, `{...hitProps}の出現数が5ではない（分岐が増減した、またはどれかが{...hitProps}を受け取っていない）: ${hitPropsSpreads.length}件`);
  assert.ok(!/listening=\{false\}/.test(body), 'ColumnSymbol本体にlisten={false}の直書きが残っている（hitProps経由に一本化されていない回帰）');
});

test('【失敗系・QA指摘2】ColumnSymbol.jsx: ColumnCrossMark（×記号）はhitPropsを持たずlistening={false}の直書きのまま——ColumnSymbolの変更が波及していない', () => {
  const src = readSource();
  const start = src.indexOf('export const ColumnCrossMark');
  const crossMarkBody = src.slice(start);
  assert.ok(/listening=\{false\}/.test(crossMarkBody), 'ColumnCrossMarkのLineがlistening={false}の直書きでなくなっている（×記号は常に非listeningのはず）');
  assert.ok(!/hitProps/.test(crossMarkBody), 'ColumnCrossMarkにhitPropsが紛れ込んでいる（×記号はタップ対象外のはず。ステップ4の柱タップは自階柱□=ColumnSymbolだけが対象）');
});
