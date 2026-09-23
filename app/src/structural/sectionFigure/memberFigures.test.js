// memberFigures.js（部材別 断面図ジェネレータ）の回帰テスト。ステップ9a。
//
// 【特性化テスト（ピン留め）】このファイルの下半分（「ピン留め」ブロック）は、
// sectionOf 注入口を入れる**前**の memberFigures.js の出力をそのまま期待値化したもの
// （primitives.map(p => JSON.stringify(p))）。意図的な出力変更なら期待値を採り直すこと。
// 採取順: ①本ファイルを期待値空で書く → ②変更前の memberFigures.js に対して実行し出力を
// 期待値に埋める → ③sectionOf 注入口を実装（:147・:263 差し替え）→ ④緑を確認 →
// ⑤期待値を1つ手で壊して赤になることを確認（検出力）→ 戻す。
//
// 【注入テスト】D1（ステップ9設計）: sectionOf(ctx, id) = (ctx?.resolveSection ?? findSectionEntry)(id)。
// resolveSection を渡したらそれが権威——内部で findSectionEntry へ再フォールバックしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberFigure } from './memberFigures.js';
import { findSectionEntry } from '../sectionCatalog.js';

// ================================================================
// ピン留め（sectionOf 導入前の出力を固定）
// ================================================================

test('ピン留め: columnMap（STEEL-H300x150、ctx={}）', () => {
  const { primitives, scale } = memberFigure({ sectionDefId: 'STEEL-H300x150' }, 'columnMap', {});
  assert.equal(scale, undefined);
  assert.deepEqual(primitives.map(p => JSON.stringify(p)), [
    '{"type":"hSection","x":-75,"y":-150,"w":150,"h":300,"web":6.5,"flange":9,"fill":"#475569"}',
    '{"type":"line","x1":0,"y1":-750,"x2":0,"y2":330,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"line","x1":-795,"y1":0,"x2":375,"y2":0,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"text","x":0,"y":-840,"text":"X","anchor":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"text","x":-885,"y":0,"text":"Y","anchor":"end","baseline":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"circle","cx":345,"cy":-150,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":345,"cy":150,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"v","from":-150,"to":150,"at":345,"label":300,"footLen":96,"foot":75}',
    '{"type":"circle","cx":-75,"cy":420,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":75,"cy":420,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"h","from":-75,"to":75,"at":420,"label":150,"footLen":96,"foot":150}',
  ]);
});

test('ピン留め: columnMap（WOOD-120x120、ctx={}）', () => {
  const { primitives, scale } = memberFigure({ sectionDefId: 'WOOD-120x120' }, 'columnMap', {});
  assert.equal(scale, undefined);
  assert.deepEqual(primitives.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":-60,"y":-60,"w":120,"h":120}',
    '{"type":"line","x1":0,"y1":-460,"x2":0,"y2":180,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"line","x1":-540,"y1":0,"x2":260,"y2":0,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"text","x":0,"y":-520,"text":"X","anchor":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"text","x":-600,"y":0,"text":"Y","anchor":"end","baseline":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"circle","cx":240,"cy":-60,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":240,"cy":60,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"v","from":-60,"to":60,"at":240,"label":120,"footLen":64,"foot":60}',
    '{"type":"circle","cx":-60,"cy":240,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":60,"cy":240,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"h","from":-60,"to":60,"at":240,"label":120,"footLen":64,"foot":60}',
  ]);
});

