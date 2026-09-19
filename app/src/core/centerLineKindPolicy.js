/**
 * CL（通り芯・中心線・補助線・梁芯）種別間の関係を導出する純粋ポリシーモジュール。
 *
 * 「CL種別ごとにどのappModeで可視か」「同座標に2種別が共存できるか」「直交端部の候補になれるか」
 * 「同方向の移動障害物になれるか」「通り芯⇔中心線の入替えを拒否するか」——これらは現状、
 * transform/centerLineOps.js（追加extent・重複判定）・transform/followerGraph.js（移動範囲）・
 * structural/beamAxisMove.js（梁芯移動範囲）・transform/centerLineConvert.js（入替えガード）・
 * snap.js（ヒット判定）・renderer/CenterLinesLayer.jsx（描画可否）に、種別ごとのインライン条件として
 * 別々に手書きされている。本モジュールはそれらが本来従うべき単一の表（原始事実）と、そこからの
 * 導出関数を集約する——将来、各呼び出し元をこの表を引く形へ移行することで、同じ規約の重複実装が
 * 食い違って起きる不具合（例: 非表示の梁芯だけが延長操作の境界になってしまう）を無くすのが目的。
 *
 * 本ファイル導入の時点では製品コードから未接続だった——特性テスト（centerLineKindPolicy.test.js）が
 * 既存4地点（centerLineOps.js 追加extent・followerGraph.js 移動範囲・beamAxisMove.js・
 * centerLineConvert.js 入替えガード）の現行動作と導出結果が一致することを固定するだけの段階を経て、
 * transform/centerLineExtend.js（延長・短縮。2026-09-19）・transform/centerLineOps.js
 * 追加extent（同・ステップ3）が orthoAnchorCandidates 経由へ移行済み。続いて同方向の移動障害物・
 * 移動スナップ吸着先（ステップ4、2026-09-19）: transform/followerGraph.js computeMoveRange・
 * structural/beamAxisMove.js beamAxisMoveRange・snap.js findCLMoveSnap/findBeamAxisMoveSnap が
 * sameDirectionObstacles／moveSnapTargetKinds 経由へ移行済み。
 * centerLineConvert.js の呼び出し元は本ファイルの範囲外（未着手）。
 *
 * 既知の乖離（旧データ限定）: 未移行の地点は、種別（centerLineKind）ではなく生の `labeled` フラグで
 * 判定している——
 *   - structural/wallBeamAxes.js の findBeamAnchorCL（L293）`cl.labeled || centerLineKind(cl)==='beam'`
 *     ——壁交点柱のアンカー解決・梁芯重複ガード（autoFillWallBeamAxes）が共有する述語。本ファイルの
 *     sameDirectionObstacleKinds('beam')=['struct','beam']と同じ意図だが未移行（L472呼び出し元含め
 *     4地点の対象外として本ステップでは未着手）。
 *   - snap.js の findNearbyCenterLines（L96）`if (cl.labeled) continue;`——長押し位置に近接する
 *     ラベルなしCL（参照元候補）を探す走査で、実質的には「labeled以外＝aux/center/beam全部」を
 *     対象にしている（種別を問わない除外）。
 * 通常経路（AddCLDialog等）で作られるCLは種別と labeled が必ず一致する
 * （通り芯のみ labeled:true）ため実害は無いが、`{labeled:true, discipline:'arch'}` のような
 * 旧データ・異常値が存在すると、本モジュールの種別ベースの予測（orthoAnchorKinds等）と
 * 製品コードの実際の結果が割れる。本モジュールの挙動は変えず、この割れをピン留めテストで
 * 固定してある（centerLineKindPolicy.test.js内、「既知の乖離」と付記したテストを参照）。
 * 種別ベースへ統一するか labeled ベースを維持するかは製品コード移行時に裁定が要る。
 * transform/centerLineOps.js 追加extentは移行済み（種別ベースへ統一。旧「既知の乖離」は解消）。
 * structural/beamAxisMove.js（梁芯移動障害物判定）・snap.js findBeamAxisMoveSnap（梁芯移動スナップの
 * 障害物判定。同じ規約をレイヤ分離のため独立実装していたもの）は本ファイルの sameDirectionObstacles
 * 経由へ移行済み（種別ベースへ統一。旧「既知の乖離」は解消。ステップ4、2026-09-19）。
 * transform/centerLineOps.js addCenterLineFromDialog の重複判定（同座標CLの列挙）・
 * transform/centerLineConvert.js の入替えガード（checkPromoteToGridGuards/checkDemoteToCenterGuards）・
 * transform/centerLineFloorSync.js findFloorsWithCounterpartCL（他階の同座標CL探索）は
 * sameCoordCounterparts（走査API）経由へ移行済み（ステップ5、2026-09-20）。checkDemoteToCenterGuards の
 * dupCenter判定も種別ベースへ統一し、旧「既知の乖離」は解消済み。
 *
 * import ゼロに近い規約（extractedModuleImportInvariant）: ./centerLine.js（centerLineKind）と
 * ./constants.js（CenterLineType）のみに依存する。store.js/snap.js/.jsx/core.js バレル/error.js は
 * 静的 import しない——node:test から本ファイルを単体 import 可能に保つため。
 */
