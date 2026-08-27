/**
 * 構造モードのドメインモデル（柱・梁・基礎・柱脚・耐力壁・スラブ・貫通孔）。
 *
 * core.js から分離。CL を「座標の源泉」とする導出方式は core の Shape 系と共通だが、
 * これらは shapeMap・ngraph に参加せず PlanGraph の専用 Map で管理される。
 * 依存は constants / sectionCatalog / _internal のみ（core.js には依存しない＝循環なし）。
 * PlanGraph（core.js）が材種別→クラス解決表とキー生成関数を import して使う。
 */
import { makeObservable, observable, computed, action } from 'mobx';
import { StructuralMaterialType } from './constants.js';
import { coordLo as _coordLo, coordHi as _coordHi } from './_internal.js';
import { findSectionEntry, diaphragmProjection } from '../structural/sectionCatalog.js';

// ---- module-private helpers（構造部材の平面位置導出。core/_internal とは別に構造専用） ----

// 通り芯の柱芯オフセット（columnAxisOffsets。ラーメン系のみ非0、未登録キー=0）。
function _axisOffset(planGraph, clId) {
  return planGraph?.columnAxisOffsets.get(clId) ?? 0;
}

// 柱・基礎・柱脚の平面位置 = 通り芯 effectiveValue + 柱芯オフセット + 個別偏心量。
// StructuralColumn / StructuralFooting が共通で使う（eccentricity は {x,y}）。
function _gridX(entity) {
  return entity.verticalCL.effectiveValue
       + _axisOffset(entity._planGraph, entity.verticalCL.id)
       + entity.eccentricity.x;
}
function _gridY(entity) {
  return entity.horizontalCL.effectiveValue
       + _axisOffset(entity._planGraph, entity.horizontalCL.id)
       + entity.eccentricity.y;
}

// トポロジー自動補完の除外集合（PlanGraph.excludedColumnSlots/excludedBeamSlots）で使うキー生成。
// structural/structuralAutoFill.js からも同じキー形式で参照するため export する。
export function columnSlotKey(verticalCL, horizontalCL) {
  return `${verticalCL.id}:${horizontalCL.id}`;
}
// 梁・耐力壁のスパンキー。始端・終端の順序に依存しないよう CL id を昇順に正規化する。
export function spanKey(axisCL, clA, clB) {
  return `${axisCL.id}:${[clA.id, clB.id].sort().join(':')}`;
}

class StructuralEntity {
  constructor(id, materialType, sectionDefId, props = {}) {
    this.id           = id;
    this.materialType = materialType; // StructuralMaterialType の値
    this.sectionDefId = sectionDefId; // 断面形状マスターへの参照ID（マスタ本体は次フェーズ）
    this.memberNo     = null; // 部材番号（材寸グループ採番から決定的に自動算定、手動編集も可。structural/memberNumbering.js）
    // 明示グループID（"C#1" のように記号+"#"+連番。分割・統合・手動採番の明示操作でのみ設定される）。
    // null＝材寸署名（memberCatalog.memberSignature）から自動導出（既定の集約）。
    // structural/memberGroups.js（台帳との conform）・memberNumbering.js（採番）が参照する。
    // 手動タグは台帳の grp.no:<numberGroupId> に一本化（部材単位ロックは廃止。同一グループ内の
    // 番号食い違いを作れてしまうため。旧 memberNoLocked は Phase D で廃止済み）。
    this.numberGroupId = props.numberGroupId ?? null;
    // 寸法の3状態（Tri-state）。'auto'=自動算定値そのまま | 'locked'=手動固定（自動算定で上書きしない）
    // | 'calculated'=構造計算のチェックを通過（現状は暫定の手動トグル。本物の計算ロジックは次フェーズ）。
    this.dimensionStatus = props.dimensionStatus ?? 'auto';
    makeObservable(this, {
      sectionDefId:     observable,
      memberNo:         observable,
      numberGroupId:    observable,
      dimensionStatus:  observable,
      setMemberNo:      action,
      setNumberGroupId: action,
      setDimensionStatus: action,
      setField:         action,
    });
  }
  setMemberNo(no) { this.memberNo = no; }
  setNumberGroupId(gid) { this.numberGroupId = gid; }
  setDimensionStatus(status) { this.dimensionStatus = status; }
  /** 構造リストタブのフォームから単一フィールドを更新する汎用セッター（StructuralInfo.setField と同型）。 */
  setField(key, value) { this[key] = value; }
}

