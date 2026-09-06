import { Fragment } from 'react';
import { observer } from 'mobx-react-lite';
import { Line, Rect, Path } from 'react-konva';
import { OpeningCategory } from '../core.js';
import { buildHostWallByOpening, wallFaceRange } from '../openings/openingGeometry.js';
import { graphComputed } from './graphDerived.js';
import { findCatalogEntry, IMPLEMENTED_MECHANISMS, OpeningMechanism } from '../openings/openingCatalog.js';
import {
  DOOR_OPEN_ANGLE_DEG, closedAngleFor, leafOpenAngle, angleVectors,
  swingDoubleLeafSpecs, swingChildLeafSpecs, fireDoorLeafSpecs, fireFoldLeafSpecs,
  foldZigzagPoints, trackOf, trackPerp, openingExteriorDir, resolveSlideLayoutPanels,
  FRAME_JAMB_WIDTH_MM, FRAME_KAKARI_WIDTH_MM,
  planFrameBand, bandPerp, planSymbolPlan, innerSpanOpening,
} from '../openings/openingPlanSymbolGeometry.js';
import { arcPathD } from './ShapesLayer.jsx';
import { LodLevel, resolveStrokeWidth } from '../viewport.js';

const TICK_HALF_MM  = 30;

// 引き違い 詳細LOD用（すべて mm）
const SLIDE_TRACK_INSET_MM = 4;       // 枠から戸先・召し合わせレールまでの隙間
const WEATHERSTRIP_DASH    = [6, 4];  // 召し合わせ部・気密材(モヘア)の破線パターン

// 開き戸 詳細LOD用 枠寸法（すべて mm）
const DOOR_LEAF_THICKNESS_MM  = 30; // 扉厚（かかり代を欠き込む深さ）
const DOOR_HINGE_GAP_MM       = 5;  // 開いた扉と吊元側の方立との隙間
// 吊元側後退量: 方立の全幅(30) - 吊元と方立の隙間(5)
const FRAME_HINGE_INSET_MM = FRAME_JAMB_WIDTH_MM - DOOR_HINGE_GAP_MM;
// 戸先側後退量: 反対側の方立の「本体20mm」境界にぴったり納まる位置
const FRAME_LATCH_INSET_MM = FRAME_JAMB_WIDTH_MM - FRAME_KAKARI_WIDTH_MM;

// 新機構用の記号寸法（すべて mm）
const FOLD_AMPLITUDE_MM  = 120; // 折れ戸・折りたたみ窓のジグザグ振幅
const SHUTTER_DASH       = [14, 4, 4, 4]; // シャッターの一点鎖線
const OVERHEAD_DASH      = [10, 6];       // オーバーヘッドドアの跳ね上げ投影（破線）
const OVERHEAD_DEPTH_MM  = 200;
const EMERGENCY_SIDE_MM  = 400; // 非常用進入口の逆三角形の一辺
const FIRE_ARC_DASH      = [10, 6]; // 常時開放金物の開放位置を示す破線円弧
const FIRE_FOLD_PEAKS    = 2;       // 常時開放式防火折戸: 吊元側に畳んだジグザグの山数
const FIRE_FOLD_AMP_MM   = 60;      // 同上の振幅

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

// 開き戸leaf1枚（扉線＋90°円弧）。吊元位置・leaf長を引数化し、片開き・両開き・親子等の
// 複数箇所から再利用する。leafThickness>0（詳細LOD）のときのみ扉厚みのある四角形を描く。
// swingSide の規約: openingGeometry.js swingSideTowardPerp の perpDir=(isVertical?1:-1)*
// swingSide*hingeSide と整合させる——hingeSideが反転する対向leaf（両開き・親子等）を同じ
// 物理側へ開かせるには、呼び出し側がswingSideも反転して渡す必要がある（openingPlanSymbolGeometry.js
// leafOpenAngle 参照。2枚が壁の反対側へ開いてしまう回帰バグの再発防止）。
function swingLeafSymbol(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLength, sp, leafThickness = 0) {
  const hinge = toWorld(isVertical, hingeAlong, pivotPerp);
  const closedAngle = closedAngleFor(isVertical, hingeSide);
  const openAngle = leafOpenAngle(closedAngle, swingSide, DOOR_OPEN_ANGLE_DEG);
  const { dir, perp } = angleVectors(openAngle);

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
        data={arcPathD(hinge.x, hinge.y, leafLength, closedAngle, openAngle - closedAngle)}
        fill="transparent"
        {...sp}
      />
    </>
  );
}

// SWING（片開き）: 開口全幅を1本のleafとして描く（既存のinset付き呼び出しをそのまま踏襲）。
function swingSymbol(opening, pivotPerp, sp, hingeInset = 0, latchInset = 0, leafThickness = 0) {
  const { width, hingeSide, swingSide, isVertical } = opening;
  const effHingeInset = Math.min(hingeInset, width);
  const effLatchInset = Math.min(latchInset, width);
  const leafLength = Math.max(0, width - effHingeInset - effLatchInset);
  const hingeAlong = hingeSide < 0 ? opening.coord1 + effHingeInset : opening.coord2 - effHingeInset;
  return swingLeafSymbol(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLength, sp, leafThickness);
}

