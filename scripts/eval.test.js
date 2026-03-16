#!/usr/bin/env node

/**
 * eval.js 测试 — 触发日志观测分析
 * 使用 Node.js 内置 assert，无第三方依赖
 */

'use strict';

const assert = require('assert');
const {
  parseLines,
  filterByDays,
  computeStats,
  detectBurstGroups,
  topN,
  formatTable,
  formatReport,
} = require('./eval.js');

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

// ==================== parseLines ====================

console.log('\n--- parseLines ---');

test('正常行解析', () => {
  const lines = [
    '{"time":"2026-03-15T07:27:30.053Z","reason":"skill-mention","query":"dashboard","prompt_length":12}',
    '{"time":"2026-03-15T08:00:00.000Z","reason":"remember","query":"some idea","prompt_length":5}',
  ];
  const records = parseLines(lines);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].reason, 'skill-mention');
  assert.strictEqual(records[0].query, 'dashboard');
  assert.ok(records[0].ts instanceof Date);
  assert.strictEqual(records[1].reason, 'remember');
});

test('空行和非 JSON 行被跳过', () => {
  const lines = [
    '',
    'not-json',
    '{"time":"2026-03-15T07:27:30.053Z","reason":"skill-mention","query":"x","prompt_length":1}',
    '   ',
  ];
  const records = parseLines(lines);
  assert.strictEqual(records.length, 1);
});

test('缺少 time 字段的行被跳过', () => {
  const lines = [
    '{"reason":"skill-mention","query":"x","prompt_length":1}',
    '{"time":"2026-03-15T07:27:30.053Z","reason":"remember","query":"y","prompt_length":2}',
  ];
  const records = parseLines(lines);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].query, 'y');
});

test('空数组返回空结果', () => {
  const records = parseLines([]);
  assert.strictEqual(records.length, 0);
});

test('time 字段解析为 Date', () => {
  const lines = ['{"time":"2026-03-15T07:27:30.053Z","reason":"continue","query":"abc","prompt_length":3}'];
  const records = parseLines(lines);
  assert.ok(records[0].ts instanceof Date);
  assert.strictEqual(records[0].ts.getUTCHours(), 7);
});

// ==================== filterByDays ====================

console.log('\n--- filterByDays ---');

function makeRecord(isoTime, reason = 'skill-mention', query = 'test') {
  return { ts: new Date(isoTime), reason, query, prompt_length: 10 };
}

test('不传 days 返回全部', () => {
  const records = [
    makeRecord('2026-01-01T00:00:00Z'),
    makeRecord('2026-03-15T00:00:00Z'),
  ];
  const result = filterByDays(records, null);
  assert.strictEqual(result.length, 2);
});

test('days=1 只保留最近 1 天', () => {
  const now = new Date('2026-03-15T12:00:00Z');
  const records = [
    makeRecord('2026-03-14T11:59:00Z'), // 超过 1 天前
    makeRecord('2026-03-14T13:00:00Z'), // 在 1 天内
    makeRecord('2026-03-15T12:00:00Z'), // 当前
  ];
  const result = filterByDays(records, 1, now);
  assert.strictEqual(result.length, 2);
});

test('days=7 过滤 7 天以外的记录', () => {
  const now = new Date('2026-03-15T00:00:00Z');
  // cutoff = 2026-03-08T00:00:00Z
  const records = [
    makeRecord('2026-03-08T00:00:01Z'), // 恰好在 7 天内（cutoff + 1s）
    makeRecord('2026-03-07T23:59:59Z'), // 超过 7 天（cutoff - 1s）
    makeRecord('2026-03-15T00:00:00Z'), // 当天
  ];
  const result = filterByDays(records, 7, now);
  assert.strictEqual(result.length, 2);
});

test('空记录返回空', () => {
  const result = filterByDays([], 7);
  assert.strictEqual(result.length, 0);
});

// ==================== computeStats ====================

console.log('\n--- computeStats ---');

