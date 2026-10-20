/**
 * 階設定表（階高＋GL）の読み口。純モジュール（store.js・snap.js・.jsx・react 系を静的に引かない。node:test から単体 import 可）。
 *
 * 用語: nFL＝n階の床仕上げ高さ。n階階高＝nFL〜(n+1)FL。最上階の階高＝最上階FL〜軒桁上端。
 * 内部の基準は「1FL＝0」（Plane.elevation）。GL は Project.glBelow1FlMm（GL＝1FL−この値）。
 * 階の追加・振り直し（floorOps.js）は storyHeightsMm で操作前の並びから各階の階高を採り、それを保って積み直す（S3）。
 */
import { rulesFor, effectiveStructure } from './structural/structureRules.js';
import { toHalfWidthSignedNumber } from './halfWidth.js';
import { addSkipZero, makeFloorLevelPrefix, makeFloorName } from './floorNumber.js';

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

// ---- 階設定表ダイアログの表示モデル（S5。UI は持たない）----

/** 編集値（文字列または数値）の検査。文字列は validateStoryHeightText、数値は整数かつ下限以上。 */
function checkHeightInput(raw) {
  if (typeof raw === 'string') return validateStoryHeightText(raw);
  if (Number.isInteger(raw) && raw >= STORY_HEIGHT_MIN_MM) return { ok: true, value: raw, error: null };
  return { ok: false, value: null, error: `階高は${STORY_HEIGHT_MIN_MM}mm以上の整数(mm)にしてください。` };
}

function draftHeightEntries(heights) {
  return heights instanceof Map ? [...heights] : Object.entries(heights ?? {});
}

/**
 * 階設定表ダイアログの行モデル（純関数）。draft の契約は computeFloorHeightEdit と同じ（編集した行・GL だけ）。
 *   rows: 上＝上階の順。{ id, name, isTop, heightText（編集中は入力のまま・未編集は現在の階高）, edited, invalid, error,
 *         nFlMm（その階の FL の GL からの高さ＝elevation＋GL。不正行は直前の有効値＝未編集扱いで追従）}
 *   gl: { text, edited, invalid, error }（text＝GL の入力欄。未編集は現在の GL）
 *   eaveFromGlMm: 軒高（GL〜軒桁上端）。階が無ければ null
 *   ok: 不正な行・GL が無い（OK 可）。changed: ok かつ反映すべき変更がある
 * nFL・軒高は draft の有効な編集を即時に反映する（不正な欄は編集前の値として扱う）。
 */
export function floorSettingsRows(planes, draft, topHeightMm, currentGlBelow1FlMm = 0) {
  const initial = storyHeightsMm(planes, topHeightMm);
  const edits = new Map();     // 編集した行 id → 生の値
  const checks = new Map();    // 編集した行 id → 検査結果
  for (const [id, raw] of draftHeightEntries(draft?.heights)) {
    if (!initial.has(id)) continue;
    edits.set(id, raw);
    checks.set(id, checkHeightInput(raw));
  }
  const validHeights = {};
  for (const [id, r] of checks) if (r.ok) validHeights[id] = r.value;

  const glRaw = draft?.glBelow1FlMm;
  const glEdited = glRaw !== undefined && glRaw !== null;
  let glCheck = { ok: true, value: currentGlBelow1FlMm, error: null };
  if (glEdited) {
    glCheck = typeof glRaw === 'string'
      ? validateGlText(glRaw)
      : (Number.isInteger(glRaw) ? { ok: true, value: glRaw, error: null } : { ok: false, value: null, error: 'GLは整数(mm)で入力してください。' });
  }
  const glEffective = glEdited && glCheck.ok ? glCheck.value : currentGlBelow1FlMm;

  // 有効な編集だけで確定した場合の各階の elevation（nFL・軒高の即時表示用）
  const sanitized = computeFloorHeightEdit(planes, { heights: validHeights }, topHeightMm, currentGlBelow1FlMm);
  const elevationOf = new Map(planes.map(p => [p.id, p.elevation]));
  for (const u of sanitized.updates) elevationOf.set(u.id, u.elevation);

  const n = planes.length;
  const rows = planes.map((p, i) => {
    const edited = edits.has(p.id);
    const chk = checks.get(p.id);
    return {
      id: p.id,
      name: p.name,
      isTop: i === n - 1,
      heightText: edited ? String(edits.get(p.id)) : String(initial.get(p.id)),
      edited,
      invalid: edited && !chk.ok,
      error: edited && !chk.ok ? chk.error : null,
      nFlMm: elevationOf.get(p.id) + glEffective,
    };
  }).reverse();

  const top = planes[n - 1];
  const effectiveTop = top && validHeights[top.id] !== undefined ? validHeights[top.id] : topHeightMm;
  const eaveZ = eaveTopZMm(planes.map(p => ({ elevation: elevationOf.get(p.id), stories: p.stories })), effectiveTop);

  const invalidRows = rows.some(r => r.invalid);
  const ok = !invalidRows && glCheck.ok;
  let changed = false;
  if (ok) {
    const full = computeFloorHeightEdit(planes, draft, topHeightMm, currentGlBelow1FlMm);
    changed = full.updates.length > 0 || full.glBelow1FlMm !== null;
  }
  return {
    rows,
    gl: {
      text: glEdited ? String(glRaw) : String(currentGlBelow1FlMm),
      edited: glEdited,
      invalid: glEdited && !glCheck.ok,
      error: glEdited && !glCheck.ok ? glCheck.error : null,
    },
    eaveFromGlMm: eaveZ === null ? null : eaveZ + glEffective,
    ok,
    changed,
  };
}

