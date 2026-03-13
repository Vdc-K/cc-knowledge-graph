# cc-knowledge-graph

> Claude Code 项目的导航系统 — 自动扫描 skills/thinking/projects 构建知识图谱，然后用子图查询回答"X 相关的上下文在哪里？"

[English](./README.md) · 中文

---

## 为什么需要它

当你有几十个 Claude Code skills、设计文档、决策记录和项目文件时，每次开始一个任务都要盲目 grep 或逐个打开文件。

这个 skill 把所有文件的**结构关系**提取成一张图，让 cc 开始工作前可以先查"跟这个任务相关的上下文都在哪里"。

## 工作原理

```
扫描 skills / thinking / projects
         ↓
构建节点 + 有类型的边（实现/依赖/思考/决策/共享...）
         ↓
写入 0-System/knowledge-graph.json
         ↓
查询："session-memory 相关的有哪些？" → 1-2 跳子图
```

## 安装

把 `scripts/` 目录和 `SKILL.md` 放入 Claude Code skills 目录：

```
.claude/skills/knowledge-graph/
├── SKILL.md
└── scripts/
    ├── scan.js      # 扫描器 + 查询入口
    └── query.js     # BFS 子图查询模块
```

零依赖，纯 Node.js。

## 用法

### 生成图谱

```bash
node .claude/skills/knowledge-graph/scripts/scan.js
# → 写入 0-System/knowledge-graph.json
```

### 查询子图

```bash
node .claude/skills/knowledge-graph/scripts/scan.js --query session-memory
```

输出：JSON 子图 + 人可读摘要。

示例输出：
```
--- 摘要 ---
关键词: session-memory
匹配节点: 8
相关边: 13

节点列表:
  [skill] session-memory
  [code] session-memory/save.js
  [thinking] 知识图谱 — cc 的导航系统
  [decision] OnlyClaude-优化 决策记录
  [skill] daily-archive
  ...
```

## 适配自己的目录结构

默认适配 [OnlyClaude 风格](https://github.com/hicccc77/OnlyClaude)项目。要改成自己的目录，在项目根目录创建 `kg.config.js`：

```js
// kg.config.js
module.exports = {
  outputFile: 'docs/knowledge-graph.json',
  scanPaths: {
    skills: '.claude/skills',
    projects: 'projects',
    thinking: 'notes/thinking',
    inbox_thinking: 'notes/inbox',
    system: 'docs',
  },
};
```

不填的 key 自动回退到默认值。

## 节点类型

| 类型 | 来源 | 示例 |
|------|------|------|
| `skill` | `.claude/skills/*/SKILL.md` | `session-memory` |
| `code` | skill 目录下的 `scripts/*.js` | `save.js` |
| `thinking` | `3-Thinking/*.md` | 设计文档 |
| `project` | `2-Projects/` 子目录 | 项目文件夹 |
| `decision` | `decision_making.md` | 决策记录文件 |
| `roadmap` | `roadmap.md` | 路线图 |
| `phantom` | 悬空引用自动创建 | 未解析的引用 |

## 边类型

`实现` · `依赖` · `思考` · `决策` · `包含` · `共享` · `改动` · `链接`

## 在 SKILL.md 中声明关系（Pull model）

在 skill 的 frontmatter 里加 `depends:` 或 `related:`，扫描器自动读取：

```yaml
---
name: full-dev
depends: dev-team, decision, tell-me
related: my-thinking-doc
---
```

也可以在任意 Markdown 文件里用 `[[wiki-link]]` 语法建立显式链接：

```markdown
这个 skill 依赖 [[session-memory]]，设计思路记录在 [[知识图谱-cc导航系统]]。
```

未解析的链接会变成 `phantom` 节点，让悬空引用一目了然。

## 自动同步（PostToolUse Hook）

在 `.claude/settings.local.json` 里配置，每次写 skill 或 thinking 文件时自动重新生成图谱：

```json
{
  "hooks": {
    "PostToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "node $CLAUDE_PROJECT_DIR/.claude/hooks/knowledge-graph-sync.js"
      }]
    }]
  }
}
```

`knowledge-graph-sync.js` 触发脚本：

```js
import { execSync } from 'child_process';

const input = JSON.parse(process.env.CLAUDE_HOOK_INPUT || '{}');
const filePath = input?.tool_input?.file_path || '';

const relevant = ['/SKILL.md', '/3-Thinking/', '/1-Inbox/thinking/', '决策记录'];
if (relevant.some(p => filePath.includes(p))) {
  execSync(`node "${process.env.CLAUDE_PROJECT_DIR}/.claude/skills/knowledge-graph/scripts/scan.js"`, { stdio: 'inherit' });
}
```

## 测试

```bash
node scripts/scan.test.js
# 22 个测试，0 失败
```

---

*MIT License · 作为 Claude Code Skill 构建*
