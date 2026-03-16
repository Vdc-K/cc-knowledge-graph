#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { runBenchmarks, formatBenchmarkReport } = require('./benchmark.js');

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

console.log('\n--- runBenchmarks ---');

function makeGraph() {
  return {
    nodes: [
      { id: 'project:MACS', type: 'project', label: 'MACS', tags: [] },
      { id: 'doc:MACS/decision_making', type: 'decision', label: 'MACS decision', file: '2-Projects/MACS/decision-making.md', tags: [] },
      { id: 'doc:MACS/macs-skill/README', type: 'doc', label: 'README', doc_kind: 'readme', path_depth: 1, file: '2-Projects/MACS/macs-skill/README.md', tags: [] },
      { id: 'doc:MACS/macs-skill/adapters/codex/README', type: 'doc', label: 'Codex README', doc_kind: 'readme', path_depth: 3, file: '2-Projects/MACS/macs-skill/adapters/codex/README.md', tags: [] },
      { id: 'skill:dev', type: 'skill', label: 'dev', tags: [] },
      { id: 'skill:dev-team', type: 'skill', label: 'dev-team', tags: [] },
      { id: 'code:dev/run.js', type: 'code', label: 'run.js', file: '.claude/skills/dev/scripts/run.js', tags: [] },
      { id: 'thinking:dev-flow', type: 'thinking', label: 'dev flow', file: '3-Thinking/dev-flow.md', tags: [] },
      { id: 'skill:dashboard', type: 'skill', label: 'dashboard', tags: [] },
      { id: 'skill:knowledge-graph', type: 'skill', label: 'knowledge-graph', tags: [] },
    ],
    edges: [
      { source: 'project:MACS', target: 'doc:MACS/decision_making', relation: '包含' },
      { source: 'project:MACS', target: 'doc:MACS/macs-skill/README', relation: '包含' },
      { source: 'project:MACS', target: 'doc:MACS/macs-skill/adapters/codex/README', relation: '包含' },
      { source: 'skill:dev', target: 'skill:dev-team', relation: '依赖' },
      { source: 'skill:dev', target: 'code:dev/run.js', relation: '实现' },
      { source: 'thinking:dev-flow', target: 'skill:dev', relation: '思考' },
      { source: 'skill:dashboard', target: 'skill:knowledge-graph', relation: '依赖' },
    ],
  };
}

test('基准集在预期图上应全部通过', () => {
  const results = runBenchmarks({
    graph: makeGraph(),
    projectDir: process.cwd(),
  });

  assert.strictEqual(results.length, 3);
  assert.ok(results.every(result => result.passed), '默认 benchmark 应全部通过');
  assert.strictEqual(results[0].profile, 'project');
  assert.strictEqual(results[1].profile, 'capability');
});

test('缺失关键节点时应明确失败原因', () => {
  const graph = makeGraph();
  graph.nodes = graph.nodes.filter(node => node.id !== 'skill:knowledge-graph');
  graph.edges = graph.edges.filter(edge => edge.target !== 'skill:knowledge-graph');

  const results = runBenchmarks({
    graph,
    projectDir: process.cwd(),
  });

  const dashboard = results.find(result => result.query === 'dashboard');
  assert.ok(dashboard);
  assert.strictEqual(dashboard.passed, false);
  assert.ok(dashboard.missingNodeIds.includes('skill:knowledge-graph'));
});

console.log('\n--- formatBenchmarkReport ---');

test('报告应包含通过率和失败详情', () => {
  const report = formatBenchmarkReport([
    {
      name: 'ok',
      query: 'dev',
      expectedProfile: 'capability',
      profile: 'capability',
      passed: true,
      nodeCount: 3,
      edgeCount: 2,
      missingSections: [],
      missingNodeIds: [],
    },
    {
      name: 'bad',
      query: 'dashboard',
      expectedProfile: 'capability',
      profile: 'reference',
      passed: false,
      nodeCount: 2,
      edgeCount: 1,
      missingSections: ['*核心能力*'],
      missingNodeIds: ['skill:dashboard'],
    },
  ]);

  assert.ok(report.includes('Pass: 1/2'));
  assert.ok(report.includes('FAIL  bad'));
  assert.ok(report.includes('missing sections: *核心能力*'));
  assert.ok(report.includes('missing nodes: skill:dashboard'));
});

console.log(`\n总计: ${passed + failed} 个测试, ${passed} 通过, ${failed} 失败\n`);

if (failed > 0) {
  process.exit(1);
}
