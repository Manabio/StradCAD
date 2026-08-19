const KIND_LABEL = { struct: '通り芯', center: '中心線', aux: '補助線', beam: '梁芯' };

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

// 中心⇔通り芯の入替え（transform/centerLineConvert.js・centerLineOps.js）
export const ERR_CL_CONVERT_NO_GRID   = '直交する通り芯が2本必要です。';
// 降格（通り芯→中心）専用: 同じ軸（X/Y）に他の通り芯が無い＝この通り芯が軸最後の1本の場合
export const ERR_CL_CONVERT_LAST_GRID = 'この軸の最後の通り芯のため中心線にできません。';
export const ERR_CL_CONVERT_ATTACHED  = 'この中心線には斜線・円弧が取り付いているため変換できません。';
// 昇格（中心→通り芯）専用: 他階の同座標に中心線があるため通り芯化できない
export const ERR_CL_CONVERT_DUP_FLOOR = (floors) => `${floors} の同じ位置に中心線があるため通り芯にできません。`;
// 降格（通り芯→中心）専用: DUP_FLOORと逆方向のため文言を分ける（「通り芯にできません」の誤表示防止）
export const ERR_CL_CONVERT_DUP_FLOOR_DEMOTE = (floors) => `${floors} の同じ位置に中心線があるため中心線にできません。`;
// 中心⇔通り芯の入替え確定後、非アクティブ階への複製（propagateDemotedCenterLine）がIDB書込等で失敗した場合
export const ERR_CL_CONVERT_SYNC_FAILED = '他階への反映に失敗しました。';

// CL削除（transform/centerLineOps.js deleteCenterLineWithUndo）専用: 同じ軸（X/Y）に他の通り芯が
// 無い＝この通り芯が軸最後の1本の場合。ERR_CL_CONVERT_LAST_GRID（降格用）と判定式は共有するが、
// 「削除できません」と方向が違うため文言は分ける。
export const ERR_CL_DELETE_LAST_GRID = 'この軸の最後の通り芯のため削除できません。';

// セッション排他ロック（storage/sessionLock.js）: 別タブが編集セッションを保持している場合、
// storage/db.js の openDB() がこの文言で reject する。App.jsx は同じ文言を全画面案内に表示する。
export const ERR_SESSION_LOCKED = 'このアプリは別のタブで開いています。編集できるのは1つのタブだけです。';
