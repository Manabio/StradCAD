// 敷地モード（appMode 'site'）の配置まわりの配線不変条件（配置 S3）。.jsx は node:test から単体 import できないため
// ソーステキスト検査で固定する（facadeModeWiring.test.js と同じ流儀。行コメントは落としてから照合する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentLines } from './uiBusySourceScan.js';

const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');

test('【配線】App.jsx: site のローダーは SiteModeState を new して await s.init() してから返す（配置の痕跡があれば配置図を開いて突入）', () => {
  const appCode = stripCommentLines(readAppSrc());
  const start = appCode.indexOf("import('./modes/SiteModeState.js')");
  assert.ok(start >= 0, 'SiteModeState のローダーが見つからない');
  assert.equal(appCode.split("import('./modes/SiteModeState.js')").length - 1, 1, 'ローダーはちょうど1箇所');
  const block = appCode.slice(start, appCode.indexOf('});', start));
  assert.match(block, /\.then\(async m => \{/);
  assert.match(block, /^\s*const s = new m\.SiteModeState\(project\.site, project\);\s*$/m);
  assert.match(block, /^\s*await s\.init\(\);/m);
  assert.match(block, /^\s*return s;\s*$/m);
});

test('【配線】FloorSwapManager.startSiteDirtyTracking: autorun が site.placement を観測する（配置の変更で dirty になる）', () => {
  const code = stripCommentLines(readSrc('storage/FloorSwapManager.js'));
  const start = code.indexOf('startSiteDirtyTracking(site) {');
  assert.ok(start >= 0);
  const body = code.slice(start, code.indexOf('disposeSiteDirtyTracking() {', start));
  assert.match(body, /^\s*void site\.placement;\s*$/m);
});
