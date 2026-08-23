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
import { ElevationLineRole, weightForRole } from './elevationStyle.js';

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
 * @returns {{points:Array<[number,number]>, endX:number, endY:number}}
 */
export function stairRunProfile(n, riserMm, runLengthMm, startX, startY, dir = 1) {
  const steps = Math.max(1, Math.round(n));
  const treadMm = runLengthMm / steps;
  const points = [[startX, startY]];
  let x = startX, y = startY;
  for (let i = 0; i < steps; i++) {
    y -= riserMm;      points.push([x, y]); // 蹴上（垂直）
    x += dir * treadMm; points.push([x, y]); // 踏面（水平）
  }
  return { points, endX: x, endY: y };
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
export function stringerPrimitives(profilePoints, depthMm) {
  const nosings = profilePoints.filter((_, i) => i % 2 === 1);
  if (nosings.length < 2) return [];
  const [x1, y1] = nosings[0];
  const [x2, y2] = nosings[nosings.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // 法線（下方向=yが増える側を正にする。階段の下＝ささら側という前提）。
  let nx = -dy / len, ny = dx / len;
  if (ny < 0) { nx = -nx; ny = -ny; }
  const ox = nx * depthMm, oy = ny * depthMm;
  const points = [
    [x1, y1], [x2, y2], [x2 + ox, y2 + oy], [x1 + ox, y1 + oy], [x1, y1],
  ];
  return [{ type: 'polyline', points, weight: weightForRole(ElevationLineRole.DETAIL) }];
}
