// CatalogPreview.jsx / CatalogMaintenancePanel.jsx の配線を固定する不変条件テスト
// （catalog/catalogMaintenanceWiring.test.js と同型——ソーステキストの正規表現検査）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const uiDir = import.meta.dirname;

function readSrc(file) {
  return fs.readFileSync(path.join(uiDir, file), 'utf8');
}

test('【不変条件・ステップ9b】ui/CatalogMaintenancePanel.jsx: ./CatalogPreview.jsxをimportし、ReadonlyKindTabの右ペインで<CatalogPreviewを描く', () => {
  const src = readSrc('CatalogMaintenancePanel.jsx');
  assert.ok(
    /from ['"]\.\/CatalogPreview\.jsx['"]/.test(src),
    'CatalogMaintenancePanel.jsx が ./CatalogPreview.jsx を import していない',
  );
  const fnMatch = /function ReadonlyKindTab\(\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に ReadonlyKindTab コンポーネントが見つからない');
  assert.ok(/<CatalogPreview\b/.test(fnMatch[0]), 'ReadonlyKindTab が <CatalogPreview を描いていない');
});

test('【不変条件・ステップ9b】ui/CatalogPreview.jsx: memberFigure(・buildOpeningElevation(の直書きが無い（ui/catalogPreview.js経由に一本化）', () => {
  const src = readSrc('CatalogPreview.jsx');
  assert.ok(!/\bmemberFigure\(/.test(src), 'CatalogPreview.jsx が memberFigure を直接呼んでいる（catalogPreview.js経由への一本化への退行）');
  assert.ok(!/\bbuildOpeningElevation\(/.test(src), 'CatalogPreview.jsx が buildOpeningElevation を直接呼んでいる（catalogPreview.js経由への一本化への退行）');
  assert.ok(/from ['"]\.\/catalogPreview\.js['"]/.test(src), 'CatalogPreview.jsx が ./catalogPreview.js を import していない');
});

test('【不変条件・ステップ9b】ui/CatalogPreview.jsx: <AutoScaledFigure に onEditDim・study を渡さない（読み取り専用）', () => {
  const src = readSrc('CatalogPreview.jsx');
  const m = /<AutoScaledFigure\b[\s\S]*?\/>/.exec(src);
  assert.ok(m, 'CatalogPreview.jsx に <AutoScaledFigure ... /> が見つからない');
  assert.ok(!/onEditDim/.test(m[0]), 'CatalogPreview.jsx の <AutoScaledFigure に onEditDim が渡されている（読み取り専用の契約への退行）');
  assert.ok(!/\bstudy\b/.test(m[0]), 'CatalogPreview.jsx の <AutoScaledFigure に study が渡されている（読み取り専用の契約への退行）');
});

// ---- QA指摘Major-1・2026-09-23: プレビュー枠は memberCatalog.js の FIGURE_FRAME_BY_MAP.columnMap を
// 使う（独自の固定枠280×220を持たない）。狭い固定枠だと annotatedFigure が最小スケール(1/500)へ落ち、
// builtin断面が軒並み潰れて見えなくなる回帰があったため。 ----
test('【不変条件・QA指摘Major-1・2026-09-23】ui/CatalogPreview.jsx: 独自のPREVIEW_MAX_定数を持たず、structural/memberCatalog.jsのFIGURE_FRAME_BY_MAPを表示枠に使う', () => {
  const src = readSrc('CatalogPreview.jsx');
  assert.ok(
    !/PREVIEW_MAX_/.test(src),
    'CatalogPreview.jsx にPREVIEW_MAX_の独自定数が残っている（FIGURE_FRAME_BY_MAPへの一本化への退行）',
  );
  assert.ok(
    /from ['"]\.\.\/structural\/memberCatalog\.js['"]/.test(src),
    'CatalogPreview.jsx が structural/memberCatalog.js を import していない',
  );
  assert.ok(
    /\bFIGURE_FRAME_BY_MAP\.columnMap\b/.test(src),
    'CatalogPreview.jsx が FIGURE_FRAME_BY_MAP.columnMap を使っていない',
  );
});

// ---- QA指摘・追加テスト3: buildCatalogPreviewの呼び出しをtry/catchで包む（D9） ----
test('【不変条件・ステップ9b・D9】ui/CatalogPreview.jsx: buildCatalogPreviewの呼び出しをtry/catchで包み、catchがcatmnt-preview-errorを描く', () => {
  const src = readSrc('CatalogPreview.jsx');
  const tryMatch = /try\s*\{([\s\S]*?)\}\s*catch\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/.exec(src);
  assert.ok(tryMatch, 'CatalogPreview.jsx に try/catch ブロックが見つからない');
  const [, tryBody, catchBody] = tryMatch;
  assert.ok(/\bbuildCatalogPreview\(/.test(tryBody), 'CatalogPreview.jsx の try ブロック内で buildCatalogPreview を呼んでいない');
  assert.ok(/catmnt-preview-error/.test(catchBody), 'CatalogPreview.jsx の catch ブロックが catmnt-preview-error を描いていない');
});
