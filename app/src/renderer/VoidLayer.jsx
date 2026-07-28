import { observer } from 'mobx-react-lite';
import { Group, Line, Text } from 'react-konva';
import { LodLevel } from '../viewport.js';
import { computeVoidCrosses } from '../finish/voidGeometry.js';

const VOID_CROSS_COLOR  = '#1e293b'; // ×の色（StepSectionLayer の断面線と同系）
const LABEL_FONT_SIZE_PX = 12;       // 「上部吹抜け」のスクリーン上表示サイズ(px)
const LABEL_MARGIN_PX    = 2;        // ×の斜線・矩形端からの余白(px)
const LABEL_GAP_PX       = 2;        // 2行表示時の行間(px)
// 「上部吹抜け」は全角のみのラベルのため、半角英数用の比率（StepSectionLayer.jsx の 0.62）ではなく
// RoomLabelsLayer.jsx の部屋名（全角想定）と同じ「1文字=fontSize幅」を使う。
const CHAR_WIDTH_RATIO   = 1.0;
const LABEL_FULL  = '上部吹抜け';
const LABEL_LINE1 = '上部';
const LABEL_LINE2 = '吹抜け';

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * CHAR_WIDTH_RATIO;
}

// 矩形の各辺を inset だけ内側へ縮める（「太線1本分内側」に対角線を描くため）。
// inset が矩形の半分を超える等で退化する（幅・高さが0以下になる）場合は null を返し、
// 呼び出し側で描画をスキップする（安全側。座標が交差した×を描かない）。
function insetRect(r, inset) {
  const x1 = r.x1 + inset, y1 = r.y1 + inset, x2 = r.x2 - inset, y2 = r.y2 - inset;
  if (!(x2 - x1 > 0 && y2 - y1 > 0)) return null;
  return { x1, y1, x2, y2 };
}

/**
 * 「上部吹抜け」ラベルの配置を決める（×の上側三角領域。自身の対角線と重ならない位置）。
 * 対角線は中心(cx,cy)から傾き±H/Wで伸びるため、中心から水平半幅 halfW の位置にテキストを
 * 置くには、対角線から離れるぶん halfW*(H/W) の垂直クリアランスが要る。
 * 1行「上部吹抜け」→ 入らなければ2行「上部」「吹抜け」→ それでも入らなければ
 * 1行を中心から H/4 上へクランプする（重なりは許容し、視認性を優先）。
 * 退化矩形（W<=0 または H<=0。呼び出し側は通常 insetRect が null を返した時点で除外するが、
 * 念のためここでも安全側に倒す）は null を返し、呼び出し側はラベルを描かない。
 * @returns {{lines:string[], cx:number, y:number, widths:number[], lineHeight:number}|null}
 */
function labelPlacement(r, fontSize, gap, margin) {
  const W = r.x2 - r.x1, H = r.y2 - r.y1;
  if (!(W > 0 && H > 0)) return null;
  const cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
  const slope = H / W;

  const fits = (halfW, height) => {
    const dy = (halfW + margin) * slope + margin;
    return dy + height <= H / 2 - margin ? dy : null;
  };

  const w1 = estimateTextWidth(LABEL_FULL, fontSize);
  const dy1 = fits(w1 / 2, fontSize);
  if (dy1 != null) {
    return { lines: [LABEL_FULL], cx, y: cy - dy1 - fontSize, widths: [w1], lineHeight: fontSize };
  }

  const w2a = estimateTextWidth(LABEL_LINE1, fontSize);
  const w2b = estimateTextWidth(LABEL_LINE2, fontSize);
  const w2  = Math.max(w2a, w2b);
  const h2  = fontSize * 2 + gap;
  const dy2 = fits(w2 / 2, h2);
  if (dy2 != null) {
    return { lines: [LABEL_LINE1, LABEL_LINE2], cx, y: cy - dy2 - h2, widths: [w2a, w2b], lineHeight: fontSize };
  }

  // クランプ: 重なりは許容し、×の上側 H/4 の高さへ1行を強制配置する
  return { lines: [LABEL_FULL], cx, y: cy - H / 4 - fontSize / 2, widths: [w1], lineHeight: fontSize };
}

