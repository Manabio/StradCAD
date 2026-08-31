// ================================================================
// 腰壁・垂れ壁ダイアログ（KneeDropWallDialog）の断面図プリミティブ生成（純関数）。
//
// 壁の長さ方向を横切る断面（見上げ方向）を模式化する。y軸下向き正
// （structural/sectionFigure/sectionGeometry.js 準拠）: floor(FL)=0, ceiling=-ceilingHeight
// （上へ行くほど y が負）。壁厚は説明図専用の固定値（WALL_W）で表し、実寸の材厚は表さない。
//
// プリミティブ形式は structural/sectionFigure/AutoScaledFigure.jsx に準拠。
// ================================================================

import { CAP_THICKNESS, CAP_OVERHANG } from '../finish/kneeDropWall.js';

const WALL_W  = 120; // mm — 壁厚の模式表現
const CAP_W   = WALL_W + 2 * CAP_OVERHANG;
const DIM_GAP = 300; // mm — 寸法線を断面線（壁帯・天板）から離す距離

/**
 * 腰壁・垂れ壁の説明図プリミティブを生成する（副作用なし。ライブプレビュー用に毎回再計算する想定）。
 * @param {{ceilingHeight:number, kneeTop:number|null, dropBottom:number|null, dimSide?:1|-1}} params
 *   ceilingHeight = 天井高さ(mm)。kneeTop = 腰壁高さ(床〜壁上端, mm) | null。
 *   dropBottom = 垂れ壁高さ(天井〜壁下端, mm) | null。天端（垂れ壁は下端の帯）は壁の
 *   高さの**内側**に厚CAP_THICKNESSで取り、kneeTop/dropBottom の位置は動かさない。
 *   dimSide = 寸法線を断面のどちら側に出すか（+1=右, -1=左。腰・垂れとも同じ側。
 *   高さ範囲が重ならない制約があるため同一x上で衝突しない）。
 * @returns {object[]} AutoScaledFigure が描くプリミティブ配列
 */
export function kneeDropWallFigurePrimitives({ ceilingHeight, kneeTop, dropBottom, dimSide = 1 }) {
  const floorY   = 0;
  const ceilingY = -ceilingHeight;
  const halfW = WALL_W / 2, halfCapW = CAP_W / 2;
  const side  = dimSide >= 0 ? 1 : -1;
  const dimAt  = (halfCapW + DIM_GAP) * side;
  const footAt = halfCapW * side; // 寸法線の足の材側座標＝天板の外縁（天端・下端をおさえる）

  const primitives = [
    { type: 'levelLine', y: floorY,   label: 'FL' },
    // CHの押さえは天井線の下側から（△CH）
    { type: 'levelLine', y: ceilingY, label: 'CH', below: true },
  ];

  if (kneeTop != null && kneeTop > 0) {
    // 天端は壁の高さの**内側**（上端から下へCAP_THICKNESS）。kneeTop＝天端の高さそのものなので
    // 帯を上に積み増さない（finish/kneeDropWall.js の寸法規約と一致させる）。
    const capH = Math.min(CAP_THICKNESS, kneeTop);
    // 腰壁本体（床〜天端の下端）
    primitives.push({ type: 'rect', x: -halfW, y: -(kneeTop - capH), w: WALL_W, h: kneeTop - capH, fill: '#bfdbfe', stroke: '#2563eb' });
    // 天端（厚CAP_THICKNESS・出幅CAP_OVERHANG＝0で壁と同面）
    primitives.push({ type: 'rect', x: -halfCapW, y: -kneeTop, w: CAP_W, h: capH, fill: '#e2e8f0', stroke: '#475569' });
    // 腰壁高さ寸法（床→壁上端＝天端）。値はダイアログの入力欄が寸法値の位置に重なるため描かない。
    primitives.push({ type: 'dim', dir: 'v', from: floorY, to: -kneeTop, at: dimAt, foot: footAt, dot: true });
  }

  if (dropBottom != null && dropBottom > 0) {
    const bodyTopY = ceilingY;
    const bodyBottomY = -(ceilingHeight - dropBottom);
    // 下端の帯も腰壁の天端と対称に壁の高さの内側へ収める（下端＝bodyBottomYは動かさない）。
    const capH = Math.min(CAP_THICKNESS, bodyBottomY - bodyTopY);
    // 垂れ壁本体（天井〜下端の帯の上端）
    primitives.push({ type: 'rect', x: -halfW, y: bodyTopY, w: WALL_W, h: (bodyBottomY - capH) - bodyTopY, fill: '#fecaca', stroke: '#dc2626' });
    // 下端の帯（厚CAP_THICKNESS・出幅CAP_OVERHANG＝0で壁と同面）
    primitives.push({ type: 'rect', x: -halfCapW, y: bodyBottomY - capH, w: CAP_W, h: capH, fill: '#e2e8f0', stroke: '#475569' });
    // 垂れ壁高さ寸法（天井→壁下端）。値はダイアログの入力欄が寸法値の位置に重なるため描かない。
    primitives.push({ type: 'dim', dir: 'v', from: ceilingY, to: bodyBottomY, at: dimAt, foot: footAt, dot: true });
  }

  // 残り寸法: 腰壁のみ→天端から天井まで／垂れ壁のみ→下端から床まで／両方→天端と下端の間。
  // こちらは導出値なので寸法値テキストを描く（縦書き・左が上、線の断面側へ少し寄せる）。
  {
    const hasKnee = kneeTop != null && kneeTop > 0;
    const hasDrop = dropBottom != null && dropBottom > 0;
    let restFrom = null, restTo = null;
    if (hasKnee && hasDrop)      { restFrom = -kneeTop; restTo = -(ceilingHeight - dropBottom); }
    else if (hasKnee)            { restFrom = -kneeTop; restTo = ceilingY; }
    else if (hasDrop)            { restFrom = floorY;   restTo = -(ceilingHeight - dropBottom); }
    const restLen = restFrom != null ? restFrom - restTo : 0; // y下向き正: from(下)−to(上)
    if (restLen > 0) {
      primitives.push({
        type: 'dim', dir: 'v', from: restFrom, to: restTo, at: dimAt, foot: footAt, dot: true,
        // 寸法値は常に寸法線の左側（右/上側の壁=寸法線が断面の右のときは断面寄り、
        // 左/下側の壁=寸法線が断面の左のときは外側）に置く。
        label: `${Math.round(restLen)}`, labelVertical: true, labelDX: -80,
      });
    }
  }

  return primitives;
}
