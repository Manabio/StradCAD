// ================================================================
// 部材別 断面図ジェネレータ（entity → ジオメトリ プリミティブ）
//
// 問題.md の各断面図仕様を、sectionGeometry.js のプリミティブ列へ変換する。
// 返り値は AutoScaledFigure / Konva（Phase 6）が共通に消費する純データ。
// core.js には依存せず、断面マスター（sectionCatalog.js）と entity のフィールドのみ使う。
//
// ctx（呼び出し元が graph から導出して渡す。未指定でも動くよう既定値を持つ）:
//   axisOffsetX / axisOffsetY : 柱芯オフセット(mm)。柱・基礎は2軸、梁・壁は axisOffset 1軸。
//   eccX / eccY / ecc         : 個別偏心量(mm)。
//   glLabel / flLabel         : 基準レベル線のラベル（'GL' / '2FL' 等）。
// ================================================================

import { findSectionEntry, SectionShape, diaphragmProjection } from '../sectionCatalog.js';
import { withLayoutId } from './layoutStudy.js';
import { shapeBounds, chooseScale } from './sectionGeometry.js';

const STEEL_FILL = '#475569';
// 偏芯量寸法線の端点マーカー（丸）の半径。縮尺に関わらずどの図でも同じ大きさに見えるようpx固定。
const MARKER_R_PX = 1.25;

// スクリーン空間注記：注記の隙間の基準量(px)。全注記オフセットは multiplier * g（mm）で表すため、
// g = GAP_BASE_PX / scale（mm）とすれば描画時 g * scale = GAP_BASE_PX（px）で縮尺非依存に一定となる。
// 値を小さくすると注記が密に、大きくすると疎になる（要調整時はここを変える）。
const GAP_BASE_PX = 22;
// スクリーン空間注記が形状の外側へ張り出す px を、縮尺見積り時に枠から各辺確保する量（FIGURE_MARGIN_PX に上乗せ）。
const ANNOTATION_RESERVE_PX = 24;

// 寸法線が断面外へ張り出す mm 量を、断面の代表寸法から決める（縮尺非依存に見えるよう比率で）。
// scale が分かっていれば px 一定（GAP_BASE_PX）になる mm を返す（スクリーン空間注記）。未指定（Konva等）は従来比率。
function gapFor(extent) { return Math.max(extent * 0.4, 80); }
function resolveGap(ctx, extent) { return ctx?.scale ? GAP_BASE_PX / ctx.scale : gapFor(extent); }

// dim プリミティブ生成ヘルパー。
function dim(dir, from, to, at, label, opts = {}) {
  return { type: 'dim', dir, from, to, at, label, ...opts };
}

// --- 寸法線の書式定義（各部材図から共通で参照する） ---------------------------------

// 寸法線の両端点に置く小さな丸（端のチック代わり）。dir='h'なら p1/p2 はx座標・at はy座標、
// dir='v'なら p1/p2 はy座標・at はx座標（dimの仕様と同じ）。
function endpointMarkers(dir, p1, p2, at) {
  const c1 = dir === 'h' ? { cx: p1, cy: at } : { cx: at, cy: p1 };
  const c2 = dir === 'h' ? { cx: p2, cy: at } : { cx: at, cy: p2 };
  return [
    { type: 'circle', ...c1, rPx: MARKER_R_PX, fill: '#64748b' },
    { type: 'circle', ...c2, rPx: MARKER_R_PX, fill: '#64748b' },
  ];
}

// 材寸法線: 部材自身の断面寸法（多くは read-only、カタログ/構造算定値）。
// 材の外面(materialEdge)から side（+1/-1。材の外側方向）に g*MATERIAL_GAP 離れた位置に
// 寸法線を引き、foot で材まで引出線を結ぶ（材には接しない。AutoScaledFigure.jsx の foot 処理）。
// 両端点には偏芯量寸法線と同じ丸を置く。
const MATERIAL_GAP = 0.9;
function materialDim(dir, from, to, materialEdge, side, label, g, opts = {}) {
  const at = materialEdge + side * g * MATERIAL_GAP;
  return [
    ...endpointMarkers(dir, from, to, at),
    dim(dir, from, to, at, label, { ...opts, foot: materialEdge }),
  ];
}

// 偏芯量寸法線: 通り芯⇄柱芯（または軸オフセット）の変位量。端のチックの代わりに
// 両端点へ小さな丸（MARKER_R_PX）を置く。dir='h'なら at はy座標、'v'なら at はx座標。
function eccentricityDim(dir, axisOffset, at, opts = {}) {
  return offsetDim(dir, 0, axisOffset, at, opts);
}

// 任意区間 from→to の変位量寸法線（ラベル=区間長の絶対値）。柱芯⇄材芯（梁の偏芯量）等に使う。
function offsetDim(dir, from, to, at, opts = {}) {
  return [
    ...endpointMarkers(dir, from, to, at),
    dim(dir, from, to, at, Math.abs(to - from), { ...opts, noTick: true }),
  ];
}

