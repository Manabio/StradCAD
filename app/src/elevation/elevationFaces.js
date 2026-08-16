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
 *
 * QA修正: 閉じた部屋の面ループでは隅に直交「面」（buildRoomFaces が返す幾何セグメント）は
 * 常に存在する——「壁のない端部」（上り口・隣室への開放等）とは、隅に直交面が無いことではなく
 * その直交面に**実壁（graph.walls）が無い**ことを指す（階段の上り口辺・壁生成がスキップされた
 * 辺では、面自体は存在してもfaceValueがinnerWallFaceAtのnullフォールバックでCL芯になる。
 * raw面のhasRealWallフィールド。buildRoomFaces参照）。そのため対応関係の判定は「直交面が存在し
 * かつその直交面がhasRealWall」に変更した——hasWallAtLocal0/hasWallAtLocalRunとして面のローカル
 * 座標系（0/run）向けに公開する。
 * @param {object[]} faces - letter/dirSign/faceValue/hasRealWall/lo/hi/startCLId/endCLId/axisCL を持つ面リスト
 * @returns {object[]} lo/hi/run/originWorld を詰め直し、hasWallAtLocal0/hasWallAtLocalRunを
 *   追加した新しい配列（他フィールドは同一参照）
 */
export function snapFaceEndsToCorners(faces) {
  const byAxisCLId = new Map();
  for (const f of faces) byAxisCLId.set(f.axisCL.id, f);

  return faces.map(f => {
    const startFace = byAxisCLId.get(f.startCLId);
    const endFace   = byAxisCLId.get(f.endCLId);
    const lo = startFace ? startFace.faceValue : f.lo;
    const hi = endFace   ? endFace.faceValue   : f.hi;
    // startCLIdは常に世界座標loを、endCLIdは常に世界座標hiを決める（上のlo/hi代入と対）。
    // ローカル座標0/runへの対応はdirSignの符号で反転する（dirSign>0: lo→0・hi→run、
    // dirSign<0: hi→0・lo→run。originWorldの定義=`dirSign>0?lo:hi`と表裏の関係）。
    // 「壁あり」＝対応する直交面が存在し、かつその面に実壁がある（hasRealWall。未設定なら
    // trueへフォールバック——合成faceを使う既存の単体テスト後方互換のため）。
    const hasWallAtLo = !!startFace && (startFace.hasRealWall ?? true);
    const hasWallAtHi = !!endFace   && (endFace.hasRealWall   ?? true);
    return {
      ...f, lo, hi, run: hi - lo, originWorld: f.dirSign > 0 ? lo : hi,
      hasWallAtLocal0:   f.dirSign > 0 ? hasWallAtLo : hasWallAtHi,
      hasWallAtLocalRun: f.dirSign > 0 ? hasWallAtHi : hasWallAtLo,
    };
  });
}

// 面から見て「次の面」へつながる隅のCL id（dirSign>0はhi側=endCLId、dirSign<0はlo側=startCLId。
// snapFaceEndsToCornersの対応関係と表裏の同じ規則）。
function exitCLId(f) { return f.dirSign > 0 ? f.endCLId : f.startCLId; }

/**
 * 隣接面ギャップ算出用: この面の「壁のない端部の延長」ぶんの左右オフセット(mm)（QA G2）。
 * buildFaceFigureは面端に対応する直交壁が無ければ（hasWallAtLocal0/hasWallAtLocalRunがfalse）
 * 床線・天井線をwallLessExtendMmぶん図の外側へ延長する（項目1）。buildRoomBand/buildStairBandは
 * 隣接面との実間隔がgapModelMmを下回らないよう、xCursor・prevRightExtentの算出にこの延長ぶんを
 * 加味する必要がある——本関数はその加味すべきオフセットだけを返す純関数（面自体もctxも
 * 変更しない）。フィールドが無ければtrue（壁あり）扱いにフォールバックする
 * （buildFaceFigureの`face.hasWallAtLocal0 ?? true`と同じ規約）。
 * @param {{hasWallAtLocal0?:boolean, hasWallAtLocalRun?:boolean}} face
 * @param {number} wallLessExtendMm
 * @returns {{leftExtendMm:number, rightExtendMm:number}}
 */
export function faceWallLessExtents(face, wallLessExtendMm) {
  return {
    leftExtendMm:  (face.hasWallAtLocal0   ?? true) ? 0 : wallLessExtendMm,
    rightExtendMm: (face.hasWallAtLocalRun ?? true) ? 0 : wallLessExtendMm,
  };
}

/**
 * 部屋 → 壁面（A/B/C/D。L字は同letter複数面へ分割。ラベルはB1/B2方式）のリスト。
 * 返り値は実際の外周を時計回りに1周した順（L字で letter が interleave する場合も
 * 隣接要素が世界座標で隅を共有する＝buildRoomFaces の不変条件）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {Array<{id:string, label:string, letter:string, isVertical:boolean, axisCL:object,
 *   inward:number, faceValue:number, hasRealWall:boolean, lo:number, hi:number, run:number,
 *   dirSign:number, originWorld:number, startCLId:string, endCLId:string,
 *   hasWallAtLocal0:boolean, hasWallAtLocalRun:boolean}>} hasRealWallはこの面自身の軸区間に
 *   実壁（graph.walls）があるか（無ければfaceValueはCL芯へフォールバック——階段の上り口辺等、
 *   generateRoomWallsFromOutlineがstairOpenings指定で壁生成をスキップした辺はfalseになる）。
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
    const innerFace = innerWallFaceAt(graph, axisCL, { isVertical: seg.isVertical, inward, spanLo: lo, spanHi: hi });
    // QA修正: innerWallFaceAtがnull（この軸区間に実壁=graph.wallsが無い）でCL芯へ
    // フォールバックしたかをhasRealWallとして記録する（wallFaces.jsのfaceRectのhasWallと
    // 同じ考え方。stairOpenings指定でgenerateRoomWallsFromOutlineが壁生成をスキップした辺は
    // ここが常にfalseになる）。snapFaceEndsToCornersがhasWallAtLocal0/hasWallAtLocalRunの
    // 判定に使う。
    const hasRealWall = innerFace != null;
    const faceValue = innerFace ?? axisCL.effectiveValue;

    raw.push({
      letter, dirSign, isVertical: seg.isVertical, axisCL, inward, faceValue, hasRealWall,
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
 * face の両端を挟む「壁中心線（CL）」のローカルx座標を返す。face.lo/hi（snapFaceEndsToCorners
 * 済みの壁仕上げ面位置）とは別に、face.startCLId/endCLId が指す実際のCL（壁厚のぶんだけ
 * face.lo/hiより外側にある）のローカル位置を求める——ユーザー仕様「面は両端の壁中心線で
 * 挟まれる」の描画・帯レイアウト（面間ギャップの起点）の両方で使う単一情報源。
 * 該当CLが解決できない場合はface.lo/hi（0/face.run）へフォールバックする。
 * @param {object} face - buildRoomFaces の1件
 * @param {object} graph
 * @returns {{lo:number, hi:number}} ローカルx（loが小さい方。dirSignの向きに関わらず正規化する）
 */
export function faceBoundaryLocalX(face, graph) {
  const startCL = getShape(graph, face.startCLId);
  const endCL   = getShape(graph, face.endCLId);
  const a = startCL ? (startCL.effectiveValue - face.originWorld) * face.dirSign : 0;
  const b = endCL   ? (endCL.effectiveValue   - face.originWorld) * face.dirSign : face.run;
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
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
