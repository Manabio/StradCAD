// ================================================================
// 建具モードの姿図（正面図）プリミティブ生成（純関数）。
//
// ui/eccentricityFigure.js / ui/kneeDropWallFigure.js と同じ「純関数でプリミティブ配列を
// 返す」形式。座標は mm・y軸下向き正、FL を y=0 とし上方は負（structural/sectionFigure/
// sectionGeometry.js 準拠）。プリミティブ形式は AutoScaledFigure.jsx に準拠。
// ================================================================

import { OpeningMechanism } from './openingCatalog.js';
import { effectiveHeight } from './openingNumbering.js';
import { OpeningCategory } from '../core.js';

const INSET_MM = 40; // 内側見付の枠inset

function round(v) { return Math.round(v); }

// 機構別の意匠表現（枠・寸法は呼び出し元 buildOpeningElevation が共通で描く）。
function mechanismPrimitives(opening, entry, width, top, sillTop) {
  const mechanism = entry?.mechanism;
  const midY = (top + sillTop) / 2;

  if (mechanism === OpeningMechanism.SWING) {
    // ヒンジ側縦辺（上端・下端）から戸先側の中央へ破線2本（建具表の慣習的な戸の開き表現）。
    const hingeX = opening.hingeSide < 0 ? 0 : width;
    const latchX = opening.hingeSide < 0 ? width : 0;
    return [
      { type: 'line', x1: hingeX, y1: top,    x2: latchX, y2: midY, dash: 'dashed' },
      { type: 'line', x1: hingeX, y1: sillTop, x2: latchX, y2: midY, dash: 'dashed' },
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

  const primitives = [
    { type: 'rect', x: 0, y: top, w: width, h: height },
    { type: 'rect', x: INSET_MM, y: top + INSET_MM, w: Math.max(width - 2 * INSET_MM, 0), h: Math.max(height - 2 * INSET_MM, 0), stroke: '#94a3b8' },
    { type: 'levelLine', y: 0, label: 'FL' },
    ...mechanismPrimitives(opening, entry, width, top, sillTop),
    {
      type: 'dim', dir: 'h', at: top - 250, from: 0, to: width, foot: top,
      editable: true, target: 'width', label: String(round(width)),
    },
    {
      type: 'dim', dir: 'v', at: width + 250, from: top, to: sillTop, foot: width,
      editable: true, target: 'height', label: String(round(height)),
    },
  ];

  if (opening.category === OpeningCategory.WINDOW) {
    primitives.push({
      type: 'dim', dir: 'v', at: width + 250, from: sillTop, to: 0, foot: width,
      editable: true, target: 'sillHeight', label: String(round(sill)),
    });
  }

  if (tag) primitives.push({ type: 'text', x: width / 2, y: top - 450, text: tag, size: 12 });

  return primitives;
}
