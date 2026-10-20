/**
 * 階設定表（階高＋GL）の読み口。純モジュール（store.js・snap.js・.jsx・react 系を静的に引かない。node:test から単体 import 可）。
 *
 * 用語: nFL＝n階の床仕上げ高さ。n階階高＝nFL〜(n+1)FL。最上階の階高＝最上階FL〜軒桁上端。
 * 内部の基準は「1FL＝0」（Plane.elevation）。GL は Project.glBelow1FlMm（GL＝1FL−この値）。
 * 階の追加・振り直し（floorOps.js）は storyHeightsMm で操作前の並びから各階の階高を採り、それを保って積み直す（S3）。
 */
import { rulesFor, effectiveStructure } from './structural/structureRules.js';
import { toHalfWidthSignedNumber } from './halfWidth.js';

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

// ---- 階設定表の入力検査と確定（S4。UI 無し）----

const INT_RE = /^-?\d+$/;

/** 階高の入力文字列の検査。整数 mm・STORY_HEIGHT_MIN_MM 以上（上限なし）。空欄・小数・非数は不可。 */
export function validateStoryHeightText(text) {
  const s = toHalfWidthSignedNumber(text).trim();
  if (s === '') return { ok: false, value: null, error: '階高を入力してください。' };
  if (!INT_RE.test(s)) return { ok: false, value: null, error: '階高は整数(mm)で入力してください。' };
  const value = Number(s);
  if (value < STORY_HEIGHT_MIN_MM) {
    return { ok: false, value: null, error: `階高は${STORY_HEIGHT_MIN_MM}mm以上にしてください。` };
  }
  return { ok: true, value, error: null };
}

/** GL（1FL からの下がり量 mm）の入力文字列の検査。整数（負も可・上限下限なし）。 */
export function validateGlText(text) {
  const s = toHalfWidthSignedNumber(text).trim();
  if (s === '') return { ok: false, value: null, error: 'GLを入力してください。' };
  if (!INT_RE.test(s)) return { ok: false, value: null, error: 'GLは整数(mm)で入力してください。' };
  return { ok: true, value: Number(s), error: null };
}

/**
 * 階設定表の「確定」の計算部（純関数）。1FL を動かさず、変えた階高ぶんだけ他の階をずらす。
 *   地上階（startFloor>=1）: n 階の階高を変えると、それより上の全階の elevation がずれる（下の階は動かない）。
 *   地階: 地階 Bn の階高＝BnFL〜直上階FL。変えると Bn とそれより下の地階がずれる（上は動かない）。
 *   最上階の階高は topStoryHeightMm にだけ書く（elevation は動かない）。
 * ずらしは「各階高の差分×層数」の累積で求める（元の elevation に足す）。触っていない階の elevation は
 * 浮動小数の誤差も入らず、旧データの非整数の階高もそのまま保たれる。
 * 基準階＝startFloor===1 の最初の階。無い（全階が地階）ときは最上の地階を固定して下へずらす
 * （「地階の階高を変えたら地階側をずらす」）。
 *
 * @param {Array} planes - 採用階（検討案・屋根専用平面を除く）の elevation 昇順（project.planes）
 * @param {{heights?: Map<string,number|string>|Object<string,number|string>, glBelow1FlMm?: number|string}} draft -
 *   契約: ユーザーが**編集した行だけ**を入れる。入っている値（数値・文字列とも）は常に検査する
 *   （数値は整数かつ1450以上、文字列は validateStoryHeightText。全角数字は半角に直してから）。
 *   入っていない行は検査も変更もしない（旧データの非整数の階高でも止まらない）。編集値が初期値
 *   （storyHeightsMm）と同じなら検査は通すが変化なし（updates に載らない）。
 *   glBelow1FlMm: 編集したときだけ入れる（数値は整数、文字列は validateGlText）。無ければ GL は変更なし（null）。
 * @param {number} topHeightMm - 現在の最上階の階高（resolveTopStoryHeightMm(project)）
 * @param {number} [currentGlBelow1FlMm=0] - 現在の GL（project.glBelow1FlMm）
 * @returns {{updates:Array<{id,name,startFloor,elevation,topStoryHeightMm?}>, glBelow1FlMm:number|null,
 *   invalidIds:string[], glInvalid:boolean, ok:boolean}}
 *   updates＝applyPlaneMetas がそのまま書ける形（変化の無い階は載せない）。glBelow1FlMm＝変更後の GL
 *   （変更なしは null）。invalidIds＝不正な行（S5 が赤表示）。ok＝invalidIds が空かつ glInvalid=false
 *   （ok でないとき updates は空・glBelow1FlMm は null）。
 */