// 鋼管（角形／丸形）柱のダイヤフラム外形（断面外面から e だけ外側へ広げた四角）。鋼管以外は null。
// e（出寸法。diaphragmProjection）と矩形プリミティブを返す。寸法線は呼び出し側が柱断面の寸法線と一本化する。
// cx/cy=断面中心、w/h=断面寸法(mm)。
function diaphragmRect(section, cx, cy, w, h) {
  const e = diaphragmProjection(section);
  if (!e) return null;
  return { e, rect: { type: 'rect', x: cx - w / 2 - e, y: cy - h / 2 - e, w: w + 2 * e, h: h + 2 * e, stroke: '#94a3b8' } };
}

// 断面マスター（H形鋼/角形鋼管/丸/矩形）を、水平中心 cx・上端 topY に配置するプリミティブ群を返す。
// width=水平方向、height=鉛直方向。返り値 { prims, w, h }（w,h は実寸mm）。
function sectionShapePrims(section, cx, topY, fill = STEEL_FILL) {
  if (!section) {
    const w = 300, h = 300;
    return { prims: [{ type: 'rect', x: cx - w / 2, y: topY, w, h, hatch: 'concrete' }], w, h };
  }
  const { shape, width: w, height: h, webThickness, flangeThickness, wallThickness } = section;
  const x = cx - w / 2;
  switch (shape) {
    case SectionShape.H_SECTION:
      return { prims: [{ type: 'hSection', x, y: topY, w, h, web: webThickness, flange: flangeThickness, fill }], w, h };
    case SectionShape.SQUARE_PIPE: {
      const t = wallThickness ?? 6;
      return {
        prims: [
          { type: 'rect', x, y: topY, w, h, stroke: fill },
          { type: 'rect', x: x + t, y: topY + t, w: w - 2 * t, h: h - 2 * t, stroke: fill },
        ], w, h,
      };
    }
    case SectionShape.ROUND_PIPE: {
      const t = wallThickness ?? 6;
      return {
        prims: [
          { type: 'circle', cx, cy: topY + h / 2, r: w / 2, stroke: fill },
          { type: 'circle', cx, cy: topY + h / 2, r: w / 2 - t, stroke: fill },
        ], w, h,
      };
    }
    case SectionShape.ROUND:
      return { prims: [{ type: 'circle', cx, cy: topY + h / 2, r: w / 2, fill: '#e2e8f0', stroke: '#334155' }], w, h };
    case SectionShape.RECT:
    default:
      return { prims: [{ type: 'rect', x, y: topY, w, h, hatch: section.materialType === 'RC' ? 'concrete' : undefined }], w, h };
  }
}

// 通り芯・柱芯（縦の一点鎖線）＋変位量 [275] を作る。基礎梁・フーチング・柱脚の図で使う。
// 通り芯を x=0、柱芯を x=axisOffset に置く。offset=0（非ラーメン・内部芯）なら柱芯線は出さない。
// dimY=変位寸法線のy（断面寄り）、labelY=通り芯/柱芯ラベルのy（変位寸法の上、スペースをあけて）。
// 柱芯（通り芯⇄柱芯）は建物の出幅から派生する read-only 表示——編集は構造リスト柱の図の出幅で一本化する。
function axisPrims(axisOffset, { dimY, labelY }) {
  const prims = [
    { type: 'axisV', x: 0 },
    { type: 'text', x: 0, y: labelY, text: '通り芯', anchor: 'middle', size: 10, fill: '#94a3b8', layoutId: 'text:axisLabel' },
  ];
  if (axisOffset && axisOffset !== 0) {
    prims.push({ type: 'axisV', x: axisOffset });
    prims.push({ type: 'text', x: axisOffset, y: labelY, text: '柱芯', anchor: 'middle', size: 10, fill: '#94a3b8', layoutId: 'text:columnAxisLabel' });
    prims.push(...eccentricityDim('h', axisOffset, dimY));
  }
  return prims;
}

