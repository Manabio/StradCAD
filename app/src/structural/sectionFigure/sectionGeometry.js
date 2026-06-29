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
