// CL移動範囲・移動スナップ（followerGraph.js computeMoveRange / structural/beamAxisMove.js
// beamAxisMoveRange / snapGeometry.js findCLMoveSnap・findBeamAxisMoveSnap）を実データで確認する
// probe（調査・回帰用。製品コードからは参照しない）。
//
// centerLineKindPolicy.js ステップ4（同方向の移動障害物・移動スナップ吸着先を
// sameDirectionObstacles／moveSnapTargetKinds 経由へ移行）の前後で出力を突き合わせ、挙動不変
// （差分0件）を確認する用途。
//
// 全階×全CL（struct含む）について:
//   - moveRange: 実アプリが移動開始時に呼ぶのと同じ関数（struct/center/aux は
//     transform/followerGraph.js の collectFollowerOffsets→computeMoveRange、
//     beam は structural/beamAxisMove.js の beamAxisMoveRange）で移動範囲を計算する。
//   - moveSnap: 各CLについて構成的に作った試行点群（buildTrialOffsets参照）で、同じく
//     snapGeometry.js の findCLMoveSnap（struct/center/aux）・findBeamAxisMoveSnap（beam）で
//     スナップ値を計算する。
//
// 【moveSnap試行点の構成（QA指摘M-2対応。固定オフセット±500/±100/0では検出力ゼロだった）】
// 各CLについて、同方向（同centerLineType・全種別・自分以外）の他CL each の value を中心に
// ±SNAP_THRESHOLD_MM/2（吸着閾値の半分。閾値内に収まる近傍点）の2点＋valueちょうどの1点を試行点に
// 加える——「他CLの値の近くにカーソルを置いたときに実際どこへ吸着するか」を種別を問わず総当たりする
// ことで、種別条件が誤って緩んだ／狭まったケースを結果の違いとして拾えるようにする。梁芯CLについては
// さらに、同方向の隣接CL（全種別、直近の下側・上側）で挟まれる区間の中点・3等分点（findBeamAxisMoveSnap
// の吸着候補そのもの）の近傍も同じ要領で追加する——固定オフセットでは区間の形が個々のCL配置に依存する
// ため、意図的に狙わない限り絶対に踏めなかった。
//
// 【moveSnap関数の差し替え（QA指摘M-2(c)対応）】
// 環境変数 CL_MOVE_SNAP_MODULE を設定すると、findCLMoveSnap/findBeamAxisMoveSnap の import 元を
// 差し替えられる（既定は本番の '../../src/snapGeometry.js'）。HEAD由来の「before」（移行前の
// labeledベース実装）と突き合わせる際、製品ファイルを一切書き換えずに済む
// （scratchpadに置いたHEAD逐語抽出モジュールを指定するだけでよい）。moveRange側
// （computeMoveRange・beamAxisMoveRange）は本ステップの対象外（既存のmutationテストで検出力を
// 確認済み）のため差し替え機構を持たない——常に現在の src/ 実装を使う。
//
// 【実アプリ経路からの意図的な省略】
// 平面系（struct/center/aux）の moveRange は本番では transform/followerGraph.js の
// resolveMoveRange（非同期）を通り、moving が通り芯（isSharedCL）の場合のみ
// storage/FloorSwapManager.js peek() で他フロアを IndexedDB から一時的に読み込んで
// 走査範囲へ加える。本probeは .stq を loadDoc.mjs で丸ごとメモリへ復元済み（IndexedDBは
// 介さない）——peek() をそのまま呼んでも IDB が空のため他フロアが「壁0枚の空グラフ」に
// 化けてしまい、実際の他フロアのデータを反映できない。そこで本probeでは
// resolveMoveRange と同じ「[アクティブグラフ, ...他フロアの走査用グラフ] から
// gatherShapes→collectFollowerOffsets→computeMoveRange」という関数列を使いつつ、
// 「他フロアの走査用グラフ」を IDB peek ではなく loadDocument が既にメモリ上に復元済みの
// project.graphMap から直接取る（scanGraphsFor）。内容面ではIDB経由と等価（同じ .stq の
// 全フロアデータが既にメモリにある）で、影響は「IDBの非同期I/O・peek専用の一時グラフ生成」
// という実装詳細を省く点のみ（collectFollowerOffsets・computeMoveRange 自体は本番と同一関数）。
//
// 【検証データ3本のカバレッジの偏り（実出力から確認）】
// - aux（補助線）CLは3本とも0本（moku2-5/moku4: {struct:12, center:15, beam:12}、13.stq:
//   {struct:6, center:24}）——findCLMoveSnap の moving=aux 経路・aux が障害物候補になる経路は
//   このprobeでは一度も踏まれない。
// - 13.stq は梁芯（beam）CLが0本——beamAxisMoveRange・findBeamAxisMoveSnap（同方向に他の梁芯が
//   無いケースはもちろん、梁芯そのものが無い）は13.stqでは一度も呼ばれない。
// - struct（通り芯）はisSharedCLの随伴探査（collectFollowerOffsets）がMAX_DEPTH/MAX_COUNTを
//   超えるとcomputeMoveRangeへ到達せず`{exceeded}`を返す。実測でstructレコードのうちexceeded
//   になる件数はmoku2-5=7/12・moku4=8/12・13.stq=5/6——半数以上のstructがcomputeMoveRangeの
//   実障害物走査そのものを通らない（このステップの主題である「同方向障害物の種別条件」を
//   検証できているのは残り、少数のstructレコードのみ）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/clMoveRangeProbe.mjs [入力.stq]
//   CL_MOVE_SNAP_MODULE=<file://絶対パス> node --import ... scripts/probe/clMoveRangeProbe.mjs [入力.stq]
import { pathToFileURL } from 'node:url';
import { loadDocument } from './loadDoc.mjs';
import { centerLineKind } from '../../src/core/centerLine.js';
import { ShapeType } from '../../src/core/constants.js';
import { collectFollowerOffsets, computeMoveRange, isSharedCL } from '../../src/transform/followerGraph.js';
import { beamAxisMoveRange } from '../../src/structural/beamAxisMove.js';

