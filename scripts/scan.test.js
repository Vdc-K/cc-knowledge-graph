#!/usr/bin/env node

/**
 * Knowledge Graph Scanner — 测试
 * 使用 Node.js 内置 assert
 */

const assert = require('assert');
const { createGraph, validateGraph, extractDecisionSections, scanRoadmapSkillLinks, escapeRegExp } = require('./scan.js');
const { queryGraph } = require('./query.js');

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

// ==================== createGraph 测试 ====================

console.log('\n--- createGraph ---');

test('createGraph 返回独立上下文', () => {
  const ctx1 = createGraph();
  const ctx2 = createGraph();
  ctx1.addNode('a', 'test', 'A', null);
  assert.strictEqual(ctx1.graph.nodes.length, 1);
  assert.strictEqual(ctx2.graph.nodes.length, 0);
});

test('addNode 去重', () => {
  const ctx = createGraph();
  ctx.addNode('a', 'test', 'A', null);
  ctx.addNode('a', 'test', 'A2', null);
  assert.strictEqual(ctx.graph.nodes.length, 1);
  assert.strictEqual(ctx.nodeMap.get('a').label, 'A');
});

test('addEdge 用 Set 去重', () => {
  const ctx = createGraph();
  ctx.addNode('a', 'test', 'A', null);
  ctx.addNode('b', 'test', 'B', null);
  ctx.addEdge('a', 'b', 'rel');
  ctx.addEdge('a', 'b', 'rel');
  assert.strictEqual(ctx.graph.edges.length, 1);
  assert.strictEqual(ctx.edgeSet.size, 1);
});

// ==================== validateGraph 测试 ====================

console.log('\n--- validateGraph ---');

test('正常图：无悬空引用', () => {
  const ctx = createGraph();
  ctx.addNode('a', 'test', 'A', null);
  ctx.addNode('b', 'test', 'B', null);
  ctx.addEdge('a', 'b', 'rel');
  const phantoms = validateGraph(ctx);
  assert.strictEqual(phantoms.length, 0);
});

test('悬空引用：source 不存在', () => {
  const ctx = createGraph();
  ctx.addNode('b', 'test', 'B', null);
  ctx.addEdge('skill:missing', 'b', 'rel');
  const phantoms = validateGraph(ctx);
  assert.strictEqual(phantoms.length, 1);
  assert.strictEqual(phantoms[0].id, 'skill:missing');
  assert.strictEqual(phantoms[0].type, 'skill');
  assert.strictEqual(phantoms[0].phantom, true);
});

test('悬空引用：target 不存在', () => {
  const ctx = createGraph();
  ctx.addNode('a', 'test', 'A', null);
  ctx.addEdge('a', 'code:foo/bar.js', 'rel');
  const phantoms = validateGraph(ctx);
  assert.strictEqual(phantoms.length, 1);
  assert.strictEqual(phantoms[0].type, 'code');
});

test('悬空引用：type 从前缀推断', () => {
  const ctx = createGraph();
  ctx.addEdge('thinking:idea', 'project:xyz', 'rel');
  const phantoms = validateGraph(ctx);
  assert.strictEqual(phantoms.length, 2);
  const types = phantoms.map(p => p.type).sort();
  assert.deepStrictEqual(types, ['project', 'thinking']);
});

test('validateGraph 幂等：多次调用不重复创建 phantom', () => {
  const ctx = createGraph();
  ctx.addNode('a', 'test', 'A', null);
  ctx.addEdge('a', 'skill:ghost', 'rel');
  const p1 = validateGraph(ctx);
  const p2 = validateGraph(ctx);
  assert.strictEqual(p1.length, 1);
  assert.strictEqual(p2.length, 0); // 第二次不再创建
  assert.strictEqual(ctx.graph.nodes.length, 2);
});

// ==================== 决策 sections 测试 ====================

console.log('\n--- 决策 sections ---');

