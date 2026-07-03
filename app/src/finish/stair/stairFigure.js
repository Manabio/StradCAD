import { buildStairGeometry, makeFrame, stairSegmentDims, insetStairBounds } from './stairGeometry.js';
import { DEFAULT_GAP_PX, orderDimsByLength, resolveDimOverlaps } from '../../structural/sectionFigure/sectionGeometry.js';

// ================================================================
// 階段の模式図を「構造タブの図描画（AutoScaledFigure）」が消費する
// プリミティブ配列へ変換するアダプタ。
//
// buildStairGeometry の出力（treads/outline/arrows/breakLine/stepNumbers、
// いずれもワールドmm座標）を sectionGeometry.js のプリミティブ形式へ写像する。
// 縮尺・配置は AutoScaledFigure が bounds から自動決定する。
// ================================================================

const STROKE = '#1e293b';

// 縮尺 scale から注記の隙間(mm)を求める。scale 指定時は DEFAULT_GAP_PX/scale＝描画px一定（スクリーン空間注記）。
// scale 未指定（縮尺未確定の1パス目など）は図サイズ比例のフォールバック。
function gapMm(scale, b) {
  if (scale) return DEFAULT_GAP_PX / scale;
  return (Math.max(b.x2 - b.x1, b.y2 - b.y1) || 1000) * 0.1;
}

// 階段の模式図プリミティブ（mm座標）を返す。b は設置エリアの包絡矩形（roomBounds）。
// view:'upper'（破断なし・全段）＋ detail:true（段番号）で全体像を描く。
// scale は annotatedFigure が決めた縮尺（注記の隙間を px 一定にするため）。
// spans はセル実測の区間長（measureStairSpans。区間長指定の反映用。null なら合成）。
export function stairFigurePrimitives(stair, b, { riser = null, scale = null, spans = null } = {}) {
  const geom = buildStairGeometry(stair, b, { view: 'upper', detail: true, riser, spans });
  const prims = [];

  // 外周（実線／dashed は破線）
  for (const s of geom.outline) {
    prims.push({ type: 'line', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, stroke: STROKE, width: 1.5, dash: s.dashed ? 'dashed' : undefined });
  }
  // 踏み面
  for (const s of geom.treads) {
    prims.push({ type: 'line', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, stroke: '#000000', width: 1 });
  }
  // 破断線（upper では通常出ないが念のため写像）
  for (const s of geom.breakLine ?? []) {
    prims.push({ type: 'line', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, stroke: STROKE, width: 1 });
  }
  // 走行矢印（始点丸＋矢じり＋U/Dラベル）
  for (const a of geom.arrows ?? []) {
    prims.push({ type: 'arrow', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, points: a.points, labelX: a.labelX, labelY: a.labelY, label: a.label, stroke: STROKE });
  }
  // 段番号
  for (const n of geom.stepNumbers) {
    prims.push({ type: 'text', x: n.x, y: n.y, text: n.text, anchor: 'middle', baseline: 'middle', size: 10, fill: STROKE });
  }

  // 所定寸法の注記
  prims.push(...stairDimPrimitives(stair, b, riser, gapMm(scale, b), spans));
  // より長い寸法線ほど図の外側へ（同一方向・同一側の tier を長さで並べ替え。チェーンは保持）。
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
  orderDimsByLength(prims, cx, cy);
  // 寸法線（＋寸法値）が他の描画物と重なったら外側へ退避（重ならない距離＋10px）。
  resolveDimOverlaps(prims, cx, cy, scale);
  return prims;
}

// 所定寸法のプリミティブ。g は注記の張り出し量(mm)＝スクリーン空間で px 一定。
// 全長・幅は「描かれた図（設置セル包絡矩形 b）」の x/y スパンを寸法線で注記（昇り方向に応じ見出し付与）。
// 踏面は走行始端に1マス分の寸法線（設計値ラベル）。蹴上・段数は設計値をテキストで併記する。
function stairDimPrimitives(stair, b, riser, g, spans) {
  const w = b.x2 - b.x1, h = b.y2 - b.y1;
  const vertical = stair.upDirection === 'up' || stair.upDirection === 'down';
  const hHeader = vertical ? '幅' : '全長'; // 横スパン(h)の見出し
  const vHeader = vertical ? '全長' : '幅'; // 縦スパン(v)の見出し
  const prims = [
    { type: 'dim', dir: 'h', from: b.x1, to: b.x2, at: b.y2 + g, label: `${hHeader} ${Math.round(w)}` }, // 横スパン（下）
    { type: 'dim', dir: 'v', from: b.y1, to: b.y2, at: b.x2 + g, label: `${vHeader} ${Math.round(h)}` }, // 縦スパン（右）
  ];

  // 踏面: 走行始端の1マス分（t:0→1/総マス数）を、全長寸法と反対側の外へ寸法線で示す（設計値ラベル・図中編集可）。
  // 実際に描かれる図形（bi＝中心線から壁厚/2逃げた矩形）に合わせる。
  const bi = insetStairBounds(stair, b, 'upper');
  const cells = Math.max(1, stair.totalSteps - 1); // 総マス数（totalSteps - 1。+1は上階到達分）
  const f = makeFrame(stair, bi);
  const p0 = f.pt(0, 0), p1 = f.pt(1 / cells, 0);
  const tread = { editable: true, target: 'tread', label: Math.round(stair.tread) };
  if (vertical) {
    prims.push({ type: 'dim', dir: 'v', from: p0.y, to: p1.y, at: b.x1 - g, labelSide: 'left', ...tread });
  } else {
    prims.push({ type: 'dim', dir: 'h', from: p0.x, to: p1.x, at: b.y1 - g, ...tread });
  }

  // 設計値（蹴上・段数）を図の下にテキスト併記
  const notes = [];
  if (riser != null) notes.push(`蹴上 ${Math.round(riser)}`);
  notes.push(`${stair.totalSteps}段`);
  prims.push({ type: 'text', x: (b.x1 + b.x2) / 2, y: b.y2 + g * 2, text: notes.join('  '), anchor: 'middle', baseline: 'hanging', size: 11, fill: '#334155' });

  // タイプ別セグメント（踊り場・回り部・各アーム・各直進部）を、その場に踏面数／長さの寸法線で注記
  prims.push(...stairSegmentDims(stair, bi, g, spans));
  return prims;
}
