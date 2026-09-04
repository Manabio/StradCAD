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
import { sameAxisLine } from '../finish/kneeDropWall.js';
import { graphList } from '../graphReadScope.js';
import { SPLIT_MERGE_EPS_MM } from './elevationStyle.js';

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する（finish/*.js と同じ規約）。
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/**
 * 展開図の対象部屋。屋内・有名・feature が null または STAIR（階段）または VOID（吹抜け。WP-V1）
 * のみ採用する（STAIR_VOID・UNDEFINED・屋外は除外）。graph.rooms の登録順のまま返す。
 * STAIR_VOID（最上階の屋内階段footprintへ自動指定される描画・操作対象外の自動管理Room）は
 * 追加しない——自動管理・無名のため `r.name !== ''` で既に落ちるが、意図を明示するコメント。
 * QA修正: 部分指定（`referenceRoomIds`が非空。親の壁際セルの一部を占め`floorLevel`等を上書き
 * するRoom。`.claude/glossary.md`）は対象から除外する——部分指定は独自の展開図帯を持たず、
 * 親の帯の中で`wallAdjacentFloorSegments`による床の段差プロファイルとして表現される
 * （`elevation-model.md`「床の段差プロファイル」節）。除外しないと親と部分指定の両方に
 * 全く同じ壁面が重複して展開されてしまう。
 */
export function selectElevationRooms(graph) {
  return (graphList(graph, 'rooms') ?? []).filter(r =>
    r.kind === RoomKind.INTERIOR && r.name !== '' &&
    (r.feature == null || r.feature === RoomFeature.STAIR || r.feature === RoomFeature.VOID) &&
    !(r.referenceRoomIds?.size > 0));
}

// letter マップ（buildRoomFaces ヘッダ参照）。isVertical・axisOffset(inward)の符号だけで決まる。
// 新仕様（elevationFaceList.js の composeRoomFaces）でも段差見付け面のletter算出に使うためexport。
export function letterOf(isVertical, axisOffset) {
  if (!isVertical) return axisOffset > 0 ? 'A' : 'C';
  return axisOffset < 0 ? 'B' : 'D';
}

export const DIR_SIGN = { A: 1, B: 1, C: -1, D: -1 };

/**
 * 「軸の向き × 図のローカルx方向」から展開記号を逆引きする（`DIR_SIGN`の逆写像）。
 *
 * 展開記号A/B/C/Dは**視線の向き**（A=12時/B=3時/C=6時/D=9時）を表し、図の左→右がどちらの
 * 世界方向かで一意に決まる——だから`DIR_SIGN[letter] === face.dirSign`は面の不変条件である。
 * 階段帯は「上り口→踊り場」という歩行方向で作図順（＝ローカルx方向）が決まるため
 * （`reorientFace`）、部屋のコンパス向き由来のletterをそのまま残すとこの不変条件が破れ、
 * 実機で「9時方向を見ている図にBの記号が付く」（ユーザー実機指摘2026-08）ことになる。
 * 階段の展開記号がケースバイケースで変わるのはこの逆引きの結果であり、例外規則ではない。
 * @param {boolean} isVertical - 面（壁）が垂直軸に沿うか
 * @param {1|-1} dirSign - 図のローカルx昇順が指す世界方向の符号
 * @returns {'A'|'B'|'C'|'D'}
 */
export function letterForDirSign(isVertical, dirSign) {
  if (!isVertical) return dirSign > 0 ? 'A' : 'C';
  return dirSign > 0 ? 'B' : 'D';
}

// QA修正（項目5b根本原因）: axisCLIdごとに面をグルーピングする（単純なMap<axisCLId,Face>だと
// 後勝ちで片方が消える）。ノッチ・張り出し（アルコーブ等）で1本の壁面が開口を挟み2区間以上に
// 分かれる場合、両区間とも同じaxisCLId（壁の通り位置そのもの）を持つ——例: 主室の右壁(B)に
// 幅の狭い張り出しが付くと、張り出しを挟む2区間(B1・B2)は同じ壁通り(axisCLId)上にありながら
// 隅を共有する相手（startCLId/endCLId）がそれぞれ異なる。
function groupByAxisCLId(faces) {
  const map = new Map();
  for (const f of faces) {
    if (!map.has(f.axisCL.id)) map.set(f.axisCL.id, []);
    map.get(f.axisCL.id).push(f);
  }
  return map;
}

