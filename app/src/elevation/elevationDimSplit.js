/**
 * 展開図: ROW1（壁芯間寸法）の分割点抽出（純関数）。設計意図は .claude/elevation-model.md 参照。
 *
 * ROW1は「面の壁中心線間（boundary.lo〜hi）を1本の寸法で通す」のではなく、床の段差CL・
 * 内部の直交壁（袖壁・腰壁）・面に到達する非通り芯の中心線、の3源で分割した「寸法の鎖」にする
 * （通り芯自体はROW2が別途担当するため、S3からは除外する）。
 */
import { CenterLineType, Discipline } from '@core';
import { perpendicularWallsOnFace } from './elevationFaces.js';
import { SPLIT_MERGE_EPS_MM } from './elevationStyle.js';

/**
 * face のROW1寸法の分割点（ローカルx。boundary.lo/hiそのものは含まない）を昇順・重複除去で返す。
 * 4源:
 *   S1 = 段差CL（floorSegments[i].hiCLId が実在するCLを指す境界。floorSegments[i].hiX を使う）
 *   S2 = perpendicularWallsOnFace(face, graph, 'far') の壁のaxisCL
 *   S3 = 非labeled・非破線・discipline=ARCHの中心線で、face軸に直交し face.lo<v<face.hi、
 *        かつ extent が面（壁）まで到達しているもの（cl.extentLo==null か、
 *        cl.extentLo<=av<=cl.extentHi。av=face.axisCL.effectiveValue）
 *   S4 = 開放スパンの内部境界（spans[i].hiCLId が実在するCLを指す境界。spans[i].hiCLX を使う。
 *        elevationOpenSpan.jsのextendFaceWithOpenSpansが既にローカルx換算済みのため localXOf不要）
 * boundary.lo/hiとほぼ同位置（±SPLIT_MERGE_EPS_MM）の点は除外する（marks配列側で改めて両端に足すため）。
 * @param {object} face - buildRoomFaces/composeRoomFacesの1件
 * @param {object} graph
 * @param {{floorSegments?:Array<{hiX:number, hiCLId:?string}>, boundary:{lo:number, hi:number},
 *   spans?:Array<{hiCLX:number|null, hiCLId:?string}>}} opts
 * @returns {number[]}
 */
export function collectRow1SplitPoints(face, graph, { floorSegments, boundary, spans }) {
  const localXOf = worldCoord => (worldCoord - face.originWorld) * face.dirSign;
  const av = face.axisCL.effectiveValue;
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

  // S3: 面に直交する非通り芯の中心線（extentが面まで届いているもののみ）。
  // graph.centerLines未定義（最小限フェイクgraphを使う単体テスト）は「中心線なし」として扱う。
  const perpType = face.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  for (const cl of graph.centerLines ?? []) {
    if (cl.centerLineType !== perpType) continue;
    if (cl.labeled) continue; // 通り芯はROW2が担当するため除外
    if (cl.lineType === 'dashed') continue;
    if (cl.discipline !== Discipline.ARCH) continue;
    if (!(cl.value > face.lo && cl.value < face.hi)) continue;
    const reaches = cl.extentLo == null || (cl.extentLo <= av && av <= cl.extentHi);
    if (!reaches) continue;
    raw.push(localXOf(cl.value));
  }

  const filtered = raw.filter(x =>
    Math.abs(x - boundary.lo) > SPLIT_MERGE_EPS_MM && Math.abs(x - boundary.hi) > SPLIT_MERGE_EPS_MM);
  filtered.sort((a, b) => a - b);

  const merged = [];
  for (const x of filtered) {
    if (merged.length === 0 || x - merged[merged.length - 1] > SPLIT_MERGE_EPS_MM) merged.push(x);
  }
  return merged;
}
