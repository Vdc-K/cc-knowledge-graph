/**
 * Knowledge Graph Query — 子图查询模块 v2
 *
 * queryGraph(graph, keyword, depth=2)
 * 带评分的 BFS：种子评分 → 加权扩展 → 分层截断
 */

// ==================== 评分常量 ====================

// 关系权重（归一化到 base relation）
function normalizeRelation(relation) {
  const colonIdx = relation.indexOf(':');
  return colonIdx > 0 ? relation.substring(0, colonIdx) : relation;
}

function getEdgeWeight(relation, isReverse) {
  const base = normalizeRelation(relation);
  const tier1 = ['实现', '依赖', '改动'];
  const tier2 = ['决策', '包含', '思考'];
  const symmetric = ['共享']; // 语义对称，不受方向惩罚

  let weight;
  if (tier1.includes(base)) weight = 1.0;
  else if (tier2.includes(base)) weight = 0.7;
  else weight = 0.5;

  if (symmetric.includes(base)) return weight;
  return isReverse ? weight * 0.7 : weight;
}

const DISTANCE_DECAY = [1.0, 0.7, 0.4];

const DEFAULTS = {
  maxNodes: 20,
  maxSeed: 6,
  maxPerType: { thinking: 4, doc: 6, phantom: 1 },
  minScoreRatio: 0.2,
};

function getDocPriority(node) {
  const kind = node.doc_kind || '';
  const depth = typeof node.path_depth === 'number' ? node.path_depth : 99;
  const base = node.doc_priority || ({
    readme: 5,
    project: 4,
    roadmap: 4,
    docs: 2,
  }[kind] || 1);
  return base - depth * 0.01;
}

function compareCandidates([idA, infoA], [idB, infoB], nodeMap) {
  if (infoB.score !== infoA.score) return infoB.score - infoA.score;
  if (infoA.distance !== infoB.distance) return infoA.distance - infoB.distance;

  const nodeA = nodeMap.get(idA) || {};
  const nodeB = nodeMap.get(idB) || {};
  const docBiasA = nodeA.type === 'doc' ? getDocPriority(nodeA) : 0;
  const docBiasB = nodeB.type === 'doc' ? getDocPriority(nodeB) : 0;
  if (docBiasB !== docBiasA) return docBiasB - docBiasA;

  return String(idA).localeCompare(String(idB));
}

// ==================== 种子评分 ====================

function scoreSeed(node, kw) {
  const id = (node.id || '').toLowerCase();
  const colonIdx = id.indexOf(':');
  const idRef = colonIdx > 0 ? id.substring(colonIdx + 1) : id;
  const label = (node.label || '').toLowerCase();
  const tags = (node.tags || []).map(t => t.toLowerCase());

  if (idRef === kw) return 1.0;
  if (label === kw) return 0.95;
  if (idRef.startsWith(kw + '-') || idRef.startsWith(kw + '/')) return 0.8;
  if (label.startsWith(kw)) return 0.75;
  if (tags.some(t => t === kw)) return 0.7;
  if (idRef.includes(kw) || label.includes(kw) || tags.some(t => t.includes(kw))) return 0.5;
  return 0;
}

// ==================== queryGraph ====================