// --- 柱（H/□/丸/矩形 の断面 ＋ 通り芯/柱芯 ＋ 偏芯） ---------------------------
// 柱は点部材のため平断面（X-Y平面）で表す。X方向(通り芯X⇄柱芯X)・Y方向(通り芯Y⇄柱芯Y)の
// 2つの変位を両方とも編集可能にする（確定で各CLの columnAxisOffsets を更新→柱が描画エリアで移動）。
// 断面名はカードの「断面」プルダウンで示す（図中ラベルは置かない）。
function columnFigure(col, ctx) {
  const section = findSectionEntry(col.sectionDefId);
  const offX = ctx.axisOffsetX ?? 0;
  const offY = ctx.axisOffsetY ?? 0;
  const w = section?.width ?? 300;   // X方向の断面寸法
  const h = section?.height ?? 300;  // Y方向の断面寸法
  const cx = offX + (ctx.eccX ?? 0);
  const cy = offY + (ctx.eccY ?? 0);
  const secTop = cy - h / 2;
  const { prims: sp } = sectionShapePrims(section, cx, secTop);
  // 柱は寸法線・ラベルが密集しやすいため、通常より大きく離す。resolveGap は scale 指定時に
  // GAP_BASE_PX/scale（mm）を返す＝描画px一定（図の倍率に寄らず一定間隔）。
  const base = resolveGap(ctx, Math.max(w, h));
  const g = base * 2.5;          // 全寸法線・ラベルを柱断面から離す距離
  // 寸法線の足（引出線）の長さ。離れ(g)を大きくしても足は伸ばさず一定長を保ち、断面との間に空きを作る。
  const footLen = base * 0.8;

  // 軸線の伸長範囲（通り芯・柱芯・断面を内包）。
  const loX = Math.min(0, offX, cx - w / 2), hiX = Math.max(0, offX, cx + w / 2);
  const loY = Math.min(0, offY, cy - h / 2), hiY = Math.max(0, offY, cy + h / 2);
  // 寸法線は柱断面からしっかり離す（断面寄りに描くと断面と紛れるため）。上側（X方向）・左側（Y方向）に
  // それぞれ2段重ねる：内（断面寄り）＝外面寸(通り芯⇄柱面=出幅, 編集可・柱面へ寸法足)、外＝偏芯量(通り芯⇄柱芯, 編集不可)。
  const xProjDimY = loY - g * 0.6, xEccDimY = loY - g * 1.4, xLabelY = loY - g * 2.3;  // X：外面寸(内)/偏芯量(外)/ラベル（上）
  // Y側（横の中心線）は柱芯ラベルを寸法値からさらに離すため、X側より大きく左へ張り出す。
  const yProjDimX = loX - g * 0.6, yEccDimX = loX - g * 1.4, yLabelX = loX - g * 2.7;  // Y：外面寸(内)/偏芯量(外)/ラベル（左）
  // 線はラベルの位置から始めず、ラベルの続き（同じ軸線上）に隙間を空けてから始める
  // （ラベルが線の上に乗って重なるのを避ける。例: 縦線なら「文字／隙間／線」を上から順に配置）。
  const labelGap = g * 0.3;
  const axTop = xLabelY + labelGap, axBot = hiY + g * 0.6;
  // 横の中心線は縦の中心線より長く見せる（右側の張り出しを縦側より大きくする）。
  const axLeft = yLabelX + labelGap, axRight = hiX + g * 1.0;
  // 柱芯（横）のラベルは通り芯Y/「Y」ラベルと同じ x に揃える（右端そろえで縦に整列）。線端点も Y 線と同じ axLeft に合わせる。
  const colAxisLabelX = yLabelX;
  const colAxisLeft = axLeft;

  // 鋼管柱はダイヤフラム外形（断面外面+e の四角）を断面の背面に重ねる。
  const dia = diaphragmRect(section, cx, cy, w, h);
  const prims = [...(dia ? [dia.rect] : []), ...sp];
  // 通り芯X（x=0・縦）／通り芯Y（y=0・横）
  prims.push({ type: 'line', x1: 0, y1: axTop, x2: 0, y2: axBot, dash: 'center', stroke: '#94a3b8' });
  prims.push({ type: 'line', x1: axLeft, y1: 0, x2: axRight, y2: 0, dash: 'center', stroke: '#94a3b8' });
  prims.push({ type: 'text', x: 0, y: xLabelY, text: 'X', anchor: 'middle', size: 10, fill: '#94a3b8' });
  prims.push({ type: 'text', x: yLabelX, y: 0, text: 'Y', anchor: 'end', baseline: 'middle', size: 10, fill: '#94a3b8' });

  if (ctx.rigid) {
    // 外側方向の符号は格納済みオフセットの符号から取る（出幅モデルは offset=s×(halfThis+出幅) で反転しない＝
    // sign(offX)=s）。**図側でフットプリントを再走査しない**——R階伏図・上階伏図など供給グラフのフットプリントが
    // 縮退/相違する階で中通りの符号が0へ落ち、柱芯偏芯量が表示されなくなる不具合（L字/R階伏図中間柱の偏芯不良）を
    // 避けるため、幾何（autoFillColumnAxisOffsets が最下階を権威に確定した offset）にそのまま追従する。
    const sX = Math.sign(offX);
    const sY = Math.sign(offY);
    // 柱芯X／柱芯Y（オフセットが非0＝通り芯と異なるときだけ線・ラベルを出す）。
    if (offX !== 0) {
      prims.push({ type: 'line', x1: offX, y1: axTop, x2: offX, y2: axBot, dash: 'center', stroke: '#64748b' });
      prims.push({ type: 'text', x: offX, y: xLabelY, text: '柱芯', anchor: 'middle', size: 10, fill: '#64748b' });
    }
    if (offY !== 0) {
      prims.push({ type: 'line', x1: colAxisLeft, y1: offY, x2: axRight, y2: offY, dash: 'center', stroke: '#64748b' });
      prims.push({ type: 'text', x: colAxisLabelX, y: offY, text: '柱芯', anchor: 'end', baseline: 'middle', size: 10, fill: '#64748b' });
    }
    // 偏芯量寸法（編集不可）：通り芯⇄柱芯の変位量。外側（断面から遠い側）。
    // 外面寸（出幅）寸法（編集可）：柱面⇄通り芯の距離（建物に1値・X/Y共通）。外面位置＝断面中心 cx を真の外側 sX へ
    // 柱半幅ずらした面（|faceX|＝出幅）。内側（断面寄り）に置き、柱面へ寸法足を出す（足の長さは材寸と同じ footLen）。
    // いずれも外周柱（外側符号≠0）のみ描く。
    const faceProjOpts = { editable: true, target: 'faceProjection', fieldKey: 'columnFaceProjection' };
    if (sX !== 0) {
      const faceX = cx - sX * w / 2; // 柱外面X（通り芯相対・外側 sX 側）。|faceX|＝出幅
      prims.push(...offsetDim('h', 0, offX, xEccDimY));                                            // X偏芯量（通り芯⇄柱芯）read-only：外
      prims.push(...offsetDim('h', 0, faceX, xProjDimY, { ...faceProjOpts, foot: hiY, footLen }));  // X出幅（通り芯⇄柱面）editable：内・柱面へ足
    }
    if (sY !== 0) {
      const faceY = cy - sY * h / 2; // 柱外面Y（通り芯相対・外側 sY 側）。|faceY|＝出幅
      // 縦寸法値は寸法線の右に空きが無いため左側に置く。
      prims.push(...offsetDim('v', 0, offY, yEccDimX, { labelSide: 'left' }));                                       // Y偏芯量 read-only：外
      prims.push(...offsetDim('v', 0, faceY, yProjDimX, { ...faceProjOpts, foot: hiX, footLen, labelSide: 'left' })); // Y出幅 editable：内・柱面へ足
    }
  }
  // 断面寸法（カタログ断面のため read-only）。右に成(h)・下に幅(w)。
  if (dia) {
    // 鋼管は出寸法 e を成 h と同じ寸法線上（同一 at）へ連続させ、柱断面の寸法線と一本化する：上e｜成h（出寸法は上だけ）。
    const e = dia.e;
    prims.push(...materialDim('v', cy - h / 2 - e, cy - h / 2, hiX, 1, e, g, { footLen }));
    prims.push(...materialDim('v', cy - h / 2, cy + h / 2, hiX, 1, h, g, { footLen }));
  } else {
    prims.push(...materialDim('v', cy - h / 2, cy + h / 2, hiX, 1, h, g, { footLen }));
  }
  prims.push(...materialDim('h', cx - w / 2, cx + w / 2, hiY, 1, w, g, { footLen }));
  return { primitives: prims };
}

