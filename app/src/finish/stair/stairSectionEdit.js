// 階段パネル（StairPanel.jsx）の図中編集・タイプ切替が sections（区間別・実段数）へ書く値の決定を
// 純関数に切り出したもの（レンダラの判断を node:test で固定するため）。
//
// UI は踏面数（マス数）でたずねる（.claude/stair-model.md）: 直進部は 実段数 = 踏面数 + 1。
// 折返し・回り階段の回転部だけは「回転部の段数 R」＝取りつきの往路・復路各1段を除いた回転部固有の
// 蹴上数でたずね、sections[1] = R + 1（マス数 w。平踊り場 w=1 ⇔ R=0）と換算する。
// R は同時にタイプを導出する: R=0 → SWITCHBACK（平踊り場）、R>0 → WINDING（回り段）。
// 回転部がユーザーの分割セル（2×2 等）か全幅の踊り場セルかによらず R だけで型が決まる
// （既存データの保存値は再分類しない。この換算は編集時にだけ働く）。
import { StairType, StairPortSide } from '@core';
import { defaultSections } from './stairGeometry.js';
import { defaultPortTurnSteps } from './stairClassify.js';
import { MIN_RUN_RISERS, PORT_RUN_INDEX, stepsFieldOf } from './stairPorts.js';

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
 * 往路 0／復路 2）を同じ数だけ減らす（直進部は 2 段以上。守れなければ null＝その側面は選べない）。
 * 走行端へ戻すと取りつき 0 にして、その蹴上を直進部へ戻す。側面へ切り替えるとき蹴上数が 0 なら
 * 初期値（鉄骨 0・木造 区画の長さ÷踏面。defaultPortTurnSteps）を入れる。蹴上数が既にあれば辺だけ替える。
 * @param {number} zoneMm - 区画（張り出し区間／等長レーンの基端の行）の長さ（stairPorts.js portZone の zoneLen）
 * @returns {Record<string, string|number|number[]>|null} setField で書くフィールド→値（sections を含みうる）。
 *   直進部が 2 段未満になる・sections が組めないときは null
 */
export function portSideChange(stair, port, side, zoneMm) {
  const sideField = port === 'entry' ? 'entrySide' : 'arrivalSide';
  const stepsField = stepsFieldOf(port);
  const idx = PORT_RUN_INDEX[port];
  const cur = Math.max(0, stair[stepsField] ?? 0);
  const out = { [sideField]: side };
  if (side === StairPortSide.END) {
    out[stepsField] = 0;
    if (cur > 0) {
      const sections = [...(stair.sections ?? defaultSections(stair) ?? [])];
      if (sections.length !== 3) return null;
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
    if (sections.length !== 3 || sections[idx] - want < MIN_RUN_RISERS) return null;
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
    if (sections.length === 3) sections[PORT_RUN_INDEX[port]] += cur;
  }
  if (sections?.length === 3) out.sections = sections;
  return out;
}

/**
 * 昇り方向・反転を変えたときに出入口を自動へ戻す書込み（辺の向きが物理的に入れ替わるため）:
 * entrySide/arrivalSide を null、取りつき蹴上を 0（その蹴上は直進部へ戻して総蹴上数を保つ）。U字以外は {}。
 */
export function resetPortSides(stair) {
  if (!U_TURN.has(stair.type)) return {};
  return { entrySide: null, arrivalSide: null, ...foldTurnSteps(stair, ['entry', 'arrival']) };
}

/**
 * 解決した出入口（resolveStairPorts の結果）が走行端なのに取りつき蹴上が残っている状態を 0 にそろえる書込み
 * （描画は走行端の取りつきを無視するため、残すと総蹴上数と図の段数字がずれる。蹴上は直進部へ戻す）。
 * @param {{ entry:string, arrival:string }} resolved
 */
export function alignPortTurnSteps(stair, resolved) {
  if (!U_TURN.has(stair.type)) return {};
  return foldTurnSteps(stair, [
    ...(resolved.entry === StairPortSide.END ? ['entry'] : []),
    ...(resolved.arrival === StairPortSide.END ? ['arrival'] : []),
  ]);
}

export const sameSections = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