function queryGraph(graph, keyword, depth = 2) {
  if (!keyword || !graph || !graph.nodes) {
    return { nodes: [], edges: [] };
  }

  const kw = keyword.toLowerCase();

  // 1. 种子节点评分
  const seedScores = new Map();
  for (const node of graph.nodes) {
    const score = scoreSeed(node, kw);
    if (score > 0) seedScores.set(node.id, score);
  }

  // 短 query 防护：<=3 字符只允许 exact/prefix/tag-exact
  if (kw.length <= 3) {
    for (const [id, score] of seedScores) {
      if (score < 0.7) seedScores.delete(id);
    }
  }

  // 截断种子数量
  let seeds = [...seedScores.entries()].sort((a, b) => b[1] - a[1]);
  if (seeds.length > DEFAULTS.maxSeed) seeds = seeds.slice(0, DEFAULTS.maxSeed);

  // 2. 构建边索引
  const outEdges = new Map(); // nodeId -> [{target, relation}]
  const inEdges = new Map();  // nodeId -> [{source, relation}]
  for (const edge of (graph.edges || [])) {
    if (!outEdges.has(edge.source)) outEdges.set(edge.source, []);
    outEdges.get(edge.source).push({ target: edge.target, relation: edge.relation });
    if (!inEdges.has(edge.target)) inEdges.set(edge.target, []);
    inEdges.get(edge.target).push({ source: edge.source, relation: edge.relation });
  }

  // 3. 带评分的 BFS
  const nodeScores = new Map(); // nodeId -> { score, distance }
  const visited = new Set();

  for (const [id, score] of seeds) {
    nodeScores.set(id, { score, distance: 0 });
    visited.add(id);
  }

  let frontier = seeds.map(s => s[0]);
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const decay = DISTANCE_DECAY[d] || 0.3;
    const nextFrontier = [];

    for (const nodeId of frontier) {
      const parentScore = nodeScores.get(nodeId).score;

      // 正向边
      for (const { target, relation } of (outEdges.get(nodeId) || [])) {
        const score = parentScore * decay * getEdgeWeight(relation, false);
        const existing = nodeScores.get(target);
        if (existing && existing.score >= score) continue; // 已有更优路径
        nodeScores.set(target, { score, distance: d });
        if (!visited.has(target)) {
          visited.add(target);
          nextFrontier.push(target);
        }
      }

      // 反向边（降权）
      for (const { source, relation } of (inEdges.get(nodeId) || [])) {
        const score = parentScore * decay * getEdgeWeight(relation, true);
        const existing = nodeScores.get(source);
        if (existing && existing.score >= score) continue;
        nodeScores.set(source, { score, distance: d });
        if (!visited.has(source)) {
          visited.add(source);
          nextFrontier.push(source);
        }
      }
    }
    frontier = nextFrontier;
  }

  // 4. 截断
  const bestScore = Math.max(...[...nodeScores.values()].map(v => v.score), 0);
  const minScore = bestScore * DEFAULTS.minScoreRatio;

  const nodeMap = new Map();
  for (const node of graph.nodes) nodeMap.set(node.id, node);

  const candidates = [...nodeScores.entries()]
    .filter(([, info]) => info.distance === 0 || info.score >= minScore)
    .sort((a, b) => compareCandidates(a, b, nodeMap));

  const result = [];
  const typeCounts = {};

  for (const [id, info] of candidates) {
    if (result.length >= DEFAULTS.maxNodes) break;

    const node = nodeMap.get(id);
    if (!node) continue;

    // 按 type 限额（种子不受限）
    const typeMax = DEFAULTS.maxPerType[node.type];
    if (typeMax !== undefined && info.distance > 0) {
      typeCounts[node.type] = typeCounts[node.type] || 0;
      if (typeCounts[node.type] >= typeMax) continue;
    }

    result.push({ ...node, _score: info.score, _distance: info.distance });
    typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;
  }

  // 5. 子图内部边
  const resultIds = new Set(result.map(n => n.id));
  const resultEdges = (graph.edges || []).filter(
    e => resultIds.has(e.source) && resultIds.has(e.target)
  );

  return { nodes: result, edges: resultEdges };
}

// ==================== Impact Analysis ====================

/**
 * 影响分析：改了 nodeId，哪些节点会受影响？
 * 反向 BFS — 找所有直接或间接依赖此节点的节点
 *
 * @param {Object} graph - 图谱数据
 * @param {string} nodeId - 被修改的节点 ID
 * @param {number} depth - 反向追溯深度（默认 2）
 * @returns {{ impacted: Array, edges: Array }}
 */
function queryImpact(graph, nodeId, depth = 2) {
  if (!nodeId || !graph || !graph.nodes) {
    return { impacted: [], edges: [] };
  }

  const nodeMap = new Map();
  for (const node of graph.nodes) nodeMap.set(node.id, node);

  if (!nodeMap.has(nodeId)) {
    return { impacted: [], edges: [] };
  }

  // 只有依赖类关系才算"影响"，弱关联（思考/相关/链接）不传导
  const IMPACT_RELATIONS = ['依赖', '实现', '包含', '改动'];

  // 构建反向边索引：谁依赖我？（只含依赖类边）
  const inEdges = new Map();
  for (const edge of (graph.edges || [])) {
    const base = normalizeRelation(edge.relation);
    if (!IMPACT_RELATIONS.includes(base)) continue;
    if (!inEdges.has(edge.target)) inEdges.set(edge.target, []);
    inEdges.get(edge.target).push({ source: edge.source, relation: edge.relation });
  }

  // 反向 BFS
  const visited = new Set([nodeId]);
  const impacted = [];
  const impactEdges = [];
  let frontier = [nodeId];

  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const nextFrontier = [];
    for (const current of frontier) {
      for (const { source, relation } of (inEdges.get(current) || [])) {
        if (visited.has(source)) continue;
        visited.add(source);
        nextFrontier.push(source);

        const node = nodeMap.get(source);
        if (node) {
          impacted.push({ ...node, _distance: d, _via: current, _relation: relation });
          impactEdges.push({ source, target: current, relation });
        }
      }
    }
    frontier = nextFrontier;
  }

  return { impacted, edges: impactEdges };
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

