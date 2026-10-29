// S造スラブ仕様（steelSlabSpec.js）の純モジュールテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SteelSlabKind, SlabConcreteType, BraceMemberType, SteelSlabSpecMode,
  ROUND_BAR_BRACE_SPECS, ANGLE_BRACE_SPECS, RAISE_CHANNEL_SPECS,
  STEEL_SLAB_SPEC_KEYS_BY_KIND, ALL_STEEL_SLAB_SPEC_KEYS,
  defaultSteelSlabSpec, projectToKind, normalizeSteelSlabSpec, steelSlabSpecEquals,
  resolveSteelSlabSpec, foldIntoCommon, resolveBraceHeightMm, toPairs, fromPairs,
  validateSteelSlabField, deckPlateOptions, flatDeckPlateOptions, alcPlateOptions,
} from './steelSlabSpec.js';
import { STEEL_BRACE_MAX_DIAGONAL_MM } from '../core/constants.js';
import { MATERIALS } from '../finish/materials/materialData.js';

const INDIVIDUAL = { mode: SteelSlabSpecMode.INDIVIDUAL };
const COMMON = { mode: SteelSlabSpecMode.COMMON };
const JFPL_CODE = '201700000029'; // JFPL200（調整プレート）

test('既定: 共通仕様はデッキプレート・全種別の項目を持つ（メモの * 印）', () => {
  const d = defaultSteelSlabSpec();
  assert.equal(d.kind, SteelSlabKind.DECK);
  assert.deepEqual(Object.keys(d).sort(), [...ALL_STEEL_SLAB_SPEC_KEYS].sort());
  assert.equal(d.deckPlateCode, '201600000001');
  assert.equal(d.flatDeckPlateCode, '201700000001');
  assert.equal(d.concreteType, SlabConcreteType.NORMAL);
  assert.equal(d.concreteThicknessMm, 150);
  assert.equal(d.concreteTopBelowFlMm, 0);
  assert.equal(d.braceMemberType, BraceMemberType.ROUND_BAR);
  assert.equal(d.braceSpec, 'M16');
  assert.equal(d.braceHeightMm, null);
  assert.equal(d.alcCode, '301200000008');
  assert.equal(d.raiseChannelSpec, 'C-100×50×20×3.2');
  assert.notEqual(defaultSteelSlabSpec(), d, '呼ぶたびに別オブジェクト');
});

test('項目表: デッキとフラットデッキはコンクリート3項目を共有し、全項目は kind＋和集合', () => {
  const k = STEEL_SLAB_SPEC_KEYS_BY_KIND;
  assert.deepEqual(k.deck.slice(1), k.flatDeck.slice(1));
  assert.deepEqual(ALL_STEEL_SLAB_SPEC_KEYS[0], 'kind');
  assert.equal(ALL_STEEL_SLAB_SPEC_KEYS.length, 1 + new Set(Object.values(k).flat()).size);
});

test('選択肢の件数: 丸鋼7・L型鋼11（既定は先頭）・かさ上げ15', () => {
  assert.equal(ROUND_BAR_BRACE_SPECS.length, 7);
  assert.equal(ANGLE_BRACE_SPECS.length, 11);
  assert.equal(RAISE_CHANNEL_SPECS.length, 15);
  assert.equal(normalizeSteelSlabSpec({ kind: 'brace', braceMemberType: 'angle', braceSpec: 'x' }, INDIVIDUAL).braceSpec, 'L-50*50*4');
});

test('ブレースの対角長の上限: 丸鋼7000・L型鋼12000（mm）', () => {
  assert.deepEqual({ ...STEEL_BRACE_MAX_DIAGONAL_MM }, { roundBar: 7000, angle: 12000 });
});

test('projectToKind: その種別の項目と kind だけ', () => {
  const p = projectToKind(defaultSteelSlabSpec(), SteelSlabKind.ALC);
  assert.deepEqual(Object.keys(p).sort(), ['alcCode', 'alcTopBelowFlMm', 'kind', 'raiseChannelSpec']);
});

