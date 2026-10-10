/**
 * Plane（平面 = XY平面 1枚 + 高さ 1つ）。core.js から分離。
 */
import { makeObservable, observable } from 'mobx';

/** 平面の切断高（FL+mm）の既定値。旧データ（フィールド無し）・未指定・不正値はこの値として扱う。 */
export const DEFAULT_PLAN_CUT_HEIGHT_MM = 1500;

/**
 * 階の平面切断高（FL+mm）の唯一の読み口。plane が null/undefined、値が有限の正数でないときは既定値。
 * 平面図の切断判定はこの関数を通して読むこと（Plane のフィールドを直接読まない）。
 */
export function planCutHeightMmOf(plane) {
  const v = plane?.planCutHeightMm;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PLAN_CUT_HEIGHT_MM;
}

/**
 * 天伏（見上げ）の切断高（FL+mm）の既定値。ASSUMED: ユーザー未指定のため平面の切断高の既定と同値にした（裁定 2026-10-10 は
 * 「専用の属性を持たせる」まで。値は後で決める）。旧データ（フィールド無し）・未指定・不正値はこの値として扱う。
 */
export const DEFAULT_CEILING_CUT_HEIGHT_MM = 1500;

/** 階の天伏切断高（FL+mm）の唯一の読み口。planCutHeightMmOf と同型（0・負・非数・欠落は既定）。 */
export function ceilingCutHeightMmOf(plane) {
  const v = plane?.ceilingCutHeightMm;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CEILING_CUT_HEIGHT_MM;
}

export class Plane {
  constructor(id, elevation, name = '', startFloor = 1, stories = 1,
              isAlternative = false, referenceId = null, altIndex = 0,
              isRoofPlane = false, roofForPlaneId = null,
              planCutHeightMm = DEFAULT_PLAN_CUT_HEIGHT_MM,
              ceilingCutHeightMm = DEFAULT_CEILING_CUT_HEIGHT_MM) {
    this.id            = id;
    this.elevation     = elevation;
    this.name          = name;
    this.startFloor    = startFloor;
    this.stories       = stories;
    this.isAlternative = isAlternative; // true = 検討
    this.referenceId   = referenceId;   // 検討の場合、採用の plane.id
    this.altIndex      = altIndex;      // 検討の表示順
    // 屋根専用平面（小屋伏／R階伏）。構造モードでのみ使う合成平面で、フロアタブ・階番号ロジックの対象外。
    this.isRoofPlane    = isRoofPlane;
    this.roofForPlaneId = roofForPlaneId; // どの実体平面の上に乗る屋根平面か（structural/roofPlane.js 参照）
    this.planCutHeightMm = planCutHeightMm; // 平面の切断高（FL+mm）。読み取りは planCutHeightMmOf
    this.ceilingCutHeightMm = ceilingCutHeightMm; // 天伏（見上げ）の切断高（FL+mm）。読み取りは ceilingCutHeightMmOf
    makeObservable(this, {
      planCutHeightMm: observable,
      ceilingCutHeightMm: observable,
      elevation:      observable,
      name:           observable,
      startFloor:     observable,
      stories:        observable,
      isAlternative:  observable,
      referenceId:    observable,
      altIndex:       observable,
      isRoofPlane:    observable,
      roofForPlaneId: observable,
    });
  }
}
