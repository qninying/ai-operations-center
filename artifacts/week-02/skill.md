---
name: multi-file-skill
author: Quincy Nkwain Ninying
version: 1.0.0
tools: config.json
---

# Multi-File Skill

## Description

This Skill demonstrates the multi-file pattern: a Skill whose definition is split across several files instead of living entirely inside one Markdown document. Use this pattern when a Skill needs any of the following, which don't fit cleanly inside a single frontmatter-plus-body file:

- **Explicit tool access scoping** — a declared, auditable list of which tools the Skill is allowed to use, kept in a structured file (`config.json`) rather than described in prose where it's easy to drift out of sync with actual behavior.
- **Supporting assets** — templates, scripts, or reference data that the instruction body points to rather than inlines, keeping the main file focused on the "how" rather than mixing in large chunks of static content.
- **Separate maintenance of structure vs. content** — a reviewer checking "what can this Skill touch" should be able to read `config.json` alone, without parsing instruction prose to infer tool access.

This specific Skill is a template/reference, not a functioning task Skill — it exists to show the directory shape (`skill.md` + `config.json` + `README.md`) that a real multi-file Skill should follow. Copy this structure as a starting point when building a Skill that genuinely needs scoped tool access or supporting files.

## When to use the multi-file pattern vs. a single file

| Situation | Pattern |
|---|---|
| Simple procedure, no special tool restrictions, no supporting assets | Single `.md` file (frontmatter + body) |
| Needs explicit tool allow/deny list for audit or safety reasons | Multi-file, with `config.json` |
| Needs templates, scripts, or reference data alongside instructions | Multi-file, with those assets as sibling files |
| Will be reviewed/approved by someone who isn't reading the full instruction body | Multi-file, so `config.json` gives them a fast structural read |

## Instructions

### Step 1: Load the configuration

Before acting, read `config.json` in this Skill's directory. It defines the tools this Skill is permitted to use and any per-tool constraints. Treat it as the authoritative scope — if a step below implies using a tool not listed in `config.json`, the config wins and the step must be skipped or escalated, not silently worked around.

### Step 2: Confirm inputs

This template Skill takes no required inputs. A real Skill built from this pattern should list its required inputs here, same as the single-file template.

### Step 3: Run the procedure

This is where the Skill's actual steps go. In this reference version, there is no real task — a real multi-file Skill replaces this section with the concrete, ordered steps for its task, same as in a single-file Skill.

### Step 4: Respect scoping on output

Any file the Skill writes, or any external call it makes, must stay within the tools and paths declared in `config.json`. If the task requires a tool outside that scope, stop and report rather than expanding scope silently.

### Step 5: Report results

Summarize what was done, which tools from `config.json` were actually used (vs. merely permitted), and any assumptions made.