// axisCLId=neighborAxisCLId を軸に持つ候補群（groupByAxisCLIdの結果）から、隅を実際に共有する
// 1件を選ぶ——候補のstartCLId/endCLIdがownAxisCLId（呼び出し元の面自身の軸）と一致する候補だけが
// 正しい相手（同じ壁通り上の他区間は別の隅を指すため一致しない）。0件なら隅の相手なし
// （壁のない端部・外周の端）、2件以上一致することは室の単純な閉ループ上では起こらない
// （各隅はちょうど2面で共有されるため）。
function findCornerNeighbor(byAxisCLId, ownAxisCLId, neighborAxisCLId) {
  const candidates = byAxisCLId.get(neighborAxisCLId);
  if (!candidates) return null;
  return candidates.find(c => c.startCLId === ownAxisCLId || c.endCLId === ownAxisCLId) ?? null;
}

// 直交面の実壁が「この面の切断面（仕上げ面の平面）を室内側へ横切っている」とみなす最小
// 進入量(mm)。横切りの正例は数百mm以上・負例（壁が面の向こう側で終わる）は仕上げ面〜芯の
// 数十mm手前で止まるため、丸め誤差だけを吸収する小さい値でよい。
export const PLANE_CROSS_EPS_MM = 1;

// 隅の実壁プローブが室内側へ探る窓の奥行(mm)。perpendicularWallsOnFaceの
// PERP_MIN_PROJECTION_MM と同値——「隅で室内側へこの程度は突き出していて初めて壁として見える」
// という同じ尺度を2箇所で共有する。
const CORNER_PROBE_DEPTH_MM = 100;

/**
 * face f の端の隅（perpFaceが乗る直交CL上）に、**実際に壁材があるか**を局所プローブする。
 *
 * ユーザー実機指摘2026-08「C1のX2上に線はなく、C1からC2へ至る間にもエッジはない。比較的単純な
 * プローブに思う。判定方法をよく確認してみて」の対応。**旧実装は直交面の面全体のフラグ
 * （`perpFace.hasRealWall`＝`innerWallFaceAt`が面のスパン全域で壁を1本でも見つけたか）を隅の
 * 判定に流用していた**ため、直交面の遠い側にだけ壁がある構成では「隅に壁がある」と誤判定し、
 * 実際には何も無い隅に見えがかりエッジの縦線が描かれていた（実機の症状: 連続する外壁面が
 * C1/C2に分かれ、その継ぎ目に無いはずの縦線が出る）。
 *
 * 正しい判定は「**その隅の周りに**壁材があるか」という局所の問い——`innerWallFaceAt`へ渡す
 * スパンを、面全体ではなく**この面の仕上げ面を挟む±CORNER_PROBE_DEPTH_MMの窓**に絞るだけでよい
 * （壁の同定・inward判定は既存の`innerWallFaceAt`をそのまま使う。判定の二重管理を増やさない）。
 *
 * **窓は面の両側に取る**——「実壁が向こう側へ折れて続く角」（＝室内側へは横切らないが角の
 * エッジは見える。ユーザー明示指示で見えがかりエッジとして縦線を描く対象）を落とさないため。
 * 室内側だけの片側窓にすると、まさにその確認済みケース（Round Fの2 C2右・3 B1右・3 D1左）が
 * エッジごと消える（実際にそう実装してテストで検出した）。室内へ横切るか否かの区別は
 * この関数ではなく`perpWallCrossesFacePlane`が担う——役割を混ぜない。
 *
 * graph未指定（合成faceを使う既存の単体テスト）は従来どおり面全体のフラグへフォールバックする。
 * @param {object} f - 対象の面
 * @param {object} perpFace - 隅を共有する直交面
 * @param {object|null} graph
 * @returns {boolean}
 */
function realWallAtCorner(f, perpFace, graph) {
  const fallback = perpFace.hasRealWall ?? true;
  if (!graph?.walls || !perpFace.axisCL) return fallback;
  if (perpFace.inward !== 1 && perpFace.inward !== -1) return fallback;
  if (!Number.isFinite(f.faceValue)) return fallback;
  // 直交壁のスパン軸は f の軸方向（Cなら壁のcoord1/coord2はY・f.faceValueもY）。
  return innerWallFaceAt(graph, perpFace.axisCL, {
    isVertical: perpFace.isVertical, inward: perpFace.inward,
    spanLo: f.faceValue - CORNER_PROBE_DEPTH_MM, spanHi: f.faceValue + CORNER_PROBE_DEPTH_MM,
  }) != null;
}

