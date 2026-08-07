import { Fragment } from 'react';
import { observer } from 'mobx-react-lite';
import { Line, Rect, Path } from 'react-konva';
import { OpeningCategory } from '../core.js';
import { findHostWall } from '../openings/openingGeometry.js';
import { findCatalogEntry, IMPLEMENTED_MECHANISMS, OpeningMechanism } from '../openings/openingCatalog.js';
import { arcPathD } from './ShapesLayer.jsx';
import { LodLevel, resolveStrokeWidth } from '../viewport.js';

const DOOR_OPEN_ANGLE_DEG = 90;
const SASH_DEPTH_MM = 40;
const TICK_HALF_MM  = 30;

// 引き違い 詳細LOD用（すべて mm）
const SLIDE_TRACK_INSET_MM = 4;       // 枠から戸先・召し合わせレールまでの隙間
const WEATHERSTRIP_DASH    = [6, 4];  // 召し合わせ部・気密材(モヘア)の破線パターン

// 開き戸 詳細LOD用 枠寸法（すべて mm）
const FRAME_JAMB_WIDTH_MM     = 30; // 方立（縦枠）の全体幅（20=本体 + 10=かかり代）
const FRAME_KAKARI_WIDTH_MM   = 10; // 方立のうち開口側「かかり代」の幅
const FRAME_OVERHANG_MM       = 10; // 壁の両面から枠が室内側に出る量
const DOOR_LEAF_THICKNESS_MM  = 30; // 扉厚（かかり代を欠き込む深さ）
const DOOR_HINGE_GAP_MM       = 5;  // 開いた扉と吊元側の方立との隙間
// 吊元側後退量: 方立の全幅(30) - 吊元と方立の隙間(5)
const FRAME_HINGE_INSET_MM = FRAME_JAMB_WIDTH_MM - DOOR_HINGE_GAP_MM;
// 戸先側後退量: 反対側の方立の「本体20mm」境界にぴったり納まる位置
const FRAME_LATCH_INSET_MM = FRAME_JAMB_WIDTH_MM - FRAME_KAKARI_WIDTH_MM;

// 長さ方向(along)・直交方向(perp)のワールド座標 → {x, y}
function toWorld(isVertical, along, perp) {
  return isVertical ? { x: perp, y: along } : { x: along, y: perp };
}

// 長さ方向[alongLo,alongHi]・直交方向[perpLo,perpHi]のワールド矩形 → Rect用 {x, y, width, height}
function rectSpec(isVertical, alongLo, alongHi, perpLo, perpHi) {
  return isVertical
    ? { x: perpLo, y: alongLo, width: perpHi - perpLo, height: alongHi - alongLo }
    : { x: alongLo, y: perpLo, width: alongHi - alongLo, height: perpHi - perpLo };
}

function swingSymbol(opening, host, sp, hingeInset = 0, latchInset = 0, leafThickness = 0) {
  const { width, hingeSide, swingSide, isVertical } = opening;
  const effHingeInset = Math.min(hingeInset, width);
  const effLatchInset = Math.min(latchInset, width);
  const leafLength = Math.max(0, width - effHingeInset - effLatchInset);
  const hingeAlong = hingeSide < 0 ? opening.coord1 + effHingeInset : opening.coord2 - effHingeInset;
  const hinge = toWorld(isVertical, hingeAlong, host.axisValue);

  // 蝶番から見て開口のもう一端へ向かう方向角（closed 位置）
  const towardFar = hingeSide < 0 ? 1 : -1; // +1: 長さ座標が増える方向
  const closedAngle = isVertical
    ? (towardFar > 0 ? 90 : -90)
    : (towardFar > 0 ? 0  : 180);
  const openAngle = closedAngle + swingSide * DOOR_OPEN_ANGLE_DEG;

  const rad  = (openAngle * Math.PI) / 180;
  const dir  = { x: Math.cos(rad), y: Math.sin(rad) };
  const perp = { x: -Math.sin(rad), y: Math.cos(rad) };

  // 扉の厚みは吊元（蝶番位置=枠から隙間ぶん離れた位置）から開く側へ向けて全幅とる
  // （蝶番を中心に両側へ振ると、吊元側の縁が枠に潜り込んでしまうため）
  const away  = { x: -swingSide * perp.x, y: -swingSide * perp.y };
  const near1 = hinge;
  const near2 = { x: hinge.x + away.x * leafThickness, y: hinge.y + away.y * leafThickness };
  const far1  = { x: near1.x + dir.x * leafLength, y: near1.y + dir.y * leafLength };
  const far2  = { x: near2.x + dir.x * leafLength, y: near2.y + dir.y * leafLength };

  return (
    <>
      <Line
        points={[near1.x, near1.y, far1.x, far1.y, far2.x, far2.y, near2.x, near2.y]}
        closed
        fill="transparent"
        {...sp}
      />
      <Path
        data={arcPathD(hinge.x, hinge.y, leafLength, closedAngle, swingSide * DOOR_OPEN_ANGLE_DEG)}
        fill="transparent"
        {...sp}
      />
    </>
  );
}