// leaf仕様の配列（{hingeAlong, hingeSide, sense, leafLength}[]）をswingLeafSymbolへ機械的に
// 展開する共通ヘルパ。leaf仕様の決定（対向leafのsense符号反転を含む）はopeningPlanSymbolGeometry.js
// 側の *LeafSpecs 関数に一本化し、ここでは消費するだけにする（QAレビュー: OpeningsLayer.jsx単体で
// swingSideの符号を握っていると、レンダラ結線のミスがテストで検出できない）。
function swingLeafSymbols(isVertical, pivotPerp, specs, sp) {
  return specs.map((s, i) => (
    <Fragment key={i}>{swingLeafSymbol(isVertical, pivotPerp, s.hingeAlong, s.hingeSide, s.sense, s.leafLength, sp)}</Fragment>
  ));
}

// SWING_DOUBLE（両開き）: 左右の枠端それぞれを吊元に、各leaf長=width/2で開口中央に円弧が出会う。
function swingDoubleSymbol(opening, pivotPerp, sp) {
  const { coord1, coord2, width, swingSide, isVertical } = opening;
  const specs = swingDoubleLeafSpecs(coord1, coord2, width, swingSide);
  return <>{swingLeafSymbols(isVertical, pivotPerp, specs, sp)}</>;
}

// SWING_CHILD（親子扉）: 親leaf長=width×(1-childRatio)、子leaf長=width×childRatio。
// 親の吊元はhingeSide側の枠端、子の吊元は反対側の枠端。
function swingChildSymbol(opening, pivotPerp, sp, entry) {
  const { coord1, coord2, width, hingeSide, swingSide, isVertical } = opening;
  const childRatio = entry?.childRatio ?? 0.3;
  const specs = swingChildLeafSpecs(coord1, coord2, width, hingeSide, swingSide, childRatio);
  return <>{swingLeafSymbols(isVertical, pivotPerp, specs, sp)}</>;
}

// 自由開きleaf1枚: 閉じ位置の扉線1本＋両側（swingSide側とその逆側）に90°円弧。
// 両方向の弧を描くため、対向leaf（coord2側）にswingSideを反転して渡しても和集合（描画結果）は
// 変わらない——swingDoubleSymbol等と異なり符号反転は不要（freeDoubleSymbol参照）。
function freeLeafSymbol(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLength, sp) {
  const hinge = toWorld(isVertical, hingeAlong, pivotPerp);
  const closedAngle = closedAngleFor(isVertical, hingeSide);
  const towardFar = hingeSide < 0 ? 1 : -1;
  const far = toWorld(isVertical, hingeAlong + towardFar * leafLength, pivotPerp);
  return (
    <>
      <Line points={[hinge.x, hinge.y, far.x, far.y]} {...sp} />
      <Path data={arcPathD(hinge.x, hinge.y, leafLength, closedAngle, swingSide * DOOR_OPEN_ANGLE_DEG)} fill="transparent" {...sp} />
      <Path data={arcPathD(hinge.x, hinge.y, leafLength, closedAngle, -swingSide * DOOR_OPEN_ANGLE_DEG)} fill="transparent" {...sp} />
    </>
  );
}

// FREE（自由片開き）: 1leaf、開口全幅。
function freeSymbol(opening, pivotPerp, sp) {
  const { coord1, coord2, width, hingeSide, swingSide, isVertical } = opening;
  const hingeAlong = hingeSide < 0 ? coord1 : coord2;
  return freeLeafSymbol(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, width, sp);
}

// FREE_DOUBLE（自由両開き）: FREEを両leafに（各leaf長width/2、吊元は両枠端）。
function freeDoubleSymbol(opening, pivotPerp, sp) {
  const { coord1, coord2, width, swingSide, isVertical } = opening;
  const leafLength = width / 2;
  return (
    <>
      {freeLeafSymbol(isVertical, pivotPerp, coord1, -1, swingSide, leafLength, sp)}
      {freeLeafSymbol(isVertical, pivotPerp, coord2, 1, swingSide, leafLength, sp)}
    </>
  );
}

// FOLD（折れ戸・折りたたみ窓）: 開口全長にジグザグ線（W形）。山数=max(2,round(width/450))。
function foldSymbol(opening, band, sp) {
  const { coord1, width, isVertical } = opening;
  const peaks = Math.max(2, Math.round(width / 450));
  const pts = foldZigzagPoints(coord1, width, peaks, FOLD_AMPLITUDE_MM).flatMap(({ along, perpOffset }) => {
    const p = toWorld(isVertical, along, band.center + perpOffset);
    return [p.x, p.y];
  });
  return <Line points={pts} {...sp} />;
}

// SLIDE_SINGLE（引き戸）: slideDoubleSymbolの1枚版。枠矩形＋内側トラック1本に全長leaf線。
function slideSingleSymbol(opening, band, sp) {
  const { coord1, coord2, isVertical } = opening;
  const leafPerp = bandPerp(band, 0.25);
  const p1 = toWorld(isVertical, coord1, leafPerp);
  const p2 = toWorld(isVertical, coord2, leafPerp);
  return (
    <>
      <Rect {...rectSpec(isVertical, coord1, coord2, band.lo, band.hi)} fill="transparent" {...sp} />
      <Line points={[p1.x, p1.y, p2.x, p2.y]} {...sp} />
    </>
  );
}

