# cc-knowledge-graph

> A navigation system for Claude Code projects — automatically builds a knowledge graph from your skills, thinking docs, and project files, then answers "what's related to X?" with a subgraph query.

English · [中文](./README.zh.md)

---

## Why

When you have dozens of Claude Code skills, thinking docs, decision records, and project files, starting a new task means blindly grepping or opening files one by one. This skill builds a **structured graph** of nodes and relationships, so you (or cc) can pull the right context before starting work.

## How It Works

```
Scan skills / thinking / projects
         ↓
Build nodes + typed edges (implements, depends, shares, thinks-about, ...)
         ↓
Write 0-System/knowledge-graph.json
         ↓
Query: "what's related to session-memory?" → 1-2 hop subgraph
```

## Install

Drop the `scripts/` folder and `SKILL.md` into your Claude Code skills directory:

```
.claude/skills/knowledge-graph/
├── SKILL.md
└── scripts/
    ├── scan.js      # scanner + query entry point
    └── query.js     # BFS subgraph query module
```

No dependencies — pure Node.js.

## Usage

### Generate the graph

```bash
node .claude/skills/knowledge-graph/scripts/scan.js
# → writes 0-System/knowledge-graph.json
```

### Query a subgraph

```bash
node .claude/skills/knowledge-graph/scripts/scan.js --query session-memory
```

Output: JSON subgraph + human-readable summary.

## Customizing Directory Structure

By default the scanner expects a Claude Code-style project layout. To adapt it to your own structure, create `kg.config.js` at your project root:

```js
// kg.config.js
module.exports = {
  outputFile: 'docs/knowledge-graph.json',  // where to write the graph
  scanPaths: {
    skills: '.claude/skills',               // Claude Code skills
    projects: 'projects',                   // your projects directory
    thinking: 'notes/thinking',             // design docs / research
    inbox_thinking: 'notes/inbox',          // drafts
    system: 'docs',                         // system files
  },
};
```

Any key you omit falls back to the default.

## Node Types

| Type | Source | Example |
|------|--------|---------|
| `skill` | `.claude/skills/*/SKILL.md` | `session-memory` |
| `code` | `scripts/*.js` in each skill | `save.js` |
| `thinking` | `3-Thinking/*.md` | `知识图谱设计` |
| `project` | `2-Projects/` subdirs | `my-project` |
| `decision` | `04-决策记录.md` files | decision record |
| `roadmap` | `roadmap.md` files | roadmap doc |
| `phantom` | unresolved references | auto-created |

## Edge Types

`实现` (implements) · `依赖` (depends-on) · `思考` (thinks-about) · `决策` (decision) · `包含` (contains) · `共享` (shares) · `改动` (modified-by) · `链接` (wiki-link)

## Declaring Relationships in SKILL.md

Add `depends:` or `related:` to your skill's frontmatter — the scanner picks them up automatically (Pull model):

```yaml
---
name: full-dev
depends: dev-team, decision, tell-me
related: my-thinking-doc
---
```

You can also use `[[wiki-link]]` syntax inside any markdown file to create explicit edges:

```markdown
This skill builds on [[session-memory]] and is documented in [[知识图谱-cc导航系统]].
```

Unresolved links become `phantom` nodes, making broken references visible.

## Auto-sync via Hook

Add this to `.claude/settings.local.json` to auto-regenerate the graph whenever you write a skill or thinking file:

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

`knowledge-graph-sync.js` (trigger script):

```js
import { execSync } from 'child_process';

const input = JSON.parse(process.env.CLAUDE_HOOK_INPUT || '{}');
const filePath = input?.tool_input?.file_path || '';

const relevant = ['/SKILL.md', '/3-Thinking/', '/1-Inbox/thinking/', '决策记录'];
if (relevant.some(p => filePath.includes(p))) {
  execSync(`node "${process.env.CLAUDE_PROJECT_DIR}/.claude/skills/knowledge-graph/scripts/scan.js"`, { stdio: 'inherit' });
}
```

## Tests

```bash
node scripts/scan.test.js
# 22 tests, 0 failures
```

---

*MIT License · Built as a Claude Code skill*
