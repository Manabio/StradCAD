// ================================================================
// 建具モードの姿図（正面図）プリミティブ生成（純関数）。
//
// ui/eccentricityFigure.js / ui/kneeDropWallFigure.js と同じ「純関数でプリミティブ配列を
// 返す」形式。座標は mm・y軸下向き正、FL を y=0 とし上方は負（structural/sectionFigure/
// sectionGeometry.js 準拠）。プリミティブ形式は AutoScaledFigure.jsx に準拠。
// ================================================================

import { OpeningMechanism } from './openingCatalog.js';
import { effectiveHeight, effectiveHandleHeight } from './openingNumbering.js';
import { resolveSlideLayoutPanels } from './openingPlanSymbolGeometry.js';
import { OpeningCategory } from '../core.js';

const INSET_MM = 40; // 内側見付の枠inset

function round(v) { return Math.round(v); }

// 頂点(apexX,apexY)へ向かう2本のline（一点鎖線/破線/実線の「V」字表現。dashは'center'/'dashed'/undefined）。
function vee(x1, y1, x2, y2, apexX, apexY, dash) {
  return [
    { type: 'line', x1, y1, x2: apexX, y2: apexY, dash },
    { type: 'line', x1: x2, y1: y2, x2: apexX, y2: apexY, dash },
  ];
}

// 開き戸1枚ぶんの開き表現: 戸先側縦辺（上端・下端）から吊元側中央へのV（頂点＝吊元側）。
// hingeSide の規約: hingeSide<0 → 吊元x=0・戸先x=width（既存SWINGと同じ）。
function singleLeafVee(hingeSide, width, top, sillTop, midY, dash) {
  const hingeX = hingeSide < 0 ? 0 : width;
  const latchX = hingeSide < 0 ? width : 0;
  return vee(latchX, top, latchX, sillTop, hingeX, midY, dash);
}

// 両開き2枚ぶんの開き表現: 中央縦線1本＋両leaf（apex=左右の枠端中央）のV。
function doubleLeafVees(width, top, sillTop, midY, dash) {
  return [
    { type: 'line', x1: width / 2, y1: top, x2: width / 2, y2: sillTop },
    ...vee(width / 2, top, width / 2, sillTop, 0, midY, dash),
    ...vee(width / 2, top, width / 2, sillTop, width, midY, dash),
  ];
}

// 内側見付内（INSET_MM内側）に等間隔の横線n本（ルーバー・ガラリ・シャッター・オーバーヘッド共通）。
// OVERHEADは呼び出し側が上部1/3のバンドだけをtop/sillTopとして渡すため、そのバンドが
// INSET_MM×2より薄い（高さ240mm未満の開口）とinnerBottom<=innerTopになり得る——負のgapで
// 横線が枠外（バンドの外）に出てしまうのを防ぐため、その場合は描かず空配列を返す。
function equalInsetLines(n, top, sillTop, width) {
  const innerTop = top + INSET_MM, innerBottom = sillTop - INSET_MM;
  if (innerBottom <= innerTop) return [];
  const innerLeft = INSET_MM, innerRight = width - INSET_MM;
  const gap = (innerBottom - innerTop) / (n + 1);
  const lines = [];
  for (let i = 1; i <= n; i += 1) {
    const y = innerTop + gap * i;
    lines.push({ type: 'line', x1: innerLeft, y1: y, x2: innerRight, y2: y });
  }
  return lines;
}

// 折れ戸・折りたたみ窓（FOLD=2等分／FIRE_FOLD=4等分）: パネル境界の縦線(n-1本)＋各パネルに
// 破線V（apexは左右交互＝隣接パネルと向き合う折れ方向を表す）。
function foldPanelPrimitives(n, width, top, sillTop, midY) {
  const panelWidth = width / n;
  const prims = [];
  for (let i = 1; i < n; i += 1) {
    const x = panelWidth * i;
    prims.push({ type: 'line', x1: x, y1: top, x2: x, y2: sillTop });
  }
  for (let i = 0; i < n; i += 1) {
    const xLo = panelWidth * i, xHi = panelWidth * (i + 1);
    const apexLeft = i % 2 === 0;
    const apexX = apexLeft ? xLo : xHi;
    const farX = apexLeft ? xHi : xLo;
    prims.push(...vee(farX, top, farX, sillTop, apexX, midY, 'dashed'));
  }
  return prims;
}