// ----------------------------------------------------------------
// 柱（StructuralColumn・抽象） — Intersection と同じ「垂直CL × 水平CL」導出方式
//
//   x = verticalCL.effectiveValue   + eccentricity.x
//   y = horizontalCL.effectiveValue + eccentricity.y
//
// eccentricity は平面 2 軸（柱は点なので XY どちらの方向にもズレ得るため、
// Wall.axisOffset のようなスカラーでは表現できない）。
// ----------------------------------------------------------------
export class StructuralColumn extends StructuralEntity {
  constructor(id, materialType, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.verticalCL   = verticalCL;   // 柱が立つ交点の垂直CL（X系）
    this.horizontalCL = horizontalCL; // 柱が立つ交点の水平CL（Y系）
    this.eccentricity = props.eccentricity ?? { x: 0, y: 0 }; // 柱芯からの個別偏心量(mm)
    this.rotation     = props.rotation ?? 0; // 平面上の配置角度（強軸・弱軸の向き）
    // 杭は柱と同一クラス（A-1は断面の縦横比だけで柱状/箱状を区別、データ構造は同一という方針）。
    // role='foundation' で杭を表現する（新規サブクラスは作らない）。
    this.role         = props.role         ?? 'standard'; // 'standard' | 'foundation'（杭）
    this.topLevel     = props.topLevel     ?? 0;    // 上端レベル(mm、floorDatum基準)
    this.bottomLevel  = props.bottomLevel  ?? null; // 下端レベル(mm)。杭は下端=杭先端深度として使用
    this.pileType     = props.pileType     ?? '既製杭'; // role==='foundation'のときのみ意味を持つ
    this.pileDiameter = props.pileDiameter ?? null;     // 杭径(mm)
    // 柱が支える概算負担床面積から算定した柱幅（mm）。柱脚サイズ算定の入力値。
    // sectionDefId（カタログ断面）には連動しない参考値（structural/memberSizing.js）。
    this.tributaryWidth = props.tributaryWidth ?? null;
    this._planGraph   = null; // PlanGraph が addColumn/convertColumnMaterial 時にセット（columnAxisOffsets参照用）
    makeObservable(this, {
      verticalCL:   observable.ref,
      horizontalCL: observable.ref,
      eccentricity: observable,
      rotation:     observable,
      role:         observable,
      topLevel:     observable,
      bottomLevel:  observable,
      pileType:     observable,
      pileDiameter: observable,
      tributaryWidth: observable,
      x: computed,
      y: computed,
    });
  }
  // x/y = 通り芯 + 柱芯オフセット（columnAxisOffsets。ラーメン系のみ非0） + 個別偏心量
  get x() { return _gridX(this); }
  get y() { return _gridY(this); }
}

export class WoodColumn extends StructuralColumn {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, StructuralMaterialType.WOOD, sectionDefId, verticalCL, horizontalCL, props);
    this.columnType  = props.columnType  ?? '管柱'; // '管柱' | '通し柱' | '隅柱'
    this.woodSpecies = props.woodSpecies ?? '杉';
    makeObservable(this, { columnType: observable, woodSpecies: observable });
  }
}

export class SteelColumn extends StructuralColumn {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, StructuralMaterialType.STEEL, sectionDefId, verticalCL, horizontalCL, props);
    this.basePlateDefId = props.basePlateDefId ?? 'BP-DEFAULT';
    makeObservable(this, { basePlateDefId: observable });
  }
}

export class RcColumn extends StructuralColumn {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, StructuralMaterialType.RC, sectionDefId, verticalCL, horizontalCL, props);
    this.mainBars = props.mainBars ?? { count: 4, size: 'D19' };
    this.hoopBars = props.hoopBars ?? { size: 'D10', pitch: 100 };
    makeObservable(this, { mainBars: observable, hoopBars: observable });
  }
}

// 小梁（role:'secondary'）の端部クリアランス(mm)。host（取りつく大梁）の縁からこの分だけ離して止める。
// ピン接合（jointType:'PIN'）に指定した鉄骨の大梁も同じ値で母材（柱・大梁）の面から離す。
export const SECONDARY_BEAM_CLEARANCE_MM = 50;

// 剛接合（鉄骨・水平方向）の継手位置(mm)。構造芯から梁の内側へこの距離の位置で母材を切断し、
// プレートで補強する（実務の一般的な仕口位置）。切断幅そのもの（10mm）は描画には使わない
// ——伏図では継手を線記号で表すため、詳細描画の2本線の間隔は描画側の定数で持つ
// （renderer/StructuralLayer.jsx RIGID_JOINT_DETAIL_GAP_MM）。
export const RIGID_JOINT_OFFSET_MM = 900;

// host大梁の跨ぎ判定の座標許容誤差(mm)。生成条件（structuralAutoFill.autoFillSecondaryBeams）と
// 端部クリアランス（StructuralBeam.spanForHostBeams）が同じ値を共有する。
export const HOST_BEAM_MATCH_TOL_MM = 0.5;

// 直交CL位置(perpCLId)に、coordを跨ぐ大梁(role:'primary')があれば返す（無ければnull）。
// 小梁の生成条件（structuralAutoFill.autoFillSecondaryBeams）と描画時の端部クリアランス
// （StructuralBeam._hostEndCenterAndHalfWidth）が二重実装せず同じ関数を使うための単一実装。
// 座標基準は value（生値）ではなく effectiveValue 系（pendingDelta込み）に統一する——生値で判定すると
// 通り芯ドラッグ中に描画側だけhostを見失い、小梁端の座標がジャンプする不具合になる（再発防止）。
export function findHostPrimaryBeam(beams, perpCLId, hostIsVertical, coord, tolerance = HOST_BEAM_MATCH_TOL_MM) {
  return beams.find(h =>
    h.role === 'primary' && h.isVertical === hostIsVertical && h.axisCL.id === perpCLId &&
    Math.min(h.clStart.effectiveValue, h.clEnd.effectiveValue) - tolerance <= coord &&
    coord <= Math.max(h.clStart.effectiveValue, h.clEnd.effectiveValue) + tolerance) ?? null;
}

