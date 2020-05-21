import { useCallback, useState, useMemo } from 'react';
import { NestTree, DataSource, Record, Measure, Filter } from './common';
import produce from 'immer';
import { sum } from 'cube-core';
import { momentCube } from 'cube-core/built/core';
import { Node } from 'cube-core/built/core/momentCube';
import { VisType, Field } from './common';
import { getTheme } from './theme';
import { DynamicCube, Cuboid } from './cube';
const theme = getTheme();
export function useNestTree () {
  let [nestTree, setNestTree] = useState<NestTree>({ id: theme.root.label, path: [] });
  const repaint = useCallback((path: number[]) => {
    setNestTree(tree => {
      const newTree = produce(tree, draft => {
        let node = draft;
        for (let i of path) {
          node = node.children[i];
        }
        node.expanded = !node.expanded;
      })
      return newTree
    });
  }, [setNestTree]);
  return { nestTree, setNestTree, repaint }
}
const alphabetCmp = (a: any, b: any) => {
  if (a > b) return 1;
  if (a === b) return 0;
  if (a < b) return -1;
}
export function sortPureNestTree (tree: NestTree, dimensions: Field[], depth: number = 0) {
  if (depth <= dimensions.length && tree.children && tree.children.length > 0) {
    if (dimensions[depth].cmp) {
      tree.children.sort((a, b) => dimensions[depth].cmp(a.id, b.id))
    } else {
      tree.children.sort((a, b) => alphabetCmp(a.id, b.id))
    }
    for (let child of tree.children) {
      sortPureNestTree(child, dimensions, depth + 1)
    }
  }
}
export function getPureNestTree (dataSource: DataSource, dimensions: string[]) {
  let hashTree: HashTree = new Map();
  let dataLen = dataSource.length;
  for (let i = 0; i < dataLen; i++) {
    insertNode(hashTree, dimensions, dataSource[i], 0);
  }
  return transHashTree2NestTree(hashTree);
}
interface HashTree extends Map<string, HashTree> {};

function insertNode (tree: HashTree, dimensions: string[], record: Record, depth: number) {
  if (depth === dimensions.length) {
    return;
  }
  let childKey = record[dimensions[depth]];
  if (!tree.has(childKey)) {
    tree.set(childKey, new Map())
  }
  insertNode(tree.get(childKey), dimensions, record, depth + 1);
}

function transHashTree2NestTree (hasTree: HashTree) {
  let tree: NestTree = { id: theme.root.label };
  transHashDFS(hasTree, tree);
  return tree;
}

function transHashDFS (hashNode: HashTree, node: NestTree) {
  if (hashNode.size === 0) {
    return;
  }
  node.children = []
  for (let child of hashNode) {
    let childInNode: NestTree = { id: child[0] };
    transHashDFS(child[1], childInNode)
    node.children.push(childInNode);
  }
}

export function transTree2LeafPathList (tree: NestTree, hasAggChild: boolean): string[][] {
  let lpList: string[][] = [];
  // 根左右序
  const dfs = (node: NestTree, path: string[]) => {
    if (hasAggChild) {
      lpList.push(path);
    } else {
      if (!(node.expanded && node.children && node.children.length > 0)) {
        lpList.push(path);
      }
    }
    if (node.expanded && node.children && node.children.length > 0) {
      for (let child of node.children) {
        dfs(child, [...path, child.id]);
      }
    }
  }
  dfs(tree, []);
  return lpList;
}
interface QueryNode {
  dimCode: string;
  dimValue: string
}
export type QueryPath = QueryNode[];
/**
 * 
 * @param cube 
 * @param path 
 * @param cubeDimensions 
 * @param measures 
 */
export function queryCube(cube: momentCube, path: QueryPath, cubeDimensions: string[]): DataSource {
  let tree = cube.tree;
  let queryPath: QueryPath = [];
  for (let dim of cubeDimensions) {
    let target = path.find(p => p.dimCode === dim);
    if (target) {
      queryPath.push(target)
    } else{ 
      queryPath.push({
        dimCode: dim,
        dimValue: '*'
      })
    }
  }
  let queryNodeList: Node[] = queryNode(tree, queryPath, 0);
  let subset: DataSource = [];
  for (let node of queryNodeList) {
    for (let record of node.rawData) {
      subset.push(record);
    }
  }
  return subset;
}

function queryNode(node: Node, path: QueryPath, depth: number): Node[] {
  if (depth >= path.length) return [];
  const targetMember = path[depth].dimValue;
  const children = [...node.children.entries()];
  if (depth === path.length - 1) {
    if (targetMember === '*') {
      return children.map(child => child[1]);
    }
    return children.filter(child => {
      return child[0] === targetMember;
    }).map(child => child[1])
  }
  let ans: Node[] = [];
  for (let child of children) {
    if (targetMember === '*' || child[0] === targetMember) {
      ans.push(...queryNode(child[1], path, depth + 1))
    }
  }
  return ans;
}

