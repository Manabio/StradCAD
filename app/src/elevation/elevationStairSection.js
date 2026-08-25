/**
 * 展開図: 折返し階段（SWITCHBACK）の断面プロファイル（項目12）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * 「既存の階段データを再利用」の実体: 区間長は finish/stair/stairClassify.js の
 * measureStairSpans（実測。歩行順 [往路レーン長, 踊り場の深さ, 復路レーン長]）を使う
 * （stair-model.mdの「区間長は実測優先・合成フォールバック」と同じ規約）。区間別の段数
 * （往路n1・復路n2）は stair.sections（歩行順・偶数index=直進部の実段数）の該当要素を使い、
 * 無ければ totalSteps を均等2分（対称な折返しという仮定。解釈の判断）。
 *
 * ローカル座標は elevationFigure.js と同じ（x=0起点、yは上向き負・床=0）。
 */
import { resolveSwitchbackSpanLengths } from '../finish/stair/stairClassify.js';
import { ElevationLineRole, weightForRole, GAP_EPS_MM as GAP_EPS } from './elevationStyle.js';

/**
 * 直進区間1本ぶんの踏面プロファイル（蹴上→踏面を段数ぶん繰り返すジグザグ線）をローカル座標で作る。
 * 最終段の踏面は次区間（踊り場・上階床）の床がその役割を兼ねるため出さない
 * （.claude/stair-model.md「直進部（実段数n）: マス n-1」と同じ考え方の側面表現）。
 * @param {number} n - 段数（蹴上の実数）
 * @param {number} riserMm
 * @param {number} runLengthMm - 区間の実測ぶんの走行長（歩行方向の総水平距離）
 * @param {number} startX
 * @param {number} startY - 区間開始時点の高さ（y、上向き負）
 * @param {1|-1} dir - 歩行方向（+1=右へ、-1=左へ）
 * @param {number} [nosingMm] - 蹴込(mm。`Stair.nosing`)。0（既定）なら従来どおり蹴上＝段鼻の
 *   真下で、点列・その並び（段鼻＝奇数index）は一切変わらない。>0なら蹴上を蹴込ぶん奥へ引っ込め、
 *   段鼻の出を1本の水平セグメントとして点列へ挟む（ユーザー実機指摘2026-08「階段の蹴上、踏面に
 *   加え、蹴込を20で描画」）。
 * @returns {{points:Array<[number,number]>, noses:Array<[number,number]>, endX:number, endY:number}}
 *   noses は段鼻（各段の踏面の先端）。蹴込を入れると点列の刻みが1段2点→3点に変わるため、
 *   **消費側がindexの偶奇から段鼻を推測できなくなる**——ここで明示的に返す（ささらの上端線は
 *   この段鼻列から作る。stringerPrimitives参照）。
 */
export function stairRunProfile(n, riserMm, runLengthMm, startX, startY, dir = 1, nosingMm = 0) {
  const steps = Math.max(1, Math.round(n));
  // 踏面（段鼻〜段鼻のピッチ）は **区間長 ÷ (段数−1)**（ユーザー実機検算2026-08「3500左CLの上が
  // 1段目踏面、右へ2500いったところが踊り場高さ、かつ11段目」＝10ピッチ×250）。区間長は
  // 「1段目の位置〜次区間（踊り場・上階床）の床の位置」であり、その間に現れる踏面はsteps−1枚
  // ——最終段の踏面は次区間の床が兼ねる（本関数のヘッダの既存仕様）。
  // 旧実装は `runLengthMm / steps` で割っており、踏面が1枚ぶん細く・最終段の踏面も余分に描いていた。
  const treadMm = steps > 1 ? runLengthMm / (steps - 1) : runLengthMm;
  // 蹴込は踏面を超えない（超えると蹴上が前段の段鼻より手前へ回り込み、輪郭が自己交差する）。
  const k = Math.max(0, Math.min(nosingMm || 0, treadMm));
  const points = [];
  const noses = [];
  let x = startX, y = startY; // x は「現在の段の段鼻」の位置（蹴上の足元は x+dir*k）
  points.push([x + dir * k, y]); // 上り口の床は蹴上の足元（段鼻から蹴込ぶん奥）で階段に接する
  for (let i = 0; i < steps; i++) {
    y -= riserMm;
    // 蹴上は**斜めの断面**（ユーザー実機指摘2026-08「踊り場への上り、最後の蹴上面も蹴込つけて
    // 斜め断面に」）——足元(x+dir*k)から段鼻(x)へ1本の斜線で上がる。蹴込0なら垂直になり
    // 従来と完全に同一（点列も同じ）。**最終段（踊り場への上り）も同じループで処理する**ので
    // 例外扱いは要らない。
    points.push([x, y]);
    noses.push([x, y]);
    // 最終段の踏面は描かない（次区間の床が兼ねる）。区間の総走行長は (steps-1)*treadMm =
    // runLengthMm のままなので endX は従来と同じ＝呼び出し側の配置は不変。
    // 踏面は段鼻から次の蹴上の足元まで＝踏面ピッチ＋蹴込ぶんの水平線。
    if (i < steps - 1) { x += dir * treadMm; points.push([x + dir * k, y]); }
  }
  return { points, noses, endX: x, endY: y };
}