// 梁の軸線群（柱芯・材芯）＋両者の相互距離（変更不可のテキスト寸法線）を作る。基礎伏図の梁は別経路 axisPrims のため対象外。
// 柱芯 x=axisOffset（基準）、材芯 x=cx（断面中心＝axisOffset＋偏芯量）。外周梁（axisOffset≠0）で偏芯すると2本に分かれ、
// その相互距離を読み取り専用の寸法線で示す（偏芯量は autoFillBeamEccentricity が外面合わせで自動算定。図上の手編集UIは持たない）。
// 柱芯オフセットが無い内部梁（軸＝通り芯一致）では軸線を出さず断面のみ。偏芯0で両軸が一致する場合は断面中心を材芯1本だけ描く。
// eccDimY=相互距離寸法のy、labelY=各軸ラベルのy。
function beamAxisPrims(axisOffset, cx, { eccDimY, labelY }) {
  if (!axisOffset || axisOffset === 0) return [];
  // 偏芯0（材芯＝柱芯）の内部寄り梁は断面中心の材芯1本のみ。
  if (cx === axisOffset) {
    return [
      { type: 'axisV', x: cx, layoutId: 'axis:materialAxis' },
      { type: 'text', x: cx, y: labelY, text: '材芯', anchor: 'middle', size: 10, fill: '#64748b', layoutId: 'text:materialAxisLabel' },
    ];
  }
  return [
    { type: 'axisV', x: axisOffset, layoutId: 'axis:columnAxis' },
    { type: 'text', x: axisOffset, y: labelY, text: '柱芯', anchor: 'middle', size: 10, fill: '#94a3b8', layoutId: 'text:columnAxisLabel' },
    { type: 'axisV', x: cx, layoutId: 'axis:materialAxis' },
    { type: 'text', x: cx, y: labelY, text: '材芯', anchor: 'middle', size: 10, fill: '#64748b', layoutId: 'text:materialAxisLabel' },
    // 柱芯⇄材芯の相互距離。編集オプションを付けない＝変更不可の静的テキスト寸法線。
    ...withLayoutId('dim:eccentricity', offsetDim('h', axisOffset, cx, eccDimY)),
  ];
}