import { centerLineKind } from './centerLine.js';
import { CenterLineType, CL_OVERLAP_TOL_MM } from './constants.js';

export const CL_KINDS = Object.freeze(['struct', 'center', 'aux', 'beam']);

// ui/ModeBar.jsx の MODES（mode値）∪ ['opening']。建具モードはモードバーにボタンを持たないが、
// App.jsx の appMode としては存在する（ModeBar.jsx冒頭コメント参照。平面モードでの建具追加・
// 他モードでの建具ターゲットクリックの2経路から遷移する）。
export const APP_MODES = Object.freeze(['floorplan', 'finish', 'opening', 'structure', 'site', 'elevation']);

function assertKnownKind(kind) {
  if (!CL_KINDS.includes(kind)) throw new Error(`未知のCL種別: ${kind}`);
}
function assertKnownMode(appMode) {
  if (!APP_MODES.includes(appMode)) throw new Error(`未知のappMode: ${appMode}`);
}

// ---- 原始事実1: 可視モード表 ----
// renderer/CenterLinesLayer.jsx L61-68（梁芯は appMode==='structure' でのみ描画、意匠CL＝中心線・
// 補助線は構造モードでは非表示）＋ renderer/SceneLayers.jsx（CenterLinesLayer は GutterLayer 経由で
// しか呼ばれない。site は `appMode !== 'site'` で GutterLayer 自体を描かない／elevation は専用画面
// （早期return）で GutterLayer を含む共有レイヤ群を一切通らない）の統合。
export const VISIBLE_KINDS_BY_MODE = Object.freeze({
  floorplan: Object.freeze(['struct', 'center', 'aux']),
  finish:    Object.freeze(['struct', 'center', 'aux']),
  opening:   Object.freeze(['struct', 'center', 'aux']),
  structure: Object.freeze(['struct', 'beam']),
  site:      Object.freeze([]),
  elevation: Object.freeze([]),
});

// ---- 原始事実2: ヒット除外表 ----
// snap.js:226 resolvePointerTargets の clKindFilter（structureモードは梁芯のみ・それ以外は梁芯以外）
// を「可視種別からの除外」として表現したもの。site/elevation はこの表に現れない＝除外なしだが、
// 可視モード表では両モードとも空集合——現行 snap.js は appMode==='structure' 以外を一律「梁芯以外
// 全部ヒット対象」として扱い、site/elevationを特別扱いしていない。つまり現行 snap.js は「描画され
// ないCLでもヒット対象になりうる」実装になっている（site/elevationで実際に resolvePointerTargets が
// 呼ばれる経路が存在するかどうかは未確認のまま残る）。この食い違いは未裁定——hitTestKinds() は
// あくまで「可視モード表 ∩ (全種別 − ヒット除外表)」を計算するだけで、上記の食い違いを解消しない
// （製品コード移行時に、site/elevationのヒット可否をどちらの表に合わせるか裁定が要る）。
export const HIT_EXCLUDED_KINDS_BY_MODE = Object.freeze({
  structure: Object.freeze(['struct']),
});

