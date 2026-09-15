import { observer } from 'mobx-react-lite';
import { Group, Line, Rect, Circle, Path } from 'react-konva';
import { ShapeType } from '@core';
import { LodLevel, resolveStrokeWidth } from '../viewport.js';
import { buildWallDrawPlan } from './wallDrawPlan.js';
import { graphComputed } from './graphDerived.js';
import { wallFinishLineWeight } from '../finish/wallFinishJoin.js';

const DASH = {
  solid:     undefined,
  dashed:    [8, 4],
  center:    [12, 4, 2, 4],
  dimension: [4, 4],
};


function strokeProps(shape, viewport) {
  const { scaleX, scaleY } = viewport;
  return {
    stroke:      shape.color,
    strokeWidth: resolveStrokeWidth(
      shape.lineWeight, Math.min(scaleX, scaleY), viewport.lineWeightsPx, viewport.pxPerMmX),
    dash:        DASH[shape.lineType],
    listening:   false,
  };
}

// SVG arc パス文字列 (ワールド座標 mm)
export function arcPathD(cx, cy, radius, startAngleDeg, includedAngleDeg) {
  const toRad = (d) => (d * Math.PI) / 180;
  const sa    = toRad(startAngleDeg);
  const ea    = toRad(startAngleDeg + includedAngleDeg);
  const x1    = cx + radius * Math.cos(sa);
  const y1    = cy + radius * Math.sin(sa);
  const x2    = cx + radius * Math.cos(ea);
  const y2    = cy + radius * Math.sin(ea);
  const large = Math.abs(includedAngleDeg) > 180 ? 1 : 0;
  const sweep = includedAngleDeg > 0 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} ${sweep} ${x2} ${y2}`;
}

// 2a壁の描画クリップ（stairUnderClip.js の stairUnderWallClips が返すサブパス配列）を
// Konva の Group clipFunc へ渡す。clipFunc はグループの絶対変換込みで呼ばれるため
// （Konva Container._drawChildren）、座標変換は不要——ワールドmm座標のまま moveTo/lineTo する。
function makeClipFunc(subpaths) {
  return (ctx) => {
    for (const sp of subpaths) {
      if (sp.length === 0) continue;
      ctx.moveTo(sp[0].x, sp[0].y);
      for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y);
      ctx.closePath();
    }
  };
}

// stairUnderClips（壁id → クリップのサブパス配列。同じ2a部屋の壁は同じ配列を共有する）を
// 壁id → クリップ単位（部屋ごとの連番）へ写す。連番は壁idの昇順で振り、Mapの生成順に依存しない
// （graphComputed のキーに使うため、同じ内容なら同じ文字列になる必要がある）。
function stairUnderClipGroups(stairUnderClips) {
  if (!stairUnderClips?.size) return null;
  const groupOf = new Map(); // サブパス配列 → 連番
  const out = new Map();
  for (const id of [...stairUnderClips.keys()].sort()) {
    const sub = stairUnderClips.get(id);
    let g = groupOf.get(sub);
    if (g == null) groupOf.set(sub, g = groupOf.size);
    out.set(id, String(g));
  }
  return out;
}

export const ShapesLayer = observer(({ graph, viewport, stairUnderClips = null }) => {
  if (!graph) return null;
  const { scaleX, scaleY, lodLevel } = viewport;

  // 壁をまたぐ派生値（下地の重複防止・T字取り合い・腰壁垂れ壁・柱の仕上げ包み・壁ごとの開口）は
  // wallDrawPlan.js に集約し、graphComputed で graph 単位にキャッシュする。これらは graph が変わらない
  // 限り同じ結果だが、このレイヤーは observer なのでパン・ズーム・ポインタ移動のたびに再レンダー
  // される——毎回総当たりし直すと実測約30ms/レンダーで、60fps の予算を一回で使い切る
  // （平面モードのカクつきの主因）。
  // LOD ごとに結果が違うため lodLevel をキーに含める（graphDerived.js の約束）。
  // 2a壁（階段下部屋の偏芯壁）の描画クリップは壁id単位で掛かる（下記 makeClipFunc）。領域の境界を
  // 畳む単位をこれに揃えるため、クリップの単位（同じ2a部屋の壁）を壁id→単位 の Map にして計画へ
  // 渡し、キーにも符号化する（キーに現れない引数を閉じ込めるとキャッシュが古い値を返す）。
  // 2a壁かどうかは graph だけでは決まらない（階段モード・上階の見下げ依存）ので、計画側で
  // 識別する代わりにここから渡す。
  const clipGroups = stairUnderClipGroups(stairUnderClips);
  const clipKey = clipGroups ? [...clipGroups].map(([id, g]) => `${id}=${g}`).join(',') : '';
  const { kneeDropOverlays, wallLines, wallStuds } =
    graphComputed(graph, `wallDrawPlan:${lodLevel}:${clipKey}`,
      () => buildWallDrawPlan(graph, lodLevel, { clipGroups }));

  return graph.generalShapes.map((shape) => {
    const sp = strokeProps(shape, viewport);

    switch (shape.type) {

      case ShapeType.VERTICAL:
        return (
          <Line
            key={shape.id}
            points={[shape.x, shape.y1, shape.x, shape.y2]}
            {...sp}
          />
        );

      case ShapeType.HORIZONTAL:
        return (
          <Line
            key={shape.id}
            points={[shape.x1, shape.y, shape.x2, shape.y]}
            {...sp}
          />
        );

      case ShapeType.DIAGONAL:
        return (
          <Line
            key={shape.id}
            points={[shape.nodeA.x, shape.nodeA.y, shape.nodeB.x, shape.nodeB.y]}
            {...sp}
          />
        );

      case ShapeType.WALL: {
        // 3通り（略図の単線／標準の帯／詳細の下地・仕上げ要素）の描画結果を1変数へ集約し、
        // 2a壁（階段下部屋の偏芯壁）は末尾で1回だけ描画クリップ（stairUnderClips）を適用する
        // （破れ線より階段踏面側の部分を描かない。.claude/stair-model.md 参照）。
        const out = (() => {
        // 壁1本分の描画ライン（開口分割・仕上げ材の線・下地の範囲）は wallDrawPlan.js の
        // resolveWallLines に判断を集約済み——ここは写像するだけ（そちらのJSDoc参照。
        // 仕上げ材の線は planWallRegion.js が材の領域の境界として解いた `lines`）。
        const plan = wallLines.get(shape.id);
        const { segments, lines } = plan;

        if (lodLevel === LodLevel.SCHEMATIC) {
          // 略図: 軸オフセット位置の単線（厚み表現なし）
          return segments.map(([a, b], i) => (
            <Line
              key={`${shape.id}:${i}`}
              points={shape.isVertical
                ? [shape.axisValue, a, shape.axisValue, b]
                : [a, shape.axisValue, b, shape.axisValue]
              }
              {...sp}
            />
          ));
        }

        // 腰壁・垂れ壁: 平面切断高さ以下の腰壁／壁本体を貫かない垂れ壁は、通常の壁帯の代わりに
        // 天板の輪郭を実線（腰壁）／破線（垂れ壁）で描く（resolveKneeDropOverlays が優先順位込みで
        // 解決済み）。輪郭も planWallRegion.js が高さクラスごとの領域の境界として解いた `lines`
        // （kind 'kd'|'kdcap'・`style` が線種）に入っているので、ここでは線種の写像だけを持つ。
        // 天板の線は壁の既定の線幅（中線）のまま。
        const kneeDrop = kneeDropOverlays?.get(shape.id) ?? null;
        if (kneeDrop) {
          const capSp = { stroke: sp.stroke, strokeWidth: sp.strokeWidth, listening: false };
          return lines.map((l, i) => (
            <Line
              key={`${shape.id}:${l.kind}:${i}`}
              points={l.vertical ? [l.at, l.lo, l.at, l.hi] : [l.lo, l.at, l.hi, l.at]}
              {...capSp}
              dash={l.style === 'drop' ? DASH.dashed : DASH.solid}
            />
          ));
        }

        // 標準・詳細: 仕上げ材の線（面線・妻線・内側線・木口線）は材の領域の合併境界として
        // planWallRegion.js が解決済み（`lines`。標準LODは面線・妻線だけ）——ここは各線分を
        // <Line> へ写すだけで、取り合いの判断を持たない。中心線は CenterLinesLayer が別途描画する
        // ため、対称壁の軸CL側の辺は領域が持ち出さない。
        // 詳細LODでは太線にする（ユーザー指示2026-09）。太さの判断は finish/wallFinishJoin.js の
        // wallFinishLineWeight が唯一の供給源——柱の仕上げ包み（柱壁）も同じ関数を引く。
        // 下地（間柱）は sp のまま（中線）。
        const finSp = {
          ...sp,
          strokeWidth: resolveStrokeWidth(
            wallFinishLineWeight(lodLevel === LodLevel.DETAIL), Math.min(scaleX, scaleY),
            viewport.lineWeightsPx, viewport.pxPerMmX),
        };
        const finishLines = lines.map((l, i) => (
          <Line
            key={`${shape.id}:${l.kind}:${i}`}
            points={l.vertical ? [l.at, l.lo, l.at, l.hi] : [l.lo, l.at, l.hi, l.at]}
            {...finSp}
          />
        ));

        // 詳細のみ: 下地（間柱断面）。位置と材厚の判断（下地帯の端の正規化・柱壁に取られた区間の除外・
        // 固定ピッチ／在来木造の柱間面割付＋柱面から10mmの端部材）は wallDrawPlan.js → wallStudLayout.js が
        // 主構造ルールの選択子 studLayout で解決済み（`wallStuds`）——ここは矩形へ写すだけ。
        // 厚み方向は通り芯(axisCL)上の実材厚（core.js の Wall.backingRange）。
        const studs = wallStuds.get(shape.id);
        if (!studs) return finishLines;

        const elems = [...finishLines];
        const backingBand = shape.backingRange;
        const backingDepth = backingBand.hi - backingBand.lo;
        const halfDepth = backingDepth / 2, halfWidth = studs.depth / 2;
        const backingCenterV = (backingBand.lo + backingBand.hi) / 2;
        for (const p of studs.centers) {
          elems.push(
            <Rect
              key={`${shape.id}:stud:${p}`}
              x={shape.isVertical ? backingCenterV - halfDepth : p - halfWidth}
              y={shape.isVertical ? p - halfWidth : backingCenterV - halfDepth}
              width={shape.isVertical ? backingDepth : studs.depth}
              height={shape.isVertical ? studs.depth : backingDepth}
              fill="transparent"
              stroke={sp.stroke}
              strokeWidth={sp.strokeWidth}
              listening={false}
            />,
          );
        }

        return elems;
        })();

        const clip = stairUnderClips?.get(shape.id);
        return clip ? <Group key={shape.id} clipFunc={makeClipFunc(clip)}>{out}</Group> : out;
      }

      case ShapeType.ARC:
        return (
          <Path
            key={shape.id}
            data={arcPathD(
              shape.center.x, shape.center.y,
              shape.radius,
              shape.startAngle,
              shape.includedAngle,
            )}
            fill="transparent"
            {...sp}
          />
        );

      case ShapeType.CIRCLE:
        return (
          <Circle
            key={shape.id}
            x={shape.center.x}
            y={shape.center.y}
            radius={shape.radius}
            fill="transparent"
            {...sp}
          />
        );

      default:
        return null;
    }
  });
});
