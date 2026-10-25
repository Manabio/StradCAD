// openingPlanSymbolJsxHooks.mjs（.jsxのJSX変換・react-konva/mobx-react-liteのスタブ化）を
// 登録するだけの薄いブートストラップ。structPerfSetup.mjs と同じ位置づけ。
// 使い方（app/ で。node --import は複数指定できる）:
//   node --import ./scripts/testSetup.mjs --import ./scripts/probe/openingPlanSymbolJsxSetup.mjs \
//     scripts/probe/openingPlanSymbolProbe.mjs [引数...]
// scripts/testSetup.mjs（'@core' エイリアス解決）を先に import すること——ShapesLayer.jsx が
// '@core' で src/core.js を参照するため、それが無いと解決エラーになる。
// フックは registerHooks()（同期・同スレッド）で登録する——module.register() は Node 26 で
// 実行時非推奨（DEP0205）。testSetup.mjs と同じ方式。
import { registerHooks } from 'node:module';
import { resolve, load } from './openingPlanSymbolJsxHooks.mjs';

registerHooks({ resolve, load });