// SLIDE_LAYOUT: パネル境界の縦線(n-1本)＋各パネル（fix→'FIX'テキスト／可動→短い水平矢印）。
function slideLayoutPrimitives(entry, width, top, sillTop, midY) {
  const panels = resolveSlideLayoutPanels(entry);
  if (panels.length === 0) return [];
  const n = panels.length;
  const panelWidth = width / n;
  const armY = top + (sillTop - top) * 0.45;
  const prims = [];
  for (let i = 1; i < n; i += 1) {
    const x = panelWidth * i;
    prims.push({ type: 'line', x1: x, y1: top, x2: x, y2: sillTop });
  }
  panels.forEach((p, i) => {
    const cx = panelWidth * (i + 0.5);
    if (p.fix) {
      prims.push({ type: 'text', x: cx, y: midY, text: 'FIX', size: 11, anchor: 'middle', baseline: 'middle' });
      return;
    }
    const len = Math.min(panelWidth * 0.5, 400);
    if (p.arrow === 'both') {
      prims.push({ type: 'arrow', x1: cx, y1: armY, x2: cx - len, y2: armY });
      prims.push({ type: 'arrow', x1: cx, y1: armY, x2: cx + len, y2: armY });
    } else {
      const dir = p.arrow === 'neg' ? -1 : 1;
      prims.push({ type: 'arrow', x1: cx - dir * len / 2, y1: armY, x2: cx + dir * len / 2, y2: armY });
    }
  });
  return prims;
}