// ----------------------------------------------------------------
// 梁（StructuralBeam・抽象） — Wall と同じ「軸CL + 始端CL + 終端CL」方式
//
//   axisValue = axisCL.effectiveValue + eccentricity
//   coord1    = clStart.effectiveValue
//   coord2    = clEnd.effectiveValue
//
// eccentricity は軸直交方向 1 軸のみのスカラー（Wall.axisOffset と同じ発想。
// 梁の長さ方向は clStart/clEnd で決まるため、もう1自由度は存在しない）。
// ----------------------------------------------------------------
export class StructuralBeam extends StructuralEntity {
  constructor(id, materialType, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.axisCL         = axisCL;     // 梁が沿う通り芯
    this.isVertical      = isVertical;
    this.clStart         = clStart;   // 始端の直交CL
    this.clEnd           = clEnd;     // 終端の直交CL
    this.eccentricity    = props.eccentricity ?? 0; // 柱芯からの個別偏心量(mm。材芯=柱芯+eccentricity)
    // 柱外面と梁縁のギャップ(mm。0=面一)。eccentricity の自動算出の基準（ラベル毎に共有する指定値）。
    // eccentricity は派生値: s*((梁幅-既定柱幅)/2 + faceGap)。s=外周側符号。structuralAutoFill.autoBeamEccentricity 参照。
    this.faceGap         = props.faceGap ?? 0;
    this.jointCondition  = props.jointCondition ?? { start: 'RIGID', end: 'RIGID' }; // 剛接合=ラーメン既定
    // 小梁・基礎梁・軒桁・母屋・垂木・踊り場受け梁はサブクラスを増やさず role + 既定値の組み合わせで表現する。
    this.role             = props.role             ?? 'primary'; // primary/secondary/foundation/eaves/roof/landing
    // 接合方法（'RIGID'=剛接合 / 'PIN'=ピン接合）。鉄骨の梁でのみ意味を持つ（isPinJoint/hasRigidJoint 参照）。
    // 既定は剛接合。ただし梁芯CL追加で自動生成される小梁（role:'secondary'）だけはピン接合を初期値にする
    // ——生成側（structuralAutoFill/beamAxisMove）ではなくここで既定を決めることで、生成経路が増えても
    // 初期値が食い違わない。旧データ（jointType未保存）もこの既定に落ちるため移行処理を持たない。
    this.jointType        = props.jointType ?? (this.role === 'secondary' ? 'PIN' : 'RIGID');
    // 梁天端レベル（floorDatum=FL基準・上が正。WP-B3で意味を確定。structural-model.md参照）。
    this.levelOffset      = props.levelOffset      ?? 0;
    this.startLevelOffset = props.startLevelOffset ?? 0; // levelOffsetからの始端追加オフセット（屋根部材の勾配用）
    this.endLevelOffset   = props.endLevelOffset   ?? 0; // levelOffsetからの終端追加オフセット
    // 梁幅b・梁成D（mm）。基礎梁(role:'foundation')のみ自動算定対象（structural/memberSizing.js）。
    // sectionDefId（カタログ断面）には連動しない参考値（columnのtributaryWidthと同じ位置づけ）。
    this.beamWidth = props.beamWidth ?? null;
    this.beamDepth = props.beamDepth ?? null;
    // 木造基礎梁（role:'foundation'）の断面詳細寸法（問題.md）。基礎種別ごとのベース／べた基礎の合成断面を
    // 編集可能フィールドとして保持する。非基礎梁は null（断面図がデフォルト値で補完するため未編集分は持たない）。
    //   embedDepth    : 基礎梁の地中部（GL下。立ち上がり = beamDepth − embedDepth）
    //   baseWidth/baseThickness/baseOverhang : ベース幅・厚・屋外側張り出し（なし／土間コン）
    //   matThickness/matTopAboveGL           : べた基礎の厚・天端（GL+）
    this.foundationSection = props.foundationSection ?? null;
    this._planGraph        = null; // PlanGraph が addBeam/convertBeamMaterial 時にセット（columnAxisOffsets参照用）
    makeObservable(this, {
      clStart:          observable.ref,
      clEnd:            observable.ref,
      eccentricity:     observable,
      faceGap:          observable,
      jointCondition:   observable,
      jointType:        observable,
      role:             observable,
      levelOffset:      observable,
      startLevelOffset: observable,
      endLevelOffset:   observable,
      beamWidth:        observable,
      beamDepth:        observable,
      foundationSection: observable,
      axisValue: computed,
      coord1:    computed,
      coord2:    computed,
      sectionWidth: computed,
      isPinJoint:    computed,
      hasRigidJoint: computed,
    });
  }
  // ピン接合として描くか。鉄骨は jointType が権威、木造・RCは従来どおり role（小梁のみピン）で決まる
  // ——木造梁は jointCondition/jointType の既定がピン寄りで、鉄骨以外まで jointType を見ると
  // 既存の木造大梁の端部処理まで変わってしまうため、材種で権威を分ける。
  get isPinJoint() {
    return this.materialType === StructuralMaterialType.STEEL
      ? this.jointType === 'PIN'
      : this.role === 'secondary';
  }
  // 剛接合の継手記号を描く対象か（鉄骨の梁のみ。用語「接合＝鉄骨の構造部材同士が取り合う場所」に従う）。
  get hasRigidJoint() {
    return this.materialType === StructuralMaterialType.STEEL && this.jointType === 'RIGID';
  }
  // axisValue = 通り芯 + 柱芯オフセット（columnAxisOffsets。ラーメン系のみ非0） + 個別偏心量
  get axisValue() {
    return this.axisCL.effectiveValue + _axisOffset(this._planGraph, this.axisCL.id) + this.eccentricity;
  }
  // 伏図見付き幅(mm)＝梁幅b（structural/structuralAutoFill.js の梁偏芯算定・描画 beamRenderWidth と同一基準）。
  // RCはbeamWidth（算定値）、鋼材はカタログ断面の幅b（軒桁等で算定beamWidthが立っていてもカタログ優先）。
  get sectionWidth() {
    if (this.materialType === StructuralMaterialType.RC) return this.beamWidth ?? 300;
    return findSectionEntry(this.sectionDefId)?.width ?? 300;
  }
  // 端部の直交CLに立つ柱を columns から探す（垂直梁はaxisCLが垂直CL・perpCLが水平CL、水平梁はその逆）。
  // columns は「その伏図に表示される柱集合」——構造モードでは1つ下の階の柱。梁はその表示中の柱の断面手前で
  // 止めるため、自階graph(_planGraph)固定ではなく描画対象の柱集合を外から受け取る（spanForColumns 経由）。
  _columnAtEnd(perpCL, columns) {
    const verticalCL   = this.isVertical ? this.axisCL : perpCL;
    const horizontalCL  = this.isVertical ? perpCL : this.axisCL;
    return columns.find(
      c => c.verticalCL.id === verticalCL.id && c.horizontalCL.id === horizontalCL.id
    ) ?? null;
  }
  // 端部の中心座標と、柱断面の梁方向半幅（柱が無い端部は中心=CL位置+柱芯オフセット、半幅=0）。
  // 柱がある端部は柱の実位置（個別偏心込み）を中心とし、断面寸法を柱の回転角で投影した半幅だけ手前で止める。
  _endCenterAndHalfWidth(perpCL, columns, diaphragm = false) {
    const column = this._columnAtEnd(perpCL, columns);
    if (!column) {
      return { center: perpCL.effectiveValue + _axisOffset(this._planGraph, perpCL.id), half: 0 };
    }
    const center = this.isVertical ? column.y : column.x;
    const sec = findSectionEntry(column.sectionDefId);
    if (!sec) return { center, half: 0 };
    const rad = (column.rotation ?? 0) * Math.PI / 180;
    // 詳細描画では梁をダイヤフラム（断面+e の四角）まで止める。e は鋼管のみ非0。
    const e = diaphragm ? diaphragmProjection(sec) : 0;
    const w = sec.width + 2 * e, h = sec.height + 2 * e;
    const extent = this.isVertical
      ? Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
      : Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
    return { center, half: extent / 2 };
  }
  // 端部の直交CLに、この小梁を跨いで支持する大梁(role:'primary')があれば、その縁+クリアランスで止める
  // 座標と半幅を返す（無ければ柱と同じ規約でCL位置=center・半幅0）。host判定は findHostPrimaryBeam に
  // 委譲する（structuralAutoFill.autoFillSecondaryBeams と同一実装・同一tolerance・同一座標基準）。
  _hostEndCenterAndHalfWidth(perpCL, beams, clearance) {
    const host = findHostPrimaryBeam(beams, perpCL.id, !this.isVertical, this.axisValue);
    if (!host) return { center: perpCL.effectiveValue + _axisOffset(this._planGraph, perpCL.id), half: 0 };
    return { center: host.axisValue, half: host.sectionWidth / 2 + clearance };
  }
  // 小梁（role:'secondary'）専用: 両端を「取りつく大梁の縁+クリアランス」で止めた始終端座標を返す
  // （host無しの端はCL位置まで＝柱と同じ規約）。beams は自階graphの梁集合（_planGraph.beams）。
  spanForHostBeams(beams, clearance = SECONDARY_BEAM_CLEARANCE_MM) {
    const a = this._hostEndCenterAndHalfWidth(this.clStart, beams, clearance);
    const b = this._hostEndCenterAndHalfWidth(this.clEnd, beams, clearance);
    const dir = Math.sign(b.center - a.center) || 1;
    return { coord1: a.center + dir * a.half, coord2: b.center - dir * b.half };
  }
  // 表示する柱集合 columns に対し、両端を柱断面手前で止めた始終端座標を返す。
  // 伏図で別階の柱を表示する場合はレンダラが表示中の柱集合を渡す（StructuralLayer.jsx）。
  // opts.diaphragm=true（詳細描画）なら鋼管柱はダイヤフラム端で止める（梁はダイヤフラムまで）。
  // 小梁（role:'secondary'）は柱ではなく取りつく大梁の縁で止まるため、渡された columns を使わず
  // spanForHostBeams に委譲する（coord1/coord2 getter・StructuralLayer.jsx の両方が自動でトリム後座標になる）。
  // ピン接合（isPinJoint）に指定された鉄骨の大梁も「母材から離して終える」——ただし母材は柱なので
  // spanForHostBeams ではなく柱基準のまま、両端に同じクリアランスを足して手前で止める
  // （小梁の host 基準経路をそのまま流用すると、host大梁の無い端がCL位置まで伸びて柱を突き抜ける）。
  spanForColumns(columns, { diaphragm = false } = {}) {
    if (this.role === 'secondary' && this.isPinJoint) return this.spanForHostBeams(this._planGraph?.beams ?? []);
    const clearance = this.isPinJoint ? SECONDARY_BEAM_CLEARANCE_MM : 0;
    const a = this._endCenterAndHalfWidth(this.clStart, columns, diaphragm);
    const b = this._endCenterAndHalfWidth(this.clEnd, columns, diaphragm);
    const dir = Math.sign(b.center - a.center) || 1;
    return { coord1: a.center + dir * (a.half + clearance), coord2: b.center - dir * (b.half + clearance) };
  }
  // 端部の少なくとも一方が柱に取りつくか（＝接合方法を選べる梁か）。梁にしか取りつかない梁（小梁）は
  // 構造リストの接合2択をグレー化する判定に使う（ユーザー指示: 柱に接合する梁のみ選択可）。
  // columns 省略時は自階graphの柱。構造モードの伏図は1つ下の階の柱を表示するため、UI側は
  // 表示中の柱集合（composition解決）を渡すこと。
  joinsColumn(columns = this._planGraph?.columns ?? []) {
    return !!this._columnAtEnd(this.clStart, columns) || !!this._columnAtEnd(this.clEnd, columns);
  }
  // 剛接合の継手位置（両端の構造芯から RIGID_JOINT_OFFSET_MM だけ梁の内側）。along軸の座標配列を返す。
  // 短スパンでは何も返さない: 2箇所の継手が入れ替わる（始端側の継手が終端側を追い越す）スパンでは
  // 記号として意味を成さないため両方落とす。追い越さない場合も、実際に描かれる区間
  // （spanForColumns）の外へ出るものは個別に除外する。
  rigidJointCoords(columns, { diaphragm = false } = {}) {
    if (!this.hasRigidJoint) return [];
    const a = this._endCenterAndHalfWidth(this.clStart, columns, diaphragm);
    const b = this._endCenterAndHalfWidth(this.clEnd, columns, diaphragm);
    const dir = Math.sign(b.center - a.center) || 1;
    const startJoint = a.center + dir * RIGID_JOINT_OFFSET_MM;
    const endJoint   = b.center - dir * RIGID_JOINT_OFFSET_MM;
    if (dir * (endJoint - startJoint) <= 0) return [];
    const { coord1, coord2 } = this.spanForColumns(columns, { diaphragm });
    const lo = Math.min(coord1, coord2), hi = Math.max(coord1, coord2);
    return [startJoint, endJoint].filter(v => v > lo && v < hi);
  }
  // coord1/coord2 = 柱がある端部は柱の断面手前（柱の中心ではなく断面まで）、無ければCL位置まで（自階graphの柱基準）。
  get coord1() { return this.spanForColumns(this._planGraph?.columns ?? []).coord1; }
  get coord2() { return this.spanForColumns(this._planGraph?.columns ?? []).coord2; }
}