/**
 * 最高の軒の高さ（GL から、mm）。屋根が複数あるときは各屋根の軒高を比べた最大値（ユーザー裁定 2026-10-20）。
 *   主屋根＝軒高（GL〜軒桁上端。view.eaveFromGlMm）。
 *   下屋＝GL＋下屋が覆う階の FL＋覆う階の階高＝GL＋**屋根セルが付く階の FL**（屋根セルが付く階は覆う階の1つ上。
 *   裁定 2026-10-20。構造の軒桁は読まない。最上階に屋根セルがあっても同じ式で最上階の FL）。
 * floorSettingsRows の結果 view を受けるので、draft の有効な編集に即時追従する（表・断面図と同じ値の流れ）。
 * 下屋が無ければ軒高と同じ。階が無ければ null。
 * @param {Array} planes - 採用階（project.planes。elevation 昇順）
 * @param {object} view - floorSettingsRows(planes, draft, topHeightMm, gl) の結果
 * @param {Iterable<string>} [leanToPlaneIds] - 屋根セル（下屋）が付く採用階の id
 */
export function maxEaveHeightMm(planes, view, leanToPlaneIds = []) {
  if (view.eaveFromGlMm === null || view.eaveFromGlMm === undefined) return null;
  const ids = new Set(leanToPlaneIds);
  const nFl = new Map(view.rows.map(r => [r.id, r.nFlMm]));
  let max = view.eaveFromGlMm;
  for (const p of planes) {
    if (!ids.has(p.id)) continue;
    const z = nFl.get(p.id);
    if (z !== undefined && z > max) max = z;
  }
  return max;
}

// ---- 階設定表ダイアログの図（断面図に入力欄の位置を載せたもの。S7・2026-10-20 図のみへ変更。図面には出ない）----

const SAME_Z_EPS = 1e-6;

/**
 * 階設定表の図のモデル（純関数）。高さは GL を 0 とした mm（上が正）。floorSettingsRows の結果 view をそのまま受ける
 * （nFlMm・eaveFromGlMm は draft の有効な編集を反映済み・不正な欄は編集前の値）ので、欄と図は常に同じ値になる。
 *
 * @param {Array} planes - 採用階（project.planes。elevation 昇順）
 * @param {object} view - floorSettingsRows(planes, draft, topHeightMm, gl) の結果
 * @returns {{lines:Array<{key,zMm,label,kind:'gl'|'fl'|'eave',planeIds:string[]}>,
 *   dims:Array<{key,kind:'story'|'gl'|'eave',fromMm,toMm,mm,text,planeId:string|null,layer:number,fromKey:string,toKey:string}>, minZ:number, maxZ:number}}
 *   lines＝水平線（zMm 昇順）。GL は常に独立した 1 本（1FL と同じ高さでも重ねない。GL 欄の入力位置が要るため。同じ高さなら GL が下）。
 *   dims＝寸法。story＝各階（複層は 1 層ずつ。layer＝層番号）の階高、gl＝GL〜1FL（同じ高さでも「0」で出す）、eave＝軒高（GL〜軒桁上端）。
 *   fromKey・toKey＝その寸法が結ぶ線の key（同じ高さの線があっても取り違えない）。
 *   複層（stories が 2 以上の整数）の中間の FL（例: 2-3階 Plane の 3FL）も 1 層ごとに線と階高寸法を持つ。
 *   小数の stories（中間階）は 1 区間として扱い、ラベルは makeFloorName（例「1ML」）。
 *   地階から地上へ 0 をまたぐ複層は対象外（層番号が重複する。floorOps.js の振り直しと同じ前提）。
 */
