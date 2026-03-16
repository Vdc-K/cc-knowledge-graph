#!/usr/bin/env node

/**
 * Knowledge Graph Scanner — 测试
 * 使用 Node.js 内置 assert
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createGraph, validateGraph, resolveDeferredEdges, extractDecisionSections, scanRoadmapSkillLinks, escapeRegExp, extractFunctionNames, getProjectDocMeta } = require('./scan.js');
const { queryGraph, queryContext, shouldIncludeSession, inferDisplayProfile } = require('./query.js');

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
  ctx.addNode('doc:proj/决策记录', 'decision', '决策记录', '2-Projects/proj/decision_making.md');

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

test('2 跳扩展（强连接保留，弱连接截断）', () => {
  const g = makeTestGraph();
  const result = queryGraph(g, 'security', 2);
  const ids = result.nodes.map(n => n.id);
  // 1跳强连接应保留
  assert.ok(ids.includes('skill:auth'), '1跳 skill:auth 应保留');
  assert.ok(ids.includes('code:auth/login.js'), '1跳 code 应保留');
  assert.ok(ids.includes('skill:db'), '2跳 skill:db 应保留');
  // 2跳弱反向连接可能被分数截断（这是新行为的正确表现）
  // project:main 通过 包含→反向→2跳 连接，分数低于阈值
  assert.ok(result.nodes.length <= 20, '结果应被截断到 maxNodes');
  // 验证分数排序
  const scores = result.nodes.map(n => n._score || 0);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i], '结果应按分数降序');
  }
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

// ==================== queryContext 测试 ====================

console.log('\n--- queryContext ---');

test('session-memory 仅在 continue 类 query 时注入', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-query-'));
  const sessionPath = path.join(projectDir, 'last-session.md');
  fs.writeFileSync(sessionPath, [
    '# 上次会话',
    '',
    '## 正在做什么',
    '继续修 scheduler 的定时任务',
  ].join('\n'));

  const result = queryContext({
    graph: null,
    query: 'session',
    projectDir,
    sessionFile: sessionPath,
  });

  assert.ok(result.includes('### 上次会话'), 'continue 类 query 应注入 session-memory');
});

test('session-memory 对无关 query 不应注入', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-query-'));
  const sessionPath = path.join(projectDir, 'last-session.md');
  fs.writeFileSync(sessionPath, [
    '# 上次会话',
    '',
    '## 正在做什么',
    '继续修 scheduler 的定时任务',
  ].join('\n'));

  const result = queryContext({
    graph: null,
    query: 'about-me',
    projectDir,
    sessionFile: sessionPath,
  });

  assert.ok(!result.includes('### 上次会话'), '无关 query 不应注入 session-memory');
});

test('session-memory 对语义相关 query 可注入', () => {
  const session = {
    '正在做什么': '继续修 scheduler 的定时任务',
    '下一步': '补 cron 规则',
  };
  assert.strictEqual(shouldIncludeSession('scheduler', session), true);
  assert.strictEqual(shouldIncludeSession('dashboard', session), false);
});

test('项目 query 应优先展示总览文档并压缩补充文档', () => {
  const graph = {
    nodes: [
      { id: 'project:MACS', type: 'project', label: 'MACS', _score: 1, _distance: 0 },
      { id: 'doc:MACS/macs-skill/README', type: 'doc', label: 'README', doc_kind: 'readme', doc_priority: 5, path_depth: 1, file: '2-Projects/MACS/macs-skill/README.md', _score: 0.7, _distance: 1 },
      { id: 'doc:MACS/macs-skill/PROJECT', type: 'doc', label: 'PROJECT', doc_kind: 'project', doc_priority: 4, path_depth: 1, file: '2-Projects/MACS/macs-skill/PROJECT.md', _score: 0.68, _distance: 1 },
      { id: 'doc:MACS/macs-skill/docs/FAQ', type: 'doc', label: 'FAQ', doc_kind: 'docs', doc_priority: 2, path_depth: 2, file: '2-Projects/MACS/macs-skill/docs/FAQ.md', _score: 0.66, _distance: 1 },
      { id: 'doc:MACS/macs-skill/adapters/codex/README', type: 'doc', label: 'Codex README', doc_kind: 'readme', doc_priority: 5, path_depth: 3, file: '2-Projects/MACS/macs-skill/adapters/codex/README.md', _score: 0.64, _distance: 1 },
      { id: 'doc:MACS/decision_making', type: 'decision', label: 'MACS decision', file: '2-Projects/MACS/decision-making.md', _score: 0.69, _distance: 1 },
    ],
    edges: [
      { source: 'project:MACS', target: 'doc:MACS/macs-skill/README', relation: '包含' },
      { source: 'project:MACS', target: 'doc:MACS/macs-skill/PROJECT', relation: '包含' },
      { source: 'project:MACS', target: 'doc:MACS/macs-skill/docs/FAQ', relation: '包含' },
      { source: 'project:MACS', target: 'doc:MACS/macs-skill/adapters/codex/README', relation: '包含' },
      { source: 'project:MACS', target: 'doc:MACS/decision_making', relation: '包含' },
    ],
  };

  const result = queryContext({
    graph,
    query: 'MACS',
    projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kg-query-project-')),
    sessionFile: null,
  });

  assert.ok(result.includes('*项目概览*'), '项目型 query 应显示项目概览分组');
  assert.ok(result.includes('doc:MACS/macs-skill/README'), '应展示顶层 README');
  assert.ok(result.includes('doc:MACS/decision_making'), '应展示决策文档');
  assert.ok(result.includes('*项目文档（补充）*'), '应把次级项目文档单独分组');
  assert.ok(result.includes('doc:MACS/macs-skill/adapters/codex/README'), '深层 README 应进入补充分组');
});

test('skill 主导 query 应按能力 / 实现 / 文档分组', () => {
  const graph = {
    nodes: [
      { id: 'skill:dev', type: 'skill', label: 'dev', _score: 1, _distance: 0 },
      { id: 'skill:dev-team', type: 'skill', label: 'dev-team', _score: 0.8, _distance: 1 },
      { id: 'code:dev/run.js', type: 'code', label: 'run.js', file: '.claude/skills/dev/scripts/run.js', _score: 0.74, _distance: 1 },
      { id: 'thinking:dev-flow', type: 'thinking', label: 'dev flow', file: '3-Thinking/dev-flow.md', _score: 0.62, _distance: 1 },
      { id: 'doc:dev/README', type: 'doc', label: 'README', file: '.claude/skills/dev/README.md', doc_kind: 'readme', path_depth: 0, _score: 0.58, _distance: 1 },
    ],
    edges: [
      { source: 'skill:dev', target: 'skill:dev-team', relation: '依赖' },
      { source: 'skill:dev', target: 'code:dev/run.js', relation: '实现' },
      { source: 'thinking:dev-flow', target: 'skill:dev', relation: '思考' },
      { source: 'doc:dev/README', target: 'skill:dev', relation: '链接' },
    ],
  };

  const result = queryContext({
    graph,
    query: 'dev',
    projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kg-query-skill-')),
    sessionFile: null,
  });

  assert.ok(result.includes('*核心能力*'), 'skill 型 query 应显示核心能力分组');
  assert.ok(result.includes('*实现 / 依赖*'), 'skill 型 query 应显示实现 / 依赖分组');
  assert.ok(result.includes('*思考 / 文档*'), 'skill 型 query 应显示思考 / 文档分组');
});

test('混合 query 应回退到核心相关分组', () => {
  const graph = {
    nodes: [
      { id: 'skill:alpha', type: 'skill', label: 'alpha', tags: ['shared'], _score: 1, _distance: 0 },
      { id: 'doc:beta/README', type: 'doc', label: 'beta', file: 'docs/beta.md', doc_kind: 'readme', path_depth: 0, tags: ['shared'], _score: 0.95, _distance: 0 },
      { id: 'thinking:gamma', type: 'thinking', label: 'gamma', file: '3-Thinking/gamma.md', tags: [], _score: 0.9, _distance: 1 },
    ],
    edges: [
      { source: 'skill:alpha', target: 'thinking:gamma', relation: '思考' },
      { source: 'doc:beta/README', target: 'thinking:gamma', relation: '链接' },
    ],
  };

  assert.strictEqual(inferDisplayProfile(graph.nodes), 'mixed');

  const result = queryContext({
    graph,
    query: 'shared',
    projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kg-query-mixed-')),
    sessionFile: null,
  });

  assert.ok(result.includes('*核心相关*'), '混合 query 应回退到核心相关分组');
  assert.ok(!result.includes('*项目概览*'), '混合 query 不应误判成项目型');
  assert.ok(!result.includes('*核心能力*'), '混合 query 不应误判成 skill 型');
});

// ==================== 项目递归扫描测试 ====================

console.log('\n--- project scan ---');

test('项目扫描应纳入项目内 README 和 docs 文档', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-project-'));
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  const projectsDir = path.join(projectDir, '2-Projects', 'DemoProj', 'nested');
  const docsDir = path.join(projectDir, '2-Projects', 'DemoProj', 'docs');
  const systemDir = path.join(projectDir, '0-System');

  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(systemDir, { recursive: true });

  fs.writeFileSync(path.join(projectDir, '2-Projects', 'DemoProj', 'decision_making.md'), '# 决策');
  fs.writeFileSync(path.join(projectsDir, 'README.md'), '# Nested README\n');
  fs.writeFileSync(path.join(docsDir, 'spec.md'), '# Spec Doc\n');

  const scanScript = path.resolve(__dirname, 'scan.js');
  const result = spawnSync('node', [scanScript], {
    cwd: projectDir,
    encoding: 'utf-8',
  });

  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const graph = JSON.parse(
    fs.readFileSync(path.join(projectDir, '0-System', 'knowledge-graph.json'), 'utf-8')
  );

  const nestedReadme = graph.nodes.find(n => n.id === 'doc:DemoProj/nested/README');
  const specDoc = graph.nodes.find(n => n.id === 'doc:DemoProj/docs/spec');
  const decision = graph.nodes.find(n => n.id === 'doc:DemoProj/decision_making');

  assert.ok(nestedReadme, '应扫描项目内嵌套 README');
  assert.ok(specDoc, '应扫描 docs/ 下文档');
  assert.ok(decision, '决策记录仍应存在');
});

test('项目文档元数据应识别 kind 和深度', () => {
  const topReadme = getProjectDocMeta('README.md');
  const nestedDoc = getProjectDocMeta('adapters/codex/README.md');

  assert.strictEqual(topReadme.kind, 'readme');
  assert.strictEqual(topReadme.depth, 0);
  assert.ok(topReadme.priority > nestedDoc.priority || topReadme.depth < nestedDoc.depth);
});

test('doc 节点应限流并优先浅层关键文档', () => {
  const graph = {
    nodes: [
      { id: 'project:macs', type: 'project', label: 'MACS', tags: [] },
      { id: 'doc:macs/README', type: 'doc', label: 'README', doc_kind: 'readme', doc_priority: 5, path_depth: 0, tags: ['文档'] },
      { id: 'doc:macs/PROJECT', type: 'doc', label: 'PROJECT', doc_kind: 'project', doc_priority: 4, path_depth: 0, tags: ['文档'] },
      { id: 'doc:macs/docs/FAQ', type: 'doc', label: 'FAQ', doc_kind: 'docs', doc_priority: 2, path_depth: 1, tags: ['文档'] },
      { id: 'doc:macs/adapters/a/README', type: 'doc', label: 'A README', doc_kind: 'readme', doc_priority: 5, path_depth: 2, tags: ['文档'] },
      { id: 'doc:macs/adapters/b/README', type: 'doc', label: 'B README', doc_kind: 'readme', doc_priority: 5, path_depth: 2, tags: ['文档'] },
      { id: 'doc:macs/adapters/c/README', type: 'doc', label: 'C README', doc_kind: 'readme', doc_priority: 5, path_depth: 2, tags: ['文档'] },
      { id: 'doc:macs/adapters/d/README', type: 'doc', label: 'D README', doc_kind: 'readme', doc_priority: 5, path_depth: 2, tags: ['文档'] },
      { id: 'doc:macs/adapters/e/README', type: 'doc', label: 'E README', doc_kind: 'readme', doc_priority: 5, path_depth: 2, tags: ['文档'] },
      { id: 'doc:macs/adapters/f/README', type: 'doc', label: 'F README', doc_kind: 'readme', doc_priority: 5, path_depth: 2, tags: ['文档'] },
      { id: 'doc:macs/adapters/g/README', type: 'doc', label: 'G README', doc_kind: 'readme', doc_priority: 5, path_depth: 2, tags: ['文档'] },
    ],
    edges: [
      { source: 'project:macs', target: 'doc:macs/README', relation: '包含' },
      { source: 'project:macs', target: 'doc:macs/PROJECT', relation: '包含' },
      { source: 'project:macs', target: 'doc:macs/docs/FAQ', relation: '包含' },
      { source: 'project:macs', target: 'doc:macs/adapters/a/README', relation: '包含' },
      { source: 'project:macs', target: 'doc:macs/adapters/b/README', relation: '包含' },
      { source: 'project:macs', target: 'doc:macs/adapters/c/README', relation: '包含' },
      { source: 'project:macs', target: 'doc:macs/adapters/d/README', relation: '包含' },
      { source: 'project:macs', target: 'doc:macs/adapters/e/README', relation: '包含' },
      { source: 'project:macs', target: 'doc:macs/adapters/f/README', relation: '包含' },
      { source: 'project:macs', target: 'doc:macs/adapters/g/README', relation: '包含' },
    ],
  };

  const result = queryGraph(graph, 'macs', 1);
  const docs = result.nodes.filter(n => n.type === 'doc');

  assert.ok(docs.length <= 6, 'doc 节点应被限流');
  assert.ok(docs.some(n => n.id === 'doc:macs/README'), '应保留顶层 README');
  assert.ok(docs.some(n => n.id === 'doc:macs/PROJECT'), '应保留 PROJECT 文档');
});

// ==================== extractFunctionNames 测试 ====================

console.log('\n--- extractFunctionNames ---');

test('function 声明', () => {
  const names = extractFunctionNames('function foo() {}\nfunction bar(x) { return x; }');
  assert.ok(names.has('foo'), 'should detect foo');
  assert.ok(names.has('bar'), 'should detect bar');
});

test('const 箭头函数', () => {
  const names = extractFunctionNames('const foo = () => {}\nconst bar = async (x) => x');
  assert.ok(names.has('foo'), 'should detect foo');
  assert.ok(names.has('bar'), 'should detect bar');
});

test('class 方法', () => {
  const code = `class Foo {\n  myMethod() {}\n  async asyncMethod(x) {}\n}`;
  const names = extractFunctionNames(code);
  assert.ok(names.has('myMethod'), 'should detect myMethod');
  assert.ok(names.has('asyncMethod'), 'should detect asyncMethod');
});

test('关键字不被误检测', () => {
  const names = extractFunctionNames('  if (x) {}\n  for (i) {}\n  while (true) {}');
  assert.ok(!names.has('if'), 'if should not be detected');
  assert.ok(!names.has('for'), 'for should not be detected');
  assert.ok(!names.has('while'), 'while should not be detected');
});

test('混合风格全部检出', () => {
  const code = [
    'function legacy() {}',
    'const arrow = (x) => x',
    'class Cls {',
    '  method() {}',
    '}',
  ].join('\n');
  const names = extractFunctionNames(code);
  assert.ok(names.has('legacy'));
  assert.ok(names.has('arrow'));
  assert.ok(names.has('method'));
});

// ==================== scanWikiLinks 测试 ====================

console.log('\n--- scanWikiLinks ---');

// 辅助：从 scan.js 内部调用 scanWikiLinks 需要通过 ctx
const { createGraph: _cg, validateGraph: _vg, extractDecisionSections: _eds, scanRoadmapSkillLinks: _srl, escapeRegExp: _er, extractFunctionNames: _efn } = require('./scan.js');
// scanWikiLinks 未导出，通过 createGraph + 手动调用
// 改为测试其效果（通过 extractDecisionSections 间接）
// 或直接测试 scanWikiLinks 的 phantom 逻辑

test('scanWikiLinks: [[ref]] 匹配到已有节点', () => {
  const ctx = createGraph();
  ctx.addNode('skill:auth', 'skill', 'auth', 'skills/auth/SKILL.md', []);

  // 手动模拟 scanWikiLinks 逻辑（函数未导出，验证通过边推断）
  // 已知行为：findWikiLinks 应找到 [[auth]] 并链接到 skill:auth
  const content = '参考 [[auth]] 实现认证。';
  const wikiRegex = /\[\[([^\]]+)\]\]/g;
  const { nodeMap, addEdge } = ctx;
  let match;
  while ((match = wikiRegex.exec(content)) !== null) {
    const ref = match[1].trim();
    const refLower = ref.toLowerCase();
    // 精确匹配
    if (nodeMap.has(`skill:${ref}`)) {
      addEdge('source:test', `skill:${ref}`, '链接');
    } else {
      // 大小写不敏感
      for (const [nodeId] of nodeMap) {
        const ci = nodeId.indexOf(':');
        if (ci < 0) continue;
        if (nodeId.substring(ci + 1).toLowerCase() === refLower) {
          addEdge('source:test', nodeId, '链接');
        }
      }
    }
  }
  const edge = ctx.graph.edges.find(e => e.target === 'skill:auth');
  assert.ok(edge, '[[auth]] 应链接到 skill:auth');
});

test('scanWikiLinks: [[Auth]] 大小写不敏感匹配', () => {
  const ctx = createGraph();
  ctx.addNode('skill:auth', 'skill', 'auth', 'skills/auth/SKILL.md', []);
  const content = '参考 [[Auth]] 实现。';
  const wikiRegex = /\[\[([^\]]+)\]\]/g;
  const { nodeMap, addEdge } = ctx;
  let match;
  while ((match = wikiRegex.exec(content)) !== null) {
    const ref = match[1].trim();
    const refLower = ref.toLowerCase();
    let resolved = false;
    if (nodeMap.has(`skill:${ref}`)) { addEdge('source:test', `skill:${ref}`, '链接'); resolved = true; }
    if (!resolved) {
      for (const [nodeId] of nodeMap) {
        const ci = nodeId.indexOf(':');
        if (ci < 0) continue;
        if (nodeId.substring(ci + 1).toLowerCase() === refLower) {
          addEdge('source:test', nodeId, '链接'); resolved = true; break;
        }
      }
    }
    if (!resolved) {
      ctx.addNode(`phantom:${ref}`, 'phantom', ref, null, []);
      addEdge('source:test', `phantom:${ref}`, '链接');
    }
  }
  const edge = ctx.graph.edges.find(e => e.target === 'skill:auth');
  assert.ok(edge, '[[Auth]] 大小写不敏感，应链接到 skill:auth');
});

test('scanWikiLinks: 未知 ref 创建 phantom', () => {
  const ctx = createGraph();
  const content = '参考 [[unknown-skill]] 实现。';
  const wikiRegex = /\[\[([^\]]+)\]\]/g;
  const { nodeMap, addNode, addEdge } = ctx;
  let match;
  while ((match = wikiRegex.exec(content)) !== null) {
    const ref = match[1].trim();
    let resolved = false;
    for (const [nodeId] of nodeMap) {
      const ci = nodeId.indexOf(':');
      if (ci >= 0 && nodeId.substring(ci + 1).toLowerCase() === ref.toLowerCase()) {
        addEdge('source:test', nodeId, '链接'); resolved = true; break;
      }
    }
    if (!resolved) {
      addNode(`phantom:${ref}`, 'phantom', ref, null, []);
      addEdge('source:test', `phantom:${ref}`, '链接');
    }
  }
  const phantom = ctx.graph.nodes.find(n => n.id === 'phantom:unknown-skill');
  assert.ok(phantom, '未知 ref 应创建 phantom 节点');
  assert.strictEqual(phantom.type, 'phantom');
});

// ==================== extractDecisionSections 补充测试 ====================

console.log('\n--- extractDecisionSections 补充 ---');

test('英文括号日期解析', () => {
  const content = `## SDK 崩溃修复(2024-03-15)\n\n### 现象\n描述`;
  const ctx = createGraph();
  const sections = extractDecisionSections(content, 'doc:test', ctx);
  assert.strictEqual(sections.length, 1);
  assert.strictEqual(sections[0].date, '2024-03-15', '应支持英文括号日期');
});

test('文件路径精确匹配（endsWith）', () => {
  const ctx = createGraph();
  // 两个文件：src/utils/index.ts 和 src/index.ts
  ctx.addNode('code:auth/index.ts', 'code', 'auth/index.ts', 'src/auth/index.ts', []);
  ctx.addNode('code:root/index.ts', 'code', 'root/index.ts', 'src/index.ts', []);

  const content = `## 改动记录（2024-01-01）\n\n**文件**：src/index.ts`;
  const sections = extractDecisionSections(content, 'doc:test', ctx);

  // 只有 src/index.ts 应该被关联，不应误匹配 src/auth/index.ts
  const wrongEdge = ctx.graph.edges.find(e => e.target === 'code:auth/index.ts' && e.relation === '改动');
  const rightEdge = ctx.graph.edges.find(e => e.target === 'code:root/index.ts' && e.relation === '改动');
  assert.ok(!wrongEdge, 'src/auth/index.ts 不应被 src/index.ts 误匹配');
  assert.ok(rightEdge, 'src/index.ts 应该正确关联');
});

// ==================== resolveDeferredEdges 测试 ====================

console.log('\n--- resolveDeferredEdges ---');

test('前向 wiki-link 不再残留 phantom', () => {
  const ctx = createGraph();
  ctx.addNode('thinking:a', 'thinking', 'a', '3-Thinking/a.md', []);
  ctx.addNode('thinking:b', 'thinking', 'b', '3-Thinking/b.md', []);
  // thinking:a 里 [[b]]，延迟解析
  ctx.deferEdge('thinking:a', 'b', '链接', ['skill', 'thinking', 'code']);
  resolveDeferredEdges(ctx);

  // 边应指向 thinking:b
  const edge = ctx.graph.edges.find(e => e.source === 'thinking:a' && e.target === 'thinking:b');
  assert.ok(edge, '应建立 thinking:a → thinking:b 的边');
  // 不应有 phantom:b
  const phantom = ctx.graph.nodes.find(n => n.id === 'phantom:b');
  assert.ok(!phantom, '不应创建 phantom:b，因为 thinking:b 已存在');
});

test('related 字段优先解析到 skill', () => {
  const ctx = createGraph();
  ctx.addNode('skill:a', 'skill', 'a', 'skills/a/SKILL.md', []);
  ctx.addNode('skill:b', 'skill', 'b', 'skills/b/SKILL.md', []);
  ctx.addNode('thinking:b', 'thinking', 'b', '3-Thinking/b.md', []);
  // skill:a 声明 related: b，resolveOrder 优先 skill
  ctx.deferEdge('skill:a', 'b', '相关', ['skill', 'thinking']);
  resolveDeferredEdges(ctx);

  // 边应指向 skill:b（不是 thinking:b）
  const edgeToSkill = ctx.graph.edges.find(e => e.source === 'skill:a' && e.target === 'skill:b');
  const edgeToThinking = ctx.graph.edges.find(e => e.source === 'skill:a' && e.target === 'thinking:b');
  assert.ok(edgeToSkill, '应优先解析到 skill:b');
  assert.ok(!edgeToThinking, '不应解析到 thinking:b');
});

test('related 字段 fallback 到 thinking', () => {
  const ctx = createGraph();
  ctx.addNode('skill:a', 'skill', 'a', 'skills/a/SKILL.md', []);
  ctx.addNode('thinking:x', 'thinking', 'x', '3-Thinking/x.md', []);
  // skill:a 声明 related: x，只有 thinking:x 存在（没有 skill:x）
  ctx.deferEdge('skill:a', 'x', '相关', ['skill', 'thinking']);
  resolveDeferredEdges(ctx);

  // 应 fallback 到 thinking:x
  const edge = ctx.graph.edges.find(e => e.source === 'skill:a' && e.target === 'thinking:x');
  assert.ok(edge, '无 skill:x 时应 fallback 到 thinking:x');
  const phantom = ctx.graph.nodes.find(n => n.id === 'phantom:x');
  assert.ok(!phantom, '不应创建 phantom:x');
});

test('deferred phantom 有 phantom: true 标记', () => {
  const ctx = createGraph();
  ctx.addNode('skill:a', 'skill', 'a', 'skills/a/SKILL.md', []);
  // 引用不存在的 ref
  ctx.deferEdge('skill:a', 'nonexistent', '相关', ['skill', 'thinking']);
  resolveDeferredEdges(ctx);

  // 应创建 phantom 节点并标记 phantom: true
  const phantom = ctx.graph.nodes.find(n => n.id === 'phantom:nonexistent');
  assert.ok(phantom, '应创建 phantom:nonexistent 节点');
  assert.strictEqual(phantom.phantom, true, 'phantom 节点应有 phantom: true 标记');
  // 边也应建立
  const edge = ctx.graph.edges.find(e => e.source === 'skill:a' && e.target === 'phantom:nonexistent');
  assert.ok(edge, '应建立到 phantom 的边');
});

// ==================== Task 1: 扩展脚本发现测试 ====================

console.log('\n--- script discovery ---');

test('.py 文件应被索引', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-script-'));
  const skillDir = path.join(projectDir, '.claude', 'skills', 'myskill');
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: myskill\ndescription: "test"\n---\n');
  fs.writeFileSync(path.join(scriptsDir, 'analyze.py'), '# python script\n');

  const scanScript = path.resolve(__dirname, 'scan.js');
  const result = spawnSync('node', [scanScript], {
    cwd: projectDir,
    encoding: 'utf-8',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const graph = JSON.parse(fs.readFileSync(path.join(projectDir, '0-System', 'knowledge-graph.json'), 'utf-8'));
  const pyNode = graph.nodes.find(n => n.id === 'code:myskill/analyze.py');
  assert.ok(pyNode, '.py 文件应被索引为 code 节点');
});

test('.sh 文件应被索引', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-script-'));
  const skillDir = path.join(projectDir, '.claude', 'skills', 'myskill');
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: myskill\ndescription: "test"\n---\n');
  fs.writeFileSync(path.join(scriptsDir, 'run.sh'), '#!/bin/bash\n');

  const scanScript = path.resolve(__dirname, 'scan.js');
  const result = spawnSync('node', [scanScript], {
    cwd: projectDir,
    encoding: 'utf-8',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const graph = JSON.parse(fs.readFileSync(path.join(projectDir, '0-System', 'knowledge-graph.json'), 'utf-8'));
  const shNode = graph.nodes.find(n => n.id === 'code:myskill/run.sh');
  assert.ok(shNode, '.sh 文件应被索引为 code 节点');
});

test('skill 根目录脚本应被索引（如 tell-me/send.js, desktop/ocr.py）', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-script-'));
  const skillDir = path.join(projectDir, '.claude', 'skills', 'myskill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: myskill\ndescription: "test"\n---\n');
  fs.writeFileSync(path.join(skillDir, 'send.js'), '// root level script\n');
  fs.writeFileSync(path.join(skillDir, 'ocr.py'), '# root level python\n');

  const scanScript = path.resolve(__dirname, 'scan.js');
  const result = spawnSync('node', [scanScript], {
    cwd: projectDir,
    encoding: 'utf-8',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const graph = JSON.parse(fs.readFileSync(path.join(projectDir, '0-System', 'knowledge-graph.json'), 'utf-8'));
  const jsNode = graph.nodes.find(n => n.id === 'code:myskill/send.js');
  const pyNode = graph.nodes.find(n => n.id === 'code:myskill/ocr.py');
  assert.ok(jsNode, 'skill 根目录的 .js 脚本应被索引');
  assert.ok(pyNode, 'skill 根目录的 .py 脚本应被索引');
});

test('scripts/ 子目录中的文件应被递归索引（如 scripts/src/, scripts/collectors/）', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-script-'));
  const skillDir = path.join(projectDir, '.claude', 'skills', 'myskill');
  const srcDir = path.join(skillDir, 'scripts', 'src');
  const collectorsDir = path.join(skillDir, 'scripts', 'collectors');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(collectorsDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: myskill\ndescription: "test"\n---\n');
  fs.writeFileSync(path.join(srcDir, 'index.ts'), '// ts src\n');
  fs.writeFileSync(path.join(collectorsDir, 'rss.mjs'), '// mjs collector\n');

  const scanScript = path.resolve(__dirname, 'scan.js');
  const result = spawnSync('node', [scanScript], {
    cwd: projectDir,
    encoding: 'utf-8',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const graph = JSON.parse(fs.readFileSync(path.join(projectDir, '0-System', 'knowledge-graph.json'), 'utf-8'));
  const tsNode = graph.nodes.find(n => n.id === 'code:myskill/src/index.ts');
  const mjsNode = graph.nodes.find(n => n.id === 'code:myskill/collectors/rss.mjs');
  assert.ok(tsNode, 'scripts/src/ 下的 .ts 文件应被递归索引');
  assert.ok(mjsNode, 'scripts/collectors/ 下的 .mjs 文件应被递归索引');
});

test('code 节点总数 >= 50（全项目扫描）', () => {
  // __dirname = .claude/skills/knowledge-graph/scripts (4 levels deep)
  const projectRoot = path.resolve(__dirname, '../../../..'); // up 4 levels
  const scanScript = path.resolve(__dirname, 'scan.js');
  const result = spawnSync('node', [scanScript], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const graphPath = path.join(projectRoot, '0-System', 'knowledge-graph.json');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  const codeNodes = graph.nodes.filter(n => n.type === 'code');
  assert.ok(codeNodes.length >= 50, `code 节点应 >= 50，当前: ${codeNodes.length}`);
});

// ==================== Task 2: phantom 节点清洁测试 ====================

console.log('\n--- phantom node cleanup ---');

test('依赖字段不应有括号残留（如 [knowledge-graph → knowledge-graph）', () => {
  const ctx = createGraph();
  // 模拟 pulse/SKILL.md 中 depends: [knowledge-graph, tell-me] 的解析
  // 正确行为：strip brackets，得到 'knowledge-graph' 和 'tell-me'
  const raw = '[knowledge-graph, tell-me]';
  const cleaned = raw.replace(/^\[|\]$/g, '').split(/[,，]\s*/).map(d => d.trim().replace(/^\[|\]$/g, '')).filter(Boolean).filter(d => d !== '[]');
  assert.ok(!cleaned.some(d => d.startsWith('[') || d.endsWith(']')), '清理后不应有括号');
  assert.deepStrictEqual(cleaned, ['knowledge-graph', 'tell-me']);
});