/**
 * 折返し階段（SWITCHBACK）の断面計算パラメータ（区間長・段数・蹴上）を単一ソース化する（WP-S1）。
 * buildSwitchbackSectionPrimitives（本ファイル）と elevationStairSequence.js（歩行順面シーケンス）が
 * 共有する——両者とも「往路n1・復路n2の段数」「実測優先・合成フォールバックの区間長」という
 * 同じ計算を必要とするため、既存のbuildSwitchbackSectionPrimitives内にあった計算をここへ抽出した
 * （既存exportの挙動・出力は一切変えない。抽出のみ）。
 * SWITCHBACK以外・floorHeight未確定の場合はnull。
 * WP-A1: floorHeightに依存しない区間長・段数の算出自体は finish/stair/stairClassify.js の
 * resolveSwitchbackSpanLengths（本関数とfinish/stair/stairLanding.jsのlandingRectが共有する
 * 単一情報源）へ抽出した。本関数はそこへfloorHeight由来のriserを合成するだけ（挙動不変）。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {number|null} floorHeight - 設置階〜上階の階高(mm)
 * @returns {{totalSteps:number, riser:number, n1:number, n2:number,
 *   len1:number, landingLen:number, len2:number}|null}
 */
export function resolveSwitchbackParams(stair, graph, floorHeight) {
  if (floorHeight == null) return null;
  const spanInfo = resolveSwitchbackSpanLengths(stair, graph);
  if (!spanInfo) return null;
  const riser = stair.riser ?? floorHeight / spanInfo.totalSteps;
  return { ...spanInfo, riser };
}

/**
 * 折返し階段（SWITCHBACK）の断面プロファイル一式（往路・踊り場・復路）をローカル座標で返す。
 * SWITCHBACK以外・floorHeight未確定の場合は空配列（非対応タイプは項目12のスコープ外。
 * WINDING等の回り階段は扇形の段になり同じ直進プロファイルが使えないため今回は対応しない）。
 * 線種: 踏面のジグザグ(見え掛かりの段)=SILHOUETTE、踊り場の床線(区間を画す面)=CUT
 * （ユーザー仕様「切断面=太、見え掛かりの段は中を基本に」の解釈。踊り場は上階側へ抜ける
 * 床の切断とみなしCUT扱いにした）。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {number|null} floorHeight - 設置階〜上階の階高(mm)
 * @returns {object[]} プリミティブ配列（x=0起点。呼び出し側でxCursor分translateする）
 */
export function buildSwitchbackSectionPrimitives(stair, graph, floorHeight) {
  const params = resolveSwitchbackParams(stair, graph, floorHeight);
  if (!params) return [];
  const { n1, n2, riser, len1, landingLen, len2 } = params;

  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);
  const prims = [];

  const run1 = stairRunProfile(n1, riser, len1, 0, 0, 1);
  prims.push({ type: 'polyline', points: run1.points, weight: silhouetteWeight });

  const landingY = run1.endY;
  const landingX2 = run1.endX + landingLen;
  prims.push({ type: 'line', x1: run1.endX, y1: landingY, x2: landingX2, y2: landingY, weight: cutWeight });

  const run2 = stairRunProfile(n2, riser, len2, landingX2, landingY, 1);
  prims.push({ type: 'polyline', points: run2.points, weight: silhouetteWeight });

  return prims;
}

