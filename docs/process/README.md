# Build process material

How CoreOps was planned and built, kept for reference. None of this is needed to run the system.

| Path | What it is |
|------|------------|
| [`BuildIdeaPrompt.txt`](BuildIdeaPrompt.txt) | The original project brief used to generate the architecture blueprint in [`project-blueprint/`](../../project-blueprint/) |
| [`skills.md`](skills.md) | How that blueprint was produced from the brief |
| [`prompts/`](prompts/) | Versioned prompt library (one folder per prompt, each with an `eval.jsonl` test set). Score a version with `python3 scripts/score_prompt.py <prompt-file> <eval.jsonl>` |
