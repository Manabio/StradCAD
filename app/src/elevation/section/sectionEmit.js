/**
 * 2.5D断面エンジン: emitColumns / emitOpenGapMarks（線種テーブル・アキX連結・最終降格。WP-E2）。
 * 設計意図はarchitect承認済みの実装指示書§5.6参照。WP-E5bでelevationStairSequence.js
 * （直接。stairPrimitivesForCut内のemitLine経由でも）から呼ばれるようになった。
 *
 * §5.6「線種テーブル」の唯一の情報源。破線は必ずlineプリミティブで出す
 * （レンダラのpolyline分岐はdash非対応。.claude/elevation-model.md）。
 */
import {
  GAP_LABEL_WIDTH_PX,
  ElevationLineRole, weightForRole, GAP_EPS_MM as GAP_EPS, kneeCapBottomMm, KNEE_CAP_FACE_MM,
} from '../elevationStyle.js';
import { zToY, cutDrawRange, localXOf } from './sectionTypes.js';

/**
 * §5.6最終フィルタの唯一の適用箇所（emitLine(x1,z1,x2,z2,role)の1箇所だけで適用する、という
 * 設計方針どおり）。線分の両端がともに「baseFloorZより下」または「天井断面より上」（向こう側）
 * なら、role・dashに関わらずDETAIL+dash:'dashed'へ降格する。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} x1
 * @param {number} z1
 * @param {number} x2
 * @param {number} z2
 * @param {string} role - ElevationLineRoleの値
 * @param {{dash?:string, ceilZ?:number, neverDowngrade?:boolean}} [opts] - ceilZ未指定は
 *   cut.zRange.hiZへフォールバック（§5.6「天井断面」＝この列で見えている天井——通常はzRange
 *   上端と一致するため、これを既定にする）。neverDowngrade:true（実機フィードバック第3弾C。
 *   リード裁定で契約変更を承認済み）は本関数のbeyond/forceDash判定を丸ごと無効化し、
 *   渡されたrole・dashをそのまま使う——CUT断面（ささら12×300矩形・踊り場床CUT線・踊り場桁断面）
 *   はbaseFloorZより下でも太線実線のまま、ささらの見えがかり帯（DETAIL）は同じくbaseFloorZより
 *   下でも細線実線のまま、という「降格が残るのは踏面梯子(正面視)と壁断面の見えがかりだけ」という
 *   線種裁定を呼び出し側（sectionStair.js）から明示的に選択できるようにするフラグ
 *   （既定false＝既存呼び出しは無変更）。
 * @returns {object} lineプリミティブ（y=zToY(z)変換済み）
 */
export function emitLine(cut, x1, z1, x2, z2, role, opts = {}) {
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const ceilZ = opts.ceilZ ?? cut.zRange?.hiZ ?? Infinity;
  // 水平線（z1===z2。床線・天井線・段の踏面線等の大半）は「ちょうどbaseFloorZ／ceilZに触れる」
  // だけでは向こう側と判定しない（strict <・>）——通常の床線(z=baseFloorZそのもの)を誤って
  // 降格しないため（WP-E5b回帰: 元は両端の緩い判定(<=)にしていたところ、床z=baseFloorZの
  // 通常の水平線まで「向こう側」扱いされてしまった）。垂直線・斜め線（z1!==z2）は、
  // sectionProbe.jsがcut.baseFloorZをzBreaksに割り込ませるため片端がbaseFloorZちょうどに
  // 一致するのが通常のケースになる——「ちょうど境界」を含めて向こう側とみなす（Math.max/minの
  // 緩い判定）。水平線側で「band全体がbaseFloorZ以下」を降格させたい場合はopts.forceDashで
  // 明示する（emitColumns参照）。
  const isDegenerate = Math.abs(z1 - z2) < GAP_EPS;
  const beyond = isDegenerate
    ? (z1 < baseFloorZ - GAP_EPS || z1 > ceilZ + GAP_EPS)
    : (Math.max(z1, z2) <= baseFloorZ + GAP_EPS || Math.min(z1, z2) >= ceilZ - GAP_EPS);
  const forced = opts.forceDash === true;
  const downgrade = !opts.neverDowngrade && (beyond || forced);
  const finalRole = downgrade ? ElevationLineRole.DETAIL : role;
  const finalDash = downgrade ? 'dashed' : (opts.dash ?? undefined);
  const prim = { type: 'line', x1, y1: zToY(z1), x2, y2: zToY(z2), weight: weightForRole(finalRole) };
  if (finalDash) prim.dash = finalDash;
  return prim;
}

// band全体がbaseFloorZ以下／ceilZ以上（水平な上端・下端エッジが「ちょうど境界に触れるだけ」
// でも降格させたい場合の判定。emitLineのopts.forceDashに渡す）。
function bandFullyBeyond(cut, band, ceilZ) {
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const top = ceilZ ?? cut.zRange?.hiZ ?? Infinity;
  return band.z1 <= baseFloorZ + GAP_EPS || band.z0 >= top - GAP_EPS;
}

// z区間が重なるか（隣接列の同一kind判定・アキ連結成分判定の共通ヘルパ）。
function overlapsZ(a, b) {
  return a.z0 < b.z1 - GAP_EPS && a.z1 > b.z0 + GAP_EPS;
}

// col（SectionColumn|null）から、[z0,z1]と重なる指定kindのband（無ければnull）を返す。
function matchingBand(col, z0, z1, kind) {
  if (!col) return null;
  return col.bands.find(b => b.kind === kind && overlapsZ(b, { z0, z1 })) ?? null;
}

// 2つの帯が「同じ壁面」を見ているか。壁オブジェクトは通り芯位置で分割されるため参照一致では
// 見分けられず、軸CL（同一graph内の同一オブジェクト）と材の面位置で比較する。層が違えば
// graphも違うため軸CLが一致せず、自動的にfalseになる。
function sameWallFace(a, b) {
  return !!a.wall && !!b.wall && a.wall.axisCL === b.wall.axisCL
    && Math.abs(a.wall.axisValue - b.wall.axisValue) < GAP_EPS;
}

// z区間の配列から1つの帯のz範囲を引く（uncoveredZRangesの内部ヘルパ）。
function subtractZ(ranges, nb) {
  const rest = [];
  for (const r of ranges) {
    if (!overlapsZ(nb, r)) { rest.push(r); continue; }
    if (nb.z0 > r.z0 + GAP_EPS) rest.push({ z0: r.z0, z1: nb.z0 });
    if (nb.z1 < r.z1 - GAP_EPS) rest.push({ z0: nb.z1, z1: r.z1 });
  }
  return rest;
}

/**
 * band の [z0,z1] のうち、隣接列 col で**同じ壁面が続いていない**z区間（＝側縁の縦線を描くべき
 * 範囲）を返す。col が null（探査範囲外）なら全区間を返す。
 *
 * 「続いていない（＝縦線を描く）」のは、隣接列の壁帯が **同じ層(layerRole)で距離(distMm)だけが
 * 違う**場合＝1枚の面が折れた凹みで側面が見えるときだけ。層が変わっただけ（見えている壁が
 * 別階のものへ入れ替わった）のは連続面の折れ角ではないので描かない（ユーザー実機指摘2026-08
 * 「6」D。実機症状: 左CL上のz3800..5400に縦線が出ていた）。
 *
 * 旧実装は `matchingBand`（重なる帯を1つ見つけたら連続とみなす）でband全体を一括判定していたため、
 * **隣接列の壁が途中までしか無い**ケースで側縁が丸ごと消えていた（ユーザー実機指摘2026-08その17
 * 「「6」D2: 2階X2通りの壁を見ているので、3500左CLの2階に壁エッジ」——手前列は上が吹抜けで
 * 壁がz0..5400まで続くのに対し隣接列は1F天井までの0..2400しか無く、その差分2400..5400が
 * 壁面の実際の終端であるにもかかわらず縦線が出ていなかった）。
 * @param {object|null} col
 * @param {object} band
 * @returns {{z0:number,z1:number}[]}
 */
function uncoveredZRanges(col, band) {
  if (!col) return [{ z0: band.z0, z1: band.z1 }];
  let ranges = [{ z0: band.z0, z1: band.z1 }];
  for (const nb of col.bands) {
    // 覆う（＝縦線を出さない）のは「同層・同距離＝そのまま続く壁」「別層＝見えている壁が
    // 入れ替わっただけ」、そして**隣接列の手前に切断壁がある**の3通り。残る「同層・別距離」
    // だけが凹みの側面として縦線になる。
    //
    // 切断壁(cut)を覆う側に数えるのは、**壁はその裏へ続いており凹んでいない**ため
    // ——境界に立つ縦線は切断壁自身の断面縁（CUT・太線）が描くので、見えがかり側で重ねて
    // 描くと同じ位置に2本出る。水平線側は`hiddenByCutWall`が同じ理由で既に抑止しており
    // （「手前の切断壁でこの帯が切られただけの縁は描かない」）、縦線側だけが取り残されていた。
    // 従来はこの重複が**線種が同じ（どちらもSILHOUETTE）ゆえに`dedupeLines`で消えていた**だけで、
    // 線種を「切断壁の縁=太線／見えがかり=中線・細線」へ分けた時点（ユーザー明示指示2026-08）に
    // 重複が表面化した——偶然の重複除去に頼らず、描かない理由の側で決める。
    if (nb.kind === 'cut') {
      if (!overlapsZ(nb, band)) continue;
      ranges = subtractZ(ranges, nb);
      continue;
    }
    if (nb.kind !== 'wall') continue;
    if (nb.layerRole === band.layerRole && nb.distMm !== band.distMm) continue;
    if (!overlapsZ(nb, band)) continue;
    // 同じ壁面がキャップ（天井高さ・上階セルの有無）の違いだけで高さを変えている境界は、
    // 壁が途切れたわけではないので**帯全体**を覆う＝縦線を出さない（ユーザー明示指示
    // 2026-08その18「セル境界は描画対象としない」。実機症状: 上階のセルが部屋⇄吹抜けで
    // 切り替わる位置＝CL上に、1階壁のキャップ差ぶんの縦線が出ていた——キャップはセル境界で
    // 切り替わるため、この線は必ずCL（一点鎖線）に重なる）。
    // 腰壁・垂れ壁で実際に高さが制限された帯（isKneeDrop）は実体の高さ差なので対象外。
    if (!nb.isKneeDrop && !band.isKneeDrop && sameWallFace(nb, band)) {
      // **ただし、その境界に切断壁が立っているならセル境界ではない**——上階の壁はその壁に
      // 突き当たって実際に終わっており、切断壁の天端より上は実体の終わりなので縦線が要る
      // （ユーザー実機指摘2026-08「「5」B: 2階Y1から2000と3500のCLにエッジが描画されない」）。
      // 天端より下は切断壁自身の断面が境界を示すので、そこまでは従来どおり抑止する。
      // 「必ずCL（一点鎖線）に重なる」というその18の根拠は、境界に実体が無い場合の話である。
      const cutTop = Math.max(...col.bands.filter(b => b.kind === 'cut').map(b => b.z1));
      if (!Number.isFinite(cutTop)) return [];
      // 天端までは「セル境界」として覆う。**その上は隣の壁面自身（nb）の被覆で決める**
      // ——隣で同じ壁面が天端の上まで続いていれば消え（袖壁の上に縦線を出さない＝その17）、
      // 続いていなければ残る（「5」B: 上階の壁が腰壁で終わっている）。
      ranges = subtractZ(ranges, { z0: band.z0, z1: cutTop });
    }
    ranges = subtractZ(ranges, nb);
  }
  return ranges.filter(r => r.z1 - r.z0 > GAP_EPS);
}

