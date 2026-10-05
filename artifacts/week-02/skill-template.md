---
name: skill-template
author: Quincy Nkwain Ninying
version: 1.0.0
---

# Skill Template

## Description

This Skill provides a reusable pattern for packaging a repeatable task — a checklist, a workflow, a review process, or a generation routine — into a form an AI agent can invoke consistently. Use it when a task is performed often enough that re-explaining the steps each time wastes effort, when the steps must be followed in a specific order to produce a correct result, or when the output needs to be consistent across different invocations and different people running it.

Typical use cases:
- A multi-step review or audit process (e.g., code review, compliance check, document QA) that should follow the same checklist every time.
- A generation task with a fixed output shape (e.g., a report, a changelog, a status update) where the structure matters more than the specific content.
- An onboarding or setup routine that a new contributor or agent session needs to run the same way every time.
- Any task where "do it the same way as last time" is the actual requirement.

A Skill is not the right tool for a one-off task, a task with no repeatable structure, or a decision that genuinely depends on judgment calls unique to each situation.

## Instructions

### Step 1: Define the trigger

State plainly what causes this Skill to be invoked — a user command, a recurring event, or a condition detected during other work. Be specific enough that invoking the Skill at the wrong time is obviously wrong. If the Skill is invoked via a slash command or keyword, name it here.

### Step 2: Gather required inputs

List every piece of information the Skill needs before it can run, and where each one comes from (user-supplied, read from a file, fetched from an API, inferred from context). For each input, state what happens if it's missing — ask the user, use a documented default, or stop and report that the Skill cannot proceed.

### Step 3: Define the procedure

Write the actual steps, in order, as a numbered list. Each step should be concrete enough that two different runs produce the same shape of result. Where a step involves a judgment call, say so explicitly and give the rule for making it (e.g., "prefer the simpler option," "escalate to the user if ambiguous").

Example skeleton:
1. Validate inputs against the requirements from Step 2.
2. Perform the core transformation or check.
3. Produce the output in the format defined in Step 4.
4. Report back to the user what was done and any assumptions made.

### Step 4: Define the output contract

Describe exactly what the Skill produces — a file, a message, a structured report — and its required shape (sections, fields, format). If the output is a file, state the filename convention and where it's saved. If the output is a structured report, enumerate its fields and their types.

### Step 5: Define failure handling

State what the Skill does when:
- A required input is missing or invalid.
- An external dependency (API, file, service) is unavailable.
- The procedure produces an ambiguous or contradictory result.

Each of these should have a defined, non-silent response — stop and report, use a documented fallback, or escalate to the user. A Skill that fails silently is incomplete.

### Step 6: Define verification

State how to confirm the Skill did what it claims — a test, a manual check, or a specific piece of evidence (e.g., "the generated file parses as valid JSON," "the user confirms the summary matches their expectation"). Don't rely on "it ran without an error" alone if a stronger check is available.

### Step 7: Version and maintain

Record the version in the frontmatter above. Bump it when the procedure, inputs, or output contract change in a way that could affect existing consumers. Note any deprecated behavior here rather than silently removing it.