test('标准格式提取', () => {
  const content = `# 决策记录

## 使用 TypeScript（2024-01-15）

**类型**：技术选型
**状态**：已确认
**文件**：src/index.ts, src/config.ts
**相关**：编译配置, 类型安全

正文内容...

## 改用 SQLite（2024-02-01）

**类型**：架构变更
**状态**：进行中
`;

  const ctx = createGraph();
  const sections = extractDecisionSections(content, 'doc:test/决策记录', ctx);
  assert.strictEqual(sections.length, 2);

  assert.strictEqual(sections[0].title, '使用 TypeScript');
  assert.strictEqual(sections[0].date, '2024-01-15');
  assert.strictEqual(sections[0].type, '技术选型');
  assert.strictEqual(sections[0].status, '已确认');
  assert.deepStrictEqual(sections[0].files, ['src/index.ts', 'src/config.ts']);
  assert.deepStrictEqual(sections[0].related, ['编译配置', '类型安全']);

  assert.strictEqual(sections[1].title, '改用 SQLite');
  assert.strictEqual(sections[1].date, '2024-02-01');
});

test('缺失元数据时 graceful', () => {
  const content = `# 决策记录

## 只有标题没有元数据

一些描述文字。
`;

  const ctx = createGraph();
  const sections = extractDecisionSections(content, 'doc:test/决策记录', ctx);
  assert.strictEqual(sections.length, 1);
  assert.strictEqual(sections[0].title, '只有标题没有元数据');
  assert.strictEqual(sections[0].date, null);
  assert.strictEqual(sections[0].type, null);
  assert.strictEqual(sections[0].status, null);
  assert.deepStrictEqual(sections[0].files, []);
  assert.deepStrictEqual(sections[0].related, []);
});

test('决策 files 匹配代码节点建立改动边', () => {
  const ctx = createGraph();
  ctx.addNode('code:myskill/index.ts', 'code', 'myskill/index.ts', '.claude/skills/myskill/scripts/index.ts');
  ctx.addNode('doc:proj/决策记录', 'decision', '决策记录', '2-Projects/proj/decision-making.md');

  const content = `## 某决策（2024-01-01）

**文件**：index.ts
`;
  extractDecisionSections(content, 'doc:test/决策记录', ctx);

  const changeEdges = ctx.graph.edges.filter(e => e.relation === '改动');
  assert.ok(changeEdges.length > 0, '应该建立改动边');
});

// ==================== Roadmap 关联测试 ====================

console.log('\n--- Roadmap 关联 ---');

test('短名称 word boundary 匹配', () => {
  const ctx = createGraph();
  ctx.addNode('skill:dev', 'skill', 'dev', null, []);
  ctx.addNode('skill:api', 'skill', 'api', null, []);

  const content = `#### 1. 开发环境 development

一些描述

#### 2. API 接口

这里提到 dev 工具
`;

  scanRoadmapSkillLinks(content, 'doc:rm', ctx);

  const edges = ctx.graph.edges.filter(e => e.relation === '任务');
  // 'dev' 不应该匹配 'development'（word boundary）
  // 'dev' 应匹配任务2中独立出现的 'dev'
  // 'api' 应匹配任务2标题中的 'API'
  const devEdge = edges.find(e => e.target === 'skill:dev');
  const apiEdge = edges.find(e => e.target === 'skill:api');
  assert.ok(devEdge, 'dev 应匹配任务正文中独立出现的 dev');
  assert.ok(apiEdge, 'api 应匹配标题中的 API');
});

test('Roadmap 去重：同一对只建一条边', () => {
  const ctx = createGraph();
  ctx.addNode('skill:myskill', 'skill', 'myskill', null, []);

  const content = `#### 1. 第一个任务

提到 myskill 的内容

#### 2. 第二个任务

再次提到 myskill
`;

  scanRoadmapSkillLinks(content, 'doc:rm', ctx);
  const edges = ctx.graph.edges.filter(e => e.target === 'skill:myskill');
  assert.strictEqual(edges.length, 1, '同一对 roadmap-skill 只建一条边');
});

// ==================== queryGraph 测试 ====================

console.log('\n--- queryGraph ---');

