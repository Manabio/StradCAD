/**
 * 部屋の天井高さ解決（複数箇所の重複式の受け皿）。
 *
 * room.getFinishInfo().ceilingHeight は自由入力の文字列（傾斜天井のレンジ表記
 * 「2300～3500」等を許容する。FinishTable.jsx 冒頭コメント参照）。数値化できる
 * 場合はその値、できない場合は graph.defaultCeilingHeight で作図しつつ、
 * ラベル表示には原文をそのまま使う（.claude/elevation-model.md 確定仕様7）。
 */
import { DEFAULT_ROOM_CEILING_HEIGHT } from '@core';

/**
 * @param {object} graph
 * @param {import('@core').Room} room
 * @param {number} [_depth] 内部再帰ガード（部分指定の親参照が循環していても無限再帰しない）
 * @returns {{mm:number, raw:string, isFallback:boolean}}
 *   mm … 作図に使う数値(mm)。isFallback=true のときは既定値。
 *   raw … ラベル表示用の原文（数値化できない入力もそのまま返す）。
 */
export function roomCeilingHeight(graph, room, _depth = 0) {
  const info = room.getFinishInfo();
  const raw = info.ceilingHeight;
  const numeric = raw != null && raw !== '' ? Number(raw) : NaN;
  if (Number.isFinite(numeric)) {
    return { mm: numeric, raw: String(raw), isFallback: false };
  }

  // 項目5: 部分指定（referenceRoomIdsで親を参照）が自身のCH指定（master/override）を持たない
  // 場合は、天井面の絶対高さを親と揃えるようCHを段差ぶん増減する
  // （部分指定CH = 親CH − (部分FL − 親FL)。問題修正2026-08: FLが親と同じでも親CHへ揃える——
  // 旧実装はFL差がある場合しか調整せず、FL同一の部分指定がdefaultCeilingHeightへ落ちて
  // 親と異なるCHになり、展開図の区間別天井描画で偽の天井段差が生じた）。
  // 自身に明示的なCH指定（master/override）があれば
  // ここへは到達しない——数値指定は上のnumericチェックで既にreturn済み、傾斜天井のレンジ表記
  // （例:「2300〜3500」。数値化できないが立派な明示指定）は raw!=null&&raw!=='' のガードで
  // 弾いて素通りさせない。既存の「customOverrides・masterが常に優先」という慣習
  // （Room.getFinishInfo）をこの追加の解決レイヤーにもそのまま適用する形になる。仕上げ表
  // （FinishTable.jsx）・展開図（elevationBand.js等）はいずれもこのroomCeilingHeightを
  // 単一情報源として使うため、両方に一貫して効く。
  const hasOwnCH = raw != null && raw !== '';
  // _depth<8は循環参照（A→B→A等）で無限再帰しないための意図的な打ち切り——上限へ達したら
  // 親CHへの揃えを諦めdefaultCeilingHeightへフォールバックする（正常な部分指定の入れ子が
  // 8世代を超えることは現実的に無い前提。QA F7）。
  const parent = !hasOwnCH && _depth < 8 && room.referenceRoomIds?.size > 0 && graph
    ? graph.rooms?.find(r => room.referenceRoomIds.has(r.id))
    : null;
  if (parent) {
    const parentFL = graph.effectiveFloorLevel(parent);
    const ownFL = graph.effectiveFloorLevel(room);
    const parentCH = roomCeilingHeight(graph, parent, _depth + 1);
    const mm = parentCH.mm - (ownFL - parentFL);
    // QA E1: 子FLが親CH以上（段差が大きすぎる）だとmmが0以下になり、展開図で天井線が床線
    // 以下になる・kneeDropWall等のエラーメッセージが無意味な範囲になる等が起きる。物理的に
    // 不可能な計算結果として扱い、下のgraph.defaultCeilingHeightフォールバックへ委ねる。
    if (mm > 0) return { mm, raw: String(mm), isFallback: parentCH.isFallback };
  }

  const fallback = graph?.defaultCeilingHeight ?? DEFAULT_ROOM_CEILING_HEIGHT;
  return { mm: fallback, raw: raw != null && raw !== '' ? String(raw) : String(fallback), isFallback: true };
}