// --- 梁（S造=H形鋼／RC=矩形）。FL線付き ---------------------------------------
function beamFigure(beam, ctx) {
  if (beam.materialType === 'STEEL') {
    const section = findSectionEntry(beam.sectionDefId);
    const axisOffset = ctx.axisOffset ?? 0;
    const cx = axisOffset + (ctx.ecc ?? 0);
    const { prims: sp, w, h } = sectionShapePrims(section, cx, 0);
    const g = resolveGap(ctx, Math.max(w, h));
    // 各要素に layoutId を付け、S造梁の配置検討モード（scope='steelBeam'）で個別に移動できるようにする。
    const prims = [
      ...beamAxisPrims(axisOffset, cx, { eccDimY: -g * 0.95, labelY: -g * 1.55 }),
      ...withLayoutId('levelLine:FL', [{ type: 'levelLine', y: -g * 0.6, label: ctx.flLabel ?? 'FL' }]),
      ...withLayoutId('shape:section', sp),
      ...withLayoutId('dim:height', materialDim('v', 0, h, cx + w / 2, 1, section?.height ?? h, g)),
      ...withLayoutId('dim:width', materialDim('h', cx - w / 2, cx + w / 2, h, 1, section?.width ?? w, g)),
    ];
    // 断面名はカードの「断面」プルダウンで示す（図中ラベルは置かない）。
    return { primitives: prims };
  }
  if (beam.materialType === 'RC') {
    return rcRectBeamFigure(beam, ctx, ctx.flLabel ?? 'FL');
  }
  // SRC造は次フェーズ（問題.md L102 空欄）
  return { primitives: [{ type: 'text', x: 0, y: 0, text: 'SRC造 梁は次フェーズ', anchor: 'middle', size: 11 }] };
}

// RC矩形梁（梁成D・梁幅b は編集可能寸法。beamWidth/beamDepth）。
function rcRectBeamFigure(beam, ctx, levelLabel) {
  const b = beam.beamWidth ?? 300;
  const D = beam.beamDepth ?? 600;
  const axisOffset = ctx.axisOffset ?? 0;
  const cx = axisOffset + (ctx.ecc ?? 0);
  const g = resolveGap(ctx, Math.max(b, D));
  const prims = [
    ...beamAxisPrims(axisOffset, cx, { eccDimY: -g * 0.4, labelY: -g * 0.95 }),
    { type: 'levelLine', y: 0, label: levelLabel },
    { type: 'rect', x: cx - b / 2, y: 0, w: b, h: D, hatch: 'concrete' },
    // 梁成D・梁幅b は構造算定値のため read-only（手入力での大きさ変更は不可）。
    ...materialDim('v', 0, D, cx + b / 2, 1, D, g),
    ...materialDim('h', cx - b / 2, cx + b / 2, D, 1, b, g),
  ];
  return { primitives: prims };
}

// 木造基礎の断面詳細の既定寸法（問題.md）。ベース600×150・張り出し0、べた基礎 厚150・天端GL+50、基礎梁の地中部250。
// beam.foundationSection に保存された編集値があれば上書きする（未編集分はこの既定で補完）。
const WOOD_FOUNDATION_DEFAULTS = Object.freeze({
  embedDepth: 250, baseWidth: 600, baseThickness: 150, baseOverhang: 0, matThickness: 150, matTopAboveGL: 50,
});

// 編集可能な材寸法線（materialDim に editable/target/fieldKey を付ける）。value がラベル＝現在値。
function editMatDim(dir, from, to, edge, side, value, g, target, fieldKey, opts = {}) {
  return materialDim(dir, from, to, edge, side, value, g, { editable: true, target, fieldKey, ...opts });
}

