/**
 * 階段吹抜け（STAIR_VOID）の整合（純モジュール。store.js・snap.js・.jsx・storage を静的に引かない）。
 * 直下階の屋内階段と、自階の STAIR_VOID を突き合わせる reconcileStairVoids と、
 * それが使う部品（setsEqual・isIndoorStair・addStairVoidRoom）。後者3つは stairFloorSync.js から移した
 * （stairFloorSync.js は storage を引くため、純モジュールから使えるようここへ置く。挙動は移す前と同じ）。
 */
import { RoomFeature, RoomKind } from '@core';
import { refreshCells } from '../gridCells.js';
import { subtractCellsFromUndefinedRooms, makeRoomUndefined } from '../roomUndefined.js';
import { collectNeededCLs, addMissingCLs, translateCellSet } from '../floorCLMap.js';

export function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// 屋内階段判定: ペア Room の kind が EXTERIOR でなければ屋内（roomId なしの旧データは屋内扱い）
export function isIndoorStair(graph, stair) {
  const room = stair.roomId ? graph.roomMap.get(stair.roomId) : null;
  return (room?.kind ?? RoomKind.INTERIOR) !== RoomKind.EXTERIOR;
}

/**
 * 最上階の階段 footprint へ階段吹抜け（STAIR_VOID）Room を自動指定する。
 * 未定義以外の既存 Room（stairVoid 自身を含む）とセルが重なる場合は何もしない（冪等・二重割当防止）。
 * 重なりは両辺を refreshCells で現行グリッドの原子セルへ展開して比べる（cells は translateCellSet の
 * 生キーで、格子が直下階より細かい階では原子セルと一致しない。生のまま比べると既存の吹抜けを見落とし、
 * 呼ぶたびに増える）。展開後が空（解決できるセルが無い）なら何もしない。
 * 未定義 Room（階段の連動削除などで外形を保つために残した部屋）とだけ重なるなら、そのセルを未定義 Room
 * から引き抜いてから作る（再指定が詰まらない。FinishModeState.applyNaming と同じ前例）。
 * 作る Room のセルは渡された cells（生キー）のまま持つ（読む側が refreshCells で展開する）。
 * @returns {boolean} 追加したか
 */
export function addStairVoidRoom(graph, cells) {
  if (cells.size === 0) return false;
  const refreshed = refreshCells(cells, graph);
  if (refreshed.size === 0) return false;
  for (const room of graph.rooms) {
    if (room.feature === RoomFeature.UNDEFINED) continue;
    const roomCells = refreshCells(room.cells, graph);
    if ([...refreshed].some(k => roomCells.has(k))) return false;
  }
  subtractCellsFromUndefinedRooms(graph, refreshed);
  const room = graph.addRoom(new Set(cells));
  room.setFeature(RoomFeature.STAIR_VOID);
  return true;
}

/**
 * 直下階 belowGraph の屋内階段と、自階 graph の階段吹抜け（STAIR_VOID）の整合を取る（純関数・同期）。
 * 順序: 1.不足の中心線の補完 → 2.足元の写し → 3.孤児の削除 → 4.重複の削除 → 5.追加
 * （追加を孤児削除の後にして、古い足元の孤児と部分的に重なる新しい足元も1回の呼び出しで置く）。
 * 写せない階段があれば孤児の判定を見送る（安全側。既存の吹抜けを消さない）。
 * 自階の階段（ペア部屋あり）と重なる吹抜けは消し、ペア部屋が無い階段との同居は触らない——
 * 呼び出し側は ensureStairRooms をこの関数の後に回す（吹抜けがペア部屋へ転用される）。
 * 屋外階段は一切対象にしない（上に何も置かない）。needed（per-floor 中心線）が空でも続ける
 * （通り芯だけで囲まれた階段にも吹抜けを置く）。
 * @param {object} graph       自階（N+1）。直接書き換える
 * @param {object} belowGraph  直下の採用階（N）。読むだけ
 * @param {object} structGraph 通り芯
 * @returns {{ changed: boolean, added: Array<{cells:Set}>, removed: Array<{roomId, reason:'orphan'|'duplicate'}>,
 *             skipped: Array<{cells:Set, reason:'untranslatable'|'overlap'|'covered-by-own-stair'}> }}
 */
