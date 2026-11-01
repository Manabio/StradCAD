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
 * @param {{unitFactor?: number|null}} [opts]
 * @returns {{ok:true, segments:object[], components:object[], unitFactor:number, unitSource:string, warnings:object[]} | {ok:false, error:object}}
 */
export function buildDxfScene(parsed, { unitFactor = null } = {}) {
  try {
    const ents = dxfEntities(parsed, { unitFactor });
    const { components } = dxfToComponents(ents.segments);
    return {
      ok: true, segments: ents.segments, components,
      unitFactor: ents.unitFactor, unitSource: ents.unitSource,
      warnings: [...parsed.warnings, ...ents.warnings],
    };
  } catch (e) {
    return unexpected(e);
  }
}
