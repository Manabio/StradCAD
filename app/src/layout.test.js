// 展開図の描画域（elevationViewRect）。横長は上帯（TOP_BAR）・左帯（LEFT_BAR）を除き、縦長は全画面。
// ElevationModeState.viewSize と SceneLayers の Group（原点＋クリップ）が同じ矩形を使う前提の単一の真実源。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { elevationViewRect, TOP_BAR, LEFT_BAR } from './layout.js';

const readSrc = rel => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');

test('elevationViewRect: 横長は上帯・左帯を除いた矩形（原点は帯の内側・大きさは帯ぶん縮む）', () => {
  const r = elevationViewRect({ width: 1200, height: 800 });
  assert.deepEqual(r, { x: LEFT_BAR, y: TOP_BAR, width: 1200 - LEFT_BAR, height: 800 - TOP_BAR });
});

test('elevationViewRect: 縦長は全画面（原点 0・大きさそのまま）', () => {
  assert.deepEqual(elevationViewRect({ width: 800, height: 1200 }), { x: 0, y: 0, width: 800, height: 1200 });
});

test('elevationViewRect: 正方形は縦長扱い（width > height でないので帯を除かない）', () => {
  assert.deepEqual(elevationViewRect({ width: 900, height: 900 }), { x: 0, y: 0, width: 900, height: 900 });
});

test('elevationViewRect: 帯より小さい横長画面でも大きさが負にならない', () => {
  const r = elevationViewRect({ width: LEFT_BAR - 1, height: TOP_BAR - 2 });
  assert.equal(r.width, 0);
  assert.equal(r.height, 0);
});

// 配線: 倍率・命中側（App.jsx → ElevationModeState.viewSize）と描画側（SceneLayers の Group）が同じ矩形を使う。
// 片方だけ size に戻ると「見える位置と押した位置の帯がずれる」のに単体テストは緑のままなので、ソースで縛る。
test('展開図の描画域: App.jsx（生成時・setViewSize）と SceneLayers.jsx（Group 原点＋クリップ・size）が同じ elevationViewRect を使う', () => {
  const app = readSrc('./App.jsx');
  assert.match(app, /new m\.ElevationModeState\(graph, project, elevationViewRect\(size\), screenPxPerMm\)/, '生成時の viewSize が描画域の矩形でない');
  assert.match(app, /setViewSize\?\.\(appMode === 'elevation' \? elevationViewRect\(size\) : size\)/, 'setViewSize が展開のとき描画域の矩形を渡していない');
  const scene = readSrc('./renderer/SceneLayers.jsx');
  const elev = scene.slice(scene.indexOf("if (appMode === 'elevation') {"), scene.indexOf("if (appMode === 'facade') {"));
  assert.match(elev, /const rect = elevationViewRect\(size\);/, '展開分岐が elevationViewRect を使っていない');
  assert.match(elev, /<Group x=\{rect\.x\} y=\{rect\.y\} clipX=\{0\} clipY=\{0\} clipWidth=\{rect\.width\} clipHeight=\{rect\.height\}>/, 'Group の原点・クリップが矩形でない');
  assert.match(elev, /<ElevationLayer mode=\{mode\} size=\{rect\}/, 'ElevationLayer の size が矩形でない');
});
