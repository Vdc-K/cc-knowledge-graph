#!/usr/bin/env node

/**
 * Knowledge Graph Scanner
 *
 * 扫描项目文件，自动构建知识图谱（节点 + 边）
 * 输出：0-System/knowledge-graph.json
 */

const fs = require('fs').promises;
const path = require('path');

// ==================== 配置 ====================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// 默认目录结构（适配 OnlyClaude 风格项目）
// 自定义：在项目根目录创建 kg.config.js，export default { scanPaths: {...}, outputFile: '...' }
const DEFAULT_CONFIG = {
  outputFile: '0-System/knowledge-graph.json',
  scanPaths: {
    skills: '.claude/skills',
    projects: '2-Projects',
    thinking: '3-Thinking',
    inbox_thinking: '1-Inbox/thinking',
    inbox: '1-Inbox',
    system: '0-System',
  },
  // context-loader 配置（可选）
  context: {
    sessionMemory: null,  // session memory 文件路径，如 '0-System/last-session.md'
  },
};

function loadConfig() {
  try {
    const configPath = path.join(PROJECT_DIR, 'kg.config.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const userConfig = require(configPath);
    return {
      outputFile: userConfig.outputFile || DEFAULT_CONFIG.outputFile,
      scanPaths: { ...DEFAULT_CONFIG.scanPaths, ...(userConfig.scanPaths || {}) },
      context: { ...DEFAULT_CONFIG.context, ...(userConfig.context || {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const CONFIG = loadConfig();
const OUTPUT_FILE = CONFIG.outputFile;
const SCAN_PATHS = CONFIG.scanPaths;

const PROJECT_DOC_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '__pycache__',
]);

// ==================== 图谱上下文工厂 ====================

function createGraph() {
  const graph = {
    version: '1.0.0',
    generated: new Date().toISOString(),
    nodes: [],
    edges: [],
  };

  const nodeMap = new Map(); // id -> node
  const edgeSet = new Set(); // 边去重

  function addNode(id, type, label, file, tags = []) {
    if (nodeMap.has(id)) return;
    const node = { id, type, label, file, tags };
    nodeMap.set(id, node);
    graph.nodes.push(node);
  }

  function addEdge(source, target, relation) {
    const key = `${source}->${target}:${relation}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    graph.edges.push({ source, target, relation });
  }

  // 延迟边：需要所有节点就位后才能解析的边（wiki-link、related）
  const deferredEdges = [];
  function deferEdge(source, targetRef, relation, resolveOrder = ['skill', 'thinking', 'code']) {
    deferredEdges.push({ source, targetRef, relation, resolveOrder });
  }

  return { graph, nodeMap, addNode, addEdge, edgeSet, deferredEdges, deferEdge };
}

// ==================== validateGraph ====================

function validateGraph(ctx) {
  const { graph, nodeMap, addNode } = ctx;
  const phantomNodes = [];

  for (const edge of graph.edges) {
    for (const endpoint of [edge.source, edge.target]) {
      if (!nodeMap.has(endpoint)) {
        // 从 id 前缀推断 type
        const colonIdx = endpoint.indexOf(':');
        const type = colonIdx > 0 ? endpoint.substring(0, colonIdx) : 'unknown';
        const phantomNode = { id: endpoint, type, label: endpoint, file: null, tags: [], phantom: true };
        nodeMap.set(endpoint, phantomNode);
        graph.nodes.push(phantomNode);
        phantomNodes.push(phantomNode);
      }
    }
  }

  return phantomNodes;
}

// ==================== 扫描器 ====================

/**
 * 扫描 Skills 目录
 */
async function scanSkills(ctx) {
  const { addNode, addEdge } = ctx;
  const skillsDir = path.join(PROJECT_DIR, SCAN_PATHS.skills);

  try {
    const dirs = await fs.readdir(skillsDir);

    for (const dir of dirs) {
      const skillPath = path.join(skillsDir, dir);
      const stat = await fs.stat(skillPath);
      if (!stat.isDirectory()) continue;

      const skillMd = path.join(skillPath, 'SKILL.md');
      try {
        const content = await fs.readFile(skillMd, 'utf-8');

        // 提取 frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let name = dir;
        let description = '';
        let tags = [];

        if (fmMatch) {
          const fm = fmMatch[1];
          const nameMatch = fm.match(/name:\s*(.+)/);
          const descMatch = fm.match(/description:\s*(.+)/);
          if (nameMatch) name = nameMatch[1].trim();
          if (descMatch) description = descMatch[1].trim();

          const layerMatch = fm.match(/layer:\s*(.+)/);
          const statusMatch = fm.match(/status:\s*(.+)/);
          if (layerMatch) tags.push(`layer:${layerMatch[1].trim()}`);
          if (statusMatch) tags.push(`status:${statusMatch[1].trim()}`);

          const triggerWords = description.match(/"([^"]+)"/g) || [];
          tags.push(...triggerWords.map(w => w.replace(/"/g, '')).slice(0, 3));

          // C: Pull model — 读取显式声明的关系
          const dependsMatch = fm.match(/^depends:\s*(.+)/m);
          if (dependsMatch) {
            // 去除可能的外层方括号（如 [knowledge-graph, tell-me]）
            const rawDeps = dependsMatch[1].trim().replace(/^\[|\]$/g, '');
            const deps = rawDeps.split(/[,，]\s*/).map(d => d.trim().replace(/^\[|\]$/g, '')).filter(Boolean).filter(d => d !== '[]');
            for (const dep of deps) {
              // dep 可以是 "skill-name" 或 "skill-name:relation-label"
              const [depName, depLabel] = dep.split(':');
              addEdge(`skill:${dir}`, `skill:${depName.trim()}`, `依赖:${(depLabel || depName).trim()}`);
            }
          }

          const relatedMatch = fm.match(/^related:\s*(.+)/m);
          if (relatedMatch) {
            // 去除可能的外层方括号（如 [eval, benchmark, decision]）
            const rawRelated = relatedMatch[1].trim().replace(/^\[|\]$/g, '');
            const related = rawRelated.split(/[,，]\s*/).map(r => r.trim().replace(/^\[|\]$/g, '')).filter(Boolean).filter(r => r !== '[]');
            for (const rel of related) {
              // rel 可以是 skill 名或 thinking 文件名（不含 .md），延迟到所有节点就位后解析
              ctx.deferEdge(`skill:${dir}`, rel, '相关', ['skill', 'thinking']);
            }
          }
        }

        const relFile = path.relative(PROJECT_DIR, skillMd);
        addNode(`skill:${dir}`, 'skill', name, relFile, tags);

        // 扫描依赖关系
        const depMatches = content.matchAll(/from\s+(\S+)\s+import\s+(.+)/g);
        for (const match of depMatches) {
          const depSkill = match[1].replace(/['"]/g, '');
          const depWhat = match[2].trim();
          addEdge(`skill:${dir}`, `skill:${depSkill}`, `依赖:${depWhat}`);
        }

        // 扫描脚本文件（skill 根目录 + scripts/ 递归）
        const SCRIPT_EXTS = new Set(['.js', '.ts', '.mjs', '.py', '.sh']);
        const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', 'dist']);

        function isTestFile(name) {
          return name.includes('.test.') || name.includes('.spec.') ||
                 name === 'vitest.config.js' || name === 'vitest.config.ts' ||
                 name === 'jest.config.js' || name === 'jest.config.ts';
        }

        // 扫描 skill 根目录（第一层，不递归）
        try {
          const rootEntries = await fs.readdir(skillPath, { withFileTypes: true });
          for (const entry of rootEntries) {
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name);
            if (!SCRIPT_EXTS.has(ext)) continue;
            if (isTestFile(entry.name)) continue;
            const scriptFile = path.relative(PROJECT_DIR, path.join(skillPath, entry.name));
            const scriptId = `code:${dir}/${entry.name}`;
            addNode(scriptId, 'code', `${dir}/${entry.name}`, scriptFile, [dir]);
            addEdge(`skill:${dir}`, scriptId, '实现');
          }
        } catch (e) {
          // 跳过
        }

        // 递归扫描 scripts/ 子目录
        const scriptsDir = path.join(skillPath, 'scripts');
        async function scanScriptsDir(currentDir, relPrefix) {
          let entries;
          try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
          } catch (e) {
            return; // 目录不存在
          }
          for (const entry of entries) {
            if (entry.isDirectory()) {
              if (SKIP_DIRS.has(entry.name)) continue;
              await scanScriptsDir(path.join(currentDir, entry.name), `${relPrefix}${entry.name}/`);
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name);
              if (!SCRIPT_EXTS.has(ext)) continue;
              if (isTestFile(entry.name)) continue;
              const fullPath = path.join(currentDir, entry.name);
              const scriptFile = path.relative(PROJECT_DIR, fullPath);
              // ID 格式：code:skillname/subpath/file.ext（subpath 相对于 scripts/）
              const scriptId = `code:${dir}/${relPrefix}${entry.name}`;
              const label = `${dir}/${relPrefix}${entry.name}`;
              addNode(scriptId, 'code', label, scriptFile, [dir]);
              addEdge(`skill:${dir}`, scriptId, '实现');
            }
          }
        }
        await scanScriptsDir(scriptsDir, '');

      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.warn(`[scan] SKILL.md 解析失败: ${skillMd} — ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn('扫描 Skills 目录失败:', e.message);
  }
}

/**
 * 扫描 Thinking 目录
 */
async function scanThinking(ctx) {
  const { addNode, addEdge, nodeMap } = ctx;

  for (const dirKey of ['thinking', 'inbox_thinking', 'inbox']) {
    if (!SCAN_PATHS[dirKey]) continue; // 配置中未定义此路径，跳过
    const thinkDir = path.join(PROJECT_DIR, SCAN_PATHS[dirKey]);

    try {
      const files = await fs.readdir(thinkDir);

      for (const file of files) {
        if (!file.endsWith('.md') || file === 'README.md') continue;

        const filePath = path.join(thinkDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const relFile = path.relative(PROJECT_DIR, filePath);

        const titleMatch = content.match(/^#\s+(.+)/m);
        const label = titleMatch ? titleMatch[1] : file.replace('.md', '');

        const id = `thinking:${file.replace('.md', '')}`;
        addNode(id, 'thinking', label, relFile, []);

        // [[wiki-link]] 显式链接（优先于关键词推断）
        scanWikiLinks(content, id, ctx);

        const title = titleMatch ? titleMatch[1] : '';
        for (const [nodeId, node] of nodeMap) {
          if (node.type !== 'skill') continue;
          const name = node.label;
          if (name.length < 3) continue;

          const wbRegex = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
          const inTitle = wbRegex.test(title);
          const occurrences = (content.match(wbRegex) || []).length;

          // 短名称（3-4字符）：必须在标题中或出现 >= 4 次（避免 "dev" 这类词误匹配）
          // 长名称（5+字符）：标题匹配 or 出现 >= 2 次
          const threshold = name.length <= 4 ? 4 : 2;
          if (inTitle || occurrences >= threshold) {
            addEdge(id, nodeId, '思考');
          }
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`[scan] Thinking 目录扫描失败: ${thinkDir} — ${e.message}`);
      }
    }
  }
}

/**
 * 扫描项目目录
 */
async function scanProjects(ctx) {
  const { addNode, addEdge, nodeMap } = ctx;
  const projectRoot = PROJECT_DIR;
  const projDir = path.join(projectRoot, SCAN_PATHS.projects);

  try {
    const dirs = await fs.readdir(projDir);

    for (const dir of dirs) {
      const dirPath = path.join(projDir, dir);
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;

      const relDir = path.relative(projectRoot, dirPath);
      const projId = `project:${dir}`;
      addNode(projId, 'project', dir, relDir, []);

      const docFiles = await collectProjectMarkdownFiles(dirPath);

      for (const filePath of docFiles) {
        const file = path.basename(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const relFile = path.relative(projectRoot, filePath);
        const relWithinProject = toPosix(path.relative(dirPath, filePath));
        const lowerRelWithinProject = relWithinProject.toLowerCase();

        // 决策记录（支持新命名 decision_making.md、旧连字符命名 decision-making.md 和 04-决策记录.md）
        if (file.includes('决策记录') || file === 'decision_making.md' || file === 'decision-making.md') {
          const decId = `doc:${dir}/decision_making`;
          addNode(decId, 'decision', `${dir} decision-making`, relFile, ['决策']);

          // 提取 sections
          const sections = extractDecisionSections(content, decId, ctx);
          const decNode = nodeMap.get(decId);
          if (decNode) decNode.sections = sections;

          addEdge(projId, decId, '包含');

          // [[wiki-link]] 显式链接
          scanWikiLinks(content, decId, ctx);

          // 决策条目关联到 skill
          const decisionTitles = content.matchAll(/^##\s+(.+?)[（(]/gm);
          for (const match of decisionTitles) {
            const title = match[1].trim();
            for (const [nodeId, node] of nodeMap) {
              if (node.type === 'skill' && title.toLowerCase().includes(node.label.toLowerCase())) {
                addEdge(decId, nodeId, '决策');
              }
            }
          }
          continue;
        }

        // Roadmap — 只建节点，不扫描 skill 关联（规划层不属于结构图）
        if (file.includes('roadmap')) {
          const rmId = `doc:${dir}/roadmap`;
          addNode(rmId, 'roadmap', `${dir} Roadmap`, relFile, ['路线图']);
          addEdge(projId, rmId, '包含');
          scanWikiLinks(content, rmId, ctx);
          continue;
        }

        if (shouldIndexProjectMarkdown(lowerRelWithinProject)) {
          const docMeta = getProjectDocMeta(lowerRelWithinProject);
          const titleMatch = content.match(/^#\s+(.+)/m);
          const label = titleMatch ? titleMatch[1].trim() : relWithinProject.replace(/\.md$/i, '');
          const docKey = relWithinProject.replace(/\.md$/i, '');
          const docId = `doc:${dir}/${toPosix(docKey)}`;
          addNode(docId, 'doc', label, relFile, ['文档', `doc-kind:${docMeta.kind}`]);
          const docNode = nodeMap.get(docId);
          if (docNode) {
            docNode.doc_kind = docMeta.kind;
            docNode.path_depth = docMeta.depth;
            docNode.doc_priority = docMeta.priority;
          }
          addEdge(projId, docId, '包含');
          scanWikiLinks(content, docId, ctx);
        }
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[scan] 项目目录扫描失败: ${projDir} — ${e.message}`);
    }
  }
}

async function collectProjectMarkdownFiles(rootDir) {
  const result = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (PROJECT_DOC_SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(currentDir, entry.name));
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      result.push(path.join(currentDir, entry.name));
    }
  }

  await walk(rootDir);
  result.sort();
  return result;
}

function shouldIndexProjectMarkdown(relWithinProject) {
  return getProjectDocMeta(relWithinProject) !== null;
}

function getProjectDocMeta(relWithinProject) {
  const normalized = toPosix(relWithinProject);
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  const depth = normalized.split('/').length - 1;

  if (lower === 'docs' || lower.startsWith('docs/') || lower.includes('/docs/')) {
    return { kind: 'docs', depth, priority: 2 };
  }
  if (base === 'project.md') {
    return { kind: 'project', depth, priority: 4 };
  }
  if (base === 'readme.md' || /^readme(\.[^.]+)?\.md$/.test(base)) {
    return { kind: 'readme', depth, priority: 5 };
  }
  if (base === 'decision_making.md' || base === 'decision-making.md') {
    return { kind: 'decision', depth, priority: 6 };
  }
  if (base.includes('roadmap')) {
    return { kind: 'roadmap', depth, priority: 4 };
  }

  return null;
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * 提取决策记录的 sections
 */
function extractDecisionSections(content, decId, ctx) {
  const { nodeMap, addEdge } = ctx;
  const sections = [];

  // 按 ## 分割决策条目
  const sectionRegex = /^##\s+(.+)/gm;
  const matches = [...content.matchAll(sectionRegex)];

  for (let i = 0; i < matches.length; i++) {
    const titleLine = matches[i][1];
    const startIdx = matches[i].index;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const sectionContent = content.substring(startIdx, endIdx);

    // 提取标题和日期：## 标题（YYYY-MM-DD）或 ## 标题(YYYY-MM-DD)
    const titleDateMatch = titleLine.match(/^(.+?)(?:[（(](\d{4}-\d{2}-\d{2})[）)])?$/);
    const title = titleDateMatch ? titleDateMatch[1].trim() : titleLine.trim();
    const date = titleDateMatch && titleDateMatch[2] ? titleDateMatch[2] : null;

    // 提取 type（如：**类型**：xxx 或 **Type**：xxx）
    const typeMatch = sectionContent.match(/\*\*(?:类型|type)\*\*[：:]\s*(.+)/i);
    const type = typeMatch ? typeMatch[1].trim() : null;

    // 提取 status
    const statusMatch = sectionContent.match(/\*\*(?:状态|status)\*\*[：:]\s*(.+)/i);
    const status = statusMatch ? statusMatch[1].trim() : null;

    // 提取 files
    const filesMatch = sectionContent.match(/\*\*(?:文件|files?)\*\*[：:]\s*(.+)/i);
    const files = [];
    if (filesMatch) {
      const fileList = filesMatch[1].split(/[,，]\s*/);
      for (const f of fileList) {
        const filePath = f.trim().replace(/`/g, '');
        if (filePath) {
          files.push(filePath);
          // 尝试匹配到已有代码节点，建立"改动"边（路径后缀精确匹配，避免 index.ts 误匹配多个文件）
          for (const [nodeId, node] of nodeMap) {
            if (node.type === 'code' && node.file) {
              const normalizedNode = node.file.replace(/\\/g, '/');
              const normalizedQuery = filePath.replace(/\\/g, '/');
              // 要求文件路径以查询路径结尾，且前面是路径分隔符（不是名称子串）
              if (normalizedNode === normalizedQuery ||
                  normalizedNode.endsWith('/' + normalizedQuery)) {
                addEdge(decId, nodeId, '改动');
              }
            }
          }
        }
      }
    }

    // 提取 related
    const relatedMatch = sectionContent.match(/\*\*(?:相关|related)\*\*[：:]\s*(.+)/i);
    const related = relatedMatch ? relatedMatch[1].trim().split(/[,，]\s*/).map(r => r.trim()).filter(Boolean) : [];

    sections.push({ title, date, type, status, files, related });
  }

  return sections;
}

/**
 * Roadmap 关联增强：标题 + 正文搜索 skill 名称
 */
function scanRoadmapSkillLinks(content, rmId, ctx) {
  const { nodeMap, addEdge } = ctx;
  const linkedSkills = new Set(); // 去重

  // 按 #### 拆分任务块
  const taskRegex = /^####\s+\d+\.\s+(.+)/gm;
  const taskMatches = [...content.matchAll(taskRegex)];

  for (let i = 0; i < taskMatches.length; i++) {
    const title = taskMatches[i][1].trim();
    const startIdx = taskMatches[i].index;
    const endIdx = i + 1 < taskMatches.length ? taskMatches[i + 1].index : content.length;
    const taskBody = content.substring(startIdx, endIdx);

    for (const [nodeId, node] of nodeMap) {
      if (node.type !== 'skill') continue;
      if (linkedSkills.has(nodeId)) continue; // 已关联，跳过

      const name = node.label.toLowerCase();
      const titleLower = title.toLowerCase();
      const bodyLower = taskBody.toLowerCase();

      let matched = false;

      if (name.length <= 3) {
        // 短名称：要求 word boundary 完全匹配
        const wbRegex = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
        matched = wbRegex.test(titleLower) || wbRegex.test(bodyLower);
      } else {
        matched = titleLower.includes(name) || bodyLower.includes(name);
      }

      if (matched) {
        addEdge(rmId, nodeId, '任务');
        linkedSkills.add(nodeId);
      }
    }
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 提取文件中的函数名（覆盖 function/箭头函数/class 方法）
 */
function extractFunctionNames(content) {
  const names = new Set();
  // function foo() / async function foo()
  for (const m of content.matchAll(/function\s+(\w+)/g)) names.add(m[1]);
  // const/let/var foo = (...) => 或 const foo = async (...) =>
  for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/g)) names.add(m[1]);
  // class 方法：缩进后的 methodName( 或 async methodName(
  for (const m of content.matchAll(/^\s{2,}(?:async\s+)?(\w+)\s*\(/gm)) {
    const name = m[1];
    if (!['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) names.add(name);
  }
  return names;
}

/**
 * [[wiki-link]] 语法识别
 * 扫描内容中的 [[xxx]] 标记，匹配到已有节点时建立"链接"边
 */
function scanWikiLinks(content, sourceId, ctx) {
  const { deferEdge } = ctx;
  const wikiRegex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = wikiRegex.exec(content)) !== null) {
    const ref = match[1].trim();
    // 延迟到所有节点就位后解析，避免扫描顺序导致 phantom 残留
    deferEdge(sourceId, ref, '链接', ['skill', 'thinking', 'code']);
  }
}

/**
 * 扫描代码文件之间的共享关系
 */
async function scanCodeRelations(ctx) {
  const { graph, addEdge } = ctx;
  const codeNodes = graph.nodes.filter(n => n.type === 'code');
  const GENERIC_FUNCS = new Set(['main', 'init', 'run', 'start', 'stop', 'setup', 'test']);

  // 倒排索引：fn -> [nodeId, ...]（每个文件只读一次）
  const funcIndex = new Map();
  for (const node of codeNodes) {
    try {
      const content = await fs.readFile(path.join(PROJECT_DIR, node.file), 'utf-8');
      for (const fn of extractFunctionNames(content)) {
        if (GENERIC_FUNCS.has(fn)) continue;
        if (!funcIndex.has(fn)) funcIndex.set(fn, []);
        funcIndex.get(fn).push(node.id);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`[scan] 代码文件读取失败: ${node.file} — ${e.message}`);
      }
    }
  }

  // 共享函数建边
  for (const [fn, nodeIds] of funcIndex) {
    if (nodeIds.length < 2) continue;
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        addEdge(nodeIds[i], nodeIds[j], `共享:${fn}`);
      }
    }
  }
}

// ==================== 延迟边解析 ====================

/**
 * 解析延迟边（wiki-link、related 等需要所有节点就位后才能解析的边）
 * 修复：前向引用不再产生 phantom 残留
 */
function resolveDeferredEdges(ctx) {
  const { deferredEdges, nodeMap, addNode, addEdge } = ctx;

  for (const { source, targetRef, relation, resolveOrder } of deferredEdges) {
    const refLower = targetRef.toLowerCase();
    let resolved = false;

    // 精确匹配
    for (const prefix of resolveOrder) {
      const candidateId = `${prefix}:${targetRef}`;
      if (nodeMap.has(candidateId)) {
        addEdge(source, candidateId, relation);
        resolved = true;
        break;
      }
    }

    // 大小写不敏感匹配
    if (!resolved) {
      for (const [nodeId] of nodeMap) {
        const colonIdx = nodeId.indexOf(':');
        if (colonIdx < 0) continue;
        const prefix = nodeId.substring(0, colonIdx);
        const nodeRef = nodeId.substring(colonIdx + 1).toLowerCase();
        if (nodeRef === refLower && resolveOrder.includes(prefix)) {
          addEdge(source, nodeId, relation);
          resolved = true;
          break;
        }
      }
    }

    // 仍未解析 → 创建 phantom
    if (!resolved) {
      const phantomId = `phantom:${targetRef}`;
      if (!nodeMap.has(phantomId)) {
        addNode(phantomId, 'phantom', targetRef, null, []);
        const phantomNode = nodeMap.get(phantomId);
        if (phantomNode) phantomNode.phantom = true;
      }
      addEdge(source, phantomId, relation);
    }
  }
}

// ==================== 输出 ====================

async function writeGraph(ctx) {
  const { graph } = ctx;
  const outputPath = path.join(PROJECT_DIR, OUTPUT_FILE);
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });

  const stats = {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    byType: {},
  };
  for (const node of graph.nodes) {
    stats.byType[node.type] = (stats.byType[node.type] || 0) + 1;
  }
  graph.stats = stats;

  await fs.writeFile(outputPath, JSON.stringify(graph, null, 2), 'utf-8');
  return outputPath;
}

// ==================== 主函数 ====================

async function main() {
  const args = process.argv.slice(2);
  const queryIdx = args.indexOf('--query');
  const benchmarkMode = args.includes('--benchmark');

  if (benchmarkMode) {
    const graphPath = path.join(PROJECT_DIR, OUTPUT_FILE);
    let graphData = null;
    try {
      graphData = JSON.parse(await fs.readFile(graphPath, 'utf-8'));
    } catch {
      console.error('Benchmark 失败: 图谱不存在，请先运行 node scan.js 生成图谱');
      process.exit(1);
    }

    const { runBenchmarks, formatBenchmarkReport } = require('./benchmark.js');
    const results = runBenchmarks({
      graph: graphData,
      projectDir: PROJECT_DIR,
      sessionFile: null,
    });
    console.log(formatBenchmarkReport(results));
    if (results.some(result => !result.passed)) {
      process.exit(1);
    }
    return;
  }

  if (queryIdx !== -1) {
    const keyword = args[queryIdx + 1];
    if (!keyword) {
      console.error('用法: node scan.js --query <keyword> [--context]');
      process.exit(1);
    }

    const contextMode = args.includes('--context');

    // 尝试读取图谱（context 模式下图谱可选）
    const graphPath = path.join(PROJECT_DIR, OUTPUT_FILE);
    let graphData = null;
    try {
      graphData = JSON.parse(await fs.readFile(graphPath, 'utf-8'));
    } catch {
      if (!contextMode) {
        console.error('查询失败: 图谱不存在，请先运行 node scan.js 生成图谱');
        process.exit(1);
      }
    }

    if (contextMode) {
      // 上下文聚合模式：KG + memory + session-memory
      const { queryContext } = require('./query.js');

      // 从 config 读取 session-memory 路径
      const sessionFile = CONFIG.context && CONFIG.context.sessionMemory
        ? CONFIG.context.sessionMemory
        : null;

      const result = queryContext({
        graph: graphData,
        query: keyword,
        projectDir: PROJECT_DIR,
        sessionFile,
      });

      console.log(result);
    } else {
      // 纯 KG 查询模式
      const { queryGraph } = require('./query.js');
      const result = queryGraph(graphData, keyword);

      console.log(JSON.stringify(result, null, 2));

      console.log('\n--- 摘要 ---');
      console.log(`关键词: ${keyword}`);
      console.log(`匹配节点: ${result.nodes.length}`);
      console.log(`相关边: ${result.edges.length}`);
      if (result.nodes.length > 0) {
        console.log('\n节点列表:');
        for (const n of result.nodes) {
          console.log(`  [${n.type}] ${n.label} (${n.id})`);
        }
      }
    }
    return;
  }

  // 扫描模式
  console.log('🔍 开始扫描知识图谱...');
  console.log(`项目目录: ${PROJECT_DIR}\n`);

  const ctx = createGraph();

  await scanSkills(ctx);
  console.log(`  Skills: ${ctx.graph.nodes.filter(n => n.type === 'skill').length} 个`);

  await scanThinking(ctx);
  console.log(`  Thinking: ${ctx.graph.nodes.filter(n => n.type === 'thinking').length} 个`);

  await scanProjects(ctx);
  console.log(`  Projects: ${ctx.graph.nodes.filter(n => n.type === 'project').length} 个`);

  await scanCodeRelations(ctx);

  // 解析延迟边（wiki-link、related 等需要所有节点就位后才能正确解析的边）
  resolveDeferredEdges(ctx);
  console.log(`  延迟边: ${ctx.deferredEdges.length} 条已解析`);

  // 验证图谱，处理悬空引用
  const phantomNodes = validateGraph(ctx);
  if (phantomNodes.length > 0) {
    console.log(`  Phantom: ${phantomNodes.length} 个悬空引用`);
  }

  const outputPath = await writeGraph(ctx);

  console.log(`\n✅ 知识图谱已生成`);
  console.log(`  节点: ${ctx.graph.nodes.length}`);
  console.log(`  边: ${ctx.graph.edges.length}`);
  console.log(`  输出: ${outputPath}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error('扫描失败:', e);
    process.exit(1);
  });
}

module.exports = {
  createGraph,
  validateGraph,
  resolveDeferredEdges,
  extractDecisionSections,
  scanRoadmapSkillLinks,
  escapeRegExp,
  extractFunctionNames,
  scanProjects,
  collectProjectMarkdownFiles,
  shouldIndexProjectMarkdown,
  getProjectDocMeta,
};