function tokenizeQuery(query) {
  if (!query) return [];
  const english = (query.match(/[a-zA-Z][\w-]*/g) || []).map(s => s.toLowerCase());
  const chinese = (query.match(/[\u4e00-\u9fff]{2,}/g) || []).map(s => s.toLowerCase());
  return [...new Set([...english, ...chinese])];
}

function shouldIncludeSession(query, session) {
  if (!session) return false;

  const rawQuery = String(query || '').trim().toLowerCase();
  if (!rawQuery) return false;

  const directHints = [
    'session', 'continue', 'last-session', 'resume',
    '上次', '继续', '昨天', '刚才', '接着',
  ];
  if (directHints.some(hint => rawQuery.includes(hint))) {
    return true;
  }

  const tokens = tokenizeQuery(rawQuery).filter(token => token.length > 1);
  if (tokens.length === 0) return false;

  const sessionText = Object.entries(session)
    .map(([key, value]) => `${key} ${value}`)
    .join(' ')
    .toLowerCase();

  return tokens.some(token => sessionText.includes(token));
}

function getTypeLabels() {
  return {
    skill: 'Skill',
    code: '代码',
    thinking: '思考',
    decision: '决策',
    project: '项目',
    roadmap: '路线图',
    doc: '文档',
    phantom: '悬空引用',
  };
}

function getNodeFamily(node) {
  const type = node?.type || '';
  if (type === 'project') return 'project';
  if (type === 'skill' || type === 'code') return 'capability';
  if (type === 'thinking') return 'reasoning';
  if (type === 'decision' || type === 'doc' || type === 'roadmap') return 'reference';
  if (type === 'phantom') return 'phantom';
  return 'other';
}

function getProfileWeight(node) {
  const score = node._score || 0;
  const distance = node._distance || 0;
  const distanceFactor = distance === 0 ? 1.15 : distance === 1 ? 1.0 : 0.6;
  return score * distanceFactor;
}

function renderNodeLine(node) {
  const typeLabels = getTypeLabels();
  const fileHint = node.file ? ` → \`${node.file}\`` : '';
  const phantom = node.phantom ? ' ⚠️' : '';
  const type = typeLabels[node.type] || node.type;
  return `- [${type}] ${node.id}${fileHint}${phantom}`;
}

function sortNodesForDisplay(nodes) {
  return [...nodes].sort((a, b) => {
    const scoreDelta = (b._score || 0) - (a._score || 0);
    if (scoreDelta !== 0) return scoreDelta;
    const distanceDelta = (a._distance || 0) - (b._distance || 0);
    if (distanceDelta !== 0) return distanceDelta;
    return String(a.id).localeCompare(String(b.id));
  });
}

function inferDisplayProfile(sortedNodes) {
  const focusNodes = sortedNodes.slice(0, 8);
  if (focusNodes.length === 0) return 'mixed';

  const familyScores = new Map();
  for (const node of focusNodes) {
    const family = getNodeFamily(node);
    const weight = getProfileWeight(node);
    familyScores.set(family, (familyScores.get(family) || 0) + weight);
  }

  const rankedFamilies = [...familyScores.entries()].sort((a, b) => b[1] - a[1]);
  const [topFamily, topScore = 0] = rankedFamilies[0] || ['mixed', 0];
  const secondScore = rankedFamilies[1]?.[1] || 0;

  const topNode = focusNodes[0];
  if (topNode?.type === 'project' && topScore >= secondScore * 1.1) return 'project';
  if (topFamily === 'project' && topScore >= secondScore * 1.1) return 'project';
  if (topFamily === 'capability' && topScore >= secondScore * 1.15) return 'capability';
  if (topFamily === 'reference' && topScore >= secondScore * 1.15) return 'reference';
  if (topFamily === 'reasoning' && topScore >= secondScore * 1.2) return 'reasoning';
  return 'mixed';
}