// SLIDE_LAYOUT: 枠矩形＋パネルごとのleaf線。パネル幅=width/panels.length、隣接パネルは
// 引違いと同じoverlapで重ねる。トラック割付・perp位置は openingPlanSymbolGeometry.js の
// trackOf/trackPerp（純関数）に委ねる。FIXテキストは平面には描かない（矢印同様、対象外）。
function slideLayoutSymbol(opening, band, sp, entry) {
  const { coord1, coord2, width, isVertical } = opening;
  const frame = <Rect {...rectSpec(isVertical, coord1, coord2, band.lo, band.hi)} fill="transparent" {...sp} />;
  const panels = resolveSlideLayoutPanels(entry);
  if (panels.length === 0) return frame;

  const tracks = entry.slideLayout.tracks;
  const overlap = Math.max(width * 0.12, 60);
  const panelWidth = width / panels.length;
  const hasFix = panels.some(p => p.fix);

  return (
    <>
      {frame}
      {panels.map((p, i) => {
        const startBase = coord1 + i * panelWidth;
        const endBase = startBase + panelWidth;
        const start = i === 0 ? startBase : startBase - overlap / 2;
        const end = i === panels.length - 1 ? endBase : endBase + overlap / 2;
        const track = trackOf(p, i, tracks, hasFix);
        const perp = trackPerp(band.center, track, tracks, band.depth);
        const a = toWorld(isVertical, start, perp);
        const b = toWorld(isVertical, end, perp);
        return <Line key={i} points={[a.x, a.y, b.x, b.y]} {...sp} />;
      })}
    </>
  );
}

// HUNG（上げ下げ窓）: 枠矩形＋両トラックに全長線1本ずつ（上下障子が平面では全長重なる）。
function hungSymbol(opening, band, sp) {
  const { coord1, coord2, isVertical } = opening;
  const leaf1Perp = bandPerp(band, 0.25);
  const leaf2Perp = bandPerp(band, 0.75);
  const l1a = toWorld(isVertical, coord1, leaf1Perp), l1b = toWorld(isVertical, coord2, leaf1Perp);
  const l2a = toWorld(isVertical, coord1, leaf2Perp), l2b = toWorld(isVertical, coord2, leaf2Perp);
  return (
    <>
      <Rect {...rectSpec(isVertical, coord1, coord2, band.lo, band.hi)} fill="transparent" {...sp} />
      <Line points={[l1a.x, l1a.y, l1b.x, l1b.y]} {...sp} />
      <Line points={[l2a.x, l2a.y, l2b.x, l2b.y]} {...sp} />
    </>
  );
}

// PIVOT（縦軸回転窓）: 開口中央に壁直交方向の障子線（長さ=min(width,600)）＋その両側に
// 90°円弧2つ（回転の軌跡、半径=width/2、中心=開口中心）。
function pivotSymbol(opening, band, sp) {
  const { centerCoord, width, isVertical } = opening;
  const leafLen = Math.min(width, 600);
  const p1 = toWorld(isVertical, centerCoord, band.center - leafLen / 2);
  const p2 = toWorld(isVertical, centerCoord, band.center + leafLen / 2);
  const center = toWorld(isVertical, centerCoord, band.center);
  const r = width / 2;
  const alongAngle = isVertical ? 90 : 0;
  const perpAngle  = isVertical ? 0 : 90;
  const sweep = perpAngle - alongAngle;
  return (
    <>
      <Line points={[p1.x, p1.y, p2.x, p2.y]} {...sp} />
      <Path data={arcPathD(center.x, center.y, r, alongAngle, sweep)} fill="transparent" {...sp} />
      <Path data={arcPathD(center.x, center.y, r, alongAngle + 180, sweep)} fill="transparent" {...sp} />
    </>
  );
}

// 窓一般線: 枠矩形（band）＋壁軸上に全長1本線。FIXED/TILT/TILT_OUT/AWNING/PROJECT_OUT/
// LOUVER/AWNING_MULTI/GARARI/GLASS_BLOCK/PIVOT_H に適用する。
function windowLineSymbol(opening, band, sp) {
  const { coord1, coord2, isVertical } = opening;
  const p1 = toWorld(isVertical, coord1, band.center);
  const p2 = toWorld(isVertical, coord2, band.center);
  return (
    <>
      <Rect {...rectSpec(isVertical, coord1, coord2, band.lo, band.hi)} fill="transparent" {...sp} />
      <Line points={[p1.x, p1.y, p2.x, p2.y]} {...sp} />
    </>
  );
}

// SHUTTER: 開口全長の一点鎖線を壁軸上に1本＋両端に既存tick。
function shutterSymbol(opening, band, sp) {
  const { coord1, coord2, isVertical } = opening;
  const p1 = toWorld(isVertical, coord1, band.center);
  const p2 = toWorld(isVertical, coord2, band.center);
  return (
    <>
      <Line points={[p1.x, p1.y, p2.x, p2.y]} dash={SHUTTER_DASH} {...sp} />
      {tickSymbol(opening, band, sp)}
    </>
  );
}