// CL_MOVE_SNAP_MODULE には絶対パス（Windowsパス可）・file://URL・相対specifierのいずれも渡せる
// （絶対パスは import() がそのまま解釈できないため pathToFileURL で変換する）。
function resolveSnapModuleSpecifier(raw) {
  if (!raw) return '../../src/snapGeometry.js';
  if (raw.startsWith('.') || raw.startsWith('file://')) return raw;
  return pathToFileURL(raw).href;
}
const snapModuleSpecifier = resolveSnapModuleSpecifier(process.env.CL_MOVE_SNAP_MODULE);
const { findCLMoveSnap, findBeamAxisMoveSnap } = await import(snapModuleSpecifier);

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku2-5.stq';
const { project } = loadDocument(src);

// 実アプリの既定ズーム相当（viewport.js DEFAULT_PX_PER_MM=96/25.4、scaleDenominator=100）。
// findCLMoveSnap・findBeamAxisMoveSnap はスクリーンpx距離で閾値判定するため、mm/px換算の代表値が要る。
const DEFAULT_PX_PER_MM = 96 / 25.4;
const SCALE = DEFAULT_PX_PER_MM / 100;
// snap.js SNAP_THRESHOLD_PX と同値（snap.js自体はstore.js経由でlocalStorageに触れるためNodeから
// 直接importできない——値だけをここに複写する。CL_THRESHOLD_PXではなくSNAP_THRESHOLD_PXを使うのは、
// 中心線移動ドラッグ中の実際のスナップ判定がこちらの閾値で呼ばれるため
// ——interaction/usePointerInteraction.js の updatePointer 内 findCLMoveSnap/findBeamAxisMoveSnap 呼び出し参照）。
const SNAP_THRESHOLD_PX = 20;
const SNAP_THRESHOLD_MM = SNAP_THRESHOLD_PX / SCALE; // ≈529mm（代表スケール時）

// followerGraph.js gatherShapes（非export）の再実装。probe専用の scanGraphsFor が返す
// グラフ配列から centerLines/walls/diagonals を重複なく集める（本番と同じ集約ロジック）。
function gatherShapesFromGraphs(graphs) {
  const seen = new Set();
  const centerLines = [];
  const walls = [];
  const diagonals = [];
  for (const g of graphs) {
    for (const cl of g.centerLines) {
      if (seen.has(cl)) continue;
      seen.add(cl); centerLines.push(cl);
    }
    for (const s of g.shapes) {
      if (seen.has(s)) continue;
      if (s.type === ShapeType.WALL) { seen.add(s); walls.push(s); }
      else if (s.type === ShapeType.DIAGONAL) { seen.add(s); diagonals.push(s); }
    }
  }
  return { centerLines, walls, diagonals };
}

// followerGraph.js gatherScanGraphs（非export）のprobe版。IDB peekの代わりに、既にメモリ上へ
// 復元済みの project.graphMap から他フロアのグラフを直接使う（ファイル冒頭コメント参照）。
function scanGraphsFor(activeGraph, movingCL) {
  if (!isSharedCL(movingCL)) return [activeGraph];
  return [...project.graphMap.values()];
}

function moveRangeFor(activeGraph, cl) {
  const kind = centerLineKind(cl);
  if (kind === 'beam') return { range: beamAxisMoveRange(activeGraph, cl) };
  const graphs = scanGraphsFor(activeGraph, cl);
  const bundle = gatherShapesFromGraphs(graphs);
  const { offsetOf, exceeded } = collectFollowerOffsets(bundle, cl);
  if (exceeded) return { exceeded };
  return { range: computeMoveRange(bundle, cl, offsetOf) };
}

