#!/usr/bin/env node

/**
 * eval.js — 触发日志观测分析
 *
 * 用法：
 *   node eval.js
 *   node eval.js --days 7
 *
 * 读取 0-System/trigger-log.jsonl，输出 CLI 友好的统计报告。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// 核心函数（供测试 require 使用）
// ============================================================

/**
 * 解析 JSONL 文本行数组，返回带 ts(Date) 的记录数组。
 * 跳过空行、非 JSON 行、缺少 time 字段的行。
 * @param {string[]} lines
 * @returns {{ ts: Date, reason: string, query: string, prompt_length: number, stage: string, context_chars: number, latency_ms: number }[]}
 */
function parseLines(lines) {
  const records = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj.time) continue;
    const ts = new Date(obj.time);
    if (isNaN(ts.getTime())) continue;
    records.push({
      ts,
      reason: obj.reason || '',
      query: typeof obj.query === 'string' ? obj.query : '',
      prompt_length: obj.prompt_length || 0,
      stage: obj.stage || 'triggered',
      context_chars: obj.context_chars || 0,
      latency_ms: obj.latency_ms || 0,
    });
  }
  return records;
}

/**
 * 按天数过滤记录（保留最近 N 天）。
 * @param {ReturnType<typeof parseLines>} records
 * @param {number|null} days  null 表示不过滤
 * @param {Date} [now]        供测试注入当前时间
 */
function filterByDays(records, days, now) {
  if (!days) return records;
  const cutoff = new Date((now || new Date()).getTime() - days * 24 * 60 * 60 * 1000);
  return records.filter(r => r.ts >= cutoff);
}

/**
 * 计算基础统计指标。
 * 只有 stage === 'triggered'（或无 stage 字段）的记录计入触发总数。
 * @param {ReturnType<typeof parseLines>} records
 */
function computeStats(records) {
  const byReason = {};
  const byHour = {};
  const querySet = new Set();
  let emptyQueryCount = 0;
  let dedupCount = 0;
  let emptyResultCount = 0;
  let latencySum = 0;
  let latencyCount = 0;

  // 触发记录：stage === 'triggered' 或未设置 stage（向后兼容）
  const triggerRecords = records.filter(r => (r.stage || 'triggered') === 'triggered');

  for (const r of triggerRecords) {
    // 按 reason
    byReason[r.reason] = (byReason[r.reason] || 0) + 1;
    // 按小时（UTC）
    const h = r.ts.getUTCHours();
    byHour[h] = (byHour[h] || 0) + 1;
    // 唯一 query
    querySet.add(r.query);
    // 空 query
    if (r.query === '') emptyQueryCount++;
    // latency
    if (r.latency_ms) {
      latencySum += r.latency_ms;
      latencyCount++;
    }
  }

  // 统计 deduped / empty_result
  for (const r of records) {
    const stage = r.stage || 'triggered';
    if (stage === 'deduped') dedupCount++;
    if (stage === 'empty_result') emptyResultCount++;
  }

  const total = triggerRecords.length;
  const dedupRate = total > 0 ? dedupCount / total : 0;
  const avgLatencyMs = latencyCount > 0 ? latencySum / latencyCount : 0;

  return {
    total,
    byReason,
    byHour,
    uniqueQueries: querySet.size,
    emptyQueryCount,
    dedupCount,
    dedupRate,
    emptyResultCount,
    avgLatencyMs,
  };
}

/**
 * 检测同一秒内多次触发（burst = 测试噪音）。
 * burst 定义：同一秒（floor(ts/1000) 相同）内出现 >= 2 条 stage=triggered 的记录。
 * @param {ReturnType<typeof parseLines>} records
 * @returns {{ second: string, count: number, reason: string, query: string }[]}
 */
function detectBurstGroups(records) {
  // 只对 triggered 记录做 burst 检测
  const triggeredRecords = records.filter(r => (r.stage || 'triggered') === 'triggered');

  // 按秒分组
  const buckets = new Map(); // key: "YYYY-MM-DDTHH:MM:SS" -> 记录列表
  for (const r of triggeredRecords) {
    const sec = r.ts.toISOString().slice(0, 19); // 截到秒
    if (!buckets.has(sec)) buckets.set(sec, []);
    buckets.get(sec).push(r);
  }

  const bursts = [];
  for (const [sec, group] of buckets) {
    if (group.length >= 2) {
      bursts.push({
        second: sec,
        count: group.length,
        reason: group[0].reason,
        query: group[0].query,
      });
    }
  }
  // 按秒升序
  bursts.sort((a, b) => a.second.localeCompare(b.second));
  return bursts;
}

/**
 * 高频 query top N。
 * @param {ReturnType<typeof parseLines>} records
 * @param {number} n
 * @returns {{ query: string, count: number }[]}
 */
function topN(records, n) {
  const freq = new Map();
  for (const r of records) {
    freq.set(r.query, (freq.get(r.query) || 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([query, count]) => ({ query, count }));
}

// ============================================================
// 格式化输出
// ============================================================

/** 对齐宽度（支持中文宽字符近似估算：中文字符算 2 宽） */
function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    w += ch.charCodeAt(0) > 127 ? 2 : 1;
  }
  return w;
}

