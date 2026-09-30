// ================================================================
// CL削除・降格の事前確認向け: 指定CLを参照する固定材（dimensionStatus!=='auto' の柱・梁・基礎/柱脚）を
// 列挙する読み取り専用の純関数（手動追加材サイレント撤去回避 指示書§2.4・§2.6・§3裁定3・
// §4 Q3/Q4/Q5・§5 ステップ3）。
//
// CLを参照する構造材の列挙自体は core/planGraph.js の structuralRefsToCL（_structuralRefsToCLの薄い
// 公開ラッパ）へ委ねる（重複実装しない。core/planGraph.js _teardownCenterLineの道連れ削除判定と
// 同じ列挙を使う）。ここでは非autoでの絞り込み・階ごとの集計・確認文言の組み立てだけを行う。
//
// 対象材は柱・基礎/柱脚・梁（大梁）のみ（§3裁定1）。耐力壁・スリーブ・壁・一般Shapeは数えない
// （structuralRefsToCLの戻り値のうち shapes/walls/sleeves は無視する）。
//
// CLの種別では分岐しない（Q3）——「そのCLに固定材が乗っているか」の一般判定のみ行う。ただし
// 他階を見るかどうか（全階共通＝通り芯か）の判定にはcenterLineKindPolicy.jsのFLOOR_SHARED_KINDS
// （原始事実13・全階共有種別）を使う——通り芯は project.structGraph に置かれ全階で共有される唯一の
// 種別のため、他階の柱・梁・基礎もこのCLを参照しうる。梁芯・中心線は階固有の実体（graph.shapeMap）
// のため、他階に同じidの材が存在することはない（他階を見る必要が無い）。
//
// 純モジュール: react/.jsx/store.js/snap.js を静的 import しない（node:testから単体import可能に保つ。
// transform/centerLineFloorSync.jsが同条件でfloorSwapManager.peekを使っているのと同じ理由）。
// ================================================================
import { centerLineKind } from '../core.js';
import { FLOOR_SHARED_KINDS, BEAM_AXIS_KINDS } from '../core/centerLineKindPolicy.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { otherPlanes } from '../transform/centerLineFloorSync.js';

/** graph上でid（CL）を参照する固定材（非auto）だけを、柱・梁・基礎/柱脚の3種に分けて返す。
 *  @param {import('@core').PlanGraph} graph
 *  @param {string} clId
 *  @returns {{ columns: Array, beams: Array, footings: Array }}
 */
export function fixedMembersReferencing(graph, clId) {
  const refs = graph.structuralRefsToCL(clId);
  return {
    columns:  refs.columns.filter(c => c.dimensionStatus !== 'auto'),
    beams:    refs.beams.filter(b => b.dimensionStatus !== 'auto'),
    footings: refs.footings.filter(f => f.dimensionStatus !== 'auto'),
  };
}

function hasAnyFixedMember(counts) {
  return counts.columns.length > 0 || counts.beams.length > 0 || counts.footings.length > 0;
}

function floorEntry(plane, counts) {
  return { plane, columns: counts.columns.length, beams: counts.beams.length, footings: counts.footings.length };
}

/** cl を削除・降格したときに巻き込まれる固定材の本数を、階ごとに集計する（読み取り専用。副作用なし）。
 *  自階を先頭に、本数が1以上の階だけを返す。全階共通（通り芯。FLOOR_SHARED_KINDS）のときだけ
 *  他階（otherPlanes(project, activeGraph)。検討・屋根を含む）もfloorSwapManager.peekで走査する
 *  ——findFloorsBlockingGridDeletionと同じ流儀（本番同型peek。IDBから読み取り専用の一時グラフへ復元
 *  するだけで、graph・IDBは一切書かない）。peekが失敗したら例外をそのまま伝播する（呼び出し元で
 *  tagCLOpFailure経由のトーストになり、削除は始まらない＝無変更のまま中断する）。
 *  この「他階を見るか」の判定はFLOOR_SHARED_KINDS（原始事実13・全階共有種別か）であり、削除本体
 *  （deleteCenterLineWithUndo）が使うisGridCenterLine（labeled && struct＝グリッド軸＝丸ナンバーを
 *  持つ通り芯として作図・採番される軸か）とは意図が異なる——前者は「他階のグラフを読みに行く必要が
 *  あるか」という共有範囲の判定、後者は「作図・採番上の通り芯か」という表示・識別の判定であり、
 *  現状はどちらも同じCL集合（struct）を指すが、混同して一方を他方の代用にしない
 *  （core/centerLineKindPolicy.js「原始事実13」節参照）。
 *  @param {object} project
 *  @param {import('@core').PlanGraph} activeGraph 自階（削除・降格を実行しようとしている階）
 *  @param {import('@core').CenterLine} cl
 *  @returns {Promise<Array<{ plane: object, columns: number, beams: number, footings: number }>>}
 */