test('normalize: 個別は自種別の項目だけ、共通は全項目', () => {
  const ind = normalizeSteelSlabSpec({ kind: 'flatDeck' }, INDIVIDUAL);
  assert.deepEqual(Object.keys(ind).sort(), ['concreteThicknessMm', 'concreteTopBelowFlMm', 'concreteType', 'flatDeckPlateCode', 'kind']);
  const com = normalizeSteelSlabSpec({ kind: 'flatDeck' }, COMMON);
  assert.deepEqual(Object.keys(com).sort(), [...ALL_STEEL_SLAB_SPEC_KEYS].sort());
  assert.equal(com.kind, 'flatDeck');
});

test('【失敗系】normalize: 種別不明は個別→null・共通→既定の種別', () => {
  for (const bad of [{ kind: 'zzz' }, {}, null, undefined, 'deck', 5]) {
    assert.equal(normalizeSteelSlabSpec(bad, INDIVIDUAL), null, JSON.stringify(bad));
  }
  assert.deepEqual(normalizeSteelSlabSpec({ kind: 'zzz', concreteThicknessMm: 200 }, COMMON), { ...defaultSteelSlabSpec(), concreteThicknessMm: 200 });
  assert.deepEqual(normalizeSteelSlabSpec(null, COMMON), defaultSteelSlabSpec());
});

test('normalize: 数値は文字列 "120" も受ける', () => {
  const s = normalizeSteelSlabSpec({ kind: 'deck', concreteThicknessMm: '120', concreteTopBelowFlMm: '30' }, INDIVIDUAL);
  assert.equal(s.concreteThicknessMm, 120);
  assert.equal(s.concreteTopBelowFlMm, 30);
});

test('【失敗系】normalize: 厚は0以下・負・非数・空・真偽値で既定、FL−は負で既定（0は有効）', () => {
  for (const bad of [0, -5, 'abc', '', '  ', null, true, NaN, Infinity]) {
    assert.equal(normalizeSteelSlabSpec({ kind: 'deck', concreteThicknessMm: bad }, INDIVIDUAL).concreteThicknessMm, 150, String(bad));
  }
  for (const bad of [-1, 'abc', '', true]) {
    assert.equal(normalizeSteelSlabSpec({ kind: 'deck', concreteTopBelowFlMm: bad }, INDIVIDUAL).concreteTopBelowFlMm, 0, String(bad));
  }
  assert.equal(normalizeSteelSlabSpec({ kind: 'alc', alcTopBelowFlMm: 0 }, INDIVIDUAL).alcTopBelowFlMm, 0);
  assert.equal(normalizeSteelSlabSpec({ kind: 'alc', alcTopBelowFlMm: -3 }, INDIVIDUAL).alcTopBelowFlMm, 0);
});

test('【失敗系】normalize: 列挙外のコンクリート種別・ブレース種別・かさ上げ鋼材は既定', () => {
  const s = normalizeSteelSlabSpec({ concreteType: 'heavy', braceMemberType: 'rope', raiseChannelSpec: 'C-1×1×1×1' }, COMMON);
  assert.equal(s.concreteType, 'normal');
  assert.equal(s.braceMemberType, 'roundBar');
  assert.equal(s.raiseChannelSpec, 'C-100×50×20×3.2');
  assert.equal(normalizeSteelSlabSpec({ concreteType: 'lightweight' }, COMMON).concreteType, 'lightweight');
});

test('【失敗系】normalize: 材料コードは帯違い・桁違い・非数が既定へ。帯内なら（カタログ無しでも）保つ', () => {
  const pick = (k, v) => normalizeSteelSlabSpec({ kind: 'deck', [k]: v }, COMMON)[k];
  assert.equal(pick('deckPlateCode', '201700000001'), '201600000001', 'フラットデッキ帯はデッキの欄に入らない');
  assert.equal(pick('deckPlateCode', 'abc'), '201600000001');
  assert.equal(pick('deckPlateCode', '2016'), '201600000001', '12桁でない');
  assert.equal(pick('deckPlateCode', '201600000002'), '201600000002');
  assert.equal(pick('alcCode', '201600000001'), '301200000008');
  assert.equal(pick('flatDeckPlateCode', 201700000002), '201700000002', '数値で来ても文字列へ');
});