/**
 * 開放スパンの内部境界の**描画x**（ローカル）。CL位置そのものではなく、
 * **その境界に立つ直交壁の「開放側の面」**を返す。
 *
 * ユーザー実機指摘2026-08（5/C2の400CL・10/D1の400CL・10/C2の800CL・10/B2の1000CL・11'/A2の
 * 1600の両側）: 開放スパンの境界の縦線が、いずれも「壁厚×1/2だけ開放側」へずれるべきだった。
 * 境界に立つ壁は中心線に対して厚みを持つため、**実際の抜け（クリアな開口）は壁の面から始まる**
 * ——CL位置で切ると壁の半厚ぶん開口を広く描いてしまう。
 *
 * 「当該壁厚・偏芯を確認し、加味する」（同指摘）ため、半壁厚の決め打ちではなく`innerWallFaceAt`で
 * **実壁の面**（`Wall.axisValue`＝偏芯込みの仕上げ面）を引く。**境界に実壁が無ければオフセットは
 * しない**——ずらす根拠になる壁厚がそこに存在しないため、CL位置がそのまま正しい境界になる
 * （半壁厚の決め打ちでフォールバックすると、壁の無い境界まで一律にずれる。実際そう実装して
 * 既存テストで検出した）。
 * 寸法・CL一点鎖線は従来どおりオフセット前の値（`spans[i].hiCLX`）を使う——描画位置と寸法位置を
 * 意図的に別に持つ既存規約（`drawnRiserX`と同じ）。
 * @param {object} face
 * @param {object} graph
 * @param {number} localX - 境界のローカルx（オフセット前）
 * @param {?string} clId - 境界のCL id（`spans[i].hiCLId`）
 * @param {1|-1} localSign - 開放側へ動かす向き（ローカルx基準。+1=大きい側）
 * @returns {number}
 */
export function drawnSpanBoundaryX(face, graph, localX, clId, localSign) {
  if (!graph?.walls || !clId) return localX;
  const cl = getShape(graph, clId);
  if (!cl || !Number.isFinite(face.faceValue) || (face.dirSign !== 1 && face.dirSign !== -1)) return localX;
  const faceValue = innerWallFaceAt(graph, cl, {
    isVertical: !face.isVertical,
    inward: localSign * face.dirSign, // 開放側の世界方向
    spanLo: face.faceValue - CORNER_PROBE_DEPTH_MM, spanHi: face.faceValue + CORNER_PROBE_DEPTH_MM,
  });
  if (faceValue == null) return localX;
  return (faceValue - face.originWorld) * face.dirSign;
}

/**
 * face.spans の各区間の**描画範囲**（ローカルx）。内部境界だけを`drawnSpanBoundaryX`でずらし、
 * 面端（先頭のlo・末尾のhi）は`snapFaceEndsToCorners`が既に直交壁の仕上げ面へ詰め済みのため
 * そのまま使う（二重にずらさない）。描画側（`buildFaceFigure`）と検証側（テスト）が同じ関数を
 * 使うための単一情報源。
 * @param {object} face
 * @param {object} graph
 * @returns {Array<{loX:number, hiX:number}>} spansと同じ長さ・同じ順
 */
export function drawnSpanRanges(face, graph) {
  const spans = face.spans ?? [];
  return spans.map((s, i) => ({
    loX: i === 0 ? s.loX : drawnSpanBoundaryX(face, graph, s.loX, spans[i - 1].hiCLId, 1),
    hiX: i === spans.length - 1 ? s.hiX : drawnSpanBoundaryX(face, graph, s.hiX, s.hiCLId, -1),
  }));
}

/**
 * 面端の直交面（perpFace）の壁が、face の切断面（faceValue の平面）を室内側へ横切って
 * いるか。横切っていれば図の端部にその壁の断面（返し）が現れる＝通常の隅。横切っていない
 * （壁が面の向こう側だけにあり、こちら側では図の端部に壁断面が現れない）端は
 * 「壁断面のない中心線」＝壁のない端部として扱う（続きがある表現＝床・天井線の延長）。
 * perpFace.lo/hi は face の奥行き方向に沿った直交面のスパン。
 * @param {{lo:number, hi:number}} perpFace
 * @param {{faceValue:number, inward:number}} face
 * @returns {boolean}
 */
export function perpWallCrossesFacePlane(perpFace, face) {
  // inward不明（幾何を持たない合成face＝既存単体テストの後方互換）は判定不能のため
  // 従来どおり「横切っている＝壁あり」へフォールバックする（hasRealWall ?? true と同じ規約）。
  if (face.inward !== 1 && face.inward !== -1) return true;
  return face.inward > 0
    ? perpFace.hi > face.faceValue + PLANE_CROSS_EPS_MM
    : perpFace.lo < face.faceValue - PLANE_CROSS_EPS_MM;
}

