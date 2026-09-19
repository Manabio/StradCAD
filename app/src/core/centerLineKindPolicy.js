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
 * 本ファイル導入の時点では製品コードから未接続——特性テスト（centerLineKindPolicy.test.js）が
 * 既存4地点（centerLineOps.js 追加extent・followerGraph.js 移動範囲・beamAxisMove.js・
 * centerLineConvert.js 入替えガード）の現行動作と導出結果が一致することを固定するのみ。
 * 製品コード側の呼び出し元をこの表へ移行する作業は本ファイルの範囲外（未着手）。
 *
 * 既知の乖離（旧データ限定）: 上記4地点のうち3箇所は、種別（centerLineKind）ではなく生の
 * `labeled` フラグで「通り芯扱いするか」を判定している
 * （transform/centerLineOps.js の梁芯extent候補フィルタ`return cl.labeled`、
 *   structural/beamAxisMove.js の梁芯移動障害物判定`other.labeled || centerLineKind(other)==='beam'`、
 *   transform/centerLineConvert.js の降格重複判定`!c.labeled && centerLineKind(c)!=='beam'`）。
 * 通常経路（AddCLDialog等）で作られるCLは種別と labeled が必ず一致する
 * （通り芯のみ labeled:true）ため実害は無いが、`{labeled:true, discipline:'arch'}` のような
 * 旧データ・異常値が存在すると、本モジュールの種別ベースの予測（orthoAnchorKinds等）と
 * 製品コードの実際の結果が割れる。本モジュールの挙動は変えず、この割れをピン留めテストで
 * 固定してある（centerLineKindPolicy.test.js内、「既知の乖離」と付記したテストを参照）。
 * 種別ベースへ統一するか labeled ベースを維持するかは製品コード移行時に裁定が要る。
 *
 * import ゼロに近い規約（extractedModuleImportInvariant）: ./centerLine.js（centerLineKind）と
 * ./constants.js（CenterLineType）のみに依存する。store.js/snap.js/.jsx/core.js バレル/error.js は
 * 静的 import しない——node:test から本ファイルを単体 import 可能に保つため。
 */
import { centerLineKind } from './centerLine.js';
import { CenterLineType } from './constants.js';

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
// transform/centerLineOps.js L368-372: 梁芯の端部候補は通り芯（labeled）のみに限定する
// （autoFillSecondaryBeamsが見るgraph.gridXs/Ysは通り芯のみのため、中心線・補助線を候補に含めると
// 直交グリッドに存在しない区画へextentが確定し小梁0本事故になる）。可視性（kindsVisibleWith）からは
// 導けない唯一の上書き。
// 既知の乖離（旧データ限定）: centerLineOps.js L372 の実装は `cl.labeled` を見ており、
// `centerLineKind(cl)==='struct'` を見ていない——通常経路のCLは種別struct⇔labeled:trueが必ず一致する
// ため実害は無いが、`{labeled:true, discipline:'arch'}`（centerLineKindは'center'）のような旧データが
// あると、この表（=種別ベース）の予測より製品コードの実際の選択（=labeledベース）が広くなりうる
// （centerLineKindPolicy.test.js の「既知の乖離」テストでピン留め済み）。
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
 * 既知の乖離（旧データ限定）: structural/beamAxisMove.js L25 の梁芯移動障害物判定は
 * `other.labeled || centerLineKind(other)==='beam'` で、前者（通り芯を指すはずの条件）が
 * `centerLineKind(other)==='struct'` ではなく生の `other.labeled` を見ている——
 * `{labeled:true, discipline:'arch'}` のような旧データがあると、この関数（=種別ベース）の予測
 * （sameDirectionObstacleKinds('beam')=['struct','beam']）より製品コードの実際の障害物判定が
 * 広くなりうる。
 */
export function sameDirectionObstacleKinds(kind) {
  return kindsVisibleWith(kind);
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
 * other が subject の直交端部アンカー候補か（追加extent・延長・短縮で使う）。
 * 自身除外＋直交（VERTICAL⇔HORIZONTAL）＋種別（orthoAnchorKinds）＋coversAlongAxis(other, coord, tolMm)
 * を満たすこと。RADIAL は subject・other どちらでも false（直交判定が成立しないため）。
 * @param {{coord?: number, tolMm?: number}} [opts]
 */
export function isOrthoAnchorCandidate(subject, other, { coord = subject.value, tolMm = 0 } = {}) {
  if (subject === other) return false;
  if (subject.centerLineType === CenterLineType.RADIAL) return false;
  if (other.centerLineType === CenterLineType.RADIAL) return false;
  const subjectIsV = subject.centerLineType === CenterLineType.VERTICAL;
  const otherIsV   = other.centerLineType === CenterLineType.VERTICAL;
  if (subjectIsV === otherIsV) return false;
  if (!orthoAnchorKinds(centerLineKind(subject)).includes(centerLineKind(other))) return false;
  return coversAlongAxis(other, coord, tolMm);
}

/** other が subject と同方向（同 centerLineType）の移動障害物候補か（移動範囲・移動スナップで使う）。 */
export function isSameDirectionObstacle(subject, other) {
  if (subject === other) return false;
  if (subject.centerLineType !== other.centerLineType) return false;
  return sameDirectionObstacleKinds(centerLineKind(subject)).includes(centerLineKind(other));
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
 * subject の直交端部アンカー候補となる CenterLine を graph.centerLines から列挙する
 * （走査API。過去の不具合（追加→移動→延長の3回に分けて発覚した「非表示の梁芯が障害物になる」）は
 * いずれも「誤った種別条件」ではなく「種別条件の無い素の graph.centerLines 走査」が原因だった——
 * 呼び出し元がこの関数経由で相手を選ぶことで、同じ規約の再実装が個別に食い違うのを防ぐ）。
 * graph は `{ centerLines: Array }` を持つオブジェクトとして引数で受けるだけで、PlanGraph自体は
 * import しない（import ゼロに近い規約を維持し、node:test から単体 import 可能に保つ）。
 * @param {{centerLines: Array}} graph
 * @param {object} subject
 * @param {{coord?: number, tolMm?: number}} [opts]
 * @returns {Array} isOrthoAnchorCandidate(subject, other, opts) を満たす CenterLine の配列
 */
export function orthoAnchorCandidates(graph, subject, opts = {}) {
  return graph.centerLines.filter(other => isOrthoAnchorCandidate(subject, other, opts));
}

/** cl が appMode で描画対象か（可視モード表そのもの）。 */
export function isRenderTarget(cl, appMode) {
  return kindsVisibleIn(appMode).includes(centerLineKind(cl));
}

/** cl が appMode でポインタヒット対象か。 */
export function isHitTestTarget(cl, appMode) {
  return hitTestKinds(appMode).includes(centerLineKind(cl));
}
