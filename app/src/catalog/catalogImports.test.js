// 純モジュール不変条件（QA指摘 M4）: src/catalog/*.js（テスト自身を除く）の静的 import は
// 許可リスト（同ディレクトリの兄弟モジュール＝'./*.js'、および '../error.js'）だけを許す方式に
// する（2026-09-22 QA指摘・Minor: ブラックリスト方式だと未知の新規依存——例えば modes/ 以外の
// 意図しないディレクトリへの依存——が増えても検知できない。許可リスト方式なら「増えたら即赤」
// になる）。本体標準マスタ（finish/materials/・structural/sectionCatalog・openings/openingCatalog）
// は動的 import(...) の形でのみ現れる（静的 import では現れない）ことも固定する。
// finish/wallFreshnessKey.test.js と同じ書き方（ソーステキストを正規表現で検査する不変条件テスト）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = import.meta.dirname;
const productFiles = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

const MASTER_PATHS = [/finish\/materials\//, /structural\/sectionCatalog/, /openings\/openingCatalog/];
// 許可される静的import specifier: 同ディレクトリの兄弟モジュール（'./xxx.js'）と '../error.js' のみ。
const ALLOWED_STATIC_SPECIFIERS = [/^\.\/[\w-]+\.js$/, /^\.\.\/error\.js$/];

test('【不変条件】catalog/*.js（テスト除く）の静的importは許可リスト（./配下の兄弟モジュール＋../error.jsのみ）に限る', () => {
  const offenders = [];
  for (const file of productFiles) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const staticImportLines = src.split(/\r?\n/).filter(l => /^\s*import /.test(l));
    for (const line of staticImportLines) {
      // 2026-09-22 QA指摘・Minor: `from '...'` を持つ通常のimportだけでなく、副作用のみの
      // import（例: `import '../viewport.js';`）もこの1本の正規表現で拾う
      // （`from`句は省略可能なグループにする）。
      const m = line.match(/^\s*import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/);
      if (!m) continue; // importで始まらない行は無い（staticImportLinesの絞り込みで保証済み）
      const specifier = m[1];
      if (!ALLOWED_STATIC_SPECIFIERS.some(re => re.test(specifier))) {
        offenders.push(`${file}: "${line.trim()}" (許可リスト外のspecifier: ${specifier})`);
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
