// ================================================================
// 腰壁・垂れ壁の記録（graph.kneeDropWalls の値の detailRefs の kneeTop・dropBottom）の解決と fit・失敗の集計（部分詳細図 S8b-1）。
// finish/roomDetailJunction.js（部屋の取り合い。S8a）と同型。
//   resolveKneeDropDetailFigure  記録の slot の割当て → 図のキーとカタログのエントリ。参照切れは entry=null
//   fitKneeDropPart              図のキー×slot×壁厚の fit（openings/openingCatalog.js fitDetailLocalMemo のメモを共有）
//   kneeDropPartEnvelope         fit → 見る側の向きに合わせた包絡線（表の側と反対から見るときは壁の中心で鏡像）
//   collectKneeDropPartFailures  未解決キー・fit 失敗の集計（仕上げ init・展開 init の通知）
// 床の段差（Room.detailRefs の floorStep。S8b-3）: resolveRoomPartFigure／fitFloorStepPart／floorStepEnvelope／collectFloorStepFailures。
// 天井の段差（CeilingZone／Room.detailRefs の ceilingStep。S8b-4a）: resolveCeilingStepFigure／fitCeilingStepPart／ceilingStepEnvelope／collectCeilingStepFailures。
// 天伏用（8b-4c）: ceilingStepUnderside（断面を下から見た包絡線）。
// 失敗は例外にしない（{error}・null・集計の行）。
// ================================================================

import { KNEE_DROP_DETAIL_SLOTS, DetailSlot, DetailFigureSource, DETAIL_BUILTIN_KNEE_CAP_KEY } from '../core/constants.js';
import { kneeDropFrontSideOf } from '../core/kneeDropRecord.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND, detailOwnerKneeDrop, detailOwnerRoom, detailOwnerCeilingZone } from '../error.js';
import { detailFigureEntry, detailFitKey, fitDetailLocalMemo } from '../openings/openingCatalog.js';
import { computeEnvelope, computeUnderside } from '../detail/detailPlacement.js';
import { partTargets, floorStepTargets, ceilingStepTargets } from './roomDetailTargets.js';
import { wallAssemblyThicknessMm } from './roomDetailJunction.js';
import { kneeDropWallGeometry } from './kneeDropWall.js';
import { buildCellToRoom } from './edgeClassify.js';

const refOf = (rec, slot) => {
  const refs = rec?.detailRefs;
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) return undefined;
  const key = refs[slot];
  return typeof key === 'string' && key !== '' ? key : undefined;
};

/**
 * 記録の slot の割当てを図のエントリへ解決する。
 * 暗黙の既定（S8c）: kneeTop は割当てが無くても腰壁（rec.knee）があれば組込みの天板（source=default）。dropBottom に既定は無い。
 * 利用者の割当てがあれば source=explicit（参照切れの通知はこちらだけ）。
 * @param {{rec:object, slot:string, entryOf?:(key:string)=>object|null}} p entryOf＝図のキー→エントリ（既定はカタログ）
 * @returns {null | {key:string, slot:string, entry:object|null, source:string}} null＝割当て無し（既定も無い）。entry が null＝参照切れ（カタログに無い）。source＝DetailFigureSource
 */
export function resolveKneeDropDetailFigure({ rec, slot, entryOf = detailFigureEntry }) {
  const key = refOf(rec, slot);
  if (key !== undefined) return { key, slot, entry: entryOf(key) ?? null, source: DetailFigureSource.EXPLICIT };
  if (slot === DetailSlot.KNEE_TOP && rec?.knee) {
    return { key: DETAIL_BUILTIN_KNEE_CAP_KEY, slot, entry: entryOf(DETAIL_BUILTIN_KNEE_CAP_KEY) ?? null, source: DetailFigureSource.DEFAULT };
  }
  return null;
}

/**
 * 図を（壁厚）に合わせた局所座標のストローク列（fitLocal の結果）。失敗は {error:{code,message}}（例外にしない）。
 * メモは openings/ の fitDetailLocalMemo と共有（鍵は図のキー・slot・壁厚）。材未解決の結果はメモしない。
 * @param {{figureKey:string, slot:string, wallThicknessMm:number, materialMap?:object|null}} p
 */