// ---- 原始事実3: 同位置共存行列 ----
// transform/centerLineOps.js L491-591 addCenterLineFromDialog の重複判定を種別×種別の行列へ一般化。
// COEXISTENCE[newKind][existingKind]:
//   'forbidden' — 追加を拒否する
//   'extent'    — 同種別のextentが重ならなければ許可する（重なれば拒否／隣接すれば結合連鎖へ）
//   'allowed'   — 無条件で許可する
//   'promote'   — 既存を削除し、新規（通り芯）へ昇格する
export const COEXISTENCE = Object.freeze({
  struct: Object.freeze({ struct: 'forbidden', center: 'promote',  aux: 'allowed',   beam: 'forbidden' }),
  center: Object.freeze({ struct: 'forbidden', center: 'extent',   aux: 'allowed',   beam: 'allowed'   }),
  aux:    Object.freeze({ struct: 'allowed',   center: 'allowed',  aux: 'extent',    beam: 'allowed'   }),
  beam:   Object.freeze({ struct: 'forbidden', center: 'forbidden', aux: 'forbidden', beam: 'extent'   }),
});

// ---- 原始事実4: 直交端部アンカーの特例 ----
// transform/centerLineOps.js 追加extent・transform/centerLineExtend.js 延長短縮: 梁芯の端部候補は
// 通り芯のみに限定する（autoFillSecondaryBeamsが見るgraph.gridXs/Ysは通り芯のみのため、中心線・
// 補助線を候補に含めると直交グリッドに存在しない区画へextentが確定し小梁0本事故になる）。可視性
// （kindsVisibleWith）からは導けない唯一の上書き。両呼び出し元とも orthoAnchorCandidates 経由に
// 移行済み（2026-09-19）——種別ベースで判定するため、旧データ（`{labeled:true, discipline:'arch'}`
// のような labeled と種別が食い違う異常値）による乖離は解消済み。
export const ORTHO_ANCHOR_OVERRIDE = Object.freeze({
  beam: Object.freeze(['struct']),
});

// ---- 原始事実5: 小表 ----
// 壁をextentアンカーにしうる種別（centerLineOps.js aux分岐の perpWalls）。
export const WALL_ANCHOR_KINDS = Object.freeze(['aux']);
// extent境界の解決方式（'none'=通り芯は常にガター~ガター全幅／'ref'=直交CL参照／
// 'overhang'=はね出し量を引いた静的値）。
// aux の 'overhang' は既存の別補助線が同じ直交CLをextentLoRef/HiRefで既に参照している場合
// （anyAuxRefsCL、centerLineOps.js L443-451/469-475）に限り 'ref'（直交CL参照・リアクティブ追従）へ
// 切り替わる——「その位置に初めて補助線を足す」ときだけ静的なはね出し値になる。
// 直交CL・壁のどちらも無い位置では、はね出しではなくポインタ座標をキリ良く丸めた静的値
// （centerLineOps.js L452-456/476-480 の roundToNiceCoord。フリーエンドポイント）になる。
export const EXTENT_ANCHOR_STYLE = Object.freeze({
  struct: 'none', center: 'ref', aux: 'overhang', beam: 'ref',
});
// 端点ルール（isEndpointAt）の対象種別（中心線・梁芯。補助線はフリー端点を持つため対象外）。
export const ENDPOINT_RULE_KINDS = Object.freeze(['center', 'beam']);
// 常に全軸（ガター~ガター）に及ぶ種別（＝端部候補・障害物判定で「extentを持たない」として扱う種別）。
// VERIFIED（renderer/CenterLinesLayer.jsx clExtent L23-31）: 通り芯の `trim:true` はガター～ガター
// ではなく直交labeled CLの端でカットするが、これは描画（画面上の線分の長さ）だけの話——
// coversAlongAxis 等ドメイン側の判定は cl.trim を一切参照せず、通り芯は trim の値に関わらず
// 常に全域扱いのまま（coversAlongAxis が種別 struct で短絡するため extentLo/Hi の値に依らない）。
export const FULL_SPAN_KINDS = Object.freeze(['struct']);
// 入替え方向（'promote'=中心線→通り芯／'demote'=通り芯→中心線）が拒否する既存種別
// （transform/centerLineConvert.js checkPromoteToGridGuards の dupStruct/dupBeam、
//   checkDemoteToCenterGuards の dupCenter＝labeled:falseかつ非梁芯）。
// 既知の乖離（旧データ限定）: dupCenter（centerLineConvert.js L165-166）は `!c.labeled` を見ており、
// `centerLineKind(c)` が center/aux かどうかを直接見ていない——`{labeled:true, discipline:'arch'}` の
// ような旧データがあると、この表（=種別ベース）が拒否を予測しても製品コードは`!c.labeled`がfalseに
// なるため拒否しない（見逃す）方向に割れうる。
export const CONVERT_BLOCKING_KINDS = Object.freeze({
  promote: Object.freeze(['struct', 'beam']),
  demote:  Object.freeze(['center', 'aux']),
});

