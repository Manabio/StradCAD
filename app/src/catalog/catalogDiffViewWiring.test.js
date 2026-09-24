// 差分表示規則（ステップ6-2）の配線を固定する不変条件テスト（catalogMaintenanceWiring.test.js と同型
// ——ソーステキストの正規表現検査）。FinishTable.jsx・EccentricityDialog.jsx・
// CatalogMaintenancePanel.jsx が catalog/catalogDiffView.js の CATALOG_DIFF_COLOR/diffTooltip
// を経由して差分表示することを固定し、色('#f97316')の直書き（定数の再発明）への退行を検知する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = path.resolve(import.meta.dirname, '..');

function readSrc(rel) {
  return fs.readFileSync(path.join(appSrc, rel), 'utf8');
}

const CONSUMERS = [
  'finish/FinishTable.jsx',
  'ui/EccentricityDialog.jsx',
  'ui/CatalogMaintenancePanel.jsx',
];

for (const rel of CONSUMERS) {
  test(`【不変条件・ステップ6-2】${rel}: catalog/catalogDiffView.js のCATALOG_DIFF_COLOR/diffTooltipを使い、#f97316を直書きしていない`, () => {
    const src = readSrc(rel);
    assert.ok(
      /from ['"][^'"]*catalog\/catalogDiffView\.js['"]/.test(src),
      `${rel} が catalog/catalogDiffView.js を import していない`,
    );
    assert.ok(/\bCATALOG_DIFF_COLOR\b/.test(src), `${rel} が CATALOG_DIFF_COLOR を使っていない`);
    // importだけでJSX側の表示に使われていない退行を検知するため、テンプレートリテラル内での
    // 実使用（${CATALOG_DIFF_MARK}）を要求する（importのみの残存では拾えない）。
    assert.ok(
      /\$\{CATALOG_DIFF_MARK\}/.test(src),
      `${rel} が CATALOG_DIFF_MARK（≠）を表示に使っていない（importのみで表示から外れている可能性）`,
    );
    assert.ok(/\bdiffTooltip\(/.test(src), `${rel} が diffTooltip(...) を呼んでいない`);
    assert.ok(
      !/#f97316/.test(src),
      `${rel} に色 '#f97316' が直書きされている（CATALOG_DIFF_COLOR経由に一本化する契約への退行）`,
    );
  });
}

test('【不変条件・ステップ6-2】modes/FinishModeState.js: catalog/catalogRegistry.js の docDiffMap を使う', () => {
  const src = readSrc('modes/FinishModeState.js');
  assert.ok(/\bdocDiffMap\(/.test(src), 'FinishModeState.js が docDiffMap(...) を呼んでいない');
});

// オレンジ表示は画面UIのみ: renderer/・figure/（図面・印刷・出力する仕上げ表）には付けない。
// サブディレクトリも対象にする（2026-09-22 QA指摘Minor-3。将来renderer/figure配下に
// サブディレクトリが増えても検知漏れしないよう再帰走査する）。
test('【不変条件・ステップ6-2】renderer/・figure/ 配下（サブディレクトリ含む）は catalog/catalogDiffView.js を import しない', () => {
  const offenders = [];
  for (const dir of ['renderer', 'figure']) {
    const abs = path.join(appSrc, dir);
    if (!fs.existsSync(abs)) continue;
    const entries = fs.readdirSync(abs, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(js|jsx)$/.test(entry.name)) continue;
      const relFile = path.join(entry.parentPath ?? entry.path ?? abs, entry.name);
      const src = fs.readFileSync(relFile, 'utf8');
      if (/catalogDiffView/.test(src)) offenders.push(path.relative(appSrc, relFile));
    }
  }
  assert.deepEqual(offenders, []);
});
