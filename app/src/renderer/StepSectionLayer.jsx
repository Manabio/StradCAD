import { observer } from 'mobx-react-lite';
import { Group, Line, Text, Circle } from 'react-konva';
import { LodLevel } from '../viewport.js';
import { computeStepSections } from '../finish/stepSection.js';

const STEP_SECTION_STROKE = '#1e293b'; // 断面線の色（StairLayerの階段断面と同系）
const HATCH_COLOR         = '#94a3b8'; // ハッチ線色
const DIM_COLOR           = '#475569'; // 寸法線・寸法値色（GutterLayer の GRID_LINE_COLOR と同系）
const DIM_FONT_SIZE_PX    = 11;        // 寸法値のスクリーン基準フォントサイズ(px)
// 寸法線を寸法値の中心から「文字の下」へずらす量(px)。文字高の半分＋わずかな余白。
// 断面の向き（高低差が左右/上下どちらでも）に依らず、常に寸法値の直下に寸法線が来る。
const DIM_LINE_OFFSET_PX  = DIM_FONT_SIZE_PX / 2 + 2;
const CHAR_WIDTH_RATIO    = 0.62;      // gutterPrimitives.jsx と同じ概算比率

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * CHAR_WIDTH_RATIO;
}

/**
 * 段差断面（隣接する2部屋にFL差があり、境界が壁・扉で塞がれていない間口に描く簡易断面図）を
 * 平面図モードで描画する。幾何計算は finish/stepSection.js に集約し、ここでは
 * その結果を Konva 要素へ写像するだけにする。
 *
 * LOD: 段差線（間口を横切る線分）は全LODで描く（略図＝細線、標準・詳細＝中線）。
 * 間口中央の断面図（断面線＝太線・ハッチ・寸法）は詳細LODのみ。
 *
 * 線幅: viewport.lineWeightsPx はスクリーンpx値のため、ワールド座標 Group 内では
 * スケールで割ってから渡す（SiteLinesLayer と同じ方式）。px値のまま strokeWidth に渡すと
 * 縮尺倍されて 0.1px 未満になり事実上不可視になる（段差線が描画されない不具合の原因）。
 */
export const StepSectionLayer = observer(({ graph, viewport }) => {
  if (!graph) return null;
  const px       = (w) => w / viewport.scaleX; // スクリーンpx → ワールド単位（ズーム非依存）
  const dotR     = px(2);
  const fontSize = DIM_FONT_SIZE_PX / viewport.scaleX;

  const weights     = viewport.lineWeightsPx;
  const isSchematic = viewport.lodLevel === LodLevel.SCHEMATIC;
  const showDetail  = viewport.lodLevel === LodLevel.DETAIL;
  // 段差線: 略図＝細線 / 標準・詳細＝中線。断面線は太線、ハッチ・寸法は細線。
  const stepStroke    = px(isSchematic ? weights.thin : weights.medium);
  const profileStroke = px(weights.thick);
  const thinStroke    = px(weights.thin);

  const sections = computeStepSections(graph);

  return sections.map(s => {
    const text = String(s.heightDiffMm);
    const textW = estimateTextWidth(text, fontSize);
    // 「寸法値の下」＝断面が横向き（軸CLが垂直）なら文字天が左向きなので +X、
    // 縦向きなら文字天が上向きなので +Y。どちらも across の正方向に一致する。
    const dimShift = px(DIM_LINE_OFFSET_PX);
    const sx = s.isVertical ? dimShift : 0;
    const sy = s.isVertical ? 0 : dimShift;
    return (
      <Group key={s.id}>
        <Line
          points={[s.stepLine.x1, s.stepLine.y1, s.stepLine.x2, s.stepLine.y2]}
          stroke={STEP_SECTION_STROKE}
          strokeWidth={stepStroke}
          listening={false}
        />
        {showDetail && s.profileSegs.map((seg, i) => (
          <Line
            key={`p${i}`}
            points={[seg.x1, seg.y1, seg.x2, seg.y2]}
            stroke={STEP_SECTION_STROKE}
            strokeWidth={profileStroke}
            listening={false}
          />
        ))}
        {showDetail && s.hatch.map((h, hi) => (
          <Group
            key={`h${hi}`}
            clipFunc={(ctx) => { ctx.rect(h.rect.x1, h.rect.y1, h.rect.x2 - h.rect.x1, h.rect.y2 - h.rect.y1); }}
          >
            {h.lines.map((l, li) => (
              <Line
                key={`hl${li}`}
                points={[l.x1, l.y1, l.x2, l.y2]}
                stroke={HATCH_COLOR}
                strokeWidth={thinStroke}
                listening={false}
              />
            ))}
          </Group>
        ))}
        {showDetail && (
          <>
            <Line
              points={[s.dim.line.x1 + sx, s.dim.line.y1 + sy, s.dim.line.x2 + sx, s.dim.line.y2 + sy]}
              stroke={DIM_COLOR}
              strokeWidth={thinStroke}
              listening={false}
            />
            {s.dim.witnesses.map((w, wi) => (
              <Line
                key={`w${wi}`}
                points={[w.x1, w.y1, w.x2 + sx, w.y2 + sy]}
                stroke={DIM_COLOR}
                strokeWidth={thinStroke}
                listening={false}
              />
            ))}
            <Circle x={s.dim.line.x1 + sx} y={s.dim.line.y1 + sy} radius={dotR} fill={DIM_COLOR} listening={false} />
            <Circle x={s.dim.line.x2 + sx} y={s.dim.line.y2 + sy} radius={dotR} fill={DIM_COLOR} listening={false} />
            <Text
              x={s.dim.textX}
              y={s.dim.textY}
              text={text}
              fontSize={fontSize}
              fill={DIM_COLOR}
              rotation={s.isVertical ? -90 : 0}
              offsetX={textW / 2}
              offsetY={fontSize / 2}
              listening={false}
            />
          </>
        )}
      </Group>
    );
  });
});
