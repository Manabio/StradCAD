/**
 * 階設定表（階高＋GL）の読み口。純モジュール（store.js・snap.js・.jsx・react 系を静的に引かない。node:test から単体 import 可）。
 *
 * 用語: nFL＝n階の床仕上げ高さ。n階階高＝nFL〜(n+1)FL。最上階の階高＝最上階FL〜軒桁上端。
 * 内部の基準は「1FL＝0」（Plane.elevation）。GL は Project.glBelow1FlMm（GL＝1FL−この値）。
 * 階の追加・振り直し（floorOps.js）は storyHeightsMm で操作前の並びから各階の階高を採り、それを保って積み直す（S3）。
 */
import { rulesFor, effectiveStructure } from './structural/structureRules.js';

/** 階高の下限(mm)。 */
export const STORY_HEIGHT_MIN_MM = 1450;
/** 階高が決まらないときの値(mm)。構造規則の横架材天端オフセットを引く前の素の階高。 */
export const STORY_HEIGHT_FALLBACK_MM = 3000;

/**
 * 最上階の階高（FL〜軒桁上端）の旧来の値。未設定の文書はこの値として扱う。
 * 在来木造は横架材天端が FL−beamTopBelowFLMm のため、その分だけ低い（2900）。それ以外は 3000。
 */
export function legacyTopStoryHeightMm(structure) {
  const framing = rulesFor(structure).framing;
  return framing ? STORY_HEIGHT_FALLBACK_MM - framing.beamTopBelowFLMm : STORY_HEIGHT_FALLBACK_MM;
}

/**
 * 最上階の1層分の階高。plane.topStoryHeightMm が有限の正数ならそれ、でなければ legacy。
 * 読む時点で解決する（読込み時に plane へ書き込まない）。
 */
export function topStoryHeightMmOf(plane, structure) {
  const v = plane?.topStoryHeightMm;
  return Number.isFinite(v) && v > 0 ? v : legacyTopStoryHeightMm(structure);
}

/**
 * プロジェクトの最上階（採用階のうち検討案・屋根専用平面を除く最上位＝project.planes の末尾）の階高。
 * 建物全体の構造（effectiveStructure(null, project)）から旧来値を導く。採用階が無ければ旧来値。
 */
export function resolveTopStoryHeightMm(project) {
  const planes = project?.planes ?? [];
  const top = planes[planes.length - 1];
  return topStoryHeightMmOf(top, effectiveStructure(null, project));
}

/**
 * 各階の1層分の階高 Map(id→mm)。orderedPlanes＝採用階（検討案・屋根専用平面を除く）の elevation 昇順。
 * 最上階以外は (次の階の elevation − この階の elevation) / stories、最上階は topHeightMm。
 */
export function storyHeightsMm(orderedPlanes, topHeightMm) {
  const map = new Map();
  orderedPlanes.forEach((plane, i) => {
    const next = orderedPlanes[i + 1];
    map.set(plane.id, next ? (next.elevation - plane.elevation) / plane.stories : topHeightMm);
  });
  return map;
}

/** 軒桁上端の高さ（1FL=0 基準）。最上階の elevation + 1層分の階高 × stories。階が無ければ null。 */
export function eaveTopZMm(orderedPlanes, topHeightMm) {
  const top = orderedPlanes[orderedPlanes.length - 1];
  if (!top) return null;
  return top.elevation + topHeightMm * top.stories;
}
