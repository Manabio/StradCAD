// 文書ファイル（.stq）の書き出し・読み込みパース処理。App.jsx から抽出し、
// ディスパッチ（id分岐）・FileReader配線・toast表示は App.jsx に残す。
// 旧「読込み/書出し」メニューが使っていた localStorage 自動保存（単一グラフ）は廃止済み——
// 残骸キーの掃除だけを clearLocalAutosave が担う。

// 旧・単一グラフ自動保存のキー（廃止済み。現在は掃除のためだけに参照する）。
const LEGACY_AUTOSAVE_KEY = 'strad-autosave';

// 旧・自動保存データの残骸を消去する（「新規（全消去）」メニュー専用）。キー文字列の唯一の
// 所有者はこのモジュール——他モジュール（store.js 等）はハードコードしないこと。
export function clearLocalAutosave() {
  localStorage.removeItem(LEGACY_AUTOSAVE_KEY);
}

// 「読込み」した文書ファイル名（File.name そのまま・拡張子付き）の localStorage キー。読込みは
// location.reload() を伴うため reload をまたいで残す。キー文字列の唯一の所有者はこのモジュール。
const OPENED_FILE_NAME_KEY = 'strad-opened-file-name';

// 読込みした文書ファイル名。未設定なら null。
export function getOpenedFileName() {
  return localStorage.getItem(OPENED_FILE_NAME_KEY);
}

export function setOpenedFileName(name) {
  localStorage.setItem(OPENED_FILE_NAME_KEY, name);
}

export function clearOpenedFileName() {
  localStorage.removeItem(OPENED_FILE_NAME_KEY);
}

// 読込みしたファイル名から保存ダイアログ用の名前（拡張子なし）を得る。末尾の .stq（大小無視）だけを外す。
export function saveNameFromOpenedFileName(name) {
  return name.replace(/\.stq$/i, '');
}

// 既定の文書ファイル名（拡張子なし・保存日時入り）。保存ダイアログの初期値に使う。
export function defaultDocumentFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `strad-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 文書ファイル（JSONエンベロープ文字列。store.js の exportDocument が構築）を
// .stq としてダウンロード書き出しする（「読込み」が読める形式）。
// fileName は拡張子なしでも可（.stq を補う）。省略時は既定名。
export function downloadDocumentFile(json, fileName = defaultDocumentFileName()) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const name = fileName.endsWith('.stq') ? fileName : `${fileName}.stq`;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// 「ファイルを開く」で読み込んだバイト列（JSON=旧形式 or FlatBuffers=新形式）を
// restoreGraph に渡せる形へパースする。不正な内容は例外を投げる。
export function parseOpenedFileBytes(bytes) {
  return bytes[0] === 0x7B // '{' = JSON
    ? JSON.parse(new TextDecoder().decode(bytes))
    : bytes;
}
