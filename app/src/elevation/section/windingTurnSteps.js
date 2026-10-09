/**
 * 2.5D断面エンジン: 回り階段（WINDING）の回転部を「段付きの踊り場」へ近似する純モジュール
 * （ユーザー裁定2026-10-09「1階展開階段：階段断面が描画されていない」案A）。
 *
 * 回転部（回り段 w マス）は平面では扇形だが、展開図の第3層（sectionStair.js の Landing＝矩形×高さ）は
 * 矩形しか持てない。回転部の矩形（走行方向 runFront〜runBack × 幅方向 S0〜S1）を、奥行き方向に
 * 等分した短冊の列へ割り、段ごとに高さを替えた Landing 群として返す（折返しの踊り場＝w=1 の
 * 退化＝回転部全面の矩形1枚と同形）。
 *
 * 割り付け（往路側が先に上り、奥で折り返して復路側へ戻る U 字）:
 *   h=⌊w/2⌋、odd=w%2、n=h+odd（奥行き方向の短冊数）、Δ=(runBack−runFront)/n。
 *   - 往路側の半幅（S0〜Mid）の段 j=1..h … 手前から奥へ k=j−1 番目の短冊。
 *   - w が奇数なら、奥の全幅の段 j=h+1 … k=h 番目（S0〜S1 全幅）。
 *   - 復路側の半幅（Mid〜S1）の段 j=h+odd+1..w … 奥から手前へ k=h−1−(j−h−odd−1) 番目。
 *   段 j の高さは z0+(j−1)·riser（z0＝回転部の最初の段の高さ＝往路の段数×蹴上）。最後の段 j=w
 *   （復路側の手前の短冊）の高さが復路の直進部の足元（baseZ）になる。
 * 実際の扇形の割り（pivot から放射）とは一致しない近似で、短冊の境界は最大 D/6 ほどずれる
 * （D＝回転部の奥行き。限界は .claude/elevation-model.md の回り階段の節）。
 *
 * 純モジュール（node:test から単体 import 可能。store.js/snap.js/.jsx を静的に引かない）。
 * @module
 */

/**
 * @typedef {{runLo:number, runHi:number, acrossLo:number, acrossHi:number, z:number,
 *   isVertical:boolean, turnStep:number, frame:{edges:never[]}}} TurnStepLanding
 */

/**
 * 回転部の短冊（Landing 互換）の列を返す。j 昇順（高さ昇順）。
 * 入力が不正（非有限・w が 1 未満または整数でない・奥行き 0）なら空配列（例外を投げない）。
 * @param {{vertical:boolean, runFront:number, runBack:number, acrossS0:number, acrossMid:number,
 *   acrossS1:number, z0:number, riser:number, cells:number}} p
 *   runFront … 回転部の手前の縁（レーンに接する側）の走行方向の世界座標。runBack … 奥の縁。
 *   acrossS0/Mid/S1 … 幅方向の世界座標（往路側の外縁・レーン境界・復路側の外縁。昇順でなくてよい）。
 *   z0 … 最初の段の高さ。cells … 回転部のマス数 w。
 * @returns {TurnStepLanding[]}
 */
export function windingTurnSteps({ vertical, runFront, runBack, acrossS0, acrossMid, acrossS1, z0, riser, cells }) {
  const nums = [runFront, runBack, acrossS0, acrossMid, acrossS1, z0, riser, cells];
  if (!nums.every(Number.isFinite)) return [];
  const w = cells;
  if (!Number.isInteger(w) || w < 1) return [];
  const h = Math.floor(w / 2), odd = w % 2, n = h + odd;
  const delta = (runBack - runFront) / n;
  if (delta === 0) return [];

  const span = (a, b) => [Math.min(a, b), Math.max(a, b)];
  const slot = k => span(runFront + k * delta, runFront + (k + 1) * delta);
  const out = [];
  for (let j = 1; j <= w; j++) {
    let k, across;
    if (j <= h) { k = j - 1; across = span(acrossS0, acrossMid); }
    else if (odd === 1 && j === h + 1) { k = h; across = span(acrossS0, acrossS1); }
    else { k = h - 1 - (j - h - odd - 1); across = span(acrossMid, acrossS1); }
    const [runLo, runHi] = slot(k);
    out.push({
      runLo, runHi, acrossLo: across[0], acrossHi: across[1], z: z0 + (j - 1) * riser,
      isVertical: vertical, turnStep: j, frame: { edges: [] },
    });
  }
  return out;
}
