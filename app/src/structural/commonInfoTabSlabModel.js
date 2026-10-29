// 共通タブ「スラブ（S造）」欄の行構成・入力検証の純モジュール（S造スラブ指定 S5・2026-10-29）。
// .jsx は node:test から import できないため、判断（出すか・どの行か・選択肢・読取専用・検証文言）をここに置いてテストで固定する。
// import は structureRules.js / steelSlabSpec.js / core/constants.js だけ（store.js / snap.js / .jsx を静的に引かない）。
// 材料の配列（{code,name,thickness}）は呼び出し側（.jsx）が composeList で作って渡す。
import { rulesFor, effectiveStructure } from './structureRules.js';
import {
  SteelSlabKind, BraceMemberType,
  STEEL_SLAB_KIND_LABELS, SLAB_CONCRETE_TYPE_LABELS, BRACE_MEMBER_TYPE_LABELS,
  ROUND_BAR_BRACE_SPECS, ANGLE_BRACE_SPECS, RAISE_CHANNEL_SPECS,
  deckPlateOptions, flatDeckPlateOptions, alcPlateOptions, validateSteelSlabField,
} from './steelSlabSpec.js';
import { DEFAULT_ROUND_BAR_BRACE_SPEC } from '../core/constants.js';

/** 欄の見出し。 */
export const SLAB_SECTION_TITLE = 'スラブ（S造）';
/** カタログに無い（削除された）材料コードが現在値のとき、選択肢の先頭へ補う表示の接尾。 */
export const SLAB_REMOVED_CODE_SUFFIX = '（カタログに無い）';
/** ブレース設置高さが空（null）のときの入力欄の薄字。 */
export const BRACE_HEIGHT_PLACEHOLDER = '自動（子梁成の1/2）';
/** ALC の厚（読取専用）の注記。 */
export const ALC_THICKNESS_NOTE = '（材料から自動）';
/** 種別の行の見出し。 */
export const SLAB_KIND_ROW_LABEL = '種別';

export const SLAB_ROW_KIND = Object.freeze({ SELECT: 'select', NUMBER: 'number', READONLY: 'readonly' });

/** 数値として扱う項目（入力は文字列で来る）。 */
const NUMBER_KEYS = new Set(['concreteThicknessMm', 'concreteTopBelowFlMm', 'braceHeightMm', 'alcTopBelowFlMm']);

/**
 * 欄を出すか。建物全体の主構造が S造、またはこの階の実効主構造（階の上書き・地階構造を反映）が S造のとき。
 * 判定は主構造の選択子 steelSlabAssignment（structureRules.js）に任せ、構造名の直書きを持たない。
 * 建物がS造なら全階で出し（上書き先が別構造の階でも建物全体の仕様の入口は残す）、
 * 階の上書きだけがS造の階でも出す（その階の割付けに効く）。リード裁定 2026-10-29。
 */
export function showSteelSlabSection(graph, project) {
  const info = project?.structuralInfo;
  return rulesFor(info?.mainStructure).steelSlabAssignment === true
    || rulesFor(effectiveStructure(graph, project)).steelSlabAssignment === true;
}

// loaded=false（材料が未読込み＝materials 未定義）では「カタログに無い」と断定できないため、現在値はコードのまま補い接尾を付けない。
function plateOptions(list, currentCode, loaded) {
  const options = list.map(m => ({ value: m.code, label: m.name }));
  if (currentCode != null && !list.some(m => m.code === currentCode)) {
    return [{ value: currentCode, label: loaded ? `${currentCode}${SLAB_REMOVED_CODE_SUFFIX}` : currentCode }, ...options];
  }
  return options;
}
function labelOptions(labels) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
function listOptions(list) {
  return list.map(v => ({ value: v, label: v }));
}

const BRACE_SPECS_BY_TYPE = Object.freeze({
  [BraceMemberType.ROUND_BAR]: ROUND_BAR_BRACE_SPECS,
  [BraceMemberType.ANGLE]: ANGLE_BRACE_SPECS,
});
function defaultBraceSpecFor(memberType) {
  return memberType === BraceMemberType.ANGLE ? ANGLE_BRACE_SPECS[0] : DEFAULT_ROUND_BAR_BRACE_SPEC;
}

function concreteRows(spec) {
  return [
    { key: 'concreteType', label: 'コンクリート種別', kind: SLAB_ROW_KIND.SELECT, options: labelOptions(SLAB_CONCRETE_TYPE_LABELS), value: spec.concreteType },
    { key: 'concreteThicknessMm', label: '厚', kind: SLAB_ROW_KIND.NUMBER, value: spec.concreteThicknessMm, unit: 'mm', min: 0 },
    { key: 'concreteTopBelowFlMm', label: 'コンクリート上面 FL−', kind: SLAB_ROW_KIND.NUMBER, value: spec.concreteTopBelowFlMm, unit: 'mm', min: 0 },
  ];
}

/**
 * 共通仕様（全種別の項目を持つ）から、種別の行と選択中の種別の項目の行を作る。
 * @param {{ spec: object, materials: Array<{code:string,name:string,thickness?:number}> }} arg
 * @returns {{ kindRow: object, rows: Array<{ key: string, label: string, kind: 'select'|'number'|'readonly',
 *   options?: Array<{value:string,label:string}>, value: *, unit?: string, placeholder?: string, min?: number, note?: string }> }}
 */