export function computeFloorHeightEdit(planes, draft, topHeightMm, currentGlBelow1FlMm = 0) {
  const initial = storyHeightsMm(planes, topHeightMm);
  const invalidIds = [];
  const newHeights = new Map(); // 編集した行のうち検査を通ったもの（初期値と違うものだけ）
  const entries = draft?.heights instanceof Map ? [...draft.heights] : Object.entries(draft?.heights ?? {});
  for (const [id, raw] of entries) {
    if (!initial.has(id)) continue;
    const old = initial.get(id);
    let value;
    if (typeof raw === 'string') {
      const r = validateStoryHeightText(raw);
      if (!r.ok) { invalidIds.push(id); continue; }
      value = r.value;
    } else {
      value = raw;
      if (!Number.isInteger(value) || value < STORY_HEIGHT_MIN_MM) { invalidIds.push(id); continue; }
    }
    if (value !== old) newHeights.set(id, value);
  }

  let glInvalid = false;
  let gl = null;
  if (draft?.glBelow1FlMm !== undefined && draft.glBelow1FlMm !== null) {
    const raw = draft.glBelow1FlMm;
    const value = typeof raw === 'string' ? validateGlText(raw).value : raw;
    if (value === null || !Number.isInteger(value)) glInvalid = true; // 数値は整数のみ可
    else if (value !== currentGlBelow1FlMm) gl = value;
  }

  if (invalidIds.length > 0 || glInvalid) {
    return { updates: [], glBelow1FlMm: null, invalidIds, glInvalid, ok: false };
  }

  // 各階の高さ変化 delta[i]＝層数×(新−旧)。最上階の階高は elevation を動かさない。
  const n = planes.length;
  const delta = planes.map(p => (newHeights.has(p.id) ? (newHeights.get(p.id) - initial.get(p.id)) * p.stories : 0));
  const firstIdx = planes.findIndex(p => p.startFloor === 1);
  const anchor = firstIdx >= 0 ? firstIdx : n - 1; // 全階が地階: 最上の地階を固定して下へずらす
  const shift = new Array(n).fill(0);
  let acc = 0;
  for (let j = anchor + 1; j < n; j++) { acc += delta[j - 1]; shift[j] = acc; }   // 上へ
  acc = 0;
  for (let j = anchor - 1; j >= 0; j--) { acc -= delta[j]; shift[j] = acc; }      // 下へ（地階）
  // 最上階の delta は上に積む階が無いので shift に現れない。

  const updates = [];
  planes.forEach((p, i) => {
    const topChanged = i === n - 1 && newHeights.has(p.id);
    if (shift[i] === 0 && !topChanged) return;
    const u = { id: p.id, name: p.name, startFloor: p.startFloor, elevation: p.elevation + shift[i] };
    if (topChanged) u.topStoryHeightMm = newHeights.get(p.id);
    updates.push(u);
  });
  return { updates, glBelow1FlMm: gl, invalidIds, glInvalid, ok: true };
}

/** 軒桁上端の高さ（1FL=0 基準）。最上階の elevation + 1層分の階高 × stories。階が無ければ null。 */
export function eaveTopZMm(orderedPlanes, topHeightMm) {
  const top = orderedPlanes[orderedPlanes.length - 1];
  if (!top) return null;
  return top.elevation + topHeightMm * top.stories;
}