/**
 * 背景側の水平線（見えがかり壁の上下端縁・スラブ端）が、**手前の切断壁に隠される**か
 * （ユーザー実機指摘2026-08「6」D1・B「1F天井断面が2階袖壁断面線とトリムされていない」）。
 *
 * 判定は「その高さが、この列の**空気ではない**（切断壁の実体が占めている）か」——
 * 「断面の中は描画しない」の一般則をこの列の高さ方向へ適用したもので、
 * `sectionVisibility.js`の空気区間と同じ見方をする（旧実装は「切断壁の天端以下ならすべて」で、
 * 床に立たない壁＝垂れ壁の**下**まで巻き込んで隠していた）。天端より上（腰壁・袖壁の上を通る
 * 上階天井）は壁に遮られないので、従来どおり対象外。
 */
function hiddenByCutWall(col, z) {
  return col.bands.some(b => b.kind === 'cut'
    && z >= b.z0 - GAP_EPS && z <= b.z1 + GAP_EPS);
}

/**
 * 見えがかり壁の帯の**側縁を立てるx**。
 *
 * 原則は列の境界（fallbackX）。ただし**その区間が隣接列の切断壁の天端から始まる**とき、つまり
 * 見えがかり壁の面が切断壁の上で終わっているとき、縦線は切断壁の**向こう側の面**へ送る
 * （ユーザー実機指摘2026-08「「5」D1: 2階Y1から2000のCL左側の腰壁の上から2階天井までの線は、
 * 同じCL右側が正解」）。
 *
 * 理由は平面にある——腰壁が突き当たる隅では壁の実体は連続しており、壁面が無くなる（アキになる）のは
 * その切断壁の**向こう側**から。手前の面に立てると、線が切断壁の断面の手前の縁から生えて見え、
 * 断面の厚みの中が壁なのかアキなのか図から読み取れなくなる（＝断面の厚みの中に、その厚みに
 * 属さない情報が入る）。切断壁は片面ずつのWallオブジェクトで複数列に割れるため、同じ天端を持つ
 * 切断壁の列が続くあいだ送り続ける。
 * @param {object[]} columns
 * @param {number} i - 見えがかり帯が乗る列
 * @param {-1|1} dir - -1=lo側 / +1=hi側
 * @param {number} z0 - この区間の下端
 * @param {number} fallbackX
 * @returns {number}
 */
function wallEndXAt(columns, i, dir, z0, fallbackX) {
  let x = fallbackX;
  for (let j = i + dir; columns[j]; j += dir) {
    if (!columns[j].bands.some(b => b.kind === 'cut' && Math.abs(b.z1 - z0) < GAP_EPS)) break;
    x = dir > 0 ? columns[j].x1 : columns[j].x0;
  }
  return x;
}

/**
 * 連続する列にまたがる同一の帯を1つのrun（x範囲）へまとめる（キーが一致し、かつ列が隣接する
 * 場合のみ連結する）。
 * @param {object[]} columns
 * @param {string} kind
 * @param {(band:object)=>*} keyOf - 同一性のキー（cut帯は壁参照、slab帯はz範囲）
 */
function bandRuns(columns, kind, keyOf) {
  const runs = [];
  columns.forEach((col, i) => {
    for (const b of col.bands) {
      if (b.kind !== kind) continue;
      const key = keyOf(b);
      const open = runs.find(r => r.key === key && r.lastIndex === i - 1);
      if (open) { open.x1 = col.x1; open.lastIndex = i; }
      else runs.push({ key, band: b, x0: col.x0, x1: col.x1, lastIndex: i });
    }
  });
  return runs;
}

/**
 * 切断壁（`cut`帯）の天端のCUT水平線。腰壁のように**見えている天井より下で終わる**切断壁は、
 * その上端が切断面の一部（そこで断面が閉じる）なので水平線を描く
 * （ユーザー実機指摘2026-08「6」D「腰壁断面線は、天端で曲がり、壁厚だけ左に進み」。
 * `cutAlong`の上端エッジと同じ扱い）。列ごとではなく**壁ごとに1本**描く——列は壁と無関係な
 * 断点でも分割されるため、列ごとに描くと同じ天端が複数本になる（seq1の既存テストが
 * 「上端水平線は1本・幅=壁厚」を固定している）。下端は描かない: 壁が載っている床
 * （スラブ端・床断面線）が既に描いており、同指摘のプロファイルも天端→外側面→2FL床と回って
 * 壁の下を通らない。
 */
function cutWallTopEdges(columns, cut, ceilZ) {
  const topZ = ceilZ ?? cut.zRange?.hiZ ?? null;
  if (topZ == null) return [];
  return cutWallRuns(columns)
    .filter(r => r.band.z1 < topZ - GAP_EPS)
    .flatMap(r => [
      emitLine(cut, r.x0, r.band.z1, r.x1, r.band.z1, ElevationLineRole.CUT, { ceilZ }),
      ...kneeCapUnderline(cut, r.x0, r.x1, r.band.z1, r.band.z0, ceilZ),
    ]);
}

/**
 * 腰壁の端部抑えの**内側の細線**（`emitColumns`の見えがかり壁の分岐から呼ぶ）。
 *
 * 天端の帯（`kneeCapUnderline`が下端を描く帯）は、壁がそこで終わる端では**端面**としても
 * 見える。端の中線（帯の外形の外側1本）は凹み側面線が既に描いているので、ここは帯の見付ぶん
 * 内側の細線だけを足す。見付と退化ガードは`kneeCapBottomMm`（elevationStyle.js）へ委ねる
 * ——面図側（elevationFigure.jsの旧kneeCapMarksOnFace）と同じ規則を1箇所に置くため。
 * @param {object[]} prims 積み先
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {object} col
 * @param {object} band 見えがかり壁の帯（isKneeDrop以外は無視する）
 * @param {{prev:object|null, next:object|null, loRanges:object[], hiRanges:object[], ceilZ:number|undefined}} ctx
 */
function appendKneeCapEndFaces(prims, cut, col, band, ctx) {
  if (!band.isKneeDrop) return;
  const top = (col.ceilZ ?? ctx.ceilZ ?? Infinity);
  if (!(band.z1 < top - GAP_EPS)) return; // 天井まで届く壁＝天端が露出していない
  if (kneeCapBottomMm(band.z1 - band.z0) == null) return; // 見付に満たない退化指定
  const coversWholeBand = ranges => ranges.length === 1
    && Math.abs(ranges[0].z0 - band.z0) < GAP_EPS && Math.abs(ranges[0].z1 - band.z1) < GAP_EPS;
  // 内側へ寄せる向きは列の内側（lo端なら+、hi端なら−）。
  if (ctx.prev && coversWholeBand(ctx.loRanges)) {
    const x = col.x0 + KNEE_CAP_FACE_MM;
    prims.push(emitLine(cut, x, band.z0, x, band.z1, ElevationLineRole.DETAIL, { ceilZ: ctx.ceilZ }));
  }
  if (ctx.next && coversWholeBand(ctx.hiRanges)) {
    const x = col.x1 - KNEE_CAP_FACE_MM;
    prims.push(emitLine(cut, x, band.z0, x, band.z1, ElevationLineRole.DETAIL, { ceilZ: ctx.ceilZ }));
  }
}

/**
 * 腰壁の天端の帯の**下端**（細線）。天端そのもの（上端）は呼び出し側が既に描いているので、
 * ここは帯の下端1本だけを返す（仕様2026-08「展開図 中線＝天端／細線＝その下」）。
 * 見付と退化ガードは展開図の唯一の情報源 `kneeCapBottomMm`（elevationStyle.js）へ委ねる
 * ——面図側（elevationFigure.js の kneeCapMarksOnFace）と同じ規則にするため。
 * @param {number} topZ 天端のz（絶対）
 * @param {number} floorZ その壁の足元のz（帯のz0。層の床）
 * @returns {object[]} 0本 or 1本
 */
function kneeCapUnderline(cut, x0, x1, topZ, floorZ, ceilZ) {
  const bottom = kneeCapBottomMm(topZ - floorZ);
  if (bottom == null) return [];
  const z = floorZ + bottom;
  return [emitLine(cut, x0, z, x1, z, ElevationLineRole.DETAIL, { ceilZ })];
}

// 切断壁の断面をz範囲で（壁参照ではなく）まとめる。**壁は片面ずつのWallオブジェクトとして
// 持つデータモデル**のため、実機の袖壁1枚が2つのWallに分かれており（列ダンプでx=45に境界）、
// 壁参照でまとめると同じ断面が2つのrunに割れてしまう——同じz範囲で連続する列は1枚の壁の
// 断面とみなす。
function cutWallRuns(columns) {
  return bandRuns(columns, 'cut', b => `${b.z0}|${b.z1}`);
}

