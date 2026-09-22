// ================================================================
// カタログ束のバイト表現（JSON。R11・storage/projectInfo.js と同型）。
//
// 純モジュール（葉。他のsrcをimportしない）。node:test から単体 import 可能。
// 未知の種別・未知の項目は往復で保持する（JSON.parse/stringifyの素通しで自然に満たす）。
// ================================================================

const KNOWN_VERSION = 1;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * value がJSON化できるか検査する。undefined / NaN / ±Infinity / 関数 / Symbol / 循環参照は例外。
 * path は失敗箇所を示す（例: "$.catalogs.material[3].thickness"）。
 */
export function assertJsonSafe(value, path = '$') {
  walk(value, path, new Set());
}

function walk(value, path, seen) {
  if (value === undefined) throw new Error(`JSON化できない値です（undefined）: ${path}`);
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`JSON化できない値です（${typeof value}）: ${path}`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`JSON化できない数値です（NaN/Infinityは不可）: ${path}`);
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`循環参照はJSON化できません: ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, seen));
  } else {
    for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, seen);
  }
  seen.delete(value);
}

/** カタログ束 → Uint8Array（UTF-8 JSON）。JSON化できない値を含む場合は例外。 */
export function encodeCatalogBundle(bundle) {
  assertJsonSafe(bundle);
  return new TextEncoder().encode(JSON.stringify(bundle));
}

/** Uint8Array → カタログ束。parse失敗・形違い・version不正は例外。 */
export function decodeCatalogBundle(bytes) {
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('カタログ束のJSONが不正です');
  }
  if (!isPlainObject(data)) throw new Error('カタログ束の形式が不正です');
  if (data.version !== KNOWN_VERSION) {
    throw new Error(`未対応のカタログ束バージョンです: ${data.version}`);
  }
  if (!isPlainObject(data.catalogs)) throw new Error('カタログ束のcatalogsが不正です');
  return {
    version: data.version,
    catalogs: data.catalogs,
    encodings: normalizeOptionalObject(data.encodings, 'encodings'),
    aliases: normalizeOptionalObject(data.aliases, 'aliases'),
  };
}

/**
 * 省略可能なオブジェクト項目（encodings/aliases）を正規化する（QA指摘 M5）。
 * 未定義（キー自体が無い）のときだけ {} に落とす。定義済みでオブジェクトでなければ例外
 * （null・配列・文字列等を黙って {} にすり替えない）。
 */
function normalizeOptionalObject(value, name) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`カタログ束の${name}が不正です`);
  return value;
}
