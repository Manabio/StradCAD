// renderer/CenterLinesLayer.jsx のソース走査による不変条件テスト（色定数の集約・CL由来色分けの
// 配線固定。OpeningsLayer.wiring.test.js・StructuralLayer.invariants.test.js と同じ型）。
// CenterLinesLayer.jsx は react-konva に依存するため import して実行できず、node:test から直接
// 検証できるのはソーステキストの構造だけ——CenterLinesLayer本体の関数本体を切り出し、行頭コメント
// （`//`・`*`）を除いた文字列に対して判定する（コメント文中の言及への誤検知を避けるため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource() {
  return fs.readFileSync(path.resolve(import.meta.dirname, 'CenterLinesLayer.jsx'), 'utf8');
}

// 行頭コメント（`//`・`*`・`/*`で始まる行）を除外する（OpeningsLayer.wiring.test.jsと同じ方針）。
function stripComments(text) {
  return text.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n');
}

// CenterLinesLayer本体（`export const CenterLinesLayer = observer((...) => {` から、対応する
// `});` まで）だけを切り出す——切り出し範囲には（同じ関数内の）axisLinesも含まれる。誤って含めない
// ようにしているのは次のexport（IntersectionMarkers）の領域だけ——「次の `export const` の直前まで」
// で区切る。
function centerLinesLayerBody(src) {
  const startIdx = src.indexOf('export const CenterLinesLayer =');
  assert.ok(startIdx >= 0, 'export const CenterLinesLayer = ... が見つからない');
  const rest = src.slice(startIdx);
  const nextExportIdx = rest.indexOf('\nexport const', 1);
  assert.ok(nextExportIdx > 0, 'CenterLinesLayer本体の終端（次のexport const）が見つからない');
  return rest.slice(0, nextExportIdx);
}

const bodyCodeOnly = stripComments(centerLinesLayerBody(readSource()));

test('【不変条件】CenterLinesLayer本体: CLのstrokeはoriginColor(centerLineOriginColorKey(cl))経由で、旧固定色\'#64748b\'は使わない', () => {
  assert.ok(/stroke=\{originColor\(centerLineOriginColorKey\(cl\)\)\}/.test(bodyCodeOnly),
    'stroke={originColor(centerLineOriginColorKey(cl))} が見つからない');
  assert.ok(!bodyCodeOnly.includes('#64748b'), "旧固定色 '#64748b' がCenterLinesLayer本体に残っている");
});

test('【不変条件】CenterLinesLayer.jsx: originColor・centerLineOriginColorKeyをそれぞれ専用モジュールからimportしている', () => {
  const src = readSource();
  assert.ok(/import\s*\{\s*originColor\s*\}\s*from\s*'\.\/canvasStyle\.js'/.test(src),
    "originColor を './canvasStyle.js' から import していない");
  assert.ok(/import\s*\{\s*centerLineOriginColorKey\s*\}\s*from\s*'\.\/originColorKey\.js'/.test(src),
    "centerLineOriginColorKey を './originColorKey.js' から import していない");
});

test('【不変条件・変更していない証拠】柱芯オフセット線(axisLines)のstrokeは今回対象外のため固定色\'#3b82f6\'のまま', () => {
  const src = readSource();
  const axisLinesIdx = src.indexOf('const axisLines =');
  assert.ok(axisLinesIdx > 0, 'axisLines の定義が見つからない');
  const axisLinesRegion = src.slice(axisLinesIdx);
  assert.ok(/stroke="#3b82f6"/.test(axisLinesRegion), 'axisLines のstrokeが固定色#3b82f6のままではない（対象外の変更）');
});

test('【不変条件・変更していない証拠】CenterLinesLayer本体: dash・opacityは今回対象外のため変更していない', () => {
  assert.ok(bodyCodeOnly.includes('dash={isAux ? undefined : [12, 4, 2, 4]}'),
    'dash={isAux ? undefined : [12, 4, 2, 4]} が見つからない（dashを今回変更していない証拠が崩れている）');
  assert.ok(bodyCodeOnly.includes('opacity={cl.labeled || isBeamAxis ? 1 : 0.5}'),
    'opacity={cl.labeled || isBeamAxis ? 1 : 0.5} が見つからない（opacityを今回変更していない証拠が崩れている）');
});