export function fitKneeDropPart({ figureKey, slot, wallThicknessMm, materialMap = null }) {
  return fitDetailLocalMemo({
    figureKey, slot, dims: { wallThickness: wallThicknessMm },
    targetsOf: (entry, dims) => partTargets(entry, { slot, wallThicknessMm: dims.wallThickness, materialMap }),
  });
}

/** 図の局所座標（s＝表の側の仕上げ面から表の側が正）を、反対側の仕上げ面から反対側が正の座標へ映す（壁の中心での鏡像）。 */
export function mirrorStrokesAcrossWall(strokes, wallThicknessMm) {
  return strokes.map(stroke => ({ ...stroke, points: stroke.points.map(p => ({ s: -wallThicknessMm - p.s, t: p.t })) }));
}

/**
 * 記録の slot の図を、壁 wall（壁厚＝同軸・スパン重なりの壁の組）で fit し、見る側（viewedSide）から見た包絡線にする。
 * 参照切れ・壁厚が引けない・fit 失敗は null（従来の描き方）。
 * @param {{graph:object, wall:object, rec:object, slot:string, viewedSide:string, materialMap?:object|null,
 *   entryOf?:(key:string)=>object|null}} p viewedSide＝KneeDropFrontSide（見る側の部屋の側）
 * @returns {null | {steps:{t:number, weight:string}[], outline:number[][], maxDeviationMm:number}}
 */
export function kneeDropPartEnvelope({ graph, wall, rec, slot, viewedSide, materialMap = null, entryOf = detailFigureEntry }) {
  const r = resolveKneeDropDetailFigure({ rec, slot, entryOf });
  if (!r?.entry) return null;
  const thickness = wallAssemblyThicknessMm(graph, wall);
  if (thickness === null) return null;
  const fitted = fitKneeDropPart({ figureKey: r.key, slot, wallThicknessMm: thickness, materialMap });
  if (fitted.error) return null;
  const strokes = viewedSide === kneeDropFrontSideOf(rec) ? fitted.strokes : mirrorStrokesAcrossWall(fitted.strokes, thickness);
  return computeEnvelope(strokes, slot);
}

/**
 * 部屋の floorStep の割当てを図のエントリへ解決する（床の段差。S8b-3。高い側の部屋の Room.detailRefs）。
 * @param {{room:object, slot?:string, entryOf?:(key:string)=>object|null}} p slot の既定は DetailSlot.FLOOR_STEP
 * @returns {null | {key:string, slot:string, entry:object|null}} null＝割当て無し。entry が null＝参照切れ（カタログに無い）
 */
export function resolveRoomPartFigure({ room, slot = DetailSlot.FLOOR_STEP, entryOf = detailFigureEntry }) {
  const key = refOf(room, slot);
  if (key === undefined) return null;
  return { key, slot, entry: entryOf(key) ?? null };
}

/**
 * 床の段差の図を段差高に合わせた局所座標のストローク列（fitLocal の結果）。失敗は {error:{code,message}}（例外にしない）。
 * メモは fitDetailLocalMemo と共有（鍵は図のキー・slot・段差高）。材未解決の結果はメモしない。
 * @param {{figureKey:string, stepHeightMm:number, materialMap?:object|null}} p
 */
export function fitFloorStepPart({ figureKey, stepHeightMm, materialMap = null }) {
  return fitDetailLocalMemo({
    figureKey, slot: DetailSlot.FLOOR_STEP, dims: { stepHeight: stepHeightMm },
    targetsOf: (entry, dims) => floorStepTargets(entry, { stepHeightMm: dims.stepHeight, materialMap }),
  });
}

/**
 * 段差高 stepHeightMm の床の段差の包絡線。参照切れ・fit 失敗は null（従来の描き方）。
 * @param {{room:object, stepHeightMm:number, materialMap?:object|null, entryOf?:(key:string)=>object|null}} p room＝高い側の部屋
 * @returns {null | {steps:{t:number, weight:string}[], outline:number[][], maxDeviationMm:number}}
 */
