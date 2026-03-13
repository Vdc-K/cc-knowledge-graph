---
name: knowledge-graph
description: 知识图谱 — cc 的导航系统。扫描项目文件自动构建节点+边的关系网，支持子图查询。触发词："/knowledge-graph"、"更新图谱"、"查图谱"
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

## 边界
**做**：扫描 Skills/Projects/Thinking 目录 → 构建节点+边的知识图谱 → 支持关键词子图查询
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

## 节点类型

| 类型 | 来源 | 示例 |
|------|------|------|
| skill | `.claude/skills/*/SKILL.md` | session-memory |
| code | `scripts/*.js` | save.js |
| thinking | `3-Thinking/*.md` | 知识图谱设计 |
| project | `2-Projects/` | OnlyClaude-优化 |
| decision | `04-决策记录.md` | 含 sections 属性 |
| roadmap | `roadmap.md` | 任务关联 |
| phantom | 悬空引用自动创建 | content-review |

## 边（关系类型）

实现、依赖、思考、决策、任务、包含、共享、改动

## 与其他 Skill 联动

| Skill | 联动方式 |
|-------|---------|
| `/dev` `/dev-team` | 开始前可查图谱获取相关上下文 |
| `/decision` | 新增决策后重新扫描更新图谱 |
| `/save-thinking` | 新增思考后重新扫描更新图谱 |

---

*v1.0 — 2026-03-13*
