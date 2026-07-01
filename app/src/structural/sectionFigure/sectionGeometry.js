// ================================================================
// 断面図ジオメトリモデル（mm単位の純データ。core.js非依存）
//
// 部材別ジェネレータ（columnFigure 等）が返す「図」を表す中立データ。
// パネルは SVG（AutoScaledFigure.jsx）、描画エリアは Konva（Phase 6）で
// この同じデータを消費する（描画対象＝編集対象、レンダラのみ2系統）。
//
// 座標系: mm、y軸下向き正（CLAUDE.md準拠）。断面図では y が大きいほど下。
//
// プリミティブ（type 別フィールド。すべて mm 座標）:
//   rect      { x, y, w, h, fill?, stroke?, hatch? }            矩形（hatch:'concrete'でRCハッチ）
//   circle    { cx, cy, r, rPx?, fill?, stroke? }                円（RC丸柱・丸形鋼管）。rPx指定時は
//                                                               縮尺に関わらず常に同じpx半径（交点マーカー等の目印用、r は無視）。
//   line      { x1, y1, x2, y2, dash?, stroke?, width? }        単純線
//   polyline  { points:[[x,y]...], closed?, fill?, stroke? }    折れ線/多角形
//   hSection  { x, y, w, h, web, flange, fill? }                H形鋼の実形状（x,y=左上, w=幅, h=成）
//   text      { x, y, text, anchor?, baseline?, size? }         ラベル（size=px、既定12）
//   axisV     { x, label }                                      縦の基準線（通り芯/柱芯。一点鎖線）
//   levelLine { y, label }                                      横の基準レベル線（GL/FL。▽記号付）
//   dim       { dir:'h'|'v', from, to, at, label, fieldKey?, editable?, foot?, labelSide?, noTick? }
//                                                               寸法線。dir='h'はx方向(from..to)を測りy=atに描く。
//                                                               dir='v'はy方向(from..to)を測りx=atに描く。
//                                                               editable+fieldKey で図上直接編集の対象になる。
//                                                               foot: 材側の座標（atと同じ軸）。指定時は端のチックの
//                                                               代わりに「寸法線⇄材」の引出線を描く（材と反対側へは出さない）。
//                                                               footLen: 引出線（足）の長さ(mm)。指定時は寸法線を材から離しても足は一定長で描き、
//                                                               材との間に空きを作る（未指定は材⇄寸法線の2/3を引く比率方式）。
//                                                               noTick: true で端のチックを出さない（foot指定時は常にチック無し）。
//                                                               labelSide:'left' で dir='v' の寸法値を寸法線の左側に表示する。
// ================================================================

// 寸法線が幾何形状の外側へ張り出す分（mm換算ではなく px 余白として renderer で確保する）。
// 縦寸法値（数字3〜4桁）が右マージンへ食い込んで見切れない幅を確保する。
export const FIGURE_MARGIN_PX = 32;

// 自動縮尺の候補（建築標準スケール、px/mm の降順）。材寸から算出した bounds に対し、
// 毎回パネルを埋める最大スケールを選ぶ（材寸が変われば再計算され縮尺も追従する＝固定しない）。
// 刻みを細かくして、スケール段差による余白（収まりすぎて小さく見える状態）を抑える。
const NICE_SCALES = [
  1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 8, 1 / 10, 1 / 15, 1 / 20, 1 / 25,
  1 / 30, 1 / 40, 1 / 50, 1 / 75, 1 / 100, 1 / 150, 1 / 200, 1 / 300, 1 / 500,
];

