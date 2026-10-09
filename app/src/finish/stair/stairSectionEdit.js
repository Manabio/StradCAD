// 階段パネル（StairPanel.jsx）の図中編集・タイプ切替が sections（区間別・実段数）へ書く値の決定を
// 純関数に切り出したもの（レンダラの判断を node:test で固定するため）。
//
// UI は踏面数（マス数）でたずねる（.claude/stair-model.md）: 直進部は 実段数 = 踏面数 + 1。
// 折返し・回り階段の回転部だけは「回転部の段数 R」＝取りつきの往路・復路各1段を除いた回転部固有の
// 蹴上数でたずね、sections[1] = R + 1（マス数 w。平踊り場 w=1 ⇔ R=0）と換算する。
// R は同時にタイプを導出する: R=0 → SWITCHBACK（平踊り場）、R>0 → WINDING（回り段）。
// 回転部がユーザーの分割セル（2×2 等）か全幅の踊り場セルかによらず R だけで型が決まる
// （既存データの保存値は再分類しない。この換算は編集時にだけ働く）。
import { StairType, StairPortSide, StructuralMaterialType } from '@core';
import { defaultSections } from './stairGeometry.js';
import { defaultPortTurnSteps, measureStairSpans } from './stairClassify.js';
import { MIN_RUN_RISERS, portRunIndex, portSectionCount, hasPortSides, resolvePorts, stepsFieldOf } from './stairPorts.js';

const U_TURN = new Set([StairType.SWITCHBACK, StairType.WINDING]);

/** sections[index] が「回転部の段数 R」としてたずねる区間か（折返し・回り階段の奇数index=1）。 */
export function isTurnStepsDim(type, index) {
  return U_TURN.has(type) && index === 1;
}

/**
 * 図中編集の入力値（踏面数、回転部は段数 R）から新しい sections と、それに応じたタイプを返す。
 * @param {{type:string, sections:number[]|null, totalSteps:number}} stair
 * @param {number} index - sections のインデックス
 * @param {number} value - 入力値（踏面数。回転部は R）
 * @returns {{ sections:number[], type:string }}
 */
export function applySectionDimEdit(stair, index, value) {
  const arr = [...(stair.sections ?? defaultSections(stair))];
  const turnSteps = isTurnStepsDim(stair.type, index);
  arr[index] = Math.max(1, (index % 2 === 0 || turnSteps) ? value + 1 : value);
  const type = turnSteps ? (arr[1] === 1 ? StairType.SWITCHBACK : StairType.WINDING) : stair.type;
  return { sections: arr, type };
}

/**
 * タイプ切替後の sections。区間数が合わなければ既定値で組み直し、折返し⇄回りの切替では
 * 回転部を型に揃える（SWITCHBACK→R=0、WINDING で R=0 のままなら既定の回り段数）。
 * @returns {number[]|null} 変更不要でも配列を返す（呼び出し側で比較）。既定値の無いタイプは null
 */
export function sectionsForType(type, stair) {
  const expected = defaultSections({ type, totalSteps: stair.totalSteps });
  if (!expected) return null;
  const arr = stair.sections && stair.sections.length === expected.length ? [...stair.sections] : [...expected];
  if (U_TURN.has(type)) {
    if (type === StairType.SWITCHBACK) arr[1] = 1;
    else if (arr[1] === 1) arr[1] = expected[1];
  }
  return arr;
}


/**
 * 出入口の辺（上り口 'entry'／到達口 'arrival'）を切り替えたときに Stair へ書くフィールド。
 * 総蹴上数（totalSteps）は変えない: 取りつき回転部の蹴上を足すぶん、その口のレーンの直進部（sections の
 * 往路 0／復路 2。矩折はアーム1 0／アーム2 2）を同じ数だけ減らす（直進部は 2 段以上。守れなければ null＝その側面は選べない）。
 * 走行端へ戻すと取りつき 0 にして、その蹴上を直進部へ戻す。側面へ切り替えるとき蹴上数が 0 なら
 * 初期値（鉄骨 0・木造 区画の長さ÷踏面。defaultPortTurnSteps）を入れる。蹴上数が既にあれば辺だけ替える。
 * @param {number} zoneMm - 区画（張り出し区間／等長レーンの基端の行）の長さ（stairPorts.js portZone の zoneLen）
 * @returns {Record<string, string|number|number[]>|null} setField で書くフィールド→値（sections を含みうる）。
 *   直進部が 2 段未満になる・sections が組めないときは null
 */
export function portSideChange(stair, port, side, zoneMm) {
  // 出入口を選べない型（曲がり階段・中空きほか）は切替不可（type 未指定の素のオブジェクトは U字・直進系として扱う）
  if (stair.type != null && !hasPortSides(stair.type)) return null;
  const sideField = port === 'entry' ? 'entrySide' : 'arrivalSide';
  const stepsField = stepsFieldOf(port);
  const idx = portRunIndex(stair.type, port);
  const count = portSectionCount(stair.type);
  const cur = Math.max(0, stair[stepsField] ?? 0);
  const out = { [sideField]: side };
  if (side === StairPortSide.END) {
    out[stepsField] = 0;
    if (cur > 0) {
      const sections = [...(stair.sections ?? defaultSections(stair) ?? [])];
      if (sections.length !== count) return null;
      sections[idx] += cur;
      out.sections = sections;
    }
    return out;
  }
  if (cur > 0) return out;
  const want = defaultPortTurnSteps(stair.structure, zoneMm, stair.tread);
  out[stepsField] = want;
  if (want > 0) {
    const sections = [...(stair.sections ?? defaultSections(stair) ?? [])];
    if (sections.length !== count || sections[idx] - want < MIN_RUN_RISERS) return null;
    sections[idx] -= want;
    out.sections = sections;
  }
  return out;
}

