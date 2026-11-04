// ================================================================
// DXF 読込みの入口（純関数）。バイト列 → 解析結果。例外は握って { ok:false, error } にする（外部ファイルは信用しない）。
//   readDxf(bytes)            : 復号 → 字句分解 → 構文解析（単位に依存しない）。
//   buildDxfScene(parsed, …)  : mm 換算（unitFactor で上書き可）→ 線分 → 連結成分。単位を変えての再計算に使う。
// 警告は構文解析・単位・成分の順に並べ、成分ごとの警告は成分側（component.warnings）に持つ。
// ================================================================

import { DxfReject } from '../../core/constants.js';
import { dxfDecode } from './dxfDecode.js';
import { dxfTokenize } from './dxfTokenize.js';
import { dxfParse } from './dxfParse.js';
import { dxfEntities } from './dxfEntities.js';
import { dxfToComponents } from './dxfToStrokes.js';

const unexpected = e => ({ ok: false, error: { code: DxfReject.UNEXPECTED, message: e instanceof Error ? e.message : String(e) } });

/** @returns {{ok:true, parsed:object, encoding:string} | {ok:false, error:{code:string}}} */
export function readDxf(bytes) {
  try {
    const decoded = dxfDecode(bytes);
    if (decoded.error) return { ok: false, error: decoded.error };
    const tokens = dxfTokenize(decoded.text);
    if (tokens.error) return { ok: false, error: tokens.error };
    return { ok: true, parsed: dxfParse(tokens.pairs), encoding: decoded.encoding };
  } catch (e) {
    return unexpected(e);
  }
}

/**
 * @param {object} parsed readDxf の parsed
 * @param {{unitFactor?: number|null, hiddenLayers?: string | string[] | Set<string>}} [opts] hiddenLayers＝off にするレイヤ名（線分の段階で除き、成分を作り直す）
 * @returns {{ok:true, segments:object[], components:object[], unitFactor:number, unitSource:string, warnings:object[],
 *            layers:{name:string, segmentCount:number}[], hiddenLayers:string[]} | {ok:false, error:object}}
 *   segments・components は off のレイヤを除いた残り。layers は全線分から数えた名前昇順の一覧（off のものも含む）。
 *   hiddenLayers は存在するレイヤ名だけの昇順配列（存在しない名前は捨てる）。
 */
export function buildDxfScene(parsed, { unitFactor = null, hiddenLayers = [] } = {}) {
  try {
    const ents = dxfEntities(parsed, { unitFactor });
    const counts = new Map();
    for (const seg of ents.segments) counts.set(seg.layer, (counts.get(seg.layer) ?? 0) + 1);
    const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const layers = [...counts].map(([name, segmentCount]) => ({ name, segmentCount })).sort((x, y) => byName(x.name, y.name));
    const hidden = [...new Set(typeof hiddenLayers === 'string' ? [hiddenLayers] : hiddenLayers)].filter(n => counts.has(n)).sort(byName);
    const hiddenSet = new Set(hidden);
    const segments = hiddenSet.size === 0 ? ents.segments : ents.segments.filter(seg => !hiddenSet.has(seg.layer));
    const { components } = dxfToComponents(segments);
    return {
      ok: true, segments, components,
      unitFactor: ents.unitFactor, unitSource: ents.unitSource,
      warnings: [...parsed.warnings, ...ents.warnings],
      layers, hiddenLayers: hidden,
    };
  } catch (e) {
    return unexpected(e);
  }
}
