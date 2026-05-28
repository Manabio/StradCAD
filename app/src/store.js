import { createContext, useContext } from 'react';
import {
  Project, CenterLineType, Discipline,
  HDimensionLine, VDimensionLine, DimensionKind, DimensionSide,
} from '@core';

export const project = new Project(crypto.randomUUID(), '新規プロジェクト');

const { graph } = project.addPlane(0, '1FL');

const clProps = { discipline: Discipline.STRUCT };
graph.addCenterLine(CenterLineType.VERTICAL,   0, clProps);
graph.addCenterLine(CenterLineType.HORIZONTAL, 0, clProps);

// 通り芯寸法線 — 4 周に GRID 寸法線を配置 (CL 追加・削除・移動に自動追従)
graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.TOP    });
graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.BOTTOM });
graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.LEFT   });
graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.RIGHT  });

export const StoreContext = createContext(project);
export function useStore() { return useContext(StoreContext); }