export class WoodBeam extends StructuralBeam {
  constructor(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, StructuralMaterialType.WOOD, sectionDefId, axisCL, isVertical, clStart, clEnd, {
      ...props,
      jointCondition: props.jointCondition ?? { start: 'PIN', end: 'PIN' }, // 木造は基本ピン接合
    });
    this.beamType = props.beamType ?? '大梁'; // '大梁' | '小梁' | '桁' | '小屋梁'
    makeObservable(this, { beamType: observable });
  }
}

export class SteelBeam extends StructuralBeam {
  constructor(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, StructuralMaterialType.STEEL, sectionDefId, axisCL, isVertical, clStart, clEnd, props);
    this.isCambered     = props.isCambered     ?? false;
    this.stiffenerCount = props.stiffenerCount ?? 0;
    makeObservable(this, { isCambered: observable, stiffenerCount: observable });
  }
}

export class RcBeam extends StructuralBeam {
  constructor(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, StructuralMaterialType.RC, sectionDefId, axisCL, isVertical, clStart, clEnd, props);
    this.topMainBars    = props.topMainBars    ?? { count: 3, size: 'D22' };
    this.bottomMainBars = props.bottomMainBars ?? { count: 3, size: 'D22' };
    this.stirrupBars    = props.stirrupBars    ?? { size: 'D10', pitch: 200 };
    makeObservable(this, { topMainBars: observable, bottomMainBars: observable, stirrupBars: observable });
  }
}

