import { observer } from 'mobx-react-lite';
import { Text } from 'react-konva';

// 記号のスクリーン上の表示サイズ(px)。RoomLabelsLayer.jsx の室名と同じ「画面上で一定の大きさ」の流儀
// （fontSizeをviewport.scaleXで逆補正する）。
const FONT_SIZE_PX = 14;

/**
 * 昇降機器具の図中記号（「EV」「EV1」等）を描くだけのレイヤー。
 * 幾何（位置・文字）の判断は一切持たず、finish/equipment/equipmentFigure.js
 * computeEquipmentSymbols が計算した値（symbols）をそのまま Konva 要素へ写像する
 * （finish/stepSection.js・finish/stair/stairGeometry.js と同じ「計算はfinish側、描画はrenderer側」の分担）。
 * @param {{symbols: Array<{id:string, text:string, x:number, y:number}>, viewport: object}} props
 */
export const EquipmentSymbolLayer = observer(({ symbols, viewport }) => {
  if (!symbols || symbols.length === 0) return null;
  const fontSize = FONT_SIZE_PX / viewport.scaleX;

  return symbols.map(s => {
    const estimatedHalfWidth = fontSize * s.text.length * 0.5;
    return (
      <Text
        key={s.id}
        x={s.x - estimatedHalfWidth}
        y={s.y - fontSize / 2}
        text={s.text}
        fontSize={fontSize}
        fill="#1e3a5f"
        fontStyle="bold"
        listening={false}
      />
    );
  });
});
