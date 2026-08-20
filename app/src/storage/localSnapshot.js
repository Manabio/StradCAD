// ハンバーガーメニューの「読込/書出」（localStorage 自動保存）・ファイル読込のパース処理。
// App.jsx から抽出。ディスパッチ（id分岐）・FileReader配線・toast表示は App.jsx に残す。
import { serializeGraph } from '../graphSnapshot.js';

const AUTOSAVE_KEY = 'strad-autosave';

// localStorage の自動保存データ（生文字列）を読む。未保存なら null。
export function readLocalAutosaveRaw() {
  return localStorage.getItem(AUTOSAVE_KEY);
}

// 自動保存データを消去する（「新規（全消去）」メニュー専用）。AUTOSAVE_KEY の唯一の所有者は
// このモジュール——他モジュール（store.js 等）はキー文字列をハードコードしないこと。
export function clearLocalAutosave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}

// 自動保存データ（base64=新形式 or JSON文字列=旧形式）を restoreGraph に渡せる形へパースする。
// 不正な内容は例外を投げる（呼び出し側が catch して toast を出す）。
export function parseAutosaveData(raw) {
  return raw.trimStart().startsWith('{')
    ? JSON.parse(raw)
    : Uint8Array.from(atob(raw), c => c.charCodeAt(0));
}

// 現在のグラフを base64 化して localStorage へ書き出す（大容量でも安全な変換方式）。
export function writeLocalAutosave(graph) {
  const bytes = serializeGraph(graph);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  localStorage.setItem(AUTOSAVE_KEY, btoa(binary));
}

// 既定の文書ファイル名（拡張子なし・保存日時入り）。保存ダイアログの初期値に使う。
export function defaultDocumentFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `strad-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 文書ファイル（JSONエンベロープ文字列。store.js の exportDocument が構築）を
// .stq としてダウンロード書き出しする（「開く」が読める形式）。
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