// ---- 原始事実6: 他階の入替え相手種別（優先順つき） ----
// transform/centerLineFloorSync.js findFloorsWithCounterpartCL: 通り芯は全階共有（project.structGraph）
// のため、同一座標の他階CLはCONVERT_BLOCKING_KINDS（同階内の入替えガード。方向ごとに別集合）とは
// 別の関係になる——通り芯自身（同じ全階共有オブジェクト）は他階の「別の相手」たりえない一方、
// 中心線・補助線・梁芯はいずれも階ローカルの実体のため、他階に同座標のものがあれば入替え後に座標が
// 重複する衝突相手になる（昇格・降格どちらの方向でも同じ集合）。
// 並び順は優先順（1つの階に複数種別が同座標にあるとき、報告に使う1種別を選ぶ規約）も兼ねる——
// transform/centerLineOps.js addCenterLineFromDialog の重複判定が同座標の相手を選ぶ優先順
// （通り芯＞中心線＞補助線＞梁芯。CL_KINDSの並びそのもの）から通り芯を除いたものと同じ
// （中心線・補助線 ＞ 梁芯）。
export const CROSS_FLOOR_COUNTERPART_KINDS = Object.freeze(['center', 'aux', 'beam']);

// ================================================================
// 種別レベルAPI
// ================================================================

/** appMode で描画・操作対象になる種別（原始事実そのもの）。 */
export function kindsVisibleIn(appMode) {
  assertKnownMode(appMode);
  return VISIBLE_KINDS_BY_MODE[appMode];
}

/** appMode でポインタヒット対象になる種別（可視種別からヒット除外分を引く）。 */
export function hitTestKinds(appMode) {
  const visible = kindsVisibleIn(appMode);
  const excluded = HIT_EXCLUDED_KINDS_BY_MODE[appMode] ?? [];
  return visible.filter(k => !excluded.includes(k));
}

/**
 * kind が可視になるいずれかの appMode について、そのモードの可視種別全体を合算した集合
 * （CL_KINDS の順に整列）。kindsVisibleWith(k) = ⋃{VISIBLE_KINDS_BY_MODE[m] : k が m で可視}。
 */
export function kindsVisibleWith(kind) {
  assertKnownKind(kind);
  const set = new Set();
  for (const mode of APP_MODES) {
    const visible = VISIBLE_KINDS_BY_MODE[mode];
    if (visible.includes(kind)) visible.forEach(k => set.add(k));
  }
  return CL_KINDS.filter(k => set.has(k));
}

/** kind の直交端部アンカー候補種別。特例（ORTHO_ANCHOR_OVERRIDE）があればそれ、無ければ kindsVisibleWith(kind)。 */
export function orthoAnchorKinds(kind) {
  assertKnownKind(kind);
  return ORTHO_ANCHOR_OVERRIDE[kind] ?? kindsVisibleWith(kind);
}

/**
 * kind の同方向（同centerLineType）移動障害物候補種別。
 * structural/beamAxisMove.js（beamAxisMoveRange）・snap.js（findBeamAxisMoveSnap）の梁芯移動障害物
 * 判定は本関数（sameDirectionObstacles経由）へ移行済み（種別ベースへ統一。旧「既知の乖離」＝生の
 * `other.labeled` で通り芯扱いを判定していた分は解消。ステップ4、2026-09-19）。
 */
