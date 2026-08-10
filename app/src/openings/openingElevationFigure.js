// ================================================================
// 建具モードの姿図（正面図）プリミティブ生成（純関数）。
//
// ui/eccentricityFigure.js / ui/kneeDropWallFigure.js と同じ「純関数でプリミティブ配列を
// 返す」形式。座標は mm・y軸下向き正、FL を y=0 とし上方は負（structural/sectionFigure/
// sectionGeometry.js 準拠）。プリミティブ形式は AutoScaledFigure.jsx に準拠。
// ================================================================

import { OpeningMechanism } from './openingCatalog.js';
import { effectiveHeight, effectiveHandleHeight } from './openingNumbering.js';
import { OpeningCategory } from '../core.js';

const INSET_MM = 40; // 内側見付の枠inset

function round(v) { return Math.round(v); }

// 機構別の意匠表現（枠・寸法は呼び出し元 buildOpeningElevation が共通で描く）。
function mechanismPrimitives(opening, entry, width, top, sillTop) {
  const mechanism = entry?.mechanism;
  const midY = (top + sillTop) / 2;

  if (mechanism === OpeningMechanism.SWING) {
    // 戸先側縦辺（上端・下端）から吊元側の中央へ一点鎖線2本（建具表の慣習的な戸の開き表現。
    // 頂点＝吊元側）。hingeX/latchX の規約: hingeSide<0 → 吊元x=0・戸先x=width。
    const hingeX = opening.hingeSide < 0 ? 0 : width;
    const latchX = opening.hingeSide < 0 ? width : 0;
    return [
      { type: 'line', x1: latchX, y1: top,    x2: hingeX, y2: midY, dash: 'center' },
      { type: 'line', x1: latchX, y1: sillTop, x2: hingeX, y2: midY, dash: 'center' },
    ];
  }
  if (mechanism === OpeningMechanism.SLIDE_DOUBLE) {
    const armY = top + (sillTop - top) * 0.3;
    return [
      { type: 'line', x1: width / 2, y1: top, x2: width / 2, y2: sillTop },
      { type: 'arrow', x1: width / 2, y1: armY, x2: 0, y2: armY },
      { type: 'arrow', x1: width / 2, y1: armY, x2: width, y2: armY },
    ];
  }
  if (mechanism === OpeningMechanism.SLIDE_SINGLE) {
    const armY = top + (sillTop - top) * 0.3;
    return [{ type: 'arrow', x1: 0, y1: armY, x2: width, y2: armY }];
  }
  if (mechanism === OpeningMechanism.FIXED) {
    return [{ type: 'text', x: width / 2, y: midY, text: 'FIX', size: 12, anchor: 'middle', baseline: 'middle' }];
  }
  // それ以外（未実装機構）: 枠のみ＋種別ラベル（IMPLEMENTED_MECHANISMSの既存方針に合わせる）。
  return entry ? [{ type: 'text', x: width / 2, y: midY, text: entry.label, size: 11, anchor: 'middle', baseline: 'middle' }] : [];
}

const HANDLE_W = 120;    // レバーハンドルのカプセル形 よこ寸法(mm)
const HANDLE_H = 15;     // レバーハンドルのカプセル形 たて寸法(mm)
const HANDLE_BACKSET = 60; // 戸先端からのバックセット(mm)
const HANDLE_MIN_WIDTH = HANDLE_BACKSET + HANDLE_W; // レバーハンドルを描ける最小間口(mm)

// レバーハンドルを描く条件（建具×SWING機構、かつ間口が十分）。buildOpeningElevation が
// 高さ寸法の配置側（吊元側/戸先側の振り分け）にもこの判定を使うため単一の関数に集約する。
function shouldDrawLeverHandle(opening, entry, width) {
  return opening.category === OpeningCategory.FITTING
    && entry?.mechanism === OpeningMechanism.SWING
    && width >= HANDLE_MIN_WIDTH;
}

