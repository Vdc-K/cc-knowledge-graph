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

// 默认目录结构（适配 Claude Code 风格项目）
// 自定义：在项目根目录创建 kg.config.js，export default { scanPaths: {...}, outputFile: '...' }
const DEFAULT_CONFIG = {
  outputFile: '0-System/knowledge-graph.json',
  scanPaths: {
    skills: '.claude/skills',
    projects: '2-Projects',
    thinking: '3-Thinking',
    inbox_thinking: '1-Inbox/thinking',
    system: '0-System',
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
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const CONFIG = loadConfig();
const OUTPUT_FILE = CONFIG.outputFile;
const SCAN_PATHS = CONFIG.scanPaths;

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

  return { graph, nodeMap, addNode, addEdge, edgeSet };
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
            const deps = dependsMatch[1].split(/[,，]\s*/).map(d => d.trim()).filter(Boolean);
            for (const dep of deps) {
              // dep 可以是 "skill-name" 或 "skill-name:relation-label"
              const [depName, depLabel] = dep.split(':');
              addEdge(`skill:${dir}`, `skill:${depName.trim()}`, `依赖:${(depLabel || depName).trim()}`);
            }
          }

          const relatedMatch = fm.match(/^related:\s*(.+)/m);
          if (relatedMatch) {
            const related = relatedMatch[1].split(/[,，]\s*/).map(r => r.trim()).filter(Boolean);
            for (const rel of related) {
              // rel 可以是 skill 名或 thinking 文件名（不含 .md）
              addEdge(`skill:${dir}`, `thinking:${rel}`, '相关');
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

        // 扫描脚本文件
        const scriptsDir = path.join(skillPath, 'scripts');
        try {
          const scripts = await fs.readdir(scriptsDir);
          for (const script of scripts) {
            if (script.endsWith('.test.js') || script.endsWith('.test.ts')) continue;
            if (script.endsWith('.js') || script.endsWith('.ts')) {
              const scriptFile = path.relative(PROJECT_DIR, path.join(scriptsDir, script));
              const scriptId = `code:${dir}/${script}`;
              addNode(scriptId, 'code', `${dir}/${script}`, scriptFile, [dir]);
              addEdge(`skill:${dir}`, scriptId, '实现');
            }
          }
        } catch (e) {
          // 没有 scripts 目录
        }

      } catch (e) {
        // 没有 SKILL.md
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

  for (const dirKey of ['thinking', 'inbox_thinking']) {
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

          const inTitle = title.includes(name);
          const occurrences = (content.match(new RegExp(name, 'g')) || []).length;

          if (inTitle || occurrences >= 2) {
            addEdge(id, nodeId, '思考');
          }
        }
      }
    } catch (e) {
      // 目录不存在
    }
  }
}

/**
 * 扫描项目目录
 */
