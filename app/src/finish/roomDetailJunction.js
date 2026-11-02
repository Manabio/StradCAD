// ================================================================
// 部屋の取り合い（Room.detailRefs の floorWall・wallCeiling）の解決と fit・失敗の集計（部分詳細図 S8a）。
//   resolveRoomDetailFigure  部屋の割当て（slot）→ 図のキーとカタログのエントリ。参照切れは drawn=null
//   fitRoomJunction          図のキー×壁厚の fit（openings/openingCatalog.js fitDetailLocalMemo のメモを共有）
//   wallAssemblyThicknessMm  壁の組（同軸・スパン重なりの全壁の materialRange ∪ backingRange）の厚み
//   roomWallThicknessesMm    部屋が生成した壁の組の厚みの集合
//   collectRoomJunctionFailures  未解決キー・fit 失敗の集計（S3 の openings/openingDetailFitCheck.js と同型）
// 仕上げモード init（通知）と展開モード init（8a-2）が呼ぶ。描画は毎レンダー呼ばれる純関数で通知の経路が無いので、
// 通知は init が自分で fit を試して集める。失敗は例外にしない（{error}・集計の行）。
// ================================================================

import { ROOM_DETAIL_SLOTS } from '../core/constants.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND, detailOwnerRoom } from '../error.js';
import { detailFigureEntry, detailFitKey, fitDetailLocalMemo } from '../openings/openingCatalog.js';
import { junctionTargets } from './roomDetailTargets.js';
import { wallConcealRange } from './columnWrap.js';
import { sameAxisLine } from './kneeDropWall.js';

const refOf = (room, slot) => {
  const refs = room?.detailRefs;
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) return undefined;
  const key = refs[slot];
  return typeof key === 'string' && key !== '' ? key : undefined;
};

/**
 * 部屋の slot の割当てを図のエントリへ解決する。
 * @param {{room:object, slot:string, entryOf?:(key:string)=>object|null}} p entryOf＝図のキー→エントリ（既定はカタログ）
 * @returns {null | {key:string, slot:string, entry:object|null}} null＝割当て無し。entry が null＝参照切れ（カタログに無い）
 */
export function resolveRoomDetailFigure({ room, slot, entryOf = detailFigureEntry }) {
  const key = refOf(room, slot);
  if (key === undefined) return null;
  return { key, slot, entry: entryOf(key) ?? null };
}

/**
 * 図を（壁厚）に合わせた局所座標のストローク列（fitLocal の結果）。失敗は {error:{code,message}}（例外にしない）。
 * メモは openings/ の fitDetailLocalMemo と共有（鍵は図のキー・slot・壁厚）。材マスタ未ロードで材束縛が解けない結果はメモしない。
 * @param {{figureKey:string, slot:string, wallThicknessMm:number, materialMap?:object|null}} p
 */
export function fitRoomJunction({ figureKey, slot, wallThicknessMm, materialMap = null }) {
  return fitDetailLocalMemo({
    figureKey, slot, dims: { wallThickness: wallThicknessMm },
    targetsOf: (entry, dims) => junctionTargets(entry, { slot, wallThicknessMm: dims.wallThickness, materialMap }),
  });
}

const roundMm = v => Math.round(v * 1e6) / 1e6;

const spanOf = w => ({ lo: Math.min(w.coord1, w.coord2), hi: Math.max(w.coord1, w.coord2) });

/**
 * 壁の「組」の厚み（mm）。同じ軸 CL 上でスパンが重なる全壁（下地オーナー壁＋仕上げ薄壁など）の
 * wallConcealRange（materialRange ∪ backingRange）の合併幅（空隙があっても lo〜hi の全幅）。範囲が引けなければ null。
 * @param {{walls?:object[]}|null} graph
 * @param {object} wall
 * @returns {number|null}
 */
