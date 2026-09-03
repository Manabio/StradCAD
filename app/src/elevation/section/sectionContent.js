/**
 * 2.5D断面エンジン: 「1つの切断 → 壁断面・見えがかり・アキのcontent」の**共通経路**。
 *
 * 階段帯（`elevationStairSequence.js`）と吹抜けの多層帯（`elevationVoid.js`）は、どちらも
 * 「切断を1本立てて断面エンジンへ渡す」処理なのに、**別々に手で組み立てていた**——その結果、
 * 階段帯にはある処理が吹抜け帯には無い、という差が静かに溜まった（探査延長・端の凹み側面線の
 * 抑制・アキのバツが吹抜け帯には無かった）。ユーザー指摘「「6」は正しく「5」は誤った出力」の
 * 直接の原因であり、「修正が他の図面にも効くか判定できない」という問題の温床でもある。
 *
 * ここを唯一の入口にすることで、**この関数へ足した修正は階段にも吹抜けにも同時に効く**。
 * タイプ固有の処理（階段のささら・遮蔽、構造材の加算レイヤ）は呼び出し側が返り値の部品
 * （`columns`/`wallPrims`/`gapMarks`）に対して後段で行う——共通経路にタイプ固有の分岐を
 * 持ち込まない、が本モジュールの境界。
 *
 * 純モジュール（store.js/snap.js/*.jsx/react-konva/appViewport.jsを静的importしない）。
 */
import { buildColumns } from './sectionEngine.js';
import { emitColumns, emitOpenGapMarks } from './sectionEmit.js';

/**
 * 壁のない端部の探査延長と、帯の部屋の包絡矩形を載せた cut を作る。
 *
 * 「壁のない端部で線を図の外へ延ばす」のはプリミティブを後から引き伸ばすのではなく
 * **探査範囲そのものを外へ広げる**（ユーザー裁定2026-08 A案。`sectionEmit.js`冒頭参照）——
 * 面の外の列も実データとして生成されるため、延長ぶんの線が通常の帯の縁として自然に出る。
 * `bandRoomBounds`は見えがかり壁の探索を帯自身の部屋の広がりに限るため（`sectionProbe.js`の
 * `withinViewRoom`）。レイキャストだけでなく構造材の判定でも使う。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} endExtendMm
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} [bandRoomBounds]
 * @returns {import('./sectionTypes.js').SectionCut}
 */
export function withProbeExtension(cut, endExtendMm, bandRoomBounds = null) {
  const openLo = cut.face?.hasWallAtLocal0 === false;
  const openHi = cut.face?.hasWallAtLocalRun === false;
  const localLoIsWorldLo = cut.dirSign > 0;
  const extend = !!endExtendMm && (openLo || openHi);
  return { ...cut, bandRoomBounds, line: !extend ? cut.line : { ...cut.line,
    probeExtendLoMm: (localLoIsWorldLo ? openLo : openHi) ? endExtendMm : 0,
    probeExtendHiMm: (localLoIsWorldLo ? openHi : openLo) ? endExtendMm : 0 } };
}

/**
 * `emitColumns`/`emitOpenGapMarks`へ渡す描画コンテキスト。
 * openEndLo/Hi: この面の端に壁が無い（壁面がその先へ続く）なら、描画範囲の端に凹み側面線を
 * 出さない（ユーザー実機指摘2026-08「3500左CLにエッジはない」）——隣接列が無いことは
 * 「そこで壁が終わる」ことを意味せず、範囲外は単に未探査。
 * `cut.face`のhasWallAtLocal0/Runがそのままローカルx=0/run側の端に対応する（cut.dirSignと
 * faceのdirSignは呼び出し側で揃えてある前提）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {{ceilZ:number|undefined, openEndLo:boolean, openEndHi:boolean}}
 */
export function emitCtxForCut(cut) {
  return {
    ceilZ: cut.zRange?.hiZ,
    openEndLo: cut.face?.hasWallAtLocal0 === false,
    openEndHi: cut.face?.hasWallAtLocalRun === false,
  };
}

/**
 * 1つの切断 → 壁断面・見えがかり・アキ（タイプ非依存）。
 *
 * 呼び出し側が後段でタイプ固有の加工をできるよう、まとめた`content`だけでなく途中の部品も返す
 * （階段帯は`wallPrims`を階段の見付けで破線化し、`gapMarks`を階段で分割し、`columns`を
 * ささら・構造材の生成へ渡す）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @param {{endExtendMm?:number, bandRoomBounds?:object|null, scale?:number}} [opts]
 * @returns {{cut:object, columns:object[], emitCtx:object,
 *   wallPrims:object[], gapMarks:object[], content:object[]}}
 *   cut … 探査延長・包絡矩形を載せた後の cut（後段の階段・構造材もこれを使う）。
 */
export function buildCutContent(cut, probeCtx, opts = {}) {
  const pcut = withProbeExtension(
    cut, opts.endExtendMm ?? 0, opts.bandRoomBounds ?? cut.bandRoomBounds ?? null,
  );
  const columns = buildColumns(pcut, probeCtx);
  // scale（px/mm）はアキ標記の省略判定に使う（sectionEmit.jsのemitOpenGapMarks）。
  const emitCtx = { ...emitCtxForCut(pcut), scale: opts.scale };
  const wallPrims = emitColumns(columns, pcut, emitCtx);
  const gapMarks = emitOpenGapMarks(columns, pcut, emitCtx);
  return { cut: pcut, columns, emitCtx, wallPrims, gapMarks, content: [...wallPrims, ...gapMarks] };
}
