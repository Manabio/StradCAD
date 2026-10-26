// S0: 階ごとの実効主構造と階別上書きだけを出す。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/s0HeaderProbe.mjs <入力.stq> [出力.json]
import { openDoc, planeHeader, writeOut } from './s0Common.mjs';

const project = openDoc(process.argv[2]);
writeOut(process.argv[3] ?? null, {
  mainStructure: project.structuralInfo?.mainStructure ?? null,
  planes: planeHeader(project),
});