// OVERHEAD（オーバーヘッドドア）: 開口全長×奥行200mmの破線矩形を室内側（openingExteriorDirの
// 逆側）の壁面に接して描く（跳ね上げた戸板の投影）＋壁軸上に実線1本。openingExteriorDirは
// 境界（host自身または反対側の壁）の外壁面向きを見るため、hostが室内向き壁でもCL偏芯でも
// 正しい室外側を返す（Math.sign(host.axisOffset)は使わない。openingPlanSymbolGeometry.js参照）。
function overheadSymbol(opening, host, graph, band, sp) {
  const { coord1, coord2, isVertical, centerCoord } = opening;
  const axisValue = band.center;
  const dir = -openingExteriorDir(host, graph, centerCoord);
  const perpLo = dir > 0 ? axisValue : axisValue - OVERHEAD_DEPTH_MM;
  const perpHi = dir > 0 ? axisValue + OVERHEAD_DEPTH_MM : axisValue;
  const p1 = toWorld(isVertical, coord1, axisValue);
  const p2 = toWorld(isVertical, coord2, axisValue);
  return (
    <>
      <Rect {...rectSpec(isVertical, coord1, coord2, perpLo, perpHi)} dash={OVERHEAD_DASH} fill="transparent" {...sp} />
      <Line points={[p1.x, p1.y, p2.x, p2.y]} {...sp} />
    </>
  );
}

// EMERGENCY（非常用進入口）: 壁軸上に全長1本線＋開口中央に逆三角形（一辺400mm、底辺が
// 外部側・頂点が室内側、輪郭のみ）。外部側の判定は overheadSymbol と同じ openingExteriorDir。
function emergencySymbol(opening, host, graph, band, sp) {
  const { coord1, coord2, centerCoord, isVertical } = opening;
  const axisValue = band.center;
  const extDir = openingExteriorDir(host, graph, centerCoord);
  const height = (EMERGENCY_SIDE_MM * Math.sqrt(3)) / 2;
  const halfBase = EMERGENCY_SIDE_MM / 2;
  const baseL = toWorld(isVertical, centerCoord - halfBase, axisValue);
  const baseR = toWorld(isVertical, centerCoord + halfBase, axisValue);
  const apex  = toWorld(isVertical, centerCoord, axisValue - extDir * height);
  const p1 = toWorld(isVertical, coord1, axisValue);
  const p2 = toWorld(isVertical, coord2, axisValue);
  return (
    <>
      <Line points={[p1.x, p1.y, p2.x, p2.y]} {...sp} />
      <Line points={[baseL.x, baseL.y, baseR.x, baseR.y, apex.x, apex.y]} closed fill="transparent" {...sp} />
    </>
  );
}

// FIRE_DOOR 1leaf分: 開放位置のleaf線＋閉位置までの破線円弧（90°または180°）。swingSideは
// swingLeafSymbolと同じ回転センス規約（2枚構成の対向leafは呼び出し側で符号反転して渡す）。
function fireLeafSymbol(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLength, angleDeg, sp) {
  const hinge = toWorld(isVertical, hingeAlong, pivotPerp);
  const closedAngle = closedAngleFor(isVertical, hingeSide);
  const openAngle = leafOpenAngle(closedAngle, swingSide, angleDeg);
  const { dir } = angleVectors(openAngle);
  const far = { x: hinge.x + dir.x * leafLength, y: hinge.y + dir.y * leafLength };
  return (
    <>
      <Line points={[hinge.x, hinge.y, far.x, far.y]} {...sp} />
      <Path data={arcPathD(hinge.x, hinge.y, leafLength, closedAngle, openAngle - closedAngle)} dash={FIRE_ARC_DASH} fill="transparent" {...sp} />
    </>
  );
}

// FIRE_DOOR（常時開放式防火戸）: fireLeaves:2は両枠端から対称に（弧は開口中央で出会う）、
// 1はhingeSide側のみ（leaf長=width）。leaf仕様の決定はfireDoorLeafSpecs（純関数）に一本化する。
function fireDoorSymbol(opening, pivotPerp, sp, entry) {
  const { coord1, coord2, width, hingeSide, swingSide, isVertical } = opening;
  const fireLeaves = entry?.fireLeaves ?? 1;
  const fireAngle  = entry?.fireAngle  ?? 90;
  const specs = fireDoorLeafSpecs(coord1, coord2, width, hingeSide, swingSide, fireLeaves);
  return (
    <>
      {specs.map((s, i) => (
        <Fragment key={i}>{fireLeafSymbol(isVertical, pivotPerp, s.hingeAlong, s.hingeSide, s.sense, s.leafLength, fireAngle, sp)}</Fragment>
      ))}
    </>
  );
}

