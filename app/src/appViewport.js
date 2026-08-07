import { Viewport } from './viewport.js';
import { RULER } from './layout.js';

// アプリ全体で共有する単一の Viewport インスタンス。
// viewport.js 本体には置かない：window 依存がここに閉じていることで、
// viewport.js を import する純モジュールを node:test から実行できる状態を保つ。
export const viewport = new Viewport(window.innerWidth, window.innerHeight, RULER, RULER);
