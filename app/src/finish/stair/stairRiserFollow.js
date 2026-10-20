/**
 * 階高の変更に追従する階段の蹴上（階設定表の確定。純モジュール。react・store.js・snap.js・.jsx・IO を静的に引かない）。
 *
 * 階段は設置階のグラフに属し、その階から1つ上の採用階へ上がる。蹴上は floorHeightAbove（上階 elevation − 自階 elevation。
 * 複層の Plane は全高）と総段数で決まる（stairDimensions.js riserOf）。階高を変えると floorHeightAbove が変わる階
 * （自階の階高の変更に限らず、複層や地階の変更でずれる場合も含む）の階段が対象で、確定前後の floorHeightAbove を比べて決める。
 *
 * 書き換え（ユーザー裁定 2026-10-20）: 明示の stair.riser を持つ階段も、総段数を保ったまま
 * 新しい蹴上＝新しい floorHeightAbove ÷ max(1, 総段数) に書き換える（展開図に不整合を出さないため）。
 * 明示の無い階段は riserOf が自動で追従するので書かない。蹴上の値が変わる階段は全部、確認・トースト・印の対象。
 */
import { riserOf } from './stairDimensions.js';

/** 蹴上の変化とみなさない差(mm)。 */
const RISER_EPS = 1e-9;

/** 階段の識別キー（階 id と階段 id。階段 id は階をまたいで一意とは限らないため階 id と組にする）。 */
export function stairRiserKey(planeId, stairId) {
  return `${planeId}:${stairId}`;
}

/**
 * グラフの階段を確認用の要約にする。{ planeId, stairId, totalSteps, explicitRiser(明示 riser。無ければ null) }。
 * 表示名は呼び出し側（連鎖の番号が要る）が label として足す。
 */
export function stairItemsOfGraph(planeId, graph) {
  return (graph?.stairs ?? []).map(s => ({
    planeId, stairId: s.id, totalSteps: s.totalSteps, explicitRiser: s.riser ?? null,
  }));
}

/** 採用階の並び（elevation 昇順）に updates（computeFloorHeightEdit の updates）を重ねた [{id, elevation}]。 */
export function planesAfterUpdates(planes, updates) {
  const moved = new Map((updates ?? []).map(u => [u.id, u.elevation]));
  return planes.map(p => ({ id: p.id, elevation: moved.has(p.id) ? moved.get(p.id) : p.elevation }));
}

/** [{id, elevation}]（elevation 昇順）での floorHeightAbove。上階が無い・id が無いときは null。 */
export function floorHeightAboveIn(list, planeId) {
  const idx = list.findIndex(p => p.id === planeId);
  if (idx < 0 || idx + 1 >= list.length) return null;
  return list[idx + 1].elevation - list[idx].elevation;
}

/**
 * 蹴上が変わる階段の一覧。before／after は [{id, elevation}]（採用階。elevation 昇順）。
 * 蹴上（前）＝明示 riser 優先の riserOf(前の階高)、蹴上（後）＝ after の階高 ÷ max(1, 総段数)
 * （明示があっても総段数を保って書き換えるので、後の値は階高だけで決まる）。
 * 階高が前後とも求まり、かつ階高が変わり、かつ蹴上の値が変わるものだけを返す（最上階の階段・階高不変・値が同じは出ない）。
 * @param {Array<{planeId:string, stairId:string, totalSteps:number, explicitRiser:number|null, label?:string}>} items
 * @returns {Array<{planeId, stairId, key, label, totalSteps, explicit:boolean, from:number, to:number}>}
 */
export function stairRiserChanges(items, before, after) {
  const out = [];
  for (const it of items ?? []) {
    const fhBefore = floorHeightAboveIn(before, it.planeId);
    const fhAfter = floorHeightAboveIn(after, it.planeId);
    if (fhBefore == null || fhAfter == null || fhBefore === fhAfter) continue;
    const from = riserOf({ riser: it.explicitRiser, totalSteps: it.totalSteps }, fhBefore);
    const to = fhAfter / Math.max(1, it.totalSteps);
    if (!(Math.abs(from - to) > RISER_EPS)) continue;
    out.push({
      planeId: it.planeId, stairId: it.stairId, key: stairRiserKey(it.planeId, it.stairId),
      label: it.label ?? '階段', totalSteps: it.totalSteps, explicit: it.explicitRiser != null, from, to,
    });
  }
  return out;
}

/** 階設定表の edit.updates から見た蹴上の変化（ダイアログの確認用。階の並びは不変なので before は planes そのまま）。 */
export function stairRiserChangesForEdit(items, planes, updates) {
  if (!items || items.length === 0 || !updates || updates.length === 0) return [];
  return stairRiserChanges(items, planes.map(p => ({ id: p.id, elevation: p.elevation })), planesAfterUpdates(planes, updates));
}

/** 蹴上(mm)の前後の表記。既存の表示（Math.round）に合わせ、丸めると同じ数字になるときだけ小数1桁。 */
export function formatRiserPair(from, to) {
  const a = Math.round(from);
  const b = Math.round(to);
  if (a !== b) return [String(a), String(b)];
  return [String(Math.round(from * 10) / 10), String(Math.round(to * 10) / 10)];
}

/** 「階段1（1->2階）: 蹴上 200→210」。 */
export function riserChangeLine(change) {
  const [a, b] = formatRiserPair(change.from, change.to);
  return `${change.label}: 蹴上 ${a}→${b}`;
}

/**
 * 確定が成功した後に、蹴上の変更を印（Project.riserAutoUpdated）とトーストで知らせる。
 * 追従の途中（wallRefresh より前）で出すと、後段の失敗で巻き戻ってもトーストと印が残るため、
 * 呼び出し側（App.jsx runFloorHeights）が withFloorOpUndo の await の後に1回だけ呼ぶ。変更が無ければ何もしない。
 * @param {{markRiserAutoUpdated:(entries:Array)=>void}} project
 * @param {Array<{key:string,to:number}>} changes - applyFloorOrderChange の riserChanges
 * @param {(msg:string)=>void} notify
 */
export function announceRiserChanges(project, changes, notify) {
  if (!changes || changes.length === 0) return;
  project.markRiserAutoUpdated(changes.map(c => [c.key, c.to]));
  notify(riserChangeToastMessage(changes));
}

/** 確定後のトースト文言。「階段1（1->2階）の蹴上を 200→210 に変更しました」を全件「／」でつなぐ。 */
export function riserChangeToastMessage(changes) {
  return changes.map(c => {
    const [a, b] = formatRiserPair(c.from, c.to);
    return `${c.label}の蹴上を ${a}→${b} に変更しました`;
  }).join('／');
}