export function steelSlabCommonRows({ spec, materials }) {
  const kindRow = {
    key: 'kind', label: SLAB_KIND_ROW_LABEL, kind: SLAB_ROW_KIND.SELECT,
    options: labelOptions(STEEL_SLAB_KIND_LABELS), value: spec.kind,
  };
  const loaded = materials != null; // 未読込み（undefined/null）と空の読込み済みを区別する
  let rows = [];
  switch (spec.kind) {
    case SteelSlabKind.DECK:
      rows = [
        { key: 'deckPlateCode', label: 'プレート', kind: SLAB_ROW_KIND.SELECT, options: plateOptions(deckPlateOptions(materials), spec.deckPlateCode, loaded), value: spec.deckPlateCode },
        ...concreteRows(spec),
      ];
      break;
    case SteelSlabKind.FLAT_DECK:
      rows = [
        { key: 'flatDeckPlateCode', label: 'プレート', kind: SLAB_ROW_KIND.SELECT, options: plateOptions(flatDeckPlateOptions(materials), spec.flatDeckPlateCode, loaded), value: spec.flatDeckPlateCode },
        ...concreteRows(spec),
      ];
      break;
    case SteelSlabKind.BRACE:
      rows = [
        { key: 'braceMemberType', label: 'ブレース', kind: SLAB_ROW_KIND.SELECT, options: labelOptions(BRACE_MEMBER_TYPE_LABELS), value: spec.braceMemberType },
        { key: 'braceSpec', label: '規格', kind: SLAB_ROW_KIND.SELECT, options: listOptions(BRACE_SPECS_BY_TYPE[spec.braceMemberType] ?? ROUND_BAR_BRACE_SPECS), value: spec.braceSpec },
        { key: 'braceHeightMm', label: '設置高さ', kind: SLAB_ROW_KIND.NUMBER, value: spec.braceHeightMm, unit: 'mm', min: 0, placeholder: BRACE_HEIGHT_PLACEHOLDER },
      ];
      break;
    case SteelSlabKind.ALC: {
      const alcList = alcPlateOptions(materials);
      const thickness = alcList.find(m => m.code === spec.alcCode)?.thickness;
      rows = [
        { key: 'alcCode', label: 'プレート', kind: SLAB_ROW_KIND.SELECT, options: plateOptions(alcList, spec.alcCode, loaded), value: spec.alcCode },
        { key: 'alcThickness', label: '厚', kind: SLAB_ROW_KIND.READONLY, value: thickness == null ? '' : String(thickness), unit: 'mm', note: ALC_THICKNESS_NOTE },
        { key: 'alcTopBelowFlMm', label: 'ALC上面 FL−', kind: SLAB_ROW_KIND.NUMBER, value: spec.alcTopBelowFlMm, unit: 'mm', min: 0 },
        { key: 'raiseChannelSpec', label: 'かさ上げ鋼材', kind: SLAB_ROW_KIND.SELECT, options: listOptions(RAISE_CHANNEL_SPECS), value: spec.raiseChannelSpec },
      ];
      break;
    }
    default:
      break;
  }
  return { kindRow, rows };
}

/**
 * 1項目の編集を検証し、確定する差分（patch）を返す。.jsx は error があれば書かずに行の下へ出し、
 * 無ければ `{ ...spec, ...patch }` を setSteelSlabSpec へ渡す。
 * - 数値項目は文字列入力を数値へ（数値でない文字列はそのまま渡して検証の文言を得る）。braceHeightMm の空は null（自動）。
 * - braceMemberType を変えて現在の braceSpec が新しい種別の規格に無ければ、同じ patch で braceSpec を新種別の既定へ。
 * - kind の変更は他種別の項目に触れない（共通仕様は全種別の項目を保つ）。
 * @returns {{ error: string|null, patch: object|null }}
 */
export function planSlabEdit({ spec, key, value, materials }) {
  let v = value;
  if (NUMBER_KEYS.has(key)) {
    const blank = v == null || (typeof v === 'string' && v.trim() === '');
    if (blank) v = key === 'braceHeightMm' ? null : '';
    else if (typeof v === 'string' && Number.isFinite(Number(v))) v = Number(v);
  }
  let error;
  if (key === 'kind') {
    error = Object.values(SteelSlabKind).includes(v) ? null : '種別が不正です';
  } else {
    error = validateSteelSlabField(spec.kind, key, v, { materialCatalog: materials, braceMemberType: spec.braceMemberType });
  }
  if (error) return { error, patch: null };
  const patch = nextSpecOnChange(spec, key, v);
  // 値が変わらない確定（同じ数値の再入力・空→null の据置き等）は書かない（再計算と undo を無駄に積まない）。
  const unchanged = Object.entries(patch).every(([k, val]) => (spec[k] ?? null) === (val ?? null));
  return { error: null, patch: unchanged ? null : patch };
}

/**
 * 共通仕様へ差分を書く。材料カタログでの照合はしない（第2引数なし）: 編集した項目の照合は planSlabEdit で済んでおり、
 * ここで照合すると編集していない項目・選択中でない種別のプレートコード（消えた材料）まで既定へ落ちるため
 * （S1 裁定「消えた材料も選択を保つ」）。onStructureChanged の mutate の中から呼ぶ。
 */
export function commitSteelSlabSpec(info, patch) {
  info.setSteelSlabSpec({ ...info.steelSlabSpec, ...patch });
}

/** key を v にしたときに spec へ重ねる差分。braceMemberType の切替で規格が合わなければ規格を新種別の既定へ戻す。 */
export function nextSpecOnChange(spec, key, v) {
  if (key === 'braceMemberType') {
    const list = BRACE_SPECS_BY_TYPE[v] ?? ROUND_BAR_BRACE_SPECS;
    return list.includes(spec.braceSpec) ? { braceMemberType: v } : { braceMemberType: v, braceSpec: defaultBraceSpecFor(v) };
  }
  return { [key]: v };
}