function padEnd(str, width) {
  const pad = width - displayWidth(str);
  return String(str) + ' '.repeat(Math.max(0, pad));
}

/**
 * 格式化键值对为文本表格。
 * @param {string} title
 * @param {Record<string, number>} data
 * @param {string} [keyHeader='']
 * @param {string} [valHeader='次数']
 */
function formatTable(title, data, keyHeader = '', valHeader = '次数') {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return `${title}\n  （无数据）\n`;
  }

  // 计算列宽
  const keyWidth = Math.max(
    displayWidth(keyHeader),
    ...entries.map(([k]) => displayWidth(k))
  ) + 2;
  const valWidth = Math.max(
    displayWidth(valHeader),
    ...entries.map(([, v]) => displayWidth(String(v)))
  ) + 2;

  const sep = '─'.repeat(keyWidth + valWidth + 3);
  const header = `  ${padEnd(keyHeader, keyWidth)}│ ${valHeader}`;
  const divider = `  ${sep}`;

  const rows = entries.map(([k, v]) => `  ${padEnd(k, keyWidth)}│ ${v}`);

  return [title, divider, header, divider, ...rows, divider, ''].join('\n');
}

/**
 * 生成完整报告字符串。
 * @param {ReturnType<typeof parseLines>} records
 * @param {number|null} days
 */
function formatReport(records, days) {
  const lines = [];
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════╗');
  lines.push('║     Knowledge Graph 触发日志观测报告             ║');
  lines.push('╚══════════════════════════════════════════════════╝');
  lines.push(`  生成时间：${now}`);
  if (days) lines.push(`  过滤范围：最近 ${days} 天`);
  lines.push('');

  if (records.length === 0) {
    lines.push('  （无数据，日志为空或时间范围内没有记录）');
    lines.push('');
    return lines.join('\n');
  }

  const stats = computeStats(records);
  const bursts = detectBurstGroups(records);
  const top5 = topN(records, 5);

  // ── 基础统计 ──
  lines.push('【基础统计】');
  lines.push(`  总触发次数：${stats.total}`);
  lines.push(`  唯一 query 数：${stats.uniqueQueries}`);
  lines.push('');

  // ── 原因分布 ──
  const ALL_REASONS = ['skill-mention', 'remember', 'continue', 'inspect-link'];
  const reasonData = {};
  for (const r of ALL_REASONS) {
    reasonData[r] = stats.byReason[r] || 0;
  }
  // 加上未知 reason
  for (const [k, v] of Object.entries(stats.byReason)) {
    if (!ALL_REASONS.includes(k)) reasonData[k] = v;
  }
  lines.push('【原因分布】');
  lines.push(formatTable('', reasonData, 'reason'));

  // ── 小时分布 ──
  lines.push('【小时分布（UTC）】');
  const hourData = {};
  for (let h = 0; h < 24; h++) {
    if (stats.byHour[h]) hourData[`${String(h).padStart(2, '0')}:00`] = stats.byHour[h];
  }
  if (Object.keys(hourData).length === 0) {
    lines.push('  （无数据）\n');
  } else {
    lines.push(formatTable('', hourData, '时段'));
  }

  // ── 高频 query top 5 ──
  lines.push('【高频 Query Top 5】');
  if (top5.length === 0) {
    lines.push('  （无数据）\n');
  } else {
    const top5Data = {};
    for (const { query, count } of top5) {
      top5Data[query === '' ? '（空）' : query] = count;
    }
    lines.push(formatTable('', top5Data, 'query'));
  }

  // ── 质量指标 ──
  lines.push('【质量指标】');
  lines.push(`  空 query 触发次数：${stats.emptyQueryCount}${stats.emptyQueryCount > 0 ? '  ⚠ 可能是误触发' : ''}`);

  if (bursts.length === 0) {
    lines.push('  重复触发检测：无 burst（同秒多触发）');
  } else {
    lines.push(`  重复触发检测：发现 ${bursts.length} 组 burst（同秒内多触发，疑似测试噪音）`);
    const burstData = {};
    for (const b of bursts.slice(0, 10)) { // 最多展示 10 组
      const key = `${b.second}  reason=${b.reason}`;
      burstData[key] = b.count;
    }
    lines.push(formatTable('', burstData, 'burst 时间点', '触发数'));
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================
// CLI 入口
// ============================================================

function main() {
  // 解析参数
  let days = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) days = n;
      i++;
    }
  }

  // 确定日志文件路径（相对于项目根）
  const logPath = path.join(__dirname, '../../../../0-System/trigger-log.jsonl');

  let content = '';
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    console.error(`无法读取日志文件：${logPath}`);
    console.error(err.message);
    process.exit(1);
  }

  const lines = content.split('\n');
  const allRecords = parseLines(lines);
  const records = filterByDays(allRecords, days);

  process.stdout.write(formatReport(records, days));
}

// ============================================================
// 导出（供测试 require）
// ============================================================

module.exports = {
  parseLines,
  filterByDays,
  computeStats,
  detectBurstGroups,
  topN,
  formatTable,
  formatReport,
};

// 直接执行时运行 CLI
if (require.main === module) {
  main();
}