/**
 * 吹抜け（feature=VOID）の×を平面図モードで描画する。
 *   自階（graph）: 壁内4頂点を対角に結ぶ一点鎖線・細線。
 *   直下階（upperCrosses。App.jsx が上階を peek して computeVoidCrosses した結果）:
 *     同じ対角線を破線・細線で描き、交点付近に「上部吹抜け」を添える。あわせて対角線と同じ
 *     オフセット（insetRect）の外形（矩形。壁内の外形頂点を結ぶ多角形）を同じ破線・細線で描く
 *     ——設置階側は実壁が既に描かれているため外形は追加しない（直下階側のみ）。
 *     （LOD SCHEMATIC では非表示。STAIR_VOID は computeVoidCrosses 側で除外済み）。
 * 世界座標は全階共通のため、upperCrosses（上階グラフで計算した座標）もそのまま自階へ描ける
 * （stairFloorSync.js の stairPortEdges と同じ前提）。
 * 線幅は CenterLinesLayer.jsx と同方式（strokeScaleEnabled=false・px値をそのまま渡す）。
 */
export const VoidLayer = observer(({ graph, viewport, upperCrosses = [] }) => {
  if (!graph) return null;

  const ownCrosses = computeVoidCrosses(graph);
  const thin = viewport.lineWeightsPx.thin;
  // ×自体は全LODで描画する。LOD SCHEMATIC で非表示にするのは「上部吹抜け」の文字のみ
  // （要件のLOD指定はラベル文字にのみ掛かる。F10）。
  const showLabel = viewport.lodLevel !== LodLevel.SCHEMATIC;

  // 「太線1本分内側」（ワールド単位。ズームで太さが変わらない px 系のため scaleX で換算する）
  const inset = viewport.lineWeightsPx.thick / viewport.scaleX;
  const fontSize = LABEL_FONT_SIZE_PX / viewport.scaleX;
  const gap = LABEL_GAP_PX / viewport.scaleX;
  const margin = LABEL_MARGIN_PX / viewport.scaleX;

  return (
    <>
      {ownCrosses.map(c => {
        const r = insetRect(c, inset);
        if (!r) return null; // 退化矩形（F8）→ 描画スキップ
        const lineProps = {
          stroke: VOID_CROSS_COLOR, strokeWidth: thin, dash: [12, 4, 2, 4],
          strokeScaleEnabled: false, listening: false,
        };
        return (
          <Group key={`own-${c.id}`}>
            <Line points={[r.x1, r.y1, r.x2, r.y2]} {...lineProps} />
            <Line points={[r.x2, r.y1, r.x1, r.y2]} {...lineProps} />
          </Group>
        );
      })}
      {upperCrosses.map(c => {
        const r = insetRect(c, inset);
        if (!r) return null; // 退化矩形（F8）→ 描画スキップ
        const label = showLabel ? labelPlacement(r, fontSize, gap, margin) : null;
        return (
          <Group key={`upper-${c.id}`}>
            <Line
              points={[r.x1, r.y1, r.x2, r.y2]}
              stroke={VOID_CROSS_COLOR}
              strokeWidth={thin}
              dash={[8, 4]}
              strokeScaleEnabled={false}
              listening={false}
            />
            <Line
              points={[r.x2, r.y1, r.x1, r.y2]}
              stroke={VOID_CROSS_COLOR}
              strokeWidth={thin}
              dash={[8, 4]}
              strokeScaleEnabled={false}
              listening={false}
            />
            <Line
              points={[r.x1, r.y1, r.x2, r.y1, r.x2, r.y2, r.x1, r.y2]}
              closed
              stroke={VOID_CROSS_COLOR}
              strokeWidth={thin}
              dash={[8, 4]}
              strokeScaleEnabled={false}
              listening={false}
            />
            {label && label.lines.map((text, i) => (
              <Text
                key={i}
                x={label.cx}
                y={label.y + i * (label.lineHeight + gap)}
                text={text}
                fontSize={fontSize}
                fill={VOID_CROSS_COLOR}
                offsetX={label.widths[i] / 2}
                listening={false}
              />
            ))}
          </Group>
        );
      })}
    </>
  );
});
