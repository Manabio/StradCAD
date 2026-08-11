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
import { StairType } from '@core';
import { measureStairSpans } from '../finish/stair/stairClassify.js';
import { MIN_LANDING } from '../finish/stair/stairGeometry.js';
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
  if (!stair || stair.type !== StairType.SWITCHBACK || floorHeight == null) return [];

  const totalSteps = Math.max(2, stair.totalSteps ?? 2);
  const riser = stair.riser ?? floorHeight / totalSteps;
  const sections = Array.isArray(stair.sections) && stair.sections.length === 3 ? stair.sections : null;
  // sections未指定（旧データ・上階自動設置分）は対称な折返しと仮定して均等2分する（解釈の判断）。
  const n1 = sections ? Math.max(1, sections[0]) : Math.round(totalSteps / 2);
  const n2 = sections ? Math.max(1, sections[2]) : totalSteps - n1;

  const spans = measureStairSpans(stair, graph);
  const tread = stair.tread > 0 ? stair.tread : 250;
  const [len1, landingLen, len2] = spans?.lengths ?? [
    tread * Math.max(1, n1 - 1),
    Math.max(4 * tread, MIN_LANDING),
    tread * Math.max(1, n2 - 1),
  ];

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