// 開口と同じ axisCL 上にある反対側（符号違い）の壁を探し、壁の両面位置 [faceLo, faceHi] を返す。
// 反対側が見つからない場合（外壁・手動壁）は軸CLを中心に対称とみなす。
function wallFaceRange(host, graph) {
  const lo = Math.min(host.coord1, host.coord2), hi = Math.max(host.coord1, host.coord2);
  const counterpart = graph.walls.find((w) =>
    w !== host && w.axisCL === host.axisCL && w.isVertical === host.isVertical &&
    Math.sign(w.axisOffset) === -Math.sign(host.axisOffset) &&
    Math.min(w.coord1, w.coord2) < hi && Math.max(w.coord1, w.coord2) > lo,
  );
  const otherFace = counterpart ? counterpart.axisValue : 2 * host.axisCL.effectiveValue - host.axisValue;
  return [Math.min(host.axisValue, otherFace), Math.max(host.axisValue, otherFace)];
}

// 1つの方立の外形を単一の輪郭（六角形）として返す（内部に分割線を作らない）。
// outward>0: かかり代は totalPerpLo 側に残り、totalPerpHi 側（室内・欠き込み側）が窄まる。
// outward<0: その逆。
function jambOutlinePoints(isVertical, outerAlong, dir, jambW, kakariW, totalPerpLo, totalPerpHi, kakariPerpLo, kakariPerpHi, outward) {
  const A = outerAlong;
  const B = outerAlong + dir * (jambW - kakariW);
  const C = outerAlong + dir * jambW;
  const seq = outward > 0
    ? [[A, totalPerpLo], [C, totalPerpLo], [C, kakariPerpHi], [B, kakariPerpHi], [B, totalPerpHi], [A, totalPerpHi]]
    : [[A, totalPerpHi], [C, totalPerpHi], [C, kakariPerpLo], [B, kakariPerpLo], [B, totalPerpLo], [A, totalPerpLo]];
  return seq.flatMap(([along, perp]) => {
    const p = toWorld(isVertical, along, perp);
    return [p.x, p.y];
  });
}

// 開き戸 詳細LOD専用: 両端の方立（縦枠）を描く（リーフ・円弧は swingSymbol が別途描画）
//
// 方立は全幅30mm（本体20mm＋かかり代10mm）だが、扉が通過する位置（扉が閉じた面=
// host.axisValue から室内側へ10mm＋壁中心側へ扉厚30mm＝計40mmの範囲）だけかかり代
// 10mmが欠き込まれた段付き断面になる。四角２つの組合せではなく単一の輪郭で描く。
function swingFrameSymbol(opening, host, graph, sp) {
  const { coord1, coord2, width, isVertical } = opening;
  const jambW = Math.min(FRAME_JAMB_WIDTH_MM, width / 2);
  const kakariW = Math.min(FRAME_KAKARI_WIDTH_MM, jambW);
  const [faceLo, faceHi] = wallFaceRange(host, graph);
  const totalPerpLo = faceLo - FRAME_OVERHANG_MM;
  const totalPerpHi = faceHi + FRAME_OVERHANG_MM;

  // 欠き込み範囲: host.axisValue から室内側10mm 〜 壁中心側30mm。室内側の境界は
  // 方立全体の外縁（totalPerpLo/Hi）と一致するため、残るかかり代は反対側の一区間のみ。
  const outward   = Math.sign(host.axisOffset) || 1;
  const notchFar  = host.axisValue - outward * DOOR_LEAF_THICKNESS_MM;
  const kakariPerpLo = outward > 0 ? totalPerpLo : notchFar;
  const kakariPerpHi = outward > 0 ? notchFar    : totalPerpHi;

  return (
    <>
      <Line points={jambOutlinePoints(isVertical, coord1, 1, jambW, kakariW, totalPerpLo, totalPerpHi, kakariPerpLo, kakariPerpHi, outward)} closed fill="transparent" {...sp} />
      <Line points={jambOutlinePoints(isVertical, coord2, -1, jambW, kakariW, totalPerpLo, totalPerpHi, kakariPerpLo, kakariPerpHi, outward)} closed fill="transparent" {...sp} />
    </>
  );
}

