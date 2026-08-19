---
name: team-lessons
description: Project-specific lessons learned — failure-catalog entries accumulated via the learning loop. Owned by this project; ccteams never overwrites this file.
---

# Team Lessons (this project)

Durable, project-specific additions to the active team's playbook. ccteams
scaffolded this file once and will never touch it again — it survives team
switches and package updates.

Entries arrive via the learning loop: when a mistake surfaces that the
playbook did not predict, the orchestrator proposes an entry here in the
standard format. Keep it lean — before adding, check whether an existing
entry (here or in the playbook) already covers the case and sharpen that
instead. If a lesson is universal to the stack rather than specific to this
project, contribute it upstream to the team's playbook in the ccteams repo.

## Failure catalog — symptom → wrong instinct → correct move

### 描画レイヤの幾何バグに対する回帰テストがトートロジー化する（2026-08-10 建具バリエーション追加で発生）

- **症状**: レンダラ（`renderer/*.jsx`）のバグ修正に対し、幾何を純モジュールへ抽出して
  テストを追加したが、テストはヘルパを直接呼んで「正しい引数を渡せば正しい結果になる」
  ことだけを確認していた。本番の呼び出し側が正しい引数を渡すかは検証されておらず、
  バグを1文字戻しても全テストが緑のままだった。
- **誤った直感**: 「JSXはテストできない」（→ テスト0本で提出）。および「純関数に
  切り出してテストを書いた＝回帰は防げる」。
- **正しい動き**:
  1. 本リポジトリには角度・座標計算を純モジュールへ抽出して `node:test` で検証する
     確立パターンがある（`openings/openingTagPlacement.js` ⇄ `renderer/OpeningTagLayer.jsx`、
     `renderer/clMoveMath.test.js`）。抽出モジュールは react-konva / store.js / snap.js /
     .jsx を静的に引かないこと。
  2. 抽出の単位は「計算式」ではなく「**呼び出し側が下していた判断**」にする
     （例: どのleafをどの符号で描くか＝`*LeafSpecs` がレンダラの唯一の供給源）。
  3. テストが本番経路を守っているかは、**バグを1文字戻して `npm test` が赤になるか**
     （変異テスト）で必ず確認し、その出力を報告に貼る。緑のままなら、そのテストは
     存在しないのと同じ。レビュー側も変異テストを自分で再実行して合否を判定する。
  4. `openingGeometry.js` のように符号規約がコメントで明文化されている場合
     （`perpDir = (isVertical?1:-1)*swingSide*hingeSide`）、それは新コードが満たすべき
     テスト可能な不変条件として読むこと。

### PowerShell のテキスト置換で UTF-8 ソースの日本語が非可逆破損する（2026-08-19 変異テスト実施中に発生）

- **症状**: 変異テストのために `Get-Content -Raw | -replace | Set-Content` で `floorOps.js` を
  書き換えたところ、日本語コメントが文字化けし、改行まで巻き込まれて構文エラー化した。
  PowerShell 5.1 の `Get-Content` は BOM 無し UTF-8 を ANSI(cp932) として誤読し、
  マルチバイト列が改行バイトを喰う many-to-one 変換のため**逆変換でも復元できない**。
- **誤った直感**: 「ASCII 部分の1語置換だから安全」「壊れても逆のエンコード変換で戻せる」。
  さらに最初の変異ラン赤化を「テストが守っている証拠」と解釈したが、実際は
  ファイル全体の parse エラーによる赤で、検証としても無効だった。
- **正しい動き**:
  1. ソースの機械的書換え（変異注入・復元を含む）は必ず **Edit ツール**で行う。
     PowerShell/シェルのテキスト置換パイプは UTF-8 ソースに対して使用禁止。
  2. 変異テストの赤化確認は「**狙ったテストだけ**が落ちたか」まで見る。テストファイル
     全体の ✖ や件数の減少（例: 722→695）は parse エラーのサインで、検証無効。
  3. 破損に気付いたら即座に `git diff --stat` で被害範囲を特定する。未コミットの
     変更を含むファイルは `git checkout` で戻せないため、HEAD 版の復元
    （`git show HEAD:path > path`）＋把握済み差分の再適用で再構築し、
     差分が想定どおりか（追加のみ・行数一致）とフルテストで検証する。

### 描画ディテールの指示を「関連描画の全面見直し」に拡大解釈する（2026-08-18 展開図の開放スパンで発生）

- **症状**: ユーザーの指示「境界のエッジ縦線が期待と異なる」に対し、builder が指示されていない
  「アキ」マークの全廃まで実施した。ユーザーから「出力は前回の方が良かった。指示以外の処理を
  する前に承認をとって」と差し戻された。
- **誤った直感**: 「期待図に描かれていない要素は消すのが正しい」「同じコードパスの周辺も
  一緒に直すのが親切」。
- **正しい動き**:
  1. 描画ディテールの指示は**列挙された項目のみ**を変更する。期待図に無い要素の削除・
     周辺挙動の変更は「指示以外の処理」であり、実装前にコーディネータ経由でユーザー承認を得る。
  2. 迷ったら「指示された最小差分」と「ついでに直したい候補」を分けて報告し、後者は
     提案に留める（実装しない）。
  3. ユーザー承認済みの描画状態はテストで固定されるため、拡大解釈の変更はテスト書き換えを
     伴う——**承認済み挙動のテストを書き換える必要が生じたら、それは拡大解釈のサイン**。
