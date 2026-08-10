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