// materialType（StructuralMaterialType）→ サブクラスの解決表（PlanGraph.addColumn/addBeam 用）
export const COLUMN_CLASS_BY_MATERIAL = Object.freeze({
  [StructuralMaterialType.WOOD]:  WoodColumn,
  [StructuralMaterialType.STEEL]: SteelColumn,
  [StructuralMaterialType.RC]:    RcColumn,
});
export const BEAM_CLASS_BY_MATERIAL = Object.freeze({
  [StructuralMaterialType.WOOD]:  WoodBeam,
  [StructuralMaterialType.STEEL]: SteelBeam,
  [StructuralMaterialType.RC]:    RcBeam,
});

// ----------------------------------------------------------------
// 基礎・柱脚（StructuralFooting・抽象） — StructuralColumn と同じ「垂直CL × 水平CL」導出方式だが
// 継承関係は持たない（柱状(A-1)/箱状(A-2)の意味的区別をクラス階層でも保つ）。
//
//   x = verticalCL.effectiveValue   + eccentricity.x
//   y = horizontalCL.effectiveValue + eccentricity.y
// ----------------------------------------------------------------
class StructuralFooting extends StructuralEntity {
  constructor(id, materialType, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.verticalCL    = verticalCL;
    this.horizontalCL  = horizontalCL;
    this.eccentricity  = props.eccentricity  ?? { x: 0, y: 0 };
    this.topLevel       = props.topLevel       ?? null; // 上端レベル(mm)。既定: 直上の柱/柱脚の下端
    this.bottomLevel    = props.bottomLevel    ?? null; // 下端レベル(mm)
    this.sectionShape   = props.sectionShape   ?? 'rect'; // 'rect' | 'round'
    this.widthX         = props.widthX         ?? 1000; // 矩形: Wx（丸の場合は直径として widthX のみ使用）
    this.widthY         = props.widthY         ?? 1000; // 矩形: Wy（丸の場合は無視）
    this._planGraph      = null; // PlanGraph が addFooting 時にセット（columnAxisOffsets参照用。直上の柱と位置を揃える）
    makeObservable(this, {
      verticalCL:   observable.ref,
      horizontalCL: observable.ref,
      eccentricity: observable,
      topLevel:     observable,
      bottomLevel:  observable,
      sectionShape: observable,
      widthX:       observable,
      widthY:       observable,
      x: computed,
      y: computed,
    });
  }
  // x/y = 通り芯 + 柱芯オフセット（直上の柱・杭と同じ基準で揃える） + 個別偏心量
  get x() { return _gridX(this); }
  get y() { return _gridY(this); }
}

