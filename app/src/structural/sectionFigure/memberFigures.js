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

import { findSectionEntry, SectionShape } from '../sectionCatalog.js';

const STEEL_FILL = '#475569';
// 偏芯量寸法線の端点マーカー（丸）の半径。縮尺に関わらずどの図でも同じ大きさに見えるようpx固定。
const MARKER_R_PX = 1.25;

// 寸法線が断面外へ張り出す mm 量を、断面の代表寸法から決める（縮尺非依存に見えるよう比率で）。
function gapFor(extent) { return Math.max(extent * 0.4, 80); }

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
  return [
    ...endpointMarkers(dir, 0, axisOffset, at),
    dim(dir, 0, axisOffset, at, Math.abs(axisOffset), { ...opts, noTick: true }),
  ];
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

// 通り芯・柱芯（縦の一点鎖線）＋変位量 [275] を作る。
// 通り芯を x=0、柱芯を x=axisOffset に置く。offset=0（非ラーメン）なら柱芯線は出さない。
// dimY=変位寸法線のy（断面寄り）、labelY=通り芯/柱芯ラベルのy（変位寸法の上、スペースをあけて）。
// clId が渡れば変位量を編集可能にする（確定で graph.columnAxisOffsets を更新→描画エリア再描画）。
function axisPrims(axisOffset, { dimY, labelY, clId }) {
  const prims = [
    { type: 'axisV', x: 0 },
    { type: 'text', x: 0, y: labelY, text: '通り芯', anchor: 'middle', size: 10, fill: '#94a3b8' },
  ];
  if (axisOffset && axisOffset !== 0) {
    prims.push({ type: 'axisV', x: axisOffset });
    prims.push({ type: 'text', x: axisOffset, y: labelY, text: '柱芯', anchor: 'middle', size: 10, fill: '#94a3b8' });
    const opts = clId ? { editable: true, fieldKey: 'axisOffset', target: 'axisOffset', clId } : {};
    prims.push(...eccentricityDim('h', axisOffset, dimY, opts));
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
  // 柱は寸法線・ラベルが密集しやすいため、通常の gapFor よりさらに広めに離す。
  const g = gapFor(Math.max(w, h)) * 1.4;

  // 軸線の伸長範囲（通り芯・柱芯・断面を内包）。
  const loX = Math.min(0, offX, cx - w / 2), hiX = Math.max(0, offX, cx + w / 2);
  const loY = Math.min(0, offY, cy - h / 2), hiY = Math.max(0, offY, cy + h / 2);
  // 偏芯量の寸法線は柱断面からしっかり離す（断面寄りに描くと断面と紛れるため）。
  const xDimY = loY - g * 0.6, xLabelY = loY - g * 1.6;   // X変位寸法とX/柱芯ラベル（上）
  // Y側（横の中心線）は柱芯ラベルを偏芯量の寸法値からさらに離すため、X側より大きく左へ張り出す。
  const yDimX = loX - g * 0.6, yLabelX = loX - g * 2.0;    // Y変位寸法とY/柱芯ラベル（左）
  // 線はラベルの位置から始めず、ラベルの続き（同じ軸線上）に隙間を空けてから始める
  // （ラベルが線の上に乗って重なるのを避ける。例: 縦線なら「文字／隙間／線」を上から順に配置）。
  const labelGap = g * 0.3;
  const axTop = xLabelY + labelGap, axBot = hiY + g * 0.6;
  // 横の中心線は縦の中心線より長く見せる（右側の張り出しを縦側より大きくする）。
  const axLeft = yLabelX + labelGap, axRight = hiX + g * 1.0;
  // 柱芯（横）のラベル・線端点だけは、柱断面中心(cx)からの距離を1.5倍にしてさらに左へ
  // 張り出す（通り芯Y/「Y」ラベルの位置・axLeftはここでは変更しない）。
  const colAxisLabelX = cx - (cx - yLabelX) * 1.5;
  const colAxisLeft = colAxisLabelX + labelGap;

  const prims = [...sp];
  // 通り芯X（x=0・縦）／通り芯Y（y=0・横）
  prims.push({ type: 'line', x1: 0, y1: axTop, x2: 0, y2: axBot, dash: 'center', stroke: '#94a3b8' });
  prims.push({ type: 'line', x1: axLeft, y1: 0, x2: axRight, y2: 0, dash: 'center', stroke: '#94a3b8' });
  prims.push({ type: 'text', x: 0, y: xLabelY, text: 'X', anchor: 'middle', size: 10, fill: '#94a3b8' });
  prims.push({ type: 'text', x: yLabelX, y: 0, text: 'Y', anchor: 'end', baseline: 'middle', size: 10, fill: '#94a3b8' });

  if (ctx.rigid) {
    // 柱芯X／柱芯Y（オフセットが非0のときだけ線・ラベルを出す。0でも変位寸法は編集可で出す）。
    if (offX !== 0) {
      prims.push({ type: 'line', x1: offX, y1: axTop, x2: offX, y2: axBot, dash: 'center', stroke: '#64748b' });
      prims.push({ type: 'text', x: offX, y: xLabelY, text: '柱芯', anchor: 'middle', size: 10, fill: '#64748b' });
    }
    if (offY !== 0) {
      prims.push({ type: 'line', x1: colAxisLeft, y1: offY, x2: axRight, y2: offY, dash: 'center', stroke: '#64748b' });
      prims.push({ type: 'text', x: colAxisLabelX, y: offY, text: '柱芯', anchor: 'end', baseline: 'middle', size: 10, fill: '#64748b' });
    }
    prims.push(...eccentricityDim('h', offX, xDimY, { editable: true, target: 'axisOffset', fieldKey: 'axisOffset', clId: ctx.axisClIdX }));
    // 偏芯量の縦寸法値は寸法線の右に空きが無いため、左側（通り芯/柱芯ラベルとの間）に置く。
    prims.push(...eccentricityDim('v', offY, yDimX, { editable: true, target: 'axisOffset', fieldKey: 'axisOffset', clId: ctx.axisClIdY, labelSide: 'left' }));
  }
  // 断面寸法（カタログ断面のため read-only）。右に成(h)・下に幅(w)。
  prims.push(...materialDim('v', cy - h / 2, cy + h / 2, hiX, 1, h, g));
  prims.push(...materialDim('h', cx - w / 2, cx + w / 2, hiY, 1, w, g));
  return { primitives: prims };
}

// --- 梁（S造=H形鋼／RC=矩形）。FL線付き ---------------------------------------
function beamFigure(beam, ctx) {
  if (beam.materialType === 'STEEL') {
    const section = findSectionEntry(beam.sectionDefId);
    const axisOffset = ctx.axisOffset ?? 0;
    const cx = axisOffset + (ctx.ecc ?? 0);
    const { prims: sp, w, h } = sectionShapePrims(section, cx, 0);
    const g = gapFor(Math.max(w, h));
    const prims = [
      ...axisPrims(axisOffset, { dimY: -g * 0.95, labelY: -g * 1.55, clId: ctx.axisClId }),
      { type: 'levelLine', y: -g * 0.6, label: ctx.flLabel ?? 'FL' },
      ...sp,
      ...materialDim('v', 0, h, cx + w / 2, 1, section?.height ?? h, g),
      ...materialDim('h', cx - w / 2, cx + w / 2, h, 1, section?.width ?? w, g),
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
  const g = gapFor(Math.max(b, D));
  const prims = [
    ...axisPrims(axisOffset, { dimY: -g * 0.35, labelY: -g * 0.95, clId: ctx.axisClId }),
    { type: 'levelLine', y: 0, label: levelLabel },
    { type: 'rect', x: cx - b / 2, y: 0, w: b, h: D, hatch: 'concrete' },
    // 梁成D・梁幅b は構造算定値のため read-only（手入力での大きさ変更は不可）。
    ...materialDim('v', 0, D, cx + b / 2, 1, D, g),
    ...materialDim('h', cx - b / 2, cx + b / 2, D, 1, b, g),
  ];
  return { primitives: prims };
}

// --- 基礎梁（RC矩形 ＋ GL線。フーチング合成は ctx.footing 指定時のみ） ----------------
function foundationBeamFigure(beam, ctx) {
  const b = beam.beamWidth ?? 350;
  const D = beam.beamDepth ?? 600;
  const axisOffset = ctx.axisOffsetX ?? ctx.axisOffset ?? 0;
  const cx = axisOffset + (ctx.ecc ?? 0);
  const g = gapFor(Math.max(b, D));
  const glY = 0;          // GL を y=0
  const beamTopY = glY;   // 基礎梁は GL から下へ
  const prims = [
    ...axisPrims(axisOffset, { dimY: -g * 0.35, labelY: -g * 0.95, clId: ctx.axisClId ?? ctx.axisClIdX }),
    { type: 'levelLine', y: glY, label: ctx.glLabel ?? 'GL（FL）' },
    { type: 'rect', x: cx - b / 2, y: beamTopY, w: b, h: D, hatch: 'concrete' },
    // 構造算定値のため read-only。
    ...materialDim('v', beamTopY, beamTopY + D, cx + b / 2, 1, D, g),
    ...materialDim('h', cx - b / 2, cx + b / 2, beamTopY + D, 1, b, g),
  ];
  // フーチング合成断面（FG）: 基礎梁の下に幅広の独立フーチングを重ねる。
  if (ctx.footing) {
    const fw = ctx.footing.widthX ?? b * 1.7;
    const fh = ctx.footing.height ?? 250;
    const fY = beamTopY + D;
    prims.push({ type: 'rect', x: cx - fw / 2, y: fY, w: fw, h: fh, hatch: 'concrete' });
    prims.push(...materialDim('h', cx - fw / 2, cx + fw / 2, fY + fh, 1, fw, g));
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
  const g = gapFor(Math.max(wx, fh));
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
  const g = gapFor(Math.max(wx, wy, depth));

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
  const g = gapFor(t * 3);
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
function bearingWallFigure(wall) {
  const wt = wall.wallType ?? 'rc';
  const t = wall.thickness ?? 150;
  // 縦帯の代表高さは厚みに比例（厚み寸法を相対的に大きく見せる）。
  const height = Math.max(t * 7, 700);
  const g = gapFor(t * 3);
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
export function memberFigure(entity, mapName, ctx = {}) {
  switch (mapName) {
    case 'columnMap':  return columnFigure(entity, ctx);
    case 'beamMap':    return entity.role === 'foundation' ? foundationBeamFigure(entity, ctx) : beamFigure(entity, ctx);
    case 'footingMap': return ('baseType' in entity) ? columnBaseFigure(entity, ctx) : footingFigure(entity, ctx);
    case 'slabMap':    return slabFigure(entity, ctx);
    case 'wallMap':    return bearingWallFigure(entity, ctx);
    default:           return { primitives: [] };
  }
}