test('ピン留め: beamMap（STEEL、STEEL-H300x150、ctx={}）', () => {
  const { primitives, scale } = memberFigure({ materialType: 'STEEL', sectionDefId: 'STEEL-H300x150' }, 'beamMap', {});
  assert.equal(scale, undefined);
  assert.deepEqual(primitives.map(p => JSON.stringify(p)), [
    '{"type":"levelLine","y":-72,"label":"FL","layoutId":"levelLine:FL"}',
    '{"type":"hSection","x":-75,"y":0,"w":150,"h":300,"web":6.5,"flange":9,"fill":"#475569","layoutId":"shape:section"}',
    '{"type":"circle","cx":183,"cy":0,"rPx":1.25,"fill":"#64748b","layoutId":"dim:height"}',
    '{"type":"circle","cx":183,"cy":300,"rPx":1.25,"fill":"#64748b","layoutId":"dim:height"}',
    '{"type":"dim","dir":"v","from":0,"to":300,"at":183,"label":300,"foot":75,"layoutId":"dim:height"}',
    '{"type":"circle","cx":-75,"cy":408,"rPx":1.25,"fill":"#64748b","layoutId":"dim:width"}',
    '{"type":"circle","cx":75,"cy":408,"rPx":1.25,"fill":"#64748b","layoutId":"dim:width"}',
    '{"type":"dim","dir":"h","from":-75,"to":75,"at":408,"label":150,"foot":300,"layoutId":"dim:width"}',
  ]);
});

test('ピン留め: columnMap（未知の sectionDefId → 既定300×300 rect, hatch:concrete）', () => {
  const { primitives, scale } = memberFigure({ sectionDefId: 'NOPE-XXX' }, 'columnMap', {});
  assert.equal(scale, undefined);
  assert.deepEqual(primitives.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":-150,"y":-150,"w":300,"h":300,"hatch":"concrete"}',
    '{"type":"line","x1":0,"y1":-750,"x2":0,"y2":330,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"line","x1":-870,"y1":0,"x2":450,"y2":0,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"text","x":0,"y":-840,"text":"X","anchor":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"text","x":-960,"y":0,"text":"Y","anchor":"end","baseline":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"circle","cx":420,"cy":-150,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":420,"cy":150,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"v","from":-150,"to":150,"at":420,"label":300,"footLen":96,"foot":150}',
    '{"type":"circle","cx":-150,"cy":420,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":150,"cy":420,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"h","from":-150,"to":150,"at":420,"label":300,"footLen":96,"foot":150}',
  ]);
});

test('ピン留め: columnMap（frame指定・rigid・偏芯あり → 2パス=annotatedFigure経路、scaleも固定）', () => {
  const { primitives, scale } = memberFigure(
    { sectionDefId: 'STEEL-H300x150' },
    'columnMap',
    { rigid: true, axisOffsetX: 100, axisOffsetY: 50, frame: { maxWidth: 340, maxHeight: 320 } },
  );
  assert.equal(scale, 1 / 3);
  assert.deepEqual(primitives.map(p => JSON.stringify(p)), [
    '{"type":"hSection","x":25,"y":-100,"w":150,"h":300,"web":6.5,"flange":9,"fill":"#475569"}',
    '{"type":"line","x1":0,"y1":-429.99999999999994,"x2":0,"y2":299,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"line","x1":-396.00000000000006,"y1":0,"x2":340,"y2":0,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"text","x":0,"y":-479.49999999999994,"text":"X","anchor":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"text","x":-445.50000000000006,"y":0,"text":"Y","anchor":"end","baseline":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"line","x1":100,"y1":-429.99999999999994,"x2":100,"y2":299,"dash":"center","stroke":"#64748b"}',
    '{"type":"text","x":100,"y":-479.49999999999994,"text":"柱芯","anchor":"middle","size":10,"fill":"#64748b"}',
    '{"type":"line","x1":-396.00000000000006,"y1":50,"x2":340,"y2":50,"dash":"center","stroke":"#64748b"}',
    '{"type":"text","x":-445.50000000000006,"y":50,"text":"柱芯","anchor":"end","baseline":"middle","size":10,"fill":"#64748b"}',
    '{"type":"circle","cx":0,"cy":-331,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":100,"cy":-331,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"h","from":0,"to":100,"at":-331,"label":100,"noTick":true}',
    '{"type":"circle","cx":0,"cy":-199,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":25,"cy":-199,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"h","from":0,"to":25,"at":-199,"label":25,"editable":true,"target":"faceProjection","axis":"X","foot":200,"footLen":52.800000000000004,"noTick":true}',
    '{"type":"circle","cx":-230.99999999999997,"cy":0,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":-230.99999999999997,"cy":50,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"v","from":0,"to":50,"at":-230.99999999999997,"label":50,"labelSide":"left","noTick":true}',
    '{"type":"circle","cx":-99,"cy":0,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":-99,"cy":-100,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"v","from":0,"to":-100,"at":-99,"label":100,"editable":true,"target":"faceProjection","axis":"Y","foot":175,"footLen":52.800000000000004,"labelSide":"left","noTick":true}',
    '{"type":"circle","cx":323.5,"cy":-100,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":323.5,"cy":200,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"v","from":-100,"to":200,"at":323.5,"label":300,"footLen":52.800000000000004,"foot":175}',
    '{"type":"circle","cx":25,"cy":348.5,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":175,"cy":348.5,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"h","from":25,"to":175,"at":348.5,"label":150,"footLen":52.800000000000004,"foot":200}',
  ]);
});

