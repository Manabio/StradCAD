/**
 * 展開図: 寸法行の分割点抽出（純関数）。設計意図は .claude/elevation-model.md 参照。
 *
 * 寸法は**1行**（ユーザー明示指示2026-08「展開図に寸法2段書きは不要」）。旧ROW2（通り芯間寸法の
 * 独立行）は廃止し、通り芯をこの鎖の分割点（S5）として取り込む——面の壁中心線間を1本で通すのでは
 * なく、床の段差CL・内部の直交壁（袖壁・腰壁）・開放スパン境界・通り芯で分割した「寸法の鎖」。
 */
import { perpendicularWallsOnFace } from './elevationFaces.js';
import { SPLIT_MERGE_EPS_MM } from './elevationStyle.js';

/**
 * face の寸法行の分割点（ローカルx。boundary.lo/hiそのものは含まない）を昇順・重複除去で返す。
 * 4源:
 *   S1 = 段差CL（floorSegments[i].hiCLId が実在するCLを指す境界。floorSegments[i].hiX を使う）
 *   S2 = perpendicularWallsOnFace(face, graph, 'far') の壁のaxisCL
 *   S4 = 開放スパンの内部境界（spans[i].hiCLId が実在するCLを指す境界。spans[i].hiCLX を使う。
 *        elevationOpenSpan.jsのextendFaceWithOpenSpansが既にローカルx換算済みのため localXOf不要）
 *   S5 = 面を貫く通り芯（呼び出し側が算出済みのローカルx配列 gridXs）
 * **旧S3（面に届く非通り芯の中心線）は廃止した**（ユーザー実機指摘2026-08: 階段室「6」Bの
 * 寸法が「2500」であるべきところ中心線1本で「1500+1000」へ割れた。中心線は壁を伴わない
 * 作図補助であり、展開図の寸法をそこで割る必然性が無い——分割は実体（段差・直交壁・開放境界）と
 * 通り芯だけが担う）。
 * boundary.lo/hiとほぼ同位置（±SPLIT_MERGE_EPS_MM）の点は除外する（marks配列側で改めて両端に足すため）。
 * @param {object} face - buildRoomFaces/composeRoomFacesの1件
 * @param {object} graph
 * @param {{floorSegments?:Array<{hiX:number, hiCLId:?string}>, boundary:{lo:number, hi:number},
 *   spans?:Array<{hiCLX:number|null, hiCLId:?string}>, gridXs?:number[]}} opts
 * @returns {number[]}
 */
export function collectRow1SplitPoints(face, graph, { floorSegments, boundary, spans, gridXs }) {
  const localXOf = worldCoord => (worldCoord - face.originWorld) * face.dirSign;
  const raw = [];

  // S1: 段差CL（gap-fillで生まれた境界=hiCLIdなしは対象外——実在するCLの位置ではないため）。
  if (floorSegments) {
    for (let i = 0; i + 1 < floorSegments.length; i++) {
      if (floorSegments[i].hiCLId) raw.push(floorSegments[i].hiX);
    }
  }

  // S4: 開放スパンの内部境界（壁区間↔open区間の境界。実在するCLを指すものだけ）。
  if (spans) {
    for (const s of spans) {
      if (s.hiCLId != null && s.hiCLX != null) raw.push(s.hiCLX);
    }
  }

  // S2: 面の中心線へ到達する直交壁（袖壁・腰壁を含む。近接=faceValueまでは届かなくてよい）。
  for (const w of perpendicularWallsOnFace(face, graph, 'far')) {
    raw.push(localXOf(w.axisCL.effectiveValue));
  }

  // S5: 面を貫く通り芯（ユーザー明示指示2026-08「展開図に寸法2段書きは不要」「壁幅が通り芯を
  // またぐ場合は通り芯から」）。旧ROW2（通り芯間寸法の独立行）を廃止し、寸法の鎖1本へ統合した
  // ——呼び出し側（elevationFigure.jsのappendAnnotationRows）が既に算出済みのローカルxを渡す。
  for (const x of gridXs ?? []) raw.push(x);

  const filtered = raw.filter(x =>
    Math.abs(x - boundary.lo) > SPLIT_MERGE_EPS_MM && Math.abs(x - boundary.hi) > SPLIT_MERGE_EPS_MM);
  filtered.sort((a, b) => a - b);

  const merged = [];
  for (const x of filtered) {
    if (merged.length === 0 || x - merged[merged.length - 1] > SPLIT_MERGE_EPS_MM) merged.push(x);
  }
  return merged;
}
