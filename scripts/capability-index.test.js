#!/usr/bin/env node

/**
 * capability-index 测试
 * 使用 Node.js 内置 assert，无外部依赖
 */

const assert = require('assert');
const {
  parseFrontmatter,
  extractTriggers,
  computeDegrees,
  detectOrphans,
  detectPhantoms,
  findHubs,
  buildCapabilityIndex,
} = require('./capability-index.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

// ==================== parseFrontmatter ====================

console.log('\n--- parseFrontmatter ---');

test('解析基础 frontmatter 字段', () => {
  const content = `---
name: dev-team
description: 复杂任务团队开发
version: '0.1.0'
layer: routing
authorization: B区（关键步骤确认）
status: stable
created: 2026-03-12
depends: dev, decision, tell-me
---

# 正文
`;
  const fm = parseFrontmatter(content);
  assert.strictEqual(fm.name, 'dev-team');
  assert.strictEqual(fm.description, '复杂任务团队开发');
  assert.strictEqual(fm.version, '0.1.0');
  assert.strictEqual(fm.layer, 'routing');
  assert.strictEqual(fm.status, 'stable');
  assert.strictEqual(fm.created, '2026-03-12');
  assert.deepStrictEqual(fm.depends, ['dev', 'decision', 'tell-me']);
});

test('depends 为空时返回空数组', () => {
  const content = `---
name: cc-usage
status: stable
---
`;
  const fm = parseFrontmatter(content);
  assert.deepStrictEqual(fm.depends, []);
});

test('related 字段正确解析', () => {
  const content = `---
name: knowledge-graph
related: 知识图谱-cc导航系统
---
`;
  const fm = parseFrontmatter(content);
  assert.deepStrictEqual(fm.related, ['知识图谱-cc导航系统']);
});

test('没有 frontmatter 时返回默认值', () => {
  const content = `# 只有正文，没有 frontmatter\n内容`;
  const fm = parseFrontmatter(content);
  assert.strictEqual(fm.name, null);
  assert.deepStrictEqual(fm.depends, []);
});

test('output_levels 字段正确提取', () => {
  const content = `---
name: dev
output_levels: L2（过程 + 结论）
---
`;
  const fm = parseFrontmatter(content);
  assert.strictEqual(fm.output_levels, 'L2（过程 + 结论）');
});

// ==================== extractTriggers ====================

console.log('\n--- extractTriggers ---');

test('从 tags 中提取 /command 触发词', () => {
  const tags = ['/dev-team', 'layer:routing', 'status:stable', '用团队开发', '复杂功能'];
  const description = '复杂任务团队开发';
  const triggers = extractTriggers(description, tags);
  assert.ok(triggers.includes('/dev-team'), '应包含 /dev-team');
  assert.ok(triggers.includes('用团队开发'), '应包含中文触发词');
  assert.ok(triggers.includes('复杂功能'), '应包含中文触发词');
  assert.ok(!triggers.includes('layer:routing'), '不应包含 layer 标签');
  assert.ok(!triggers.includes('status:stable'), '不应包含 status 标签');
});

test('tags 为空时返回空数组', () => {
  const triggers = extractTriggers('描述', []);
  assert.deepStrictEqual(triggers, []);
});

test('/sleep 等多命令标签也能提取', () => {
  const tags = ['/daily-archive', '/sleep', '归档今天'];
  const triggers = extractTriggers('description', tags);
  assert.ok(triggers.includes('/daily-archive'));
  assert.ok(triggers.includes('/sleep'));
  assert.ok(triggers.includes('归档今天'));
});

// ==================== computeDegrees ====================

console.log('\n--- computeDegrees ---');

test('degree 计算正确（出边 + 入边去重）', () => {
  const edges = [
    { source: 'skill:A', target: 'skill:B', relation: '依赖:B' },
    { source: 'skill:A', target: 'skill:C', relation: '依赖:C' },
    { source: 'skill:D', target: 'skill:A', relation: '依赖:A' },
  ];
  const skillIds = new Set(['skill:A', 'skill:B', 'skill:C', 'skill:D']);
  const { degreeMap, dependedByMap } = computeDegrees(edges, skillIds);
  // A: 出2 + 入1 = 3
  assert.strictEqual(degreeMap.get('skill:A'), 3);
  // B: 入1
  assert.strictEqual(degreeMap.get('skill:B'), 1);
  // D: 出1
  assert.strictEqual(degreeMap.get('skill:D'), 1);
});

test('dependedByMap 正确记录被依赖关系', () => {
  const edges = [
    { source: 'skill:full-dev', target: 'skill:dev-team', relation: '依赖:dev-team' },
    { source: 'skill:morning', target: 'skill:dev-team', relation: '依赖:dev-team' },
  ];
  const skillIds = new Set(['skill:full-dev', 'skill:morning', 'skill:dev-team']);
  const { dependedByMap } = computeDegrees(edges, skillIds);
  const deps = dependedByMap.get('skill:dev-team');
  assert.ok(deps.has('full-dev'), 'dev-team 应被 full-dev 依赖');
  assert.ok(deps.has('morning'), 'dev-team 应被 morning 依赖');
});

test('重复边只计一次 degree', () => {
  // daily-archive 有两条指向 tell-me 的边
  const edges = [
    { source: 'skill:daily-archive', target: 'skill:tell-me', relation: '依赖:tell-me' },
    { source: 'skill:daily-archive', target: 'skill:tell-me', relation: '依赖:飞书通知' },
  ];
  const skillIds = new Set(['skill:daily-archive', 'skill:tell-me']);
  const { degreeMap } = computeDegrees(edges, skillIds);
  // tell-me 只被 daily-archive 依赖一次（去重）
  assert.strictEqual(degreeMap.get('skill:tell-me'), 1);
});

test('非 skill 节点不计入 degree', () => {
  const edges = [
    { source: 'skill:knowledge-graph', target: 'code:kg/query.js', relation: '实现' },
    { source: 'thinking:xxx', target: 'skill:dashboard', relation: '思考' },
  ];
  const skillIds = new Set(['skill:knowledge-graph', 'skill:dashboard']);
  const { degreeMap } = computeDegrees(edges, skillIds);
  // knowledge-graph 出边指向非 skill，不计
  assert.strictEqual(degreeMap.get('skill:knowledge-graph'), 0);
  // dashboard 被 thinking 指向，不计（非 skill）
  assert.strictEqual(degreeMap.get('skill:dashboard'), 0);
});

// ==================== detectOrphans ====================

console.log('\n--- detectOrphans ---');

test('degree=0 的 skill 为孤儿', () => {
  const degreeMap = new Map([
    ['skill:A', 0],
    ['skill:B', 3],
    ['skill:C', 0],
  ]);
  const orphans = detectOrphans(degreeMap);
  assert.deepStrictEqual(orphans.sort(), ['A', 'C']);
});

test('没有孤儿时返回空数组', () => {
  const degreeMap = new Map([
    ['skill:A', 2],
    ['skill:B', 1],
  ]);
  const orphans = detectOrphans(degreeMap);
  assert.deepStrictEqual(orphans, []);
});

// ==================== detectPhantoms ====================

console.log('\n--- detectPhantoms ---');

test('检测 phantom=true 的节点', () => {
  const nodes = [
    { id: 'skill:content-review', type: 'skill', phantom: true },
    { id: 'skill:dev', type: 'skill' },
    { id: 'skill:tell-me', type: 'skill', phantom: false },
  ];
  const phantoms = detectPhantoms(nodes);
  assert.deepStrictEqual(phantoms, ['skill:content-review']);
});

test('没有 phantom 时返回空数组', () => {
  const nodes = [
    { id: 'skill:dev', type: 'skill' },
  ];
  const phantoms = detectPhantoms(nodes);
  assert.deepStrictEqual(phantoms, []);
});

// ==================== findHubs ====================

console.log('\n--- findHubs ---');

test('返回 degree 前 5 的 hub skill', () => {
  const degreeMap = new Map([
    ['skill:A', 10],
    ['skill:B', 5],
    ['skill:C', 8],
    ['skill:D', 3],
    ['skill:E', 7],
    ['skill:F', 1],
  ]);
  const hubs = findHubs(degreeMap, 5);
  assert.strictEqual(hubs.length, 5);
  assert.strictEqual(hubs[0].name, 'A');
  assert.strictEqual(hubs[0].degree, 10);
  assert.strictEqual(hubs[1].name, 'C');
  assert.strictEqual(hubs[2].name, 'E');
});

test('skill 数量少于 5 时返回全部', () => {
  const degreeMap = new Map([
    ['skill:A', 5],
    ['skill:B', 3],
  ]);
  const hubs = findHubs(degreeMap, 5);
  assert.strictEqual(hubs.length, 2);
});

// ==================== buildCapabilityIndex（集成测试）====================

console.log('\n--- buildCapabilityIndex（集成）---');

test('集成：从真实文件构建 capability-index', () => {
  const index = buildCapabilityIndex();

  // 基础结构
  assert.ok(typeof index.generated === 'string', '应有 generated 时间戳');
  assert.ok(Array.isArray(index.skills), 'skills 应为数组');
  assert.ok(typeof index.stats === 'object', 'stats 应为对象');

  // stats 字段
  assert.ok(typeof index.stats.total === 'number', 'stats.total 应为数字');
  assert.ok(typeof index.stats.byLayer === 'object');
  assert.ok(typeof index.stats.byStatus === 'object');
  assert.ok(Array.isArray(index.stats.orphans));
  assert.ok(Array.isArray(index.stats.phantoms));
  assert.ok(Array.isArray(index.stats.hubs));
});

test('集成：dev-team skill 字段完整', () => {
  const index = buildCapabilityIndex();
  const devTeam = index.skills.find(s => s.name === 'dev-team');
  assert.ok(devTeam, 'dev-team 应存在');
  assert.strictEqual(devTeam.layer, 'routing');
  assert.strictEqual(devTeam.status, 'stable');
  assert.strictEqual(devTeam.version, '0.1.0');
  assert.ok(Array.isArray(devTeam.depends), 'depends 应为数组');
  assert.ok(devTeam.depends.includes('dev'), 'depends 应包含 dev');
  assert.ok(Array.isArray(devTeam.triggers), 'triggers 应为数组');
  assert.ok(devTeam.triggers.includes('/dev-team'), 'triggers 应包含 /dev-team');
  assert.ok(typeof devTeam.degree === 'number', 'degree 应为数字');
  assert.ok(Array.isArray(devTeam.dependedBy), 'dependedBy 应为数组');
  assert.ok(typeof devTeam.isOrphan === 'boolean', 'isOrphan 应为 boolean');
  assert.ok(typeof devTeam.hasScript === 'boolean', 'hasScript 应为 boolean');
  assert.strictEqual(devTeam.hasScript, false, 'dev-team 无脚本');
});

test('集成：knowledge-graph skill hasScript=true', () => {
  const index = buildCapabilityIndex();
  const kg = index.skills.find(s => s.name === 'knowledge-graph');
  assert.ok(kg, 'knowledge-graph 应存在');
  assert.strictEqual(kg.hasScript, true, 'knowledge-graph 有脚本');
  assert.ok(kg.scriptFiles.length > 0, 'scriptFiles 不为空');
});

test('集成：phantom skill 被检测到', () => {
  const index = buildCapabilityIndex();
  assert.ok(index.stats.phantoms.includes('skill:content-review'), '应检测到 skill:content-review phantom');
});

test('集成：full-dev dependedBy 为空', () => {
  const index = buildCapabilityIndex();
  const fullDev = index.skills.find(s => s.name === 'full-dev');
  assert.ok(fullDev, 'full-dev 应存在');
  assert.deepStrictEqual(fullDev.dependedBy, [], 'full-dev 没有被任何 skill 依赖');
});

test('集成：total 等于 skills 数组长度', () => {
  const index = buildCapabilityIndex();
  assert.strictEqual(index.stats.total, index.skills.length);
});

test('集成：byLayer 统计值之和等于 total', () => {
  const index = buildCapabilityIndex();
  const layerTotal = Object.values(index.stats.byLayer).reduce((a, b) => a + b, 0);
  assert.strictEqual(layerTotal, index.stats.total);
});

test('集成：tell-me skill hasScript=true（脚本在根目录）', () => {
  const index = buildCapabilityIndex();
  const tellMe = index.skills.find(s => s.name === 'tell-me');
  assert.ok(tellMe, 'tell-me 应存在');
  assert.strictEqual(tellMe.hasScript, true, 'tell-me 根目录有 send.js，hasScript 应为 true');
  assert.ok(tellMe.scriptFiles.length > 0, 'scriptFiles 不为空');
});

// ==================== 汇报 ====================

console.log(`\n总计：${passed + failed} 个测试，${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