async function scanProjects(ctx) {
  const { addNode, addEdge, nodeMap } = ctx;
  const projDir = path.join(PROJECT_DIR, SCAN_PATHS.projects);

  try {
    const dirs = await fs.readdir(projDir);

    for (const dir of dirs) {
      const dirPath = path.join(projDir, dir);
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;

      const relDir = path.relative(PROJECT_DIR, dirPath);
      const projId = `project:${dir}`;
      addNode(projId, 'project', dir, relDir, []);

      const files = await fs.readdir(dirPath);

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(dirPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const relFile = path.relative(PROJECT_DIR, filePath);

        // 决策记录（支持新命名 decision-making.md 和旧命名 04-决策记录.md）
        if (file.includes('决策记录') || file === 'decision-making.md' || file === 'decision_making.md') {
          const decId = `doc:${dir}/decision-making`;
          addNode(decId, 'decision', `${dir} decision-making`, relFile, ['决策']);

          // 提取 sections
          const sections = extractDecisionSections(content, decId, ctx);
          const decNode = nodeMap.get(decId);
          if (decNode) decNode.sections = sections;

          addEdge(projId, decId, '包含');

          // [[wiki-link]] 显式链接
          scanWikiLinks(content, decId, ctx);

          // 决策条目关联到 skill
          const decisionTitles = content.matchAll(/^##\s+(.+?)（/gm);
          for (const match of decisionTitles) {
            const title = match[1].trim();
            for (const [nodeId, node] of nodeMap) {
              if (node.type === 'skill' && title.toLowerCase().includes(node.label.toLowerCase())) {
                addEdge(decId, nodeId, '决策');
              }
            }
          }
        }

        // Roadmap — 只建节点，不扫描 skill 关联（规划层不属于结构图）
        if (file.includes('roadmap')) {
          const rmId = `doc:${dir}/roadmap`;
          addNode(rmId, 'roadmap', `${dir} Roadmap`, relFile, ['路线图']);
          addEdge(projId, rmId, '包含');
        }
      }
    }
  } catch (e) {
    console.warn('扫描项目目录失败:', e.message);
  }
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

    // 提取标题和日期：## 标题（YYYY-MM-DD）
    const titleDateMatch = titleLine.match(/^(.+?)(?:（(\d{4}-\d{2}-\d{2})）)?$/);
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
          // 尝试匹配到已有代码节点，建立"改动"边
          for (const [nodeId, node] of nodeMap) {
            if (node.type === 'code' && node.file && node.file.includes(filePath)) {
              addEdge(decId, nodeId, '改动');
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
 * [[wiki-link]] 语法识别
 * 扫描内容中的 [[xxx]] 标记，匹配到已有节点时建立"链接"边
 */
function scanWikiLinks(content, sourceId, ctx) {
  const { nodeMap, addNode, addEdge } = ctx;
  const wikiRegex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = wikiRegex.exec(content)) !== null) {
    const ref = match[1].trim();

    // 按优先级尝试匹配：skill → thinking → code → phantom
    const candidates = [
      `skill:${ref}`,
      `thinking:${ref}`,
      `code:${ref}`,
    ];

    let resolved = false;
    for (const candidateId of candidates) {
      if (nodeMap.has(candidateId)) {
        addEdge(sourceId, candidateId, '链接');
        resolved = true;
        break;
      }
    }

    // 没有匹配节点 → 创建 phantom 节点
    if (!resolved) {
      const phantomId = `phantom:${ref}`;
      if (!nodeMap.has(phantomId)) {
        addNode(phantomId, 'phantom', ref, null, []);
      }
      addEdge(sourceId, phantomId, '链接');
    }
  }
}

/**
 * 扫描代码文件之间的共享关系
 */
async function scanCodeRelations(ctx) {
  const { graph, addEdge } = ctx;
  const codeNodes = graph.nodes.filter(n => n.type === 'code');

  for (let i = 0; i < codeNodes.length; i++) {
    for (let j = i + 1; j < codeNodes.length; j++) {
      const fileA = path.join(PROJECT_DIR, codeNodes[i].file);
      const fileB = path.join(PROJECT_DIR, codeNodes[j].file);

      try {
        const contentA = await fs.readFile(fileA, 'utf-8');
        const contentB = await fs.readFile(fileB, 'utf-8');

        const funcPattern = /function\s+(\w+)/g;
        const funcsA = new Set([...contentA.matchAll(funcPattern)].map(m => m[1]));
        const funcsB = new Set([...contentB.matchAll(funcPattern)].map(m => m[1]));

        const GENERIC_FUNCS = new Set(['main', 'init', 'run', 'start', 'stop', 'setup', 'test']);
        for (const fn of funcsA) {
          if (funcsB.has(fn) && !GENERIC_FUNCS.has(fn)) {
            addEdge(codeNodes[i].id, codeNodes[j].id, `共享:${fn}`);
          }
        }
      } catch (e) {
        // 文件读取失败
      }
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

  if (queryIdx !== -1) {
    // 查询模式
    const keyword = args[queryIdx + 1];
    if (!keyword) {
      console.error('用法: node scan.js --query <keyword>');
      process.exit(1);
    }

    // 读取已有图谱
    const graphPath = path.join(PROJECT_DIR, OUTPUT_FILE);
    try {
      const data = JSON.parse(await fs.readFile(graphPath, 'utf-8'));
      const { queryGraph } = require('./query.js');
      const result = queryGraph(data, keyword);

      // JSON 输出
      console.log(JSON.stringify(result, null, 2));

      // 人可读摘要
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
    } catch (e) {
      console.error('查询失败:', e.message);
      console.error('请先运行 node scan.js 生成图谱');
      process.exit(1);
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

module.exports = { createGraph, validateGraph, extractDecisionSections, scanRoadmapSkillLinks, escapeRegExp };