export function sameDirectionObstacleKinds(kind) {
  return kindsVisibleWith(kind);
}

/**
 * kind の移動スナップ吸着先種別（障害物候補とは別の関係）。findCLMoveSnap（moving=struct/center/aux）は
 * 障害物集合（sameDirectionObstacleKinds）と異なり、moving=structでもbeamへは吸着しない——吸着先は
 * 「主体がヒット可能ないずれかのappModeで可視な種別の和」= ⋃{VISIBLE_KINDS_BY_MODE[m] : kind ∈ hitTestKinds(m)}。
 * struct/center/aux はいずれも hitTestKinds経由でfloorplan/finish/openingにしか現れないため、この3種は
 * 同じ結果（['struct','center','aux']）になる——現行 findCLMoveSnap（moving種別を問わずbeamを無条件除外）
 * と一致することを centerLineKindPolicy.test.js で固定している。beam自身は findCLMoveSnap を通らない
 * （呼び出し元 interaction/usePointerInteraction.js の updatePointer が
 * `appMode === 'structure' && centerLineKind(cl) === 'beam'` の場合のみ findBeamAxisMoveSnap を、
 * それ以外（appMode!=='structure'、または appMode==='structure'でもcl種別がbeam以外——後者は現行
 * hitTestKinds('structure')=['beam']のため実際には発生しない組み合わせ）は findCLMoveSnap を呼ぶ）。
 * 導出は VISIBLE_KINDS_BY_MODE に連動する——site/elevation のヒットを有効化するには可視表
 * （VISIBLE_KINDS_BY_MODE.site/elevation、現状どちらも空配列）を非空にする必要があり、その時点で
 * hitTestKinds(site/elevation)も非空になり、moveSnapTargetKindsの吸着先も自動的に広がる（吸着先だけを
 * 個別に拡張することはできない設計）。
 */
export function moveSnapTargetKinds(kind) {
  assertKnownKind(kind);
  const set = new Set();
  for (const mode of APP_MODES) {
    if (hitTestKinds(mode).includes(kind)) {
      VISIBLE_KINDS_BY_MODE[mode].forEach(k => set.add(k));
    }
  }
  return CL_KINDS.filter(k => set.has(k));
}

/** newKind を existingKind と同座標へ追加しようとしたときの帰結（COEXISTENCE行列）。 */
export function coexistenceAt(newKind, existingKind) {
  assertKnownKind(newKind);
  assertKnownKind(existingKind);
  return COEXISTENCE[newKind][existingKind];
}

/** 変換方向（'promote'=中心線→通り芯／'demote'=通り芯→中心線）が拒否する既存種別。 */
export function convertBlockingKinds(direction) {
  if (!Object.prototype.hasOwnProperty.call(CONVERT_BLOCKING_KINDS, direction)) {
    throw new Error(`未知の変換方向: ${direction}`);
  }
  return CONVERT_BLOCKING_KINDS[direction];
}

/** kind と結合しうる種別（現行は同種別のみ）。 */
export function mergeableKinds(kind) {
  assertKnownKind(kind);
  return [kind];
}

/** kind が壁を extent アンカーにしうるか。 */
export function allowsWallAnchor(kind) {
  assertKnownKind(kind);
  return WALL_ANCHOR_KINDS.includes(kind);
}

/** kind の extent 境界解決方式。 */
export function extentAnchorStyle(kind) {
  assertKnownKind(kind);
  return EXTENT_ANCHOR_STYLE[kind];
}

/** kind が端点ルール（isEndpointAt）の対象か。 */
export function hasEndpointRule(kind) {
  assertKnownKind(kind);
  return ENDPOINT_RULE_KINDS.includes(kind);
}

/** kind が常に全軸へ及ぶか。 */
export function spansEntireAxis(kind) {
  assertKnownKind(kind);
  return FULL_SPAN_KINDS.includes(kind);
}

// ================================================================
// CLレベルAPI
// ================================================================