// 独立フーチング（基礎） — 柱・杭の直下に置かれる、最も広がった箱
export class IndependentFooting extends StructuralFooting {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, props.materialType ?? StructuralMaterialType.RC, sectionDefId, verticalCL, horizontalCL, props);
    this.footingType = props.footingType ?? '独立基礎'; // '独立基礎' | '複合基礎'
    this.mainBars    = props.mainBars    ?? { size: 'D13', pitch: 200 };
    this.supportType = props.supportType ?? '直接基礎'; // '直接基礎' | '杭基礎'
    makeObservable(this, { footingType: observable, mainBars: observable, supportType: observable });
  }
}

// 柱脚 — 柱と基礎/杭頭の間に入る箱状の接合部材。鉄骨/RCの材質分岐はサブクラスを分けず、
// 両フィールド群を共存させ materialType で使う方を切り替える（コンストラクタの簡潔さ優先）。
export class ColumnBase extends StructuralFooting {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, props.materialType ?? StructuralMaterialType.RC, sectionDefId, verticalCL, horizontalCL, props);
    this.baseType        = props.baseType        ?? '固定'; // '露出' | '埋込' | 'ピン' | '固定'
    this.basePlateDefId  = props.basePlateDefId  ?? null; // 鉄骨のみ
    this.anchorBoltCount = props.anchorBoltCount ?? null; // 鉄骨のみ
    this.anchorBoltSize  = props.anchorBoltSize  ?? null; // 鉄骨のみ
    this.mainBars        = props.mainBars        ?? null; // RCのみ
    // 基礎柱(ペデスタル)の埋込み深さ・全高(mm)。柱の負担床面積から算定したtributaryWidthの2.3倍を既定値とする
    // （structural/memberSizing.js）。IndependentFootingには持たせない（種別判定は'pedestalDepth' in entity）。
    this.pedestalDepth   = props.pedestalDepth   ?? null;
    makeObservable(this, {
      baseType: observable, basePlateDefId: observable,
      anchorBoltCount: observable, anchorBoltSize: observable, mainBars: observable,
      pedestalDepth: observable,
    });
  }
}

