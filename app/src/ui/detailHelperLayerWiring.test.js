// ヘルパー画面の「図面読込みタブのレイヤ一覧（on/off）」（S7d-0b）の配線を固定する不変条件テスト
// （detailHelperPickWiring.test.js と同型——コメントを除いたソース本体の正規表現検査＋検出力）。純ロジックは ui/detailHelperDxf.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = path.resolve(import.meta.dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(appSrc, rel), 'utf8');

// 文字列リテラルは保持し、// と /* */ のコメントだけを取り除く。
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
    const ch = src[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function topLevelBlock(src, startMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) return null;
  const e = src.indexOf('\n}\n', s);
  return e < 0 ? null : src.slice(s, e + 3);
}

// ---- 判定（本体文字列 → 真偽）----
// 一覧の行は dxfLayerRows(state) から作る（判断は純関数側）。
const rowsFromDxfLayerRows = body => !!body && /const layerRows = dxfLayerRows\(state\)/.test(body);
// 小節は行があるときだけ描く。
const sectionOnlyWhenRows = body => !!body && /\{layerRows\.length > 0 && \(/.test(body);
// チェックの onChange は onToggleLayer(名前)。busy なら入力を受けない。
const checkboxTogglesByName = body => !!body
  && /<input type="checkbox" checked=\{r\.visible\} disabled=\{busy\} onChange=\{\(\) => onToggleLayer\(r\.name\)\} \/>/.test(body);
// 「全部 on」は onAllLayersOn を呼び、全部 on のとき（または busy）は disabled。
const allOnButton = body => !!body
  && /disabled=\{busy \|\| layerRows\.every\(r => r\.visible\)\} onClick=\{onAllLayersOn\}>\{DETAIL_HELPER_TEXT\.layersAllOn\}</.test(body);
// 見出しは文言表から。
const headingFromTextTable = body => !!body && /\{DETAIL_HELPER_TEXT\.layers\}/.test(body);
// 文言の直書きがない。
const noLiteralLabels = body => !!body && !/>\s*レイヤ\s*</.test(body) && !/>\s*全部 on\s*</.test(body);
// DxfPane は ImportResult へ 2 つの prop を渡す。
const paneForwards = body => !!body && /onToggleLayer=\{onToggleLayer\} onAllLayersOn=\{onAllLayersOn\}/.test(body);
// パネル本体: toggleDxfLayer / setDxfLayers(…, []) の結果（{dxf, error}）を applyDxfResult で反映する。
const panelWiresLayers = src => /onToggleLayer=\{name => applyDxfResult\(toggleDxfLayer\(dxf, name\)\)\}/.test(src)
  && /onAllLayersOn=\{\(\) => applyDxfResult\(setDxfLayers\(dxf, \[\]\)\)\}/.test(src);
// applyDxfResult は dxf を state へ、error を画面の文言へ。
const applyReflectsDxfAndError = src => /function applyDxfResult\(r\) \{\s*setDxf\(r\.dxf\);\s*setDxfMessage\(r\.error \? \{ text: r\.error, isError: true \} : null\);/.test(src);
const cssHasLayerList = css => /\.dthlp-layer-list\s*\{/.test(css) && /\.dthlp-layer-row\s*\{/.test(css);

const panel = () => stripComments(readSrc('ui/DetailHelperPanel.jsx'));
const importResultBody = () => topLevelBlock(panel(), 'function ImportResult(');
const dxfPaneBody = () => topLevelBlock(panel(), 'function DxfPane(');

test('【配線】ImportResult: 行は dxfLayerRows から・行があるときだけ小節を描く・見出しと文言は文言表', () => {
  const body = importResultBody();
  assert.ok(body, 'ImportResult が見つからない');
  assert.ok(rowsFromDxfLayerRows(body), body);
  assert.ok(sectionOnlyWhenRows(body), body);
  assert.ok(headingFromTextTable(body), body);
  assert.ok(noLiteralLabels(body), body);
});

test('【配線】ImportResult: チェックは onToggleLayer(名前)・「全部 on」は onAllLayersOn（全部 on のとき disabled）', () => {
  const body = importResultBody();
  assert.ok(checkboxTogglesByName(body), body);
  assert.ok(allOnButton(body), body);
});

test('【配線】DxfPane・パネル本体: 2 つの prop を通し、結果は applyDxfResult で反映する。CSS にクラスがある', () => {
  assert.ok(paneForwards(dxfPaneBody()), dxfPaneBody());
  assert.ok(panelWiresLayers(panel()));
  assert.ok(applyReflectsDxfAndError(panel()));
  assert.ok(cssHasLayerList(readSrc('ui/DetailHelperPanel.css')));
});

test('【検出力】判定は壊れた配線を落とす（常に描く・onToggleLayer を外す・disabled を外す・直書き・prop 未配線・CSS なし）', () => {
  assert.equal(rowsFromDxfLayerRows('const layerRows = dxfLayerRows(state);'), true);
  assert.equal(rowsFromDxfLayerRows('const layerRows = [];'), false);
  assert.equal(sectionOnlyWhenRows('{layerRows.length > 0 && ('), true);
  assert.equal(sectionOnlyWhenRows('{true && ('), false);
  const box = '<input type="checkbox" checked={r.visible} disabled={busy} onChange={() => onToggleLayer(r.name)} />';
  assert.equal(checkboxTogglesByName(box), true);
  assert.equal(checkboxTogglesByName(box.replace('onToggleLayer(r.name)', 'noop()')), false);
  assert.equal(checkboxTogglesByName(box.replace(' disabled={busy}', '')), false);
  const btn = '<button disabled={busy || layerRows.every(r => r.visible)} onClick={onAllLayersOn}>{DETAIL_HELPER_TEXT.layersAllOn}</button>';
  assert.equal(allOnButton(btn), true);
  assert.equal(allOnButton(btn.replace('busy || layerRows.every(r => r.visible)', 'busy')), false);
  assert.equal(allOnButton(btn.replace('onAllLayersOn', 'noop')), false);
  assert.equal(allOnButton(btn.replace('{DETAIL_HELPER_TEXT.layersAllOn}', '全部 on')), false);
  assert.equal(headingFromTextTable('<span>{DETAIL_HELPER_TEXT.layers}</span>'), true);
  assert.equal(headingFromTextTable('<span>レイヤ</span>'), false);
  assert.equal(noLiteralLabels('<span>{DETAIL_HELPER_TEXT.layers}</span>'), true);
  assert.equal(noLiteralLabels('<span>レイヤ</span>'), false);
  assert.equal(noLiteralLabels('<button>全部 on</button>'), false);
  assert.equal(paneForwards('onToggleLayer={onToggleLayer} onAllLayersOn={onAllLayersOn}'), true);
  assert.equal(paneForwards('onToggleLayer={onToggleLayer}'), false);
  const wired = 'onToggleLayer={name => applyDxfResult(toggleDxfLayer(dxf, name))} onAllLayersOn={() => applyDxfResult(setDxfLayers(dxf, []))}';
  assert.equal(panelWiresLayers(wired), true);
  assert.equal(panelWiresLayers(wired.replace('toggleDxfLayer(dxf, name)', 'dxf')), false);
  assert.equal(panelWiresLayers(wired.replace('setDxfLayers(dxf, [])', 'setDxfLayers(dxf, [1])')), false);
  assert.equal(panelWiresLayers(wired.replace('applyDxfResult(toggleDxfLayer', 'setDxf(toggleDxfLayer')), false);
  const apply = 'function applyDxfResult(r) { setDxf(r.dxf); setDxfMessage(r.error ? { text: r.error, isError: true } : null); }';
  assert.equal(applyReflectsDxfAndError(apply), true);
  assert.equal(applyReflectsDxfAndError(apply.replace('setDxf(r.dxf);', 'setDxf(r);')), false);
  assert.equal(applyReflectsDxfAndError(apply.replace('setDxfMessage(', 'noop(')), false);
  assert.equal(cssHasLayerList('.dthlp-layer-list { a: b } .dthlp-layer-row { c: d }'), true);
  assert.equal(cssHasLayerList('.dthlp-layer-list { a: b }'), false);
});