// ---- WP-S1: 歩行順面シーケンス（elevationStairSequence.js）向けの追加部品 ----

// 鉄骨階段のささら（ささら桁）の板厚・せい（成）。Stairモデルに桁成フィールドが無いため、
// 作図上の既定値としてローカル定数に持つ（将来 Stair 側にフィールド化する余地を残すコメント）。
// 出典: http://kentiku-kouzou.jp/struc-sasara.html「最低でも12mm厚で、プレートのせいは
// 250～300程度」——せいは上限の300mmを採用（変形・強度に余裕を持たせる側の値）。
// STEEL_STRINGER_DEPTH_MMは旧実装（WP-S1〜WP-E5b時点）ではCUT表現時代の作図上の仮値200mmだった
// ものを、ページ記載の実寸法へ更新した（挙動変更。ユーザー指示「ささらを展開に反映」対応）。
export const STEEL_STRINGER_DEPTH_MM = 300;
// ささら（プレート）の板厚。正面視（切断面がFlightに直交する見返り）で見える12mm×せいの
// 矩形断面の横幅に使う（sectionStair.js）。側面視のstringerPrimitivesは板厚を使わない
// （輪郭は段鼻を結ぶ線とその平行線の2本だけで表現するため）。
export const STEEL_STRINGER_THICKNESS_MM = 12;
// 踊り場桁枠（front/back/side桁）のせい（WP-A2。ユーザー裁定2026-08-23で250→300へ変更——
// ささら（斜め部。STEEL_STRINGER_DEPTH_MM=300）と同値。板厚12共通）。
export const STEEL_LANDING_FRAME_DEPTH_MM = 300;

/**
 * 段鼻高さごとの水平「梯子状」細線一式（ユーザー仕様「階段直進部上を正面または踊り場から
 * 見返りで見た展開は、踏面を梯子状に細線」）。baseAbsMm（この区間の下端の絶対高さ。設置階FL=0
 * 基準）から riserMm 刻みで steps 段ぶん、[loX,hiX] の全幅に水平線を引く。
 * dashed=true（踊り場より下等、見えがかりが破線になる区間）は 'dashed' の line として返す
 * （破線は必ず line プリミティブで出す——レンダラの polyline 分岐は dash 非対応のため）。
 * @param {{loX:number, hiX:number, riserMm:number, steps:number, baseAbsMm:number, dashed?:boolean}} p
 * @returns {object[]}
 */
export function treadLadderLines({ loX, hiX, riserMm, steps, baseAbsMm, dashed = false }) {
  const weight = weightForRole(ElevationLineRole.DETAIL);
  const n = Math.max(0, Math.round(steps));
  const out = [];
  for (let k = 1; k <= n; k++) {
    const y = -(baseAbsMm + k * riserMm);
    out.push({
      type: 'line', x1: loX, y1: y, x2: hiX, y2: y, weight,
      ...(dashed ? { dash: 'dashed' } : {}),
    });
  }
  return out;
}

/**
 * 鉄骨階段のささら（ささら桁）プロファイル: profilePoints（stairRunProfile等が返す蹴上・踏面の
 * ジグザグ点列）の段鼻（凸点列＝奇数index。蹴上通過直後・踏面通過前の点。等ピッチの階段では
 * 一直線に並ぶ）を結ぶ直線から、法線方向へ depthMm ぶん下げた平行線を作り、両端を閉じた
 * 1本の polyline（DETAIL＝見えがかりの細線）として返す。
 * ユーザー指示「ささらの見えかがりは細線、断面は太線」対応: 段部はささらの横に付く（横付け）の
 * が一般的（出典ページ「段部はササラの横につく納まりが一般的」）ため、段鼻を結ぶ上縁から下は
 * 段板の木口がささらに隠れて見えない——側面視（レーンを縦断する切断）でこの輪郭を見た目どおり
 * DETAIL（細線）で描く。太線(CUT)はささらが実際に切断される正面視（レーンを横切る切断）側
 * （sectionStair.jsのflightStringerFrontPrimitives）に割り当てた。旧実装（WP-S1〜WP-E5b）は
 * このpolyline自体をCUTにしていた——側面視の見えがかりを太線扱いしていた誤りを本対応で修正する。
 * @param {Array<[number,number]>} profilePoints - stairRunProfile(...).points 等のジグザグ点列
 * @param {number} depthMm - ささらの桁成（見付幅）
 * @returns {object[]} 0または1件のpolylineプリミティブ配列
 */