// --- 基礎梁（RC矩形 ＋ GL線）。木造は基礎種別ごとにベース／べた基礎マットを合成し、問題.md の寸法を
//     すべて編集可能フィールドとして配置する（ctx.woodFoundation）。非木造は従来どおり梁天端=GL・read-only。
function foundationBeamFigure(beam, ctx) {
  const b = beam.beamWidth ?? 350;
  const D = beam.beamDepth ?? 600;
  const axisOffset = ctx.axisOffsetX ?? ctx.axisOffset ?? 0;
  const cx = axisOffset + (ctx.ecc ?? 0);
  const wood = !!ctx.woodFoundation;

  if (!wood) {
    // 非木造：従来の read-only 断面（梁天端=GL、フーチング合成は ctx.footing 指定時のみ）。
    const g = resolveGap(ctx, Math.max(b, D));
    const prims = [
      ...axisPrims(axisOffset, { dimY: -g * 0.35, labelY: -g * 0.95, clId: ctx.axisClId ?? ctx.axisClIdX }),
      { type: 'levelLine', y: 0, label: ctx.glLabel ?? 'GL（FL）' },
      { type: 'rect', x: cx - b / 2, y: 0, w: b, h: D, hatch: 'concrete' },
      ...materialDim('v', 0, D, cx + b / 2, 1, D, g),
      ...materialDim('h', cx - b / 2, cx + b / 2, D, 1, b, g),
    ];
    if (ctx.footing) {
      const fw = ctx.footing.widthX ?? b * 1.7;
      const fh = ctx.footing.height ?? 250;
      prims.push({ type: 'rect', x: cx - fw / 2, y: D, w: fw, h: fh, hatch: 'concrete' });
      prims.push(...materialDim('h', cx - fw / 2, cx + fw / 2, D + fh, 1, fw, g));
    }
    return { primitives: prims };
  }

  // ---- 木造：問題.md の基礎断面（全寸法を編集可能フィールドとして配置）----
  const fs = { ...WOOD_FOUNDATION_DEFAULTS, ...(beam.foundationSection ?? {}) };
  const isMat = ctx.foundationType === 'ベタ基礎';
  const embed = Math.min(fs.embedDepth, D); // 地中部（GL下）
  const rise  = D - embed;                  // 立ち上がり（GL上）
  const g = resolveGap(ctx, Math.max(b, D, fs.baseWidth));
  const glY = 0;                  // GL を y=0（基礎梁内部を通る）
  const beamTopY = glY - rise;    // 基礎梁天端 = GL+rise
  const beamBotY = glY + embed;   // 基礎梁下端 = GL−embed
  const beamLeft = cx - b / 2, beamRight = cx + b / 2;

  const prims = [
    ...axisPrims(axisOffset, { dimY: beamTopY - g * 0.4, labelY: beamTopY - g * 1.15, clId: ctx.axisClId ?? ctx.axisClIdX }),
    // GL：通り芯と同様に「線（datum）」と「ラベル」を分離し、それぞれ配置検討で独立移動できるようにする。
    ...withLayoutId('levelLine:GL', [{ type: 'levelLine', y: glY, noLabel: true }]),
    ...withLayoutId('text:glLabel', [{ type: 'text', x: beamLeft - g * 1.95, y: glY - 3, text: '▽ GL', anchor: 'end', size: 10, fill: '#94a3b8' }]),
    ...withLayoutId('rect:beam', [{ type: 'rect', x: beamLeft, y: beamTopY, w: b, h: D, hatch: 'concrete' }]),
    // 基礎梁幅 b（上・水平、編集可）。
    ...withLayoutId('dim:beamWidth', editMatDim('h', beamLeft, beamRight, beamTopY, -1, b, g * 0.6, null, 'beamWidth')),
    // 基礎梁成 D=立ち上がり+地中（左・外側、編集可）。
    ...withLayoutId('dim:beamDepth', editMatDim('v', beamTopY, beamBotY, beamLeft, -1, D, g * 1.9, null, 'beamDepth')),
    // 立ち上がり（左・内側、編集可。成Dを rise+地中 に保つ）。
    ...withLayoutId('dim:rise', editMatDim('v', beamTopY, glY, beamLeft, -1, rise, g * 0.85, 'riseAboveGL', null)),
    // 地中部（左・内側、編集可）。
    ...withLayoutId('dim:embed', editMatDim('v', glY, beamBotY, beamLeft, -1, embed, g * 0.85, 'foundationSection', 'embedDepth')),
  ];

  if (isMat) {
    // べた基礎：ベースなし。屋内側（右）に厚150・天端GL+50のマットスラブ。天端・厚を編集可フィールドに。
    const matTopY = glY - fs.matTopAboveGL;
    const matLen  = fs.baseWidth;
    const matRight = beamRight + matLen;
    prims.push(...withLayoutId('rect:mat', [{ type: 'rect', x: beamRight, y: matTopY, w: matLen, h: fs.matThickness, hatch: 'concrete' }]));
    prims.push(...withLayoutId('text:matLabel', [{ type: 'text', x: beamRight + matLen / 2, y: matTopY - g * 0.5, text: 'べた基礎', anchor: 'middle', size: 10, fill: '#94a3b8' }]));
    // 天端（GL→マット天端、垂直・編集可）。
    prims.push(...withLayoutId('dim:matTopAboveGL', editMatDim('v', matTopY, glY, matRight, 1, fs.matTopAboveGL, g * 0.6, 'foundationSection', 'matTopAboveGL')));
    // べた基礎厚（垂直・編集可）。
    prims.push(...withLayoutId('dim:matThickness', editMatDim('v', matTopY, matTopY + fs.matThickness, matRight, 1, fs.matThickness, g * 1.4, 'foundationSection', 'matThickness')));
  } else {
    // なし／土間コン：基礎梁下にベース（幅・厚・張り出しを編集可フィールドに）。張り出しは屋外側（左）。
    const baseLeft = beamLeft - fs.baseOverhang;
    const baseRight = baseLeft + fs.baseWidth;
    const baseY = beamBotY;
    prims.push(...withLayoutId('rect:base', [{ type: 'rect', x: baseLeft, y: baseY, w: fs.baseWidth, h: fs.baseThickness, hatch: 'concrete' }]));
    // ベース幅（下・水平、編集可）。
    prims.push(...withLayoutId('dim:baseWidth', editMatDim('h', baseLeft, baseRight, baseY + fs.baseThickness, 1, fs.baseWidth, g, 'foundationSection', 'baseWidth')));
    // ベース厚（右・垂直、編集可）。
    prims.push(...withLayoutId('dim:baseThickness', editMatDim('v', baseY, baseY + fs.baseThickness, baseRight, 1, fs.baseThickness, g * 0.6, 'foundationSection', 'baseThickness')));
    // ベース張り出し（屋外側＝左、基礎梁外面→ベース外面、水平・編集可）。
    prims.push(...withLayoutId('dim:baseOverhang', editMatDim('h', baseLeft, beamLeft, baseY, -1, fs.baseOverhang, g * 0.5, 'foundationSection', 'baseOverhang')));
    if (ctx.foundationType === '土間コン') {
      // 土間コン：屋内側（右）にGLレベルの土間スラブ（模式・寸法なし）。
      prims.push(...withLayoutId('rect:doma', [{ type: 'rect', x: beamRight, y: glY, w: fs.baseWidth, h: 120, hatch: 'concrete' }]));
      prims.push(...withLayoutId('text:domaLabel', [{ type: 'text', x: beamRight + fs.baseWidth / 2, y: glY - g * 0.4, text: '土間コン', anchor: 'middle', size: 10, fill: '#94a3b8' }]));
    }
  }
  return { primitives: prims };
}