function slideDoubleSymbol(opening, host, sp) {
  const { coord1, coord2, centerCoord, isVertical } = opening;
  const overlap = Math.max(opening.width * 0.12, 60);
  const axisValue = host.axisValue;

  const frameRect = isVertical
    ? { x: axisValue - SASH_DEPTH_MM / 2, y: coord1, width: SASH_DEPTH_MM, height: coord2 - coord1 }
    : { x: coord1, y: axisValue - SASH_DEPTH_MM / 2, width: coord2 - coord1, height: SASH_DEPTH_MM };

  const leaf1Perp = axisValue - SASH_DEPTH_MM / 4;
  const leaf2Perp = axisValue + SASH_DEPTH_MM / 4;
  const leaf1 = [toWorld(isVertical, coord1, leaf1Perp), toWorld(isVertical, centerCoord + overlap / 2, leaf1Perp)];
  const leaf2 = [toWorld(isVertical, centerCoord - overlap / 2, leaf2Perp), toWorld(isVertical, coord2, leaf2Perp)];

  return (
    <>
      <Rect {...frameRect} fill="transparent" {...sp} />
      <Line points={[leaf1[0].x, leaf1[0].y, leaf1[1].x, leaf1[1].y]} {...sp} />
      <Line points={[leaf2[0].x, leaf2[0].y, leaf2[1].x, leaf2[1].y]} {...sp} />
    </>
  );
}

// 引き違い 詳細LOD専用: 壁厚から枠位置を導出し、枠＋2枚のサッシ＋召し合わせ部の気密材（破線）を描く。
// 窓（OpeningCategory.WINDOW）のみ各サッシ中央にガラス線を追加し、戸は無地のパネルとして描く。
function slideDoubleDetailSymbol(opening, host, graph, sp) {
  const { coord1, coord2, centerCoord, isVertical, category } = opening;
  const overlap = Math.max(opening.width * 0.12, 60);

  const [faceLo, faceHi] = wallFaceRange(host, graph);
  const outerLo = faceLo - FRAME_OVERHANG_MM;
  const outerHi = faceHi + FRAME_OVERHANG_MM;
  const sashDepth = Math.max(0, (outerHi - outerLo - SLIDE_TRACK_INSET_MM * 3) / 2);
  const track1 = [outerLo + SLIDE_TRACK_INSET_MM, outerLo + SLIDE_TRACK_INSET_MM + sashDepth];
  const track2 = [outerHi - SLIDE_TRACK_INSET_MM - sashDepth, outerHi - SLIDE_TRACK_INSET_MM];
  const leaves = [
    { span: [coord1, centerCoord + overlap / 2], track: track1 },
    { span: [centerCoord - overlap / 2, coord2], track: track2 },
  ];

  const ws1 = toWorld(isVertical, centerCoord, track1[0]);
  const ws2 = toWorld(isVertical, centerCoord, track2[1]);

  return (
    <>
      <Rect {...rectSpec(isVertical, coord1, coord2, outerLo, outerHi)} fill="transparent" {...sp} />
      {leaves.map(({ span, track }, i) => {
        const glassPerp = (track[0] + track[1]) / 2;
        const g1 = toWorld(isVertical, span[0], glassPerp);
        const g2 = toWorld(isVertical, span[1], glassPerp);
        return (
          <Fragment key={i}>
            <Rect {...rectSpec(isVertical, span[0], span[1], track[0], track[1])} fill="transparent" {...sp} />
            {category === OpeningCategory.WINDOW && <Line points={[g1.x, g1.y, g2.x, g2.y]} {...sp} />}
          </Fragment>
        );
      })}
      <Line points={[ws1.x, ws1.y, ws2.x, ws2.y]} dash={WEATHERSTRIP_DASH} {...sp} />
    </>
  );
}