// QA指摘Minor-3（2026-09-23）: 角形鋼管（diaphragmRect 分岐＝section の shape/wallThickness を
// 読む唯一の未カバー分岐）を追加でピン留め。この分岐は 9a で触っていないため現行出力＝変更前出力。
test('ピン留め: columnMap（角形鋼管 STEEL-SQ200x200x9.0 → ダイヤフラム外形＋出寸法eの2段寸法線）', () => {
  const { primitives, scale } = memberFigure({ sectionDefId: 'STEEL-SQ200x200x9.0' }, 'columnMap', {});
  assert.equal(scale, undefined);
  assert.deepEqual(primitives.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":-125,"y":-125,"w":250,"h":250,"stroke":"#94a3b8"}',
    '{"type":"rect","x":-100,"y":-100,"w":200,"h":200,"stroke":"#475569"}',
    '{"type":"rect","x":-91,"y":-91,"w":182,"h":182,"stroke":"#475569"}',
    '{"type":"line","x1":0,"y1":-500,"x2":0,"y2":220,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"line","x1":-580,"y1":0,"x2":300,"y2":0,"dash":"center","stroke":"#94a3b8"}',
    '{"type":"text","x":0,"y":-560,"text":"X","anchor":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"text","x":-640,"y":0,"text":"Y","anchor":"end","baseline":"middle","size":10,"fill":"#94a3b8"}',
    '{"type":"circle","cx":280,"cy":-125,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":280,"cy":-100,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"v","from":-125,"to":-100,"at":280,"label":25,"footLen":64,"foot":100}',
    '{"type":"circle","cx":280,"cy":-100,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":280,"cy":100,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"v","from":-100,"to":100,"at":280,"label":200,"footLen":64,"foot":100}',
    '{"type":"circle","cx":-100,"cy":280,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"circle","cx":100,"cy":280,"rPx":1.25,"fill":"#64748b"}',
    '{"type":"dim","dir":"h","from":-100,"to":100,"at":280,"label":200,"footLen":64,"foot":100}',
  ]);
});

// ================================================================
// 注入テスト（D1: ctx.resolveSection がカタログ解決の権威になる）
// ================================================================

// QA指摘Minor-1（2026-09-23）: 「未指定 ≡ 明示指定」の A/B 等価テストは恒真（HEAD 版でも緑）だったため、
// resolver が entity の sectionDefId でちょうど1回呼ばれる「発火」を assert する形に置き換えた
// （columnFigure を findSectionEntry 直呼びへ戻す変異で赤になる）。
test('注入: ctx.resolveSection は entity の sectionDefId でちょうど1回呼ばれ、結果が図に使われる（columnMap）', () => {
  const entity = { sectionDefId: 'STEEL-H300x150' };
  const calls = [];
  const spy = id => { calls.push(id); return findSectionEntry(id); };
  const withSpy = memberFigure(entity, 'columnMap', { resolveSection: spy });
  assert.deepEqual(calls, ['STEEL-H300x150']);
  assert.deepEqual(withSpy, memberFigure(entity, 'columnMap', {}));
});

