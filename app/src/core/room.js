/**
 * 部屋・仕上げモード境界関連クラス群（WallBackingMaterial / edgeKey / Edge /
 * RoomFinish / ExteriorFinishRow / Room）。core.js から分離。
 */
import { makeObservable, observable, action } from 'mobx';
import { RoomKind, DEFAULT_WALL_MATERIAL } from './constants.js';
import { INTERIOR_MASTERS } from '../finish/materials/interiorMasters.js';

// ================================================================
// WALL BACKING MATERIAL (壁下地材)
//
// 下地に使用する材を 1 種定義する。
// x < y を常に保証する（x = 短辺, y = 長辺）。
// ================================================================

export class WallBackingMaterial {
  constructor(id, name, x, y) {
    this.id   = id;
    this.name = name;
    this.x    = Math.min(x, y);
    this.y    = Math.max(x, y);
    makeObservable(this, {
      name:          observable,
      x:             observable,
      y:             observable,
      setName:       action,
      setDimensions: action,
    });
  }
  setName(name) { this.name = name; }
  setDimensions(x, y) { this.x = Math.min(x, y); this.y = Math.max(x, y); }
}

// ================================================================
// EDGE (境界エッジ — 仕上げモードの部屋境界)
//
// 両端をノード（交点）で挟まれ、両側に名称がついた境界セグメントに附帯する
// 情報をまとめる。座標は持たず、CL-ID ベースの安定キーで同定する:
//   key = `${axisCLId}:${startCLId}:${endCLId}`（CL 移動で不変）
//
// データを小さく保つため、本クラスはデータ＋問合せ・書換えのみを持ち、
// 判定・選定（境界マスター選定など）は仕上げモードの function 側で行う。
//   masterType : 選定結果のキャッシュ（BOUNDARY_MASTERS のキー）| null（都度導出可）
//   overrides  : 材の個別上書きポケット（Room.customOverrides と同方式）
// ================================================================

/** エッジ安定キーを組み立てる。 */
export function edgeKey(axisCLId, startCLId, endCLId) {
  return `${axisCLId}:${startCLId}:${endCLId}`;
}

export class Edge {
  constructor(key, masterType = null, overrides = null) {
    this.key        = key;
    this.masterType = masterType;
    this.overrides  = observable.map(); // field → value（材コード等）
    if (overrides) for (const [k, v] of overrides) this.overrides.set(k, v);
    makeObservable(this, {
      masterType:    observable,
      setMasterType: action,
      setOverride:   action,
      clearOverride: action,
    });
  }

  // key の構成要素（必要時に分解）
  get axisCLId()  { return this.key.split(':')[0]; }
  get startCLId() { return this.key.split(':')[1]; }
  get endCLId()   { return this.key.split(':')[2]; }

  setMasterType(t)          { this.masterType = t; }
  setOverride(field, value) { this.overrides.set(field, value); }
  clearOverride(field)      { this.overrides.delete(field); }
}

// ================================================================
// ROOM (仕上げモード — 部屋領域 + 仕上げ情報)
// ================================================================

// 巾木の初期値（QA G2: ユーザーが新規にRoomを作成する経路でのみ適用する。RoomFinishの
// コンストラクタでは絶対に設定しない——復元/デシリアライズ経路（graphSnapshot.js /
// roomReinterpret.js の restoreRoomsState）は「新しいRoomインスタンスを作ってから空でない
// フィールドだけ上書きする」実装のため、コンストラクタ既定値を非空にすると、ユーザーが
// 巾木を''へクリアした部屋がundo/redo・再読込のたびに既定値へ勝手に戻ってしまう。
// 適用箇所は applyDefaultBaseboard()（呼び出し元は仕上げモードの部屋新規指定確定処理のみ）。
export const DEFAULT_BASEBOARD_MATERIAL = '木製出幅木';
export const DEFAULT_BASEBOARD_HEIGHT   = 'h=60';

// 自由文字列の仕上げフィールド。
// 壁材（wallMaterial）・壁仕上げ（wallFinish）・天井高さ（ceilingHeight）は
// 内装マスター（templateKey）+ customOverrides で管理するため、ここには持たない。
export class RoomFinish {
  constructor() {
    this.floorMaterial     = '';
    this.baseboardMaterial = '';
    this.baseboardHeight   = '';
    this.dadoMaterial      = '';
    this.dadoHeight        = '';
    this.ceilingMaterial   = '';
    this.cornice           = '';
    this.note              = '';
    makeObservable(this, {
      floorMaterial:     observable,
      baseboardMaterial: observable,
      baseboardHeight:   observable,
      dadoMaterial:      observable,
      dadoHeight:        observable,
      ceilingMaterial:   observable,
      cornice:           observable,
      note:              observable,
      setField:          action,
    });
  }
  setField(field, value) { this[field] = value; }
}

