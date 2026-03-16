#!/usr/bin/env node

/**
 * capability-index 生成器
 *
 * 读取所有 SKILL.md frontmatter + KG 边关系，
 * 生成 0-System/capability-index.json
 *
 * 用法：node capability-index.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

function stripMatchingQuotes(value) {
  if (!value || value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '\'' && last === '\'') || (first === '"' && last === '"')) {
    return value.slice(1, -1);
  }
  return value;
}

// ─── 路径常量 ────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const SKILLS_DIR = path.join(PROJECT_ROOT, '.claude/skills');
const KG_FILE = path.join(PROJECT_ROOT, '0-System/knowledge-graph.json');
const OUTPUT_FILE = path.join(PROJECT_ROOT, '0-System/capability-index.json');

// ─── frontmatter 解析 ────────────────────────────────────────────────────────

/**
 * 解析 Markdown 文件开头的 YAML frontmatter
 * 支持字段：name, description, version, layer, authorization, status, created,
 *           depends, related, output_levels, intern_start, intern_end
 * @param {string} content - 文件完整内容
 * @returns {object} 解析后的 frontmatter 对象
 */
function parseFrontmatter(content) {
  const defaults = {
    name: null,
    description: null,
    version: null,
    layer: null,
    authorization: null,
    status: null,
    created: null,
    depends: [],
    related: [],
    output_levels: null,
  };

  if (!content || !content.startsWith('---')) return defaults;

  const end = content.indexOf('\n---', 3);
  if (end === -1) return defaults;

  const block = content.slice(3, end).trim();
  const result = { ...defaults };

  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    const val = stripMatchingQuotes(line.slice(colon + 1).trim());

    if (!key || !val) continue;

    if (key === 'depends' || key === 'related') {
      // 逗号分隔的列表
      result[key] = val.split(',').map(s => s.trim()).filter(Boolean);
    } else if (key in result) {
      result[key] = val;
    }
  }

  return result;
}

// ─── triggers 提取 ──────────────────────────────────────────────────────────

/**
 * 从 description + tags 中提取触发词
 * - tags 中以 / 开头的 → command trigger
 * - tags 中非 layer:/status:/code: 前缀的中文或业务词 → 自然语言触发词
 * @param {string} description
 * @param {string[]} tags
 * @returns {string[]}
 */
function extractTriggers(description, tags) {
  const triggers = [];
  const SKIP_PREFIXES = ['layer:', 'status:', 'code:', 'type:'];

  for (const tag of tags) {
    const isSkip = SKIP_PREFIXES.some(p => tag.startsWith(p));
    if (!isSkip) {
      triggers.push(tag);
    }
  }

  return triggers;
}

// ─── degree 计算 ─────────────────────────────────────────────────────────────

/**
 * 从 KG edges 计算每个 skill 的 degree（出边 + 入边，只计 skill↔skill 之间的边，去重）
 * @param {object[]} edges - KG edges
 * @param {Set<string>} skillIds - 所有 skill id 集合（形如 "skill:xxx"）
 * @returns {{ degreeMap: Map<string, number>, dependedByMap: Map<string, Set<string>> }}
 */
function computeDegrees(edges, skillIds) {
  // 用 Set 去重：key = "source|target" 只算一次
  const seenPairs = new Set();
  const degreeMap = new Map();
  const dependedByMap = new Map();

  for (const id of skillIds) {
    degreeMap.set(id, 0);
    dependedByMap.set(id, new Set());
  }

  // 只有依赖类关系才算真正的依赖，「相关」「链接」「思考」不计入
  const DEP_RELATIONS = ['依赖', '实现', '包含', '改动'];

  for (const edge of edges) {
    const { source, target, relation } = edge;
    const srcIsSkill = skillIds.has(source);
    const tgtIsSkill = skillIds.has(target);

    if (!srcIsSkill || !tgtIsSkill) continue;

    // 过滤：只统计依赖类边
    const base = relation ? relation.split(':')[0] : '';
    if (!DEP_RELATIONS.includes(base)) continue;

    const pairKey = `${source}|${target}`;
    if (!seenPairs.has(pairKey)) {
      seenPairs.add(pairKey);
      degreeMap.set(source, (degreeMap.get(source) || 0) + 1);
      degreeMap.set(target, (degreeMap.get(target) || 0) + 1);
      // 记录 target 被 source 依赖
      const srcName = source.replace('skill:', '');
      dependedByMap.get(target).add(srcName);
    }
  }

  return { degreeMap, dependedByMap };
}