function aggregateAll(dataSource: DataSource, measures: Measure[]): Record {
  // todo different handler for holistic and algebra.
  let result: Record = {};
  for (let mea of measures) {
    let aggObj = mea.aggregator ? mea.aggregator(dataSource, [mea.id]) : sum(dataSource, [mea.id]);
    result[mea.id] = aggObj[mea.id];
  }
  return result;
}

export function getCossMatrix(visType: VisType, cube: momentCube, rowLPList: string[][] = [], columnLPList: string[][] = [], rows: string[], columns: string[], measures: Measure[], dimensionsInView: string[]): Record[][] | Record[][][] {
  const rowLen = rowLPList.length;
  const columnLen = columnLPList.length;
  const dimensions = rows.concat(columns)
  let crossMatrix: Array<Array<Record>> = [];
  // function getCell (node: Node, path: string[], depth: number): Record {
  //   if (typeof node === 'undefined') return null;
  //   if (depth === path.length) {
  //     return node._aggData;
  //   }
  //   return getCell(node.children.get(path[depth]), path, depth + 1);
  // }
  for (let i = 0; i < rowLen; i++) {
    crossMatrix.push([])
    for (let j = 0; j < columnLen; j++) {
      let path: QueryPath = [
        ...rowLPList[i].map((d, i) => ({
          dimCode: rows[i],
          dimValue: d
        })),
        ...columnLPList[j].map((d, i) => ({
          dimCode: columns[i],
          dimValue: d
        }))
      ]
      let result = queryCube(cube, path, dimensions);
      switch (visType) {
        case 'bar':
        case 'line':
        case 'scatter':
          crossMatrix[i].push(aggregateOnGroupBy(result, dimensionsInView, measures));
          break;
        // case 'scatter':
        //   crossMatrix[i].push(result);
        //   break;
        case 'number':
        default:
          crossMatrix[i].push(aggregateAll(result, measures));
          break;
      }
    }
  }
  return crossMatrix;
}

interface NestFields {
  nestRows: Field[];
  nestColumns: Field[];
  dimensionsInView: Field[];
  facetMeasures: Measure[];
  viewMeasures: Measure[];
}
export function getNestFields(visType: VisType, rows: Field[], columns: Field[], measures: Measure[]): NestFields  {
  switch(visType) {
    case 'number':
      return {
        nestRows: rows,
        nestColumns: columns,
        dimensionsInView: [],
        facetMeasures: measures,
        viewMeasures: measures
      }
    case 'bar':
    case 'line':
      return {
        nestRows: rows,
        nestColumns: columns.slice(0, -1),
        dimensionsInView: columns.slice(-1),
        facetMeasures: measures,
        viewMeasures: measures
      }
    case 'scatter':
      return {
        nestRows: rows,
        nestColumns: columns.slice(0, -1),
        dimensionsInView: columns.slice(-1),
        facetMeasures: measures,
        viewMeasures: measures.slice(-1),
      };
    default:
      return {
        nestRows: rows,
        nestColumns: columns,
        dimensionsInView: [],
        facetMeasures: measures,
        viewMeasures: measures
      }
  }
}

export function useNestFields (visType: VisType, rows: Field[], columns: Field[], measures: Measure[]): NestFields {
  const nestRows = rows;
  const { nestColumns, dimensionsInView } = useMemo(() => {
    if (visType !== 'number') {
      return {
        nestColumns: columns.slice(0, -1),
        dimensionsInView: columns.slice(-1)
      };
    }
    return {
      nestColumns: columns,
      dimensionsInView: []
    };
  }, [visType, columns]);
  const { facetMeasures, viewMeasures } = useMemo(() => {
    if (visType === 'scatter') {
      return {
        facetMeasures: measures,
        viewMeasures: measures.slice(-1)
      }
    }
    return {
      facetMeasures: measures,
      viewMeasures: measures
    }
  }, [visType, measures]);
  return {
    nestRows,
    nestColumns,
    dimensionsInView,
    facetMeasures,
    viewMeasures
  }
}

export function aggregateOnGroupBy(dataSource: DataSource, fields: string[], measures: Measure[]): DataSource {
  let groups = new Map<string, DataSource>();
  // todo: support multi-dimensions.
  let field = fields[0];
  let data: DataSource = [];
  for (let record of dataSource) {
    if (!groups.has(record[field])) {
      groups.set(record[field], [])
    }
    groups.get(record[field]).push(record);
  }
  for (let dataFrame of groups.entries()) {
    let record: Record = {
      [field]: dataFrame[0]
    }
    for (let mea of measures) {
      record[mea.id] = (mea.aggregator || sum)(dataFrame[1], [mea.id])[mea.id];
    }
    data.push(record)
  }
  return data;
}