const sampleRecords = [
  makeRecord('2026-03-15T07:00:00Z', 'skill-mention', 'dashboard'),
  makeRecord('2026-03-15T07:01:00Z', 'skill-mention', 'dashboard'),
  makeRecord('2026-03-15T07:02:00Z', 'remember', 'some idea'),
  makeRecord('2026-03-15T08:00:00Z', 'continue', ''),
  makeRecord('2026-03-15T08:01:00Z', 'inspect-link', '看看链接'),
  makeRecord('2026-03-15T08:01:00Z', 'inspect-link', '看看链接'),
];

test('总触发次数正确', () => {
  const stats = computeStats(sampleRecords);
  assert.strictEqual(stats.total, 6);
});

test('按 reason 分组计数', () => {
  const stats = computeStats(sampleRecords);
  assert.strictEqual(stats.byReason['skill-mention'], 2);
  assert.strictEqual(stats.byReason['remember'], 1);
  assert.strictEqual(stats.byReason['continue'], 1);
  assert.strictEqual(stats.byReason['inspect-link'], 2);
});

test('按小时分布', () => {
  const stats = computeStats(sampleRecords);
  assert.strictEqual(stats.byHour[7], 3);
  assert.strictEqual(stats.byHour[8], 3);
});

test('唯一 query 计数（去重）', () => {
  const stats = computeStats(sampleRecords);
  // 'dashboard', 'some idea', '', '看看链接' -> 4 个不同值
  assert.strictEqual(stats.uniqueQueries, 4);
});

test('空 query 触发次数', () => {
  const stats = computeStats(sampleRecords);
  assert.strictEqual(stats.emptyQueryCount, 1);
});

test('空记录返回零值统计', () => {
  const stats = computeStats([]);
  assert.strictEqual(stats.total, 0);
  assert.strictEqual(stats.uniqueQueries, 0);
  assert.strictEqual(stats.emptyQueryCount, 0);
  assert.deepStrictEqual(stats.byReason, {});
  assert.deepStrictEqual(stats.byHour, {});
});

// ==================== detectBurstGroups ====================

console.log('\n--- detectBurstGroups ---');

test('同一秒多次触发被标记为 burst', () => {
  const records = [
    makeRecord('2026-03-15T07:33:29.050Z', 'inspect-link', '看看'),
    makeRecord('2026-03-15T07:33:29.100Z', 'inspect-link', '看看'),
    makeRecord('2026-03-15T07:33:29.200Z', 'inspect-link', '看看'),
  ];
  const bursts = detectBurstGroups(records);
  assert.strictEqual(bursts.length, 1);
  assert.strictEqual(bursts[0].count, 3);
  assert.strictEqual(bursts[0].reason, 'inspect-link');
});

test('不同秒的触发不被识别为 burst', () => {
  const records = [
    makeRecord('2026-03-15T07:00:01Z', 'skill-mention', 'a'),
    makeRecord('2026-03-15T07:00:02Z', 'skill-mention', 'a'),
    makeRecord('2026-03-15T07:00:03Z', 'skill-mention', 'a'),
  ];
  const bursts = detectBurstGroups(records);
  assert.strictEqual(bursts.length, 0);
});

test('burst 阈值：同一秒内 >= 2 才算', () => {
  const records = [
    makeRecord('2026-03-15T07:00:01.100Z', 'remember', 'x'),
  ];
  const bursts = detectBurstGroups(records);
  assert.strictEqual(bursts.length, 0);
});

test('多组不同的 burst 都被检出', () => {
  const records = [
    // 第一组：07:00:01
    makeRecord('2026-03-15T07:00:01.100Z', 'inspect-link', 'link'),
    makeRecord('2026-03-15T07:00:01.200Z', 'inspect-link', 'link'),
    // 间隔
    makeRecord('2026-03-15T07:01:00.000Z', 'skill-mention', 'dev'),
    // 第二组：07:02:05
    makeRecord('2026-03-15T07:02:05.010Z', 'remember', 'idea'),
    makeRecord('2026-03-15T07:02:05.020Z', 'remember', 'idea'),
    makeRecord('2026-03-15T07:02:05.030Z', 'remember', 'idea'),
  ];
  const bursts = detectBurstGroups(records);
  assert.strictEqual(bursts.length, 2);
});

test('空记录返回空 burst 列表', () => {
  const bursts = detectBurstGroups([]);
  assert.strictEqual(bursts.length, 0);
});

