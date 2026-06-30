# Usage Guide

## Claude Prompt

Read AGENTS.md and AGENT_LOG.md first.

You are the implementation agent.

Before coding:
1. Create required snapshot
2. Record snapshot in AGENT_LOG.md
3. Inspect relevant files
4. Summarize implementation plan

Implement only the requested task.
Do not rewrite unrelated code.

After implementation:
- Update AGENT_LOG.md

Task:
[YOUR TASK]

--------------------------------

## Codex Review Prompt

Read AGENTS.md and AGENT_LOG.md first.

You are the review agent.

Review Claude Code's latest implementation.

Do not modify files yet.

Check:
- Bugs
- Logic errors
- Runtime issues
- Security concerns
- Edge cases
- Broken imports

Update AGENT_LOG.md

--------------------------------

## Codex Fix Prompt

Apply only the necessary fixes from your review.

Do not rewrite unrelated code.

After fixing:
- Update AGENT_LOG.md