// --- 独立フーチング（基礎梁フーチング）。RC箱、GL線、幅編集可 ----------------------
function footingFigure(footing, ctx) {
  const wx = footing.widthX ?? 600;
  const top = footing.topLevel ?? 0;
  const bottom = footing.bottomLevel ?? (top - 250);
  const fh = Math.abs(top - bottom) || 250;
  const axisOffset = ctx.axisOffsetX ?? 0;
  const cx = axisOffset + (ctx.eccX ?? 0);
  const g = resolveGap(ctx, Math.max(wx, fh));
  const prims = [
    ...axisPrims(axisOffset, { dimY: -g * 0.35, labelY: -g * 0.95, clId: ctx.axisClIdX }),
    { type: 'levelLine', y: 0, label: ctx.glLabel ?? 'GL' },
    { type: 'rect', x: cx - wx / 2, y: g * 0.6, w: wx, h: fh, hatch: 'concrete' },
    // 構造算定値のため read-only。
    ...materialDim('h', cx - wx / 2, cx + wx / 2, g * 0.6 + fh, 1, wx, g),
    ...materialDim('v', g * 0.6, g * 0.6 + fh, cx + wx / 2, 1, fh, g),
  ];
  return { primitives: prims };
}

// --- 柱脚（上に平断面、下に縦断面。GL/通り芯/柱芯。杭は描かない） -------------------
function columnBaseFigure(cb, ctx) {
  const wx = cb.widthX ?? 800;
  const wy = cb.widthY ?? 800;
  const depth = cb.pedestalDepth ?? 600;
  const axisOffset = ctx.axisOffsetX ?? 0;
  const cx = axisOffset + (ctx.eccX ?? 0);
  const g = resolveGap(ctx, Math.max(wx, wy, depth));

  // 平断面（上）: wx×wy の矩形。y帯を上部に確保。
  const planTopY = -(wy + g * 2.2);
  const prims = [
    // 構造算定値のため寸法はすべて read-only（手入力での大きさ変更は不可）。
    { type: 'rect', x: cx - wx / 2, y: planTopY, w: wx, h: wy, hatch: 'concrete' },
    ...materialDim('h', cx - wx / 2, cx + wx / 2, planTopY, -1, wx, g),
    ...materialDim('v', planTopY, planTopY + wy, cx + wx / 2, 1, wy, g),
    // 縦断面（下）: GL線＋ペデスタル箱。
    ...axisPrims(axisOffset, { dimY: -g * 0.35, labelY: -g * 0.95, clId: ctx.axisClIdX }),
    { type: 'levelLine', y: 0, label: ctx.glLabel ?? 'GL' },
    { type: 'rect', x: cx - wx / 2, y: 0, w: wx, h: depth, hatch: 'concrete' },
    ...materialDim('v', 0, depth, cx + wx / 2, 1, depth, g),
  ];
  return { primitives: prims };
}

// --- スラブ（厚指定。FL線＋帯。デッキは台形リブ＋方向ラベル） ---------------------
function slabFigure(slab, ctx) {
  const t = slab.thickness ?? 150;
  // 表示用の代表幅は厚みに比例（過大だと厚み寸法が相対的に小さく潰れるため）。
  const width = Math.max(t * 7, 700);
  const g = resolveGap(ctx, t * 3);
  const prims = [{ type: 'levelLine', y: 0, label: ctx.flLabel ?? 'FL' }];
  if (slab.slabKind === 'deck') {
    prims.push(...deckProfile(-width / 2, 0, width, t));
    // 描画エリアの両矢印クリックで90度回転する「デッキ方向」（問題.md L117-119）。断面図では方向ラベルで示す。
    prims.push({ type: 'text', x: 0, y: t + g * 0.95, text: `デッキ方向 ${slab.deckDirection === 'y' ? 'Y' : 'X'}`, anchor: 'middle', size: 11 });
  } else {
    prims.push({ type: 'rect', x: -width / 2, y: 0, w: width, h: t, hatch: 'concrete' });
  }
  prims.push(...materialDim('v', 0, t, width / 2, 1, t, g, { editable: true, fieldKey: 'thickness' }));
  return { primitives: prims };
}

