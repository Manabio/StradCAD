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
 * 走行端へ戻すと取りつき回転部は無くなる（蹴上数 0）。側面へ切り替えるとき蹴上数が 0 なら
 * 初期値（鉄骨 0・木造 張り出し÷踏面。defaultPortTurnSteps）を入れる。
 * @returns {Record<string, string|number>} setField で書くフィールド→値
 */
export function portSideChange(stair, port, side, overhangMm) {
  const sideField  = port === 'entry' ? 'entrySide' : 'arrivalSide';
  const stepsField = port === 'entry' ? 'entryTurnSteps' : 'arrivalTurnSteps';
  const out = { [sideField]: side };
  if (side === StairPortSide.END) out[stepsField] = 0;
  else if (!(stair[stepsField] > 0)) out[stepsField] = defaultPortTurnSteps(stair.structure, overhangMm, stair.tread);
  return out;
}

export const sameSections = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