/**
 * ささらの帯（上端線・下端線）の幾何を返す。`stringerPrimitives`（描画）と
 * `sectionStair.js`（踊り場桁枠の下端をこの帯とのトリム点で切る）が**同じ交点を共有する**ための
 * 単一情報源——別々に計算すると1本の取り合いが2つの位置に分裂する。
 *
 * 上端 = 段鼻の勾配線を巾木高さぶん上げた線。下端 = 上端を法線方向へ`depthMm`（ささらのせい）
 * 平行移動した線。
 *
 * **トリム結合（ユーザー実機指摘2026-08「直進部の斜めささらと踊り場ささら（上下共）は、
 * トリム結合して取り合う」）**: `opts.mitreDepthMm`（踊り場桁枠のせい）を渡すと、その端の
 * 下端の角を「上端のその端の高さ＋mitreDepthMm」の**水平線との交点**へ移す。踊り場桁枠の
 * 下端はこの水平線そのもの（桁枠は鉛直にせいを取る）なので、斜めささらの法線オフセットとの
 * 交差角がここで解消し、2本の下端が1点で継がる。上端は元々この端で一致している（段鼻の
 * 最終点＝踊り場床）ため、上下とも取り合う。
 * @param {Array<[number,number]>} nosings - 段鼻列（昇順・2点以上）
 * @param {number} depthMm
 * @param {{baseboardMm?:number, mitreDepthMm?:number, mitreStart?:boolean, mitreEnd?:boolean}} [opts]
 * @returns {{top:[[number,number],[number,number]], bottom:[[number,number],[number,number]]}|null}
 */
export function stringerBandGeometry(nosings, depthMm, opts = {}) {
  if (!nosings || nosings.length < 2) return null;
  const lift = Math.max(0, opts.baseboardMm ?? 0);
  const p1 = [nosings[0][0], nosings[0][1] - lift];
  const p2 = [nosings[nosings.length - 1][0], nosings[nosings.length - 1][1] - lift];
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1;
  // 法線（下方向=yが増える側を正にする。階段の下＝ささら側という前提）。
  let nx = -dy / len, ny = dx / len;
  if (ny < 0) { nx = -nx; ny = -ny; }
  const ox = nx * depthMm, oy = ny * depthMm;
  let b1 = [p1[0] + ox, p1[1] + oy];
  let b2 = [p2[0] + ox, p2[1] + oy];
  const mitreD = opts.mitreDepthMm;
  // 下端線（方向(dx,dy)）と水平線 y=targetY の交点。dy===0（水平なささら＝あり得ない）は素通し。
  const mitreTo = (b, targetY) => {
    if (Math.abs(dy) < GAP_EPS) return b;
    const t = (targetY - b[1]) / dy;
    return [b[0] + t * dx, targetY];
  };
  if (mitreD != null && opts.mitreStart) b1 = mitreTo(b1, p1[1] + mitreD);
  if (mitreD != null && opts.mitreEnd)   b2 = mitreTo(b2, p2[1] + mitreD);
  return { top: [p1, p2], bottom: [b1, b2] };
}

