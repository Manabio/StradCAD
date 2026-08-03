// 梁芯CL（discipline:'fuse'、centerLineKind==='beam'）の移動UI専用ロジック（純関数、UI非依存）。
// 設計意図は .claude/structural-model.md「梁芯CL（discipline:'fuse'）と小梁は既存の仕組みへ薄く乗せる」参照。
import { CenterLineType, centerLineKind, spanKey } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { secondaryBeamSpansFor, resolveDefaultMaterialType, isStructureSpecified, effectiveStructure } from './structuralAutoFill.js';
import { DEFAULT_BEAM_SECTION_BY_MATERIAL } from './memberCatalog.js';
import { structureHasMemberKind, MEMBER_KIND } from './structuralClassification.js';

/**
 * 梁芯CL cl の移動可能範囲 [min, max]（絶対座標value）。
 * 障害物＝cl自身以外・同じcenterLineTypeの「通り芯（labeled:true）」または「他の梁芯（centerLineKind==='beam'）」。
 * 両隣の障害物の内側へ CL_OVERLAP_TOL_MM（追加時の重複ガードと同じ値）だけ内寄せする——通り芯・他の
 * 梁芯と同一座標に到達させない（梁芯の追加経路が持つ「他種別CLと同位置に共存不可」ガード＝大梁と完全
 * 重複する小梁の生成防止、を移動でも素通りさせないため）。中心線・補助線（labeled:falseの通常CL）とは
 * 障害物にしていないため同位置に到達し得るが、これらは梁芯にとって物理的な衝突ではない
 * （小梁の生成はhost判定＝大梁の有無だけで決まり、中心線・補助線の位置とは無関係）ため実害はない。
 * transform/followerGraph.js の resolveMoveRange は使わない（構造モードでは非表示の平面図側の中心線・
 * 補助線・壁まですべて障害物になり、画面に何も無いのに梁芯が見えない壁で止まる体験になるため）。
 */
export function beamAxisMoveRange(graph, cl) {
  let min = -Infinity, max = Infinity;
  for (const other of graph.centerLines) {
    if (other.id === cl.id || other.centerLineType !== cl.centerLineType) continue;
    if (!(other.labeled || centerLineKind(other) === 'beam')) continue;
    const v = other.effectiveValue;
    if (v < cl.value) { if (v > min) min = v; }
    else if (v > cl.value) { if (v < max) max = v; }
    // v === cl.value（既存の重複CL）は範囲に影響させない
  }
  return {
    min: min === -Infinity ? -Infinity : min + CL_OVERLAP_TOL_MM,
    max: max === Infinity ? Infinity : max - CL_OVERLAP_TOL_MM,
  };
}

/**
 * 梁芯CL cl に限定して、小梁の構成を現在のhost状況へ再解決する（張り替え方式）。
 * 「一旦全削除してautoFillで再生成」にすると、ユーザーが設定した小梁の断面が既定値に戻り部材番号グループ
 * （numberGroupId）も失われるため、位置順に対応づけて張り替える:
 *   - 対応が付く分   → clStart/clEnd を setField で張り替えるだけ（id・sectionDefId・dimensionStatus・
 *                      numberGroupId を維持）
 *   - 余剰のold      → graph.beamMap.delete + 子スリーブの連鎖削除（graph.removeBeam は使わない。
 *                      removeBeam は excludedBeamSlots に記録するため、自動再解決による削除が
 *                      ユーザーの手動削除として記録され、以後その位置に小梁が生成されなくなる。
 *                      deleteClassificationOverflow と同じ理由・同じ規律）
 *   - 不足分         → graph.addBeam。materialType/sectionDefId は同一CL上の既存小梁から継承し、
 *                      無ければ project の既定材料・既定断面（DEFAULT_BEAM_SECTION_BY_MATERIAL）
 * host判定・区間規則は secondaryBeamSpansFor（structuralAutoFill.js。autoFillSecondaryBeamsと共有）に
 * 集約し、二系統にしない。
 * autoFillSecondaryBeams と同じ構造ゲート（主構造未確定・記号Bが構造分類で×の間は何もしない）を持つ。
 * 生成側と同じ「非破壊」の割り切りで、ゲートに引っかかっても既存小梁は削除しない（unstructure化した
 * からといって既存部材を巻き込んで壊さない。deleteClassificationOverflow が別途担う領域）。
 * @returns {{ before: number, after: number }} 移動前後のそのCL上の小梁本数（本数変化トースト用）
 */
export function resolveSecondaryBeamsForAxis(graph, cl, project) {
  const currentCount = graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === cl.id).length;
  if (!isStructureSpecified(graph, project)) return { before: currentCount, after: currentCount };
  const structure = effectiveStructure(graph, project);
  if (!structureHasMemberKind(MEMBER_KIND.BEAM, structure)) return { before: currentCount, after: currentCount };

  const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
  const hosts = secondaryBeamSpansFor(graph, cl);
  const newPairs = [];
  for (let i = 0; i < hosts.length - 1; i++) {
    const a = hosts[i], b = hosts[i + 1];
    const key = spanKey(cl, a, b);
    if (graph.excludedBeamSlots.has(key)) continue; // 手動削除を尊重（autoFillSecondaryBeamsと同じ規律）
    newPairs.push({ a, b });
  }

  const olds = graph.beams
    .filter(b => b.role === 'secondary' && b.axisCL.id === cl.id)
    .sort((x, y) =>
      Math.min(x.clStart.effectiveValue, x.clEnd.effectiveValue) -
      Math.min(y.clStart.effectiveValue, y.clEnd.effectiveValue));

  const before = olds.length;
  const n = Math.min(newPairs.length, olds.length);

  // 対応が付く分: 張り替え（id・sectionDefId・dimensionStatus・numberGroupId を維持）
  for (let i = 0; i < n; i++) {
    const beam = olds[i];
    const { a, b } = newPairs[i];
    beam.setField('clStart', a);
    beam.setField('clEnd', b);
  }

  // 余剰のold: 明示削除を汚さない方式で削除（graph.removeBeam は使わない）
  for (let i = n; i < olds.length; i++) {
    const beam = olds[i];
    for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
    graph.beamMap.delete(beam.id);
  }

  // 不足分: 新規追加。材料・断面は同一CL上の既存小梁（張り替え後に残る先頭）から継承、無ければ既定。
  if (n < newPairs.length) {
    const template = olds[0] ?? null;
    const materialType = template?.materialType ?? resolveDefaultMaterialType(graph, project);
    const section = template?.sectionDefId ?? DEFAULT_BEAM_SECTION_BY_MATERIAL[materialType];
    for (let i = n; i < newPairs.length; i++) {
      const { a, b } = newPairs[i];
      graph.addBeam(materialType, section, cl, isVertical, a, b, { role: 'secondary', beamType: '小梁' });
    }
  }

  return { before, after: newPairs.length };
}
