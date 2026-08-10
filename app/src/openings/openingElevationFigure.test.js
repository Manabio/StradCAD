import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '../core.js';
import { findCatalogEntry, FITTING_CATALOG, WINDOW_CATALOG } from './openingCatalog.js';
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

// ================================================================
// 窓・扉バリエーション追加（実装仕様書 §6-c）: 新機構でもmechanismPrimitivesが例外を出さず、
// 未対応の機構はラベル表示へフォールバックすることを確認する。
// ================================================================

// ---- (c) 全カタログエントリを総当たりし、buildOpeningElevationが例外を出さずプリミティブを返す ----
test('buildOpeningElevation: FITTING_CATALOG/WINDOW_CATALOGの全エントリで例外を出さない', () => {
  for (const entry of FITTING_CATALOG) {
    const opening = makeOpening({
      category: OpeningCategory.FITTING, subType: entry.key, width: entry.defaultWidth, height: entry.defaultHeight,
      sillHeight: null, hingeSide: -1, swingSide: 1,
    });
    let primitives;
    assert.doesNotThrow(() => { primitives = buildOpeningElevation(opening, { tag: null, entry }); }, `${entry.key}で例外`);
    assert.ok(Array.isArray(primitives) && primitives.length > 0, `${entry.key}: 枠・寸法を含む最低限のプリミティブが返るはず`);
  }
  for (const entry of WINDOW_CATALOG) {
    const opening = makeOpening({
      category: OpeningCategory.WINDOW, subType: entry.key, width: entry.defaultWidth, height: entry.defaultHeight,
      sillHeight: 800, hingeSide: -1, swingSide: 1,
    });
    let primitives;
    assert.doesNotThrow(() => { primitives = buildOpeningElevation(opening, { tag: null, entry }); }, `${entry.key}で例外`);
    assert.ok(Array.isArray(primitives) && primitives.length > 0, `${entry.key}: 枠・寸法を含む最低限のプリミティブが返るはず`);
  }
});

// ---- 未実装機構(姿図)は種別ラベルのテキストへフォールバックする ----
// §4実装完了によりFITTING_CATALOG/WINDOW_CATALOGの全エントリが姿図を持つため、フォールバック分岐
// （mechanismPrimitives switchに一致しない機構）はカタログに存在しない合成entryで直接検証する。
test('buildOpeningElevation: mechanismPrimitivesが未対応の機構は種別ラベルのテキストにフォールバックする', () => {
  const entry = { key: 'yetToBeImplemented', label: '未実装種別', mechanism: 'notYetImplementedMechanism' };
  const opening = makeOpening({ category: OpeningCategory.FITTING, subType: entry.key, width: 1600, height: 2000, sillHeight: null });
  const primitives = buildOpeningElevation(opening, { tag: null, entry });
  assert.ok(primitives.some(p => p.type === 'text' && p.text === entry.label));
});

// ---- 失敗系: 未知のsubType（entry=null）でも例外を出さず、枠・寸法のみ返す ----
test('【失敗系】buildOpeningElevation: 未知のsubType（entry=null）でも例外を出さない', () => {
  const opening = makeOpening({ category: OpeningCategory.WINDOW, subType: 'unknownType', width: 600, height: 900, sillHeight: 800 });
  let primitives;
  assert.doesNotThrow(() => { primitives = buildOpeningElevation(opening, { tag: null, entry: null }); });
  assert.ok(primitives.some(p => p.type === 'rect'), '枠のrectは機構に関わらず描かれるはず');
  assert.equal(primitives.filter(p => p.type === 'text').length, 0, 'entry=nullではラベルテキストも出ない（entry.labelが読めないため）・tagもnull');
});

// ================================================================
// 窓・扉バリエーション追加 実装仕様書 §4（姿図）: 新機構の形状テスト
// ================================================================