export async function collectFixedMembersByFloor(project, activeGraph, cl) {
  const result = [];
  const selfCounts = fixedMembersReferencing(activeGraph, cl.id);
  if (hasAnyFixedMember(selfCounts)) result.push(floorEntry(activeGraph.plane, selfCounts));

  if (FLOOR_SHARED_KINDS.includes(centerLineKind(cl))) {
    for (const plane of otherPlanes(project, activeGraph)) {
      const temp = await floorSwapManager.peek(plane, project.structGraph);
      const counts = fixedMembersReferencing(temp, cl.id);
      if (hasAnyFixedMember(counts)) result.push(floorEntry(plane, counts));
    }
  }
  return result;
}

/**
 * cl を参照する固定材（非auto。fixedMembersReferencingと同じ集合）を、graphから実際に削除する
 * （手動追加材サイレント撤去回避 指示書§2.4・§3裁定4・§5ステップ4）。確認の本数と消す材が
 * 同じ述語（fixedMembersReferencing）から出るようにするため、列挙をここでも呼び直す。
 *
 * graph.removeColumn/removeBeam/removeFooting は使わない——それらは削除したスロットを
 * excludedColumnSlots/excludedBeamSlots/excludedFootingSlots に記録し、次回以降の自動補完で
 * 復活しないようにする「手動削除」専用の意味を持つ（core/planGraph.js:571-584,662-666）。
 * ここでの削除は「降格に伴う自然な後始末」であり、通り芯そのものが消える（中心線化される）ため
 * 除外集合に記録する意味が無い——columnMap/beamMap/footingMapから直接delete
 * （removeDependentsOfCenterLineと同じ流儀。core/planGraph.js:1148-1173）。
 *
 * 削除するスリーブは refs.sleeves（CL照合）ではなく、消す固定梁のhostBeamIdだけで連鎖させる
 * （auto梁のスリーブを巻き込まないため——refs.sleevesはCLに軸・端点が一致する梁一般のスリーブを
 * 指し、非autoで絞ったbeams配列より広い可能性がある）。
 *
 * 呼び出し側はrunInAction（mobxのobservable.map/setへの書き込みをまとめる）で包むこと
 * （このファイル自身はmobxを静的に引かない——react/.jsx/store.js/snap.jsを静的importしない
 * という本ファイル冒頭の方針に合わせ、runInActionの責務は呼び出し側に残す）。
 * @param {import('@core').PlanGraph} graph
 * @param {string} clId
 * @returns {{ columns: string[], beams: string[], footings: string[], sleeves: string[] }} 削除したid一覧
 */
export function removeFixedMembersReferencing(graph, clId) {
  const { columns, beams, footings } = fixedMembersReferencing(graph, clId);
  const removedSleeveIds = [];
  for (const b of beams) {
    for (const s of [...graph.sleeveMap.values()]) {
      if (s.hostBeamId === b.id) {
        graph.sleeveMap.delete(s.id);
        removedSleeveIds.push(s.id);
      }
    }
    graph.beamMap.delete(b.id);
  }
  for (const c of columns)  graph.columnMap.delete(c.id);
  for (const f of footings) graph.footingMap.delete(f.id);
  return {
    columns:  columns.map(c => c.id),
    beams:    beams.map(b => b.id),
    footings: footings.map(f => f.id),
    sleeves:  removedSleeveIds,
  };
}

/** CLの確認文言向けの呼び名。通り芯は採番済みラベル（例: X3）に「通り芯 」を前置し、梁芯・中心線は
 *  ラベルを持たない（採番されない）ため種別名＋座標で示す（例: 梁芯 (2400)）。
 *  種別の判定はcenterLineKindPolicy.js経由（FLOOR_SHARED_KINDS／BEAM_AXIS_KINDS）で行い、
 *  centerLineKind(x)==='<リテラル>'のインライン比較はしない（G3ガード対策）。
 *  @param {import('@core').CenterLine} cl
 *  @returns {string}
 */
export function clDisplayName(cl) {
  const kind = centerLineKind(cl);
  const kindName = FLOOR_SHARED_KINDS.includes(kind) ? '通り芯' : BEAM_AXIS_KINDS.includes(kind) ? '梁芯' : '中心線';
  return cl.label ? `${kindName} ${cl.label}` : `${kindName} (${Math.round(cl.effectiveValue)})`;
}

/** Q5の確認文言。本数0の材種は省く。基礎/柱脚は「基礎」と表記する。
 *  verbは文末の動詞（既定'削除する'。降格側は'中心線にする'を渡す——手動追加材サイレント撤去回避
 *  指示書§5ステップ4。既定値を変えないため既存呼び出し（CL削除）の文言・テストは不変）。
 *  @param {string} clName clDisplayNameの戻り値等、CLの呼び名
 *  @param {Array<{ plane: object, columns: number, beams: number, footings: number }>} byFloor
 *  @param {{ verb?: string }} [opts]
 *  @returns {string}
 */
export function formatFixedMemberConfirm(clName, byFloor, { verb = '削除する' } = {}) {
  const floors = byFloor.map(({ plane, columns, beams, footings }) => {
    const bits = [];
    if (columns  > 0) bits.push(`柱${columns}`);
    if (beams    > 0) bits.push(`梁${beams}`);
    if (footings > 0) bits.push(`基礎${footings}`);
    return `${plane.name}: ${bits.join('・')}`;
  });
  return `${clName} には手動で固定した構造材があります（${floors.join('／')}）。${verb}と一緒に削除されます。よろしいですか？`;
}
