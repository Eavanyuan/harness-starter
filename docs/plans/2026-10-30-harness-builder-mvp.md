> **[已被取代]** 本文档的可用部分已合并进最终方案
> [`2026-10-30-harness-builder-final.md`](./2026-10-30-harness-builder-final.md)，
> 实施以最终方案为准，本文仅留档评审过程。

# Harness Builder MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local CLI that clones the current harness for new projects and inspects existing Java/TypeScript/Vue projects to produce a reviewable, customizable harness plan before applying changes.

**Architecture:** Keep the CLI in this Node ESM repository. Separate read-only project analysis, normalized analysis output, harness plan generation, diff preview, and explicit apply. Use a deterministic built-in scanner for baseline facts, with optional adapters for pinned open-source analyzers; never run project install/build scripts automatically.

**Tech Stack:** Node.js >=18, ESM, existing shell test conventions, JSON + Markdown + Mermaid. TypeScript/Vue dependency analysis may use dependency-cruiser; Java bytecode analysis may use the installed JDK `jdeps` only when compiled outputs already exist.

---

## Product decisions

- New-project default is the current harness and agent set, with only project name, stack paths, and detected commands adapted.
- Existing-project scanning is read-only with respect to source files. Reports are written only to an explicit `--out` directory outside the target repository by default.
- `plan` creates a file-level proposal and diff. `apply` is a separate explicit command; existing user-authored files are never silently overwritten.
- MVP stack support is Java plus TypeScript/Vue. Other languages may be detected as unsupported, but do not receive generated stack commands in this release.
- Offer `lean` and `standard` process profiles. Both keep state tracking, verification evidence, required tests, high-risk stops, and review. `lean` shortens low-impact documentation flow; it does not disable safety gates.
- Analyzer adapters must report tool name/version, source evidence, and limitations. Do not install dependencies or run target-project scripts during scan.
- Skill integration in MVP is agent-mediated: create a prompt bundle from the machine report and selected, version-pinned open-source `SKILL.md` sources; the user's configured coding agent performs semantic interpretation. Do not add an LLM/API runtime to the CLI.
- The existing untracked `scripts/lib/analyzer.mjs` is the starting point for inspection, not a file to overwrite wholesale. Preserve the user's current work and reconcile it before implementation.

## Task 1: Define and test the analysis report contract

**Files:**
- Create: `test/analyzer.test.sh`
- Modify: `scripts/lib/analyzer.mjs`

**Steps:**

1. Create temporary Java/Maven and TypeScript/Vue fixture trees in the test script. Include ignored directories, direct imports, an unresolved import, and a cycle.
2. Run the analyzer against each fixture and assert detected stacks, source paths, dependency edges, ignored paths, confidence/limitations, and cycle output.
3. Refactor analyzer output into a stable JSON shape with `schema_version`, project root/name, stacks, modules, edges, evidence, tool metadata, and warnings. Preserve current exported functions where practical.
4. Ensure no source file is modified and no package-manager or project build command is invoked by the analyzer.
5. Run `bash test/analyzer.test.sh`; expect all fixture assertions to pass and no files to appear inside fixture roots.

## Task 2: Add Java and TypeScript/Vue analyzer adapters

**Files:**
- Create: `scripts/lib/analyzers/js-dependency-cruiser.mjs`
- Create: `scripts/lib/analyzers/java-jdeps.mjs`
- Create: `scripts/lib/skill-catalog.mjs`
- Create: `scripts/analysis-skills.json`
- Modify: `scripts/lib/analyzer.mjs`
- Modify: `package.json`
- Modify: `test/analyzer.test.sh`

**Steps:**

1. Define one static-analyzer adapter interface: `detect(root)`, `analyze(root)`, and `metadata()`; adapter output must map into the Task 1 report schema.
2. Add the TypeScript/Vue adapter for dependency-cruiser JSON output. Use a pinned, reviewed version; consume the project's existing TypeScript config/compiler when present. If unavailable, retain built-in source scanning and state the lower confidence.
3. Add the Java adapter for existing `target/classes` or `build/classes` through `jdeps` DOT output. Do not invoke Maven/Gradle to create compiled output. Fall back to source import and build-manifest edges when no classes exist.
4. Add a skill catalog containing source URL, pinned ref/version, license, scope, and entrypoint for each curated open-source skill. Before adding a source, verify its upstream license and document why it is needed; do not fetch arbitrary skills during a project scan.
5. Build a prompt bundle from `analysis.json` plus the selected skills. The bundle asks the user's configured agent to summarize architecture and propose profile choices with file evidence; it cannot write into the target project.
6. Treat missing executables, unsupported syntax, and analyzer failures as report warnings, not silent empty graphs or project-scan failures.
7. Add fixture tests for adapter unavailable/failure/fallback cases, catalog pin/license fields, and prompt-bundle output; verify tool metadata is recorded.
8. Run `bash test/analyzer.test.sh`; expect stable JSON, pinned skill provenance, and explicit fallback warnings.

## Task 3: Add the `inspect` command and project map

**Files:**
- Create: `scripts/harness-cli.mjs`
- Create: `scripts/lib/render-analysis.mjs`
- Modify: `package.json`
- Modify: `test/analyzer.test.sh`

**Steps:**

1. Add CLI argument parsing for `inspect <project-path> --out <report-dir>` and reject missing paths, unknown options, and an output directory inside the project unless explicitly requested.
2. Call the analysis engine and write `analysis.json`, `PROJECT-MAP.md`, and `dependencies.mmd` only under `--out`.
3. Include detected entrypoints, build/test commands, module counts, dependency graph, cycles, hotspots, unsupported areas, and confidence notes; separate measured facts from inferred architecture.
4. Add tests for path validation, output shape, no target writes, and stable Mermaid identifiers.
5. Run `node scripts/harness-cli.mjs inspect <fixture> --out <temp-report>`; expect report artifacts only under the chosen output directory.

