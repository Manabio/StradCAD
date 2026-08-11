/**
 * 展開図: 部屋 → 壁面（A/B/C/D、L字分割）の導出と、面上の開口抽出（純関数群）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * A＝平面の上側（北側）の壁を室内から見た面、B=右（東）、C=下（南）、D=左（西）
 * （時計回り。12/3/6/9時に対応）。dirSign は「室内に立って面を正対して見たとき
 * 右手が指す世界方向」で、A→B→C→D は平面を時計回りに一巡し、隣り合う面は
 * 同じ隅を世界座標で共有する（buildRoomFaces の不変条件）。
 */
import { RoomKind, RoomFeature } from '@core';
import { computeExternalEdgeParams, mergeSegments } from '../finish/wallGeneration.js';
import { innerWallFaceAt } from '../finish/wallFaces.js';

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する（finish/*.js と同じ規約）。
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/**
 * 展開図の対象部屋。屋内・有名・feature が null または STAIR（階段）のみ採用する
 * （STAIR_VOID・VOID・UNDEFINED・屋外は除外）。graph.rooms の登録順のまま返す。
 */
export function selectElevationRooms(graph) {
  return graph.rooms.filter(r =>
    r.kind === RoomKind.INTERIOR && r.name !== '' &&
    (r.feature == null || r.feature === RoomFeature.STAIR));
}

// letter マップ（buildRoomFaces ヘッダ参照）。isVertical・axisOffset(inward)の符号だけで決まる。
function letterOf(isVertical, axisOffset) {
  if (!isVertical) return axisOffset > 0 ? 'A' : 'C';
  return axisOffset < 0 ? 'B' : 'D';
}

const DIR_SIGN = { A: 1, B: 1, C: -1, D: -1 };

/**
 * 各面の端座標を、同じ直交CL上にある直交面の faceValue（壁の室内側仕上げ面）へ詰める
 * （＝仕上げ面から仕上げ面までの有効長さにする）。対応する直交面が無い辺はCL芯のまま
 * （faces 由来の元の lo/hi を保持）。
 * @param {object[]} faces - letter/dirSign/faceValue/lo/hi/startCLId/endCLId/axisCL を持つ面リスト
 * @returns {object[]} lo/hi/run/originWorld を詰め直した新しい配列（他フィールドは同一参照）
 */
export function snapFaceEndsToCorners(faces) {
  const byAxisCLId = new Map();
  for (const f of faces) byAxisCLId.set(f.axisCL.id, f);

  return faces.map(f => {
    const startFace = byAxisCLId.get(f.startCLId);
    const endFace   = byAxisCLId.get(f.endCLId);
    const lo = startFace ? startFace.faceValue : f.lo;
    const hi = endFace   ? endFace.faceValue   : f.hi;
    return { ...f, lo, hi, run: hi - lo, originWorld: f.dirSign > 0 ? lo : hi };
  });
}

// 面から見て「次の面」へつながる隅のCL id（dirSign>0はhi側=endCLId、dirSign<0はlo側=startCLId。
// snapFaceEndsToCornersの対応関係と表裏の同じ規則）。
function exitCLId(f) { return f.dirSign > 0 ? f.endCLId : f.startCLId; }

/**
 * 部屋 → 壁面（A/B/C/D。L字は同letter複数面へ分割。ラベルはB1/B2方式）のリスト。
 * 返り値は実際の外周を時計回りに1周した順（L字で letter が interleave する場合も
 * 隣接要素が世界座標で隅を共有する＝buildRoomFaces の不変条件）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {Array<{id:string, label:string, letter:string, isVertical:boolean, axisCL:object,
 *   inward:number, faceValue:number, lo:number, hi:number, run:number, dirSign:number,
 *   originWorld:number, startCLId:string, endCLId:string}>}
 */