export function floorStepEnvelope({ room, stepHeightMm, materialMap = null, entryOf = detailFigureEntry }) {
  const r = resolveRoomPartFigure({ room, entryOf });
  if (!r?.entry) return null;
  const fitted = fitFloorStepPart({ figureKey: r.key, stepHeightMm, materialMap });
  if (fitted.error) return null;
  return computeEnvelope(fitted.strokes, DetailSlot.FLOOR_STEP, { tMaxMm: stepHeightMm }); // 低い側の床より下は定義域の外
}

/**
 * graph の部屋の floorStep について、図が見つからない・段差高に合わせられない組を集める。
 * 行の形は collectRoomJunctionFailures と同形（wallThickness の代わりに stepHeightMm）。symbolKey は部屋名の主語。
 * 試す段差高は stepHeightsOf(部屋)＝その部屋が高い側になる段差の高さ（呼び出し側が elevation/elevationStepFace.js floorStepHeightsByOwner で供給。
 * finish/ は elevation/ を引かない）。重複排除の鍵 seen は階をまたいで共有できる（破壊的に更新する）。
 * @param {object|null} graph
 * @param {Set<string>} [seen]
 * @param {{materialMap?:object|null, entryOf?:(key:string)=>object|null, stepHeightsOf?:(room:object)=>number[]}} [opts]
 */
export function collectFloorStepFailures(graph, seen = new Set(), { materialMap = null, entryOf = detailFigureEntry, stepHeightsOf = () => [] } = {}) {
  const failures = [];
  for (const room of graph?.rooms ?? []) {
    const r = resolveRoomPartFigure({ room, entryOf });
    if (!r) continue;
    const slot = DetailSlot.FLOOR_STEP;
    const owner = detailOwnerRoom(room.name);
    const push = (key, label, reason, extra) => {
      if (seen.has(key)) return;
      seen.add(key);
      failures.push({ key, symbolKey: owner, slot, label, reason, message: ERR_DETAIL_FIT_FAILED(label, owner, reason, slot), roomId: room.id, ...extra });
    };
    if (!r.entry) {
      push(`notFound|room|${room.id}|${slot}|${r.key}`, r.key, ERR_DETAIL_FIGURE_NOT_FOUND(owner, slot));
      continue;
    }
    for (const stepHeightMm of stepHeightsOf(room)) {
      const fitted = fitFloorStepPart({ figureKey: r.key, stepHeightMm, materialMap });
      if (fitted.error) {
        push(`${detailFitKey({ figureKey: r.key, slot, dims: { stepHeight: stepHeightMm } })}|room|${room.id}`,
          r.entry.label || r.key, fitted.error.message, { stepHeightMm });
      }
    }
  }
  return failures;
}

// ---- 天井の段差（ceilingStep。S8b-4a。持ち主は低い側の天井面＝区画 CeilingZone.detailRefs か部屋 Room.detailRefs）----

/**
 * 天井の段差の割当てを図のエントリへ解決する。持ち主は zone があれば区画、無ければ部屋（区画から部屋への継承はしない）。
 * @param {{room?:object|null, zone?:object|null, entryOf?:(key:string)=>object|null}} p
 * @returns {null | {key:string, slot:string, entry:object|null}} null＝割当て無し。entry が null＝参照切れ（カタログに無い）
 */
export function resolveCeilingStepFigure({ room = null, zone = null, entryOf = detailFigureEntry }) {
  return resolveRoomPartFigure({ room: zone ?? room, slot: DetailSlot.CEILING_STEP, entryOf });
}

/**
 * 天井の段差の図を段差高に合わせた局所座標のストローク列（fitLocal の結果）。失敗は {error:{code,message}}（例外にしない）。
 * メモは fitDetailLocalMemo と共有（鍵は図のキー・slot・段差高）。材未解決の結果はメモしない。
 * @param {{figureKey:string, stepHeightMm:number, materialMap?:object|null}} p
 */
