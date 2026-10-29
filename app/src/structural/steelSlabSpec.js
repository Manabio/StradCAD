// S造スラブの仕様（SteelSlabSpec）の純モジュール。ユーザー指示 問題.md 2026-10-29「S造スラブ指定」。
//
// 建物全体の共通仕様（StructuralInfo.steelSlabSpec）と、スラブごとの個別仕様（SteelSlab.steelSpec）が
// 同じ形を持つ。個別仕様が共通仕様と同じ内容になったら個別を捨てて共通へ戻る（foldIntoCommon）。
//
// 形は1段のフラットなオブジェクト（fieldPacking が2段ネストを持てないため）:
//   { kind, deckPlateCode, flatDeckPlateCode, concreteType, concreteThicknessMm, concreteTopBelowFlMm,
//     braceMemberType, braceSpec, braceHeightMm, alcCode, alcTopBelowFlMm, raiseChannelSpec }
// どの種別がどの項目を持つかは STEEL_SLAB_SPEC_KEYS_BY_KIND が唯一の定義。個別仕様は自分の種別の項目だけを持ち、
// 共通仕様は全種別の項目を持つ（種別を切り替えても他種別の選択が残る）。
//
// 純モジュール: store.js / snap.js / .jsx を静的に引かない（node:test から単体 import できる）。材料カタログは
// import せず、呼び出し側が材料の配列（{code,name,thickness}）を渡す。
import {
  SteelSlabKind, SlabConcreteType, BraceMemberType,
  ROUND_BAR_BRACE_SPECS, ANGLE_BRACE_SPECS, RAISE_CHANNEL_SPECS,
  DEFAULT_DECK_PLATE_CODE, DEFAULT_FLAT_DECK_PLATE_CODE, DEFAULT_ALC_PLATE_CODE,
  DEFAULT_SLAB_CONCRETE_THICKNESS_MM, DEFAULT_SLAB_TOP_BELOW_FL_MM,
  DEFAULT_ROUND_BAR_BRACE_SPEC, DEFAULT_RAISE_CHANNEL_SPEC,
  STEEL_SLAB_DECK_CODE_BAND, STEEL_SLAB_FLAT_DECK_CODE_BAND, STEEL_SLAB_ALC_CODE_BAND,
  FLAT_DECK_ADJUST_PLATE_NAME_PREFIX,
} from '../core/constants.js';
import { isMaterialCode } from '../catalog/materialCode.js';
import { packExtraFields, unpackExtraFields } from './fieldPacking.js';

export {
  SteelSlabKind, SlabConcreteType, BraceMemberType,
  STEEL_SLAB_KIND_LABELS, SLAB_CONCRETE_TYPE_LABELS, BRACE_MEMBER_TYPE_LABELS,
  ROUND_BAR_BRACE_SPECS, ANGLE_BRACE_SPECS, RAISE_CHANNEL_SPECS,
} from '../core/constants.js';

/** normalizeSteelSlabSpec の mode。共通仕様は全項目を返し、個別仕様は自種別の項目だけを返す。 */
export const SteelSlabSpecMode = Object.freeze({ COMMON: 'common', INDIVIDUAL: 'individual' });

const CONCRETE_KEYS = Object.freeze(['concreteType', 'concreteThicknessMm', 'concreteTopBelowFlMm']);

/** 種別ごとの項目（kind を除く）。どの種別がどの項目を持つかの唯一の定義。デッキとフラットデッキはコンクリート3項目を共有する。 */
export const STEEL_SLAB_SPEC_KEYS_BY_KIND = Object.freeze({
  [SteelSlabKind.DECK]:      Object.freeze(['deckPlateCode', ...CONCRETE_KEYS]),
  [SteelSlabKind.FLAT_DECK]: Object.freeze(['flatDeckPlateCode', ...CONCRETE_KEYS]),
  [SteelSlabKind.BRACE]:     Object.freeze(['braceMemberType', 'braceSpec', 'braceHeightMm']),
  [SteelSlabKind.ALC]:       Object.freeze(['alcCode', 'alcTopBelowFlMm', 'raiseChannelSpec']),
});