export function buildRoomFaces(room, graph) {
  // axisCLId ごとにグループ化してから mergeSegments する（wallGeneration.js の各生成関数と同じ
  // 手順）。グループ化せず全外周エッジを一括で渡すと、mergeSegments が「endCLId===次のstartCLId」
  // だけで結合するため、L字の隅で別軸（別letter）の面同士が誤って1本にマージされてしまう
  // （例: 上辺セグメントの終端Vertical CLと、そのCLをaxisとする別の垂直面のstartCLIdが
  // 偶然一致し、letterの異なる面が消えてしまう）。
  const paramsByAxisCLId = new Map();
  for (const p of computeExternalEdgeParams(room, 1, graph)) {
    if (!paramsByAxisCLId.has(p.axisCLId)) paramsByAxisCLId.set(p.axisCLId, []);
    paramsByAxisCLId.get(p.axisCLId).push(p);
  }
  const rawSegs = [];
  for (const [, segs] of paramsByAxisCLId) rawSegs.push(...mergeSegments(segs, graph));

  const raw = [];
  for (const seg of rawSegs) {
    const axisCL  = getShape(graph, seg.axisCLId);
    const startCL = getShape(graph, seg.startCLId);
    const endCL   = getShape(graph, seg.endCLId);
    if (!axisCL || !startCL || !endCL) continue;

    const inward = Math.sign(seg.axisOffset) || 1;
    const letter = letterOf(seg.isVertical, seg.axisOffset);
    const dirSign = DIR_SIGN[letter];
    const lo = Math.min(startCL.value, endCL.value);
    const hi = Math.max(startCL.value, endCL.value);
    const faceValue = innerWallFaceAt(graph, axisCL, { isVertical: seg.isVertical, inward, spanLo: lo, spanHi: hi })
      ?? axisCL.effectiveValue;

    raw.push({
      letter, dirSign, isVertical: seg.isVertical, axisCL, inward, faceValue,
      lo, hi, run: hi - lo, originWorld: dirSign > 0 ? lo : hi,
      startCLId: seg.startCLId, endCLId: seg.endCLId,
    });
  }
  if (raw.length === 0) return [];

  // 外周を実際に1周する順（隅=axisCL.idの一致で次面へ辿る）。開始点はA(北)のうち最も左（lo最小）
  // ——単独のAならそのまま先頭になる（矩形部屋のI1: ['A','B','C','D']順と整合）。
  const byAxisCLId = new Map(raw.map(f => [f.axisCL.id, f]));
  const aSegs = raw.filter(f => f.letter === 'A').sort((a, b) => a.lo - b.lo);
  const start = aSegs[0] ?? raw[0];

  const chain = [];
  const seen = new Set();
  let cur = start;
  while (cur && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    const next = byAxisCLId.get(exitCLId(cur));
    if (!next || next === start) break;
    cur = next;
  }

  // ラベル付与: letterごとの出現順（=時計回りに辿った順）にB1,B2,…を振る。単独ならletterのまま。
  const totalByLetter = new Map();
  for (const f of chain) totalByLetter.set(f.letter, (totalByLetter.get(f.letter) ?? 0) + 1);
  const seenIdx = new Map();
  const labeled = chain.map(f => {
    const idx = (seenIdx.get(f.letter) ?? 0) + 1;
    seenIdx.set(f.letter, idx);
    const label = totalByLetter.get(f.letter) > 1 ? `${f.letter}${idx}` : f.letter;
    return { ...f, id: label, label };
  });

  return snapFaceEndsToCorners(labeled);
}

/**
 * face 上に乗る開口（建具・窓）を centerCoord 昇順で返す。findHostWall の規約踏襲
 * （openings/openingGeometry.js:22-35）だが Wall を経由せず face の軸情報のみで判定する。
 * wallSide===0（CL偏芯の仕上げ面合わせ等）は両側の面にマッチする。
 * @param {object} face - buildRoomFaces の1件
 * @param {object} graph
 * @returns {import('@core').Opening[]}
 */
export function openingsOnFace(face, graph) {
  return graph.openings
    .filter(o => o.isVertical === face.isVertical && o.axisCL.id === face.axisCL.id)
    .filter(o => o.wallSide === 0 || Math.sign(o.wallSide) === face.inward)
    .filter(o => o.centerCoord >= face.lo && o.centerCoord <= face.hi)
    .sort((a, b) => a.centerCoord - b.centerCoord);
}
