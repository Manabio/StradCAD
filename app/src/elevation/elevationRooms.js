/**
 * 展開図: 部屋群 → 帯配列の組み立てを1部屋単位で隔離する（純関数）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * ElevationModeState.init() が唯一の呼び出し元。1部屋の帯構築（buildRoomBand/buildStairBand）が
 * 例外を投げても他の部屋の帯はそのまま残し、失敗した部屋名を集めて呼び出し側（モード状態）が
 * materialError（既存のトースト経路）へ渡せるようにする（QA F4: 以前は1部屋の異常が
 * unhandled rejection になり、キャンバスが真っ白のまま何も通知されなかった）。
 */

/**
 * @param {Array<{id:string, name:string}>} rooms
 * @param {(room:object) => object} buildOne - 1部屋ぶんの帯を構築する（buildRoomBand/buildStairBand相当）
 * @param {(err:Error, room:object) => void} [onError] - 失敗時のログ等（副作用。既定は何もしない）
 * @returns {{bands:object[], failedRoomNames:string[]}}
 */
export function buildBandsSafely(rooms, buildOne, onError = () => {}) {
  const bands = [];
  const failedRoomNames = [];
  for (const room of rooms) {
    try {
      bands.push(buildOne(room));
    } catch (err) {
      onError(err, room);
      failedRoomNames.push(room.name || room.id);
    }
  }
  return { bands, failedRoomNames };
}