/**
 * **天井断面の高さが変わる境界に立つ、上階の床構造（スラブ）の断面**（ユーザー明示指示の図形）。
 *
 * 低い側の天井（1階天井）と上階の床（2FL）に挟まれた区間は、**断面の中**＝建物の躯体で、
 * その中には何も描かない。描くのはその**輪郭**だけ:
 * ```
 *   ...吹抜け側...   |          ← 小口（低い側の天井 → 上階の床）
 *                    +--------  ← 上階の床の断面線（低い天井の側へ走る）
 *                       a       ← 断面の中（何も描かない）
 *   -----------------+--------  ← 低い側の天井の断面線（既に描かれている）
 * ```
 * この輪郭が無いと、1階天井の線と2階天井の線が繋がらないまま宙で終わる。
 * 境界に壁が立つ場合（腰壁・袖壁）は、その壁の断面がこの床の上に載る形になる——壁の帯自体は
 * 実体のz範囲のまま（`sectionEngine.js`の`clipBandsToCeil`）で、下へ引き伸ばさない。
 *
 * 上階の床レベルは層スタックから取る（低い側の天井より上・高い側の天井より下にある層のFL）。
 * 該当する層が無い＝同じ階の中の天井段差なので、この規則の対象外（何も描かない）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns - x0昇順
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number|undefined} ceilZ
 * @returns {object[]}
 */
/**
 * [xa,xb]のうち`cut.aboveCeilVisibleRanges`（天井断面より上で描画してよい断面ローカルxの範囲。
 * 「断面の中は描画しない」の判定結果。省略＝制限しない）に入る部分。向きは元のまま保つ。
 *
 * 現状は呼び出し側（`elevationVoid.js`の`upperStoreySegments`）が空気セルの連結成分から求めて
 * 渡す。段階2でエンジン自身が全帯について求めるようになったら、この入力は不要になる。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} xa
 * @param {number} xb
 * @returns {Array<[number,number]>}
 */
function aboveCeilVisibleSpans(cut, xa, xb) {
  const ranges = cut.aboveCeilVisibleRanges;
  if (!Array.isArray(ranges)) return [[xa, xb]];
  const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
  const out = [];
  for (const r of ranges) {
    const s = Math.max(lo, r.lo), e = Math.min(hi, r.hi);
    if (e - s > GAP_EPS) out.push(xa <= xb ? [s, e] : [e, s]);
  }
  return out;
}

function ceilStepSlabSection(columns, cut, ceilZ) {
  const prims = [];
  const range = cutDrawRange(cut);
  for (let i = 0; i + 1 < columns.length; i++) {
    const a = columns[i], b = columns[i + 1];
    if (!Number.isFinite(a.ceilZ) || !Number.isFinite(b.ceilZ)) continue;
    if (Math.abs(a.ceilZ - b.ceilZ) < GAP_EPS) continue;
    const zLow = Math.min(a.ceilZ, b.ceilZ), zHigh = Math.max(a.ceilZ, b.ceilZ);
    // 低い天井の側が「上階の床が実在する」と言っている場合だけ描く（sectionEngine.jsの
    // upperFloorZ）。上に部屋が無い＝床が無い境界に床の断面線を描いてはいけない
    // （ユーザー確定「吹抜けには天井断面まで水平断面が無い」）。
    // 境界のすぐ隣の列は**まだ吹抜けのセルの中**でありうる（天井段差の位置は壁の手前の面、
    // 上階の床が始まるのは壁の向こうの面で、半壁厚ずれる）ため、低い天井が続くあいだ
    // 外側へ走査して最初に見つかった値を使う。
    const step = a.ceilZ < b.ceilZ ? -1 : +1; // 低い天井の側へ進む向き
    let floorZ = null;
    for (let k = a.ceilZ < b.ceilZ ? i : i + 1; k >= 0 && k < columns.length; k += step) {
      if (Math.abs((columns[k].ceilZ ?? NaN) - zLow) > GAP_EPS) break;
      if (Number.isFinite(columns[k].upperFloorZ)) { floorZ = columns[k].upperFloorZ; break; }
    }
    if (!Number.isFinite(floorZ) || floorZ <= zLow + GAP_EPS || floorZ >= zHigh - GAP_EPS) continue;
    const x = a.x1;
    // 小口（低い側の天井 → 上階の床）。境界そのものなので必ず1本。
    prims.push(emitLine(cut, x, zLow, x, floorZ, ElevationLineRole.CUT, { ceilZ }));
    // 上階の床の断面線は**低い天井の側**へ走る（高い側は吹抜けで床が無い）。
    // 端は面の描画範囲の端（壁のない端部のはね出しを含む）——ユーザー明示指示
    // 「1500CLの右側はね出しまで」。
    // 上階の床の断面線は、境界に立つ切断壁（腰壁・袖壁）の**断面の中**を通ってはいけない
    // ——上階の床と、その上に載る壁は1つの連続した切断面で、その内部にこの線を引くと
    // 「展開図では断面の中は描画しない」に反する（ユーザー明示指示2026-08「「5」D1: CL右側の
    // 腰壁天端から2FLまでの断面線と2FL断面が取り合うのが正解」——壁の向こう側の面で
    // 床の断面線へ折れるのが1本の輪郭）。壁の列を越えた位置＝壁の向こう側の面から描き始める。
    let startX = x;
    for (let k = step > 0 ? i + 1 : i; columns[k]; k += step) {
      if (!columns[k].bands.some(bd => bd.kind === 'cut' && Math.abs(bd.z0 - floorZ) < GAP_EPS)) break;
      startX = step > 0 ? columns[k].x1 : columns[k].x0;
    }
    const outX = a.ceilZ < b.ceilZ ? range.lo : range.hi;
    if (Math.abs(outX - startX) > GAP_EPS) {
      // 上階の床の断面線は**低い天井の断面線より上**に載る＝その区間の上階が見えているときだけ
      // 描いてよい（見えていなければ「断面の中」で、上階の床は天井裏の躯体になる）。
      for (const [sx, ex] of aboveCeilVisibleSpans(cut, startX, outX)) {
        prims.push(emitLine(cut, sx, floorZ, ex, floorZ, ElevationLineRole.CUT, { ceilZ }));
      }
    }
  }
  return prims;
}

/**
 * 上階床スラブの端に**切断壁が載っている**（袖壁・腰壁）ときの取り合い
 * （ユーザー実機指摘2026-08「6」D1・B「CL内側まで進んで、上を向いて2階袖壁の階段側断面線と
 * トリム／1FL天井から2FL床までの上へ向かう線分がない」）。
 * スラブは吹抜けの開口縁（CL）で終わるが、袖壁はそのCLに芯を合わせて左右へ張り出す。作図は
 *   下階天井(slab.z0) …→ 袖壁の反対側の面 → そこを**上へ**立ち上げて 上階床(slab.z1) へ
 * とつなぎ、袖壁の断面線と交点で取り合わせる。この立上りが無いと天井線が宙で終わる。
 * 上階床側（slab.z1）の水平線は袖壁の手前の面で止まる（`hiddenByCutWall`）——同指摘の
 * 「2FL床断面まで下りる、再度CLの外へ延長して終わる」どおり、壁の下は通らない。
 */