// 取りつき回転部の蹴上（entry/arrival の指定ぶん）を 0 にして直進部へ戻す書込み（総蹴上数を保つ）。
function foldTurnSteps(stair, ports) {
  const out = {};
  let sections = null;
  for (const port of ports) {
    const field = stepsFieldOf(port);
    const cur = Math.max(0, stair[field] ?? 0);
    if (cur === 0) continue;
    out[field] = 0;
    sections ??= [...(stair.sections ?? defaultSections(stair) ?? [])];
    if (sections.length === portSectionCount(stair.type)) sections[portRunIndex(stair.type, port)] += cur;
  }
  if (sections?.length === portSectionCount(stair.type)) out.sections = sections;
  return out;
}

/**
 * 昇り方向・反転を変えたときに出入口を自動へ戻す書込み（辺の向きが物理的に入れ替わるため）:
 * entrySide/arrivalSide を null、取りつき蹴上を 0（その蹴上は直進部へ戻して総蹴上数を保つ）。
 * 出入口の辺を選べない型（曲がり階段・中空きほか）は {}。
 */
export function resetPortSides(stair) {
  if (!hasPortSides(stair.type)) return {};
  return { entrySide: null, arrivalSide: null, ...foldTurnSteps(stair, ['entry', 'arrival']) };
}

/**
 * 解決した出入口（resolveStairPorts の結果）に取りつき蹴上をそろえる書込み。
 * - 走行端なのに取りつき蹴上が残っている → 0 にする（描画は走行端の取りつきを無視するため、残すと総蹴上数と
 *   図の段数字がずれる。蹴上は直進部へ戻す）。
 * - 鉄骨以外（木造・RC・未設定）の側面の口で蹴上が 0（平場）→ 1 にする（defaultPortTurnSteps の初期値と同じ規則。
 *   木造の隔て板の柱が段板を支える区画はその一例。ユーザー裁定 2026-10-09）。その口のレーンの直進部から 1 段引いて総蹴上数を保つ。直進部が
 *   MIN_RUN_RISERS 未満になるときは sections をそのままにして蹴上だけ 1 にする（総蹴上数は +1）。
 *   鉄骨の平場 0（踏み込み踊り場）はそのまま。
 * @param {{ entry:string, arrival:string }} resolved
 */
export function alignPortTurnSteps(stair, resolved) {
  if (!hasPortSides(stair.type)) return {};
  const ports = ['entry', 'arrival'];
  const out = foldTurnSteps(stair, ports.filter(p => resolved[p] === StairPortSide.END));
  if (stair.structure === StructuralMaterialType.STEEL) return out;
  const count = portSectionCount(stair.type);
  let sections = out.sections ? [...out.sections] : null;
  for (const port of ports) {
    const side = resolved[port];
    const field = stepsFieldOf(port);
    if (!side || side === StairPortSide.END || Math.max(0, stair[field] ?? 0) > 0) continue;
    out[field] = 1;
    sections ??= [...(stair.sections ?? defaultSections(stair) ?? [])];
    if (sections.length !== count) continue;
    const idx = portRunIndex(stair.type, port);
    if (sections[idx] - 1 >= MIN_RUN_RISERS) sections[idx] -= 1;
    out.sections = sections;
  }
  return out;
}

/**
 * 図中寸法から取りつき蹴上（entryTurnSteps/arrivalTurnSteps）を直接編集するときの入力値の下限。
 * 鉄骨以外は側面の取りつきに平場（0）を置かない。0 を書いてから alignPortTurnSteps で 1 へ戻すと、そのたびに
 * 直進部から 1 段ずつ削られるため、書込みの手前で 1 に止める。鉄骨・他のフィールドは値そのまま。
 */
export function clampPortTurnStepsEdit(stair, field, value) {
  if (field !== 'entryTurnSteps' && field !== 'arrivalTurnSteps') return value;
  if (stair.structure === StructuralMaterialType.STEEL) return value;
  return Math.max(1, value);
}

/**
 * 読込み・壁再生成の境界（wallRefresh.js refreshWallsForGraph）で、graph の出入口を選べる型の全階段に
 * alignPortTurnSteps を適用する（保存済みデータの、鉄骨以外の側面の平場 0 を 1 へ・走行端に残った蹴上を 0 へ
 * そろえる）。冪等。undo には積まない。出入口の辺が自動（null）でも区画の張り出しで側面に解決されうるので、
 * 保存値の辺では絞らず全件を実測する（1 階段 1.5ms 以下）。
 * @returns {boolean} 1 つでも書き換えたか
 */
export function alignPortStairsOnGraph(graph) {
  let changed = false;
  for (const stair of graph.stairs) {
    if (!hasPortSides(stair.type)) continue;
    const resolved = resolvePorts(stair, measureStairSpans(stair, graph));
    if (!resolved) continue;
    const fields = alignPortTurnSteps(stair, resolved);
    for (const [k, v] of Object.entries(fields)) stair.setField(k, v);
    if (Object.keys(fields).length > 0) changed = true;
  }
  return changed;
}

export const sameSections = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