/**
 * 各面の端座標を、同じ直交CL上にある直交面の faceValue（壁の室内側仕上げ面）へ詰める
 * （＝仕上げ面から仕上げ面までの有効長さにする）。対応する直交面が無い辺はCL芯のまま
 * （faces 由来の元の lo/hi を保持）。
 *
 * QA修正: 閉じた部屋の面ループでは隅に直交「面」（buildRoomFaces が返す幾何セグメント）は
 * 常に存在する——「壁のない端部」（上り口・隣室への開放等）とは、隅に直交面が無いことではなく
 * その直交面に**実壁（graph.walls）が無い**ことを指す（階段の上り口辺・壁生成がスキップされた
 * 辺では、面自体は存在してもfaceValueがinnerWallFaceAtのnullフォールバックでCL芯になる。
 * raw面のhasRealWallフィールド。buildRoomFaces参照）。
 * さらに（ユーザー明示指示2026-08）実壁があっても、その壁がこの面の切断面を室内側へ
 * 横切っていない（perpWallCrossesFacePlane=false。壁が面の向こう側だけにある——例:
 * L字部屋の入隅の先や、上端短縮されたCLの壁が視点側の帯に存在しない場合）端は、図の端部に
 * 壁断面が現れないため壁のない端部として扱い、端座標も直交面へ詰めずCL芯のまま残す
 * （「図の端部が壁断面のない中心線の場合は、図の外側まで床と天井断面をのばす」）。
 * 判定結果は hasWallAtLocal0/hasWallAtLocalRun として面のローカル座標系（0/run）向けに公開する。
 * @param {object[]} faces - letter/dirSign/faceValue/hasRealWall/lo/hi/startCLId/endCLId/axisCL を持つ面リスト
 * @returns {object[]} lo/hi/run/originWorld を詰め直し、hasWallAtLocal0/hasWallAtLocalRunを
 *   追加した新しい配列（他フィールドは同一参照）
 */
