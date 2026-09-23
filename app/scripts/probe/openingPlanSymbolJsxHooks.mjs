// 建具モード 平面記号（renderer/OpeningsLayer.jsx）の Konva props を node 上で直接評価するための
// ロードフック本体。structPerfHooks.mjs と同じ位置づけ（openingPlanSymbolJsxSetup.mjs から
// node:module の register() で登録される）。製品ソースは一切書き換えず、Node へ読み込む瞬間の
// ソース文字列だけを差し替える。
//   .jsx（app/src/ 配下）を rolldown/experimental の transformSync で ESM へ変換（JSX automatic
//     runtime。Vite が本番で行う変換と同じ入口を使う）
//   'react-konva' を文字列型スタブへ（Group='Group'等。実際にKonvaへ描画はしない——
//     要素ツリー（{type,props}）を組むところまでで十分なため）
//   'mobx-react-lite' の observer を恒等関数へ（MobXの購読は不要。呼び出し側で1回だけ呼ぶ）
// 対象拡張子は app/src/ 配下の .jsx のみ（OpeningsLayer.jsx が静的 import する ShapesLayer.jsx も
// 同じ変換を通す）。app/src/ 配下以外・.jsx 以外はそのまま nextLoad へ委譲する。
//
// 使い方: 単体では効果を持たない。openingPlanSymbolJsxSetup.mjs を node --import で
// scripts/testSetup.mjs（'@core' エイリアス解決）の後に登録してから使う。
import fs from 'node:fs';
import { transformSync } from 'rolldown/experimental';

const STUB_SPECIFIERS = new Map([
  ['react-konva', `export const Group='Group',Line='Line',Rect='Rect',Path='Path',Circle='Circle';`],
  ['mobx-react-lite', `export function observer(f){ return f; }`],
]);

export async function resolve(specifier, context, nextResolve) {
  if (STUB_SPECIFIERS.has(specifier)) {
    return { url: `openingplansymbolstub:${specifier}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('openingplansymbolstub:')) {
    const name = url.slice('openingplansymbolstub:'.length);
    return { format: 'module', source: STUB_SPECIFIERS.get(name), shortCircuit: true };
  }
  if (url.includes('/app/src/') && url.endsWith('.jsx')) {
    // node は .jsx の形式を判定できず nextLoad へ委譲できない（ERR_UNKNOWN_FILE_EXTENSION）ため、
    // ソースはここで直接読む（テスト・ビルドを経由しない調査用フックのみの特例。他の.jsフックは
    // nextLoad を使う既存流儀＝structPerfHooks.mjsのまま）。
    const path = new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const raw = fs.readFileSync(path, 'utf8');
    const { code, errors } = transformSync(path, raw, {});
    if (errors && errors.length) {
      throw new Error(`[openingPlanSymbolJsxHooks] transformSync失敗 ${url}: ${JSON.stringify(errors)}`);
    }
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