export type cmpFunc = (a: string, b: string) => number;
export class AsyncCacheCube {
  private dynamicCube: DynamicCube;
  private dimensions: string[];
  private asyncCubeQuery: (path: QueryPath, measures: string[]) => Promise<DataSource>;
  // private measures: string
  private dimCompare: cmpFunc = (a: string, b: string) => {
    if (a > b) return 1;
    if (a === b) return 0;
    if (a < b) return -1;
  }
  constructor (props: { dimensions?: string[]; cmp?: cmpFunc; asyncCubeQuery: (path: QueryPath, measures: string[]) => Promise<DataSource>; }) {
    const { dimensions, cmp, asyncCubeQuery } = props;
    if (cmp) {
      this.dimCompare = cmp;
    } 
    // this.dimensions = [...dimensions].sort(cmp);
    this.dynamicCube = new DynamicCube({ computeCuboid: asyncCubeQuery });
    this.asyncCubeQuery = asyncCubeQuery;
  }
  // public appendDimension(dimension: string) {
  //   let i = 0;
  //   for (; i < this.dimensions.length; i++) {
  //     let cmp = this.dimCompare(dimension, this.dimensions[i]);
  //     if (cmp === 1) {
  //       break;
  //     } else if (cmp === 0) {
  //       return;
  //     }
  //   }
  //   this.dimensions.splice(i, 1, dimension);
  // }
  // public deleteDimension(dimension: string) {
  //   for (let i = 0; i < this.dimensions.length; i++) {
  //     let cmp = this.dimCompare(dimension, this.dimensions[i]);
  //     if (cmp === 0) {
  //       this.dimensions.splice(i, 1);
  //       break;
  //     }
  //   }
  // }
  // private encode (values: string[]): string {
  //   return values.join('-');
  // }
  public async cacheQuery (originPath: QueryPath, measures: string[]): Promise<DataSource> {
    const path: QueryPath = [...originPath].sort((a, b) => this.dimCompare(a.dimCode, b.dimCode));
    const cuboidKey = path.map(p => p.dimCode);
    const cuboid = await this.dynamicCube.getCuboid(cuboidKey, measures);
    return cuboid.get(path);
  }
  public async getCuboidNestTree (originPath: Field[], branchFilters?: Filter[]): Promise<NestTree> {
    const originPathCode = originPath.map(p => p.id);
    const pathCode: string[] = [...originPathCode].sort(this.dimCompare);
    const cuboid = await this.dynamicCube.getCuboid(pathCode, []);
    let viewData = cuboid.dataSource;
    if (branchFilters && branchFilters.every(f => originPathCode.includes(f.id))) {
      viewData = cuboid.dataSource.filter(record => {
        // must use == not === for key in map is string while the origin value is number, might try 
        return branchFilters.every(f => f.values.find(v => v == record[f.id]));
      })
    }
    const pureNestTree = getPureNestTree(viewData, originPathCode);
    sortPureNestTree(pureNestTree, originPath, 0);
    return pureNestTree;
  }
  public async requestCossMatrix(visType: VisType, rowLPList: string[][] = [], columnLPList: string[][] = [], rows: Field[], columns: Field[], measures: Measure[], dimensionsInView: Field[]): Promise<Record[][] | Record[][][]> {
    const rowLen = rowLPList.length;
    const columnLen = columnLPList.length;
    let crossMatrix: Array<Array<Record>> = [];
    let measureCodeList = measures.map(m => m.id);
    for (let i = 0; i < rowLen; i++) {
      crossMatrix.push([])
      for (let j = 0; j < columnLen; j++) {
        let path: QueryPath = [
          ...rowLPList[i].map((d, index) => ({
            dimCode: rows[index].id,
            dimValue: d
          })),
          ...columnLPList[j].map((d, index) => ({
            dimCode: columns[index].id,
            dimValue: d
          }))
        ]
        for (let dim of dimensionsInView) {
          path.push({
            dimCode: dim.id,
            dimValue: '*'
          });
        }
        let result = await this.cacheQuery(path, measureCodeList);
        switch (visType) {
          case 'bar':
          case 'line':
          case 'scatter':
            crossMatrix[i].push(result);
            break;
          case 'number':
          default:
            crossMatrix[i].push(result[0]);
            break;
        }
      }
    }
    return crossMatrix;
  }
}

export function arrayEqual(arr1: any[], arr2: any[]): boolean {
  if (arr1.length !== arr2.length) return false;
  for (let i = 0; i < arr1.length; i++) {
    if (arr1[i] !== arr2[i]) return false;
  }
  return true;
}

export function labelHighlightNode(tree: NestTree, valuePath: any[], hlPath: any[], depth: number): void {
  tree.isHighlight = true;
  if (tree.children) {
    for (let child of tree.children) {
      // == not ===
      if (child.id == hlPath[depth]) {
        labelHighlightNode(child, [...valuePath, child.id], hlPath, depth + 1);
      }
    }
  }
}

export function clearHighlight(tree: NestTree): void {
  tree.isHighlight = false;
  if (tree.children) {
    for (let child of tree.children) {
      clearHighlight(child);
    }
  }
}