test('【失敗系】normalize: カタログを渡すと JFPL（調整プレート）はフラットデッキに使えない・存在しないコードも既定', () => {
  assert.ok(MATERIALS.some(m => m.code === JFPL_CODE && m.name.startsWith('JFPL')), '前提: 調整プレートが実在する');
  const opt = { ...COMMON, materialCatalog: MATERIALS };
  assert.equal(normalizeSteelSlabSpec({ flatDeckPlateCode: JFPL_CODE }, opt).flatDeckPlateCode, '201700000001');
  assert.equal(normalizeSteelSlabSpec({ flatDeckPlateCode: '201700000002' }, opt).flatDeckPlateCode, '201700000002');
  assert.equal(normalizeSteelSlabSpec({ flatDeckPlateCode: '201799999999' }, opt).flatDeckPlateCode, '201700000001', '帯内でもカタログに無い');
});

test('選択肢: 帯で絞り、フラットデッキは JFPL を除く', () => {
  assert.ok(deckPlateOptions(MATERIALS).length > 0);
  assert.ok(deckPlateOptions(MATERIALS).every(m => m.code.startsWith('2016')));
  const flat = flatDeckPlateOptions(MATERIALS);
  assert.ok(flat.length > 0 && flat.every(m => m.code.startsWith('2017') && !m.name.startsWith('JFPL')));
  assert.ok(alcPlateOptions(MATERIALS).every(m => m.code.startsWith('3012')));
  assert.deepEqual(deckPlateOptions(undefined), []);
});

test('normalize: braceHeightMm は null か 0 以上の有限数。負・非数は null（自動）', () => {
  const h = v => normalizeSteelSlabSpec({ kind: 'brace', braceHeightMm: v }, INDIVIDUAL).braceHeightMm;
  assert.equal(h(null), null);
  assert.equal(h(undefined), null);
  assert.equal(h(150), 150);
  assert.equal(h('150'), 150);
  assert.equal(h(0), 0);
  assert.equal(h(-5), null);
  assert.equal(h('abc'), null);
});

test('normalize: ブレースの規格は種別ごとの選択肢にあるものだけ（種別違いは既定）', () => {
  const s = (t, spec) => normalizeSteelSlabSpec({ kind: 'brace', braceMemberType: t, braceSpec: spec }, INDIVIDUAL).braceSpec;
  assert.equal(s('roundBar', 'M20'), 'M20');
  assert.equal(s('roundBar', 'L-50*50*6'), 'M16', '丸鋼にL型鋼の規格');
  assert.equal(s('angle', 'L-75*75*9'), 'L-75*75*9');
  assert.equal(s('angle', 'M20'), 'L-50*50*4', 'L型鋼に丸鋼の規格');
});

test('steelSlabSpecEquals: 同種別で項目が同じなら true。他種別の項目は無視、braceHeightMm の null と数値は別', () => {
  const com = defaultSteelSlabSpec();
  const a = projectToKind(com, 'deck');
  assert.equal(steelSlabSpecEquals(a, { ...a }), true);
  assert.equal(steelSlabSpecEquals(a, { ...a, concreteThicknessMm: 160 }), false);
  assert.equal(steelSlabSpecEquals(a, { ...a, braceSpec: 'M24' }), true, '他種別の項目は比べない');
  assert.equal(steelSlabSpecEquals(a, projectToKind(com, 'flatDeck')), false, '種別違い');
  const auto = projectToKind(com, 'brace');
  assert.equal(steelSlabSpecEquals(auto, { ...auto, braceHeightMm: 150 }), false);
  assert.equal(steelSlabSpecEquals(auto, { ...auto, braceHeightMm: undefined }), true, 'undefined は null と同じ（自動）');
  assert.equal(steelSlabSpecEquals(null, undefined), true);
  assert.equal(steelSlabSpecEquals(null, a), false);
});