/**
 * cl が coord を軸方向に覆っているか（延長・追加extentの境界判定で使う）。
 * struct、または cl.labeled（旧データ互換——本来 labeled:false のはずの中心線・補助線・梁芯が
 * 旧データで labeled:true のまま残っているケースを、可視性の判定を変えずに全域扱いへ倒す。
 * `|| cl.labeled` は意図的に残す）なら常に true。extent の片側が未解決（null）でも true
 * （はね出し未確定側を障害物にしない）。それ以外は閉区間 [extentLo-tolMm, extentHi+tolMm] に
 * coord が含まれるかで判定する。
 */
export function coversAlongAxis(cl, coord, tolMm = 0) {
  if (centerLineKind(cl) === 'struct' || cl.labeled) return true;
  const { extentLo, extentHi } = cl;
  if (extentLo == null || extentHi == null) return true;
  return coord >= extentLo - tolMm && coord <= extentHi + tolMm;
}

/**
 * 直交端部アンカー候補の判定本体（種別許可＋方向＋範囲被覆）。isOrthoAnchorCandidate（既存CL同士の
 * 単発判定）と orthoAnchorCandidatesForNew（まだグラフに存在しない新規CL用の走査）が共有する唯一の
 * 実装——呼び出し元ごとに再実装すると同じ規約が個別に食い違う（transform/centerLineOps.js・
 * transform/centerLineExtend.js 移行時の教訓。過去に3回、種別条件の無い素の graph.centerLines 走査が
 * 個別に混入して不具合になった）。RADIAL の other は常に false（直交判定が成立しないため）。
 * subject 側の RADIAL 除外は呼び出し元（isOrthoAnchorCandidate／orthoAnchorCandidatesForNew）が担う
 * （前者はsubjectオブジェクトから、後者はcenterLineType引数から判定する——本関数はsubjectオブジェクト
 * 自体を受け取らないため、ここでは判定できない）。
 */
function matchesOrthoAnchor(kind, subjectCenterLineType, other, coord, tolMm) {
  if (other.centerLineType === CenterLineType.RADIAL) return false;
  const subjectIsV = subjectCenterLineType === CenterLineType.VERTICAL;
  const otherIsV   = other.centerLineType === CenterLineType.VERTICAL;
  if (subjectIsV === otherIsV) return false;
  if (!orthoAnchorKinds(kind).includes(centerLineKind(other))) return false;
  return coversAlongAxis(other, coord, tolMm);
}

/**
 * other が subject の直交端部アンカー候補か（追加extent・延長・短縮で使う）。
 * 自身除外＋直交（VERTICAL⇔HORIZONTAL）＋種別（orthoAnchorKinds）＋coversAlongAxis(other, coord, tolMm)
 * を満たすこと。RADIAL は subject・other どちらでも false（直交判定が成立しないため）。
 * @param {{coord?: number, tolMm?: number}} [opts]
 */
export function isOrthoAnchorCandidate(subject, other, { coord = subject.value, tolMm = 0 } = {}) {
  if (subject === other) return false;
  if (subject.centerLineType === CenterLineType.RADIAL) return false;
  return matchesOrthoAnchor(centerLineKind(subject), subject.centerLineType, other, coord, tolMm);
}

/** other が subject と同方向（同 centerLineType）の移動障害物候補か（移動範囲・移動スナップで使う）。 */
export function isSameDirectionObstacle(subject, other) {
  if (subject === other) return false;
  if (subject.centerLineType !== other.centerLineType) return false;
  return sameDirectionObstacleKinds(centerLineKind(subject)).includes(centerLineKind(other));
}

/** other が subject の移動スナップ吸着先候補か（moveSnapTargetKinds ベース。findCLMoveSnap で使う）。 */
export function isMoveSnapTarget(subject, other) {
  if (subject === other) return false;
  if (subject.centerLineType !== other.centerLineType) return false;
  return moveSnapTargetKinds(centerLineKind(subject)).includes(centerLineKind(other));
}

