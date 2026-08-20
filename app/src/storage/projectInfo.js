// 調査・計画情報（project.projectInfo = 敷地情報／建築情報ダイアログの入力値）の
// バイト列コーデック。プレーンJSONをUTF-8で包むだけ——FBSスキーマにしないのは、
// フォーム項目（30超・全て文字列/配列）が頻繁に増減する調査票であり、スキーマ管理の
// コストに見合わないため。db.js のレコード（bytes）規約と .stq エンベロープの両方で使う。
// 葉モジュール: 他の src を import しない（node:test から単体 import 可能に保つ）。

/** { siteInfo, buildingInfo } → Uint8Array（UTF-8 JSON） */
export function encodeProjectInfo(info) {
  return new TextEncoder().encode(JSON.stringify({
    siteInfo:     info?.siteInfo     ?? null,
    buildingInfo: info?.buildingInfo ?? null,
  }));
}

/** Uint8Array → { siteInfo, buildingInfo }。不正な内容は例外を投げる（呼び出し側が catch）。 */
export function decodeProjectInfo(bytes) {
  const data = JSON.parse(new TextDecoder().decode(bytes));
  return {
    siteInfo:     data?.siteInfo     ?? null,
    buildingInfo: data?.buildingInfo ?? null,
  };
}