export function reconcileStairVoids(graph, belowGraph, structGraph) {
  if (!graph) throw new Error('reconcileStairVoids: graph がありません');
  if (!belowGraph) throw new Error('reconcileStairVoids: belowGraph がありません');
  const result = { changed: false, added: [], removed: [], skipped: [] };
  const belowIndoor = belowGraph.stairs.filter(s => isIndoorStair(belowGraph, s));

  // 1. 不足の中心線の補完（屋内階段のセルだけ。needed が空でも以降を続ける）
  const needed = collectNeededCLs(belowIndoor.flatMap(s => [...s.cells]), belowGraph);
  if (addMissingCLs(needed, belowGraph, structGraph, graph) > 0) result.changed = true;

  // 2. 足元の写し（追加はまだしない）。写せた足元（現行グリッドの原子セル集合）を手順3の孤児判定と手順5に使う
  const mapped = []; // { translated, refreshed }
  for (const stair of belowIndoor) {
    const translated = translateCellSet(stair.cells, belowGraph, structGraph, graph);
    const refreshed = translated ? refreshCells(translated, graph) : null;
    if (!translated || refreshed.size === 0) {
      result.skipped.push({ cells: new Set(stair.cells), reason: 'untranslatable' });
      continue;
    }
    mapped.push({ translated, refreshed });
  }
  const validFootprints = mapped.map(m => m.refreshed);

  // 3a. 自階の階段（ペア部屋あり）と原子セルが重なる STAIR_VOID は removeRoom（二重所有を残さない）。
  //     ペア部屋が無い階段との同居は触らない（後段の ensureStairRooms がペア部屋へ転用する）。
  const ownPaired = graph.stairs
    .filter(s => s.roomId && graph.roomMap.get(s.roomId)?.feature === RoomFeature.STAIR)
    .map(s => refreshCells(s.cells, graph));
  for (const room of graph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID)) {
    const cells = refreshCells(room.cells, graph);
    if (!ownPaired.some(sc => [...cells].some(k => sc.has(k)))) continue;
    graph.removeRoom(room.id);
    result.removed.push({ roomId: room.id, reason: 'duplicate' });
    result.changed = true;
  }

  // 3. 孤児の削除: どの足元とも一致しない STAIR_VOID は未定義化（外形を保つ。applyStairRemovalToFloor と同じ）。
  //    追加（手順5）より前に行う——古い足元の孤児と新しい足元が部分的に重なっても、1回の呼び出しで収束させるため。
  //    写せない階段が1つでもあれば孤児の判定そのものを見送る（その階段の既存の吹抜けを誤って消さない。安全側）
  const canJudgeOrphans = !result.skipped.some(s => s.reason === 'untranslatable');
  const keptVoids = [];
  for (const room of graph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID)) {
    const cells = refreshCells(room.cells, graph);
    if (!canJudgeOrphans || validFootprints.some(fp => setsEqual(fp, cells))) { keptVoids.push({ room, cells }); continue; }
    makeRoomUndefined(room);
    result.removed.push({ roomId: room.id, reason: 'orphan' });
    result.changed = true;
  }

  // 4. 重複の削除: 同 footprint の吹抜けは graph.rooms の並びで先頭だけ残す。
  //    残りは未定義化せず removeRoom で消す——未定義化すると残した吹抜けと同じセルを持つ未定義部屋が
  //    重なって残り（セルの二重所有）、外形は残した吹抜けが既に保っているため未定義部屋は不要。
  const seen = [];
  for (const { room, cells } of keptVoids) {
    if (seen.some(c => setsEqual(c, cells))) {
      graph.removeRoom(room.id);
      result.removed.push({ roomId: room.id, reason: 'duplicate' });
      result.changed = true;
    } else {
      seen.push(cells);
    }
  }

  // 5. 追加
  for (const { translated, refreshed } of mapped) {
    const hasSameVoid = graph.rooms.some(r =>
      r.feature === RoomFeature.STAIR_VOID && setsEqual(refreshCells(r.cells, graph), refreshed));
    if (hasSameVoid) continue; // 冪等

    // 自階の階段と原子セルが1つでも重なれば置かない（ペア部屋の有無によらない）
    const coveredByOwn = graph.rooms.some(r =>
      r.feature === RoomFeature.STAIR && setsEqual(refreshCells(r.cells, graph), refreshed))
      || graph.stairs.some(s => [...refreshCells(s.cells, graph)].some(k => refreshed.has(k)));
    if (coveredByOwn) {
      result.skipped.push({ cells: new Set(translated), reason: 'covered-by-own-stair' });
      continue;
    }

    if (addStairVoidRoom(graph, translated)) {
      result.added.push({ cells: new Set(translated) });
      result.changed = true;
    } else {
      result.skipped.push({ cells: new Set(translated), reason: 'overlap' });
    }
  }
  return result;
}

/**
 * cells（候補の部屋のセル）に触れる階段吹抜け（STAIR_VOID）を、全体が含まれるものと一部だけ重なるものに分ける
 * （純関数・読むだけ）。続きの階段の指定（FinishModeState.applyNaming）が、吸収してよい吹抜けと
 * 拒否すべき部分的な重なりを見分けるのに使う。両辺を refreshCells で現行グリッドの原子セルへ展開して比べる。
 * 重ならない吹抜けはどちらにも入らない。展開後が空の吹抜けは触れていないとみなす。
 * @returns {{ absorbed: Array<object>, partial: boolean }} absorbed＝セルが全部 cells に含まれる吹抜け
 */
export function stairVoidsTouching(graph, cells) {
  const mine = refreshCells(cells, graph);
  const absorbed = [];
  let partial = false;
  for (const room of graph.rooms) {
    if (room.feature !== RoomFeature.STAIR_VOID) continue;
    const own = refreshCells(room.cells, graph);
    if (own.size === 0) continue;
    const hit = [...own].filter(k => mine.has(k)).length;
    if (hit === 0) continue;
    if (hit === own.size) absorbed.push(room);
    else partial = true;
  }
  return { absorbed, partial };
}
