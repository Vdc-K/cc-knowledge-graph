#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { queryGraph, queryContext, inferDisplayProfile } = require('./query.js');

const DEFAULT_BENCHMARKS = [
  {
    name: 'MACS project overview',
    query: 'MACS',
    expectedProfile: 'project',
    requiredSections: ['*项目概览*', '*项目文档（补充）*'],
    requiredNodeIds: ['project:MACS', 'doc:MACS/decision_making'],
  },
  {
    name: 'dev capability layout',
    query: 'dev',
    expectedProfile: 'capability',
    requiredSections: ['*核心能力*', '*实现 / 依赖*', '*思考 / 文档*'],
    requiredNodeIds: ['skill:dev'],
  },
  {
    name: 'dashboard capability layout',
    query: 'dashboard',
    expectedProfile: 'capability',
    requiredSections: ['*核心能力*', '*实现 / 依赖*'],
    requiredNodeIds: ['skill:dashboard', 'skill:knowledge-graph'],
  },
];

function runBenchmarks({ graph, benchmarks = DEFAULT_BENCHMARKS, projectDir, sessionFile = null }) {
  return benchmarks.map(benchmark => {
    const subgraph = queryGraph(graph, benchmark.query);
    const context = queryContext({
      graph,
      query: benchmark.query,
      projectDir,
      sessionFile,
    });
    const profile = inferDisplayProfile(subgraph.nodes);

    const missingSections = (benchmark.requiredSections || []).filter(
      section => !context.includes(section)
    );
    const nodeIds = new Set(subgraph.nodes.map(node => node.id));
    const missingNodeIds = (benchmark.requiredNodeIds || []).filter(
      nodeId => !nodeIds.has(nodeId)
    );

    const profileMatches = !benchmark.expectedProfile || profile === benchmark.expectedProfile;
    const passed = profileMatches && missingSections.length === 0 && missingNodeIds.length === 0;

    return {
      ...benchmark,
      passed,
      profile,
      nodeCount: subgraph.nodes.length,
      edgeCount: subgraph.edges.length,
      missingSections,
      missingNodeIds,
    };
  });
}

function formatBenchmarkReport(results) {
  const passedCount = results.filter(result => result.passed).length;
  const lines = [
    'Knowledge Graph Query Benchmarks',
    `Pass: ${passedCount}/${results.length}`,
    '',
  ];

  for (const result of results) {
    lines.push(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name}`);
    lines.push(`  query: ${result.query}`);
    lines.push(`  profile: ${result.profile}${result.expectedProfile ? ` (expected ${result.expectedProfile})` : ''}`);
    lines.push(`  subgraph: ${result.nodeCount} nodes, ${result.edgeCount} edges`);
    if (result.missingSections.length > 0) {
      lines.push(`  missing sections: ${result.missingSections.join(', ')}`);
    }
    if (result.missingNodeIds.length > 0) {
      lines.push(`  missing nodes: ${result.missingNodeIds.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function loadGraph(projectDir, outputFile = '0-System/knowledge-graph.json') {
  const graphPath = path.join(projectDir, outputFile);
  return JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
}

function main() {
  const projectDir = process.cwd();
  const graph = loadGraph(projectDir);
  const results = runBenchmarks({ graph, projectDir });
  console.log(formatBenchmarkReport(results));
  if (results.some(result => !result.passed)) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_BENCHMARKS,
  runBenchmarks,
  formatBenchmarkReport,
  loadGraph,
};