// FIRE_FOLD 1袖分: 吊元側に折りたたんだジグザグ（leaf長の1/4程度の幅、2山）＋閉位置までの破線円弧。
// swingSideの規約はfireLeafSymbolと同じ。
function fireFoldPanel(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLen, angleDeg, sp) {
  const hinge = toWorld(isVertical, hingeAlong, pivotPerp);
  const closedAngle = closedAngleFor(isVertical, hingeSide);
  const openAngle = leafOpenAngle(closedAngle, swingSide, angleDeg);
  const { dir, perp } = angleVectors(openAngle);
  const foldLen = leafLen / 4;
  const segCount = FIRE_FOLD_PEAKS * 2;
  const pts = [hinge.x, hinge.y];
  for (let i = 1; i <= segCount; i += 1) {
    const d = (foldLen * i) / segCount;
    const amp = i === segCount ? 0 : (i % 2 === 1 ? FIRE_FOLD_AMP_MM : -FIRE_FOLD_AMP_MM);
    pts.push(hinge.x + dir.x * d + perp.x * amp, hinge.y + dir.y * d + perp.y * amp);
  }
  return (
    <>
      <Line points={pts} {...sp} />
      <Path data={arcPathD(hinge.x, hinge.y, leafLen, closedAngle, openAngle - closedAngle)} dash={FIRE_ARC_DASH} fill="transparent" {...sp} />
    </>
  );
}

// FIRE_FOLD（常時開放式防火折戸）: fireAngle:90は片袖（hingeSide側のみ、弧半径=width）、
// 180は両袖（各半径=width/2、開口中央で出会う）。leaf仕様の決定はfireFoldLeafSpecs（純関数）に一本化する。
function fireFoldSymbol(opening, pivotPerp, sp, entry) {
  const { coord1, coord2, width, hingeSide, swingSide, isVertical } = opening;
  const fireAngle = entry?.fireAngle ?? 90;
  const specs = fireFoldLeafSpecs(coord1, coord2, width, hingeSide, swingSide, fireAngle);
  return (
    <>
      {specs.map((s, i) => (
        <Fragment key={i}>{fireFoldPanel(isVertical, pivotPerp, s.hingeAlong, s.hingeSide, s.sense, s.leafLength, fireAngle, sp)}</Fragment>
      ))}
    </>
  );
}

