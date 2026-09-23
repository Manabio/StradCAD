// ステップ11e「作図P2＝建具の平面記号の純関数化」の仕上げ。renderer/OpeningsLayer.jsx が
// 判断（機構ディスパッチ・枠種別・線幅の役割・回転中心・内法区間）を一切持たず、すべて
// openings/openingPlanSymbol.js（純関数）へ委ねていることをソーステキスト検査で固定する
// （finish/wallFreshnessKey.test.js・catalog/catalogRegistryWiring.test.js と同じ型）。
// コメント（行コメント・ブロックコメントの行頭）は除外する——退行の説明コメントに現れる旧関数名
// （「旧swingSymbol」等）を誤検知しないため（QA指摘: 正規表現はコメント文にも一致しうる）。
// 注意: stripCommentsは行頭コメントしか除外しない。コード行の末尾コメント（`const x = 1; // ...`）
// は除外されないため、そこに禁止語が現れると安全側（誤って赤になる）に倒れる——見逃し（偽陰性）
// より誤検知（偽陽性）を選ぶ設計。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'OpeningsLayer.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  return text.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】OpeningsLayer.jsx は openingCatalog.js の OpeningMechanism（機構列挙）をコード本体で参照しない', () => {
  assert.ok(!/\bOpeningMechanism\./.test(codeOnly), 'OpeningMechanism. への参照が残っている（機構ディスパッチが旧経路へ退行）');
});

test('【不変条件】OpeningsLayer.jsx は openingPlanSymbolGeometry.js の判断関数（planSymbolPlan/planFrameBand/swingOpenPerpDir）を直接呼ばない', () => {
  for (const fn of ['planSymbolPlan(', 'planFrameBand(', 'swingOpenPerpDir(']) {
    assert.ok(!codeOnly.includes(fn), `${fn} への直接呼び出しが残っている（判断ロジックが旧経路へ退行）`);
  }
});

test('【不変条件】OpeningsLayer.jsx は core.js の LINE_WEIGHT_MM（線幅の役割の生値）を参照しない（役割→太さはplanSymbolWeightMmに一本化）', () => {
  assert.ok(!/\bLINE_WEIGHT_MM\b/.test(codeOnly), 'LINE_WEIGHT_MM への参照が残っている（線幅の役割が旧経路へ退行）');
});

test('【不変条件】OpeningsLayer.jsx は openings/openingPlanSymbol.js の buildOpeningPlanSymbol を import している', () => {
  const importLines = src.split(/\r?\n/).filter(l => /^import /.test(l));
  assert.ok(
    importLines.some(l => /\bbuildOpeningPlanSymbol\b/.test(l) && /openings\/openingPlanSymbol\.js/.test(l)),
    'buildOpeningPlanSymbol を openings/openingPlanSymbol.js から import していない',
  );
});

test('【不変条件】renderPlanPrimitiveのcaseはline/polyline/rect/arcの4つちょうど（プリミティブ語彙が増減したら要更新）', () => {
  const caseLines = codeOnly.match(/^\s*case '[a-z]+':/gm) ?? [];
  const kinds = caseLines.map(l => l.match(/case '([a-z]+)'/)[1]);
  assert.deepEqual(kinds.sort(), ['arc', 'line', 'polyline', 'rect']);
});

test('【不変条件】renderOpeningSymbol本体に機構名の分岐が無い（entry.mechanismの値を直接読み分けない）', () => {
  const m = codeOnly.match(/function renderOpeningSymbol\(opening\) \{[\s\S]*?\n {2}\}\n\}/);
  assert.ok(m, 'renderOpeningSymbol関数の本体が見つからない');
  const body = m[0];
  assert.ok(!/mechanism/i.test(body), 'renderOpeningSymbol本体がmechanismを参照している（機構ディスパッチが旧経路へ退行）');
});