function buildDisplaySections(sortedNodes, profile) {
  const core = sortedNodes.filter(n => (n._distance || 0) <= 1);
  const extended = sortedNodes.filter(n => (n._distance || 0) > 1);
  const sections = [];

  if (profile === 'project') {
    const overview = [];
    const supplementalDocs = [];

    for (const node of core) {
      if (node.type === 'project' || node.type === 'decision' || node.type === 'roadmap') {
        overview.push(node);
        continue;
      }

      if (node.type === 'doc') {
        const isSummaryReadme = node.doc_kind === 'readme' && (node.path_depth || 0) <= 1;
        if (isSummaryReadme || ['project', 'roadmap'].includes(node.doc_kind)) overview.push(node);
        else supplementalDocs.push(node);
        continue;
      }

      overview.push(node);
    }

    sections.push({ title: '项目概览', nodes: overview });
    if (supplementalDocs.length > 0) {
      sections.push({ title: '项目文档（补充）', nodes: supplementalDocs.slice(0, 3) });
    }

    const rest = [...supplementalDocs.slice(3), ...extended];
    if (rest.length > 0) {
      sections.push({ title: `扩展相关（${rest.length} 项）`, nodes: rest.slice(0, 6), compact: true, total: rest.length });
    }
    return sections;
  }

  if (profile === 'capability') {
    const primary = [];
    const implementation = [];
    const rationale = [];

    for (const node of core) {
      if (node.type === 'skill' && (node._distance || 0) === 0) {
        primary.push(node);
      } else if (node.type === 'skill' || node.type === 'code' || node.type === 'project') {
        implementation.push(node);
      } else if (['thinking', 'decision', 'roadmap', 'doc'].includes(node.type)) {
        rationale.push(node);
      } else {
        implementation.push(node);
      }
    }

    if (primary.length > 0) sections.push({ title: '核心能力', nodes: primary });
    if (implementation.length > 0) sections.push({ title: '实现 / 依赖', nodes: implementation });
    if (rationale.length > 0) sections.push({ title: '思考 / 文档', nodes: rationale });
  } else if (profile === 'reference') {
    const primaryDocs = [];
    const implementation = [];
    const reasoning = [];

    for (const node of core) {
      if (['decision', 'doc', 'roadmap'].includes(node.type)) {
        primaryDocs.push(node);
      } else if (['thinking'].includes(node.type)) {
        reasoning.push(node);
      } else {
        implementation.push(node);
      }
    }

    if (primaryDocs.length > 0) sections.push({ title: '核心文档', nodes: primaryDocs });
    if (implementation.length > 0) sections.push({ title: '关联实现 / 项目', nodes: implementation });
    if (reasoning.length > 0) sections.push({ title: '思考背景', nodes: reasoning });
  } else if (profile === 'reasoning') {
    const ideas = [];
    const implementation = [];
    const references = [];

    for (const node of core) {
      if (node.type === 'thinking' || node.type === 'decision') ideas.push(node);
      else if (node.type === 'doc' || node.type === 'roadmap') references.push(node);
      else implementation.push(node);
    }

    if (ideas.length > 0) sections.push({ title: '核心思路', nodes: ideas });
    if (implementation.length > 0) sections.push({ title: '关联能力 / 项目', nodes: implementation });
    if (references.length > 0) sections.push({ title: '参考文档', nodes: references });
  } else {
    sections.push({ title: '核心相关', nodes: core });
  }

  if (extended.length > 0) {
    sections.push({ title: `扩展相关（${extended.length} 项）`, nodes: extended.slice(0, 6), compact: true, total: extended.length });
  }

  return sections.filter(section => section.nodes.length > 0);
}

function renderDisplaySections(output, sortedNodes) {
  const profile = inferDisplayProfile(sortedNodes);
  const sections = buildDisplaySections(sortedNodes, profile);

  sections.forEach((section, index) => {
    if (index > 0) output.push('');
    output.push(`*${section.title}*`);

    for (const node of sortNodesForDisplay(section.nodes)) {
      if (section.compact) {
        const fileHint = node.file ? ` → \`${node.file}\`` : '';
        output.push(`- ${node.id}${fileHint}`);
      } else {
        output.push(renderNodeLine(node));
      }
    }

    if (section.compact && section.total > section.nodes.length) {
      output.push(`- ...及 ${section.total - section.nodes.length} 项`);
    }
  });
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

  // Layer 1: KG（按分数排序，带距离标记）
  if (graph) {
    const subgraph = queryGraph(graph, query);
    if (subgraph.nodes.length > 0) {
      hasContent = true;
      output.push('### 知识图谱');

      // 按分数排序的节点（已由 queryGraph 排好）
      const sorted = sortNodesForDisplay(subgraph.nodes);
      renderDisplaySections(output, sorted);
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
  if (session && shouldIncludeSession(query, session)) {
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

module.exports = {
  queryGraph,
  queryImpact,
  queryContext,
  findMemoryDir,
  loadMemory,
  loadSession,
  shouldIncludeSession,
  tokenizeQuery,
  inferDisplayProfile,
};
