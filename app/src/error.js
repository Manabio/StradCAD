const KIND_LABEL = { struct: '通り芯', center: '中心線', aux: '補助線' };

export const ERR_CL_DUPLICATE = (kind) =>
  `既に同じ位置に${KIND_LABEL[kind]}があり、追加できません。`;

export const ERR_CL_CENTER_UPGRADED =
  '同位置に中心線があります。その中心線を削除して、追加する通り芯を参照するように変更します。';

export const ERR_CL_STRUCT_EXISTS =
  '同位置に通り芯があり、追加できません。';

export const ERR_DRAW = 'Draw error:';

// 仕上げモード突入時、永続化データが参照する材コードが材マスタに存在しない場合
export const ERR_MATERIAL_MISMATCH = '材データが一致しません。';

// 中心線移動時、随伴する図形の連鎖が深すぎる／多すぎる場合（transform/followerGraph.js）
export const ERR_CL_MOVE_TOO_DEEP = (excess, max) =>
  `関連する図形の連鎖が深すぎます。ネストを${excess}段減らして${max}段以内にしてください。`;

export const ERR_CL_MOVE_TOO_MANY = (excess, max) =>
  `関連する図形が多すぎます。あと${excess}個削除して${max}個以内にしてください。`;

export const ERR_CL_MOVE_LOAD_FAILED = 'フロアデータの読み込みに失敗しました。';

// 開口（建具・窓）の配置検証（openings/openingGeometry.js）
export const ERR_OPENING_OUT_OF_WALL = '開口が壁の範囲を超えています。';
export const ERR_OPENING_OVERLAP     = '既存の開口と重なっています。';

// 構造モード突入時、構造情報パネルの主要構造が未指定（'未定'）の場合
export const ERR_STRUCT_MAIN_UNSPECIFIED = '主要構造を指定してください。';