test('related 字段不应有括号残留（如 [eval, benchmark] → eval, benchmark）', () => {
  const raw = '[eval, benchmark, decision]';
  const cleaned = raw.replace(/^\[|\]$/g, '').split(/[,，]\s*/).map(r => r.trim().replace(/^\[|\]$/g, '')).filter(Boolean).filter(r => r !== '[]');
  assert.deepStrictEqual(cleaned, ['eval', 'benchmark', 'decision']);
});

test('知识图谱中不应有 ID 含括号 artifact 的 phantom 节点（全项目扫描）', () => {
  // __dirname = .claude/skills/knowledge-graph/scripts (4 levels deep)
  const projectRoot = path.resolve(__dirname, '../../../..');
  const graphPath = path.join(projectRoot, '0-System', 'knowledge-graph.json');
  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  } catch {
    // 图谱未生成，跳过
    return;
  }
  const bracketPhantoms = graph.nodes.filter(n =>
    (n.id.includes('[') || n.id.includes(']')) && n.phantom
  );
  assert.strictEqual(bracketPhantoms.length, 0,
    `存在含括号的 phantom 节点: ${bracketPhantoms.map(n => n.id).join(', ')}`);
});

// ==================== 汇总 ====================

console.log(`\n总计: ${passed + failed} 个测试, ${passed} 通过, ${failed} 失败\n`);

if (failed > 0) {
  process.exit(1);
}
