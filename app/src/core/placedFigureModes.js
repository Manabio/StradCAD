/**
 * 図面モード（姿図配置モード）の定義表（constants.js の PLACED_FIGURE_MODES）から、モードの一覧・表示名・
 * 天伏に出す分類を導く純モジュール。「表に 1 行 = モード 1 つ」で、導出はここだけが持つ
 * （設計意図は .claude/mode-system.md の「図面モード」の節）。
 *
 * import は ./constants.js と ../error.js（どちらも無 import の葉）だけ——core/centerLineKindPolicy.js が
 * 本ファイルを引くため、node:test から単体 import できる状態を保つ（extractedModuleImportInvariant）。
 * 向きは constants ← placedFigureModes ← centerLineKindPolicy。
 */
import { PLACED_FIGURE_MODES, PLACED_FIGURE_SUBJECTS, CEILING_PLACED_FIGURE_SUBJECTS, CORE_APP_MODES } from './constants.js';
import {
  ERR_PLACED_FIGURE_MODE_DUPLICATE, ERR_PLACED_FIGURE_MODE_CONFLICT, ERR_PLACED_FIGURE_MODE_NO_SUBJECTS,
  ERR_PLACED_FIGURE_MODE_BAD_SUBJECT, ERR_PLACED_FIGURE_MODE_OVERLAP,
} from '../error.js';

function validateRows(rows, coreModes) {
  const ownerOfMode = new Map();
  const ownerOfSubject = new Map();
  for (const row of rows) {
    const id = row.mode;
    if (ownerOfMode.has(id)) throw new Error(ERR_PLACED_FIGURE_MODE_DUPLICATE(id));
    if (coreModes.includes(id)) throw new Error(ERR_PLACED_FIGURE_MODE_CONFLICT(id));
    ownerOfMode.set(id, row);
    if (!Array.isArray(row.subjects) || row.subjects.length === 0) throw new Error(ERR_PLACED_FIGURE_MODE_NO_SUBJECTS(id));
    for (const subject of row.subjects) {
      if (!PLACED_FIGURE_SUBJECTS.includes(subject)) throw new Error(ERR_PLACED_FIGURE_MODE_BAD_SUBJECT(id, subject));
      const other = ownerOfSubject.get(subject);
      if (other !== undefined && other !== id) throw new Error(ERR_PLACED_FIGURE_MODE_OVERLAP(other, id, subject));
      ownerOfSubject.set(subject, id);
    }
  }
}

/**
 * 定義表の行から導出一式を組む（凍結）。rows が不正なら Error を投げる（文言は error.js）。
 * @param {ReadonlyArray<{mode:string,label:string,subjects:string[]}>} rows
 * @param {ReadonlyArray<string>} coreModes 既存の appMode（id の衝突検査の相手）
 */
export function buildPlacedFigureModeRegistry(rows, coreModes) {
  validateRows(rows, coreModes);
  const defs = rows.map(r => Object.freeze({ mode: r.mode, label: r.label, subjects: Object.freeze([...new Set(r.subjects)]) }));
  const byId = new Map(defs.map(d => [d.mode, d]));
  return Object.freeze({
    modeIds: Object.freeze(defs.map(d => d.mode)),
    isMode: (appMode) => byId.has(appMode),
    defOf: (appMode) => byId.get(appMode) ?? null,
    labelOf: (appMode) => byId.get(appMode)?.label ?? null,
    ceilingSubjectsOf: (appMode) => Object.freeze((byId.get(appMode)?.subjects ?? []).filter(s => CEILING_PLACED_FIGURE_SUBJECTS.includes(s))),
  });
}

/** 本番の定義表（PLACED_FIGURE_MODES）から組んだ導出一式。個別の書き出しは下の 5 つ。 */
export const PLACED_FIGURE_MODE_REGISTRY = buildPlacedFigureModeRegistry(PLACED_FIGURE_MODES, CORE_APP_MODES);

/** 図面モードの appMode 値（定義表の並び）。 */
export const PLACED_FIGURE_MODE_IDS = PLACED_FIGURE_MODE_REGISTRY.modeIds;
export const isPlacedFigureMode = PLACED_FIGURE_MODE_REGISTRY.isMode;
/** appMode の定義行。図面モードでなければ null。 */
export const placedFigureModeOf = PLACED_FIGURE_MODE_REGISTRY.defOf;
/** appMode の表示名。図面モードでなければ null。 */
export const placedFigureModeLabelOf = PLACED_FIGURE_MODE_REGISTRY.labelOf;
/** appMode が扱う分類のうち天伏（見上げ）に出すもの。図面モードでなければ空。 */
export const placedFigureModeCeilingSubjectsOf = PLACED_FIGURE_MODE_REGISTRY.ceilingSubjectsOf;
