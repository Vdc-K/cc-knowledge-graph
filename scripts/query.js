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

// ==================== Memory 发现 ====================

const fs = require('fs');
const path = require('path');

/**
 * 自动发现 Claude Code memory 目录
 * 扫描 ~/.claude/projects/ 下匹配当前项目目录的文件夹
 */
function findMemoryDir(projectDir) {
  const projectsBase = path.join(process.env.HOME || '', '.claude', 'projects');
  if (!fs.existsSync(projectsBase)) return null;

  // Claude Code 编码规则：/ → -，保留开头的 -
  // 先尝试精确编码匹配，再 fallback 到全路径解码匹配
  const encoded = projectDir.replace(/\//g, '-');  // "/Users/hhl/OnlyClaude" → "-Users-hhl-OnlyClaude"

  try {
    const dirs = fs.readdirSync(projectsBase);

    // 优先：精确编码匹配
    if (dirs.includes(encoded)) {
      const memDir = path.join(projectsBase, encoded, 'memory');
      if (fs.existsSync(memDir)) return memDir;
    }

    // Fallback：解码后完整路径匹配（处理编码规则变化的情况）
    for (const dir of dirs) {
      const decoded = '/' + dir.replace(/^-/, '').replace(/-/g, '/');
      if (decoded === projectDir) {
        const memDir = path.join(projectsBase, dir, 'memory');
        if (fs.existsSync(memDir)) return memDir;
      }
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * 从 memory 目录加载匹配的记忆
 */
function loadMemory(projectDir, query) {
  const memoryDir = findMemoryDir(projectDir);
  if (!memoryDir) return [];

  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
  const results = [];

  try {
    const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');

    for (const file of files) {
      const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');

      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)/m);
      const descMatch = fm.match(/^description:\s*(.+)/m);
      const typeMatch = fm.match(/^type:\s*(.+)/m);

      const name = nameMatch ? nameMatch[1].trim() : file.replace('.md', '');
      const description = descMatch ? descMatch[1].trim() : '';
      const type = typeMatch ? typeMatch[1].trim() : 'unknown';

      const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      const searchText = (description + ' ' + body).toLowerCase();
      const isRelevant = keywords.some(k => searchText.includes(k));

      if (isRelevant || keywords.length === 0) {
        results.push({ name, description, type, body });
      }
    }
  } catch { /* ignore */ }

  return results;
}

/**
 * 加载 session-memory（上次会话状态）
 * @param {string} sessionFile - session memory 文件路径（绝对或相对于 projectDir）
 */
function loadSession(projectDir, sessionFile) {
  if (!sessionFile) return null;

  const absPath = path.isAbsolute(sessionFile)
    ? sessionFile
    : path.join(projectDir, sessionFile);

  if (!fs.existsSync(absPath)) return null;

  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const sections = {};

    // 按 ## 标题分割（如果有），否则按 # 标题分割
    const hasH2 = /^## /m.test(content);
    const headerPrefix = hasH2 ? '##' : '#';
    const headerRegex = new RegExp(`^${headerPrefix}\\s+(.+)`, 'gm');

    const headers = [...content.matchAll(headerRegex)];
    for (let i = 0; i < headers.length; i++) {
      const title = headers[i][1].trim();
      const start = headers[i].index + headers[i][0].length;
      const end = i + 1 < headers.length ? headers[i + 1].index : content.length;
      const body = content.substring(start, end).replace(/\n---[\s\S]*$/, '').trim();
      if (body) sections[title] = body;
    }

    // 如果没有标题结构，把 **key**：value 格式的行提取出来
    if (Object.keys(sections).length === 0) {
      const kvRegex = /\*\*(.+?)\*\*[：:]\s*(.+)/g;
      let m;
      while ((m = kvRegex.exec(content)) !== null) {
        sections[m[1].trim()] = m[2].trim();
      }
    }

    return Object.keys(sections).length > 0 ? sections : null;
  } catch { return null; }
}

/**
 * 聚合上下文：KG + memory + session-memory
 * @param {Object} options
 * @param {Object} options.graph - 图谱数据（可选，没有就跳过 KG）
 * @param {string} options.query - 查询关键词
 * @param {string} options.projectDir - 项目目录
 * @param {string} [options.sessionFile] - session memory 文件路径
 * @returns {string} - 格式化的 Markdown 上下文
 */
function queryContext({ graph, query, projectDir, sessionFile }) {
  const output = [`## 上下文：${query}\n`];
  let hasContent = false;

  // Layer 1: KG
  if (graph) {
    const subgraph = queryGraph(graph, query);
    if (subgraph.nodes.length > 0) {
      hasContent = true;
      output.push('### 知识图谱');

      const byType = {};
      for (const node of subgraph.nodes) {
        if (!byType[node.type]) byType[node.type] = [];
        byType[node.type].push(node);
      }

      const typeLabels = {
        skill: '相关 Skill', code: '相关代码', thinking: '相关思考',
        decision: '相关决策', project: '相关项目', roadmap: '路线图', phantom: '悬空引用',
      };
      const typeOrder = ['skill', 'code', 'thinking', 'decision', 'project', 'roadmap', 'phantom'];

      for (const type of typeOrder) {
        const nodes = byType[type];
        if (!nodes || nodes.length === 0) continue;
        output.push(`**${typeLabels[type] || type}**`);
        for (const node of nodes) {
          const fileHint = node.file ? ` → \`${node.file}\`` : '';
          const phantom = node.phantom ? ' ⚠️ phantom' : '';
          output.push(`- ${node.id}${fileHint}${phantom}`);
        }
      }
      output.push('');
    }
  }

  // Layer 2: Memory
  const memories = loadMemory(projectDir, query);
  if (memories.length > 0) {
    hasContent = true;
    output.push('### 约束 / 记忆');

    const typeLabels = { feedback: '⚠️ 约束', user: '👤 用户', project: '📋 项目', reference: '🔗 参考' };
    for (const m of memories) {
      const label = typeLabels[m.type] || m.type;
      output.push(`**[${label}] ${m.description || m.name}**`);
      const firstPara = m.body.split(/\n\n/)[0].trim();
      output.push(firstPara);
      output.push('');
    }
  }

  // Layer 3: Session Memory
  const session = loadSession(projectDir, sessionFile);
  if (session) {
    hasContent = true;
    output.push('### 上次会话');

    const order = ['正在做什么', '已完成', '遇到的问题', '下一步'];
    for (const key of order) {
      if (session[key]) {
        output.push(`**${key}**：${session[key].replace(/\n/g, ' ')}`);
      }
    }
    // 输出其他未命中的 section
    for (const [key, val] of Object.entries(session)) {
      if (!order.includes(key)) {
        output.push(`**${key}**：${val.replace(/\n/g, ' ')}`);
      }
    }
  }

  if (!hasContent) {
    return `## 上下文：${query}\n\n（暂无相关上下文）`;
  }

  return output.join('\n');
}

module.exports = { queryGraph, queryContext, findMemoryDir, loadMemory, loadSession };