/** 共通仕様が持つ全項目（kind を先頭に、全種別の項目の和集合。永続化のキー集合）。 */
export const ALL_STEEL_SLAB_SPEC_KEYS = Object.freeze([
  'kind',
  ...new Set(Object.values(STEEL_SLAB_SPEC_KEYS_BY_KIND).flat()),
]);

const KIND_VALUES = new Set(Object.values(SteelSlabKind));
const CONCRETE_TYPE_VALUES = new Set(Object.values(SlabConcreteType));
const BRACE_MEMBER_TYPE_VALUES = new Set(Object.values(BraceMemberType));

/** プレートの材料コード項目 → 材料コード帯（先頭4桁）。 */
const PLATE_CODE_BAND_BY_KEY = Object.freeze({
  deckPlateCode:     STEEL_SLAB_DECK_CODE_BAND,
  flatDeckPlateCode: STEEL_SLAB_FLAT_DECK_CODE_BAND,
  alcCode:           STEEL_SLAB_ALC_CODE_BAND,
});

/** プレートの材料コードを持つ項目名（使用中コードの収集に使う。catalog/codeNormalization.js の直書きと一致をテストで固定）。 */
export const STEEL_SLAB_PLATE_CODE_KEYS = Object.freeze(Object.keys(PLATE_CODE_BAND_BY_KEY));

/** ブレース種別 → 規格の選択肢。 */
const BRACE_SPECS_BY_TYPE = Object.freeze({
  [BraceMemberType.ROUND_BAR]: ROUND_BAR_BRACE_SPECS,
  [BraceMemberType.ANGLE]:     ANGLE_BRACE_SPECS,
});

/** ブレース種別 → 規格の既定（丸鋼は M16、L型鋼は先頭）。 */
function defaultBraceSpec(memberType) {
  return memberType === BraceMemberType.ANGLE ? ANGLE_BRACE_SPECS[0] : DEFAULT_ROUND_BAR_BRACE_SPEC;
}

// ---- 材料の選択肢（呼び出し側が渡す材料配列 {code,name,thickness} から帯で絞る）----

function inBand(materials, band) {
  return (materials ?? []).filter(m => typeof m?.code === 'string' && m.code.startsWith(band));
}
function isAdjustPlate(m) {
  return typeof m?.name === 'string' && m.name.startsWith(FLAT_DECK_ADJUST_PLATE_NAME_PREFIX);
}

/** デッキプレート（帯2016）の選択肢。 */
export function deckPlateOptions(materials) { return inBand(materials, STEEL_SLAB_DECK_CODE_BAND); }
/** フラットデッキ（帯2017）の選択肢。調整プレート（名称が JFPL で始まる）は除く。 */
export function flatDeckPlateOptions(materials) {
  return inBand(materials, STEEL_SLAB_FLAT_DECK_CODE_BAND).filter(m => !isAdjustPlate(m));
}
/** ALC（帯3012）の選択肢。 */
export function alcPlateOptions(materials) { return inBand(materials, STEEL_SLAB_ALC_CODE_BAND); }

const PLATE_OPTIONS_BY_KEY = Object.freeze({
  deckPlateCode:     deckPlateOptions,
  flatDeckPlateCode: flatDeckPlateOptions,
  alcCode:           alcPlateOptions,
});

// ---- 既定値 ----

const FIELD_DEFAULTS = Object.freeze({
  deckPlateCode:       DEFAULT_DECK_PLATE_CODE,
  flatDeckPlateCode:   DEFAULT_FLAT_DECK_PLATE_CODE,
  concreteType:        SlabConcreteType.NORMAL,
  concreteThicknessMm: DEFAULT_SLAB_CONCRETE_THICKNESS_MM,
  concreteTopBelowFlMm: DEFAULT_SLAB_TOP_BELOW_FL_MM,
  braceMemberType:     BraceMemberType.ROUND_BAR,
  braceSpec:           DEFAULT_ROUND_BAR_BRACE_SPEC,
  braceHeightMm:       null,
  alcCode:             DEFAULT_ALC_PLATE_CODE,
  alcTopBelowFlMm:     DEFAULT_SLAB_TOP_BELOW_FL_MM,
  raiseChannelSpec:    DEFAULT_RAISE_CHANNEL_SPEC,
});