## Task 4: Generate new-project plans from the current harness baseline

**Files:**
- Create: `scripts/lib/plan.mjs`
- Modify: `scripts/harness-cli.mjs`
- Modify: `scripts/build-agents.mjs` only if stack token resolution needs a safe extension
- Create: `test/harness-plan.test.sh`

**Steps:**

1. Add `plan new <target> --name <project-name>` using the current source-of-truth files (`agents/`, `hooks/`, `.skills/`, templates, scripts, and CI workflow), not generated CLI output as the source.
2. Adapt only `harness.config.json` values inferred from Java/Maven and TypeScript/Vue manifests. Mark guessed commands for review and leave unknown commands unset.
3. Write the proposal into a staging directory and produce a manifest of create/update/conflict actions; do not write the target repository.
4. Verify generated agents and hooks using existing `check:agents`, `check:hooks`, and `check:skills` against the staged project.
5. Test that default new-project plans contain the current 11 agents and current harness gate set, with no unreviewed profile trimming.
6. Run `bash test/harness-plan.test.sh`; expect a reproducible plan and unchanged target tree.

## Task 5: Generate existing-project plans with workflow profiles

**Files:**
- Modify: `scripts/lib/plan.mjs`
- Modify: `scripts/harness-cli.mjs`
- Modify: `harness.config.json`
- Modify: `scripts/init-harness.sh`
- Modify: `agents/orchestrator.agent.md`
- Modify: `scripts/doctor.mjs`
- Create: `templates/HARNESS-ADOPTION.md`
- Modify: `test/harness-plan.test.sh`

**Steps:**

1. Add `plan existing <project-path> --profile lean|standard --analysis <analysis.json>` and validate that the analysis report belongs to the requested project.
2. Define `processProfiles` in `harness.config.json`. Each profile lists required stages/artifacts and optional stages; hard gates (state schema, verification evidence, tests, high-risk stops, review, CI) are fixed invariants outside profile overrides.
3. Add the selected profile to each initialized task state and update the orchestrator source to follow the declared required/optional stages. Rebuild all generated agent outputs from source.
4. Map detected stacks to `harness.config.json`; include a source citation for each inferred stack path and command.
5. Make `standard` use the current process. Make `lean` omit only low-impact RS/FS/ADR ceremony; preserve state, evidence, tests, high-risk stops, and review.
6. Add `doctor` validation that profiles exist, profile stage lists are valid, and no profile disables a fixed hard gate.
7. Generate an adoption checklist that marks each inferred value as confirmed, uncertain, or unsupported. Keep project-specific architecture prose as a suggested addition, not an authoritative generated claim.
8. Test profile invariants: the lean plan cannot remove mandatory gates; unsupported stacks do not receive invented commands; conflicting existing files are listed as conflicts.
9. Run `bash test/harness-plan.test.sh`; expect both profiles to produce stable and reviewable manifests.

## Task 6: Add diff preview and explicit, safe apply

**Files:**
- Create: `scripts/lib/apply.mjs`
- Modify: `scripts/harness-cli.mjs`
- Create: `test/harness-apply.test.sh`

**Steps:**

1. Add `plan diff <plan-dir>` to show create/update/conflict actions and unified diffs without modifying the target.
2. Add `apply <plan-dir>` with path containment checks, symlink checks, and a second refusal for unresolved conflicts.
3. Apply files atomically. Create new files only; update existing generated files only when their generated marker matches; otherwise require an explicit per-file replacement choice.
4. Save a manifest of applied paths and original hashes in the report directory for review and recovery.
5. Test path traversal, symlink escape, conflict refusal, canceled preview, clean apply, and rerun idempotency.
6. Run `bash test/harness-apply.test.sh`; expect all refusal cases to leave the target tree unchanged.

## Task 7: Add validation, docs, and CI coverage

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/quality-gate.yml`
- Modify: `README.md`
- Create: `test/harness-cli.test.sh`

**Steps:**

1. Add npm scripts for inspect/plan/apply and a `test:harness-cli` aggregate that runs analyzer, plan, and apply tests.
2. Add the aggregate test to `npm run gate` and the quality-gate workflow.
3. Document new-project and existing-project commands, supported stack limits, open-source analyzer versions/licenses, read-only scan behavior, profile invariants, and conflict handling.
4. Test CLI help, invalid input exit codes, clean new-project plan, existing-project scan/plan, and refusal to apply without explicit command.
5. Run the targeted harness CLI tests, then the full `npm run gate`; save raw outputs through the repository's verify workflow when this plan is executed.
6. Confirm `git status --short` shows only intended harness changes and generated outputs pass drift checks.

## Out of scope for MVP

- Automatic installation or execution of target-project dependencies/build commands.
- Automatic semantic architecture decisions or automatic rewriting of existing AGENTS/architecture documents.
- Other language adapters beyond Java and TypeScript/Vue.
- Remote service, web UI, account sync, or automatic PR creation.
- Enforcing all traceability semantics without human review; the tool reports evidence and gaps, while semantic completeness remains review work.

## Execution constraints

- Implement in an isolated worktree when explicitly authorized; the current worktree contains unrelated uncommitted changes.
- Run test-first per task and preserve the existing `scripts/lib/analyzer.mjs` work.
- Do not commit or modify implementation files as part of the plan-authoring task.

## References

- dependency-cruiser supports JavaScript/TypeScript dependency analysis and graph output: https://github.com/sverweij/dependency-cruiser
- Oracle `jdeps` reference documents Java package/class dependency analysis and DOT output: https://docs.oracle.com/javase/8/docs/technotes/tools/windows/jdeps.html