// ----------------------------------------------------------------
// 耐力壁（StructuralWall・抽象） — StructuralBeam と同じ「軸CL + 始端CL + 終端CL」導出方式
//
//   axisValue = axisCL.effectiveValue + eccentricity
//   coord1    = clStart.effectiveValue
//   coord2    = clEnd.effectiveValue
//   length    = |coord2 - coord1|
//
// 架構の Wall と異なり startOffset/endOffset（面取り対応）を持たない —
// 耐力壁は柱・梁と同じく配置インタラクションで直接生成・削除され、
// 仕上げモードのような全削除→再生成サイクルが無いため、自動面取りの対象外。
// ----------------------------------------------------------------
export class StructuralWall extends StructuralEntity {
  constructor(id, materialType, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.axisCL       = axisCL;     // 壁が沿う通り芯
    this.isVertical   = isVertical;
    this.clStart      = clStart;    // 始端の直交CL
    this.clEnd        = clEnd;      // 終端の直交CL
    this.eccentricity = props.eccentricity ?? 0;   // axisCLからの符号付き偏心量(mm)
    this.thickness    = props.thickness    ?? 180; // 壁厚(mm) — 連続値の設計パラメータのため直接保持
    this.bottomLevel  = props.bottomLevel  ?? 0;    // 高さ範囲・下端レベル(mm、floorDatum基準)
    this.topLevel     = props.topLevel     ?? null; // 高さ範囲・上端レベル(mm)。null=階高から自動
    // 耐力壁の種別（問題.md）。RC造='rc'（厚指定）／S造='none'|'brace'|'steelPlate'。
    // 現状クラスはRC専用だが、S造の種別選択はメタ属性として保持する（新クラスは次フェーズ）。
    this.wallType     = props.wallType     ?? 'rc'; // 'rc' | 'none' | 'brace' | 'steelPlate'
    makeObservable(this, {
      clStart:      observable.ref,
      clEnd:        observable.ref,
      eccentricity: observable,
      thickness:    observable,
      bottomLevel:  observable,
      topLevel:     observable,
      wallType:     observable,
      axisValue: computed,
      coord1:    computed,
      coord2:    computed,
      length:    computed,
    });
  }
  get axisValue() { return this.axisCL.effectiveValue + this.eccentricity; }
  get coord1()    { return this.clStart.effectiveValue; }
  get coord2()    { return this.clEnd.effectiveValue; }
  get length()    { return Math.abs(this.coord2 - this.coord1); }
}

export class RcBearingWall extends StructuralWall {
  constructor(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, StructuralMaterialType.RC, sectionDefId, axisCL, isVertical, clStart, clEnd, props);
    this.verticalBars   = props.verticalBars   ?? { size: 'D10', pitch: 200 }; // たて筋
    this.horizontalBars = props.horizontalBars ?? { size: 'D10', pitch: 200 }; // よこ筋
    makeObservable(this, {
      verticalBars:   observable,
      horizontalBars: observable,
      isStructuralBearingWall: computed,
      crossSectionalArea:      computed,
    });
  }
  // 壁式RC造の最小制限（学会基準等の目安値）: 壁厚150mm以上・壁長450mm以上
  get isStructuralBearingWall() {
    return this.thickness >= 150 && this.length >= 450;
  }
  get crossSectionalArea() {
    return this.isStructuralBearingWall ? this.length * this.thickness : 0;
  }
}

// ----------------------------------------------------------------
// 耐力壁の開口（RcWallOpening） — 親 RcBearingWall を直接参照する。
// 架構の Opening（Wallを直接参照しない自己完結アンカー）とは非対称な設計だが、
// StructuralWall は仕上げモードのような再生成サイクルが無いため直接参照で安全かつ単純。
// ----------------------------------------------------------------
export class RcWallOpening {
  constructor(id, wall, offset, width, props = {}) {
    this.id     = id;
    this.wall   = wall;    // 親 RcBearingWall への直接参照
    this.offset = offset;  // wall.clStart からの符号付き距離(mm) — 開口中心位置
    this.width  = width;   // 開口幅(mm) — 壁の長さ方向
    this.height     = props.height     ?? 2000; // 開口高さ(mm) — 壁量計算上の準耐力壁判定等に使用
    this.sillHeight = props.sillHeight ?? 0;    // 開口下端の高さ(mm、床上)
    this.lintelBars = props.lintelBars ?? { size: 'D13', count: 2 }; // まぐさ補強筋
    this.affectsEffectiveLength = props.affectsEffectiveLength ?? true; // 有効壁長算定への影響フラグ（計算ロジックは対象外）
    makeObservable(this, {
      wall:        observable.ref,
      offset:      observable,
      width:       observable,
      height:      observable,
      sillHeight:  observable,
      lintelBars:  observable,
      affectsEffectiveLength: observable,
      centerCoord: computed,
      coord1:      computed,
      coord2:      computed,
    });
  }
  get centerCoord() { return this.wall.clStart.effectiveValue + this.offset; }
  get coord1()       { return _coordLo(this.centerCoord, this.width); }
  get coord2()       { return _coordHi(this.centerCoord, this.width); }
}