export function snapFaceEndsToCorners(faces, graph = null) {
  const byAxisCLId = groupByAxisCLId(faces);

  return faces.map(f => {
    const startFace = findCornerNeighbor(byAxisCLId, f.axisCL.id, f.startCLId);
    const endFace   = findCornerNeighbor(byAxisCLId, f.axisCL.id, f.endCLId);
    // 「壁あり」＝対応する直交面が存在し、**その隅に実壁があり**（realWallAtCorner）、
    // かつその壁がこの面の切断面を室内側へ横切っている（perpWallCrossesFacePlane）。
    const realAtLo = !!startFace && realWallAtCorner(f, startFace, graph);
    const realAtHi = !!endFace   && realWallAtCorner(f, endFace, graph);
    const hasWallAtLo = realAtLo && perpWallCrossesFacePlane(startFace, f);
    const hasWallAtHi = realAtHi && perpWallCrossesFacePlane(endFace, f);
    // 見えがかりエッジ＝実壁はあるが切断面を横切らない端（凹み角）。壁断面は描かないが、
    // 壁が折れて向こうへ続く角のエッジ自体は見えるため、縦線（中線）を描く対象として公開する
    // （ユーザー明示指示2026-08。直交面や実壁自体が無い端＝階段上り口等は従来どおり縦線なし）。
    const edgeAtLo = realAtLo && !hasWallAtLo;
    const edgeAtHi = realAtHi && !hasWallAtHi;
    // 端座標: 壁あり・見えがかりエッジとも直交面のfaceValueへ詰める（＝この面の壁の実端。
    // 凹み角では相手の壁面に突き当たる位置）。エッジ縦線・延長の起点は壁の実端に立てる
    // （ユーザー確認2026-08: 中心線位置ではなく壁の実端。これにより隣接面の隅共有の
    // 不変条件も従来どおり保たれる）。直交面や実壁自体が無い端のみCL芯のまま。
    const lo = (hasWallAtLo || edgeAtLo) ? startFace.faceValue : f.lo;
    const hi = (hasWallAtHi || edgeAtHi) ? endFace.faceValue   : f.hi;
    // startCLIdは常に世界座標loを、endCLIdは常に世界座標hiを決める（上のlo/hi代入と対）。
    // ローカル座標0/runへの対応はdirSignの符号で反転する（dirSign>0: lo→0・hi→run、
    // dirSign<0: hi→0・lo→run。originWorldの定義=`dirSign>0?lo:hi`と表裏の関係）。
    return {
      ...f, lo, hi, run: hi - lo, originWorld: f.dirSign > 0 ? lo : hi,
      hasWallAtLocal0:   f.dirSign > 0 ? hasWallAtLo : hasWallAtHi,
      hasWallAtLocalRun: f.dirSign > 0 ? hasWallAtHi : hasWallAtLo,
      edgeAtLocal0:      f.dirSign > 0 ? edgeAtLo : edgeAtHi,
      edgeAtLocalRun:    f.dirSign > 0 ? edgeAtHi : edgeAtLo,
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
  // QA修正（項目5b根本原因）: 単純なMap<axisCLId,Face>だと、ノッチ・張り出しで同じ壁通り
  // (axisCLId)が2区間以上に分かれる場合に後勝ちで片方が消え、その面がchainに一切現れず
  // 「抽出漏れ」になる（張り出し(アルコーブ)付き部屋で確認・再現。elevationFaces.test.js参照）。
  // groupByAxisCLId+findCornerNeighborで「同じ壁通りの複数区間」から隅を実際に共有する
  // 1件だけを選ぶ。
  const byAxisCLId = groupByAxisCLId(raw);
  const aSegs = raw.filter(f => f.letter === 'A').sort((a, b) => a.lo - b.lo);
  const start = aSegs[0] ?? raw[0];

  const chain = [];
  const seen = new Set();
  let cur = start;
  while (cur && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    const next = findCornerNeighbor(byAxisCLId, cur.axisCL.id, exitCLId(cur));
    if (!next || next === start) break;
    cur = next;
  }

  // ラベル付与: letterごとの出現順（=時計回りに辿った順）にB1,B2,…を振る（labelFaces。単独ならletterのまま）。
  return snapFaceEndsToCorners(labelFaces(chain), graph);
}

/**
 * letterごとの出現順（配列順）にラベル(id/label)を振り直す（新仕様。elevationFaceList.js の
 * composeRoomFaces が「袖壁分割→段差見付け面の挿入」で面配列を組み替えた後に呼ぶ）。
 * buildRoomFaces内部で使っていた採番ロジックをそのまま抽出したもの——チェーンを辿る処理とは
 * 独立しており、既に並び終わった配列を受け取ってlabel/idを付け替えるだけの純関数。
 * 単独ならletterのまま、複数あればletter+出現順(B1,B2,…)。
 *
 * **数えるのは面ではなくパネル**（規則B。elevationFaceList.jsのmergeSteppedFacesIntoPanel）。
 * 同じ `panelId` を持つ面は1枚の壁を段差で割っただけなので、まとめて1つと数え、同じラベルを
 * 与える（実機「5」の南面はC1+C2ではなく1枚の「C」）。`panelId` を持たない面は1面＝1パネル
 * ＝現行と完全に同じ採番になる（後方互換）。
 * @param {object[]} faces - letter を持つ面配列（chain順）
 * @returns {object[]} id/label を付け替えた新しい配列（他フィールドは同一参照）
 */
export function labelFaces(faces) {
  const panelKey = (f, i) => (f.panelId != null ? `p:${f.panelId}` : `f:${i}`);
  const totalByLetter = new Map();
  const counted = new Set();
  faces.forEach((f, i) => {
    const key = panelKey(f, i);
    if (counted.has(key)) return;
    counted.add(key);
    totalByLetter.set(f.letter, (totalByLetter.get(f.letter) ?? 0) + 1);
  });
  const seenIdx = new Map();
  const idxByPanel = new Map();
  return faces.map((f, i) => {
    const key = panelKey(f, i);
    let idx = idxByPanel.get(key);
    if (idx == null) {
      idx = (seenIdx.get(f.letter) ?? 0) + 1;
      seenIdx.set(f.letter, idx);
      idxByPanel.set(key, idx);
    }
    const label = totalByLetter.get(f.letter) > 1 ? `${f.letter}${idx}` : f.letter;
    return { ...f, id: label, label };
  });
}

// perpendicularWallsOnFace の許容差(mm)。新仕様「袖壁・腰壁の面分割」「ROW1寸法のCL分割」で使う。
const PERP_TOUCH_TOL_MM = 150;      // 直交壁が到達したとみなす許容差（TOUCH_TOL）
const PERP_MIN_PROJECTION_MM = 100; // 室内側への最小突出量（MIN_PROJECTION_MM）

/**
 * face に直交し、face の内側（face.lo〜face.hiの内側にaxisCLを持つ）へ突き出す壁の一覧
 * （新仕様「袖壁・腰壁の面分割」「ROW1寸法のCL分割」の共通判定。純関数）。
 * side='near': 面の仕上げ面(faceValue)へ到達し室内側へMIN_PROJECTION_MM以上突出する壁
 *   （＝袖壁・腰壁として面を分割する対象。仕様2）。
 * side='far': 面の壁中心線(axisCL.effectiveValue)へ到達し室内側へ突出する壁
 *   （＝ROW1寸法のCL分割点として拾う対象。仕様1のS2。faceValueより緩い＝壁厚を貫通していなくても拾う）。
 * 外壁（isExteriorWall）・自室外周生成壁（isRoomWall）・同軸壁（w.axisCL.id===face.axisCL.id）は除外する。
 * @param {object} face - buildRoomFaces/composeRoomFaces の1件
 * @param {object} graph
 * @param {'near'|'far'} side
 * @returns {import('@core').Wall[]}
 */
export function perpendicularWallsOnFace(face, graph, side) {
  const av = face.axisCL.effectiveValue;
  const fv = face.faceValue;
  const inward = face.inward;
  // graph.walls未定義（buildFaceFigure等の単体テストが使う最小限フェイクgraph）は「壁なし」として
  // 空配列を返す（従来のctx.gridCLs ?? []等と同じ規約。real graphでは常に配列が返る）。
  return (graphList(graph, 'walls') ?? []).filter(w => {
    if (w.isVertical === face.isVertical) return false; // 直交のみ
    if (w.isExteriorWall) return false;
    // 外周生成壁（isRoomWall）の扱いはsideで分ける。
    // near（袖壁＝面を分割する自立壁）では除外する——部屋の外周生成壁は面自身とその隅を作る壁で
    // あり、袖壁ではない。
    // far（寸法の分割点。面の**向こう側**に立つ壁）では**除外しない**——向こう側の壁は定義上
    // どこかの部屋の外周生成壁であり、一律に除外すると分割点が1本も取れない（実機データでは
    // 全ての壁がisRoomWall=trueで、この源が常に空だった。ユーザー実機指摘2026-08その9:
    // 「22」Bは向こう側の3500の壁で3500+3500・「22」C2は向こう側の2600の壁で2600+2400が正解）。
    // 自室の壁が誤って混ざらないのは下のreach/project判定が担う——自室の壁は面の位置で終わり、
    // 向こう側へMIN_PROJECTION_MM以上突き出さないため落ちる。
    if (side === 'near' && w.isRoomWall) return false;
    if (w.axisCL.id === face.axisCL.id) return false; // 同軸壁除外
    const wv = w.axisCL.effectiveValue;
    if (!(wv > face.lo && wv < face.hi)) return false; // face.lo/hiの内側のみ
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (side === 'near') {
      const reach   = inward > 0 ? wLo <= fv + PERP_TOUCH_TOL_MM      : wHi >= fv - PERP_TOUCH_TOL_MM;
      const project = inward > 0 ? wHi >= fv + PERP_MIN_PROJECTION_MM : wLo <= fv - PERP_MIN_PROJECTION_MM;
      return reach && project;
    }
    const reach   = inward > 0 ? wHi >= av - PERP_TOUCH_TOL_MM      : wLo <= av + PERP_TOUCH_TOL_MM;
    const project = inward > 0 ? wLo <= av - PERP_MIN_PROJECTION_MM : wHi >= av + PERP_MIN_PROJECTION_MM;
    return reach && project;
  });
}

// wallCoverageGapsOnFace: 壁のない端部(hasWallAtLocal0/Run===false)に接する隙間を、
// 「隅の取り合いのCL-仕上げ面の食い違いによる見かけの隙間」とみなして無視する幅の上限(mm)。
// PERP_TOUCH_TOL_MM・finish/kneeDropWall.js の SPAN_OVERLAP_EPS と同じ、隅の取り合いの
// 許容差を流用する（食い違いの実測は概ね半壁厚=57.5mm程度で、この値を大きく超える幅は
// 隅の取り合いではなく階段口・大開口等の実在する欠落）。
const END_ARTIFACT_TOL_MM = 150;

/**
 * その面の軸と**同じ通り**（sameAxisLine。idではなく向き＋座標一致——finish/kneeDropWall.js
 * の規約）にある実壁（graph.walls）の被覆から、[0, run]の**壁の実体が無いローカルx区間**を返す
 * （ユーザー実機指摘2026-09「22」2階A1・階段の下り口: face.spansは開放スパン解析（部屋の連続性）
 * 由来で、'wall'区間の内側に「壁が生成されていない区間」（階段の下り口）があっても'wall'のまま
 * ——巾木・壁2段書きの述語(elevationFigure.jsのwallLessRunsOnFace)には実壁の被覆という
 * 第3の源が要る。階段帯のsequence経路——elevationStair.jsがcomposedFaces経由で
 * hasRealWall=falseを含む面を流す——でも同様に壁の欠落を検出する必要があり、この関数は
 * 単体テストの最小graphだけでなく本番のその経路でも保険として働く）。
 * 壁の偏芯側は問わない（同じ通りにどちら向きの壁でもあれば壁あり）。壁はcoord1/coord2
 * （壁の長さ方向の世界座標。core/wall.js）をローカルxへ写像して和集合を取る——同室内の
 * 連続した壁は生成時に`mergeSegments`（finish/wallGeneration.js）で1本のWallへ結合される
 * ため通常は面の全幅が1本の被覆になり、複数のWallに分かれるのは(a)隅で隣室側の壁が
 * 仕上げ面まで食い込んで**重なる**場合（例: 57.5mm重複。この重なりそのものが連続の根拠で
 * あり、SPLIT_MERGE_EPS_MM(=1mm)という小さな許容差が57.5mmの隔たりを埋めているわけではない
 * ——重なっている2区間はどんな許容差でも結合される）と、(b)階段口のように**実際に壁が
 * 途切れている**場合の2通りで、後者だけがここで隙間として報告される。
 * graph.walls が無い（単体テストの最小graph）場合は空配列を返す（既存呼び出しの出力不変）。
 * 同じ通りに一致する壁が1本も見つからない場合も**空配列**を返す（「情報が無い」＝従来どおり
 * 全面を壁ありと見なすフォールバック）。これは単体テスト（他の直交壁だけを積んだ最小graphで、
 * face自身の壁が定義されていないケースを「壁が皆無」と誤認して面全体を巾木無しにしないため）
 * だけでなく、**本番の階段帯sequence経路（`elevationStair.js`の`hasRealWall=false`の面）でも
 * 保険として働く**——そうした面はそもそもこの軸に実壁が1本も無いことが前提のため、隙間扱いに
 * せず「情報が無い」まま呼び出し側（`kind==='step'`の別描画分岐等）に委ねる。部分的に欠けている
 * 区間（同じ通りに壁が1本以上あるが、その被覆に穴がある場合）だけを隙間として報告する用途に
 * 限定する。
 * **面の端(0/run)に接する側の隙間は、その端が壁のある端(`hasWallAtLocal0`/`hasWallAtLocalRun`
 * ===true。省略時も既定true)なら報告し、壁のない端部(===false)では幅が`END_ARTIFACT_TOL_MM`
 * 以下なら報告しない**（幅がそれを超える場合は壁のない端部でも報告する）——壁のない
 * 端部では面の境界(`face.lo/hi`由来のローカル0/run)が壁中心線(CL)のまま残り、実壁の仕上げ面は
 * そこから半壁厚ぶん内側から始まるため、幅わずか（概ね57.5mm）の**見かけの隙間**が必ず生じる。
 * この見かけの隙間は、巾木を面の端(0/run)でクランプする既存規則
 * （`elevationFigure.js`の`buildFaceFigure`内`Math.max(drawnX0,0)`/`Math.min(drawnXRun,run)`）が
 * 既に面の端で止めているため、ここでも報告すると同じ抑制を二重に行うだけで意味を持たない。
 * 一方、階段口・大開口のように幅が`END_ARTIFACT_TOL_MM`を超える隙間は、たとえ壁のない端部に
 * 接していても実在する欠落なので報告する。
 * @param {object} face - buildRoomFaces/composeRoomFacesの1件（axisCL/isVertical/originWorld/dirSign/run/
 *   hasWallAtLocal0/hasWallAtLocalRun。両方省略時=true=壁ありの端 扱い。既存の規約と同じ）
 * @param {object} graph
 * @returns {Array<{lo:number,hi:number}>} 昇順・結合済み（[0,run]内にクリップ済み）
 */
export function wallCoverageGapsOnFace(face, graph) {
  const walls = graphList(graph, 'walls');
  if (!Array.isArray(walls)) return [];
  const run = face.run;
  const covered = walls
    .filter(w => w.isVertical === face.isVertical && sameAxisLine(w.axisCL, face.axisCL))
    .map(w => {
      const a = (w.coord1 - face.originWorld) * face.dirSign;
      const b = (w.coord2 - face.originWorld) * face.dirSign;
      return { lo: Math.max(0, Math.min(a, b)), hi: Math.min(run, Math.max(a, b)) };
    })
    .filter(r => r.hi > r.lo)
    .sort((a, b) => a.lo - b.lo);
  if (covered.length === 0) return [];
  const merged = [];
  for (const r of covered) {
    const last = merged[merged.length - 1];
    if (last && r.lo <= last.hi + SPLIT_MERGE_EPS_MM) last.hi = Math.max(last.hi, r.hi);
    else merged.push({ ...r });
  }
  const hasWallAtLocal0   = face.hasWallAtLocal0   ?? true;
  const hasWallAtLocalRun = face.hasWallAtLocalRun ?? true;
  const gaps = [];
  let cursor = 0;
  merged.forEach((r, i) => {
    if (r.lo > cursor + SPLIT_MERGE_EPS_MM) {
      const hi = Math.min(r.lo, run);
      const isEndArtifact = i === 0 && !hasWallAtLocal0 && (hi - cursor) <= END_ARTIFACT_TOL_MM;
      if (!isEndArtifact) gaps.push({ lo: cursor, hi });
    }
    cursor = Math.max(cursor, r.hi);
  });
  if (cursor < run - SPLIT_MERGE_EPS_MM) {
    const isEndArtifact = !hasWallAtLocalRun && (run - cursor) <= END_ARTIFACT_TOL_MM;
    if (!isEndArtifact) gaps.push({ lo: cursor, hi: run });
  }
  return gaps.filter(g => g.hi > g.lo + SPLIT_MERGE_EPS_MM);
}

// perpFaceAt の隅一致判定許容差(mm)。elevationStepFace.js（見付け面の隅スナップ・挿入位置探索）・
// elevationOpenSpan.js（開放スパンの端の直交壁面スナップ）が共有する。
export const CORNER_TOL_MM = 200;

/**
 * wallFaces（直交面の候補集合）のうち、指定した固定軸位置(targetAxisValue)がスパン内に収まり、
 * かつ位置(pos)がCORNER_TOL_MM以内で最も近いものを返す（旧elevationStepFace.jsの
 * nearestPerpFaceAtをexport化・汎用化。QA修正: 各消費者で個別実装されていたロジックを統合）。
 * 直交面fはisVertical=falseなら自身の位置(axisCL)がY・スパン(lo/hi)がXという具合に、
 * targetIsVertical側とは軸が入れ替わる——「targetAxisValueがfのスパン内か」（到達判定）と
 * 「pos（target自身の伸びる方向の座標）とfの位置(axisCL)の近さ」（どちらが最寄りか）は
 * 別の軸同士の比較になる点に注意。
 * @param {object[]} wallFaces - buildRoomFaces/composeRoomFacesの面配列（隅探索用）
 * @param {boolean} targetIsVertical - 探している対象自身のisVertical（直交面はこれと異なる）
 * @param {number} targetAxisValue - 対象の固定軸位置（fのスパンに収まるか判定する値）
 * @param {number} pos - 対象の伸びる方向の座標（fの位置との近さを測る値）
 * @returns {object|null}
 */
export function perpFaceAt(wallFaces, targetIsVertical, targetAxisValue, pos) {
  let best = null, bestDist = Infinity;
  for (const f of wallFaces) {
    if (f.kind === 'step') continue;
    if (f.isVertical === targetIsVertical) continue; // 直交面のみ
    if (!(targetAxisValue >= f.lo - CORNER_TOL_MM && targetAxisValue <= f.hi + CORNER_TOL_MM)) continue;
    const dist = Math.abs(f.axisCL.effectiveValue - pos);
    // 到達判定（上のif）だけではdistに上限が無く、真の隅から遠く離れた直交面でも「その時点で
    // いちばん近い」というだけで採用してしまう（例: 部屋を貫通する上下の壁面は、targetAxisValueさえ
    // 範囲内なら室内のどの位置からも「候補」に入ってしまう）。CORNER_TOL_MM以内でなければ
    // 候補にしない——真に隅を共有する直交面が無ければ呼び出し側はフォールバック値を使うべき。
    if (dist > CORNER_TOL_MM) continue;
    if (dist < bestDist) { bestDist = dist; best = f; }
  }
  return best;
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
 * face 上に乗る開口（建具・窓）を centerCoord 昇順で返す。Wall を経由せず face の
 * 軸情報のみで判定する。1つの開口は物理的にその場所の壁すべてを貫通するため、
 * wallSide（配置時にどちら側の壁をホストにしたか）では絞らない——共有壁の建具は
 * 両側の部屋の展開図に出る（findOpeningsOnWall——openings/openingGeometry.js——と
 * 同じ考え方。旧実装は wallSide の符号一致を要求しており、反対側の部屋の展開図に
 * 建具が一切描かれなかった）。裏側から見る面での姿図の左右反転は描画側が担う
 * （elevationFigure.js: 姿図は世界座標昇順が図のx昇順という正準向きのため、
 * dirSign<0 の面では左右反転して置く）。
 * @param {object} face - buildRoomFaces の1件
 * @param {object} graph
 * @returns {import('@core').Opening[]}
 */
export function openingsOnFace(face, graph) {
  return (graphList(graph, 'openings') ?? [])
    .filter(o => o.isVertical === face.isVertical && o.axisCL.id === face.axisCL.id)
    .filter(o => o.centerCoord >= face.lo && o.centerCoord <= face.hi)
    .sort((a, b) => a.centerCoord - b.centerCoord);
}