function slabEdgeCutWallJunction(columns, cut, ceilZ) {
  const prims = [];
  const slabs = bandRuns(columns, 'slab', b => `${b.z0}|${b.z1}`);
  for (const c of cutWallRuns(columns)) {
    for (const s of slabs) {
      if (Math.abs(s.band.z1 - c.band.z0) > GAP_EPS) continue; // 壁がこのスラブの上に載っている
      // スラブが伸びている側の反対＝袖壁の「向こう側」の面。実機ではそれが階段側になる。
      const slabOnLoSide = s.x0 < c.x0 - GAP_EPS;
      const nearX = slabOnLoSide ? c.x0 : c.x1;
      const farX  = slabOnLoSide ? c.x1 : c.x0;
      prims.push(emitLine(cut, nearX, s.band.z0, farX, s.band.z0, ElevationLineRole.SILHOUETTE, { ceilZ }));
      prims.push(emitLine(cut, farX, s.band.z0, farX, s.band.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
      // **上階床の断面線を袖壁の手前の面からスラブ側へ張り出す**（ユーザー実機指摘2026-08「6」D1
      // 「2F腰壁断面が2FLまで下りたあと、左を向いて2FL床断面線はりだし」）。旧はこの線を
      // 「スラブの上に立つ遠い壁の下端縁」に頼っていたが、その壁が帯の部屋の外（d7250）で
      // 探索対象から外れた結果、線ごと消えていた——スラブ自身から描くのが本来の姿。
      const outX = slabOnLoSide ? s.x0 : s.x1;
      if (Math.abs(outX - nearX) > GAP_EPS) {
        prims.push(emitLine(cut, nearX, s.band.z1, outX, s.band.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
      }
    }
  }
  return prims;
}

/**
 * 見えがかりの線種は**奥行き**で決まる（ユーザー明示指示2026-08「切断壁の縁は太線が正で、その他の
 * 見えがかりの線を直近を中線、それ以外を細線で分類」）。この切断で見えている最も手前の壁面までの
 * 距離を返す（見えがかり壁が1枚も無ければInfinity）。
 *
 * 「直近」は列ごとではなく**その切断（＝その1枚の図）全体**で決める——列ごとに最小を取ると、
 * 奥まった凹みもその列では最前面なので中線になり、面の中で奥行きの表現が失われる。図全体で
 * 最も手前＝その面自身の壁面（`sectionCutPlane.js`で下げたぶんの距離）が中線、そこから奥は
 * 全て細線、という深度の階調になる。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @returns {number}
 */
export function nearestSightlineDistMm(columns) {
  let min = Infinity;
  for (const col of columns ?? []) {
    for (const band of col.bands) {
      if (band.kind === 'wall' && Number.isFinite(band.distMm)) min = Math.min(min, band.distMm);
    }
  }
  return min;
}

/**
 * その帯が見せている「仮想断面からの距離」。open/slabは**何も見えていない**のでnull。
 * 見えがかり線を描くかどうかは、隣り合う帯どうしでこの値が変わるかだけで決まる
 * （ユーザー明示指示2026-08「仮想断面からの距離が変わるところに垂直、水平、または、斜めの
 * 見えがかり線を描画」）——同じ距離が続いていればそこは1枚の連続面であり、線は存在しない。
 * @param {object|null|undefined} band
 * @returns {number|null}
 */
function visibleDepthMm(band) {
  if (!band) return null;
  if (band.kind === 'wall') return Number.isFinite(band.distMm) ? band.distMm : null;
  if (band.kind === 'cut' || band.kind === 'cutAlong') return 0; // 切断面は距離0
  return null; // open/slab
}

// 列の中で、指定zにz方向で隣接する帯（dir=-1なら下側・+1なら上側）。範囲外はundefined。
function neighborBandAt(col, z, dir) {
  return col.bands.find(b => (dir < 0
    ? Math.abs(b.z1 - z) < GAP_EPS
    : Math.abs(b.z0 - z) < GAP_EPS));
}

/**
 * その帯が、隣（z方向）との境界の見えがかり線を**描く側か**。
 * 距離が変わらなければ線は無い（1枚の連続面）。変わるときは**手前の面**がその輪郭を持つ
 * ——両方が描くと同じ位置に線種の違う線が2本出る（奥行きで線種を分けた結果、以前は同一線種
 * ゆえに`dedupeLines`が消していた重複が表面化する）。相手が何も見えていない側（アキ・床スラブ・
 * 範囲外）なら、この面の輪郭としてこちらが描く。
 * @param {object} band
 * @param {object|null|undefined} neighbor
 * @returns {boolean}
 */
function ownsBoundary(band, neighbor) {
  const a = visibleDepthMm(band);
  if (a === null) return false;
  const b = visibleDepthMm(neighbor);
  if (b === null) return true;
  return a < b;
}

/**
 * その列で「床断面線・天井断面線が既にある高さ」とみなすz。**FL・CHの見えがかりは描画しない**
 * （ユーザー明示指示2026-08）——床と天井はその位置に断面線（CUT・太線）を持っており、壁がそこに
 * 接する線を見えがかりとして重ねると同じ位置に2本出る（線種を奥行きで分けた結果、太線と
 * 中線・細線が重なって見える）。
 *
 * FL: 帯自身のFL（baseFloorZ）・各層のFL（floorZMm）・その列の床スラブのFL。
 * CH: **その列の天井断面（`col.ceilZ`。無ければ帯の天井 emitCtx.ceilZ／cut.zRange.hiZ）**。
 * 天井高さは層の属性ではなく部屋・区間ごとに違うため層スタックからは一意に決まらず、区間の天井を
 * 知っている呼び出し側から`cut.ceilProfile`で受け取る（sectionEngine.js）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('./sectionTypes.js').SectionColumn} col
 * @param {number|undefined} ceilZ - emitCtx.ceilZ
 * @returns {number[]}
 */
function sectionLevelZs(cut, col, ceilZ) {
  const zs = [];
  if (Number.isFinite(cut.baseFloorZ)) zs.push(cut.baseFloorZ);
  for (const layer of cut.layers ?? []) {
    if (Number.isFinite(layer?.floorZMm)) zs.push(layer.floorZMm);
  }
  for (const band of col.bands) {
    if (band.kind === 'slab' && Number.isFinite(band.floorZ)) zs.push(band.floorZ);
  }
  const chZ = ceilZ ?? cut.zRange?.hiZ;
  if (Number.isFinite(chZ)) zs.push(chZ);
  return zs;
}

/**
 * SectionColumn[] → 切断壁の断面（両縁）・見えがかり壁面の輪郭／凹み側面線 のプリミティブ列
 * （§3.4役割分担表・§5.5・§5.6）。アキXはemitOpenGapMarks側（本関数はopen/slab bandを描かない
 * ——slabは非描画のまま、AMBIGUITY F）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{ceilZ?:number, openEndLo?:boolean, openEndHi?:boolean}} [emitCtx]
 * @returns {object[]}
 */
export function emitColumns(columns, cut, emitCtx = {}) {
  const prims = [];
  const ceilZ = emitCtx.ceilZ;
  // 見えがかりの線種（直近=中線／それ以外=細線）。nearestSightlineDistMm参照。
  const nearestDistMm = nearestSightlineDistMm(columns);
  const sightRole = distMm => (Number.isFinite(distMm) && distMm <= nearestDistMm + GAP_EPS
    ? ElevationLineRole.SILHOUETTE : ElevationLineRole.DETAIL);
  // 注: 「壁のない端部で線を図の外側へ延長する」処理はここには無い。プリミティブを後から
  // 引き伸ばすのではなく、**探査範囲そのものを外へ広げる**（sectionProbe.jsの
  // probeExtendLo/HiMm。ユーザー裁定2026-08 A案）——面の外の列も実データとして生成されるため、
  // 延長ぶんの線は通常の帯の縁として自然に出る。両方やると二重に伸びるので、ここでは何もしない。
  columns.forEach((col, i) => {
    const prev = columns[i - 1] ?? null;
    const next = columns[i + 1] ?? null;
    for (const band of col.bands) {
      if (band.kind === 'cut') {
        // 切断壁の断面矩形の両縁: その縁が接する側がopenならCUT、塞がれていればSILHOUETTE
        // （AMBIGUITY B）。列の外（画面端）はopen扱い。WP-E5b修正: 隣接列が「別のcut band」で
        // なければopen扱いにしていた旧実装（`|| !matchingBand(...,'cut')`）は、隣接列が
        // 'wall'（距離のある見えがかり壁）のときも「塞がれていない」と誤判定していた
        // （例: seq1で切断された往復間の壁の縁が、遠くに見える別の壁（'wall'band）に接する場合。
        // 保存意味論「seq1では切断線を横切るcutとして厚みの2縁=open側CUT/塞がれ側SILHOUETTE」
        // を満たすには、'wall'・'cutAlong'等どの種類であれ何らかの実体があれば「塞がれている」
        // とみなす必要がある——isOpenSideAtは`kind==='open'`（または開口貫通）だけをopenと
        // みなすため、そのままの結果を使えばよい）。
        // **同じ壁のcut帯が隣接列にも続いていれば、その境界は壁の内部なので線を描かない**
        // （ユーザー実機指摘2026-08「6」D。腰壁の断面がx=-57.5..57.5の1枚なのに、列が
        // x-57.5..0/0..45/45..57.5へ分割されていたため、内部にV x0・V x45の縦線が出ていた）。
        // cutAlongの端部縦線と同じ「隣接列に同じ壁が続くか」のパターン。壁の同一性は
        // band.wall参照で見る——両側にwallが載っている場合だけ抑止し、載っていない
        // （単体テストの手書き列など）場合は従来どおり描く。
        // **壁は片面ずつのWallオブジェクト**（cutWallRuns参照。実機の袖壁1枚が2つのWallに
        // 分かれる）ため、参照一致だけで見ると1枚の袖壁の**内部**＝軸CL上にその境界の縦線が
        // 出る。**同じ軸CLに載っていて同じz範囲の切断壁は、1枚の壁の表裏**とみなす
        // ——切断線は壁を厚み方向に横切るので、同一軸CLの切断壁が隣接列で接するのは
        // 「同じ壁の反対の面」以外にありえない（別々の壁が接するなら軸CLが違う）。
        // 天端の水平線を1本にまとめている`cutWallRuns`と同じ「1枚の壁」の見方をそろえたもの。
        const sameWall = b => !!b && !!b.wall && !!band.wall
          && (b.wall === band.wall
            || (!!b.wall.axisCL && b.wall.axisCL === band.wall.axisCL
              && Math.abs(b.z0 - band.z0) < GAP_EPS && Math.abs(b.z1 - band.z1) < GAP_EPS));
        // `exposedSide`（sectionEngine.jsのclipBandsToCeil）が付いた帯は、**天井の高さが変わる
        // 境界に立っていて片側からしか見えない壁**。見えるのはその側の面だけで、反対側の面は
        // 低い天井の裏に隠れている——両縁を描くと壁厚が図に出てしまう（ユーザー明示指示:
        // 実機「5」A「X2の右側が断面線なら、左側は壁の中になり、描画しないが正解」）。
        const hidden = band.exposedSide ?? null;
        if (hidden !== 'hi' && !sameWall(matchingBand(prev, band.z0, band.z1, 'cut'))) {
          prims.push(Object.assign(emitLine(cut, col.x0, band.z0, col.x0, band.z1, ElevationLineRole.CUT, { ceilZ }),{__o:'cutEdgeLo'}));
        }
        if (hidden !== 'lo' && !sameWall(matchingBand(next, band.z0, band.z1, 'cut'))) {
          prims.push(Object.assign(emitLine(cut, col.x1, band.z0, col.x1, band.z1, ElevationLineRole.CUT, { ceilZ }),{__o:'cutEdgeHi'}));
        }
      } else if (band.kind === 'wall') {
        // 見えがかり壁面の輪郭（上端・下端）。水平線（縮退）はemitLineの単独判定では
        // 「ちょうどbaseFloorZ/ceilZに触れるだけ」を向こう側と見なさないため、band全体が
        // baseFloorZ以下／ceilZ以上ならforceDashで明示的に降格する（WP-E5b: sectionProbe.jsが
        // cut.baseFloorZをzBreaksに割り込ませることで生じる、内部分割されたband用の対応）。
        const beyondBand = bandFullyBeyond(cut, band, ceilZ);
        // **手前の切断壁でこの帯が切られただけの縁は描かない**（ユーザー実機指摘2026-08「6」D）。
        // 同じ列で切断壁(cut)の上端/下端とちょうど一致する縁は、見えがかり壁の実際の端ではなく
        // 「手前の腰壁に遮られてそこで見えなくなった」だけの遮蔽境界で、壁自体はその裏へ続いている
        // （実機症状: 腰壁の内側半分x0..57.5の下に、遠い壁の天端としてH z3000が出ていた）。
        // 腰壁の天端側はcut帯自身がCUT水平線として描くので、線が失われることはない。
        // **腰壁が床スラブの上に直に載っている境界は描かない**（ユーザー実機指摘2026-08「6」C
        // 「2FLの線は、左の壁断面から腰壁が終わるエッジまで不要。この腰壁の仕上げ面は、直下の
        // 2FLから1FL天井線までの面と同面のため」）。腰壁は床の端に立つので、その仕上げ面と
        // 直下の床スラブ小口は同一平面＝見た目に線は現れない。腰壁でない（`isKneeDrop`でない）
        // 遠くの壁は同面ではないので、スラブ小口の線はそのまま出る（実機の右半分がこれ）。
        const flushOnSlab = band.isKneeDrop
          && col.bands.some(b => b.kind === 'slab' && Math.abs(b.z1 - band.z0) < GAP_EPS);
        const role = sightRole(band.distMm);
        // 見えがかりの水平線は「仮想断面からの距離が変わるところ」だけに描き、FL・CHには描かない
        // （ユーザー明示指示2026-08。visibleDepthMm / sectionLevelZs 参照）。
        // 天井断面の高さは列ごとに違う（区間ごとの天井。sectionEngine.jsのceilProfile）ため、
        // その列の天井を優先して使う——帯の天井(emitCtx.ceilZ)だけを見ると、天井の低い区間で
        // 天井断面線と見えがかりの水平線が重なる。
        const sectionZs = sectionLevelZs(cut, col, col.ceilZ ?? ceilZ);
        const atSectionLevel = z => sectionZs.some(f => Math.abs(z - f) < GAP_EPS);
        if (!flushOnSlab && !hiddenByCutWall(col, band.z0) && !atSectionLevel(band.z0)
            && ownsBoundary(band, neighborBandAt(col, band.z0, -1))) {
          prims.push(emitLine(cut, col.x0, band.z0, col.x1, band.z0, role, { ceilZ, forceDash: beyondBand }));
        }
        // **その空間の天井の縁は、仮想断面から最も近い面（＝主な描画対象）と同格なので中線**
        // （ユーザー明示指示2026-08「追加した1階天井見えがかり：仮想断面から最も近い壁
        // （=主な描画対象）と同じ面のエッジなので中線を選択する」）——天井は切断面のすぐ手前から
        // 奥へ広がる面で、その縁までの奥行きは0であり、見えている壁までの距離（この帯のdistMm）
        // ではない。天井懐(slab)がすぐ上に接し、その層の天井(ceilZ)がこの高さに一致することで
        // 「この境界は空間の天井である」と判定する（slab/openの境界側と同じ見方）。
        const upperBand = neighborBandAt(col, band.z1, +1);
        const atSpaceCeil = upperBand?.kind === 'slab' && Number.isFinite(upperBand.ceilZ)
          && Math.abs(upperBand.ceilZ - band.z1) < GAP_EPS;
        const topRole = atSpaceCeil ? ElevationLineRole.SILHOUETTE : role;
        if (!hiddenByCutWall(col, band.z1) && !atSectionLevel(band.z1)
            && ownsBoundary(band, neighborBandAt(col, band.z1, +1))) {
          prims.push(emitLine(cut, col.x0, band.z1, col.x1, band.z1, topRole, { ceilZ, forceDash: beyondBand }));
          // 腰壁の天端（仕様2026-08）: 見えがかりでも天端の帯は見えるので下端を細線で足す。
          // 天端の水平線を実際に描いた場合だけ——遮蔽で消した縁の下に帯だけ残ると嘘になる。
          if (band.isKneeDrop && band.z1 < (col.ceilZ ?? ceilZ ?? Infinity) - GAP_EPS) {
            prims.push(...kneeCapUnderline(cut, col.x0, col.x1, band.z1, band.z0, ceilZ));
          }
        }
        // 凹み: 隣接列で同一z区間のwallのdistMmが変化した境界にSILHOUETTE縦線（§5.5）。
        // 凹み側面線。**列の外側の端（prev/nextが無い＝描画範囲の端）では、その端に壁が
        // 無ければ描かない**（ユーザー実機指摘2026-08「3500左CLにエッジはない」）——
        // 隣接列が無いことは「そこで壁が終わる」ことを意味しない。範囲外は単に未探査であり、
        // 面が「壁のない端部」だと分かっている側（emitCtx.openEndLo/openEndHi）では
        // 壁面はその先へ続いている。旧実装は`!prevWall`だけで判定していたため、
        // 先頭列・末尾列には常に縦線が出ていた（全パネルの端に出る症状）。
        // **凹みは同じ層(layerRole)の壁どうしでしか成立しない**（ユーザー実機指摘2026-08「6」D。
        // 実機症状: 左CL上のz3800..5400に縦線が出ていた——隣は上階側の遠い壁(d7250 above)、
        // こちらは設置階の壁(d2250 self)で、距離が変わるのは「1枚の壁面が凹んだ」からではなく
        // **見えている壁が別の層のものへ入れ替わった**だけ。連続面の折れ角ではないので描かない）。
        // 隣接列に見えがかり壁が無い場合は従来どおり「そこで壁が終わる」＝描く。
        // **手前の切断壁に切られてこの列だけ分割された帯の側縁は描かない**（ユーザー明示指示
        // 2026-08その17「「6」D1・B: 腰壁上のエッジは不要」）。腰壁の天端で始まる帯は、
        // その列で腰壁に遮られたぶんだけ下端が持ち上がった**同じ壁の続き**であり、隣接列では
        // 1本の大きな帯（あるいは別の見え方）になる。ここで側縁を描くと、腰壁の上に壁の切れ目が
        // 無いのに縦線が出る。
        //
        // 判定は「**帯の下端が、その列の切断壁の天端にちょうど一致する**」——それが「切断壁に
        // 切られて持ち上がった」ということの定義そのもの。以前は`hiddenByCutWall(col, band.z0)`
        // ＝「天端が帯の下端以上の切断壁がこの列にあるか」で見ていたが、これは**切断壁より下に
        // ある帯まで巻き込む**（実機「5」A: 1階の壁の帯z0..2400が、その上に立つ2階X2壁の断面
        // z2400..5400のせいで「切られた」と判定され、X2右側の壁エッジが丸ごと消えていた）。
        // 切断壁はそれ自身のz範囲でしか遮らない。
        const splitByCutWall = col.bands.some(b =>
          b.kind === 'cut' && Math.abs(b.z1 - band.z0) < GAP_EPS);
        // **ただし隣接列がアキ（open）なら、そこで壁面は本当に終わっている**——「切られて
        // 持ち上がっただけ」と言えるのは、その先で壁面が何らかの形で続いているとき。アキは
        // 「その面の平面に壁が無い」ことそのものなので、境界の縦線が要る（ユーザー実機指摘
        // 2026-08「「5」B: 2階Y1から2000と3500のCLにエッジが描画されない」）。
        // 隣接列がスラブ等の別の見え方になるだけの場合は従来どおり抑止する（その17「6」D1）。
        const endsAtGap = nb => !!nb && nb.bands.some(x => x.kind === 'open' && overlapsZ(x, band));
        {
          const wholeBand = [{ z0: band.z0, z1: band.z1 }];
          const loRanges = (splitByCutWall && !endsAtGap(prev)) ? []
            : prev ? uncoveredZRanges(prev, band) : (emitCtx.openEndLo ? [] : wholeBand);
          for (const r of loRanges) {
            const x = wallEndXAt(columns, i, -1, r.z0, col.x0);
            prims.push(Object.assign(emitLine(cut, x, r.z0, x, r.z1, role, { ceilZ }),{__o:'recessLo'}));
          }
          const hiRanges = (splitByCutWall && !endsAtGap(next)) ? []
            : next ? uncoveredZRanges(next, band) : (emitCtx.openEndHi ? [] : wholeBand);
          for (const r of hiRanges) {
            const x = wallEndXAt(columns, i, +1, r.z0, col.x1);
            prims.push(Object.assign(emitLine(cut, x, r.z0, x, r.z1, role, { ceilZ }),{__o:'recessHi'}));
          }
          // 腰壁の端部抑え（仕様2026-08「追加したい腰壁の仕様」）: 天端の帯は壁が終わる端でも
          // 見えるので、その端に**帯の見付ぶん内側の細線**を足す（端の中線は上の凹み側面線が
          // 既に描いている＝帯の外形2本のうち内側の1本だけがここの責務。天端の水平線と
          // その下端＝kneeCapUnderline と対になる）。
          // 描く端は「その壁がそこで実際に終わる端」だけ——隣接列が有る（＝探査範囲の内側）
          // かつ帯の全高が覆われていない端。次の2つは対象外で、どちらも条件から自然に落ちる:
          //   - 面の端（隣接列が無い）… そこは直交壁との取り合いで、腰壁は相手の壁表面まで
          //     行って終わる。その位置の縦線は端部処理が描くため二重にしない。
          //   - 同じ軸上に壁が続く端 … 連続する壁は同じ偏芯・同じ厚みで同面のため
          //     （uncoveredZRangesが空を返す）。
          appendKneeCapEndFaces(prims, cut, col, band, { prev, next, loRanges, hiRanges, ceilZ });
        }
      } else if (band.kind === 'cutAlong') {
        // cutAlong（縦断された壁。WP-E5リード裁定・§6.1）: 見付面自体は塗らず輪郭のみ描く。
        // 上端エッジ（腰壁ならtopHeight位置。壁がz途中で終わる場合その上はrayが継続し別kindの
        // bandになる＝band.z1が常に「この壁のこの位置での実際の上端」）はCUT水平線
        // （band全体がbaseFloorZ以下なら降格。'wall'と同じforceDash判定）。
        prims.push(emitLine(cut, col.x0, band.z1, col.x1, band.z1, ElevationLineRole.CUT,
          { ceilZ, forceDash: bandFullyBeyond(cut, band, ceilZ) }));
        // 腰壁の天端（仕様2026-08）: 上端が天井より下で終わる＝天端が露出している帯だけ、
        // 帯の下端を細線で足す（垂れ壁は下端が露出するので z1 は天井に一致し、ここは通らない）。
        if (band.isKneeDrop && band.z1 < (col.ceilZ ?? ceilZ ?? Infinity) - GAP_EPS) {
          prims.push(...kneeCapUnderline(cut, col.x0, col.x1, band.z1, band.z0, ceilZ));
        }
        // 端部縦線: 壁のx方向の実際の端（隣接列に同じcutAlong壁が続かない側）にCUT縦線
        // （壁の実端の断面。§5.5の凹み側面線と同じ「隣接列と比較」パターンだが、cutAlongは
        // 塗り分けを持たないため常にCUT——壁が存在しない側=open端という区別を線種に反映する
        // 必要が無い、壁の実端そのものを示す線のため）。
        const prevAlong = matchingBand(prev, band.z0, band.z1, 'cutAlong');
        if (!prevAlong) {
          prims.push(Object.assign(emitLine(cut, col.x0, band.z0, col.x0, band.z1, ElevationLineRole.CUT, { ceilZ }),{__o:'cutEdgeLo'}));
        }
        const nextAlong = matchingBand(next, band.z0, band.z1, 'cutAlong');
        if (!nextAlong) {
          prims.push(Object.assign(emitLine(cut, col.x1, band.z0, col.x1, band.z1, ElevationLineRole.CUT, { ceilZ }),{__o:'cutEdgeHi'}));
        }
      }
      // open/slabの帯自体はここでは描かない（AMBIGUITY F）。ただしslab→openの境界（＝above層の
      // 床の端）はSILHOUETTE水平線として描く（WP-E5b追加。§5.6「2FLの中線= above層の床スラブ端
      // （slabとopenの境界）→SILHOUETTE水平線」）。同一列内でz方向に隣接するslab/open帯の境界を
      // 対象にする——列をまたぐslab⇄open（x方向の境界）は凹み側面線に相当する概念が無く
      // （床の厚み方向の境界であってwallの見付面ではない）、本WPでは対象外（ASSUMED）。
    }
    for (let i = 0; i + 1 < col.bands.length; i++) {
      const a = col.bands[i], b = col.bands[i + 1];
      const aIsFloorEdge = (a.kind === 'slab' || a.kind === 'open');
      const bIsFloorEdge = (b.kind === 'slab' || b.kind === 'open');
      if (aIsFloorEdge && bIsFloorEdge && a.kind !== b.kind) {
        if (!hiddenByCutWall(col, a.z1)) {
          prims.push(emitLine(cut, col.x0, a.z1, col.x1, a.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
        }
      }
    }
  });
  prims.push(...cutWallTopEdges(columns, cut, ceilZ));
  // 上階の床との取り合いは、**区間ごとの天井を持つ帯（cut.ceilProfileあり＝通常の部屋帯・
  // 吹抜け帯）は ceilStepSlabSection、持たない帯（階段帯）は slabEdgeCutWallJunction** が担当する。
  // 両方走らせると同じ取り合いを別々の作図で二重に描く——前者は「天井の高さが変わる境界」を
  // 起点に低い天井の側へ床の断面線を伸ばし、後者は「スラブ帯の外端」を起点に反対側へ伸ばす。
  // 通常の部屋帯では 1F天井〜2FL が吹抜けの側でも天井懐(slab)に分類されるため、後者は床の
  // 断面線を吹抜けの側（床が無い側）へ引いてしまう。
  if (Array.isArray(cut.ceilProfile) && cut.ceilProfile.length > 0) {
    prims.push(...ceilStepSlabSection(columns, cut, ceilZ));
  } else {
    prims.push(...slabEdgeCutWallJunction(columns, cut, ceilZ));
  }
  return dedupeLines(prims);
}

// 完全に同一（type/x1/y1/x2/y2/weight/dash）の線プリミティブを1本にまとめる（WP-E5b追加）。
// sectionProbe.jsがcut.baseFloorZ/ceilZをzBreaksに割り込ませる（§5.6最終フィルタをband内部の
// 一部にも適用できるようにするため）副作用として、同一kindの隣接z区間が「上端／下端」を
// それぞれ独立に描く際、その内部分割の境界ちょうどで同じ水平線が2回出ることがある
// （例: wallの下側区間の上端縁と上側区間の下端縁が同じz=baseFloorZに重なる）——見た目には
// 影響しない冗長プリミティブだが、テスト側の本数アサーションを不安定にするため統合する。
function dedupeLines(prims) {
  const seen = new Set();
  const out = [];
  for (const p of prims) {
    const key = p.type === 'line' ? `${p.type}|${p.x1}|${p.y1}|${p.x2}|${p.y2}|${p.weight}|${p.dash ?? ''}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(p);
  }
  return out;
}

// 線分(x1,y1)-(x2,y2)が軸並行矩形の内側にある媒介変数区間[t0,t1]（Liang-Barsky。交わらなければ
// null）。矩形はz→y変換済み（yLo<=yHi）で渡す。
function segmentInsideRect(x1, y1, x2, y2, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const ps = [-dx, dx, -dy, dy];
  const qs = [x1 - r.xLo, r.xHi - x1, y1 - r.yLo, r.yHi - y1];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    const p = ps[i], q = qs[i];
    if (Math.abs(p) < 1e-9) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-9 ? [t0, t1] : null;
}

// 媒介変数区間の集合を昇順・非重複へ統合する。
function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[1]);
    else out.push([...iv]);
  }
  return out;
}

/**
 * 指定のx/z範囲に食い込む**腰壁・垂れ壁**の帯を矩形（y変換済み）で返す。アキのバツのクリップに使う
 * （ユーザー実機指摘2026-08「6」C「バツが、腰壁と交差する場合、腰壁内はクリップして描画しない」）。
 * 対象を「実体の帯すべて」ではなく`isKneeDrop`（腰壁・垂れ壁指定で高さが制限された壁。
 * sectionProbe.jsが付与）に絞るのが要点——実体一般で差し引くと、開口の下の普通の壁まで
 * 対象になり、WP-E7 D1の確認済み仕様「開口が2階アキと連続すると1組の**大きな**X」が
 * 細切れになる（実際にそう作り込んで既存テストが落ちた）。
 */
function obstructionRects(columns, x0, x1, z0, z1) {
  const rects = [];
  for (const col of columns) {
    if (col.x1 <= x0 + GAP_EPS || col.x0 >= x1 - GAP_EPS) continue;
    for (const b of col.bands) {
      if (!b.isKneeDrop || b.openingPassThrough) continue;
      if (!overlapsZ(b, { z0, z1 })) continue;
      rects.push({ xLo: col.x0, xHi: col.x1, yLo: zToY(b.z1), yHi: zToY(b.z0) });
    }
  }
  return rects;
}

// 線分から矩形の和に入る区間を取り除き、残った区間だけの線分列にする。
function subtractRectsFromLine(p, rects) {
  if (!rects.length) return [p];
  const cut = mergeIntervals(rects
    .map(r => segmentInsideRect(p.x1, p.y1, p.x2, p.y2, r))
    .filter(Boolean));
  if (!cut.length) return [p];
  const at = t => ({ x: p.x1 + (p.x2 - p.x1) * t, y: p.y1 + (p.y2 - p.y1) * t });
  const out = [];
  let cursor = 0;
  for (const [c0, c1] of cut) {
    if (c0 - cursor > 1e-9) {
      const a = at(cursor), b = at(c0);
      out.push({ ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    cursor = Math.max(cursor, c1);
  }
  if (1 - cursor > 1e-9) {
    const a = at(cursor), b = at(1);
    out.push({ ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}

/**
 * アキのバツ（`emitOpenGapMarks`が出す一点鎖線の対角線）のうち、**手前の実体に隠れる区間だけを
 * 破線へ落とす**（ユーザー実機指摘2026-08「6」C「但し、階段に隠れる部分は破線」）。
 * 破線の範囲は**何かの基準線の左右では決まらない**（同指摘の撤回・再指示「想定したバツに対して
 * 描画面+所定距離までレイキャストして、隠れた部分を破線にする」）——渡す矩形は手前に実体が
 * 存在する範囲そのもの（`stairOccluderRects`）で、対角線とその重なりを取るだけ。
 * 対象は`dash:'center'`の斜め線だけ——既に`dashed`のもの（床断面より下のアキ）や水平・垂直線は
 * そのまま通す。区間ごとに線分を分割して積み直すため、1本のバツが複数の線分になる。
 * @param {object[]} prims - emitOpenGapMarksの出力（他のプリミティブが混ざっていてもよい）
 * @param {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>} rects - 階段の見付け矩形
 * @returns {object[]}
 */
export function splitGapMarksByStair(prims, rects) {
  if (!rects?.length) return prims;
  const boxes = rects.map(r => ({
    xLo: Math.min(r.xLo, r.xHi), xHi: Math.max(r.xLo, r.xHi),
    yLo: zToY(Math.max(r.zLo, r.zHi)), yHi: zToY(Math.min(r.zLo, r.zHi)),
  }));
  const out = [];
  for (const p of prims) {
    const isDiagonal = p.type === 'line' && p.dash === 'center'
      && Math.abs(p.x1 - p.x2) > GAP_EPS && Math.abs(p.y1 - p.y2) > GAP_EPS;
    if (!isDiagonal) { out.push(p); continue; }
    const hidden = mergeIntervals(boxes
      .map(b => segmentInsideRect(p.x1, p.y1, p.x2, p.y2, b))
      .filter(Boolean));
    if (hidden.length === 0) { out.push(p); continue; }
    const at = t => ({ x: p.x1 + (p.x2 - p.x1) * t, y: p.y1 + (p.y2 - p.y1) * t });
    const push = (t0, t1, dash) => {
      if (t1 - t0 <= 1e-9) return;
      const a = at(t0), b = at(t1);
      out.push({ ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y, dash });
    };
    let cursor = 0;
    for (const [h0, h1] of hidden) {
      push(cursor, h0, 'center');   // 見えている区間
      push(h0, h1, 'dashed');       // 階段に隠れる区間
      cursor = h1;
    }
    push(cursor, 1, 'center');
  }
  return out;
}

/**
 * 見えがかりの**水平線**のうち、手前の階段（flightの見付け矩形）に隠れる区間を破線にする
 * （ユーザー実機指摘2026-08「6」C「1FL天井線は、左壁断面から復路左のささらまで。その先は
 * 袋階段に隠れて見えなくなるが、アキ・バツのために破線で右側壁断面線まで」）。
 * 対象はSILHOUETTE（中線）の実線水平線だけ。矩形の**z範囲の内側に厳密に入る**ものに限る
 * ——ちょうど上端・下端に載る線（例: 2FL線が復路の昇り切り高さと一致する）は階段に隠れて
 * いるのではなく縁で接しているだけなので対象外。
 * @param {object[]} prims
 * @param {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>} rects
 */
export function dashHorizontalsBehindStair(prims, rects) {
  if (!rects?.length) return prims;
  const out = [];
  for (const p of prims) {
    const isTarget = p.type === 'line' && p.weight === weightForRole(ElevationLineRole.SILHOUETTE)
      && !p.dash && Math.abs(p.y1 - p.y2) < GAP_EPS;
    if (!isTarget) { out.push(p); continue; }
    const z = -p.y1;
    const xLo = Math.min(p.x1, p.x2), xHi = Math.max(p.x1, p.x2);
    const hidden = mergeIntervals(rects
      .filter(r => z > Math.min(r.zLo, r.zHi) + GAP_EPS && z < Math.max(r.zLo, r.zHi) - GAP_EPS)
      .map(r => [Math.max(xLo, Math.min(r.xLo, r.xHi)), Math.min(xHi, Math.max(r.xLo, r.xHi))])
      .filter(([a, b]) => b - a > GAP_EPS));
    if (!hidden.length) { out.push(p); continue; }
    const seg = (a, b, dash) => {
      if (b - a <= GAP_EPS) return;
      out.push(dash ? { ...p, x1: a, x2: b, dash } : { ...p, x1: a, x2: b });
    };
    let cursor = xLo;
    for (const [h0, h1] of hidden) { seg(cursor, h0, null); seg(h0, h1, 'dashed'); cursor = h1; }
    seg(cursor, xHi, null);
  }
  return out;
}

// polyline（階段の断面プロファイル）が高さzを横切るローカルxのうち、最初に見つかるもの（無ければnull）。
function profileXAtZ(points, z) {
  const y = zToY(z);
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    if (y < lo - GAP_EPS || y > hi + GAP_EPS) continue;
    if (Math.abs(y2 - y1) < GAP_EPS) return Math.min(x1, x2); // 水平区間はその始点
    return x1 + (x2 - x1) * ((y - y1) / (y2 - y1));
  }
  return null;
}

/**
 * 階段の**下ささらの見えがかり**（DETAILのpolyline）のうち、下階天井〜上階床の間に入る区間を
 * 取り除く（ユーザー実機指摘2026-08「6」D2「1F天井断面から2F床断面の間は、天井内なので、
 * 下ささらをカット」）。その帯は床構造の中で、室内側からは見えない。
 * z帯を横切る線分は交点で分割し、帯の外に残る部分だけを新しいpolylineとして返す。
 * @param {object[]} stairContent
 * @param {number} zLo - 下階天井
 * @param {number} zHi - 上階床
 */
export function clipStairDetailInSlabBand(stairContent, zLo, zHi) {
  if (!(zHi > zLo + GAP_EPS)) return stairContent;
  const detail = weightForRole(ElevationLineRole.DETAIL);
  const inBand = z => z > zLo + GAP_EPS && z < zHi - GAP_EPS;
  const isStringer = p => p.type === 'polyline' && p.weight === detail && p.points?.length > 1;
  // **上ささらは見えるので残す**（ユーザー実機指摘2026-08「6」D2）。ささらの見えがかりは
  // 上端・下端の2本1組で出るので、x範囲が重なる相手より低い方＝下端だけを対象にする
  // （同じ高さのもの＝重複出力は両方とも残す）。
  const stringers = stairContent.filter(isStringer).map(p => ({
    p,
    meanZ: p.points.reduce((sum, [, y]) => sum - y, 0) / p.points.length,
    xLo: Math.min(...p.points.map(([x]) => x)),
    xHi: Math.max(...p.points.map(([x]) => x)),
  }));
  const isLower = p => {
    const me = stringers.find(e => e.p === p);
    return stringers.some(o => o.p !== p && o.meanZ > me.meanZ + GAP_EPS
      && o.xLo < me.xHi - GAP_EPS && o.xHi > me.xLo + GAP_EPS);
  };
  const out = [];
  for (const p of stairContent) {
    if (!isStringer(p) || !isLower(p)) { out.push(p); continue; }
    let run = [];
    const flush = () => { if (run.length > 1) out.push({ ...p, points: run }); run = []; };
    const push = pt => {
      const last = run[run.length - 1];
      if (!last || Math.abs(last[0] - pt[0]) > GAP_EPS || Math.abs(last[1] - pt[1]) > GAP_EPS) run.push(pt);
    };
    for (let i = 0; i + 1 < p.points.length; i++) {
      const a = p.points[i], b = p.points[i + 1];
      const at = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      // 帯の境界を横切るtで線分を分割し、区間ごとに中点で内外を判定する。
      const ts = [0, 1];
      if (Math.abs(b[1] - a[1]) > GAP_EPS) {
        for (const edge of [zLo, zHi]) {
          const t = (zToY(edge) - a[1]) / (b[1] - a[1]);
          if (t > GAP_EPS && t < 1 - GAP_EPS) ts.push(t);
        }
      }
      ts.sort((x, y) => x - y);
      for (let k = 0; k + 1 < ts.length; k++) {
        const [t0, t1] = [ts[k], ts[k + 1]];
        if (inBand(-at((t0 + t1) / 2)[1])) { flush(); continue; } // 帯の中は捨てる
        push(at(t0)); push(at(t1));
      }
    }
    flush();
  }
  return out;
}

/**
 * 階段の断面プロファイル（CUTのpolyline）との取り合いを作る
 * （ユーザー実機指摘2026-08「6」D2）。
 *   1. **1F天井断面線は階段断面との交点で終える**（「1F天井断面線が右に進み、天井厚と階段断面
 *      との交点で終了」）——旧はスラブ帯の切れる列境界で止まっており、階段の手前で宙に終わっていた。
 *   2. **2FLで終わっている階段断面線から2FLの床断面線を張り出す**（「2FLで終了している階段断面線を
 *      2FLはねだしまで」）——階段が上り切った先の床が、そこから外側へ続くことを示す線。
 * どちらもプロファイルの実座標から求める（面やレーンの幾何を作図側で再構成しない）。
 * @param {object[]} wallContent - emitColumns等の出力（この配列は変更せず新しい配列を返す）
 * @param {object[]} stairContent - stairPrimitivesForCutの出力
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{ceilLowAbs:number, floorHeight:number, drawLo:number, drawHi:number}} ref
 */
export function joinToStairProfile(wallContent, stairContent, cut, ref) {
  const profile = stairContent.find(p =>
    p.type === 'polyline' && p.weight === weightForRole(ElevationLineRole.CUT) && p.points?.length > 1);
  if (!profile) return wallContent;
  const out = wallContent.map(p => ({ ...p }));

  // 1. 1F天井断面線を階段断面との交点まで伸ばす。
  const meetX = profileXAtZ(profile.points, ref.ceilLowAbs);
  if (meetX != null) {
    for (const p of out) {
      if (p.type !== 'line' || Math.abs(p.y1 - p.y2) > GAP_EPS) continue;
      if (Math.abs(-p.y1 - ref.ceilLowAbs) > GAP_EPS) continue;
      const lo = Math.min(p.x1, p.x2), hi = Math.max(p.x1, p.x2);
      if (meetX > hi + GAP_EPS) { p.x1 = lo; p.x2 = meetX; }        // 右へ伸ばす
      else if (meetX < lo - GAP_EPS) { p.x1 = meetX; p.x2 = hi; }   // 左へ伸ばす
    }
  }

  // 2. 階段断面の上り切り（2FL）から床断面線を外側へ張り出す。
  const top = profile.points.reduce((a, b) => (-b[1] > -a[1] ? b : a));
  if (Math.abs(-top[1] - ref.floorHeight) < GAP_EPS) {
    const toLo = Math.abs(top[0] - ref.drawLo) <= Math.abs(ref.drawHi - top[0]);
    const endX = toLo ? ref.drawLo : ref.drawHi;
    if (Math.abs(endX - top[0]) > GAP_EPS) {
      out.push(emitLine(cut, top[0], ref.floorHeight, endX, ref.floorHeight,
        ElevationLineRole.SILHOUETTE, { ceilZ: cut.zRange?.hiZ }));
    }
  }
  return out;
}

/**
 * SectionColumn[] → アキのX（対角線2本。AMBIGUITY E）のプリミティブ列。
 * kind==='open' の band、および openingPassThrough:true が付いた band（kind問わず。§5.4・
 * WP-E7でopeningがこのフラグを立てる想定——本関数自体はフラグの由来を問わない）を
 * 「アキ扱い」とみなし、列をまたいでz範囲が重なるもの同士を連結成分としてまとめてから
 * 1組ずつXを描く（defer D1「開口が2階アキと連続する場合の1つの大きなX」の一般規則。§7）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{ceilZ?:number}} [emitCtx]
 * @returns {object[]}
 */
export function emitOpenGapMarks(columns, cut, emitCtx = {}) {
  const ceilZ = emitCtx.ceilZ;
  // **床断面の延長端（壁のない端部のはね出し）にはアキを描かない**（ユーザー明示指示2026-08
  // 「床断面延長端に『アキ・バツ』は描画不要」）——延長は「線を図の外へ延ばす」ために探査範囲を
  // 広げたぶんで、そこは面の外。面の外に「その面に壁が無い」という標記を出す意味がない。
  // 面自身の範囲は`cut.line.lo/hi`（探査延長`probeExtendLo/HiMm`を含まない値）で決まる。
  // **実画面で「ア キ」を置けない幅の区間には、アキ標記そのものを出さない**（ユーザー実機指摘
  // 2026-08「「5」C2: 1階400の『アキ・バツ』が省略されない」）——壁2段書きの省略判定と同じ考え方。
  // scale（px/mm）未指定（単体テスト・ゴールデン）では判定せず従来どおり全て描く。
  const minGapWidthMm = emitCtx.scale ? GAP_LABEL_WIDTH_PX / emitCtx.scale : 0;
  const endA = localXOf(cut, cut.line.lo), endB = localXOf(cut, cut.line.hi);
  const faceLoX = Math.min(endA, endB), faceHiX = Math.max(endA, endB);
  const cells = [];
  columns.forEach((col, colIndex) => {
    for (const b of col.bands) {
      // **切断壁（面を横切る壁）の天端の上の空気は「その面のアキ」ではない**——アキはその面の
      // 平面に壁が無い範囲の標記であって、直交する壁を越えた先の空間はこの面の穴ではない。
      // これを混ぜると、連結成分が腰壁の断面の厚みの中へ食い込み、バツの端点が壁の断面の
      // 手前の縁×天端の位置に落ちる（ユーザー実機指摘2026-08「「5」D1: 2階のバツが、
      // Y1から2000CL側、開口端部を正しく拾っていない」）。
      // **面の平面にある腰壁の天端の上（＝本当のアキ）は下が'wall'帯なので影響しない**
      // ——「6」Cの「バツ左下点は左側壁断面と腰壁上端の交点へ」はそちらの構成で、従来どおり。
      const overCutWall = col.bands.some(x => x.kind === 'cut' && Math.abs(x.z1 - b.z0) < GAP_EPS);
      if ((b.kind === 'open' || b.openingPassThrough) && !overCutWall) {
        // viaOpening: 建具の開口として抜けている区間。**アキ標記（矩形＋「ア キ」）は付けない**
        // ——そこは建具の姿図が描く場所であり「アキ」ではない（バツは従来どおり出す。
        // 「開口が2階アキと連続する場合は1組の大きなX」の確認済み仕様を壊さないため）。
        const x0 = Math.max(col.x0, faceLoX), x1 = Math.min(col.x1, faceHiX);
        if (x1 - x0 <= GAP_EPS) continue; // 面の外（延長ぶん）だけの列
        cells.push({ colIndex, x0, x1, z0: b.z0, z1: b.z1,
          viaOpening: b.kind !== 'open' || b.openingPassThrough === true });
      }
    }
  });

  // 連結成分（列インデックスが隣接し、z範囲が重なるセル同士を1つにまとめる）。
  const groups = [];
  for (const cell of cells) {
    const touching = groups.filter(g => g.some(c =>
      Math.abs(c.colIndex - cell.colIndex) <= 1 && overlapsZ(c, cell)));
    if (touching.length === 0) { groups.push([cell]); continue; }
    const [target, ...rest] = touching;
    target.push(cell);
    for (const other of rest) {
      target.push(...other);
      groups.splice(groups.indexOf(other), 1);
    }
  }

  const prims = [];
  for (const g of groups) {
    const x0 = Math.min(...g.map(c => c.x0));
    const x1 = Math.max(...g.map(c => c.x1));
    if (x1 - x0 < minGapWidthMm) continue; // 標記を置けない幅＝アキ・バツごと省略
    const z0 = Math.min(...g.map(c => c.z0));
    const z1 = Math.max(...g.map(c => c.z1));
    // **バツの4点は空き面の実際の隅**（ユーザー実機指摘2026-08「6」C「バツの４点は、空き面の
    // 最も大きい対角を頂点とする」「2Fのアキ・バツ左下点は、左側壁断面と腰壁上端の交点へ移動」）。
    // 外接矩形の隅は、成分がL字（腰壁が食い込む等）だとアキでない場所に落ちる。左右それぞれの
    // 端にあるセルのz範囲から、その端での実際の上下を取る（矩形なら外接矩形と一致＝挙動不変）。
    const atX = x => g.filter(c => c.x0 <= x + GAP_EPS && c.x1 >= x - GAP_EPS);
    const edgeZ = (x, fallbackLo, fallbackHi) => {
      const cs = atX(x);
      return cs.length
        ? { lo: Math.min(...cs.map(c => c.z0)), hi: Math.max(...cs.map(c => c.z1)) }
        : { lo: fallbackLo, hi: fallbackHi };
    };
    const L = edgeZ(x0 + GAP_EPS, z0, z1);
    const R = edgeZ(x1 - GAP_EPS, z0, z1);
    // **開放スパンのアキは高低差に追従する**（ユーザー裁定2026-09「高低差」＝バツの床は遠側床に
    // 着く）——下端は遠側の床、上端は近側/遠側の天井の低い方（既存の「開放先の天井が低ければ
    // そこまで」と同じ規約）。判定材料（遠側のFL/CH）は探査では得られないため、呼び出し側が
    // `cut.openSpans`（値の出どころは face.spans）で渡す。該当しないアキ（探査で見つかる通常の
    // 壁なし区間）は従来どおり探査どおりのz範囲のまま。
    // **far値が引けないときはクランプしない**（＝探査どおりのz。「値が無いのに帯の床と断定する」
    // のは安全側ではない——実機で下端が帯の床へ引き上げられる不具合になった）。
    // 連結成分に複数の開放スパンが掛かりうるため、**重なりが最大のもの**を採る
    // （最初の1件だと、端が僅かに掛かっただけの別スパンのfar値を使ってしまう）。
    const span = (cut.openSpans ?? [])
      .map(sp => ({ sp, ov: Math.min(sp.hiX, x1) - Math.max(sp.loX, x0) }))
      .filter(c => c.ov > GAP_EPS)
      .sort((a, b) => b.ov - a.ov)[0]?.sp;
    const farFloorZ = span && Number.isFinite(span.farFloorZ) ? span.farFloorZ : null;
    const farCeilZ = span && Number.isFinite(span.farCeilZ) ? span.farCeilZ : null;
    // 下端（ユーザー裁定2026-09の3点で確定）: **遠側床が帯の床より高いときだけ**そこまで持ち上げる
    // ——その下は遠側の床スラブで塞がれていてアキではない。それ以外（遠側が帯の床と同じ／低い）は
    // **探査が見つけた床のまま**にする。探査はその位置の実際の床（部分指定の段差・遠側の一段違う床）を
    // 既に見つけており、far値で上書きすると必ずどちらかの実機ケースが壊れる:
    //   「11'」A2左（far=-100・遠側が一段上の床）→ 探査どおり（遠側床まで下げない）
    //   「10」D1（far=0・近側の床が下がっている）→ 探査どおり（帯の床へ引き上げない）
    //   遠側床が帯の床より高い構成 → 遠側床まで持ち上げる
    const spanLoZ = z => (farFloorZ != null && farFloorZ > GAP_EPS ? farFloorZ : z);
    const spanHiZ = z => (farCeilZ == null ? z : Math.min(z, farCeilZ));
    const LC = { lo: spanLoZ(L.lo), hi: spanHiZ(L.hi) };
    const RC = { lo: spanLoZ(R.lo), hi: spanHiZ(R.hi) };
    // §5.6: baseFloorZより上=一点鎖線(center)、床断面より下=破線(dashed)。連結成分がbaseFloorZを
    // またぐ（D1の「開口+上階アキ」等）場合は、床断面より下へ到達している時点でdashedを選ぶ
    // （ASSUMED: 設計書はこの併合時の様式を明記していないため、より弱い表現＝dashedを安全側の
    // 既定にした。報告に明記する）。
    const dash = z0 >= (cut.baseFloorZ ?? 0) - GAP_EPS ? 'center' : 'dashed';
    // **バツは実体（腰壁等）と交差する区間をクリップする**（ユーザー実機指摘2026-08「6」C
    // 「バツが、腰壁と交差する場合、腰壁内はクリップして描画しない」）。連結成分の外接矩形
    // いっぱいに対角線を引くため、成分に食い込む壁の上を線が通ってしまう。
    // 差し引くのは**実体の帯だけ**（wall/cut/cutAlong。ただし開口貫通は成分の一部なので除く）
    // ——「アキのセルの和」でクリップすると、開口と上階アキがL字に連結する構成で
    // 「1組の大きなX」（WP-E7 D1の確認済み仕様）が細切れになるため採らない。
    const blockers = obstructionRects(columns, x0, x1,
      Math.min(z0, LC.lo, RC.lo), Math.max(z1, LC.hi, RC.hi));
    // アキ標記の「ア キ」（旧 elevationFigure.js の appendGapMark から移設）。次の3条件を
    // すべて満たす連結成分にだけ付ける:
    //   - 建具の開口を含まない（viaOpening）… そこは建具の姿図の場所で「アキ」ではない
    //   - 外接矩形そのもの（全セルが同じz範囲）… L字に食い込んだ成分では外接矩形の中心が
    //     アキでない場所（腰壁の上等）に落ち、文字が実体の上に乗る
    //   - 床断面より上（dash==='center'）… 床断面より下の抜けは「向こう側の断面＝細線の破線」で、
    //     そこへ実線の標記を足すのは線種の規則に反する
    //
    // **輪郭の矩形は描かない**（ユーザー明示指示「矩形をやめて」）——アキの輪郭は定義上つねに
    // 周囲の実体（壁の断面・床/天井の断面線・腰壁の天端・面端の縦線）と一致するため、矩形として
    // 独立に描くと必ず二重になる。しかも矩形は中線なので、後から重なって**断面＝太線という
    // 線種の情報を上書きしてしまう**（実機「5」A: X2通りの壁の断面（太線）の上に、アキ矩形の
    // 左辺（中線）が重なっていた）。抜けの範囲はバツと「ア キ」で足りる。
    const isRect = g.every(c => Math.abs(c.z0 - z0) < GAP_EPS && Math.abs(c.z1 - z1) < GAP_EPS);
    if (!g.some(c => c.viaOpening) && isRect && dash === 'center') {
      // 中心はクランプ後のz範囲（バツと同じ範囲）で採る——線と文字が食い違わないため。
      const tLo = Math.min(LC.lo, RC.lo), tHi = Math.max(LC.hi, RC.hi);
      prims.push({ type: 'text', x: (x0 + x1) / 2, y: zToY((tLo + tHi) / 2),
        text: 'ア キ', anchor: 'middle', baseline: 'middle' });
    }
    for (const [a, b] of [[[x0, LC.lo], [x1, RC.hi]], [[x0, LC.hi], [x1, RC.lo]]]) {
      const line = emitLine(cut, a[0], a[1], b[0], b[1], ElevationLineRole.DETAIL, { dash, ceilZ });
      prims.push(...subtractRectsFromLine(line, blockers));
    }
  }
  return prims;
}
