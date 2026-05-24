import { createContext, useContext } from 'react';
import { Project, CenterLineType, Discipline } from '@core';

export const project = new Project(crypto.randomUUID(), '新規プロジェクト');

const { graph } = project.addPlane(0, '1FL');

const clProps = { discipline: Discipline.STRUCT };
graph.addCenterLine(CenterLineType.VERTICAL,   0, clProps);
graph.addCenterLine(CenterLineType.HORIZONTAL, 0, clProps);

export const StoreContext = createContext(project);
export function useStore() { return useContext(StoreContext); }