// ─── orphan 检测 ─────────────────────────────────────────────────────────────

/**
 * 找出 degree=0 的孤儿 skill（skill 名称，不含 "skill:" 前缀）
 * @param {Map<string, number>} degreeMap
 * @returns {string[]}
 */
function detectOrphans(degreeMap) {
  const orphans = [];
  for (const [id, deg] of degreeMap) {
    if (deg === 0) orphans.push(id.replace('skill:', ''));
  }
  return orphans;
}

// ─── phantom 检测 ────────────────────────────────────────────────────────────

/**
 * 找出 KG 中标记 phantom=true 的节点 id
 * @param {object[]} nodes
 * @returns {string[]}
 */
function detectPhantoms(nodes) {
  return nodes.filter(n => n.phantom === true).map(n => n.id);
}

// ─── hub 检测 ────────────────────────────────────────────────────────────────

/**
 * 返回 degree 排名前 N 的 hub skill
 * @param {Map<string, number>} degreeMap
 * @param {number} topN
 * @returns {{ name: string, degree: number }[]}
 */
function findHubs(degreeMap, topN = 5) {
  return Array.from(degreeMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id, degree]) => ({ name: id.replace('skill:', ''), degree }));
}

// ─── hasScript 检测 ──────────────────────────────────────────────────────────

/**
 * 检查 skill 是否有脚本文件：
 * 1. 检查 skill 根目录（第一层，非递归）
 * 2. 检查 scripts/ 子目录（递归）
 * @param {string} skillDir - skill 目录绝对路径
 * @returns {{ hasScript: boolean, scriptFiles: string[] }}
 */
function detectScripts(skillDir) {
  const SCRIPT_EXTS = new Set(['.js', '.py', '.mjs', '.ts', '.sh']);
  let scriptFiles = [];

  // 1. 扫描 skill 根目录（第一层，非递归）
  try {
    const entries = fs.readdirSync(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && SCRIPT_EXTS.has(path.extname(entry.name))) {
        scriptFiles.push(entry.name);
      }
    }
  } catch {
    // 读取失败静默跳过
  }

  // 2. 递归扫描 scripts/ 目录（含子目录）
  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    function scan(dir, prefix) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            scan(path.join(dir, entry.name), relPath);
          } else if (SCRIPT_EXTS.has(path.extname(entry.name))) {
            scriptFiles.push(`scripts/${relPath}`);
          }
        }
      } catch {
        // 读取失败静默跳过
      }
    }
    scan(scriptsDir, '');
  }

  return { hasScript: scriptFiles.length > 0, scriptFiles };
}

// ─── 主构建函数 ───────────────────────────────────────────────────────────────

/**
 * 构建完整的 capability-index 数据结构
 * @returns {object} capability-index JSON 对象
 */
