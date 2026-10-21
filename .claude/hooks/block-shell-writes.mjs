// PreToolUse（Bash）フック: シェル経由のファイル書込み・標準入力からのスクリプト実行を実行前に止める。
// 理由: 委譲先がヒアドキュメント等でファイルを書き、UTF-8 の日本語ソースを壊す・孤児プロセスが残る事故が
// 繰り返し起きた（team-lessons「委譲先が、禁止を明記していたのにヒアドキュメントでファイルへ追記した」）。
// 標準入力に Claude Code のフック入力 JSON が来る。止めるときは permissionDecision: 'deny' を返す。
import { readFileSync } from 'node:fs';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // 入力が読めないときは何もしない（フックの不具合で全 Bash を止めない）
}
const cmd = String(input?.tool_input?.command ?? '');

// /dev/null への捨てる出力は書込みではないので除く
const toFile = (s) => !/^\s*\/dev\/null\b/.test(s);

const rules = [
  {
    name: 'ヒアドキュメント（<<EOF・<<\'EOF\'・<<-EOF）',
    test: (c) => /(^|[^<])<<-?\s*['"]?[A-Za-z_]/.test(c),
  },
  {
    name: '`python -`（標準入力からのスクリプト実行）',
    test: (c) => /\bpython[0-9.]*(?:\.exe)?\s+-(?:\s|$)/.test(c),
  },
  {
    name: '`tee` によるファイル書込み',
    test: (c) => [...c.matchAll(/\btee\b((?:\s+-[a-zA-Z]+)*)\s+(\S+)/g)].some(m => toFile(m[2])),
  },
  {
    name: '`cat`・`echo`・`printf` のリダイレクトによるファイル書込み',
    test: (c) => [...c.matchAll(/\b(?:cat|echo|printf)\b[^|;&\n]*?(?<![0-9&])>{1,2}\s*([^\s;&|]+)/g)].some(m => toFile(m[1])),
  },
  {
    name: '`node -e` でのファイル書込み',
    test: (c) => /\bnode(?:\.exe)?\s+(?:-e|--eval)\b/.test(c) && /writeFile|appendFile|createWriteStream/.test(c),
  },
];

const hit = rules.find(r => r.test(cmd));
if (!hit) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason:
      `このプロジェクトでは ${hit.name} を使えません。ファイルの作成・追記・書換えは Edit／Write ツールで行い、` +
      'スクリプトは Write でファイルに書いてから `node ファイル名` で実行してください（.claude/hooks/block-shell-writes.mjs）。',
  },
}));