function makeTestGraph() {
  return {
    nodes: [
      { id: 'skill:auth', type: 'skill', label: 'Auth Service', tags: ['security'] },
      { id: 'skill:db', type: 'skill', label: 'Database', tags: ['storage'] },
      { id: 'code:auth/login.js', type: 'code', label: 'auth/login.js', tags: ['auth'] },
      { id: 'thinking:security', type: 'thinking', label: 'Security Design', tags: [] },
      { id: 'project:main', type: 'project', label: 'Main Project', tags: [] },
    ],
    edges: [
      { source: 'skill:auth', target: 'code:auth/login.js', relation: '实现' },
      { source: 'skill:auth', target: 'skill:db', relation: '依赖' },
      { source: 'thinking:security', target: 'skill:auth', relation: '思考' },
      { source: 'project:main', target: 'skill:db', relation: '包含' },
    ],
  };
}

test('精确匹配（id）', () => {
  const g = makeTestGraph();
  const result = queryGraph(g, 'auth', 0);
  // depth=0 只返回种子节点
  const ids = result.nodes.map(n => n.id);
  assert.ok(ids.includes('skill:auth'));
  assert.ok(ids.includes('code:auth/login.js'));
});

test('模糊匹配（label，大小写不敏感）', () => {
  const g = makeTestGraph();
  const result = queryGraph(g, 'DATABASE', 0);
  assert.strictEqual(result.nodes.length, 1);
  assert.strictEqual(result.nodes[0].id, 'skill:db');
});

test('tags 匹配', () => {
  const g = makeTestGraph();
  const result = queryGraph(g, 'security', 0);
  const ids = result.nodes.map(n => n.id);
  assert.ok(ids.includes('skill:auth'));
  assert.ok(ids.includes('thinking:security'));
});

test('1 跳扩展', () => {
  const g = makeTestGraph();
  const result = queryGraph(g, 'auth', 1);
  const ids = result.nodes.map(n => n.id);
  // skill:auth 的邻居：code:auth/login.js, skill:db, thinking:security
  assert.ok(ids.includes('skill:auth'));
  assert.ok(ids.includes('skill:db'));
  assert.ok(ids.includes('thinking:security'));
});

test('2 跳扩展', () => {
  const g = makeTestGraph();
  const result = queryGraph(g, 'security', 2);
  const ids = result.nodes.map(n => n.id);
  // thinking:security -> skill:auth -> skill:db, code:auth/login.js
  // skill:auth 也匹配 tags:security -> skill:db, code:auth/login.js, thinking:security
  // 2跳：skill:db -> project:main
  assert.ok(ids.includes('project:main'), '2跳应该到达 project:main');
});

test('环路安全', () => {
  const g = {
    nodes: [
      { id: 'a', type: 't', label: 'A', tags: [] },
      { id: 'b', type: 't', label: 'B', tags: [] },
      { id: 'c', type: 't', label: 'C', tags: [] },
    ],
    edges: [
      { source: 'a', target: 'b', relation: 'r' },
      { source: 'b', target: 'c', relation: 'r' },
      { source: 'c', target: 'a', relation: 'r' }, // 环
    ],
  };
  const result = queryGraph(g, 'A', 10);
  assert.strictEqual(result.nodes.length, 3, '环路不应导致无限循环');
  assert.strictEqual(result.edges.length, 3);
});

test('空查询返回空结果', () => {
  const g = makeTestGraph();
  const result = queryGraph(g, '', 2);
  assert.strictEqual(result.nodes.length, 0);
  assert.strictEqual(result.edges.length, 0);
});

test('无匹配返回空结果', () => {
  const g = makeTestGraph();
  const result = queryGraph(g, 'zzzznotexist', 2);
  assert.strictEqual(result.nodes.length, 0);
  assert.strictEqual(result.edges.length, 0);
});

test('edges 只包含子图内部的边', () => {
  const g = makeTestGraph();
  const result = queryGraph(g, 'auth', 0);
  // depth=0: skill:auth, code:auth/login.js
  // 内部边：skill:auth -> code:auth/login.js
  for (const e of result.edges) {
    const nodeIds = result.nodes.map(n => n.id);
    assert.ok(nodeIds.includes(e.source), `source ${e.source} 应在子图中`);
    assert.ok(nodeIds.includes(e.target), `target ${e.target} 应在子图中`);
  }
});

// ==================== 汇总 ====================

console.log(`\n总计: ${passed + failed} 个测试, ${passed} 通过, ${failed} 失败\n`);

if (failed > 0) {
  process.exit(1);
}
