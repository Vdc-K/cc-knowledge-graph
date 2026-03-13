/**
 * Knowledge Graph Query — 子图查询模块
 *
 * queryGraph(graph, keyword, depth=2)
 * 模糊匹配节点 -> BFS 扩展 -> 返回子图
 */

/**
 * 查询子图
 * @param {Object} graph - 完整图谱 { nodes, edges }
 * @param {string} keyword - 搜索关键词
 * @param {number} depth - BFS 扩展深度，默认 2
 * @returns {{ nodes: Array, edges: Array }}
 */
function queryGraph(graph, keyword, depth = 2) {
  if (!keyword || !graph || !graph.nodes) {
    return { nodes: [], edges: [] };
  }

  const kw = keyword.toLowerCase();

  // 1. 模糊匹配种子节点（id / label / tags）
  const seedIds = new Set();
  for (const node of graph.nodes) {
    const idMatch = node.id && node.id.toLowerCase().includes(kw);
    const labelMatch = node.label && node.label.toLowerCase().includes(kw);
    const tagsMatch = node.tags && node.tags.some(t => t.toLowerCase().includes(kw));
    if (idMatch || labelMatch || tagsMatch) {
      seedIds.add(node.id);
    }
  }

  // 2. 构建邻接表（双向）
  const adjacency = new Map(); // nodeId -> Set<nodeId>
  const edgeIndex = new Map(); // nodeId -> [edge, ...]

  for (const edge of (graph.edges || [])) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);

    if (!edgeIndex.has(edge.source)) edgeIndex.set(edge.source, []);
    if (!edgeIndex.has(edge.target)) edgeIndex.set(edge.target, []);
    edgeIndex.get(edge.source).push(edge);
    edgeIndex.get(edge.target).push(edge);
  }

  // 3. BFS 扩展
  const visited = new Set(seedIds);
  let frontier = [...seedIds];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier = [];
    for (const nodeId of frontier) {
      const neighbors = adjacency.get(nodeId);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextFrontier.push(neighbor);
        }
      }
    }
    frontier = nextFrontier;
  }

  // 4. 提取子图
  const nodeMap = new Map();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }

  const resultNodes = [];
  for (const id of visited) {
    const node = nodeMap.get(id);
    if (node) resultNodes.push(node);
  }

  // 只包含子图内部的边（source 和 target 都在 visited 中）
  const resultEdges = (graph.edges || []).filter(
    e => visited.has(e.source) && visited.has(e.target)
  );

  return { nodes: resultNodes, edges: resultEdges };
}

module.exports = { queryGraph };
