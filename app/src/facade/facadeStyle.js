/**
 * 立面図（外壁立面4面）の見た目の定数（領域別 Style。elevation/elevationStyle.js と同じ置き方）。
 * 「実画面mm」の値は校正値ベースでズーム非依存——モデルmmへの換算は elevationLayout.js の screenMmToModelMm で、
 * 倍率が確定した後に行う（展開図の2パス方式と同じ）。線種は elevation/elevationStyle.js の ElevationLineRole を使う。
 */

/** 面と面の縦の間隔（実画面mm）。見出しの文字（FACE_LABEL_FONT_PX）が上の面の GL に重ならない幅。 */
export const FACADE_GAP_SCREEN_MM = 20;
/** ▽GL の水平線を建物の左右の端からさらに延ばす長さ（実画面mm）。▽と「GL」をこの延長の上に置く。 */
export const FACADE_GL_EXTEND_SCREEN_MM = 10;
/** ▽の高さ（実画面mm。先端が GL の線に乗り、底辺がこの高さだけ上）。 */
export const FACADE_GL_MARK_SCREEN_MM = 3;
/** ▽の頂角（度）。60＝正三角形（底辺の半分＝高さ×tan(30°)）。 */
export const FACADE_GL_MARK_APEX_DEG = 60;
/** 見出し（東立面図など）の中心を建物の上端から上へ離す距離（実画面mm）。 */
export const FACADE_TITLE_GAP_SCREEN_MM = 6;
/** 「GL」の文字サイズ（px。展開図の建具記号・通り芯番号の OPENING_TAG_FONT_PX と同じ大きさ）。 */
export const FACADE_LEVEL_FONT_PX = 11;
/** 線の見え隠れを調べる間隔（モデルmm）。この間隔で標本を取り、見え方が変わる区間だけ二分探索で詰める。 */
export const FACADE_VIS_SAMPLE_MM = 100;
/** 見え隠れの切れ目を二分探索で詰める精度（モデルmm）。奥行きプロファイルの折れ点がこの範囲にあればそこへ寄せる。 */
export const FACADE_VIS_BISECT_MM = 0.5;
/**
 * 屋根の遮蔽の厚み（モデルmm）。視線の手前にある屋根の部分の屋根面の z の最小からこの厚みだけ下までを隠す
 * （屋根は面＝厚み 0 で持つため、垂木＋野地の目安の厚みを足して、軒の出の下の壁の上端・鼻先の下を隠す。リード裁定 S2）。
 */
export const FACADE_ROOF_OCCLUSION_DEPTH_MM = 100;
/** buildFacadeLines（facadeGeometry.js）の屋根の線の kind（壁の線は kind を持たない＝S1 の形のまま）。壁の線と屋根の線は1本にまとめない。 */
export const FACADE_ROOF_LINE_KIND = 'roof';
