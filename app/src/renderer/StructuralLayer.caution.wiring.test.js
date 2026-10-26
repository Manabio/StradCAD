// renderer/StructuralLayer.jsx の注意色（手動の梁芯に近すぎる自動の梁芯に乗る子梁。規則C 案c・S3-3）の配線を
// ソース走査で固定する（react-konva 依存で import 実行できないため）。判定の中身は
// structural/slabSecondaryBeamAxes.js nearUserSlabAxisIds（単体テストは同ファイルのテスト）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = rel => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
// コメント行を除く（コメントに書かれた識別子で一致しないように）
const code = src => src.split('\n').filter(l => !/^\s*(\/\/|\{?\/\*|\*)/.test(l)).join('\n');

const layer = code(read('StructuralLayer.jsx'));

test('【配線】StructuralLayer.jsx: 近い梁芯の集合は graphComputed 経由（主題階の梁グラフ）で求め、梁の線色だけを CAUTION_COLOR にする', () => {
  assert.match(layer, /import \{ CAUTION_COLOR \} from '\.\.\/core\/constants\.js';/);
  assert.match(layer, /import \{ nearUserSlabAxisIds \} from '\.\.\/structural\/slabSecondaryBeamAxes\.js';/);
  assert.match(layer, /graphComputed\(beam\.graph, 'nearUserSlabAxisIds', \(\) => nearUserSlabAxisIds\(beam\.graph, project\)\)/);
  assert.match(layer, /const color = cautionAxisIds\?\.has\(b\.axisCL\.id\) \? CAUTION_COLOR : colorOf\(b\.materialType\);/);
});

test('【配線】CAUTION_COLOR は梁の描画の1箇所だけ（柱・壁・スラブ・梁芯の線・由来色の表には使わない）', () => {
  assert.equal((layer.match(/CAUTION_COLOR/g) ?? []).length, 2, 'import と梁の線色の2回だけ');
  assert.doesNotMatch(code(read('canvasStyle.js')), /CAUTION_COLOR/);
  assert.match(code(read('../core/constants.js')), /export const CAUTION_COLOR = 'hsl\(48, 100%, 45%\)';/);
});

test('【配線】注意色は画面の構造モードの描画だけ: StructuralLayer を使うのは SceneLayers.jsx の構造モード分岐のみ（図面合成・出力は通らない）', () => {
  const scene = code(read('SceneLayers.jsx'));
  assert.match(scene, /appMode === 'structure' && \(\s*<StructuralLayer/);
  // StructuralLayer を import するのは SceneLayers と MemberTagLayer（定数・関数の再利用だけ）以外にない
  const importers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|jsx)$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
      if (/from '[^']*StructuralLayer\.jsx'/.test(fs.readFileSync(p, 'utf8'))) importers.push(e.name);
    }
  };
  walk(path.resolve(import.meta.dirname, '..'));
  assert.deepEqual(importers.sort(), ['MemberTagLayer.jsx', 'SceneLayers.jsx']);
});