export function fitCeilingStepPart({ figureKey, stepHeightMm, materialMap = null }) {
  return fitDetailLocalMemo({
    figureKey, slot: DetailSlot.CEILING_STEP, dims: { stepHeight: stepHeightMm },
    targetsOf: (entry, dims) => ceilingStepTargets(entry, { stepHeightMm: dims.stepHeight, materialMap }),
  });
}

/**
 * 段差高 stepHeightMm の天井の段差の包絡線。参照切れ・fit 失敗は null（従来の描き方）。
 * @param {{room?:object|null, zone?:object|null, stepHeightMm:number, materialMap?:object|null, entryOf?:(key:string)=>object|null}} p
 *   zone があれば区画の割当て・無ければ room（低い側の持ち主）
 * @returns {null | {steps:{t:number, weight:string}[], outline:number[][], maxDeviationMm:number}}
 */
export function ceilingStepEnvelope({ room = null, zone = null, stepHeightMm, materialMap = null, entryOf = detailFigureEntry }) {
  const r = resolveCeilingStepFigure({ room, zone, entryOf });
  if (!r?.entry) return null;
  const fitted = fitCeilingStepPart({ figureKey: r.key, stepHeightMm, materialMap });
  if (fitted.error) return null;
  return computeEnvelope(fitted.strokes, DetailSlot.CEILING_STEP, { tMinMm: -stepHeightMm }); // 高い側の天井面より上は定義域の外
}

/**
 * 段差高 stepHeightMm の天井の段差を下から見た包絡線（天伏の見切りの線。8b-4c）。解決→fit→computeUnderside。
 * 参照切れ・割当て無し・fit 失敗（FL 基準の図・段差高 0 以下を含む）・材の辺が無くて線が引けないときは null（従来の描き方＝CL の線だけ）。
 * @param {{room?:object|null, zone?:object|null, stepHeightMm:number, materialMap?:object|null, entryOf?:(key:string)=>object|null}} p
 * @returns {null | {lines:{s:number, weight:string}[], reachMm:number}}
 */
export function ceilingStepUnderside({ room = null, zone = null, stepHeightMm, materialMap = null, entryOf = detailFigureEntry }) {
  const r = resolveCeilingStepFigure({ room, zone, entryOf });
  if (!r?.entry) return null;
  if (!(stepHeightMm > 0)) return null;
  const fitted = fitCeilingStepPart({ figureKey: r.key, stepHeightMm, materialMap });
  if (fitted.error) return null;
  const underside = computeUnderside(fitted.strokes, { tMinMm: -stepHeightMm });
  return underside.lines.length > 0 ? underside : null;
}

/**
 * graph の部屋・区画の ceilingStep について、図が見つからない・段差高に合わせられない組を集める。floorStep と同形の行
 * （部屋単位の主語は部屋・区画の主語は「部屋「X」の区画n」。roomId・zoneId を持つ）。試す段差高は stepHeightsOf(部屋, 区画|null)＝その持ち主が低い側に
 * なる段差の高さ（呼び出し側が ceiling/ceilingSurfaces.js ceilingStepHeightsByOwner で供給。finish/ は ceiling/ を引かない）。
 * 重複排除の鍵 seen は階をまたいで共有できる（破壊的に更新する）。
 * @param {object|null} graph
 * @param {Set<string>} [seen]
 * @param {{materialMap?:object|null, entryOf?:(key:string)=>object|null, stepHeightsOf?:(room:object, zone:object|null)=>number[]}} [opts]
 */