function buildCapabilityIndex() {
  // 1. 读取 KG
  let kg = { nodes: [], edges: [] };
  if (fs.existsSync(KG_FILE)) {
    try {
      kg = JSON.parse(fs.readFileSync(KG_FILE, 'utf8'));
    } catch (e) {
      console.warn(`[capability-index] 读取 KG 失败: ${e.message}`);
    }
  }

  // 2. 收集所有 skill id（包括 phantom）
  const allSkillIds = new Set(
    kg.nodes
      .filter(n => n.type === 'skill')
      .map(n => n.id)
  );

  // 3. 计算 degree
  const { degreeMap, dependedByMap } = computeDegrees(kg.edges, allSkillIds);

  // 4. 检测 phantom 和 orphan
  const phantoms = detectPhantoms(kg.nodes);
  const orphanNames = detectOrphans(degreeMap);
  const orphanSet = new Set(orphanNames);

  // 5. 找 hubs
  const hubs = findHubs(degreeMap, 5);

  // 6. 遍历真实 SKILL.md 文件（排除 phantom）
  const skills = [];

  // KG 中标签映射（id → tags）方便后续 trigger 提取
  const nodeTagMap = new Map();
  for (const node of kg.nodes) {
    if (node.type === 'skill') {
      nodeTagMap.set(node.id, node.tags || []);
    }
  }

  // 读取每个 skill 目录
  let skillDirs = [];
  try {
    skillDirs = fs.readdirSync(SKILLS_DIR).filter(d => {
      const fullPath = path.join(SKILLS_DIR, d);
      return fs.statSync(fullPath).isDirectory() && d !== 'README.md';
    });
  } catch (e) {
    console.warn(`[capability-index] 读取 skills 目录失败: ${e.message}`);
  }

  for (const dirName of skillDirs) {
    const skillDir = path.join(SKILLS_DIR, dirName);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) continue;

    let content = '';
    try {
      content = fs.readFileSync(skillMdPath, 'utf8');
    } catch (e) {
      console.warn(`[capability-index] 读取 ${skillMdPath} 失败: ${e.message}`);
      continue;
    }

    const fm = parseFrontmatter(content);
    const name = fm.name || dirName;
    const skillId = `skill:${name}`;

    const tags = nodeTagMap.get(skillId) || [];
    const triggers = extractTriggers(fm.description || '', tags);
    const { hasScript, scriptFiles } = detectScripts(skillDir);
    const degree = degreeMap.get(skillId) ?? 0;
    const dependedBy = Array.from(dependedByMap.get(skillId) || []);

    skills.push({
      name,
      description: fm.description || '',
      version: fm.version || '',
      layer: fm.layer || '',
      status: fm.status || '',
      authorization: fm.authorization || '',
      created: fm.created || '',
      depends: fm.depends,
      triggers,
      hasScript,
      scriptFiles,
      degree,
      dependedBy,
      isOrphan: orphanSet.has(name),
    });
  }

  // 7. 统计
  const byLayer = {};
  const byStatus = {};
  for (const s of skills) {
    byLayer[s.layer || 'unknown'] = (byLayer[s.layer || 'unknown'] || 0) + 1;
    byStatus[s.status || 'unknown'] = (byStatus[s.status || 'unknown'] || 0) + 1;
  }

  return {
    generated: new Date().toISOString(),
    skills,
    stats: {
      total: skills.length,
      byLayer,
      byStatus,
      orphans: orphanNames,
      phantoms,
      hubs,
    },
  };
}

// ─── CLI 入口 ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const index = buildCapabilityIndex();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(index, null, 2), 'utf8');
  console.log(`✅ capability-index 生成完成 → ${OUTPUT_FILE}`);
  console.log(`   Skills: ${index.stats.total}`);
  console.log(`   Layers: ${JSON.stringify(index.stats.byLayer)}`);
  console.log(`   Orphans: ${index.stats.orphans.join(', ') || '无'}`);
  console.log(`   Phantoms: ${index.stats.phantoms.join(', ') || '无'}`);
  console.log(`   Hubs: ${index.stats.hubs.map(h => `${h.name}(${h.degree})`).join(', ')}`);
}

// ─── 导出（供测试使用）───────────────────────────────────────────────────────

module.exports = {
  parseFrontmatter,
  extractTriggers,
  computeDegrees,
  detectOrphans,
  detectPhantoms,
  findHubs,
  buildCapabilityIndex,
};
