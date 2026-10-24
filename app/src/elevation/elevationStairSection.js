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
 *
 * 断面エンジン（section/）が引く部品（stairRunProfile・resolveUTurnSectionParams・ささらの帯・
 * 鉄骨/木造の寸法定数）は section/stairSectionProfile.js へ移した（展開図リファクタ S1。
 * section/ から親ディレクトリへ逆向きに import しないため）。既存の import 先を変えないよう
 * 下で再公開する。帯ビルダーと断面エンジンの交差そのものの整理は S7 の範囲。
 */
import { StructuralMaterialType } from '@core';
import { resolveSwitchbackSpanLengths } from '../finish/stair/stairClassify.js';
import { ElevationLineRole, ElevationDash, weightForRole } from './elevationStyle.js';
import { line, polyline } from './elevationPrimitives.js';
import {
  WOOD_TREAD_THICKNESS_MM, stairRunProfile, resolveUTurnSectionParams, stringerBandGeometry, stringerPrimitives,
  STEEL_STRINGER_DEPTH_MM, STEEL_STRINGER_THICKNESS_MM, STEEL_LANDING_FRAME_DEPTH_MM,
} from './section/stairSectionProfile.js';

export {
  WOOD_TREAD_THICKNESS_MM, stairRunProfile, resolveUTurnSectionParams, stringerBandGeometry, stringerPrimitives,
  STEEL_STRINGER_DEPTH_MM, STEEL_STRINGER_THICKNESS_MM, STEEL_LANDING_FRAME_DEPTH_MM,
};

/**
 * 階段の断面線（flight の下側の輪郭）が**繋がっている＝階段下の空間が蹴込板で閉じている**か
 * （ユーザー裁定2026-10-08「主要構造が木造の階段…は、断面線が繋がっているか/いないか。蹴込板がなく、
 * 踏面だけで構成された階段は、（階段）下を描く」）。展開図の階段帯は、階段下部屋が無くても
 * これが true なら断面線より下（階段下）を描かない。鉄骨（ささら＋踏面で下が空く）は false＝
 * 従来どおり「階段下部屋の有無」だけで決まる。
 * 現状は WOOD ⇔ 蹴込板あり（WOOD_TREAD_THICKNESS_MM の輪郭は垂直の蹴込板を持つ）。RC も true
 * （ユーザー裁定2026-10-08: RC 階段は斜スラブで下面まで断面線が繋がる）。false は鉄骨（ささら＋踏面で下が空く）だけ。将来 Stair に
 * 「蹴込板なし」属性が入ったら、木造でもそれが立つ階段は false を返す（踏面だけの階段は下を描く）。
 * 属性は今は追加しない。
 * @param {{structure?:*}|null|undefined} stair
 * @returns {boolean}
 */
export function stairSectionIsClosed(stair) {
  return stair?.structure === StructuralMaterialType.WOOD || stair?.structure === StructuralMaterialType.RC;
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

  const prims = [];

  const run1 = stairRunProfile(n1, riser, len1, 0, 0, 1);
  prims.push(polyline(run1.points, ElevationLineRole.SILHOUETTE));

  const landingY = run1.endY;
  const landingX2 = run1.endX + landingLen;
  prims.push(line(run1.endX, landingY, landingX2, landingY, ElevationLineRole.CUT));

  const run2 = stairRunProfile(n2, riser, len2, landingX2, landingY, 1);
  prims.push(polyline(run2.points, ElevationLineRole.SILHOUETTE));

  return prims;
}

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
    out.push(line(loX, y, hiX, y, { weight, ...(dashed ? { dash: ElevationDash.DASHED } : {}) }));
  }
  return out;
}
