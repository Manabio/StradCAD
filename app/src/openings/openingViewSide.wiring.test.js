// 見る側の配線（本番の呼び出し箇所のソース文字列検査。elevationBand.wiring.test.js と同じ流儀）。
// 展開図は viewerPerp＝face.inward（部屋側）、立面は viewerPerp＝segment.outwardSign（外）。符号を反転すると
// 扉の実線／一点鎖線が全面で逆になるが、単体の純関数テストでは検出できないため呼び出し側を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '..');
const codeOf = rel => fs.readFileSync(path.join(srcDir, rel), 'utf8').split(/\r?\n/)
  .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
  .map(line => line.replace(/\s\/\/.*$/, '')).join('\n');

const elevation = codeOf('elevation/elevationFigure.js');
const facade = codeOf('facade/facadeOpenings.js');

const ELEVATION_CALL = /openingOpensTowardViewer\(o, mechanism, \{\s*viewerPerp: face\.inward,\s*exteriorPerp: openingExteriorPerp\(o, mechanism, graph\),/;
// 本番の buildFaceFigure → appendOpenings の呼び出しで graph を渡している（渡さないと外壁の窓の室外側が引けず null になる）
// （行頭＝呼び出し。`function appendOpenings(` の定義側の引数では一致させない）
const ELEVATION_GRAPH_PASS = /^[ \t]*appendOpenings\(prims, \{[^}]*\bgraph\b/m;
// 省略形 `towardViewer,`（`towardViewer: null` ではない）で姿図へ渡す
const ELEVATION_PASS = /minFaceMm, towardViewer,\s*\}\)/;
const FACADE_CALL = /openingOpensTowardViewer\(o, entry\.mechanism, \{\s*viewerPerp: segment\.outwardSign,\s*exteriorPerp: segment\.outwardSign,/;
const FACADE_PASS = /minFaceMm, towardViewer,\s*\}\)/;

test('展開図: 見る側の方向は face.inward（符号反転・dirSign ではない）・室外側は graph から引き、結果を姿図へ渡す', () => {
  assert.match(elevation, ELEVATION_CALL);
  assert.match(elevation, ELEVATION_GRAPH_PASS);
  assert.match(elevation, ELEVATION_PASS);
  assert.match(elevation, /import \{[^}]*\bopeningOpensTowardViewer\b[^}]*\} from '\.\.\/openings\/openingViewSide\.js'/);
});

test('立面図: 見る側の方向・室外側の方向とも segment.outwardSign で、結果を姿図へ渡す', () => {
  assert.match(facade, FACADE_CALL);
  assert.match(facade, FACADE_PASS);
  assert.match(facade, /import \{[^}]*\bopeningOpensTowardViewer\b[^}]*\} from '\.\.\/openings\/openingViewSide\.js'/);
});

test('検出力: 符号反転・別の向き（dirSign）・渡し忘れに置き換えた文字列では落ちる', () => {
  for (const wrong of ['-face.inward', 'face.dirSign', '(-face.inward)']) {
    assert.doesNotMatch(elevation.replace('viewerPerp: face.inward', `viewerPerp: ${wrong}`), ELEVATION_CALL, wrong);
  }
  for (const wrong of ['-segment.outwardSign', 'segment.value', '(-segment.outwardSign)']) {
    assert.doesNotMatch(facade.replace('viewerPerp: segment.outwardSign', `viewerPerp: ${wrong}`), FACADE_CALL, wrong);
    assert.doesNotMatch(facade.replace('exteriorPerp: segment.outwardSign', `exteriorPerp: ${wrong}`), FACADE_CALL, wrong);
  }
  // 室外側を null に固定する・graph を渡さない
  assert.doesNotMatch(elevation.replace('exteriorPerp: openingExteriorPerp(o, mechanism, graph),', 'exteriorPerp: null,'), ELEVATION_CALL);
  assert.doesNotMatch(elevation.replace('openings, face, graph, project,', 'openings, face, project,'), ELEVATION_GRAPH_PASS);
  // towardViewer を渡し忘れる・null に固定する
  for (const wrong of [', minFaceMm,', ', minFaceMm, towardViewer: null,']) {
    assert.doesNotMatch(elevation.replace(', minFaceMm, towardViewer,', wrong), ELEVATION_PASS, wrong);
    assert.doesNotMatch(facade.replace(', minFaceMm, towardViewer,', wrong), FACADE_PASS, wrong);
  }
});