// ---- 修正①: SLIDE_DOUBLE（引き違い窓）は召し合わせ縦線2本＋短い水平矢印2本（ガラス斜線なし） ----
test('buildOpeningElevation: SLIDE_DOUBLE（引き違い窓）は召し合わせ框の縦線2本＋障子ごとの水平矢印2本を含む', () => {
  const entry = findCatalogEntry('window', 'doubleSliding');
  const opening = makeOpening({ width: 1690, height: 1170, sillHeight: 800, subType: 'doubleSliding' });
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const verticalLines = primitives.filter(p => p.type === 'line' && p.x1 === p.x2);
  assert.equal(verticalLines.length, 2, '召し合わせ框の縦線が2本あるはず');
  assert.deepEqual(verticalLines.map(l => l.x1).sort((a, b) => a - b), [opening.width / 2 - 20, opening.width / 2 + 20]);

  const arrows = primitives.filter(p => p.type === 'arrow');
  assert.equal(arrows.length, 2, '障子ごとの水平矢印が2本あるはず');
  assert.ok(arrows.every(a => a.y1 === a.y2), '矢印は水平のはず');

  assert.equal(primitives.some(p => p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2), false, 'ガラス斜線は描かないはず');
});

// ---- TILT（内倒し窓）は破線Vで、apexが下辺中央 ----
test('buildOpeningElevation: TILT（内倒し窓）は破線Vで頂点が下辺中央', () => {
  const entry = findCatalogEntry('window', 'hopper');
  const opening = makeOpening({ width: 600, height: 500, sillHeight: 800, subType: 'hopper' });
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const veeLines = primitives.filter(p => p.type === 'line' && p.dash === 'dashed');
  assert.equal(veeLines.length, 2, '破線Vの2本があるはず');
  const sillTop = -opening.sillHeight;
  assert.ok(veeLines.every(l => l.x2 === opening.width / 2 && l.y2 === sillTop), '頂点は下辺中央(width/2, sillTop)のはず');
});

// ---- SLIDE_LAYOUT: fixパネルには中央にFIXテキスト、可動パネルには水平矢印 ----
test('buildOpeningElevation: SLIDE_LAYOUT(singleSliding片引き窓)はfixパネルに中央FIXテキスト・可動パネルに矢印', () => {
  const entry = findCatalogEntry('window', 'singleSliding');
  const opening = makeOpening({ width: 1235, height: 1170, sillHeight: 800, subType: 'singleSliding' });
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const fixText = primitives.find(p => p.type === 'text' && p.text === 'FIX');
  assert.ok(fixText, 'FIXテキストが存在するはず');
  const panelWidth = opening.width / 2;
  assert.equal(fixText.x, panelWidth * 1.5, 'fixパネル(2枚目)の中央に配置されるはず');

  assert.ok(primitives.some(p => p.type === 'arrow'), '可動パネル(1枚目)に矢印があるはず');

  const dividers = primitives.filter(p => p.type === 'line' && p.x1 === p.x2);
  assert.equal(dividers.length, 1, 'パネル境界の縦線はpanels.length-1=1本のはず');
  assert.equal(dividers[0].x1, panelWidth);
});

// ---- PIVOT（縦軸回転窓）は一点鎖線の縦軸を含む ----
test('buildOpeningElevation: PIVOT（縦軸回転窓）はwidth/2に一点鎖線の縦軸を含む', () => {
  const entry = findCatalogEntry('window', 'pivot');
  const opening = makeOpening({ width: 600, height: 900, sillHeight: 800, subType: 'pivot' });
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const axis = primitives.find(p => p.type === 'line' && p.dash === 'center' && p.x1 === p.x2);
  assert.ok(axis, '一点鎖線の縦軸があるはず');
  assert.equal(axis.x1, opening.width / 2);

  const dashedLines = primitives.filter(p => p.type === 'line' && p.dash === 'dashed');
  assert.equal(dashedLines.length, 4, '菱形を構成する破線Vが2組(4本)あるはず');
});