// ----------------------------------------------------------------
// スラブ（StructuralSlab・抽象） — Room と同じ「cells: Set<cellKey>」導出方式。
// cellKey は finish/gridCells.js と同形式（"leftCLId:topCLId:rightCLId:bottomCLId"）。
// CLが削除されて一部セルキーが解決不能になっても Room と同様にデータは保持し、
// 描画時に解決できないセルを無視するだけに留める（teardown 不要）。
// ----------------------------------------------------------------
export class StructuralSlab extends StructuralEntity {
  constructor(id, materialType, sectionDefId, cells, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.cells      = cells ?? new Set();
    this.thickness  = props.thickness  ?? 150; // スラブ厚(mm)
    this.floorLevel = props.floorLevel ?? null; // Room.floorLevel と同じ「疎な例外」方式（null=floorDatumどおり）
    // スラブ・べた基礎・屋根版はサブクラスを増やさず role で区別する。
    this.role           = props.role           ?? 'slab'; // 'slab' | 'mat_foundation' | 'roof_panel'
    this.levelRef       = props.levelRef       ?? 'top';  // 基準レベルが上端基準か下端基準か
    this.slopeDirection = props.slopeDirection ?? null;    // {dx,dy} | null（水平面内の勾配方向、屋根版用）
    this.slopeAngle     = props.slopeAngle     ?? 0;       // 勾配角度(度、0=水平)
    // 厚指定の種別（問題.md）。'slab'=コンクリートスラブ / 'deck'=デッキプレート。
    this.slabKind       = props.slabKind       ?? 'slab'; // 'slab' | 'deck'
    // デッキ方向（slabKind==='deck'のみ意味を持つ）。'x'=X方向 / 'y'=Y方向。描画エリアの両矢印クリックで90度回転。
    this.deckDirection  = props.deckDirection  ?? 'x';   // 'x' | 'y'
    makeObservable(this, {
      cells:          observable,
      thickness:      observable,
      floorLevel:     observable,
      role:           observable,
      levelRef:       observable,
      slopeDirection: observable,
      slopeAngle:     observable,
      slabKind:       observable,
      deckDirection:  observable,
      setCells:       action,
    });
  }
  setCells(cells) { this.cells = new Set(cells); }
}

export class RcSlab extends StructuralSlab {
  constructor(id, sectionDefId, cells, props = {}) {
    super(id, StructuralMaterialType.RC, sectionDefId, cells, props);
    this.mainBars         = props.mainBars         ?? { size: 'D10', pitch: 200 }; // 主筋（短辺方向）
    this.distributionBars = props.distributionBars ?? { size: 'D10', pitch: 200 }; // 配力筋（長辺方向）
    makeObservable(this, { mainBars: observable, distributionBars: observable });
  }
}

// ----------------------------------------------------------------
// 貫通孔（PenetrationSleeve） — 梁(B)・スラブ(C)の配管/配線貫通孔。
// 意匠Openingと同じ設計パターンで、ホスト構造材を直接参照せず自己完結アンカーを持つ
// （StructuralEntity は継承しない＝materialType/sectionDefId/memberNo の採番対象外）。
// ----------------------------------------------------------------
export class PenetrationSleeve {
  constructor(id, hostType, props = {}) {
    this.id       = id;
    this.hostType = hostType; // 'beam' | 'slab'
    // 梁ホスト用アンカー（hostBeamId は同一CL上に複数梁がある場合の連鎖削除の一意特定用）
    this.hostBeamId   = props.hostBeamId   ?? null;
    this.hostAxisCL   = props.hostAxisCL   ?? null;
    this.hostClStart  = props.hostClStart  ?? null;
    this.hostClEnd    = props.hostClEnd    ?? null;
    this.localPos     = props.localPos     ?? 0; // 軸方向ローカル位置(clStartからのmm)
    this.heightOffset = props.heightOffset ?? 0; // 梁上端基準の断面内高さ位置(mm)
    // スラブホスト用アンカー（hostSlabId は連鎖削除の一意特定用）
    this.hostSlabId = props.hostSlabId ?? null;
    this.hostCellKey = props.hostCellKey ?? null;
    this.localX     = props.localX     ?? 0; // セル内ローカルx
    this.localY     = props.localY     ?? 0; // セル内ローカルy
    // 共通
    this.diameter         = props.diameter         ?? 100;   // 径(mm)
    this.hasReinforcement = props.hasReinforcement ?? false; // 補強プレート有無
    makeObservable(this, {
      hostAxisCL:  observable.ref,
      hostClStart: observable.ref,
      hostClEnd:   observable.ref,
      localPos:      observable,
      heightOffset:  observable,
      hostCellKey:   observable,
      localX:        observable,
      localY:        observable,
      diameter:         observable,
      hasReinforcement: observable,
    });
  }
}

// materialType（StructuralMaterialType）→ サブクラスの解決表（PlanGraph.addBearingWall/addSlab 用）
export const WALL_CLASS_BY_MATERIAL = Object.freeze({
  [StructuralMaterialType.RC]: RcBearingWall,
});
export const SLAB_CLASS_BY_MATERIAL = Object.freeze({
  [StructuralMaterialType.RC]: RcSlab,
});