export function sectionDiagramModel(planes, view) {
  const nFl = new Map(view.rows.map(r => [r.id, r.nFlMm]));
  const raw = [{ rid: 'gl', zMm: 0, label: 'GL', kind: 'gl', planeId: null }];
  const dims = [];
  planes.forEach((p, i) => {
    const base = nFl.get(p.id);
    const next = planes[i + 1];
    const upper = next ? nFl.get(next.id) : view.eaveFromGlMm;
    if (base === undefined || upper === null || upper === undefined) return;
    const layers = Number.isInteger(p.stories) && p.stories >= 1 ? p.stories : 1;
    const h = (upper - base) / layers;
    for (let k = 0; k < layers; k++) {
      const z = base + k * h;
      // 中間階（小数の stories）は既存の表記（stairFloorLabel と同じ makeFloorName。例「1ML」）に揃える
      const label = Number.isInteger(p.stories)
        ? `${makeFloorLevelPrefix(addSkipZero(p.startFloor, k))}FL`
        : makeFloorName(p.startFloor, p.stories);
      const rid = `fl:${p.id}:${k}`;
      raw.push({ rid, zMm: z, label, kind: 'fl', planeId: p.id });
      const toRid = k < layers - 1 ? `fl:${p.id}:${k + 1}` : (next ? `fl:${next.id}:0` : 'eave');
      dims.push({ key: `story:${p.id}:${k}`, kind: 'story', fromMm: z, toMm: z + h, mm: h, planeId: p.id, layer: k, fromRid: rid, toRid });
    }
  });
  if (view.eaveFromGlMm !== null && view.eaveFromGlMm !== undefined) {
    raw.push({ rid: 'eave', zMm: view.eaveFromGlMm, label: '軒桁上端', kind: 'eave', planeId: null });
    dims.push({ key: 'eave', kind: 'eave', fromMm: 0, toMm: view.eaveFromGlMm, mm: view.eaveFromGlMm, planeId: null, layer: 0, fromRid: 'gl', toRid: 'eave' });
  }
  const firstFl = planes.find(p => p.startFloor === 1);
  const firstZ = firstFl ? nFl.get(firstFl.id) : undefined;
  if (firstZ !== undefined) {
    dims.push({ key: 'gl', kind: 'gl', fromMm: 0, toMm: firstZ, mm: firstZ, planeId: null, layer: 0, fromRid: 'gl', toRid: `fl:${firstFl.id}:0` });
  }

  raw.sort((a, b) => a.zMm - b.zMm); // 安定ソート: 同じ高さなら GL（先頭に積んだ）が下
  const lines = [];
  const keyOf = new Map(); // rid -> 線の key
  for (const r of raw) {
    const last = lines[lines.length - 1];
    if (last && last.kind !== 'gl' && r.kind !== 'gl' && Math.abs(last.zMm - r.zMm) <= SAME_Z_EPS) {
      last.label = `${last.label}=${r.label}`;
      if (r.kind === 'eave') last.kind = 'eave';
      if (r.planeId) last.planeIds.push(r.planeId);
      keyOf.set(r.rid, last.key);
    } else {
      const key = `line${lines.length}`;
      lines.push({ key, zMm: r.zMm, label: r.label, kind: r.kind, planeIds: r.planeId ? [r.planeId] : [] });
      keyOf.set(r.rid, key);
    }
  }
  for (const d of dims) {
    d.text = String(Math.round(Math.abs(d.mm)));
    d.fromKey = keyOf.get(d.fromRid);
    d.toKey = keyOf.get(d.toRid);
    delete d.fromRid;
    delete d.toRid;
  }
  return { lines, dims, minZ: lines[0].zMm, maxZ: lines[lines.length - 1].zMm };
}

/** 数値入力欄1つの大きさ（px）。階高欄・GL 欄とも同じ（ダイアログの cl-dialog-input に合わせた高さ）。 */
export const FIGURE_INPUT_W = 70;
export const FIGURE_INPUT_H = 22;
/** ▽ マーカーの大きさ（px）。先端（下の頂点）がレベル線に乗る。 */
export const FIGURE_MARKER_W = 8;
export const FIGURE_MARKER_H = 7;

/**
 * 階設定表の図（断面図に入力欄の位置を載せたもの）を px 座標へ変換する（純関数）。y 下向き正なので上階が上。
 * 縦は 1px = 1/pxPerMm mm の比例だが、隣り合う線の間は最小 minGapPx を保つ（入力欄が入る高さ。階高が小さくても潰れない）。
 * SVG は 1:1 で描き（viewBox で縮めない）、入力欄は返り値の input 枠へ絶対配置で重ねる。
 *
 * 右の寸法鎖＝階高・GL〜1FL（入力欄つき。複層の2層目以降は表示のみ）、左の寸法＝最高軒高（自動。GL〜軒桁上端の区間に
 * opts.maxEaveMm の値を書く。値は maxEaveHeightMm の結果をそのまま渡す＝同じ情報を2か所で計算しない）。
 *
 * @param {object} model - sectionDiagramModel の結果
 * @param {{maxEaveMm?:number|null, pxPerMm?:number, minGapPx?:number}} [opts]
 */