// 1図の全プリミティブを走査して mm 単位のバウンディングボックスを返す。
// 寸法線(dim)・基準線(axisV/levelLine)も含める（張り出しを縮尺計算に織り込むため）。
// text のラベル幅は px 依存で mm 確定できないため renderer の px 余白(FIGURE_MARGIN_PX)に委ねる。
export function figureBounds(primitives) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ext = (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const p of primitives) {
    switch (p.type) {
      case 'rect':
      case 'hSection':
        ext(p.x, p.y); ext(p.x + p.w, p.y + p.h); break;
      case 'circle':
        // rPx指定（px固定半径の目印）はmmで確定できないため中心点のみ寄与（pxマージンに委ねる）。
        if (p.rPx != null) { ext(p.cx, p.cy); } else { ext(p.cx - p.r, p.cy - p.r); ext(p.cx + p.r, p.cy + p.r); }
        break;
      case 'line':
        ext(p.x1, p.y1); ext(p.x2, p.y2); break;
      case 'arrow':
        ext(p.x1, p.y1); ext(p.x2, p.y2);
        if (p.labelX != null) ext(p.labelX, p.labelY);
        break;
      case 'polyline':
        for (const [x, y] of p.points) ext(x, y); break;
      case 'text':
        ext(p.x, p.y); break;
      case 'axisV':
        ext(p.x, minY === Infinity ? p.x : minY); break; // x のみ寄与（y範囲は他要素に従う）
      case 'levelLine':
        ext(maxX === -Infinity ? 0 : maxX, p.y); break;
      case 'dim':
        if (p.dir === 'h') { ext(p.from, p.at); ext(p.to, p.at); }
        else               { ext(p.at, p.from); ext(p.at, p.to); }
        break;
      default: break;
    }
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// 形状（部材断面そのもの）だけの mm 範囲。注記（dim/text/基準線/px固定マーカー・軸線）を除いて求める。
// スクリーン空間注記では縮尺を「形状」基準で決める（注記の張り出しは px 一定で別途確保するため、
// 注記を範囲に含めると縮尺が注記量に引きずられて形状が小さくなりすぎる）。
const SHAPE_TYPES = new Set(['rect', 'hSection', 'polyline', 'circle']);
export function shapeBounds(primitives) {
  return figureBounds(primitives.filter(p => SHAPE_TYPES.has(p.type) && !(p.type === 'circle' && p.rPx != null)));
}

// 幾何の mm サイズと描画可能 px 枠から、枠を埋める最大の建築標準スケール(px/mm)を選ぶ。
// px余白(FIGURE_MARGIN_PX)は枠から差し引く。返り値は NICE_SCALES のいずれか。
export function chooseScale(mmWidth, mmHeight, maxPxWidth, maxPxHeight) {
  const usableW = Math.max(1, maxPxWidth - 2 * FIGURE_MARGIN_PX);
  const usableH = Math.max(1, maxPxHeight - 2 * FIGURE_MARGIN_PX);
  if (mmWidth <= 0 && mmHeight <= 0) return 1 / 10;
  // 枠に収めるのに使える px/mm（これ以下の最大スケールを選ぶ＝はみ出さず最大表示）。
  const fit = Math.min(
    mmWidth  > 0 ? usableW / mmWidth  : Infinity,
    mmHeight > 0 ? usableH / mmHeight : Infinity,
  );
  for (const s of NICE_SCALES) if (s <= fit) return s;
  return NICE_SCALES[NICE_SCALES.length - 1]; // 巨大断面は最小スケールで頭打ち
}

// スケール(px/mm)を "1/10" 等の表示ラベルへ整形する。
export function scaleLabel(scale) {
  return scale >= 1 ? `${Math.round(scale)}/1` : `1/${Math.round(1 / scale)}`;
}

// mm→px 変換器を作る。原点は bounds 左上 + px余白。
export function makeTransform(bounds, scale) {
  const pxPerMm = scale;
  const tx = mm => FIGURE_MARGIN_PX + (mm - bounds.minX) * pxPerMm;
  const ty = mm => FIGURE_MARGIN_PX + (mm - bounds.minY) * pxPerMm;
  const sx = mm => mm * pxPerMm; // 寸法（長さ）の px 変換
  const pxWidth  = bounds.width  * pxPerMm + 2 * FIGURE_MARGIN_PX;
  const pxHeight = bounds.height * pxPerMm + 2 * FIGURE_MARGIN_PX;
  return { pxPerMm, scale, tx, ty, sx, pxWidth, pxHeight };
}

// 一般解の注記基準隙間(px)。図描画システムの既定＝「指定がなければこれ」。
// 図と寸法線を十分に離す初期値（構造の GAP_BASE_PX=22 より広め）。
// 構造リストは密集のため独自の GAP_BASE_PX を継続使用する（この既定は階段・今後の新図向け）。
export const DEFAULT_GAP_PX = 30;

// 図中の寸法編集フィールド（EditableDimLabel チップ）の高さ(px)。縦方向の寸法の描画長が
// これを下回ると寸法とフィールドが潰れて編集不能になるため、倍率選定の下限ガードに使う。
const DIM_FIELD_HEIGHT_PX = 16;

// 縦方向(dir='v')の寸法のうち最小の測定長(mm)。無ければ Infinity（ガード無効）。
function minVerticalDimMm(primitives) {
  let min = Infinity;
  for (const p of primitives) {
    if (p.type === 'dim' && p.dir === 'v') {
      const len = Math.abs(p.to - p.from);
      if (len > 0 && len < min) min = len;
    }
  }
  return min;
}

// figure（図＋注記込み）が px 枠に収まるか。makeTransform と同じく各辺 FIGURE_MARGIN_PX を見込む。
function fitsFrame(primitives, scale, frame) {
  const fb = figureBounds(primitives);
  return fb.width  * scale + 2 * FIGURE_MARGIN_PX <= frame.maxWidth
      && fb.height * scale + 2 * FIGURE_MARGIN_PX <= frame.maxHeight;
}

// 寸法線配置の一般解：より長い寸法線ほど図の外側へ。
// 同一 (dir, 図心に対する側) の寸法を、現在のオフセット段(tier=|at-図心|)ごとにまとめ、
// tier の代表長さ（その段の最大測定長）で「短い段ほど内側／長い段ほど外側」に並べ替える。
// チェーン（同一 at に連なる寸法群）は tier ごと保持され崩れない。dim.at を書き換えて返す。
export function orderDimsByLength(primitives, cx, cy) {
  const groups = new Map(); // "dir:sign" -> dim[]
  for (const p of primitives) {
    if (p.type !== 'dim') continue;
    const center = p.dir === 'h' ? cy : cx;
    const sign = Math.sign(p.at - center) || 1;
    const key = `${p.dir}:${sign}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [key, dims] of groups) {
    const sign = Number(key.split(':')[1]);
    const center = key.startsWith('h') ? cy : cx;
    // tier（オフセット距離）ごとに dim をまとめ、代表長さ＝その段の最大測定長を記録。
    const tiers = new Map(); // dist -> { dims, maxLen }
    for (const d of dims) {
      const dist = Math.abs(d.at - center);
      const len = Math.abs(d.to - d.from);
      if (!tiers.has(dist)) tiers.set(dist, { dims: [], maxLen: 0 });
      const t = tiers.get(dist);
      t.dims.push(d);
      if (len > t.maxLen) t.maxLen = len;
    }
    const dists = [...tiers.keys()].sort((a, b) => a - b);            // 近い順
    const byLen = [...tiers.values()].sort((a, b) => a.maxLen - b.maxLen); // 短い順
    byLen.forEach((t, i) => { for (const d of t.dims) d.at = center + sign * dists[i]; });
  }
  return primitives;
}

// 寸法の値ラベル/線の「積み重ね方向(perp)」の半幅(px)の概算。
// dir='h' は縦積み＝ラベル高さ相当、dir='v' は横積み＝ラベル幅相当（文字数で概算）。
function dimPerpHalfPx(d, isH) {
  const FONT = 11;
  if (isH) return FONT;
  const len = String(d.label ?? '').length;
  return Math.max(FONT, len * FONT * 0.35);
}

// 寸法線配置の一般解：寸法線（＋附帯する寸法値）が他の描画物と重なったら外側へ退避する。
// 同一 (dir, 図心に対する側) の寸法を内側→外側に走査し、各段(tier)の perp フットプリントが
// 内側の境界と重なるなら「重ならない距離(=境界)＋10px」まで外側へ移動する（段内チェーンは一括移動）。
// px 判定のため scale（px/mm）が必要。scale 未指定時は何もしない。
const DIM_CLEAR_PX = 10;
export function resolveDimOverlaps(primitives, cx, cy, scale) {
  if (!scale) return primitives;
  const groups = new Map(); // "dir:sign" -> dim[]
  for (const p of primitives) {
    if (p.type !== 'dim') continue;
    const center = p.dir === 'h' ? cy : cx;
    const sign = Math.sign(p.at - center) || 1;
    const key = `${p.dir}:${sign}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [key, dims] of groups) {
    const isH = key.startsWith('h');
    const sign = Number(key.split(':')[1]);
    const center = isH ? cy : cx;
    // tier（オフセット距離）ごとにまとめ、perp 半幅は段内の最大を代表とする。
    const tierMap = new Map(); // dist -> { dims, half }
    for (const d of dims) {
      const dist = Math.abs(d.at - center);
      const half = dimPerpHalfPx(d, isH);
      if (!tierMap.has(dist)) tierMap.set(dist, { dims: [], half: 0 });
      const t = tierMap.get(dist);
      t.dims.push(d);
      if (half > t.half) t.half = half;
    }
    const tiers = [...tierMap.entries()].map(([dist, t]) => ({ dist, ...t })).sort((a, b) => a.dist - b.dist);
    let boundaryPx = 0; // 図形エッジ（外向き距離 0）から始める
    for (const t of tiers) {
      let distPx = t.dist * scale;          // 寸法線の外向き px
      if (distPx - t.half < boundaryPx) {    // 内側の描画物と重なる
        distPx = boundaryPx + DIM_CLEAR_PX + t.half; // 重ならない距離＋10px
        const distMm = distPx / scale;
        for (const d of t.dims) d.at = center + sign * distMm;
      }
      boundaryPx = distPx + t.half;
    }
  }
  return primitives;
}

// スクリーン空間注記の共有縮尺決定（一般解）。タブ内図描画システム（構造リスト・階段）の全図で使う。
// generate(scale) は「その scale で注記の隙間を px 一定にした」プリミティブ列（配列）を返す純関数。
//
// 倍率選定：NICE_SCALES を大きい方から辿り、「図＋他の描画物を込みで」枠に収まる最大スケールを選ぶ
// （収まらなければスケールダウン）。ただし縦方向の最小寸法の描画長が寸法編集フィールド高(px)を割る
// スケールは採らず、1つ前（大きい方）を選ぶ＝はみ出してもスクロールで見せ、寸法フィールドを潰さない。
// frame 未指定時は従来どおり（scale=null で1回生成し、縮尺は描画側 figureBounds に委ねる）。
export function annotatedFigure(generate, frame) {
  if (!frame) return { primitives: generate(null), scale: null };
  for (let i = 0; i < NICE_SCALES.length; i++) {
    const s = NICE_SCALES[i];
    const prims = generate(s);
    if (!fitsFrame(prims, s, frame)) continue; // 収まらない → スケールダウン
    // 収まる最大スケール。縦方向の最小寸法が編集フィールド高を割るなら1つ前（大きい方）を採る。
    if (minVerticalDimMm(prims) * s < DIM_FIELD_HEIGHT_PX && i > 0) {
      const ps = NICE_SCALES[i - 1];
      return { primitives: generate(ps), scale: ps };
    }
    return { primitives: prims, scale: s };
  }
  // どのスケールでも収まらない → 最小スケール。
  const s = NICE_SCALES[NICE_SCALES.length - 1];
  return { primitives: generate(s), scale: s };
}
