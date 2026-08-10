import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '../core.js';
import { findCatalogEntry } from './openingCatalog.js';
import { buildOpeningElevation } from './openingElevationFigure.js';

// buildOpeningElevation は effectiveHeight(opening) 経由でしか height を読まないため、
// core.js の Opening インスタンスは不要——プリミティブ生成が読む最小限のプロパティを
// 持つダックタイピングの代役で足りる（openingNumbering.test.js と同じ方針）。
function makeOpening(overrides = {}) {
  return {
    width: 1690, height: 1170, sillHeight: 800, category: OpeningCategory.WINDOW, subType: 'doubleSliding',
    hingeSide: -1, swingSide: 1,
    ...overrides,
  };
}

// ---- Finding B 回帰: height に負値が混入しても姿図のrect高さは負にならない ----
test('buildOpeningElevation: height=-500（負値）でも枠のrect(h)は正値になる', () => {
  const opening = makeOpening({ height: -500 });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const outerRect = primitives.find(p => p.type === 'rect');
  assert.ok(outerRect, '枠外形のrectが存在する');
  assert.ok(outerRect.h > 0, `rectのhは正値のはず（実際: ${outerRect.h}）`);
});

test('buildOpeningElevation: 通常値では枠のrect(h)がeffectiveHeightと一致する', () => {
  const opening = makeOpening({ height: 1170 });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const outerRect = primitives.find(p => p.type === 'rect');
  assert.equal(outerRect.h, 1170);
});

// ---- tag: 左上へ移動（anchor:'start'） ----
test('buildOpeningElevation: tagありのとき左上(x:0, anchor:start)にテキストが配置される', () => {
  const opening = makeOpening();
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: 'AW-1', entry });

  const tagText = primitives.find(p => p.type === 'text' && p.text === 'AW-1');
  assert.ok(tagText, 'タグのtextプリミティブが存在する');
  assert.equal(tagText.x, 0);
  assert.equal(tagText.anchor, 'start');
});

// ---- レバーハンドル: 建具×SWING機構のみ描画 ----
test('buildOpeningElevation: 建具(fitting)×SWING機構ならレバーハンドル（rx付きrect）とhandleHeight寸法が出る（hingeSide=-1→戸先は右→寸法も右）', () => {
  const opening = makeOpening({
    category: OpeningCategory.FITTING, subType: 'singleSwing', width: 800, height: 2000, sillHeight: null,
    hingeSide: -1,
  });
  const entry = findCatalogEntry(opening.category, opening.subType); // singleSwing = SWING機構
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const capsule = primitives.find(p => p.type === 'rect' && p.rx != null);
  assert.ok(capsule, 'rx付きのカプセル形rectが存在する');
  assert.equal(capsule.w, 120);
  assert.equal(capsule.h, 15);
  assert.equal(capsule.rx, 7.5);
  // hingeSide=-1 → ヒンジx=0・戸先x=width。戸先端(width)から60mm内側、さらに120mm内側まで。
  assert.equal(capsule.x, opening.width - 180);

  // 戸先(latch)は右側（width側）なので、handleHeight寸法も右（at:width+250, foot:width, labelSide既定=右）。
  const handleDim = primitives.find(p => p.type === 'dim' && p.target === 'handleHeight');
  assert.ok(handleDim, 'handleHeight寸法が存在する');
  assert.equal(handleDim.from, -1050); // 既定値
  assert.equal(handleDim.to, 0);
  assert.equal(handleDim.at, opening.width + 250);
  assert.equal(handleDim.foot, opening.width);
  assert.equal(handleDim.labelSide, undefined);

  // 吊元（hinge）は左側なので、height寸法は左（at:-250, foot:0, labelSide:'left'）へ振り分けられる。
  const heightDim = primitives.find(p => p.type === 'dim' && p.target === 'height');
  assert.equal(heightDim.at, -250);
  assert.equal(heightDim.foot, 0);
  assert.equal(heightDim.labelSide, 'left');
});