export function layoutFloorSettingsFigure(model, opts = {}) {
  const {
    maxEaveMm = null, pxPerMm = 0.04, minGapPx = 36, padTop = 26, padBottom = 14,
    leftDimX = 62, longX1 = 10, flX1 = 76, lineX2 = 224, rightDimX = 200, inputX = 210, markerX = 150, glMarkerX = 34,
  } = opts;
  const lines = model.lines;
  const gaps = lines.slice(1).map((l, i) => Math.max(minGapPx, (l.zMm - lines[i].zMm) * pxPerMm));
  const height = padTop + gaps.reduce((a, b) => a + b, 0) + padBottom;
  const ys = new Array(lines.length);
  ys[0] = height - padBottom;
  for (let i = 1; i < lines.length; i++) ys[i] = ys[i - 1] - gaps[i - 1];
  const yOfKey = new Map(lines.map((l, i) => [l.key, ys[i]]));

  const outLines = lines.map((l, i) => {
    const y = ys[i];
    const long = l.kind === 'gl' || l.kind === 'eave';
    const mx = l.kind === 'gl' ? glMarkerX : markerX;
    return {
      ...l,
      y,
      long,
      x1: long ? longX1 : flX1,
      // 線は右の寸法線をまたいで lineX2 まで（図面の寸法補助線のように寸法線より少し先へ出る）
      x2: lineX2,
      // ▽: 先端（下の頂点）が線の上に乗る。ラベルは▽の左・線のすぐ上。GL の▽は最高軒高の寸法線より左（glMarkerX）
      marker: { points: [[mx - FIGURE_MARKER_W / 2, y - FIGURE_MARKER_H], [mx + FIGURE_MARKER_W / 2, y - FIGURE_MARKER_H], [mx, y]] },
      labelX: mx - FIGURE_MARKER_W / 2 - 3,
      labelY: y - 2,
    };
  });

  const rightDims = [];
  let leftDim = null;
  for (const d of model.dims) {
    const y1 = yOfKey.get(d.fromKey);
    const y2 = yOfKey.get(d.toKey);
    if (y1 === undefined || y2 === undefined) continue;
    const yMid = (y1 + y2) / 2;
    if (d.kind === 'eave') {
      // 「最高軒高」の文字は GL▽（左の寸法線より左）と重ならないよう、値の行を GL 線の ▽・ラベルより上に保つ（小さい建物の対策）
      const valueY = Math.min(yMid + 12, Math.max(y1, y2) - 12);
      leftDim = {
        key: d.key, x: leftDimX, y1, y2, yMid,
        textX: leftDimX - 6,
        valueY,
        labelY: valueY - 14,
        text: maxEaveMm === null || maxEaveMm === undefined ? '-' : String(Math.round(maxEaveMm * 10) / 10),
      };
      continue;
    }
    // 階高・GL の入力欄。複層の2層目以降は同じ階の欄を重ねないので表示のみ
    const target = d.kind === 'gl' ? { kind: 'gl' } : d.layer === 0 ? { kind: 'height', id: d.planeId } : null;
    rightDims.push({
      ...d, x: rightDimX, y1, y2, yMid,
      textX: inputX + FIGURE_INPUT_W / 2,
      input: target ? { ...target, x: inputX, y: yMid - FIGURE_INPUT_H / 2, w: FIGURE_INPUT_W, h: FIGURE_INPUT_H } : null,
    });
  }
  // 1FL が無い（地階だけの）建物: GL〜1FL の寸法が無いので、GL 線の右（階高欄の列のさらに右）に GL の欄だけ置く
  let width = Math.max(lineX2, inputX + FIGURE_INPUT_W) + 10;
  const glLine = outLines.find(l => l.kind === 'gl');
  if (glLine && outLines.some(l => l.kind === 'fl') && !rightDims.some(d => d.kind === 'gl')) {
    const x = inputX + FIGURE_INPUT_W + 8;
    rightDims.push({
      key: 'gl', kind: 'gl', planeId: null, layer: 0, solo: true, text: '', x: rightDimX, y1: glLine.y, y2: glLine.y, yMid: glLine.y, textX: x,
      input: { kind: 'gl', x, y: glLine.y - FIGURE_INPUT_H / 2, w: FIGURE_INPUT_W, h: FIGURE_INPUT_H },
    });
    width = x + FIGURE_INPUT_W + 10;
  }
  // DOM 順＝Tab 順を見た目の上から下にそろえる（上階→下階→GL。GL は常に最下）
  rightDims.sort((a, b) => (a.kind === 'gl') - (b.kind === 'gl') || a.yMid - b.yMid);
  return { width, height, lines: outLines, rightDims, leftDim };
}
