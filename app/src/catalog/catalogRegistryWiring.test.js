// 本番の読み出し口（finish/wallRegeneration.js・modes/FinishModeState.js・
// modes/ElevationModeState.js・ui/EccentricityDialog.jsx）が catalogRegistry.js の
// composeCatalog/composeList を経由してMATERIALSを読んでいることを固定する不変条件テスト
// （finish/wallFreshnessKey.test.js:192-207 と同じ型——ソーステキストの正規表現検査）。
// `new Map(MATERIALS.map(...))` へ手で戻す退行（overlayを無視する退行）を検知する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = path.resolve(import.meta.dirname, '..');

function readSrc(rel) {
  return fs.readFileSync(path.join(appSrc, rel), 'utf8');
}

const CONSUMERS = [
  { rel: 'finish/wallRegeneration.js', label: 'loadMaterialMap' },
  { rel: 'modes/FinishModeState.js', label: 'init（materials/materialMap）' },
  { rel: 'modes/ElevationModeState.js', label: 'init（materialMap）' },
  { rel: 'ui/EccentricityDialog.jsx', label: 'materialMapロード' },
];

for (const { rel, label } of CONSUMERS) {
  test(`【不変条件】${rel}: ${label}はcatalogRegistry.jsのcompose経由でMATERIALSを読む（new Map(MATERIALS.map(...))への退行を検知）`, () => {
    const src = readSrc(rel);
    assert.ok(
      /from ['"][^'"]*catalog\/catalogRegistry\.js['"]/.test(src),
      `${rel} が catalog/catalogRegistry.js を import していない`,
    );
    assert.ok(
      /\bcompose(Catalog|List)\(/.test(src),
      `${rel} が composeCatalog/composeList を呼んでいない`,
    );
    assert.ok(
      !/new Map\(\s*(matMod\.)?MATERIALS\.map/.test(src),
      `${rel} が composeCatalog/composeList を経由せず直接 new Map(MATERIALS.map(...)) を組んでいる（退行）`,
    );
  });
}

// 設計書（catalog-design.md）どおり、EccentricityDialog.jsxはsetMaterials/setMaterialMapの
// 両方がcompose経由であることを固定する（coordinator指摘・2026-09-22: setMaterialsが
// matMod.MATERIALSの直読みに戻る退行を検知）。
test('【不変条件】ui/EccentricityDialog.jsx: setMaterialsもcomposeList経由でMATERIALSを読む（setMaterials(matMod.MATERIALS)への退行を検知）', () => {
  const src = readSrc('ui/EccentricityDialog.jsx');
  assert.ok(
    /setMaterials\(\s*composeList\(/.test(src),
    'EccentricityDialog.jsx の setMaterials が composeList(...) を経由していない',
  );
  assert.ok(
    !/setMaterials\(\s*matMod\.MATERIALS\s*\)/.test(src),
    'EccentricityDialog.jsx の setMaterials が matMod.MATERIALS を直接渡している（composeList未経由への退行）',
  );
});

test('【不変条件】modes/FinishModeState.js: 材コード判定はcatalog/materialCode.jsのisMaterialCodeを使う（正規表現の重複定義への退行を検知）', () => {
  const src = readSrc('modes/FinishModeState.js');
  assert.ok(
    /from ['"][^'"]*catalog\/materialCode\.js['"]/.test(src),
    'FinishModeState.js が catalog/materialCode.js を import していない',
  );
  assert.ok(/\bisMaterialCode\(/.test(src), 'FinishModeState.js が isMaterialCode を呼んでいない');
  assert.ok(!/\/\^\\d\{12\}\$\//.test(src), 'FinishModeState.js に12桁コードの正規表現がまだ直書きされている');
});

// 2026-09-22 QA指摘・Minor: 「新規（全消去）」= store.js の resetAll がステップ4で
// catalog/catalogRegistry.js の clearOverlays を呼ぶ配線は未実装（overlayを実際に立てる
// doc/userの取込みUI自体がまだ無いため、resetAllから呼んでも今は何も消すものが無い）。
// ここではコメントとして裁定だけ残し、テストはまだ書かない（配線を実装するステップ4で
// 「store.js: resetAllがclearOverlaysを呼ぶ」不変条件テストを追加する）。