/** 共通仕様の既定（全種別の項目を持ち、種別はデッキプレート）。呼ぶたびに新しいオブジェクトを返す。 */
export function defaultSteelSlabSpec() {
  return { kind: SteelSlabKind.DECK, ...FIELD_DEFAULTS };
}

/** spec から kind の項目だけを取り出した個別形（kind 付き）。種別の切替えや共通との比較に使う。 */
export function projectToKind(spec, kind) {
  const out = { kind };
  for (const key of STEEL_SLAB_SPEC_KEYS_BY_KIND[kind] ?? []) out[key] = spec?.[key];
  return out;
}

// ---- 値の正規化（落ちない。不正なら既定へ） ----

// 数値らしい値だけ有限数にする（'120' は可。null・''・空白・真偽値・'abc' は null）。
function toFiniteNumber(v) {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizePositive(v, fallback) {
  const n = toFiniteNumber(v);
  return n !== null && n > 0 ? n : fallback;
}
function normalizeNonNegative(v, fallback) {
  const n = toFiniteNumber(v);
  return n !== null && n >= 0 ? n : fallback;
}

// 材料コード: 文字列化（fieldPacking の coerce が数値へ戻すため）し、帯と選択肢で照合する。
// materials が無いとき（保存データの復元など）は12桁数字＋帯だけを見る（カタログの編集で消えた材料も保つ）。
function normalizePlateCode(key, v, materials) {
  if (v == null) return FIELD_DEFAULTS[key];
  const code = String(v);
  if (!isMaterialCode(code) || !code.startsWith(PLATE_CODE_BAND_BY_KEY[key])) return FIELD_DEFAULTS[key];
  if (materials && !PLATE_OPTIONS_BY_KEY[key](materials).some(m => m.code === code)) return FIELD_DEFAULTS[key];
  return code;
}

function normalizeOneOf(v, allowed, fallback) {
  const s = v == null ? v : String(v);
  return allowed.has(s) ? s : fallback;
}

function normalizeListed(v, list, fallback) {
  const s = v == null ? v : String(v);
  return list.includes(s) ? s : fallback;
}

/**
 * 仕様を正規化する。落ちない（不正値は項目の既定へ）。
 * @param {object|null|undefined} raw 保存データ・UI入力など
 * @param {{mode?: 'common'|'individual', materialCatalog?: Array<{code:string,name?:string,thickness?:number}>}} [opts]
 *   mode: common＝全項目を返す（種別が不明なら既定の種別）／individual＝自種別の項目だけを返す（種別が不明なら null）。
 *   materialCatalog: 渡すとプレートの材料コードを選択肢と照合する。無いときは帯だけを見る。
 * @returns {object|null}
 */
export function normalizeSteelSlabSpec(raw, { mode = SteelSlabSpecMode.COMMON, materialCatalog } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawKind = src.kind == null ? src.kind : String(src.kind);
  if (!KIND_VALUES.has(rawKind) && mode === SteelSlabSpecMode.INDIVIDUAL) return null;
  const kind = KIND_VALUES.has(rawKind) ? rawKind : SteelSlabKind.DECK;

  const braceMemberType = normalizeOneOf(src.braceMemberType, BRACE_MEMBER_TYPE_VALUES, FIELD_DEFAULTS.braceMemberType);
  const braceHeight = toFiniteNumber(src.braceHeightMm);
  const full = {
    kind,
    deckPlateCode:        normalizePlateCode('deckPlateCode', src.deckPlateCode, materialCatalog),
    flatDeckPlateCode:    normalizePlateCode('flatDeckPlateCode', src.flatDeckPlateCode, materialCatalog),
    concreteType:         normalizeOneOf(src.concreteType, CONCRETE_TYPE_VALUES, FIELD_DEFAULTS.concreteType),
    concreteThicknessMm:  normalizePositive(src.concreteThicknessMm, FIELD_DEFAULTS.concreteThicknessMm),
    concreteTopBelowFlMm: normalizeNonNegative(src.concreteTopBelowFlMm, FIELD_DEFAULTS.concreteTopBelowFlMm),
    braceMemberType,
    braceSpec:            normalizeListed(src.braceSpec, BRACE_SPECS_BY_TYPE[braceMemberType], defaultBraceSpec(braceMemberType)),
    braceHeightMm:        braceHeight !== null && braceHeight >= 0 ? braceHeight : null,
    alcCode:              normalizePlateCode('alcCode', src.alcCode, materialCatalog),
    alcTopBelowFlMm:      normalizeNonNegative(src.alcTopBelowFlMm, FIELD_DEFAULTS.alcTopBelowFlMm),
    raiseChannelSpec:     normalizeListed(src.raiseChannelSpec, RAISE_CHANNEL_SPECS, FIELD_DEFAULTS.raiseChannelSpec),
  };
  return mode === SteelSlabSpecMode.INDIVIDUAL ? projectToKind(full, kind) : full;
}

// ---- 比較・解決・畳み込み ----

/** 同じ種別で、その種別の項目がすべて同じか。両方 null/undefined は同じ。braceHeightMm の null（自動）と数値は別。 */
export function steelSlabSpecEquals(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a.kind !== b.kind) return false;
  return (STEEL_SLAB_SPEC_KEYS_BY_KIND[a.kind] ?? []).every(k => (a[k] ?? null) === (b[k] ?? null));
}

