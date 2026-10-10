/**
 * 見上げの断面解決（純モジュール）。天伏モード（appMode 'ceiling'）が、見下げの解決器 `planSectionFigure` をそのまま使って
 * 「切断高 c より上を見上げたときの見えがかり」を線で解く。`.claude/plan-section.md` の「見上げ（天伏）」。
 *
 * 方式: 立体の z を符号反転した鏡像を作り、解決器へ渡す（解決器本体は変えない）。
 *   zLo' = -zHi、zHi' = -zLo、zAt' = (x,y) => -zAt(x,y)（zAt を持つ立体だけ）、cutZ' = -cutZ。
 * 見下げの分類・遮蔽がそのまま見上げの意味になる（鏡像で「上端が高い＝下端が低い」。天井面・床の下面が手前）。
 * 見下げの「窓＝自階の床の穴」の規則は使わない: 鏡像では自階の床（z=0）が非表示側に落ち、上階の層（鏡像で下階に見える）が
 * 窓扱いになってしまう。そこで全立体の source.layerFloorZ を 0 に置き換えて窓規則を無効にし、元の値は source.viewLayerFloorZ に
 * 退避する（上階の中身は上階スラブの面材と天井面の同点遮蔽で隠れ、穴・吹抜けの中だけ見える）。出力では元の値へ戻す。
 *
 * store.js / snap.js / *.jsx / graphDerived を import しない（node:test から単体 import 可）。
 */
import { planSectionFigure } from './planSectionFigure.js';

const mirrorSolid = s => {
  const out = {
    ...s,
    zLo: 0 - s.zHi,
    zHi: 0 - s.zLo,
    source: { ...s.source, layerFloorZ: 0, viewLayerFloorZ: s.source?.layerFloorZ ?? null },
  };
  if (typeof s.zAt === 'function') out.zAt = (x, y) => 0 - s.zAt(x, y);
  return out;
};

/** 出力のプリミティブの source を元の layerFloorZ へ戻す（viewLayerFloorZ を消す）。 */
function restoreSource(prim) {
  const { viewLayerFloorZ, ...rest } = prim.source ?? {};
  if (viewLayerFloorZ == null) delete rest.layerFloorZ; // 元が省略（鏡像で 0 を入れた分を消す）
  else rest.layerFloorZ = viewLayerFloorZ;
  return { ...prim, source: rest };
}

/**
 * 立体と切断高から、見上げの平面の線を解く。入力の配列・立体は変更しない。
 * @param {import('./planSolids.js').Solid[]} solids  planSolids の出力（ceilings:true で天井立体を含む）
 * @param {number} cutZ  切断面の高さ（自階 FL=0 の絶対 mm）。有限でなければ TypeError
 * @param {{eps?: number, slopeSampleMm?: number}} [opts]  planSectionFigure と同じ
 * @returns {import('./planSectionFigure.js').Primitive[]}  source.layerFloorZ は入力の立体の値（省略は省略のまま）
 */
export function planSectionFigureUp(solids, cutZ, opts = {}) {
  if (!Number.isFinite(cutZ)) throw new TypeError(`planSectionFigureUp: cutZ は有限の数値が必要です（${String(cutZ)}）`);
  if (!Array.isArray(solids)) return [];
  const mirrored = solids.filter(s => s && Number.isFinite(s.zLo) && Number.isFinite(s.zHi)).map(mirrorSolid);
  return planSectionFigure(mirrored, 0 - cutZ, opts).map(restoreSource);
}