// デッキプレートの台形リブ断面（簡易プロファイル）。上端 topY、全幅 w、成 t。
function deckProfile(x0, topY, w, t) {
  const ribs = 6;
  const pitch = w / ribs;
  const flat = pitch * 0.35; // 山・谷の平坦部
  const pts = [[x0, topY]];
  for (let i = 0; i < ribs; i++) {
    const x = x0 + i * pitch;
    pts.push([x, topY], [x + flat, topY + t], [x + pitch - flat, topY + t], [x + pitch, topY]);
  }
  pts.push([x0 + w, topY]);
  return [{ type: 'polyline', points: pts, stroke: '#475569' }];
}

// --- 耐力壁（RC=厚帯／S造= なし・ブレース・鋼板壁） -------------------------------
function bearingWallFigure(wall, ctx = {}) {
  const wt = wall.wallType ?? 'rc';
  const t = wall.thickness ?? 150;
  // 縦帯の代表高さは厚みに比例（厚み寸法を相対的に大きく見せる）。
  const height = Math.max(t * 7, 700);
  const g = resolveGap(ctx, t * 3);
  if (wt === 'none') {
    return { primitives: [
      { type: 'axisV', x: 0, label: '壁芯' },
      { type: 'text', x: 0, y: height / 2, text: 'なし', anchor: 'middle', size: 12 },
    ] };
  }
  if (wt === 'brace') {
    // ブレース（×型）はベイ立面の模式。壁芯を中心に表示用ベイ幅で描く。
    const bw = 900;
    return { primitives: [
      { type: 'rect', x: -bw / 2, y: 0, w: bw, h: height, stroke: '#94a3b8' },
      { type: 'line', x1: -bw / 2, y1: 0, x2: bw / 2, y2: height, stroke: '#475569', width: 1.5 },
      { type: 'line', x1: bw / 2, y1: 0, x2: -bw / 2, y2: height, stroke: '#475569', width: 1.5 },
      { type: 'text', x: 0, y: -g * 0.4, text: 'ブレース', anchor: 'middle', size: 11 },
    ] };
  }
  // steelPlate（鋼板壁）= 鋼材塗り帯 / rc = コンクリートハッチ帯。いずれも厚指定。
  const isSteel = wt === 'steelPlate';
  return { primitives: [
    { type: 'axisV', x: 0, label: '壁芯' },
    { type: 'rect', x: -t / 2, y: 0, w: t, h: height, fill: isSteel ? STEEL_FILL : undefined, hatch: isSteel ? undefined : 'concrete' },
    ...materialDim('h', -t / 2, t / 2, 0, -1, t, g, { editable: true, fieldKey: 'thickness' }),
    // ラベルは寸法線の足と重ならないよう、寸法線よりさらに上に置く。
    ...(isSteel ? [{ type: 'text', x: 0, y: -g * 1.3, text: '鋼板壁', anchor: 'middle', size: 11 }] : []),
  ] };
}

// --- ディスパッチャ ----------------------------------------------------------
function dispatchFigure(entity, mapName, ctx) {
  switch (mapName) {
    case 'columnMap':  return columnFigure(entity, ctx);
    case 'beamMap':    return entity.role === 'foundation' ? foundationBeamFigure(entity, ctx) : beamFigure(entity, ctx);
    case 'footingMap': return ('baseType' in entity) ? columnBaseFigure(entity, ctx) : footingFigure(entity, ctx);
    case 'slabMap':    return slabFigure(entity, ctx);
    case 'wallMap':    return bearingWallFigure(entity, ctx);
    default:           return { primitives: [] };
  }
}

// スクリーン空間注記の縮尺決定（2パス）。
// ctx.frame（{maxWidth,maxHeight}）が渡れば、1パス目で形状だけの mm 範囲から縮尺を見積もり、
// 2パス目に scale を渡して注記の隙間を px 一定（GAP_BASE_PX）で再生成する。決定した scale も返す
// （描画側 AutoScaledFigure は同じ scale を使い、注記を縮尺非依存の一定間隔で描く）。
// frame 未指定（Konva 等）や scale 確定済みは従来どおり（mm 比率 gap・scale は描画側が決める）。
export function memberFigure(entity, mapName, ctx = {}) {
  if (!ctx.frame || ctx.scale != null) return dispatchFigure(entity, mapName, ctx);
  const sb = shapeBounds(dispatchFigure(entity, mapName, ctx).primitives); // 1パス目：形状範囲（注記除外）
  const f = ctx.frame;
  const scale = chooseScale(sb.width, sb.height, f.maxWidth - 2 * ANNOTATION_RESERVE_PX, f.maxHeight - 2 * ANNOTATION_RESERVE_PX);
  return { ...dispatchFigure(entity, mapName, { ...ctx, scale }), scale }; // 2パス目：px 一定 gap
}