// レバーハンドル（建具×SWING機構・間口十分のときのみ。呼び出し前に shouldDrawLeverHandle で
// 判定済みの前提）。戸先(latch)側の端からバックセット分あけ、そこからヒンジ側へHANDLE_W分
// 伸ばしたカプセル形（短辺が半円）を、FLからeffectiveHandleHeight分上がった高さに水平に描く。
// hingeSide の規約は mechanismPrimitives と同じ（hingeSide<0 → ヒンジx=0・戸先x=width）。
// 寸法（handleHeight）はレバーハンドルのある戸先側の縦辺の外に置く（heightは反対＝吊元側。
// buildOpeningElevation 側で振り分ける）。
function leverHandlePrimitives(opening, width) {
  const handleH = effectiveHandleHeight(opening);
  const latchX = opening.hingeSide < 0 ? width : 0;
  // 戸先→ヒンジ方向の符号（latchXがwidth側ならヒンジは0側＝負方向）
  const towardHinge = opening.hingeSide < 0 ? -1 : 1;
  const capsuleX = towardHinge > 0 ? latchX + HANDLE_BACKSET : latchX - HANDLE_BACKSET - HANDLE_W;
  const centerY = -handleH;
  // 戸先が右（hingeSide<0）なら寸法も右（at:width+250,foot:width）、戸先が左（hingeSide>0）なら
  // 寸法も左（at:-250,foot:0,labelSide:'left'）。
  const handleDim = opening.hingeSide < 0
    ? { at: width + 250, foot: width }
    : { at: -250, foot: 0, labelSide: 'left' };
  return [
    {
      type: 'rect', x: capsuleX, y: centerY - HANDLE_H / 2, w: HANDLE_W, h: HANDLE_H, rx: HANDLE_H / 2,
    },
    {
      type: 'dim', dir: 'v', at: handleDim.at, from: -handleH, to: 0, foot: handleDim.foot, labelSide: handleDim.labelSide,
      editable: true, target: 'handleHeight', label: String(round(handleH)),
    },
  ];
}

/**
 * 建具1件の姿図プリミティブを生成する。
 * @param {object} opening core.js の Opening（category/subType/width/hingeSide等）
 * @param {{ tag: string|null, entry: object|null }} extra tag=採番結果, entry=findCatalogEntry の結果
 * @returns {object[]} AutoScaledFigure が描くプリミティブ配列
 */
export function buildOpeningElevation(opening, { tag, entry } = {}) {
  const width  = opening.width;
  const height = effectiveHeight(opening);
  // 建具（fitting）は窓台の概念を持たないため sill=0 扱い（core.js のコメント方針どおり）。
  const sill = opening.category === OpeningCategory.WINDOW ? (opening.sillHeight ?? 0) : 0;
  const top = -(sill + height); // FLからの上端y（負）
  const sillTop = -sill;        // 窓台上端y（建具はFL=0）

  const drawHandle = shouldDrawLeverHandle(opening, entry, width);
  // 高さ寸法の配置側: レバーハンドルを描くときだけ、ハンドルのある戸先側を避けて吊元側へ置く
  // （戸先＝hingeSide<0のとき右／hingeSide>0のとき左）。描かないときは従来どおり常に右。
  const heightOnHingeLeft = drawHandle && opening.hingeSide < 0;
  const heightDim = heightOnHingeLeft
    ? { type: 'dim', dir: 'v', at: -250, from: top, to: sillTop, foot: 0, labelSide: 'left',
        editable: true, target: 'height', label: String(round(height)) }
    : { type: 'dim', dir: 'v', at: width + 250, from: top, to: sillTop, foot: width,
        editable: true, target: 'height', label: String(round(height)) };

  const primitives = [
    { type: 'rect', x: 0, y: top, w: width, h: height },
    { type: 'rect', x: INSET_MM, y: top + INSET_MM, w: Math.max(width - 2 * INSET_MM, 0), h: Math.max(height - 2 * INSET_MM, 0), stroke: '#94a3b8' },
    { type: 'levelLine', y: 0, label: 'FL' },
    ...mechanismPrimitives(opening, entry, width, top, sillTop),
    {
      type: 'dim', dir: 'h', at: top - 250, from: 0, to: width, foot: top,
      editable: true, target: 'width', label: String(round(width)),
    },
    heightDim,
  ];

  if (opening.category === OpeningCategory.WINDOW) {
    primitives.push({
      type: 'dim', dir: 'v', at: width + 250, from: sillTop, to: 0, foot: width,
      editable: true, target: 'sillHeight', label: String(round(sill)),
    });
  }

  // レバーハンドル: 建具（fitting）×SWING機構・間口十分のときのみ（窓・引戸・狭小間口には描かない）。
  if (drawHandle) {
    primitives.push(...leverHandlePrimitives(opening, width));
  }

  if (tag) primitives.push({ type: 'text', x: 0, y: top - 450, text: tag, size: 12, anchor: 'start' });

  return primitives;
}