export function stringerPrimitives(profilePoints, depthMm, zBounds, opts = {}) {
  // 段鼻列は呼び出し側が明示的に渡す（stairRunProfile(...).noses）。未指定時のみ従来の
  // 「奇数index＝段鼻」ヒューリスティックへフォールバックする——蹴込>0では1段の点列が
  // 2点→3点になり偶奇では拾えないため（elevationStairSection.jsのstairRunProfile参照）。
  const nosings = opts.noses ?? profilePoints.filter((_, i) => i % 2 === 1);
  if (nosings.length < 2) return [];
  // ユーザー実機指摘2026-08「鉄骨階段ささらの上端は、踏面先端で巾木同寸」: 上端線は段鼻を
  // 結ぶ勾配線そのものではなく、そこから**巾木高さぶん上**（yは上向き負なので減算）。
  // これにより上端が踊り場桁枠side辺の上端（`landing.z + baseboardHeightMm`。sectionStair.jsの
  // landingFramePrimitives）と**踊り場の縁でちょうど一致**する——最後の段鼻の高さが
  // landing.zそのものだから。「直進部の斜めささらと踊り場ささらはトリム結合して取り合う」の
  // 上端側はこれで自動的に成立する（下端側は勾配の法線オフセットと踊り場の鉛直せいが
  // 交差するため、別途トリムが要る。未対応=defer）。
  const band = stringerBandGeometry(nosings, depthMm, opts);
  if (!band) return [];
  const { top: [[x1, y1], [x2, y2]], bottom: [b1, b2] } = band;
  const points = [[x1, y1], [x2, y2], b2, b1, [x1, y1]];
  // 実機フィードバック第3弾B: オフセット後の多角形は、法線オフセット(ox,oy)ぶん元のnosing線
  // （flightの端の1つ内側のnosingを結ぶ線。flight自身の始端・終端ちょうどではない）よりFL側へ
  // はみ出すことがある（せいdepthMmぶん下げる方向＝階段の下＝floorへ向かう方向のため）。
  // z=baseZ・z=baseZ+steps×riser（ローカルy=zBounds.yHi/yLo。flightZBoundsと同じ規約）の
  // 水平面でSutherland–Hodgman相当の単純な半平面クリップを行い、FLを超えた突き出しを切る
  // （clipStringerToAnchors「ジグザグ点列の端点をFLへ強制的に揃える」対応の、オフセット後
  // 多角形版）。zBounds未指定（既存呼び出し）は挙動不変。
  const clippedPoints = zBounds ? clipPolygonToYRange(points, zBounds.yLo, zBounds.yHi) : points;
  if (clippedPoints.length < 3) return [];
  return [{ type: 'polyline', points: clippedPoints, weight: weightForRole(ElevationLineRole.DETAIL) }];
}

// [x,y]の閉多角形（points[0]===points[末尾]の重複終点あり・無し両対応）を、y<=yHi・y>=yLo
// の2つの半平面でSutherland–Hodgman法によりクリップする（実機フィードバック第3弾B）。
// yLo/yHiのいずれかがnullなら該当する側の半平面クリップを省略する。
function clipPolygonToYRange(points, yLo, yHi) {
  let poly = points;
  if (poly.length > 1) {
    const [fx, fy] = poly[0], [lx, ly] = poly[poly.length - 1];
    if (Math.abs(fx - lx) < GAP_EPS && Math.abs(fy - ly) < GAP_EPS) poly = poly.slice(0, -1); // 重複終点を除去
  }
  if (yHi != null) poly = clipHalfPlaneY(poly, y => y <= yHi + GAP_EPS, yHi);
  if (yLo != null) poly = clipHalfPlaneY(poly, y => y >= yLo - GAP_EPS, yLo);
  if (poly.length === 0) return [];
  return [...poly, poly[0]]; // 閉多角形として再度終点を閉じる（呼び出し側の既存出力形と揃える）
}

// Sutherland–Hodgman法の1半平面ぶんのクリップ（keepFn(y)がtrueの頂点を保持し、境界を跨ぐ辺には
// 交点(x, boundaryY)を挿入する）。
function clipHalfPlaneY(poly, keepFn, boundaryY) {
  if (poly.length === 0) return poly;
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const curr = poly[i];
    const prev = poly[(i - 1 + n) % n];
    const currIn = keepFn(curr[1]);
    const prevIn = keepFn(prev[1]);
    if (currIn) {
      if (!prevIn) out.push(intersectAtY(prev, curr, boundaryY));
      out.push(curr);
    } else if (prevIn) {
      out.push(intersectAtY(prev, curr, boundaryY));
    }
  }
  return out;
}

function intersectAtY(a, b, boundaryY) {
  const [ax, ay] = a, [bx, by] = b;
  const t = Math.abs(by - ay) < GAP_EPS ? 0 : (boundaryY - ay) / (by - ay);
  return [ax + t * (bx - ax), boundaryY];
}