// 機構別の意匠表現（枠・寸法は呼び出し元 buildOpeningElevation が共通で描く）。
function mechanismPrimitives(opening, entry, width, top, sillTop) {
  const mechanism = entry?.mechanism;
  const midY = (top + sillTop) / 2;
  const h = sillTop - top; // 開口高さ(mm)。effectiveHeightと同値（top/sillTopの差として再導出）。
  const { hingeSide } = opening;

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
    // 召し合わせ框の縦線2本（x=width/2±20mm）＋障子ごとの短い水平矢印2本（矢頭は外側の枠端向き）。
    const meetGap = 20;
    const armY = top + (sillTop - top) * 0.45;
    const legLen = Math.min(width / 4, 400);
    return [
      { type: 'line', x1: width / 2 - meetGap, y1: top, x2: width / 2 - meetGap, y2: sillTop },
      { type: 'line', x1: width / 2 + meetGap, y1: top, x2: width / 2 + meetGap, y2: sillTop },
      { type: 'arrow', x1: width / 2 - 60, y1: armY, x2: width / 2 - 60 - legLen, y2: armY },
      { type: 'arrow', x1: width / 2 + 60, y1: armY, x2: width / 2 + 60 + legLen, y2: armY },
    ];
  }
  if (mechanism === OpeningMechanism.SLIDE_SINGLE) {
    const armY = top + (sillTop - top) * 0.3;
    return [{ type: 'arrow', x1: 0, y1: armY, x2: width, y2: armY }];
  }
  if (mechanism === OpeningMechanism.FIXED) {
    return [{ type: 'text', x: width / 2, y: midY, text: 'FIX', size: 12, anchor: 'middle', baseline: 'middle' }];
  }
  if (mechanism === OpeningMechanism.SWING_DOUBLE) {
    return doubleLeafVees(width, top, sillTop, midY, 'center');
  }
  if (mechanism === OpeningMechanism.SWING_CHILD) {
    // 縦線位置=親leaf長（吊元側からwidth×(1-childRatio)）。親・子それぞれに一点鎖線V。
    const childRatio = entry?.childRatio ?? 0.3;
    const dividerX = hingeSide < 0 ? width * (1 - childRatio) : width * childRatio;
    const hingeX = hingeSide < 0 ? 0 : width;
    const childX = hingeSide < 0 ? width : 0;
    return [
      { type: 'line', x1: dividerX, y1: top, x2: dividerX, y2: sillTop },
      ...vee(dividerX, top, dividerX, sillTop, hingeX, midY, 'center'),
      ...vee(dividerX, top, dividerX, sillTop, childX, midY, 'center'),
    ];
  }
  if (mechanism === OpeningMechanism.SWING_IN) {
    return singleLeafVee(hingeSide, width, top, sillTop, midY, 'dashed');
  }
  if (mechanism === OpeningMechanism.FREE) {
    // 一点鎖線V＋同じapexの破線V（両方向開きを重ねて表現）。
    return [
      ...singleLeafVee(hingeSide, width, top, sillTop, midY, 'center'),
      ...singleLeafVee(hingeSide, width, top, sillTop, midY, 'dashed'),
    ];
  }
  if (mechanism === OpeningMechanism.FREE_DOUBLE) {
    return [
      ...doubleLeafVees(width, top, sillTop, midY, 'center'),
      ...doubleLeafVees(width, top, sillTop, midY, 'dashed'),
    ];
  }
  if (mechanism === OpeningMechanism.SLIDE_LAYOUT) {
    return slideLayoutPrimitives(entry, width, top, sillTop, midY);
  }
  if (mechanism === OpeningMechanism.HUNG) {
    const midLineY = (top + sillTop) / 2;
    const yTop = top + h * 0.25, yBot = sillTop - h * 0.25;
    return [
      { type: 'line', x1: 0, y1: midLineY, x2: width, y2: midLineY },
      { type: 'arrow', x1: width / 2, y1: yBot, x2: width / 2, y2: yTop },
      { type: 'arrow', x1: width / 2, y1: yTop, x2: width / 2, y2: yBot },
    ];
  }
  if (mechanism === OpeningMechanism.PROJECT_V) {
    return singleLeafVee(hingeSide, width, top, sillTop, midY, undefined);
  }
  if (mechanism === OpeningMechanism.AWNING) {
    return [{ type: 'line', x1: 0, y1: sillTop, x2: width, y2: top }];
  }
  if (mechanism === OpeningMechanism.PROJECT_OUT) {
    return vee(0, sillTop, width, sillTop, width / 2, top, undefined);
  }
  if (mechanism === OpeningMechanism.TILT) {
    return vee(0, top, width, top, width / 2, sillTop, 'dashed');
  }
  if (mechanism === OpeningMechanism.TILT_OUT) {
    return vee(0, top, width, top, width / 2, sillTop, undefined);
  }
  if (mechanism === OpeningMechanism.DREH_KIPP) {
    return [
      ...singleLeafVee(hingeSide, width, top, sillTop, midY, 'dashed'),
      ...vee(0, top, width, top, width / 2, sillTop, 'dashed'),
    ];
  }
  if (mechanism === OpeningMechanism.PIVOT) {
    // 破線V×2（apex=左辺中央／右辺中央）＝菱形＋一点鎖線の縦軸。
    return [
      ...vee(width / 2, top, width / 2, sillTop, 0, midY, 'dashed'),
      ...vee(width / 2, top, width / 2, sillTop, width, midY, 'dashed'),
      { type: 'line', x1: width / 2, y1: top - 100, x2: width / 2, y2: sillTop + 100, dash: 'center' },
    ];
  }
  if (mechanism === OpeningMechanism.PIVOT_H) {
    // 破線V×2（apex=上辺中央／下辺中央）＝菱形＋一点鎖線の横軸。
    return [
      ...vee(0, midY, width, midY, width / 2, top, 'dashed'),
      ...vee(0, midY, width, midY, width / 2, sillTop, 'dashed'),
      { type: 'line', x1: -100, y1: midY, x2: width + 100, y2: midY, dash: 'center' },
    ];
  }
  if (mechanism === OpeningMechanism.LOUVER) {
    return equalInsetLines(5, top, sillTop, width);
  }
  if (mechanism === OpeningMechanism.AWNING_MULTI) {
    // 3等分の横線2本＋各段に実線V（各段の上隅2点→段の下辺中央apex）。
    const bandH = h / 3;
    const ys = [top, top + bandH, top + 2 * bandH, sillTop];
    const prims = [
      { type: 'line', x1: 0, y1: ys[1], x2: width, y2: ys[1] },
      { type: 'line', x1: 0, y1: ys[2], x2: width, y2: ys[2] },
    ];
    for (let i = 0; i < 3; i += 1) {
      prims.push(...vee(0, ys[i], width, ys[i], width / 2, ys[i + 1], undefined));
    }
    return prims;
  }
  if (mechanism === OpeningMechanism.GARARI) {
    return equalInsetLines(8, top, sillTop, width);
  }
  if (mechanism === OpeningMechanism.GLASS_BLOCK) {
    // 内側見付内に約150mmグリッド（本数は寸法から丸め、最低1マス）。
    const innerLeft = INSET_MM, innerRight = width - INSET_MM;
    const innerTop = top + INSET_MM, innerBottom = sillTop - INSET_MM;
    const innerW = innerRight - innerLeft, innerH = innerBottom - innerTop;
    const cols = Math.max(1, Math.round(innerW / 150));
    const rows = Math.max(1, Math.round(innerH / 150));
    const prims = [];
    for (let i = 1; i < cols; i += 1) {
      const x = innerLeft + (innerW * i) / cols;
      prims.push({ type: 'line', x1: x, y1: innerTop, x2: x, y2: innerBottom });
    }
    for (let i = 1; i < rows; i += 1) {
      const y = innerTop + (innerH * i) / rows;
      prims.push({ type: 'line', x1: innerLeft, y1: y, x2: innerRight, y2: y });
    }
    return prims;
  }
  if (mechanism === OpeningMechanism.SHUTTER) {
    return [
      ...equalInsetLines(8, top, sillTop, width),
      { type: 'arrow', x1: width / 2, y1: sillTop - h * 0.2, x2: width / 2, y2: top + h * 0.2 },
    ];
  }
  if (mechanism === OpeningMechanism.OVERHEAD) {
    // 横線3本（上部1/3に集約）＋中央に上向き矢印＋'OHD'テキスト。
    const bandBottom = top + h / 3;
    return [
      ...equalInsetLines(3, top, bandBottom, width),
      { type: 'arrow', x1: width / 2, y1: sillTop - h * 0.2, x2: width / 2, y2: top + h * 0.2 },
      { type: 'text', x: width / 2, y: bandBottom + (sillTop - bandBottom) / 2, text: 'OHD', size: 11, anchor: 'middle', baseline: 'middle' },
    ];
  }
  if (mechanism === OpeningMechanism.EMERGENCY) {
    // 中央に逆三角形（▽、一辺=min(width,height)×0.35、輪郭のみ）。
    const side = Math.min(width, h) * 0.35;
    const triH = (side * Math.sqrt(3)) / 2;
    const tl = { x: width / 2 - side / 2, y: midY - triH / 2 };
    const tr = { x: width / 2 + side / 2, y: midY - triH / 2 };
    const bp = { x: width / 2, y: midY + triH / 2 };
    return [
      { type: 'line', x1: tl.x, y1: tl.y, x2: tr.x, y2: tr.y },
      { type: 'line', x1: tr.x, y1: tr.y, x2: bp.x, y2: bp.y },
      { type: 'line', x1: bp.x, y1: bp.y, x2: tl.x, y2: tl.y },
    ];
  }
  if (mechanism === OpeningMechanism.FIRE_DOOR) {
    // 常時開放金物の開放角度は姿図では表現しない（fireLeavesのみ反映）。
    const fireLeaves = entry?.fireLeaves ?? 1;
    return fireLeaves === 2
      ? doubleLeafVees(width, top, sillTop, midY, 'center')
      : singleLeafVee(hingeSide, width, top, sillTop, midY, 'center');
  }
  if (mechanism === OpeningMechanism.FOLD) {
    return foldPanelPrimitives(2, width, top, sillTop, midY);
  }
  if (mechanism === OpeningMechanism.FIRE_FOLD) {
    return foldPanelPrimitives(4, width, top, sillTop, midY);
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
 * @param {{ tag: string|null, entry: object|null, includeDims?: boolean,
 *   includeMotionArrows?: boolean, includeLevelLine?: boolean }} extra
 *   tag=採番結果, entry=findCatalogEntry の結果。
 *   includeDims/includeMotionArrows/includeLevelLine（既定すべてtrue=従来どおり建具モードの
 *   編集用姿図として使う）は展開モードでの再利用のための抑制オプション（項目1）。
 *   - includeDims=false: 幅・高さ・窓台高さ・レバーハンドル高さの寸法(type:'dim')を出さない
 *     （展開図側は編集用寸法を持たない。「レバーハンドルの高さ寸法、その他寸法類」は描かない仕様）。
 *   - includeMotionArrows=false: 引違いの召し合わせ矢印・シャッター開閉矢印等の動作線(type:'arrow')
 *     を出さない（「動作線（開き勝手の矢印）」は描かない仕様。開き戸の吊元V字(type:'line')は
 *     動作線ではなく吊元表示のため対象外＝残す）。
 *   - includeLevelLine=false: 建具単体の編集用FL基準線(type:'levelLine')を出さない
 *     （展開図側は部屋自体のFL線を別途持つため重複・冗長になる）。
 * @returns {object[]} AutoScaledFigure が描くプリミティブ配列
 */
export function buildOpeningElevation(
  opening, { tag, entry, includeDims = true, includeMotionArrows = true, includeLevelLine = true } = {},
) {
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

  // 抑制オプション（項目1）。既定値はすべてtrueのため、フィルタは常に配列を素通りし
  // 従来の建具モード姿図パネル（OpeningEditor.jsx）の挙動は変わらない。
  let result = primitives;
  if (!includeDims)         result = result.filter(p => p.type !== 'dim');
  if (!includeMotionArrows) result = result.filter(p => p.type !== 'arrow');
  if (!includeLevelLine)    result = result.filter(p => p.type !== 'levelLine');
  return result;
}