test('注入: resolveSection が throw したら握り潰さずそのまま伝播する', () => {
  const ctx = { resolveSection: () => { throw new Error('boom'); } };
  assert.throws(() => memberFigure({ sectionDefId: 'WOOD-120x120' }, 'columnMap', ctx), /boom/);
  assert.throws(() => memberFigure({ materialType: 'STEEL', sectionDefId: 'STEEL-H300x150' }, 'beamMap', ctx), /boom/);
});

test('注入: resolveSection が □ ドラフトを返すとダイヤフラム外形（width+2×出寸法）が描かれる', () => {
  const draft = { key: 'DRAFT-SQ', materialType: 'STEEL', shape: 'squarePipe', width: 200, height: 200, wallThickness: 9 };
  const { primitives } = memberFigure({ sectionDefId: 'WOOD-120x120' }, 'columnMap', { resolveSection: () => draft });
  assert.deepEqual(primitives[0], { type: 'rect', x: -125, y: -125, w: 250, h: 250, stroke: '#94a3b8' });
  assert.deepEqual(primitives[1], { type: 'rect', x: -100, y: -100, w: 200, h: 200, stroke: '#475569' });
  const eDim = primitives.find(p => p.type === 'dim' && p.label === 25);
  assert.ok(eDim, '出寸法 e=25 の寸法線');
});

test('注入: ctx.resolveSection が未保存ドラフトを返すと、その寸法・材寸ラベルが反映される（columnMap）', () => {
  const draft = { key: 'DRAFT', materialType: 'WOOD', shape: 'rect', width: 105, height: 300, label: 'ドラフト105×300' };
  const { primitives } = memberFigure(
    { sectionDefId: 'WOOD-120x120' }, // カタログに実在するキーを指定しても resolveSection が権威
    'columnMap',
    { resolveSection: () => draft },
  );
  const shape = primitives[0];
  assert.equal(shape.type, 'rect');
  assert.equal(shape.w, 105);
  assert.equal(shape.h, 300);
  const vDim = primitives.find(p => p.type === 'dim' && p.dir === 'v');
  const hDim = primitives.find(p => p.type === 'dim' && p.dir === 'h');
  assert.equal(vDim.label, 300); // 成
  assert.equal(hDim.label, 105); // 幅
});

test('注入: ctx.resolveSection が null を返すと、実在キーでも既定300×300へ落ちる（再フォールバックしない）', () => {
  const { primitives } = memberFigure(
    { sectionDefId: 'WOOD-120x120' }, // カタログには実在する
    'columnMap',
    { resolveSection: () => null },
  );
  const shape = primitives[0];
  assert.equal(shape.type, 'rect');
  assert.equal(shape.w, 300);
  assert.equal(shape.h, 300);
  assert.equal(shape.hatch, 'concrete'); // 既定rectの目印（sectionShapePrimsの!sectionフォールバック）
});

test('注入: beamMap（STEEL）でも ctx.resolveSection の注入が効く', () => {
  const draft = { key: 'DRAFT-BEAM', materialType: 'STEEL', shape: 'hSection', width: 200, height: 400, webThickness: 8, flangeThickness: 13, label: 'ドラフトH400×200' };
  const { primitives } = memberFigure(
    { materialType: 'STEEL', sectionDefId: 'STEEL-H300x150' }, // カタログには実在する
    'beamMap',
    { resolveSection: () => draft },
  );
  const shape = primitives.find(p => p.type === 'hSection');
  assert.equal(shape.w, 200);
  assert.equal(shape.h, 400);
});
