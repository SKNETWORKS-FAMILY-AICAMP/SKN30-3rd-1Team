# Claude Code + Codex CLI Collaboration Orchestration Guide

## Roles
- Claude Code = Implementation agent
- Codex CLI = Review/validation agent
- User = Orchestrator

## Workflow
1. User assigns task to Claude
2. Claude:
   - Read AGENTS.md and AGENT_LOG.md
   - Create snapshot
   - Explain plan
   - Implement changes
   - Update AGENT_LOG.md

3. User reviews Claude output

4. User asks Codex for review
5. Codex:
   - Read AGENTS.md and AGENT_LOG.md
   - Review Claude changes
   - Report issues
   - Update AGENT_LOG.md

6. User decides whether Codex should apply fixes

## Snapshot command

    mkdir -p ../snapshots
    cp -r . ../snapshots/pre_claude_$(date +%F_%H%M)

## Safety Rules
- Avoid unrelated rewrites
- Do not modify secrets/.env unless requested
- Keep changes scoped
- Log all work