// ---- SWING_DOUBLE（両開き戸/窓）は中央縦線1本＋一点鎖線Vが左右両leafぶん(4本)ある ----
test('buildOpeningElevation: SWING_DOUBLE（両開き戸）は中央縦線1本＋一点鎖線V4本（両leafぶん）', () => {
  const entry = findCatalogEntry('fitting', 'doubleSwing');
  const opening = makeOpening({ category: OpeningCategory.FITTING, width: 1600, height: 2000, sillHeight: null, subType: 'doubleSwing' });
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const solidCenterLine = primitives.find(p => p.type === 'line' && p.dash == null && p.x1 === p.x2 && p.x1 === opening.width / 2);
  assert.ok(solidCenterLine, '中央縦線(dashなし)があるはず');

  const centerDashLines = primitives.filter(p => p.type === 'line' && p.dash === 'center');
  assert.equal(centerDashLines.length, 4, '左右2leafぶんの一点鎖線Vで4本のはず');
});

// ---- FIRE_DOOR: fireLeaves:2はSWING_DOUBLEと同形（中央縦線＋一点鎖線4本）、1はSWINGと同形（一点鎖線2本） ----
test('buildOpeningElevation: FIRE_DOOR(両開き)はSWING_DOUBLEと同形、(片開き)はSWINGと同形', () => {
  const doubleEntry = findCatalogEntry('fitting', 'fireDoorDouble');
  const doubleOpening = makeOpening({ category: OpeningCategory.FITTING, width: 1800, height: 2000, sillHeight: null, subType: 'fireDoorDouble' });
  const doublePrims = buildOpeningElevation(doubleOpening, { tag: null, entry: doubleEntry });
  assert.equal(doublePrims.filter(p => p.type === 'line' && p.dash === 'center').length, 4);
  assert.ok(doublePrims.some(p => p.type === 'line' && p.dash == null && p.x1 === p.x2));

  const singleEntry = findCatalogEntry('fitting', 'fireDoorSingle');
  const singleOpening = makeOpening({ category: OpeningCategory.FITTING, width: 900, height: 2000, sillHeight: null, subType: 'fireDoorSingle', hingeSide: -1 });
  const singlePrims = buildOpeningElevation(singleOpening, { tag: null, entry: singleEntry });
  assert.equal(singlePrims.filter(p => p.type === 'line' && p.dash === 'center').length, 2);
});

// ---- FOLD/FIRE_FOLD: パネル分割縦線(n-1本)＋各パネルに破線V ----
test('buildOpeningElevation: FOLD(折れ戸)は分割縦線1本、FIRE_FOLD(常時開放式防火折戸)は分割縦線3本', () => {
  const foldEntry = findCatalogEntry('fitting', 'folding');
  const foldOpening = makeOpening({ category: OpeningCategory.FITTING, width: 800, height: 2000, sillHeight: null, subType: 'folding' });
  const foldPrims = buildOpeningElevation(foldOpening, { tag: null, entry: foldEntry });
  const foldDividers = foldPrims.filter(p => p.type === 'line' && p.dash == null && p.x1 === p.x2);
  assert.equal(foldDividers.length, 1);

  const fireFoldEntry = findCatalogEntry('fitting', 'fireFold90');
  const fireFoldOpening = makeOpening({ category: OpeningCategory.FITTING, width: 1600, height: 2000, sillHeight: null, subType: 'fireFold90' });
  const fireFoldPrims = buildOpeningElevation(fireFoldOpening, { tag: null, entry: fireFoldEntry });
  const fireFoldDividers = fireFoldPrims.filter(p => p.type === 'line' && p.dash == null && p.x1 === p.x2);
  assert.equal(fireFoldDividers.length, 3);
  assert.equal(fireFoldPrims.filter(p => p.type === 'line' && p.dash === 'dashed').length, 8, '4パネル×V2本=8本のはず');
});