// ==================== topN ====================

console.log('\n--- topN ---');

test('返回频率最高的 N 项', () => {
  const records = [
    makeRecord('2026-03-15T07:00:00Z', 'skill-mention', 'a'),
    makeRecord('2026-03-15T07:00:01Z', 'skill-mention', 'a'),
    makeRecord('2026-03-15T07:00:02Z', 'skill-mention', 'a'),
    makeRecord('2026-03-15T07:00:03Z', 'remember', 'b'),
    makeRecord('2026-03-15T07:00:04Z', 'remember', 'b'),
    makeRecord('2026-03-15T07:00:05Z', 'continue', 'c'),
  ];
  const top = topN(records, 2);
  assert.strictEqual(top.length, 2);
  assert.strictEqual(top[0].query, 'a');
  assert.strictEqual(top[0].count, 3);
  assert.strictEqual(top[1].query, 'b');
  assert.strictEqual(top[1].count, 2);
});

test('N 大于唯一 query 数时，返回全部', () => {
  const records = [
    makeRecord('2026-03-15T07:00:00Z', 'skill-mention', 'x'),
    makeRecord('2026-03-15T07:00:01Z', 'remember', 'y'),
  ];
  const top = topN(records, 10);
  assert.strictEqual(top.length, 2);
});

test('空 query 也纳入统计', () => {
  const records = [
    makeRecord('2026-03-15T07:00:00Z', 'continue', ''),
    makeRecord('2026-03-15T07:00:01Z', 'continue', ''),
  ];
  const top = topN(records, 5);
  const emptyEntry = top.find(t => t.query === '');
  assert.ok(emptyEntry, '空 query 应出现在 top 列表');
  assert.strictEqual(emptyEntry.count, 2);
});

test('空记录返回空 top 列表', () => {
  const top = topN([], 5);
  assert.strictEqual(top.length, 0);
});

// ==================== formatTable ====================

console.log('\n--- formatTable ---');

test('基础表格格式：包含标题和分隔符', () => {
  const output = formatTable('原因分布', { 'skill-mention': 3, 'remember': 1 });
  assert.ok(output.includes('原因分布'), '应包含表格标题');
  assert.ok(output.includes('skill-mention'), '应包含 key');
  assert.ok(output.includes('3'), '应包含数值');
});

test('空对象输出空表格（不抛出）', () => {
  assert.doesNotThrow(() => formatTable('空表', {}));
});

// ==================== formatReport ====================

console.log('\n--- formatReport ---');

test('完整报告包含所有必要章节', () => {
  const records = [
    makeRecord('2026-03-15T07:00:00Z', 'skill-mention', 'dev'),
    makeRecord('2026-03-15T07:00:00Z', 'skill-mention', 'dev'),
    makeRecord('2026-03-15T07:00:01Z', 'remember', ''),
  ];
  const report = formatReport(records, null);
  assert.ok(report.includes('总触发'), '应包含总触发数');
  assert.ok(report.includes('原因分布'), '应包含原因分布');
  assert.ok(report.includes('小时分布'), '应包含小时分布');
  assert.ok(report.includes('高频'), '应包含高频 query');
  assert.ok(report.includes('质量'), '应包含质量指标章节');
});

test('有 days 参数时报告头部包含 days 信息', () => {
  const records = [makeRecord('2026-03-15T07:00:00Z', 'skill-mention', 'x')];
  const report = formatReport(records, 7);
  assert.ok(report.includes('7'), '报告应提及过滤的天数');
});

test('0 条记录时报告提示无数据（不抛出）', () => {
  assert.doesNotThrow(() => {
    const report = formatReport([], null);
    assert.ok(typeof report === 'string');
  });
});

// ==================== multi-stage: parseLines ====================

console.log('\n--- parseLines (multi-stage) ---');

