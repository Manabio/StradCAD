// 線（中心線・通り芯）の id をプロジェクト全体で一意に保つための検査。
//
// 不変条件: 線の id は、通り芯を含めてプロジェクト全体で一意。この不変条件を検査する読み取り専用の
// 関数群——平面を複製・移籍するときや、既存データに同じidが残っていないかを確かめるときに使う。
//
// node:test から単体で import できる純モジュール（store.js・snap.js・.jsx を静的に引かない）。

import { CenterLine, isGridCenterLine } from '@core';

/**
 * 平面ごとの線id一覧から、複数の平面（同一平面内の重複を含む）に現れるidを集めて返す（純関数）。
 * @param {{planeId: string|null, planeName: string, ids: Iterable<string>}[]} entries
 *   通り芯（共有グラフ）は {planeId: null, planeName: '通り芯'} の1エントリとして渡す。
 * @returns {{id: string, planes: {planeId: string|null, planeName: string}[]}[]}
 *   重複なしなら []。同一エントリ内の重複も1件として報告し、planes に同じ平面を2回入れる。
 */
export function findDuplicateLineIds(entries) {
  const occurrences = new Map(); // id -> {planeId, planeName}[]
  for (const entry of entries) {
    const { planeId, planeName, ids } = entry;
    if (ids == null || typeof ids[Symbol.iterator] !== 'function') {
      throw new Error(`findDuplicateLineIds: entries[].ids は Iterable である必要があります（planeId=${planeId}）`);
    }
    for (const id of ids) {
      if (!occurrences.has(id)) occurrences.set(id, []);
      occurrences.get(id).push({ planeId, planeName });
    }
  }
  const duplicates = [];
  for (const [id, planes] of occurrences) {
    if (planes.length >= 2) duplicates.push({ id, planes });
  }
  return duplicates;
}

/**
 * snapshot（保存形式の中間オブジェクト。graphSnapshot.js buildSnapshot の出力と同形）に含まれる
 * 線の id 一覧を返す。
 * @param {{centerLines: {id:string}[]}} snapshot
 * @returns {string[]}
 */
export function lineIdsOfSnapshot(snapshot) {
  return snapshot.centerLines.map(c => c.id);
}

/**
 * PlanGraph の「自グラフ固有」の中心線id一覧を返す（通り芯＝GRID種別のCLを除く）。
 *
 * graph.centerLines（core/planGraph.js のゲッター）は _structGraph（project.structGraph）の
 * CenterLineを自グラフのものへ合流して返すため、アクティブ階・peekした各階について
 * そのまま使うと、共有される通り芯のidが「階の数＋通り芯エントリの1」だけ重複して現れ、
 * 本来一意でよい通り芯を毎回「複数平面にまたがる重複」として誤検出する。
 * そのため graphSnapshot.js buildSnapshot の floorCLs と同じ絞り込み（自グラフの shapeMap から
 * GRID種別を除く）に揃える。
 * @param {import('./core/planGraph.js').PlanGraph} graph
 * @returns {string[]}
 */
function floorOwnCenterLineIds(graph) {
  return [...graph.shapeMap.values()]
    .filter(s => s instanceof CenterLine && !isGridCenterLine(s))
    .map(s => s.id);
}

/**
 * プロジェクト全体（採用階・検討案・屋根専用平面を含む全平面＋共有グラフ）を走査し、
 * 複数の平面にまたがる線idを返す（読み取り専用）。
 * @param {import('./core/project.js').Project} project
 * @param {{activeGraph: import('./core/planGraph.js').PlanGraph, peek: (plane) => Promise<import('./core/planGraph.js').PlanGraph>}} deps
 *   peek は注入（本番では `(plane) => floorSwapManager.peek(plane, project.structGraph)`）。
 *   peek が reject したら、この関数も同じ理由で reject する（握らずそのまま伝える）。
 * @returns {Promise<{id: string, planes: {planeId: string|null, planeName: string}[]}[]>}
 */
export async function scanProjectLineIds(project, { activeGraph, peek }) {
  const entries = [];
  for (const plane of project.planeMap.values()) {
    const isActive = plane.id === project.activePlaneId;
    const graph = isActive ? activeGraph : await peek(plane);
    entries.push({ planeId: plane.id, planeName: plane.name, ids: floorOwnCenterLineIds(graph) });
  }
  // 共有グラフ（通り芯）は1エントリとしてまとめる。structGraph は _structGraph を持たないため
  // .centerLines は自身の shapeMap のみを返す（_mergeWithStructGraph が own のみに短絡）。
  entries.push({
    planeId: null, planeName: '通り芯',
    ids: project.structGraph.centerLines.map(cl => cl.id),
  });
  return findDuplicateLineIds(entries);
}
