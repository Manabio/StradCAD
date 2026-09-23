// ================================================================
// R13: 文書同梱材が本体（user/builtin）と不一致のときの表示規則（色・記号・ツールチップ文言）。
//
// 純モジュール（葉）。catalogKinds.js（登録表。compareFields/knownFieldsの参照）と
// catalogMatch.js（valuesEqual/diffEntries。同ディレクトリの兄弟＝許可リスト内）に依存する。
// 等価判定はcatalogMatch.jsの1本のみ——ここで複製しない（2026-09-22 QA指摘Major-1:
// 複製したdeepEqualはvaluesEqualと入れ子の意味論が食い違っていたため廃止）。
//
// 色は JS 定数のみで持つ（CSSクラスにしない）。.jsx 側は style={{ color: CATALOG_DIFF_COLOR }}
// で使う。renderer/・figure/（図面・印刷・出力）はこのモジュールを import しない
// （Q11裁定: 図面・印刷・出力する仕上げ表にはオレンジ表示を付けない）。
// ================================================================

import { kindDef } from './catalogKinds.js';
import { diffEntries } from './catalogMatch.js';

/**
 * R13 差分表示色。renderer/SiteLinesLayer.jsx の隣地境界線と同じ値(#f97316)だが、
 * 意味が別（敷地図の線色 vs カタログの不一致表示）のため定数は共有しない。
 */
export const CATALOG_DIFF_COLOR = '#f97316';

/** 差分がある名称の後ろに付ける記号。 */
export const CATALOG_DIFF_MARK = '≠';

// 項目名 → 日本語ラベル（登録表 knownFields に対応する表示名の唯一の定義箇所）。
const FIELD_LABELS = Object.freeze({
  material: Object.freeze({
    code: 'コード', name: '名称', spec: '仕様', x: 'X', y: 'Y',
    thickness: '厚', note: '備考', category: '区分', backingClass: '下地区分',
  }),
  section: Object.freeze({
    key: 'キー', materialType: '材種', shape: '断面形状', width: '幅', height: 'せい',
    webThickness: 'ウェブ厚', flangeThickness: 'フランジ厚', wallThickness: '管厚', label: '呼称',
  }),
  openingSubType: Object.freeze({
    category: '区分', key: 'キー', label: '呼称', mechanism: '機構', wallKinds: '対応壁種',
    defaultWidth: '既定幅', defaultHeight: '既定高', childRatio: '子扉比率',
    fireLeaves: '防火枚数', fireAngle: '防火角度', slideLayout: '引違い配置',
  }),
  interiorMaster: Object.freeze({
    key: 'キー', label: '呼称', wallMaterial: '壁材', wallFinish: '壁仕上げ', ceilingHeight: '天井高',
  }),
  boundaryMaster: Object.freeze({
    key: 'キー', label: '呼称', kind: '種類', layers: '層構成', derivedFrom: '継承元', fields: '項目',
  }),
});

/**
 * 項目名 → 日本語ラベル（FIELD_LABELSの唯一の読み出し口）。QA指摘Minor-1（ステップ10f・
 * 2026-09-23）: ui/CatalogMaintenancePanel.jsx の閲覧タブ（ReadonlyKindTab）詳細欄も
 * このfieldLabelを使う——ツールチップ（diffTooltip）と詳細欄で別の日本語名が同時に出る
 * 二重定義を防ぐため、ラベル文字列はFIELD_LABELS（本ファイル）にだけ持つ。
 * 未知の種別・項目はfield名そのものを返す（投げない）。
 * @param {string} kind
 * @param {string} field
 * @returns {string}
 */
export function fieldLabel(kind, field) {
  return FIELD_LABELS[kind]?.[field] ?? field;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 表示用の値整形。未設定（null/undefined/空文字）は「（未設定）」。配列・オブジェクトはJSON化。 */
function formatFieldValue(v) {
  if (v === null || v === undefined || v === '') return '（未設定）';
  if (Array.isArray(v) || isPlainObject(v)) return JSON.stringify(v);
  return String(v);
}

/**
 * diffFields（entryとbaseEntryで異なる項目）を「項目名 現在値（本体 本体値）」の形で
 * 「／」区切りに連結する（例: 「厚 15（本体 12.5）／名称 ○○（本体 △△）」）。
 * diffFields が空/null なら空文字。
 */
export function diffTooltip(kind, diffFields, entry, baseEntry) {
  kindDef(kind); // 未知の種別は例外
  if (!diffFields || diffFields.length === 0) return '';
  return diffFields
    .map(f => `${fieldLabel(kind, f)} ${formatFieldValue(entry?.[f])}（本体 ${formatFieldValue(baseEntry?.[f])}）`)
    .join('／');
}

/**
 * from → to で異なる項目を [{field, label, from, to}] で返す（6-3の「t=12.5 → t=15」表示・
 * 保守パネルの「違っている項目だけオレンジ」用）。diffFields 省略時は catalogMatch.js の
 * diffEntries(kind, from, to) で求める（等価判定を二重に持たない——diffPairs は項目名を
 * 受けて値を並べるだけで、差分判定そのものは行わない）。呼び出し側が既に docDiffMap 等で
 * diffFields を持っていれば、それをそのまま渡して再計算を避けられる。
 * from/to は生の値（未整形）——表示側で formatFieldValue 相当の整形を行う。
 */
export function diffPairs(kind, from, to, diffFields = diffEntries(kind, from, to)) {
  kindDef(kind); // 未知の種別は例外（diffEntries内でも検査されるが、from/to省略呼び出しでも一貫させる）
  return diffFields.map(f => ({ field: f, label: fieldLabel(kind, f), from: from?.[f], to: to?.[f] }));
}
