// renderer/StructuralLayer.jsx の床開口×の配線をソース走査で固定する（react-konva 依存で import 実行できないため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(import.meta.dirname, 'StructuralLayer.jsx'), 'utf8');

test('【配線】StructuralLayer.jsx: openingEdgeComponents → openingCrossSegments を呼び、屋根専用平面・基礎伏図では描かない', () => {
  assert.match(src, /import \{ openingEdgeComponents \} from '\.\.\/structural\/openingBeamAxes\.js'/);
  assert.match(src, /import \{ openingCrossSegments \} from '\.\.\/structural\/openingCrossDrawing\.js'/);
  assert.match(src, /openingEdgeComponents\(beam\.graph, \{[^}]*belowGraph/s);
  assert.match(src, /openingCrossSegments\(components, beam\.graph\.beams/);
  assert.match(src, /isRoofPlane === true \|\| foundationBeams\.length > 0/);
  assert.match(src, /beamHalfWidthOf: b => \(beamRenderWidth\(b, lod\) \?\? 0\) \/ 2/);
});

test('【配線】StructuralLayer.jsx: 下階 belowGraph は column?.graph が beam.graph と異なるときだけ。キャッシュの置き場と鍵は belowGraph・主題階に依存する', () => {
  assert.match(src, /const openingBelowGraph = column\?\.graph && column\.graph !== beam\?\.graph \? column\.graph : null;/);
  assert.match(src, /graphComputed\(openingBelowGraph \?\? beam\.graph, `openingCross:\$\{beam\.graph\.plane\.id\}:\$\{lod\}`/);
  assert.match(src, /belowGraph = openingBelowGraph;/);
});

test('【配線】StructuralLayer.jsx: 床開口×は梁本体の後・自階柱（frontColumnGroups）の前に、クリック不可で描く', () => {
  const beamBody = src.indexOf('beamDrawSpans.flatMap(');
  const cross = src.indexOf('openingCrossList.map(');
  const front = src.indexOf('{frontColumnGroups.map(renderColumnGroup)}');
  assert.ok(beamBody > 0 && cross > 0 && front > 0, '描画ブロックが見つからない');
  assert.ok(beamBody < cross, '床開口×が梁本体より前にある');
  assert.ok(cross < front, '床開口×が frontColumnGroups より後ろにある');
  const block = src.slice(cross, front);
  assert.match(block, /listening=\{false\}/);
  // 一点破線（openingCrossDash＝線幅d基準 144d/3d/6d/3d）・細線（thin）
  assert.match(block, /dash=\{openingCrossDash\(viewport\.lineWeightsPx\.thin\)\}/);
  assert.doesNotMatch(block, /ROOF_FRAMING_DASH/);
  // dash は画面px単位＝strokeScaleEnabled={false} とpx線幅が前提（小屋組と同じ）。ワールド単位の thin だと実線に見える
  assert.match(block, /strokeWidth=\{viewport\.lineWeightsPx\.thin\}/);
  assert.match(block, /strokeScaleEnabled=\{false\}/);
  assert.doesNotMatch(block, /strokeWidth=\{thin\}/);
});
