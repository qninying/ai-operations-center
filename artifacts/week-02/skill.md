---
name: csv-report-builder
description: Validates, cleans, aggregates, and summarizes CSV data files into a self-contained HTML report with tables and key stats. Make sure to use this skill whenever the user has a messy or raw CSV/TSV file and wants it checked for data-quality issues, cleaned up, grouped/summarized by a column, or turned into a shareable report — even if they just say "can you make sense of this spreadsheet" or "summarize this data" without using the words "CSV" or "report" explicitly. Covers the full pipeline (validate -> clean -> aggregate -> report) but each stage can also be run standalone if the user only wants one step.
allowed-tools: Bash, Read, Write
license: For internal/example use. Adapt before distributing.
---

# CSV Report Builder

## Purpose

Turn a raw CSV file into a trustworthy, readable summary. Real-world CSVs are
rarely clean — inconsistent whitespace, duplicate rows, mixed types in a
numeric column, missing values. Rather than eyeballing the data or writing
one-off pandas snippets from scratch each time, this skill runs a fixed,
auditable four-stage pipeline and produces a report that shows exactly what
was found and fixed, so the user can trust the numbers in it.

## Why multiple files instead of one script

Each stage below is deliberately a separate, single-purpose script:

- **Separation of concerns.** Validation should never silently mutate data;
  cleaning should never hide what it changed; aggregation should never
  guess at a schema the validator hasn't already confirmed. Keeping them
  in separate files makes each one easy to reason about and re-run alone.
- **Partial use.** A user might only want validation ("just tell me if this
  file is broken") without wanting it cleaned or reported on. Standalone
  scripts make that possible without extra flags or modes bolted onto one
  monolithic tool.
- **Progressive disclosure.** This SKILL.md stays short because the
  detailed conventions (exact JSON shapes, exit codes, column-naming rules)
  live in `references/`, loaded only when actually needed — not on every
  invocation.

## Tool access

This skill only needs `Bash` (to run the Python scripts below), `Read`
(to inspect the source CSV and script output), and `Write` (to save the
cleaned CSV, aggregate JSON, and final HTML report). It does not need
`Edit` (scripts are run, not hand-edited), `WebFetch`/`WebSearch` (this is
a local data task), or any messaging tools — if a task built on this skill
seems to need those, that's a signal it has grown beyond what this skill
covers.

## Pipeline

Run stages in order from the skill's own directory (so relative script
paths resolve), passing the working file forward from one stage to the
next. All scripts use only the Python standard library — no dependency
install step is required.

### 1. Validate

```bash
python3 scripts/validate_csv.py <input.csv>
```

Checks the file for a consistent header, consistent column count per row,
and per-column type consistency (a column is expected to be either
uniformly numeric or uniformly text). Prints a JSON report to stdout — see
`references/csv_conventions.md` for the exact shape — and exits non-zero
if the file has structural problems that would make cleaning or
aggregation unreliable (e.g. inconsistent column counts). Exits zero with
a list of warnings for things cleaning can fix (duplicates, whitespace,
missing values).

Read the validation report before proceeding. If it exits non-zero, fix
or flag the structural issue with the user rather than forcing the file
through the rest of the pipeline — garbage in, garbage out.

### 2. Clean

```bash
python3 scripts/clean_csv.py <input.csv> <cleaned_output.csv>
```

Trims whitespace, drops exact-duplicate rows, and coerces numeric columns
(stripping stray currency symbols/commas). Rows that can't be repaired
(e.g. a required field is empty) are dropped and logged — never silently
kept with a guessed value. Prints a JSON summary of what changed (rows in,
rows out, rows dropped and why, columns coerced) to stdout.

### 3. Aggregate

```bash
python3 scripts/aggregate_csv.py <cleaned.csv> <group_by_column> <aggregate_output.json>
```

Groups the cleaned data by `<group_by_column>` and computes count, sum,
mean, min, and max for every numeric column. Writes the result as JSON
(shape documented in `references/csv_conventions.md`). Ask the user which
column to group by if it isn't obvious from context — picking the wrong
grouping column silently produces a misleading report, so don't guess if
there are multiple plausible candidates (e.g. both a `region` and a
`category` column).

### 4. Report

```bash
python3 scripts/generate_report.py <cleaned.csv> <aggregate_output.json> <report.html>
```

Renders a single self-contained HTML file (inline CSS, no external
requests) with: a data-quality summary (from the clean step's stdout, if
you pass it along — see the script's `--clean-summary` flag), a sortable
table of the cleaned data, and a table of the aggregated stats per group.
Open or hand back `<report.html>` as the deliverable.

## When something looks wrong

If validation reports structural problems, or a column expected to be
numeric is mostly text, stop and ask the user rather than pushing through
— see `references/troubleshooting.md` for the common causes (wrong
delimiter, extra header rows, merged cells exported from Excel) and how
to confirm which one applies before choosing a fix.
