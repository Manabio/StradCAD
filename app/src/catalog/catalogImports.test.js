// 純モジュール不変条件（QA指摘 M4）: src/catalog/*.js（テスト自身を除く）の静的 import 行が
// store.js / snap.js / .jsx / modes/ を含まないこと、本体標準マスタ（finish/materials/・
// structural/sectionCatalog・openings/openingCatalog）は動的 import(...) の形でのみ現れる
// （静的 import では現れない）ことを固定する。finish/wallFreshnessKey.test.js と同じ書き方
// （ソーステキストを正規表現で検査する不変条件テスト）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = import.meta.dirname;
const productFiles = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

const FORBIDDEN_STATIC = [/store\.js/, /snap\.js/, /\.jsx['"]/, /['"][^'"]*\/modes\//];
const MASTER_PATHS = [/finish\/materials\//, /structural\/sectionCatalog/, /openings\/openingCatalog/];

test('【不変条件】catalog/*.js（テスト除く）の静的importはstore.js/snap.js/.jsx/modes/を含まない', () => {
  const offenders = [];
  for (const file of productFiles) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const staticImportLines = src.split(/\r?\n/).filter(l => /^\s*import /.test(l));
    for (const line of staticImportLines) {
      for (const re of FORBIDDEN_STATIC) {
        if (re.test(line)) offenders.push(`${file}: "${line.trim()}" (${re})`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('【不変条件】本体マスタ（finish/materials/・structural/sectionCatalog・openings/openingCatalog）は静的importでは現れない（動的import(...)のみ許容）', () => {
  const offenders = [];
  for (const file of productFiles) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const staticImportLines = src.split(/\r?\n/).filter(l => /^\s*import /.test(l));
    for (const line of staticImportLines) {
      for (const re of MASTER_PATHS) {
        if (re.test(line)) offenders.push(`${file}: 静的importで本体マスタを参照している: "${line.trim()}" (${re})`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('catalogKinds.js: 本体標準マスタ5本への動的import(loadBuiltin thunk)が実在する', () => {
  const lines = fs.readFileSync(path.join(dir, 'catalogKinds.js'), 'utf8').split(/\r?\n/);
  for (const token of ['materialData.js', 'sectionCatalog.js', 'openingCatalog.js', 'interiorMasters.js', 'boundaryMasters.js']) {
    // コメントでの言及ではなく、実際の動的import(...)行を探す（コメント中の言及は無視する）。
    const importLine = lines.find(l => l.includes(token) && /\bimport\(/.test(l));
    assert.ok(importLine, `${token} への動的import(...)行が見つからない`);
    assert.ok(!/^\s*import /.test(importLine), `${token} への参照が静的importになっている: "${importLine.trim()}"`);
  }
});