/**
 * 共通仕様どうしが全項目（他種別の項目も）同じか。共通仕様は選択中でない種別の項目も保つため、
 * steelSlabSpecEquals（自種別の項目だけ）では undo 登録・既定判定の変更を見逃す。両方 null/undefined は同じ。
 */
export function steelSlabCommonSpecEquals(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return ALL_STEEL_SLAB_SPEC_KEYS.every(k => (a[k] ?? null) === (b[k] ?? null));
}

/** 共通仕様が既定（defaultSteelSlabSpec）と全項目同じか。保存データへ書くか（既定なら書かない）の判定。 */
export function isDefaultSteelSlabSpec(spec) {
  return steelSlabCommonSpecEquals(spec, defaultSteelSlabSpec());
}

/** スラブの実効仕様。個別があればそれ、無ければ共通を個別の形（自種別の項目だけ）にしたもの。 */
export function resolveSteelSlabSpec(individual, common) {
  if (individual) return individual;
  const base = common ?? defaultSteelSlabSpec();
  return projectToKind(base, base.kind);
}

/**
 * 個別仕様が共通仕様と同じなら null（個別を捨てて共通へ戻る）、違えば個別のまま返す。
 * 種別が違う個別は共通と同じ仕様ではない（畳むと種別が共通の種別へ戻ってしまう）ので常に個別のまま。
 */
export function foldIntoCommon(individual, common) {
  if (!individual) return null;
  const base = common ?? defaultSteelSlabSpec();
  if (individual.kind !== base.kind) return individual;
  return steelSlabSpecEquals(individual, projectToKind(base, individual.kind)) ? null : individual;
}

/** SteelSlab か（steelSpec を持つ実体）。core を引かずに判定する（memberCatalog.js は core.js から import されるため循環を避ける）。 */
export function isSteelSlabLike(entity) {
  return entity != null && typeof entity === 'object' && 'steelSpec' in entity;
}

/**
 * 部材番号の署名に載せる、SteelSlab の個別仕様の安定文字列。共通に従う（null）は 'common'、個別は toPairs を
 * `キー:値` で連結する（キー順は ALL_STEEL_SLAB_SPEC_KEYS で固定）。署名の区切り '|' と '=' は含まない。
 */
export function steelSlabSignatureValue(steelSpec) {
  if (!steelSpec) return 'common';
  const [keys, vals] = toPairs(steelSpec);
  return keys.map((k, i) => `${k}:${vals[i]}`).join(',');
}