// SWING・SLIDE_DOUBLE以外の実装済み機構の記号。band（見込帯）を受け取る機構は詳細LODでは
// 呼び出し側（OpeningsLayer本体）が枠内法へ寄せたopening（openingPlanSymbolGeometry.js
// frameInnerSpan由来）を渡すため、この関数自身はSTANDARD/DETAILの分岐を持たない——分岐点は
// planFrameBand/planSymbolPlanに一本化されている（.claude/opening-model.md参照）。
// pivotPerpは蝶番系（回転中心）専用——host.axisValueをband内へクランプした値（F2。
// planSymbolPlanが算出）。OVERHEAD/EMERGENCYは回転しないためhost自体（+graph）で
// openingExteriorDirを引く。未対応の機構はnullを返し、呼び出し側がtickSymbolへフォールバックする。
function otherMechanismSymbol(mechanism, opening, pivotPerp, host, graph, band, sp, entry) {
  switch (mechanism) {
    case OpeningMechanism.SWING_DOUBLE: return swingDoubleSymbol(opening, pivotPerp, sp);
    case OpeningMechanism.SWING_CHILD:  return swingChildSymbol(opening, pivotPerp, sp, entry);
    case OpeningMechanism.SWING_IN:
    case OpeningMechanism.PROJECT_V:
    case OpeningMechanism.DREH_KIPP:    return swingSymbol(opening, pivotPerp, sp);
    case OpeningMechanism.FREE:         return freeSymbol(opening, pivotPerp, sp);
    case OpeningMechanism.FREE_DOUBLE:  return freeDoubleSymbol(opening, pivotPerp, sp);
    case OpeningMechanism.FOLD:         return foldSymbol(opening, band, sp);
    case OpeningMechanism.SLIDE_SINGLE: return slideSingleSymbol(opening, band, sp);
    case OpeningMechanism.SLIDE_LAYOUT: return slideLayoutSymbol(opening, band, sp, entry);
    case OpeningMechanism.HUNG:         return hungSymbol(opening, band, sp);
    case OpeningMechanism.PIVOT:        return pivotSymbol(opening, band, sp);
    case OpeningMechanism.FIXED:
    case OpeningMechanism.TILT:
    case OpeningMechanism.TILT_OUT:
    case OpeningMechanism.AWNING:
    case OpeningMechanism.PROJECT_OUT:
    case OpeningMechanism.LOUVER:
    case OpeningMechanism.AWNING_MULTI:
    case OpeningMechanism.GARARI:
    case OpeningMechanism.GLASS_BLOCK:
    case OpeningMechanism.PIVOT_H:      return windowLineSymbol(opening, band, sp);
    case OpeningMechanism.SHUTTER:      return shutterSymbol(opening, band, sp);
    case OpeningMechanism.OVERHEAD:     return overheadSymbol(opening, host, graph, band, sp);
    case OpeningMechanism.EMERGENCY:    return emergencySymbol(opening, host, graph, band, sp);
    case OpeningMechanism.FIRE_DOOR:    return fireDoorSymbol(opening, pivotPerp, sp, entry);
    case OpeningMechanism.FIRE_FOLD:    return fireFoldSymbol(opening, pivotPerp, sp, entry);
    default: return null;
  }
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
// 方立は全幅30mm（本体20mm＋かかり代10mm）だが、扉が通過する位置（扉が閉じた面=pivotPerp
// から室内側へ10mm＋壁中心側へ扉厚30mm＝計40mmの範囲）だけかかり代10mmが欠き込まれた
// 段付き断面になる。四角２つの組合せではなく単一の輪郭で描く。
//
// pivotPerp（=host.axisValueをband内へクランプした値。呼び出し側のplanSymbolPlanが算出）を
// 欠き込みの起点にする——frameDepthの半外付けでbandがhost.axisValue自身を含まなくなると
// （host側の面がband外に出る）、素のhost.axisValueを起点にした場合に扉leafがband外へ140mm
// 浮いた上notchFarのクランプで輪郭が矩形へ潰れる実バグがあった（F2）。frameDepth未設定時は
// bandが必ずhost.axisValueを含むためpivotPerp===host.axisValueとなり既存挙動は変わらない。
function swingFrameSymbol(opening, host, band, pivotPerp, sp) {
  const { coord1, coord2, width, isVertical } = opening;
  const jambW = Math.min(FRAME_JAMB_WIDTH_MM, width / 2);
  const kakariW = Math.min(FRAME_KAKARI_WIDTH_MM, jambW);
  const totalPerpLo = band.lo;
  const totalPerpHi = band.hi;

  // 欠き込み範囲: pivotPerp から室内側10mm 〜 壁中心側30mm。室内側の境界は
  // 方立全体の外縁（totalPerpLo/Hi）と一致するため、残るかかり代は反対側の一区間のみ。
  // 扉厚(30mm)ぶんがband外へはみ出す場合の保険として、なおband内へクランプする。
  const outward   = Math.sign(host.axisOffset) || 1;
  const notchFarRaw = pivotPerp - outward * DOOR_LEAF_THICKNESS_MM;
  const notchFar  = Math.min(Math.max(notchFarRaw, totalPerpLo), totalPerpHi);
  const kakariPerpLo = outward > 0 ? totalPerpLo : notchFar;
  const kakariPerpHi = outward > 0 ? notchFar    : totalPerpHi;

  return (
    <>
      <Line points={jambOutlinePoints(isVertical, coord1, 1, jambW, kakariW, totalPerpLo, totalPerpHi, kakariPerpLo, kakariPerpHi, outward)} closed fill="transparent" {...sp} />
      <Line points={jambOutlinePoints(isVertical, coord2, -1, jambW, kakariW, totalPerpLo, totalPerpHi, kakariPerpLo, kakariPerpHi, outward)} closed fill="transparent" {...sp} />
    </>
  );
}

// 非蝶番系 詳細LOD専用（frame:'sash'）: 開口両端に方立（縦枠）を単純な閉じた矩形2つで描く
// （扉が通過しないためswingFrameSymbolのような欠き込みは無い）。記号本体（otherMechanismSymbol）
// が自前で枠矩形を描かない機構（FOLD/PIVOT/SHUTTER/OVERHEAD/EMERGENCY）専用——記号側が枠矩形を
// 描く機構は sashFrameOpenSymbol を使う（F5、二重描画防止）。
function sashFrameSymbol(opening, band, jambWidth, sp) {
  const { coord1, coord2, isVertical } = opening;
  return (
    <>
      <Rect {...rectSpec(isVertical, coord1, coord1 + jambWidth, band.lo, band.hi)} fill="transparent" {...sp} />
      <Rect {...rectSpec(isVertical, coord2 - jambWidth, coord2, band.lo, band.hi)} fill="transparent" {...sp} />
    </>
  );
}

// 非蝶番系 詳細LOD専用（frame:'sashOpen'）: 記号自身が開口全幅の枠矩形を描く機構
// （SASH_OPEN_MECHANISMS = SLIDE_SINGLE/SLIDE_LAYOUT/HUNG/windowLine群）専用の方立。
// 内側（開口本体側）の縦線を持たない3辺（コの字）で描く——閉じた矩形のまま描くと、記号側の
// 枠矩形（otherMechanismSymbolがframeInnerSpanの内法区間に描く矩形）と方立の内側縦線が
// 座標coord1+jambWidth/coord2-jambWidthで完全に一致し、同じ線を2回描いてしまう
// （前コミットf86f305「開口の縁の二重描画をなくす」と同じ瑕疵の再発防止。F5）。
// 開口を横断する線は描かない（折れ戸・開き戸の開口部を塞がないため、上下の横線は各ジャンブの
// 幅ぶんだけに留める）。
function sashFrameOpenSymbol(opening, band, jambWidth, sp) {
  const { coord1, coord2, isVertical } = opening;
  const jamb = (outerAlong, innerAlong) => {
    const p1 = toWorld(isVertical, innerAlong, band.lo);
    const p2 = toWorld(isVertical, outerAlong, band.lo);
    const p3 = toWorld(isVertical, outerAlong, band.hi);
    const p4 = toWorld(isVertical, innerAlong, band.hi);
    return [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y];
  };
  return (
    <>
      <Line points={jamb(coord1, coord1 + jambWidth)} {...sp} />
      <Line points={jamb(coord2, coord2 - jambWidth)} {...sp} />
    </>
  );
}

// 引き違い leaf線2本のみ（枠矩形なし）。SCHEMATIC LODでの略図表現・slideDoubleSymbolの内部で共用する。
function slideDoubleLeafLines(opening, band, sp) {
  const { coord1, coord2, centerCoord, isVertical } = opening;
  const overlap = Math.max(opening.width * 0.12, 60);
  const leaf1Perp = bandPerp(band, 0.25);
  const leaf2Perp = bandPerp(band, 0.75);
  const leaf1 = [toWorld(isVertical, coord1, leaf1Perp), toWorld(isVertical, centerCoord + overlap / 2, leaf1Perp)];
  const leaf2 = [toWorld(isVertical, centerCoord - overlap / 2, leaf2Perp), toWorld(isVertical, coord2, leaf2Perp)];

  return (
    <>
      <Line points={[leaf1[0].x, leaf1[0].y, leaf1[1].x, leaf1[1].y]} {...sp} />
      <Line points={[leaf2[0].x, leaf2[0].y, leaf2[1].x, leaf2[1].y]} {...sp} />
    </>
  );
}

function slideDoubleSymbol(opening, band, sp) {
  const { coord1, coord2, isVertical } = opening;
  return (
    <>
      <Rect {...rectSpec(isVertical, coord1, coord2, band.lo, band.hi)} fill="transparent" {...sp} />
      {slideDoubleLeafLines(opening, band, sp)}
    </>
  );
}

// 引き違い 詳細LOD専用: band（見込帯）から枠位置を導出し、枠＋2枚のサッシ＋召し合わせ部の
// 気密材（破線）を描く。窓（OpeningCategory.WINDOW）のみ各サッシ中央にガラス線を追加し、
// 戸は無地のパネルとして描く。
function slideDoubleDetailSymbol(opening, band, sp) {
  const { coord1, coord2, centerCoord, isVertical, category } = opening;
  const overlap = Math.max(opening.width * 0.12, 60);

  const outerLo = band.lo, outerHi = band.hi;
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
function tickSymbol(opening, band, sp) {
  const { coord1, coord2, isVertical } = opening;
  const axisValue = band.center;
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
  const detail = lodLevel === LodLevel.DETAIL;

  // 開口ごとのホスト壁は graph が変わらない限り同じ——パン・ズームの再レンダーで
  // 引き直さないよう graph 単位にキャッシュする（graphDerived.js）。
  const hostByOpening = graphComputed(graph, 'hostWallByOpening', () => buildHostWallByOpening(graph));

  // 詳細LODでのみ壁面線(faceLo/faceHi)を引く。wallFaceRange→findCounterpartWallはgraph.wallsの
  // 線形探索（O(壁数)）のため、開口ごとに毎回呼ぶとO(開口数×壁数)になる（F6）。ホスト壁が
  // 同じ複数開口（1本の壁に窓が並ぶ等）で重複計算しないよう、ホスト壁の id 単位で1回だけ計算し
  // graph 単位にキャッシュする（hostByOpeningと同じ graphComputed パターン。実装方針9）。
  //
  // 注意（graphDerived.js の規約）: compute は自身の実行中に読んだobservable/computedだけを
  // 依存として登録する。外側の変数（上のhostByOpening）をクロージャで捕まえるだけだと、
  // その参照はこのcomputedが最初に作られた時点のものに固定され、graph.openingsが変わって
  // hostWallByOpeningが再計算されても（graph.wallsが変わらない限り）このcomputedは無効化
  // されない——`wallFaceRange`がgraph.wallsを読むために"たまたま"連動していただけの壊れやすい
  // 依存だった。compute内で`graphComputed(graph, 'hostWallByOpening', ...)`を呼び直し、
  // その場でhostWallByOpening computedを`.get()`することで、MobXのcomputed同士の依存追跡に
  // 正しく乗せる（computed-observes-computedはMobXの標準パターン）。
  const faceRangeByHostId = detail
    ? graphComputed(graph, 'wallFaceRangeByHostId', () => {
        const hosts = graphComputed(graph, 'hostWallByOpening', () => buildHostWallByOpening(graph));
        const map = new Map();
        for (const host of hosts.values()) {
          if (!map.has(host.id)) map.set(host.id, wallFaceRange(host, graph));
        }
        return map;
      })
    : null;

  return graph.openings.map((opening) => {
    const host = hostByOpening.get(opening.id) ?? null;
    if (!host) return null; // ホスト壁が見つからない開口は描画しない（壁の削除・トリム後の縮退仕様）

    const entry = findCatalogEntry(opening.category, opening.subType);
    const sp = {
      stroke:      opening.color,
      strokeWidth: resolveStrokeWidth(opening.lineWeight, Math.min(scaleX, scaleY)),
      listening:   false,
    };
    const highlight = opening.id === selectedId ? selectionHighlight(opening, host, opening.isVertical) : null;

    // 見込帯（planFrameBand）が一般/詳細の唯一の分岐点。詳細LODのときだけ壁面線
    // （faceRangeByHostId）を引き、frameDepth（ユーザー入力）が設定されているときだけ
    // 室外側判定（openingExteriorDir）も追加で引く——一般LODのレンダーコストを増やさない。
    const band = detail
      ? (() => {
          // キャッシュミス（本来起きない想定だが、キー衝突等の異常系でも詳細LOD描画を
          // 丸ごと落とさないための保険）はメモ化なしで直接計算し、その1件だけ縮退させる。
          const [faceLo, faceHi] = faceRangeByHostId.get(host.id) ?? wallFaceRange(host, graph);
          const exteriorDir = opening.frameDepth > 0 ? openingExteriorDir(host, graph, opening.centerCoord) : undefined;
          return planFrameBand({ axisValue: host.axisValue, faceLo, faceHi, frameDepth: opening.frameDepth, exteriorDir, detail: true });
        })()
      : planFrameBand({ axisValue: host.axisValue, detail: false });

    // 略図: 機構を問わずティックマークのみ（視認ノイズを減らす簡略表示）。ただし引き違い
    // （戸・窓）だけはtickに加えてleaf線2本（枠矩形なし）も描き、開閉方向が視認できるようにする。
    if (lodLevel === LodLevel.SCHEMATIC) {
      const slideLeaf = entry?.mechanism === OpeningMechanism.SLIDE_DOUBLE ? slideDoubleLeafLines(opening, band, sp) : null;
      return <Fragment key={opening.id}>{highlight}{tickSymbol(opening, band, sp)}{slideLeaf}</Fragment>;
    }

    if (entry && IMPLEMENTED_MECHANISMS.has(entry.mechanism)) {
      // 詳細LODディスパッチの「判断」（notched/sashOpen/sash/none・内法区間・回転中心）は
      // すべてplanSymbolPlan（純関数、node:test単体テスト対象）に一本化する——ここに
      // 機構ごとの分岐を書き足さない（QA指摘: .jsx内の判断は結線ミスがテストで検出できない）。
      const jambW = Math.min(FRAME_JAMB_WIDTH_MM, opening.width / 2);
      const plan = planSymbolPlan({
        mechanism: entry.mechanism,
        lodLevel,
        coord1: opening.coord1,
        coord2: opening.coord2,
        axisValue: host.axisValue,
        band,
        jambWidth: jambW,
      });

      if (entry.mechanism === OpeningMechanism.SWING) {
        return (
          <Fragment key={opening.id}>
            {highlight}
            {detail && swingFrameSymbol(opening, host, band, plan.pivotPerp, sp)}
            {swingSymbol(
              opening, plan.pivotPerp, sp,
              detail ? FRAME_HINGE_INSET_MM : 0,
              detail ? FRAME_LATCH_INSET_MM : 0,
              detail ? DOOR_LEAF_THICKNESS_MM : 0,
            )}
          </Fragment>
        );
      }
      if (entry.mechanism === OpeningMechanism.SLIDE_DOUBLE) {
        return (
          <Fragment key={opening.id}>
            {highlight}
            {detail ? slideDoubleDetailSymbol(opening, band, sp) : slideDoubleSymbol(opening, band, sp)}
          </Fragment>
        );
      }
      if (plan.frame === 'notched') {
        // 蝶番系（SWING以外）: 回転中心はplan.pivotPerpのまま（不変条件。扉は枠の中心ではなく
        // 面で閉じる）、開口の長さ方向のみ枠の内法へ寄せる。
        const spanOpening = innerSpanOpening(opening, plan.innerSpan);
        return (
          <Fragment key={opening.id}>
            {highlight}
            {swingFrameSymbol(opening, host, band, plan.pivotPerp, sp)}
            {otherMechanismSymbol(entry.mechanism, spanOpening, plan.pivotPerp, host, graph, band, sp, entry)}
          </Fragment>
        );
      }
      if (plan.frame === 'sashOpen' || plan.frame === 'sash') {
        // 非蝶番系: 一般記号を枠内法・実見込へ寄せて描く（機構を追加してもここは変更不要——
        // 一般/詳細・方立の形状の分岐点はplanSymbolPlanに一本化されている）。
        const spanOpening = innerSpanOpening(opening, plan.innerSpan);
        const frameEl = plan.frame === 'sashOpen'
          ? sashFrameOpenSymbol(opening, band, jambW, sp)
          : sashFrameSymbol(opening, band, jambW, sp);
        return (
          <Fragment key={opening.id}>
            {highlight}
            {frameEl}
            {otherMechanismSymbol(entry.mechanism, spanOpening, plan.pivotPerp, host, graph, band, sp, entry)}
          </Fragment>
        );
      }
      // frame==='none'（STANDARD）: bandは一般帯（axisValue中心・幅40mm）なので見た目は不変。
      const other = otherMechanismSymbol(entry.mechanism, opening, plan.pivotPerp, host, graph, band, sp, entry);
      if (other) return <Fragment key={opening.id}>{highlight}{other}</Fragment>;
    }
    return <Fragment key={opening.id}>{highlight}{tickSymbol(opening, band, sp)}</Fragment>;
  });
});
