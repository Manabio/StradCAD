// 在来木造の梁カードの「梁成」「自動梁の対象」欄（表示だけ・入力不可。ユーザー裁定2026-10-02）の
// 表示判断を持つ純モジュール（react・.jsx・store.js・snap.js を静的に引かない＝node:test から単体 import 可）。
// 確定処理（書き込み）は持たない——手入力 woodManualDepthMm を書く画面は無い（structural-model.md「成の手入力」）。
import { sectionList } from './sectionCatalog.js';
import { WOOD_DEPTH_BEAM_ROLES } from './structureRules.js';
import { isValidManualDepth } from './woodFraming.js';

/**
 * 欄を出す条件: 在来木造（rules.framing が真）・beamMap・主構造の材種・成の自動更新対象 role。
 * @param {string} mapName
 * @param {{materialType?: string, role?: string}} beam 代表の梁
 * @param {{framing?: any, baseMaterial?: string}} rules rulesFor(structure)
 */
export function showsWoodBeamDepthFields(mapName, beam, rules) {
  return !!rules?.framing && mapName === 'beamMap'
    && beam?.materialType === rules.baseMaterial
    && WOOD_DEPTH_BEAM_ROLES.includes(beam?.role);
}

/**
 * 材幅に対応するカタログ（overlay込み）の成の昇順。幅が非数・0以下なら空。
 * @param {number} columnWidthMm
 * @returns {number[]}
 */
export function woodBeamDepthOptions(columnWidthMm) {
  if (!Number.isFinite(columnWidthMm) || columnWidthMm <= 0) return [];
  const depths = new Set();
  for (const s of sectionList()) {
    if (s.materialType === 'WOOD' && s.width === columnWidthMm && s.height >= columnWidthMm) depths.add(s.height);
  }
  return [...depths].sort((a, b) => a - b);
}

/**
 * 欄の表示値。depthValue: 有効な手入力（woodFraming.js isValidManualDepth。woodAutoFill.js と共通の判定）なら
 * その数、それ以外は null（＝「自動」）。autoTargetValue: dimensionStatus が 'auto' なら 'auto'、それ以外は 'locked'。
 * @returns {{depthValue: number|null, autoTargetValue: 'auto'|'locked'}}
 */
export function woodBeamDepthFieldView(beam, columnWidthMm) {
  const m = beam?.woodManualDepthMm;
  return {
    depthValue: isValidManualDepth(m, columnWidthMm) ? m : null,
    autoTargetValue: beam?.dimensionStatus === 'auto' ? 'auto' : 'locked',
  };
}