test('解析带 stage 字段的记录', () => {
  const lines = [
    '{"time":"2026-03-15T07:27:30.053Z","stage":"triggered","reason":"skill-mention","query":"dashboard","prompt_length":12,"context_chars":500,"latency_ms":42}',
    '{"time":"2026-03-15T07:27:30.100Z","stage":"retrieved","reason":"skill-mention","query":"dashboard","prompt_length":12,"context_chars":500,"latency_ms":15}',
    '{"time":"2026-03-15T07:27:30.150Z","stage":"injected","reason":"skill-mention","query":"dashboard","prompt_length":12,"context_chars":500,"latency_ms":8}',
  ];
  const records = parseLines(lines);
  assert.strictEqual(records.length, 3);
  assert.strictEqual(records[0].stage, 'triggered');
  assert.strictEqual(records[1].stage, 'retrieved');
  assert.strictEqual(records[2].stage, 'injected');
  assert.strictEqual(records[0].context_chars, 500);
  assert.strictEqual(records[0].latency_ms, 42);
});

test('旧日志（无 stage 字段）默认为 triggered', () => {
  const lines = [
    '{"time":"2026-03-15T07:27:30.053Z","reason":"skill-mention","query":"dashboard","prompt_length":12}',
  ];
  const records = parseLines(lines);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].stage, 'triggered');
});

test('解析 deduped 和 empty_result stage', () => {
  const lines = [
    '{"time":"2026-03-15T07:00:00Z","stage":"deduped","reason":"remember","query":"x","prompt_length":5}',
    '{"time":"2026-03-15T07:00:01Z","stage":"empty_result","reason":"continue","query":"y","prompt_length":3}',
  ];
  const records = parseLines(lines);
  assert.strictEqual(records[0].stage, 'deduped');
  assert.strictEqual(records[1].stage, 'empty_result');
});

test('context_chars 和 latency_ms 缺失时默认为 0', () => {
  const lines = [
    '{"time":"2026-03-15T07:00:00Z","reason":"skill-mention","query":"x","prompt_length":1}',
  ];
  const records = parseLines(lines);
  assert.strictEqual(records[0].context_chars, 0);
  assert.strictEqual(records[0].latency_ms, 0);
});

// ==================== multi-stage: computeStats ====================

console.log('\n--- computeStats (multi-stage) ---');

function makeStageRecord(isoTime, stage, reason = 'skill-mention', query = 'test', latency_ms = 0) {
  return { ts: new Date(isoTime), stage, reason, query, prompt_length: 10, context_chars: 100, latency_ms };
}

test('只有 stage=triggered 的记录计入 total', () => {
  const records = [
    makeStageRecord('2026-03-15T07:00:00Z', 'triggered', 'skill-mention', 'a'),
    makeStageRecord('2026-03-15T07:00:01Z', 'triggered', 'remember', 'b'),
    makeStageRecord('2026-03-15T07:00:02Z', 'retrieved', 'skill-mention', 'a'),
    makeStageRecord('2026-03-15T07:00:03Z', 'injected', 'skill-mention', 'a'),
    makeStageRecord('2026-03-15T07:00:04Z', 'deduped', 'remember', 'b'),
  ];
  const stats = computeStats(records);
  assert.strictEqual(stats.total, 2);
});

test('旧日志（无 stage / 默认 triggered）被正常计入 total', () => {
  const records = [
    makeRecord('2026-03-15T07:00:00Z', 'skill-mention', 'x'),
    makeRecord('2026-03-15T07:00:01Z', 'remember', 'y'),
  ];
  // makeRecord 不设 stage，parseLines 会补 'triggered'；
  // 但这里直接构造 record 时也不设 stage，模拟旧日志默认行为
  const stats = computeStats(records);
  assert.strictEqual(stats.total, 2);
});

test('dedupCount 统计 stage=deduped 的数量', () => {
  const records = [
    makeStageRecord('2026-03-15T07:00:00Z', 'triggered'),
    makeStageRecord('2026-03-15T07:00:01Z', 'deduped'),
    makeStageRecord('2026-03-15T07:00:02Z', 'deduped'),
  ];
  const stats = computeStats(records);
  assert.strictEqual(stats.dedupCount, 2);
});