export class ExteriorFinishRow {
  constructor() {
    this.id     = crypto.randomUUID();
    this.part   = '';
    this.finish = '';
    this.base   = '';
    this.note   = '';
    this.roomId = null; // 階段ペアRoomのID（階段連動行のみ設定。手入力行は null）
    makeObservable(this, {
      part:     observable,
      finish:   observable,
      base:     observable,
      note:     observable,
      roomId:   observable,
      setField: action,
    });
  }
  setField(field, value) { this[field] = value; }
}

// cells は Set<string> — cellKey(xLeftCL, yTopCL) の集合
export class Room {
  constructor(id, name = '', cells = new Set(), referenceRoomIds = new Set(),
              kind = RoomKind.INTERIOR, templateKey = null, feature = null) {
    this.id               = id;
    this.name             = name;
    this.cells            = cells;
    this.referenceRoomIds = referenceRoomIds; // 判定3: 参照先部屋IDセット
    this.kind             = kind; // 内外区分（base軸）: 屋内 / 屋外
    this.feature          = feature; // 属性軸: 'stair' | 'void' | 'stairVoid' | null（なし）
    this.templateKey      = templateKey;      // 内装マスターへのポインタ（null = 未指定）
    this.customOverrides  = observable.map(); // 個別上書きポケット（壁・天井フィールドのみ）
    this.finish           = new RoomFinish();
    this.namePosition     = null;   // { x, y } | null — null = roomBounds 重心を使用
    this.floorLevel       = null;   // 階基準からの符号付き床レベル差(mm)。null = 基準どおり
    this.generatedWallIds = new Set(); // 自動生成された Wall の ID を管理（非 observable）
    makeObservable(this, {
      name:             observable,
      cells:            observable,
      referenceRoomIds: observable,
      kind:             observable,
      feature:          observable,
      templateKey:      observable,
      namePosition:     observable.ref,
      floorLevel:       observable,
      setName:          action,
      addCell:          action,
      removeCell:       action,
      setCells:         action,
      setKind:          action,
      setFeature:       action,
      setTemplateKey:   action,
      setOverride:      action,
      clearOverride:    action,
      setNamePosition:  action,
      setFloorLevel:    action,
    });
  }
  setName(name)              { this.name = name; }
  addCell(key)               { this.cells.add(key); }
  removeCell(key)            { this.cells.delete(key); }
  setCells(cells)            { this.cells = cells; }
  setKind(kind)              { this.kind = kind; }
  setFeature(feature)        { this.feature = feature; } // 'stair' | 'void' | 'stairVoid' | null
  setNamePosition(x, y)     { this.namePosition = { x, y }; }
  setFloorLevel(mm)         { this.floorLevel = mm; } // mm | null（null = 階基準どおり）

  setTemplateKey(key)        { this.templateKey = key; }

  /**
   * 個別上書き。マスター値と同値なら override を削除し、ポケットを空に保つ。
   * （数値フィールドの型差を吸収するため緩く比較）
   */
  setOverride(field, value) {
    const master = INTERIOR_MASTERS[this.templateKey] ?? {};
    if (field in master && String(master[field]) === String(value)) {
      this.customOverrides.delete(field);
    } else {
      this.customOverrides.set(field, value);
    }
  }
  clearOverride(field)       { this.customOverrides.delete(field); }

  /**
   * 内装マスター + 個別上書きをマージした、壁・天井フィールドの実効値。
   * 壁材（wallMaterial）はマスター・上書きとも未指定なら既定（せっこうボード t=12.5）に
   * フォールバックする（壁描画の仕上げ厚導出が部屋の壁材を単一情報源とするため）。
   */
  getFinishInfo() {
    const master = INTERIOR_MASTERS[this.templateKey] ?? {};
    const info = { ...master, ...Object.fromEntries(this.customOverrides) };
    if (!info.wallMaterial) info.wallMaterial = DEFAULT_WALL_MATERIAL;
    return info;
  }
}

/**
 * 巾木の初期値を room.finish に適用する（QA G2）。呼び出してよいのは「ユーザー操作で
 * Room が新規作成される経路」（仕上げモードの部屋指定確定処理。FinishModeState.js の
 * graph.addRoom(...) 直後）だけ——復元・デシリアライズ経路（graphSnapshot.js /
 * roomReinterpret.js の restoreRoomsState / schema/graphFbs.js 経由の読み込み）では
 * 絶対に呼ばないこと（呼ぶと空文字クリアが往復不能になる。RoomFinishコンストラクタの
 * コメント参照）。
 * @param {Room} room
 */
export function applyDefaultBaseboard(room) {
  room.finish.setField('baseboardMaterial', DEFAULT_BASEBOARD_MATERIAL);
  room.finish.setField('baseboardHeight', DEFAULT_BASEBOARD_HEIGHT);
}