test('buildOpeningElevation: 建具×SWINGでhingeSide=1ならカプセルは戸先(x=0)側から60mm、寸法配置も反転する（handleHeight左・height右）', () => {
  const opening = makeOpening({
    category: OpeningCategory.FITTING, subType: 'singleSwing', width: 800, height: 2000, sillHeight: null,
    hingeSide: 1,
  });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const capsule = primitives.find(p => p.type === 'rect' && p.rx != null);
  assert.equal(capsule.x, 60);

  // 戸先(latch)は左側（x=0側）なので、handleHeight寸法は左（at:-250, foot:0, labelSide:'left'）。
  const handleDim = primitives.find(p => p.type === 'dim' && p.target === 'handleHeight');
  assert.equal(handleDim.at, -250);
  assert.equal(handleDim.foot, 0);
  assert.equal(handleDim.labelSide, 'left');

  // 吊元（hinge）は右側なので、height寸法は右（at:width+250, foot:width, labelSide既定=右）＝従来どおり。
  const heightDim = primitives.find(p => p.type === 'dim' && p.target === 'height');
  assert.equal(heightDim.at, opening.width + 250);
  assert.equal(heightDim.foot, opening.width);
  assert.equal(heightDim.labelSide, undefined);
});

// ---- 開き表現の線種・向き: 一点鎖線、頂点=吊元側（戸先側2点→吊元中央1点） ----
test('buildOpeningElevation: SWINGの開き表現は一点鎖線(dash:center)で、戸先側の縦辺2点→吊元中央1点になっている（hingeSide=-1）', () => {
  const opening = makeOpening({
    category: OpeningCategory.FITTING, subType: 'singleSwing', width: 800, height: 2000, sillHeight: null,
    hingeSide: -1, // ヒンジ(吊元)x=0、戸先x=width
  });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const swingLines = primitives.filter(p => p.type === 'line' && p.dash === 'center');
  assert.equal(swingLines.length, 2, '一点鎖線(dash:center)が2本あるはず');
  for (const line of swingLines) {
    assert.equal(line.x1, opening.width, '始点(戸先側)のxはwidthのはず');
    assert.equal(line.x2, 0, '終点(吊元側)のxは0のはず');
  }
  // sillTop は -sill 由来で -0 になり得るため +0 を足して符号を正規化する（deepEqual は -0 と 0 を区別する）
  assert.deepEqual(swingLines.map(l => l.y1 + 0).sort((a, b) => a - b), [-2000, 0], '始点は戸先側縦辺の上端・下端のはず');
  assert.deepEqual(swingLines.map(l => l.y2), [-1000, -1000], '終点は吊元側の縦中央1点のはず');
  assert.equal(primitives.some(p => p.type === 'line' && p.dash === 'dashed'), false, '破線(dashed)は使わない');
});

test('buildOpeningElevation: SWINGの開き表現はhingeSide=1でも戸先側2点→吊元中央1点になっている', () => {
  const opening = makeOpening({
    category: OpeningCategory.FITTING, subType: 'singleSwing', width: 800, height: 2000, sillHeight: null,
    hingeSide: 1, // ヒンジ(吊元)x=width、戸先x=0
  });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const swingLines = primitives.filter(p => p.type === 'line' && p.dash === 'center');
  assert.equal(swingLines.length, 2);
  for (const line of swingLines) {
    assert.equal(line.x1, 0, '始点(戸先側)のxは0のはず');
    assert.equal(line.x2, opening.width, '終点(吊元側)のxはwidthのはず');
  }
  // sillTop は -sill 由来で -0 になり得るため +0 を足して符号を正規化する（deepEqual は -0 と 0 を区別する）
  assert.deepEqual(swingLines.map(l => l.y1 + 0).sort((a, b) => a - b), [-2000, 0], '始点は戸先側縦辺の上端・下端のはず');
  assert.deepEqual(swingLines.map(l => l.y2), [-1000, -1000], '終点は吊元側の縦中央1点のはず');
});