/**
 * ブレースの設置高さ(mm)。null（自動）は子梁成の半分。0〜子梁成に収める。
 * 上限が子梁成に依るため、normalize は上限を見ない。
 */
export function resolveBraceHeightMm(spec, childDepthMm) {
  if (!Number.isFinite(childDepthMm)) return 0; // 子梁成が不明（非有限）なら 0
  const raw = spec?.braceHeightMm ?? childDepthMm / 2;
  return Math.min(Math.max(raw, 0), childDepthMm);
}

// ---- 永続化（keys[]/vals[] の文字列ペア。fieldPacking の規約）----

/** 仕様 → [keys[], vals[]]。null の項目（braceHeightMm 自動）は書かない。 */
export function toPairs(spec) {
  return packExtraFields(spec ?? {}, ALL_STEEL_SLAB_SPEC_KEYS);
}

/**
 * [keys, vals] → 仕様。fieldPacking の coerce が数値らしい文字列（材料コード）を数値へ戻すため、
 * normalize が String() で文字列へ戻す。opts は normalizeSteelSlabSpec と同じ。
 */
export function fromPairs(keys, vals, opts) {
  return normalizeSteelSlabSpec(unpackExtraFields(keys ?? [], vals ?? []), opts);
}

// ---- 入力検証（UI用。項目ごとに日本語の理由を返す。問題なければ null）----

const PLATE_LABELS = Object.freeze({
  deckPlateCode: 'デッキプレート', flatDeckPlateCode: 'フラットデッキ', alcCode: 'ALCパネル',
});

/**
 * 1項目の入力を検証する。
 * @param {string} kind 種別
 * @param {string} key 項目名
 * @param {*} value 入力値
 * @param {{materialCatalog?: Array}} [ctx]
 * @returns {string|null} 不正の理由（日本語）／問題なければ null
 */
export function validateSteelSlabField(kind, key, value, ctx = {}) {
  if (!(STEEL_SLAB_SPEC_KEYS_BY_KIND[kind] ?? []).includes(key)) return `${kind} に項目 ${key} はありません`;
  if (key in PLATE_CODE_BAND_BY_KEY) {
    const code = value == null ? '' : String(value);
    if (!isMaterialCode(code) || !code.startsWith(PLATE_CODE_BAND_BY_KEY[key])) {
      return `${PLATE_LABELS[key]}の材料コードが不正です`;
    }
    if (ctx.materialCatalog && !PLATE_OPTIONS_BY_KEY[key](ctx.materialCatalog).some(m => m.code === code)) {
      return `${PLATE_LABELS[key]}に使えない材料です`;
    }
    return null;
  }
  if (key === 'concreteType') return CONCRETE_TYPE_VALUES.has(value) ? null : 'コンクリート種別が不正です';
  if (key === 'concreteThicknessMm') {
    const n = toFiniteNumber(value);
    return n !== null && n > 0 ? null : '厚は0より大きい数値で入力してください';
  }
  if (key === 'concreteTopBelowFlMm' || key === 'alcTopBelowFlMm') {
    const n = toFiniteNumber(value);
    return n !== null && n >= 0 ? null : '上面のFL−は0以上の数値で入力してください';
  }
  if (key === 'braceMemberType') return BRACE_MEMBER_TYPE_VALUES.has(value) ? null : 'ブレース種別が不正です';
  if (key === 'braceSpec') {
    const list = BRACE_SPECS_BY_TYPE[ctx.braceMemberType] ?? BRACE_SPECS_BY_TYPE[FIELD_DEFAULTS.braceMemberType];
    return list.includes(value) ? null : 'ブレースの規格が選択肢にありません';
  }
  if (key === 'braceHeightMm') {
    if (value == null) return null; // 自動
    const n = toFiniteNumber(value);
    return n !== null && n >= 0 ? null : '設置高さは0以上の数値で入力してください';
  }
  if (key === 'raiseChannelSpec') return RAISE_CHANNEL_SPECS.includes(value) ? null : 'かさ上げ鋼材が選択肢にありません';
  return null;
}