/**
 * other が subject と結合しうるか（transform/centerLineMerge.js findCenterLineMergeMatch の
 * 種別条件と同型: 同 centerLineType・同種別・両者 labeled:false）。
 * 製品コードの findCenterLineMergeMatch（centerLineMerge.js L77-79）は candidate（=other相当）の
 * `!cl.labeled` だけを見ており、segment 側（=subject相当）が labeled:false であることは呼び出し元
 * （centerLineOps.js commitCLMoveOp 等の `if (!cl.labeled) mergeCenterLineChain(...)`）が保証する
 * 前提になっている。isMergeCandidate は特定の呼び出し文脈に依存させたくないため、
 * subject.labeled も対称にチェックする（呼び出し元の保証に頼らない安全側の既定）。
 */
export function isMergeCandidate(subject, other) {
  if (subject === other) return false;
  if (subject.centerLineType !== other.centerLineType) return false;
  if (subject.labeled || other.labeled) return false;
  return mergeableKinds(centerLineKind(subject)).includes(centerLineKind(other));
}

/**
 * まだグラフに存在しない新規CL（AddCLDialog確定前など）の直交端部アンカー候補を graph.centerLines
 * から列挙する走査API。subject が実CLオブジェクトとして存在しない場面（追加ダイアログ確定前）向け——
 * isOrthoAnchorCandidate／orthoAnchorCandidates は既存CLオブジェクトの centerLineType/value に依存
 * するため、生成前に候補を絞りたい呼び出し元がダック型の仮オブジェクトを作ると、value の代わりに
 * coord を渡し忘れても例外にならず非labeled候補だけが静かに脱落する事故になりうる（QA実測:
 * 該当箇所で2件あるべき候補が1件になった）。kind・centerLineType・coord を必須の明示引数にすることで
 * この種の事故を型（呼び出し時の引数不足）で防ぐ。
 * graph は `{ centerLines: Array }` を持つオブジェクトとして引数で受けるだけで、PlanGraph自体は
 * import しない（import ゼロに近い規約を維持し、node:test から単体 import 可能に保つ）。
 * @param {{centerLines: Array}} graph
 * @param {{kind: string, centerLineType: string, coord: number, tolMm?: number, exclude?: object|null}} opts
 * @returns {Array} matchesOrthoAnchor(kind, centerLineType, other, coord, tolMm) を満たし、exclude
 *   自身は除く CenterLine の配列
 */
export function orthoAnchorCandidatesForNew(graph, { kind, centerLineType, coord, tolMm = 0, exclude = null }) {
  assertKnownKind(kind);
  if (typeof coord !== 'number' || Number.isNaN(coord)) {
    throw new Error(`orthoAnchorCandidatesForNew: coordは数値である必要があります（実際: ${coord}）`);
  }
  if (centerLineType === CenterLineType.RADIAL) return [];
  return graph.centerLines.filter(other =>
    other !== exclude && matchesOrthoAnchor(kind, centerLineType, other, coord, tolMm));
}

/**
 * subject の直交端部アンカー候補となる CenterLine を graph.centerLines から列挙する
 * （走査API。過去の不具合（追加→移動→延長の3回に分けて発覚した「非表示の梁芯が障害物になる」）は
 * いずれも「誤った種別条件」ではなく「種別条件の無い素の graph.centerLines 走査」が原因だった——
 * 呼び出し元がこの関数経由で相手を選ぶことで、同じ規約の再実装が個別に食い違うのを防ぐ）。
 * subject が既存CLオブジェクト（centerLineType/valueを持つ）である場面専用——orthoAnchorCandidatesForNew
 * へ委譲する薄いラッパー（判定の本体は matchesOrthoAnchor に一本化してある）。
 * @param {{centerLines: Array}} graph
 * @param {object} subject
 * @param {{coord?: number, tolMm?: number}} [opts]
 * @returns {Array} isOrthoAnchorCandidate(subject, other, opts) を満たす CenterLine の配列
 */
export function orthoAnchorCandidates(graph, subject, opts = {}) {
  return orthoAnchorCandidatesForNew(graph, {
    kind:           centerLineKind(subject),
    centerLineType: subject.centerLineType,
    coord:          opts.coord ?? subject.value,
    tolMm:          opts.tolMm ?? 0,
    exclude:        subject,
  });
}

