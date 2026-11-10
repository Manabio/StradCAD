// 他モードの 1 階（相当）へ重ねる敷地の境界線の配線（.jsx は node:test から単体 import できないため、ソース文字列を検査する。
// 前例: renderer/SitePlacementLayer.wiring.test.js）。コメントは除外して検査する。純モジュール側は
// site/sitePlacementView.test.js（composeSiteBoundaryOverlay）・site/siteBoundaryChain.test.js・floorNumber.test.js・planFigureVisibility.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}
const code = rel => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));
const count = (text, re) => (text.match(re) ?? []).length;

const layer = code('./SiteBoundaryOverlayLayer.jsx');
const scene = code('./SceneLayers.jsx');

test('SiteBoundaryOverlayLayer: placement が無ければ描かない（overlay が null なら null を返す）', () => {
  assert.match(layer, /const overlay = composeSiteBoundaryOverlay\(\{ site, scale: viewport\.scaleX \}\);/);
  assert.match(layer, /if \(!overlay\) return null;/);
});

test('SiteBoundaryOverlayLayer: 境界線の runs・角の丸は配置の変換 Group の中、境界線ラベルは Group の外。すべて listening しない', () => {
  assert.match(layer, /<Group \{\.\.\.siteTransformGroupProps\(overlay\.transform\)\} listening=\{false\}>/);
  const groupAt = layer.indexOf('<Group ');
  const groupEnd = layer.indexOf('</Group>');
  const chainsAt = layer.indexOf('overlay.chains.flatMap');
  const cornersAt = layer.indexOf('overlay.corners.map');
  const labelsAt = layer.indexOf('overlay.labels.map');
  assert.ok(groupAt < chainsAt && chainsAt < cornersAt && cornersAt < groupEnd, '線・角は Group の中');
  assert.ok(labelsAt > groupEnd, 'ラベルは Group の外（配置図座標）');
  const shapes = count(layer, /<(Line|Circle|Group|Text)\b/g);
  assert.equal(shapes, 4, 'Line・Circle・Text・Group だけ（通り芯・寸法・頂点番号は描かない）');
  assert.equal(count(layer, /listening=\{false\}/g), shapes, '当たりなし（全部 listening={false}）');
  assert.ok(!/onClick|onTap|name=\{SITE_HIT_NODE_NAME\}|dash=/.test(layer), 'クリックなし・当たり名なし・dash なし（runs で描く）');
  assert.ok(!/gridLines|grid\.|roofLines|placementVertexLabelText/.test(layer), '通り芯・屋根・頂点番号は含めない');
});

test('SiteBoundaryOverlayLayer: 線は SITE_LINE_COLOR・境界線の線幅（siteLineWeightKey(true,false)）、角の丸は SITE_CORNER_MARK_*、ラベルは SitePlacementLayer と同じ箱', () => {
  assert.match(layer, /stroke=\{SITE_LINE_COLOR\}\s+strokeWidth=\{lineWidth\}/);
  assert.match(layer, /const lineWidth = viewport\.lineWeightsPx\[siteLineWeightKey\(true, false\)\];/);
  assert.match(layer, /const markR = SITE_CORNER_MARK_RADIUS_PX \/ viewport\.scaleX;/);
  assert.match(layer, /strokeWidth=\{viewport\.lineWeightsPx\[SITE_CORNER_MARK_WEIGHT\]\}/);
  assert.match(layer, /const boundaryBoxW = SITE_BOUNDARY_LABEL_BOX_PX \/ viewport\.scaleX;/);
  assert.ok(!/BOUNDARY_LABEL_BOX_PX = /.test(layer), '箱幅の定数は siteLineStyle.js 1 か所');
  assert.match(layer, /text=\{l\.text\}/);
  assert.match(layer, /rotation=\{l\.rotation\}/);
  assert.match(layer, /offsetX=\{boundaryBoxW \/ 2\}/);
});

test('SceneLayers: 境界線の重ねは shouldShowSiteBoundaryOverlay(appMode)・配置の指定・isGroundFloorEquivalent の 3 条件で出し、SiteBoundaryOverlayLayer に site・viewport を渡す', () => {
  assert.match(scene, /const siteBoundaryOverlayShown = shouldShowSiteBoundaryOverlay\(appMode\) && project\.site\.placement != null\s+&& isGroundFloorEquivalent\(project\.activePlane, project\.planes\);/);
  assert.match(scene, /\{siteBoundaryOverlayShown && <SiteBoundaryOverlayLayer site=\{project\.site\} viewport=\{viewport\} \/>\}/);
  assert.match(scene, /import \{ SiteBoundaryOverlayLayer \} from '\.\/SiteBoundaryOverlayLayer\.jsx';/);
  assert.ok(!/appMode === 'floorplan' \|\| appMode === 'finish'/.test(scene), 'モードの列挙は述語 1 か所（SceneLayers に直書きしない）');
  // 展開・立面の早期 return より後（平面系のレイヤー束の中）。敷地の配置図（SitePlacementLayer）の直後
  assert.ok(scene.indexOf('siteBoundaryOverlayShown &&') > scene.indexOf("if (appMode === 'facade')"));
  assert.ok(scene.indexOf('<SiteBoundaryOverlayLayer') > scene.indexOf('<SitePlacementLayer'));
});
