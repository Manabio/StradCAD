/**
 * Plane（平面 = XY平面 1枚 + 高さ 1つ）。core.js から分離。
 */
import { makeObservable, observable } from 'mobx';

export class Plane {
  constructor(id, elevation, name = '', startFloor = 1, stories = 1,
              isAlternative = false, referenceId = null, altIndex = 0,
              isRoofPlane = false, roofForPlaneId = null) {
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
    makeObservable(this, {
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