export function collectCeilingStepFailures(graph, seen = new Set(), { materialMap = null, entryOf = detailFigureEntry, stepHeightsOf = () => [] } = {}) {
  const failures = [];
  const slot = DetailSlot.CEILING_STEP;
  for (const room of graph?.rooms ?? []) {
    const holders = [{ zone: null, owner: detailOwnerRoom(room.name) }]
      .concat((room.ceilingZones ?? []).map((zone, i) => ({ zone, owner: detailOwnerCeilingZone(room.name, i + 1) })));
    for (const { zone, owner } of holders) {
      const r = resolveCeilingStepFigure({ room, zone, entryOf });
      if (!r) continue;
      const holderKey = zone ? `zone|${room.id}|${zone.id}` : `room|${room.id}`;
      const push = (key, label, reason, extra) => {
        if (seen.has(key)) return;
        seen.add(key);
        failures.push({ key, symbolKey: owner, slot, label, reason, message: ERR_DETAIL_FIT_FAILED(label, owner, reason, slot), roomId: room.id, zoneId: zone?.id ?? null, ...extra });
      };
      if (!r.entry) {
        push(`notFound|${holderKey}|${slot}|${r.key}`, r.key, ERR_DETAIL_FIGURE_NOT_FOUND(owner, slot));
        continue;
      }
      for (const stepHeightMm of stepHeightsOf(room, zone)) {
        const fitted = fitCeilingStepPart({ figureKey: r.key, stepHeightMm, materialMap });
        if (fitted.error) {
          push(`${detailFitKey({ figureKey: r.key, slot, dims: { stepHeight: stepHeightMm } })}|${holderKey}`,
            r.entry.label || r.key, fitted.error.message, { stepHeightMm });
        }
      }
    }
  }
  return failures;
}

/**
 * graph の腰壁・垂れ壁の記録について、部位の図が見つからない・壁厚に合わせられない組を集める。
 * 通知の行は collectRoomJunctionFailures と同形: {key, symbolKey, slot, label, reason, message, kneeDropKey, wallThickness?}。
 * symbolKey は通知文の主語（腰壁・垂れ壁〈部屋〉）。重複排除の鍵 seen は階をまたいで共有できる（破壊的に更新する）。
 * @param {object|null} graph
 * @param {Set<string>} [seen]
 * @param {{materialMap?:object|null, entryOf?:(key:string)=>object|null}} [opts]
 */
export function collectKneeDropPartFailures(graph, seen = new Set(), { materialMap = null, entryOf = detailFigureEntry } = {}) {
  const failures = [];
  if (!graph?.kneeDropWalls || graph.kneeDropWalls.size === 0) return failures;
  let cellToRoom = null;
  for (const [recKey, rec] of graph.kneeDropWalls) {
    if (!rec?.detailRefs) continue;
    for (const slot of KNEE_DROP_DETAIL_SLOTS) {
      const r = resolveKneeDropDetailFigure({ rec, slot, entryOf });
      // 暗黙の既定（組込みの天板）の失敗は通知しない: 展開は従来の天端下の細線へ黙って戻る（S8c）
      if (!r || r.source === DetailFigureSource.DEFAULT) continue;
      cellToRoom ??= buildCellToRoom(graph);
      const geo = kneeDropWallGeometry(graph, recKey, cellToRoom);
      const owner = detailOwnerKneeDrop([geo?.roomNeg?.name, geo?.roomPos?.name]);
      const push = (key, label, reason, extra) => {
        if (seen.has(key)) return;
        seen.add(key);
        failures.push({
          key, symbolKey: owner, slot, label, reason, message: ERR_DETAIL_FIT_FAILED(label, owner, reason, slot), kneeDropKey: recKey, ...extra,
        });
      };
      if (!r.entry) {
        // 参照切れ。鍵は記録ごと（同じ図を別の記録が指していても主語が違う）
        push(`notFound|kneeDrop|${recKey}|${slot}|${r.key}`, r.key, ERR_DETAIL_FIGURE_NOT_FOUND(owner, slot));
        continue;
      }
      if (!geo) continue; // 区間の壁が無い（孤児の記録）は試さない
      const thicknesses = new Set();
      for (const wall of geo.walls) {
        const mm = wallAssemblyThicknessMm(graph, wall);
        if (mm !== null) thicknesses.add(mm);
      }
      for (const wallThickness of [...thicknesses].sort((a, b) => a - b)) {
        const fitted = fitKneeDropPart({ figureKey: r.key, slot, wallThicknessMm: wallThickness, materialMap });
        if (fitted.error) {
          push(`${detailFitKey({ figureKey: r.key, slot, dims: { wallThickness } })}|kneeDrop|${recKey}`,
            r.entry.label || r.key, fitted.error.message, { wallThickness });
        }
      }
    }
  }
  return failures;
}
