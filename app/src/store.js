import { createContext, useContext } from 'react';
import { Project, CenterLineType } from '@core';

export const project = new Project(crypto.randomUUID(), '新規プロジェクト');

const { graph } = project.addPlane(0, '1FL');

// 通り芯 (addCenterLine の戻り値を保持して図形追加に使う)
const X1 = graph.addCenterLine(CenterLineType.VERTICAL,    0);
const X2 = graph.addCenterLine(CenterLineType.VERTICAL,  3640);
const X3 = graph.addCenterLine(CenterLineType.VERTICAL,  7280);
const Y1 = graph.addCenterLine(CenterLineType.HORIZONTAL,   0);
const Y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640);
const Y3 = graph.addCenterLine(CenterLineType.HORIZONTAL, 7280);

// テスト図形: 外周壁
graph.addVerticalLine(X1, Y1, Y3);
graph.addVerticalLine(X3, Y1, Y3);
graph.addHorizontalLine(Y1, X1, X3);
graph.addHorizontalLine(Y3, X1, X3);

// テスト図形: 内壁
graph.addVerticalLine(X2, Y1, Y3);
graph.addHorizontalLine(Y2, X1, X3);

// テスト図形: 斜線 (対角)
const nA = graph.intersectionMap.get(`${X1.id}:${Y1.id}`);
const nC = graph.intersectionMap.get(`${X2.id}:${Y2.id}`);
if (nA && nC) graph.addDiagonalLine(nA, nC);

export const StoreContext = createContext(project);
export function useStore() { return useContext(StoreContext); }