test('buildOpeningElevation: 引き違い戸（SLIDE_DOUBLE機構）ではレバーハンドルを描かず、height寸法は従来どおり右側のまま', () => {
  const opening = makeOpening({
    category: OpeningCategory.FITTING, subType: 'doubleSliding', width: 1600, height: 2000, sillHeight: null,
    hingeSide: -1,
  });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  assert.equal(primitives.some(p => p.type === 'rect' && p.rx != null), false);
  assert.equal(primitives.some(p => p.type === 'dim' && p.target === 'handleHeight'), false);

  const heightDim = primitives.find(p => p.type === 'dim' && p.target === 'height');
  assert.equal(heightDim.at, opening.width + 250);
  assert.equal(heightDim.foot, opening.width);
  assert.equal(heightDim.labelSide, undefined);
});

test('buildOpeningElevation: 窓（開き窓・SWING機構）ではカテゴリがwindowのためレバーハンドルを描かず、height寸法は従来どおり右側のまま', () => {
  const opening = makeOpening({
    category: OpeningCategory.WINDOW, subType: 'casement', width: 600, height: 900, sillHeight: 800,
    hingeSide: -1,
  });
  const entry = findCatalogEntry(opening.category, opening.subType); // casement = SWING機構
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  assert.equal(primitives.some(p => p.type === 'rect' && p.rx != null), false);
  assert.equal(primitives.some(p => p.type === 'dim' && p.target === 'handleHeight'), false);

  const heightDim = primitives.find(p => p.type === 'dim' && p.target === 'height');
  assert.equal(heightDim.at, opening.width + 250);
  assert.equal(heightDim.foot, opening.width);
  assert.equal(heightDim.labelSide, undefined);
});

// ---- QA指摘4: 狭小間口（width<180=バックセット60+カプセル幅120）ではカプセルが枠外へはみ出すため
// クランプせず非描画にする（figureBounds/縮尺が崩れるのを防ぐ。仕様判断済み） ----
test('buildOpeningElevation: 建具×SWINGでもwidth=150（180未満・hingeSide=-1）ならレバーハンドルを描かず、height寸法は従来どおり右側のまま', () => {
  const opening = makeOpening({
    category: OpeningCategory.FITTING, subType: 'singleSwing', width: 150, height: 2000, sillHeight: null,
    hingeSide: -1,
  });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  assert.equal(primitives.some(p => p.type === 'rect' && p.rx != null), false);
  assert.equal(primitives.some(p => p.type === 'dim' && p.target === 'handleHeight'), false);

  const heightDim = primitives.find(p => p.type === 'dim' && p.target === 'height');
  assert.equal(heightDim.at, opening.width + 250);
  assert.equal(heightDim.foot, opening.width);
  assert.equal(heightDim.labelSide, undefined);
});

test('buildOpeningElevation: 建具×SWINGでもwidth=150（180未満・hingeSide=1）ならレバーハンドルを描かず、height寸法は従来どおり右側のまま', () => {
  const opening = makeOpening({
    category: OpeningCategory.FITTING, subType: 'singleSwing', width: 150, height: 2000, sillHeight: null,
    hingeSide: 1,
  });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  assert.equal(primitives.some(p => p.type === 'rect' && p.rx != null), false);
  assert.equal(primitives.some(p => p.type === 'dim' && p.target === 'handleHeight'), false);

  const heightDim = primitives.find(p => p.type === 'dim' && p.target === 'height');
  assert.equal(heightDim.at, opening.width + 250);
  assert.equal(heightDim.foot, opening.width);
  assert.equal(heightDim.labelSide, undefined);
});

test('buildOpeningElevation: handleHeight編集値がレバーハンドルの高さ・寸法に反映される', () => {
  const opening = makeOpening({
    category: OpeningCategory.FITTING, subType: 'singleSwing', width: 800, height: 2000, sillHeight: null,
    hingeSide: -1, handleHeight: 900,
  });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const capsule = primitives.find(p => p.type === 'rect' && p.rx != null);
  assert.equal(capsule.y, -900 - 7.5);

  const handleDim = primitives.find(p => p.type === 'dim' && p.target === 'handleHeight');
  assert.equal(handleDim.from, -900);
  assert.equal(handleDim.label, '900');
});