export function wallAssemblyThicknessMm(graph, wall) {
  const own = spanOf(wall);
  let lo = Infinity;
  let hi = -Infinity;
  for (const w of [wall, ...(graph?.walls ?? [])]) {
    if (w !== wall) {
      if (!sameAxisLine(w.axisCL, wall.axisCL)) continue; // 通り一致は座標で見る規約（kneeDropWall.sameAxisLine。参照同一性・id 比較にしない）
      const sp = spanOf(w);
      if (!(Math.min(sp.hi, own.hi) > Math.max(sp.lo, own.lo))) continue;
    }
    const r = wallConcealRange(w);
    if (r && Number.isFinite(r.lo) && Number.isFinite(r.hi)) { lo = Math.min(lo, r.lo); hi = Math.max(hi, r.hi); }
  }
  return hi > lo ? roundMm(hi - lo) : null;
}

/**
 * 部屋が生成した壁（room.generatedWallIds）の組の厚み（wallAssemblyThicknessMm）の、重複を除いた昇順の列。
 * 壁が無い・引けない部屋は空（fit を試さない）。extraWalls＝展開図が面ごとに実際に使う壁（隣室が生成した壁を含む。
 * elevationJunction.junctionFaceWallsOf）。描画と通知の壁厚の取り方を合わせる。
 * @param {{shapeMap?:{get:(id:string)=>object|undefined}, walls?:object[]}|null} graph
 * @param {{generatedWallIds?:Iterable<string>}|null} room
 * @param {object[]} [extraWalls]
 * @returns {number[]}
 */
export function roomWallThicknessesMm(graph, room, extraWalls = []) {
  const out = new Set();
  const walls = [...extraWalls];
  for (const id of room?.generatedWallIds ?? []) {
    const wall = graph?.shapeMap?.get(id);
    if (wall) walls.push(wall);
  }
  for (const wall of walls) {
    const mm = wallAssemblyThicknessMm(graph, wall);
    if (mm !== null) out.add(mm);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * graph の部屋について、取り合いの図が見つからない・壁厚に合わせられない組を集める。
 * 通知の行は buildResolveRows の detailFitFailures と同形: {key, symbolKey, slot, label, reason, message, roomId, wallThickness?}。
 * symbolKey は通知文の主語（部屋名）。重複排除の鍵 seen は階をまたいで共有できる（破壊的に更新する）。
 * @param {object|null} graph
 * @param {Set<string>} [seen]
 * @param {{materialMap?:object|null, entryOf?:(key:string)=>object|null, faceWallsOf?:(room:object)=>object[]}} [opts]
 *   faceWallsOf＝展開 init が渡す「部屋の面ごとの壁」（仕上げ init は渡さない＝生成壁のみ）
 */
export function collectRoomJunctionFailures(graph, seen = new Set(), { materialMap = null, entryOf = detailFigureEntry, faceWallsOf = null } = {}) {
  const failures = [];
  for (const room of graph?.rooms ?? []) {
    const owner = detailOwnerRoom(room.name);
    for (const slot of ROOM_DETAIL_SLOTS) {
      const r = resolveRoomDetailFigure({ room, slot, entryOf });
      if (!r) continue;
      const push = (key, label, reason, extra) => {
        if (seen.has(key)) return;
        seen.add(key);
        failures.push({
          key, symbolKey: owner, slot, label, reason, message: ERR_DETAIL_FIT_FAILED(label, owner, reason, slot), roomId: room.id, ...extra,
        });
      };
      if (!r.entry) {
        // 参照切れ。鍵は部屋ごと（同じ図を別の部屋が指していても主語が違う）
        push(`notFound|room|${room.id}|${slot}|${r.key}`, r.key, ERR_DETAIL_FIGURE_NOT_FOUND(owner, slot));
        continue;
      }
      for (const wallThickness of roomWallThicknessesMm(graph, room, faceWallsOf?.(room) ?? [])) {
        const fitted = fitRoomJunction({ figureKey: r.key, slot, wallThicknessMm: wallThickness, materialMap });
        if (fitted.error) {
          push(`${detailFitKey({ figureKey: r.key, slot, dims: { wallThickness } })}|room|${room.id}`,
            r.entry.label || r.key, fitted.error.message, { wallThickness });
        }
      }
    }
  }
  return failures;
}