test('resolveSteelSlabSpec: 個別があれば個別、無ければ共通を共通の種別の形で', () => {
  const com = { ...defaultSteelSlabSpec(), kind: 'alc' };
  const ind = normalizeSteelSlabSpec({ kind: 'deck' }, INDIVIDUAL);
  assert.equal(resolveSteelSlabSpec(ind, com), ind);
  assert.deepEqual(resolveSteelSlabSpec(null, com), projectToKind(com, 'alc'));
  assert.deepEqual(resolveSteelSlabSpec(null, null), projectToKind(defaultSteelSlabSpec(), 'deck'));
});

test('foldIntoCommon: 共通と同じ内容の個別は null（共通へ戻る）、違えば個別のまま', () => {
  const com = defaultSteelSlabSpec();
  const same = normalizeSteelSlabSpec({ kind: 'deck' }, INDIVIDUAL);
  assert.equal(foldIntoCommon(same, com), null);
  const diff = normalizeSteelSlabSpec({ kind: 'deck', concreteThicknessMm: 120 }, INDIVIDUAL);
  assert.equal(foldIntoCommon(diff, com), diff);
  // 共通の種別と違う個別は、その種別の共通の項目と同じなら戻る（他種別の項目は共通に残っている）
  const flat = normalizeSteelSlabSpec({ kind: 'flatDeck' }, INDIVIDUAL);
  assert.equal(foldIntoCommon(flat, com), null);
  assert.equal(foldIntoCommon(null, com), null);
});

test('foldIntoCommon: braceHeightMm が null(自動) の共通に対し 150 の個別は残る・null の個別は戻る', () => {
  const com = defaultSteelSlabSpec();
  const fixed = normalizeSteelSlabSpec({ kind: 'brace', braceHeightMm: 150 }, INDIVIDUAL);
  assert.equal(foldIntoCommon(fixed, com), fixed);
  const auto = normalizeSteelSlabSpec({ kind: 'brace' }, INDIVIDUAL);
  assert.equal(foldIntoCommon(auto, com), null);
  const com150 = { ...com, braceHeightMm: 150 };
  assert.equal(foldIntoCommon(fixed, com150), null);
  assert.equal(foldIntoCommon(auto, com150), auto, '共通が150なら自動の個別は残る');
});

test('resolveBraceHeightMm: null は子梁成/2・上限は子梁成・下限は0', () => {
  assert.equal(resolveBraceHeightMm({ braceHeightMm: null }, 300), 150);
  assert.equal(resolveBraceHeightMm({ braceHeightMm: 400 }, 300), 300);
  assert.equal(resolveBraceHeightMm({ braceHeightMm: 100 }, 300), 100);
  assert.equal(resolveBraceHeightMm({ braceHeightMm: 0 }, 300), 0);
  assert.equal(resolveBraceHeightMm({ braceHeightMm: -5 }, 300), 0, 'normalize を通らない負も 0 に収める');
  const n = normalizeSteelSlabSpec({ kind: 'brace', braceHeightMm: -5 }, INDIVIDUAL);
  assert.equal(resolveBraceHeightMm(n, 300), 150, 'normalize は負を null にするので自動＝子梁成/2');
});

test('【失敗系】resolveBraceHeightMm: 子梁成が非有限（NaN・undefined・Infinity）なら 0', () => {
  for (const depth of [NaN, undefined, Infinity, null]) {
    assert.equal(resolveBraceHeightMm({ braceHeightMm: null }, depth), 0, String(depth));
  }
});

