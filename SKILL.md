---
name: knowledge-graph
description: 知识图谱 — cc 的底层导航系统。扫描项目文件自动构建节点+边的关系网，支持子图查询和上下文聚合。是 /context-loader 的数据源（KG 构建图谱，CL 消费图谱加载上下文）。一般通过 /context-loader 间接使用，直接触发用于手动更新或调试图谱。触发词："/knowledge-graph"、"更新图谱"、"查图谱"
version: '0.1.0'
layer: atomic
authorization: A区（自动执行）
output_levels: L1（结论）
status: stable
created: 2026-03-13
related: 知识图谱-cc导航系统
---

# Knowledge Graph — cc 的导航系统

解决"信息散落在多个文件，cc 缺少关联感知"的问题。

## 实现方式

**可执行脚本**：`scripts/scan.js` + `scripts/query.js`

- `scan.js`：扫描生成图谱 / 查询子图 / 上下文聚合入口
- `query.js`：查询逻辑模块，export `queryGraph`、`queryContext`、`findMemoryDir`、`loadMemory`、`loadSession`

## 边界
**做**：扫描 Skills/Projects/Thinking 目录 → 构建节点+边的知识图谱 → 支持关键词子图查询 → 支持三层上下文聚合
**不做**：不做语义分析（用关键词匹配）；不替代 grep（它是结构化关联，不是全文搜索）

## 使用方式

### 生成图谱

```bash
node .claude/skills/knowledge-graph/scripts/scan.js
```

输出：`0-System/knowledge-graph.json`

### 查询子图

```bash
node .claude/skills/knowledge-graph/scripts/scan.js --query <关键词>
```

返回该关键词相关的 1-2 跳子图（JSON + 人可读摘要）。

### 上下文聚合模式（--context）

```bash
node .claude/skills/knowledge-graph/scripts/scan.js --query <关键词> --context
```

三层聚合，输出结构化 Markdown：

| 层 | 来源 | 实现函数 |
|----|------|---------|
| Layer 1 | 知识图谱子图查询 | `queryGraph()` |
| Layer 2 | Memory 目录匹配（自动发现 `~/.claude/projects/.../memory/*.md`） | `findMemoryDir()` + `loadMemory()` |
| Layer 3 | Session Memory（上次会话状态） | `loadSession()` |

context 模式下图谱可选——即使图谱不存在也能聚合 memory 和 session 数据。

### 跑查询 benchmark

```bash
node .claude/skills/knowledge-graph/scripts/scan.js --benchmark
```

固定回归 `MACS`、`dev`、`dashboard` 三类 query，检查：

- 展示画像是否正确（`project` / `capability`）
- 关键分组是否仍存在
- 关键节点是否仍在子图中

如果是日常回归，优先走仓库统一入口：

```bash
bash scripts/check.sh knowledge-graph
```

## 配置

项目根目录放 `kg.config.js` 可自定义：

```js
module.exports = {
  outputFile: '0-System/knowledge-graph.json',
  scanPaths: {
    skills: '.claude/skills',
    projects: '2-Projects',
    thinking: '3-Thinking',
    inbox_thinking: '1-Inbox/thinking',
    system: '0-System',
  },
  context: {
    sessionMemory: '0-System/last-session.md',  // session memory 文件路径，null 则跳过
  },
};
```

## 节点类型

| 类型 | 来源 | 示例 |
|------|------|------|
| skill | `.claude/skills/*/SKILL.md` | session-memory |
| code | `scripts/*.js` | save.js |
| thinking | `3-Thinking/*.md` | 知识图谱设计 |
| project | `2-Projects/` | OnlyClaude-优化 |
| decision | `decision_making.md` | 含 sections 属性 |
| roadmap | `roadmap.md` | 任务关联 |
| phantom | 悬空引用自动创建 | content-review |

## 边（关系类型）

实现、依赖、思考、决策、任务、包含、共享、改动、链接、相关

## query.js 导出接口

| 函数 | 说明 |
|------|------|
| `queryGraph(graph, keyword, depth=2)` | 纯 KG 子图查询，返回 `{ nodes, edges }` |
| `queryContext({ graph, query, projectDir, sessionFile })` | 三层上下文聚合，返回 Markdown 字符串 |
| `findMemoryDir(projectDir)` | 自动发现 Claude Code memory 目录 |
| `loadMemory(projectDir, query)` | 加载匹配的 memory 文件 |
| `loadSession(projectDir, sessionFile)` | 加载 session-memory 文件 |

## 与其他 Skill 联动

| Skill | 联动方式 |
|-------|---------|
| `/context-loader` | 薄封装调用 `scan.js --query --context`（依赖本 skill） |
| `/dev` `/dev-team` | 通过 context-loader 间接使用 |
| `/decision` | 新增决策后重新扫描更新图谱 |
| `/save-thinking` | 新增思考后重新扫描更新图谱 |

## 下一步

**短期（v2.1）** ✅ 已完成：
- [x] 补 deferred 管线端到端测试（4 个新测试：前向 wiki-link、related 优先级、fallback、phantom 标记）
- [x] hook 覆盖补全（监听 `1-Inbox/thinking`）
- [x] 错误处理收窄（ENOENT 静默跳过，其他解析错误 console.warn）

**中期（v3）**：
- [ ] thinking → skill 关键词匹配改为"证据分"（标题/H2 高分、段落集中 中分、全文散落 不建边）
- [ ] SKILL.md 支持 `aliases` 字段，匹配 canonical dir name + aliases
- [ ] 模块拆分：graph-core / scanners / query / cli（当前 scan.js 职责过重）

**远期**：
- [x] 查询 benchmark（固定 query set + expected profile/sections/nodes，防止调参漂移）
- [ ] 增量扫描（只更新变更文件，不全量重建）

---

*v2.0 — 2026-03-14：cc + Codex 协作优化。scan.js 延迟边解析 + 4 项 bug 修复；query.js 重写（种子评分 + 加权 BFS + 分层截断），dev 查询噪音 -45%*
*v1.1 — 2026-03-13：新增 --context 模式、query.js 导出接口说明、kg.config.js 配置文档*