// 記号未実装の機構: 開口端に短いティックマーク2本のみ描き、ギャップの存在を視認できるようにする
function tickSymbol(opening, host, sp) {
  const { coord1, coord2, isVertical } = opening;
  const axisValue = host.axisValue;
  const tick = (along) => {
    const a = toWorld(isVertical, along, axisValue - TICK_HALF_MM);
    const b = toWorld(isVertical, along, axisValue + TICK_HALF_MM);
    return [a.x, a.y, b.x, b.y];
  };
  return (
    <>
      <Line points={tick(coord1)} {...sp} />
      <Line points={tick(coord2)} {...sp} />
    </>
  );
}

// 選択中開口のハイライト矩形（リスト⇄図面の対応表示。建具モード専用）。
// 壁厚方向は host.materialRange（実際に材が存在する範囲）へ視認用マージンを足す。
const SELECT_HIGHLIGHT_MARGIN_MM = 30;
function selectionHighlight(opening, host, isVertical) {
  const { lo, hi } = host.materialRange;
  const perpLo = lo - SELECT_HIGHLIGHT_MARGIN_MM, perpHi = hi + SELECT_HIGHLIGHT_MARGIN_MM;
  return (
    <Rect
      key={`${opening.id}-sel`}
      {...rectSpec(isVertical, opening.coord1, opening.coord2, perpLo, perpHi)}
      stroke="#2563eb"
      strokeWidth={2}
      fill="transparent"
      listening={false}
    />
  );
}

export const OpeningsLayer = observer(({ graph, viewport, selectedId = null }) => {
  if (!graph) return null;
  const { scaleX, scaleY, lodLevel } = viewport;

  return graph.openings.map((opening) => {
    const host = findHostWall(opening, graph);
    if (!host) return null; // ホスト壁が見つからない開口は描画しない（壁の削除・トリム後の縮退仕様）

    const entry = findCatalogEntry(opening.category, opening.subType);
    const sp = {
      stroke:      opening.color,
      strokeWidth: resolveStrokeWidth(opening.lineWeight, Math.min(scaleX, scaleY)),
      listening:   false,
    };
    const highlight = opening.id === selectedId ? selectionHighlight(opening, host, opening.isVertical) : null;

    // 略図: 機構を問わずティックマークのみ（視認ノイズを減らす簡略表示）
    if (lodLevel !== LodLevel.SCHEMATIC && entry && IMPLEMENTED_MECHANISMS.has(entry.mechanism)) {
      if (entry.mechanism === OpeningMechanism.SWING) {
        const detail = lodLevel === LodLevel.DETAIL;
        return (
          <Fragment key={opening.id}>
            {highlight}
            {detail && swingFrameSymbol(opening, host, graph, sp)}
            {swingSymbol(
              opening, host, sp,
              detail ? FRAME_HINGE_INSET_MM : 0,
              detail ? FRAME_LATCH_INSET_MM : 0,
              detail ? DOOR_LEAF_THICKNESS_MM : 0,
            )}
          </Fragment>
        );
      }
      if (entry.mechanism === OpeningMechanism.SLIDE_DOUBLE) {
        const detail = lodLevel === LodLevel.DETAIL;
        return (
          <Fragment key={opening.id}>
            {highlight}
            {detail ? slideDoubleDetailSymbol(opening, host, graph, sp) : slideDoubleSymbol(opening, host, sp)}
          </Fragment>
        );
      }
    }
    return <Fragment key={opening.id}>{highlight}{tickSymbol(opening, host, sp)}</Fragment>;
  });
});