/**
 * cl の試行オフセット(mm、cl.value からの相対値)を構成的に作る（QA指摘M-2対応）。
 * 1) 自身の現在地点(0)。
 * 2) 同方向（同centerLineType・全種別・自分以外）の他CL each について、その value ちょうど・
 *    value±SNAP_THRESHOLD_MM/2（吸着閾値の半分＝必ず閾値内に収まる近傍）の3点。
 * 3) cl が梁芯なら、同方向の隣接CL（全種別、直近の下側・上側）で挟まれる区間の中点・3等分点
 *    （findBeamAxisMoveSnapの吸着候補そのもの）についても同じ3点構成を追加する。
 * 全種別を対象にする（sameDirectionObstacleKinds等の障害物種別に絞らない）のは、種別条件が
 * 誤って緩んだ／狭まった変異を「本来吸着しないはずの種別に吸着する／すべき種別に吸着しない」
 * という形で検出できるようにするため。
 */
function buildTrialOffsets(graph, cl) {
  const half = SNAP_THRESHOLD_MM / 2;
  const offsets = new Set([0]);
  const siblings = graph.centerLines.filter(o => o.centerLineType === cl.centerLineType && o.id !== cl.id);
  const addAround = (worldValue) => {
    offsets.add(Math.round(worldValue - cl.value));
    offsets.add(Math.round(worldValue - cl.value - half));
    offsets.add(Math.round(worldValue - cl.value + half));
  };
  for (const other of siblings) addAround(other.value);

  if (centerLineKind(cl) === 'beam' && siblings.length > 0) {
    const below = siblings.filter(o => o.value < cl.value).sort((a, b) => b.value - a.value)[0];
    const above = siblings.filter(o => o.value > cl.value).sort((a, b) => a.value - b.value)[0];
    if (below && above) {
      const lo = below.value, hi = above.value;
      for (const p of [(lo + hi) / 2, lo + (hi - lo) / 3, lo + (hi - lo) * 2 / 3]) addAround(p);
    }
  }
  return [...offsets].sort((a, b) => a - b);
}

function snapFor(graph, cl, offsetMm) {
  const isV = cl.centerLineType === 'X';
  const coord = cl.value + offsetMm;
  const wx = isV ? coord : 0;
  const wy = isV ? 0 : coord;
  const kind = centerLineKind(cl);
  if (kind === 'beam') return findBeamAxisMoveSnap(graph, cl, wx, wy, SNAP_THRESHOLD_PX, SCALE, SCALE);
  return findCLMoveSnap(graph, cl, wx, wy, SNAP_THRESHOLD_PX, SCALE, SCALE);
}

// JSON.stringify は Infinity/-Infinity を黙って null にする（区別が消える）ため、文字列化して残す。
function roundRange(range) {
  if (!range) return null;
  const r = (v) => (v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : Math.round(v));
  return { min: r(range.min), max: r(range.max) };
}

const results = [];

// ---- struct（通り芯・全フロア共通）: project.structGraph.centerLines から一意に列挙する ----
// 移動範囲は isSharedCL(cl) 判定により常に全フロアを走査対象にするため、どのフロアを
// activeGraph として渡しても理論上は同じ結果になるはず——代表として先頭フロアを使う
// （全フロアそれぞれをactiveにして重複計算することもできるが、出力サイズと実行時間を優先し省略）。
const firstPlane = project.planes[0];
const firstGraph = firstPlane ? project.graphMap.get(firstPlane.id) : null;
if (firstGraph) {
  for (const cl of project.structGraph.centerLines) {
    const kind = centerLineKind(cl);
    const rangeResult = moveRangeFor(firstGraph, cl);
    const entry = {
      plane: '(struct/全階共通)', id: cl.id, kind, centerLineType: cl.centerLineType, value: Math.round(cl.value),
      moveRange: rangeResult.exceeded ? { exceeded: rangeResult.exceeded } : roundRange(rangeResult.range),
      moveSnap: {},
    };
    for (const offset of buildTrialOffsets(firstGraph, cl)) entry.moveSnap[offset] = snapFor(firstGraph, cl, offset);
    results.push(entry);
  }
}

// ---- center/aux/beam（フロア固有） ----
for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;
  for (const cl of graph.centerLines) {
    const kind = centerLineKind(cl);
    if (kind === 'struct') continue; // 上で処理済み
    const rangeResult = moveRangeFor(graph, cl);
    const entry = {
      plane: plane.name, id: cl.id, kind, centerLineType: cl.centerLineType, value: Math.round(cl.value),
      moveRange: rangeResult.exceeded ? { exceeded: rangeResult.exceeded } : roundRange(rangeResult.range),
      moveSnap: {},
    };
    for (const offset of buildTrialOffsets(graph, cl)) entry.moveSnap[offset] = snapFor(graph, cl, offset);
    results.push(entry);
  }
}

console.log(JSON.stringify(results, null, 2));