test('emptyResultCount 统计 stage=empty_result 的数量', () => {
  const records = [
    makeStageRecord('2026-03-15T07:00:00Z', 'triggered'),
    makeStageRecord('2026-03-15T07:00:01Z', 'empty_result'),
    makeStageRecord('2026-03-15T07:00:02Z', 'empty_result'),
    makeStageRecord('2026-03-15T07:00:03Z', 'empty_result'),
  ];
  const stats = computeStats(records);
  assert.strictEqual(stats.emptyResultCount, 3);
});

test('dedupRate = dedupCount / total（total > 0）', () => {
  const records = [
    makeStageRecord('2026-03-15T07:00:00Z', 'triggered'),
    makeStageRecord('2026-03-15T07:00:01Z', 'triggered'),
    makeStageRecord('2026-03-15T07:00:02Z', 'deduped'),
    makeStageRecord('2026-03-15T07:00:03Z', 'deduped'),
  ];
  const stats = computeStats(records);
  assert.strictEqual(stats.dedupRate, 1.0); // 2 deduped / 2 triggered
});

test('total=0 时 dedupRate 为 0', () => {
  const records = [
    makeStageRecord('2026-03-15T07:00:00Z', 'deduped'),
  ];
  const stats = computeStats(records);
  assert.strictEqual(stats.total, 0);
  assert.strictEqual(stats.dedupRate, 0);
});

test('avgLatencyMs 仅对 stage=triggered 的记录求均值', () => {
  const records = [
    makeStageRecord('2026-03-15T07:00:00Z', 'triggered', 'skill-mention', 'a', 100),
    makeStageRecord('2026-03-15T07:00:01Z', 'triggered', 'remember', 'b', 200),
    makeStageRecord('2026-03-15T07:00:02Z', 'retrieved', 'skill-mention', 'a', 999), // 不应计入
  ];
  const stats = computeStats(records);
  assert.strictEqual(stats.avgLatencyMs, 150);
});

test('没有 triggered 记录时 avgLatencyMs 为 0', () => {
  const records = [
    makeStageRecord('2026-03-15T07:00:00Z', 'retrieved', 'skill-mention', 'a', 50),
  ];
  const stats = computeStats(records);
  assert.strictEqual(stats.avgLatencyMs, 0);
});

test('空记录时新增字段均为 0', () => {
  const stats = computeStats([]);
  assert.strictEqual(stats.dedupCount, 0);
  assert.strictEqual(stats.dedupRate, 0);
  assert.strictEqual(stats.emptyResultCount, 0);
  assert.strictEqual(stats.avgLatencyMs, 0);
});

// ==================== multi-stage: detectBurstGroups ====================

console.log('\n--- detectBurstGroups (multi-stage) ---');

test('burst 检测只对 stage=triggered 的记录生效', () => {
  const records = [
    makeStageRecord('2026-03-15T07:00:01.100Z', 'triggered', 'inspect-link', 'link'),
    makeStageRecord('2026-03-15T07:00:01.200Z', 'triggered', 'inspect-link', 'link'),
    // 同一秒内的 retrieved 不计入 burst
    makeStageRecord('2026-03-15T07:00:01.300Z', 'retrieved', 'inspect-link', 'link'),
    makeStageRecord('2026-03-15T07:00:01.400Z', 'retrieved', 'inspect-link', 'link'),
    makeStageRecord('2026-03-15T07:00:01.500Z', 'retrieved', 'inspect-link', 'link'),
  ];
  const bursts = detectBurstGroups(records);
  assert.strictEqual(bursts.length, 1);
  assert.strictEqual(bursts[0].count, 2); // 只数 triggered
});

test('同一秒只有 non-triggered 时不产生 burst', () => {
  const records = [
    makeStageRecord('2026-03-15T07:00:01.100Z', 'retrieved', 'skill-mention', 'x'),
    makeStageRecord('2026-03-15T07:00:01.200Z', 'injected', 'skill-mention', 'x'),
    makeStageRecord('2026-03-15T07:00:01.300Z', 'deduped', 'skill-mention', 'x'),
  ];
  const bursts = detectBurstGroups(records);
  assert.strictEqual(bursts.length, 0);
});

// ==================== 汇总 ====================

console.log(`\n总计: ${passed + failed} 个测试, ${passed} 通过, ${failed} 失败\n`);

if (failed > 0) {
  process.exit(1);
}