/**
 * subject の同方向移動障害物候補となる CenterLine を graph.centerLines から列挙する走査API
 * （移動範囲・移動スナップで使う。orthoAnchorCandidates と同じ理由——過去に3回、種別条件の無い素の
 * graph.centerLines 走査が非表示の梁芯を障害物へ混入させる不具合の原因になった——で一本化する）。
 * @param {{centerLines: Array}} graph
 * @param {object} subject
 * @returns {Array} isSameDirectionObstacle(subject, other) を満たす CenterLine の配列
 */
export function sameDirectionObstacles(graph, subject) {
  return graph.centerLines.filter(other => isSameDirectionObstacle(subject, other));
}

/**
 * value（座標）・centerLineType（方向）が一致するCLを graph.centerLines から列挙する走査API
 * （同座標の重複判定・入替えガード・他階の相手探索で使う。orthoAnchorCandidates／sameDirectionObstacles
 * と同じ理由——過去に3回、種別条件の無い素の graph.centerLines 走査が不具合の原因になった——で
 * 一本化する）。種別（kind）による絞り込みは行わない——呼び出し側が coexistenceAt／
 * convertBlockingKinds／CROSS_FLOOR_COUNTERPART_KINDS の結果で判定する（本APIは「同座標の候補を
 * 集める」役割のみを持つ）。
 * exclude は同一グラフ内の既存CLを自分自身として除外する用途（オブジェクト参照比較）——異なる
 * グラフインスタンス間（例: 他階を peek した一時グラフ）の同一id除外にはならない。呼び出し側が
 * id で別途除外すること（transform/centerLineFloorSync.js findFloorsWithCounterpartCL 参照）。
 * @param {{centerLines: Array}} graph
 * @param {{centerLineType: string, value: number, tolMm?: number, exclude?: object|null}} opts
 * @returns {Array}
 */
export function sameCoordCounterparts(graph, { centerLineType, value, tolMm = CL_OVERLAP_TOL_MM, exclude = null }) {
  if (centerLineType == null) {
    throw new Error(`sameCoordCounterparts: centerLineTypeは必須です（実際: ${centerLineType}）`);
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`sameCoordCounterparts: valueは数値である必要があります（実際: ${value}）`);
  }
  return graph.centerLines.filter(other =>
    other !== exclude && other.centerLineType === centerLineType && Math.abs(other.value - value) < tolMm);
}

/** cl が appMode で描画対象か（可視モード表そのもの）。 */
export function isRenderTarget(cl, appMode) {
  return kindsVisibleIn(appMode).includes(centerLineKind(cl));
}

/** cl が appMode でポインタヒット対象か。 */
export function isHitTestTarget(cl, appMode) {
  return hitTestKinds(appMode).includes(centerLineKind(cl));
}

/**
 * target が既存の補助線から extentLoRef/HiRef で参照されているか（走査API。追加extent・延長で
 * 「はね出し（静的値）」か「直交CL参照（リアクティブ追従）」かの分岐に使う——他の補助線が同じ
 * target を既に参照していれば ref 化する。transform/centerLineOps.js の anyAuxRefsCL・
 * transform/centerLineExtend.js の同名関数を統合したもの。
 * 素の `ex.lineType==='dashed' && !ex.labeled` を見ている（centerLineKind(ex)==='aux' そのものでは
 * ない）——既知の乖離（旧データ限定）: centerLineKind は lineType==='dashed' のみで aux と判定するため
 * `{lineType:'dashed', labeled:true}` のような旧データがあると centerLineKind ベースでは aux 扱いに
 * なるが、本関数（labeled:false も要求）は候補にしない。通常経路（AddCLDialogのaux分岐）で作られる
 * 補助線は必ず labeled:false のため実害は無い。種別ベースへ統一するかは製品コード移行時の裁定が要る
 * （本関数は挙動を変えず、既存2箇所の実装をそのまま集約しただけ）。
 * @param {{centerLines: Array}} graph
 * @param {object} target
 * @returns {boolean}
 */
export function isReferencedByAux(graph, target) {
  return graph.centerLines.some(ex =>
    ex.lineType === 'dashed' && !ex.labeled &&
    (ex.extentLoRef?.clId === target.id || ex.extentHiRef?.clId === target.id)
  );
}
