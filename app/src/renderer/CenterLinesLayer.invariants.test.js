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

test('【不変条件・変更していない証拠】CenterLinesLayer本体: dashは通り芯だけ長鎖線化し中心線・梁芯は[12,4,2,4]のまま、opacityは変更していない', () => {
  // 通り芯（struct）だけ長鎖線 gridLineDash、補助線は実線、それ以外（中心線・梁芯）は従来の [12,4,2,4]。
  assert.ok(bodyCodeOnly.includes("dash={isAux ? undefined : centerLineKind(cl) === 'struct' ? gridLineDash(viewport.lineWeightsPx.thin) : [12, 4, 2, 4]}"),
    '通り芯のみ gridLineDash・他は [12, 4, 2, 4] のdash式が見つからない（中心線・梁芯の一点鎖線が変わっている）');
  assert.ok(bodyCodeOnly.includes('opacity={cl.labeled || isBeamAxis ? 1 : 0.5}'),
    'opacity={cl.labeled || isBeamAxis ? 1 : 0.5} が見つからない（opacityを今回変更していない証拠が崩れている）');
});

// ガター帯の出入り: CL本体（clLines・全種別）・柱芯線（axisLines）は gutterClipRects().area の clip 付き
// Group で描画エリア矩形にクリップし（二値判定ではない）、丸ラベル（GutterLayer.jsx GutterCircleLabels）
// は isClInDrawingBand（本体が全部切り落とされる条件と同じ）で消える配線を固定する。
test('【不変条件】CenterLinesLayer本体と柱芯線は gutterClipRects().area の clip Group で描画エリアにクリップし、二値判定は持たない', () => {
  assert.ok(bodyCodeOnly.includes('const { area } = gutterClipRects(viewport, width, height);'),
    'gutterClipRects().area の取得が見つからない');
  assert.ok(/<Group\b[^>]*clipX=\{area\.x\}[^>]*clipY=\{area\.y\}[^>]*clipWidth=\{area\.width\}[^>]*clipHeight=\{area\.height\}/.test(bodyCodeOnly),
    'area 矩形の clip 付き Group が見つからない');
  assert.ok(bodyCodeOnly.includes('return clipped(clLines);') && bodyCodeOnly.includes('return clipped([...clLines, ...axisLines]);'),
    'clLines／clLines+axisLines の両経路が clip Group で包まれていない');
  assert.ok(!bodyCodeOnly.includes('isClInDrawingBand'),
    'CenterLinesLayer本体に二値判定 isClInDrawingBand が残っている（クリップ方式へ統一済み）');
});

test('【不変条件】GutterLayer.jsx の丸ラベルは isClInDrawingBand を使い、旧インライン判定を持たない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'GutterLayer.jsx'), 'utf8');
  const labelsIdx = src.indexOf('const GutterCircleLabels =');
  assert.ok(labelsIdx > 0, 'GutterCircleLabels の定義が見つからない');
  const region = stripComments(src.slice(labelsIdx, src.indexOf('\nconst ', labelsIdx + 1)));
  assert.equal((region.match(/isClInDrawingBand\(cl, viewport, width, height\)/g) ?? []).length, 2,
    'GutterCircleLabels の縦・横で isClInDrawingBand を使っていない');
  assert.ok(!region.includes('sx < INSET.left') && !region.includes('sy < INSET.top'),
    'GutterCircleLabels に旧インライン判定が残っている（本体と判定が分岐する）');
});

// 寸法線のクリップ: GRID寸法（X行・Y行の2 Group）と CENTER寸法（両経路を包む Group）の配線を固定する。
test('【不変条件】GutterLayer.jsx: GridDimensions に clip 付き Group が2つ、CenterDimensions に1つ以上ある', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'GutterLayer.jsx'), 'utf8');
  const gridIdx = src.indexOf('const GridDimensions =');
  const centerIdx = src.indexOf('const CenterDimensions =');
  assert.ok(gridIdx > 0 && centerIdx > gridIdx, 'GridDimensions / CenterDimensions の定義が見つからない');
  const gridRegion = stripComments(src.slice(gridIdx, src.indexOf('\nconst ', gridIdx + 1)));
  const centerRegion = stripComments(src.slice(centerIdx, src.indexOf('\nexport const', centerIdx)));
  const clipGroups = r => (r.match(/<Group\b[^>]*clipX=/g) ?? []).length;
  assert.equal(clipGroups(gridRegion), 2, 'GridDimensions の clipX 付き Group が2つではない');
  assert.ok(clipGroups(centerRegion) >= 1, 'CenterDimensions に clipX 付き Group が無い');
});
