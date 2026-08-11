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
 * @returns {{mm:number, raw:string, isFallback:boolean}}
 *   mm … 作図に使う数値(mm)。isFallback=true のときは既定値。
 *   raw … ラベル表示用の原文（数値化できない入力もそのまま返す）。
 */
export function roomCeilingHeight(graph, room) {
  const info = room.getFinishInfo();
  const raw = info.ceilingHeight;
  const numeric = raw != null && raw !== '' ? Number(raw) : NaN;
  if (Number.isFinite(numeric)) {
    return { mm: numeric, raw: String(raw), isFallback: false };
  }
  const fallback = graph?.defaultCeilingHeight ?? DEFAULT_ROOM_CEILING_HEIGHT;
  return { mm: fallback, raw: raw != null && raw !== '' ? String(raw) : String(fallback), isFallback: true };
}