test('既定の材料コード3件は実カタログの選択肢にあり、カタログ照合を通しても既定のまま', () => {
  const d = defaultSteelSlabSpec();
  assert.deepEqual(normalizeSteelSlabSpec(d, { mode: 'common', materialCatalog: MATERIALS }), d);
  assert.ok(deckPlateOptions(MATERIALS).some(m => m.code === d.deckPlateCode));
  assert.ok(flatDeckPlateOptions(MATERIALS).some(m => m.code === d.flatDeckPlateCode));
  assert.ok(alcPlateOptions(MATERIALS).some(m => m.code === d.alcCode));
});

test('toPairs/fromPairs: 往復で材料コードは文字列のまま（coerce が数値へ戻すのを normalize が戻す）', () => {
  const com = { ...defaultSteelSlabSpec(), kind: 'alc', concreteThicknessMm: 175, braceHeightMm: 120, braceMemberType: 'angle', braceSpec: 'L-65*65*6' };
  const [keys, vals] = toPairs(com);
  assert.ok(vals.every(v => typeof v === 'string'));
  const back = fromPairs(keys, vals, COMMON);
  assert.deepEqual(back, com);
  assert.equal(typeof back.deckPlateCode, 'string');
  assert.equal(back.alcCode, '301200000008');
});

test('toPairs: braceHeightMm=null は書かない・復元で null', () => {
  const [keys, vals] = toPairs(defaultSteelSlabSpec());
  assert.ok(!keys.includes('braceHeightMm'));
  assert.equal(fromPairs(keys, vals, COMMON).braceHeightMm, null);
});

test('【失敗系】fromPairs: 壊れたペア（桁違いの数値コード・未知の種別・長さ不足）は既定へ。個別は種別不明で null', () => {
  const broken = fromPairs(['kind', 'deckPlateCode', 'concreteThicknessMm'], ['brace', '12', 'xx'], COMMON);
  assert.equal(broken.kind, 'brace');
  assert.equal(broken.deckPlateCode, '201600000001');
  assert.equal(broken.concreteThicknessMm, 150);
  assert.deepEqual(fromPairs(['kind'], ['nope'], COMMON), defaultSteelSlabSpec());
  assert.equal(fromPairs(['kind'], ['nope'], INDIVIDUAL), null);
  assert.deepEqual(fromPairs([], [], COMMON), defaultSteelSlabSpec());
  assert.equal(fromPairs(undefined, undefined, INDIVIDUAL), null);
  assert.deepEqual(fromPairs(['concreteThicknessMm'], [], COMMON), defaultSteelSlabSpec(), '値が欠けた対');
});

test('validateSteelSlabField: 正常は null、不正は日本語の理由', () => {
  const ctx = { materialCatalog: MATERIALS };
  assert.equal(validateSteelSlabField('deck', 'deckPlateCode', '201600000001', ctx), null);
  assert.match(validateSteelSlabField('deck', 'deckPlateCode', '201700000001', ctx), /不正/);
  assert.match(validateSteelSlabField('flatDeck', 'flatDeckPlateCode', JFPL_CODE, ctx), /使えない/);
  assert.match(validateSteelSlabField('deck', 'concreteThicknessMm', 0), /0より大きい/);
  assert.equal(validateSteelSlabField('deck', 'concreteThicknessMm', '120'), null);
  assert.match(validateSteelSlabField('alc', 'alcTopBelowFlMm', -1), /0以上/);
  assert.equal(validateSteelSlabField('brace', 'braceHeightMm', null), null);
  assert.match(validateSteelSlabField('brace', 'braceHeightMm', -2), /0以上/);
  assert.match(validateSteelSlabField('brace', 'braceSpec', 'M99'), /選択肢/);
  assert.equal(validateSteelSlabField('brace', 'braceSpec', 'L-50*50*6', { braceMemberType: 'angle' }), null);
  assert.match(validateSteelSlabField('alc', 'raiseChannelSpec', 'x'), /選択肢/);
  assert.match(validateSteelSlabField('alc', 'concreteType', 'normal'), /ありません/, '種別に無い項目');
});
