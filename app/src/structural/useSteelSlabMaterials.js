import { useEffect, useState } from 'react';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import { composeList } from '../catalog/catalogRegistry.js';

/**
 * S造スラブ欄・カードのプレート選択肢に使う材料一覧（本体カタログ＋ユーザー追加。仕上げモードと同じ composeList）。
 * materialData.js は独立チャンクのため kindDef(...).loadBuiltin() の動的 import で読む。
 * 未読込み（読込み中・失敗）は undefined を返す——空配列を渡すと全プレートが既定へ正規化されるため照合させない。
 */
export function useSteelSlabMaterials() {
  const [materials, setMaterials] = useState([]);
  useEffect(() => {
    let alive = true;
    kindDef(CatalogKind.MATERIAL).loadBuiltin().then(list => {
      if (alive) setMaterials(composeList(CatalogKind.MATERIAL, list));
    }).catch(() => {
      // 読込みに失敗したら未読込み（undefined）のまま続ける——照合も「カタログに無い」表示もせず、現在値を保つ。
    });
    return () => { alive = false; };
  }, []);
  return materials.length > 0 ? materials : undefined;
}
