#!/usr/bin/env python3
"""
score_prompt.py

Grades a prompt against a set of test cases you've already decided are
correct. You give it two files: a prompt (a text file with {{placeholders}}
in it) and an eval.jsonl file (one test case per line, each with an "input"
and an "expected"). It fills each case's input into the prompt, sends it to
Claude, and checks whether what came back matches what you said should come
back.

Usage:
    python3 scripts/score_prompt.py <path-to-prompt-file> <path-to-eval.jsonl>

Example:
    python3 scripts/score_prompt.py prompts/classify-incident-severity/prompt.txt prompts/classify-incident-severity/eval.jsonl

Usage note on scores: claude-sonnet-5 doesn't allow pinning down a
"temperature" setting (confirmed by actually trying it — the API rejects it
as deprecated for this model), so there's a small amount of genuine
run-to-run randomness this script can't remove. A single score is real
evidence, but if a score is close to a decision (did version B actually beat
version A, or was it luck?), run it 2-3 times before trusting the difference.
"""

import sys
import os
import re
import json
from pathlib import Path

# --- Settings you might want to change later ---

# Which Claude model to use. Kept the same model this project's own AI
# agents already use (see mcp-server/src/rootCauseAgent.ts), so scores here
# are comparable to how the rest of CoreOps behaves.
MODEL = "claude-sonnet-5"

# How much room Claude's reply is allowed to take. Raised from 1024 to 4096
# after a real failure: draft-diagnostic-script's replies (a full script
# wrapped in JSON) sometimes got cut off before the JSON closed, which then
# failed to parse and looked like a wrong answer rather than a too-small
# limit. 4096 covers a full script comfortably; raise further if a future
# prompt's replies are naturally longer than that.
MAX_TOKENS = 4096

# When comparing two numbers (like a confidence score), how far apart they're
# allowed to be and still count as "the same answer." Raised from 0.01 (the
# original, essentially-exact value, fine for a field like an incident count)
# to 15 once a prompt with a *subjective* number field showed up — a 0-100
# confidence estimate is a judgment call, not something a model should be
# expected to match to the exact point. Applies to every prompt's numbers,
# not just one, since this is a shared setting.
NUMBER_TOLERANCE = 15

# Where this project's real Anthropic API key already lives.
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
PROJECT_ENV_FILE = REPO_ROOT / "mcp-server" / ".env"


def load_api_key():
    """
    Reads ANTHROPIC_API_KEY from this project's .env file (mcp-server/.env).
    If it's missing entirely, this prints a plain-English fix instead of
    letting the program crash with a confusing error later.
    """
    from dotenv import load_dotenv

    if PROJECT_ENV_FILE.exists():
        load_dotenv(PROJECT_ENV_FILE)
    else:
        # Also try a .env in whatever folder you're running this from, in
        # case you've set one up somewhere else.
        load_dotenv()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Couldn't find ANTHROPIC_API_KEY.")
        print(f"Fix: open {PROJECT_ENV_FILE} and make sure it has a line like:")
        print("  ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)
    return api_key


def fill_prompt(prompt_template, input_values):
    """
    Takes the prompt text and swaps every {{field_name}} in it for the real
    value from this test case's "input". Example: if the prompt contains
    {{system}} and the input has "system": "prod-sql-01", the result has
    "prod-sql-01" in that spot instead.
    """
    filled = prompt_template
    for key, value in input_values.items():
        placeholder = "{{" + key + "}}"
        filled = filled.replace(placeholder, str(value))
    return filled


def call_claude(client, filled_prompt):
    """
    Sends the filled-in prompt to Claude and returns its reply as plain text.

    Note: claude-sonnet-5 rejects a `temperature` setting outright ("deprecated
    for this model") — confirmed by actually hitting the API, not assumed — so
    this script can't force fully deterministic answers the way older models
    allowed. That means two runs of the same prompt and case can genuinely
    give different answers by chance. See score_prompt.py's usage note: run
    more than once before trusting a single score change as real progress.
    """
    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        messages=[{"role": "user", "content": filled_prompt}],
    )

    if response.stop_reason == "max_tokens":
        # Confirmed with a real case (draft-diagnostic-script v1.0.0): a reply
        # cut off mid-script has no closing brace, so it fails to parse and
        # looks like a wrong answer instead of what it actually is -- a
        # response that ran out of room. Printing this plainly so a future
        # "couldn't parse" failure is diagnosable, not mysterious.
        print(f"  (warning: Claude's reply was cut off at {MAX_TOKENS} tokens -- raise MAX_TOKENS if this keeps happening)")

    # A reply can come back in more than one piece (a "block"). We only care
    # about the text pieces, joined together into one string.
    return "".join(block.text for block in response.content if block.type == "text")


def extract_json(response_text):
    """
    Claude might answer with exactly {"severity": "High"}, or it might wrap
    it in a sentence or a code block. This looks for the first { ... } chunk
    in the reply and tries to read it as JSON. Returns None if it can't find
    or can't parse one — that counts as a failed case, not a crash.
    """
    match = re.search(r"\{.*\}", response_text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def values_match(expected_value, actual_value):
    """
    Decides whether one field's expected value and actual value count as a
    match, per the two rules we agreed on:
      - numbers are allowed to be a little off (NUMBER_TOLERANCE)
      - everything else is compared as text, ignoring case and extra spaces
    """
    if isinstance(expected_value, (int, float)) and isinstance(actual_value, (int, float)):
        return abs(expected_value - actual_value) <= NUMBER_TOLERANCE
    return str(expected_value).strip().lower() == str(actual_value).strip().lower()


def score_case(expected, actual_parsed):
    """
    Compares ONLY the fields listed in `expected` — anything extra Claude
    adds around them is ignored, per what we agreed. Returns whether every
    expected field matched, and a list of exactly which ones didn't (empty
    if it passed).
    """
    if actual_parsed is None:
        return False, [(field, expected[field], "(no readable answer came back)") for field in expected]

    mismatches = []
    for field, expected_value in expected.items():
        actual_value = actual_parsed.get(field, "(missing)")
        if not values_match(expected_value, actual_value):
            mismatches.append((field, expected_value, actual_value))
    return (len(mismatches) == 0), mismatches


def load_cases(eval_path):
    """Reads the eval.jsonl file: one JSON object per line, skipping blank lines."""
    cases = []
    with eval_path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                cases.append(json.loads(line))
    return cases


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 scripts/score_prompt.py <prompt_file> <eval_jsonl_file>")
        sys.exit(1)

    prompt_path = Path(sys.argv[1])
    eval_path = Path(sys.argv[2])

    if not prompt_path.exists():
        print(f"Can't find the prompt file: {prompt_path}")
        print("(If you haven't written the prompt yet, this is expected — write it, then run this again.)")
        sys.exit(1)

    if not eval_path.exists():
        print(f"Can't find the eval file: {eval_path}")
        sys.exit(1)

    api_key = load_api_key()

    # Imported here (not at the top) so the plain-English "you're missing
    # ANTHROPIC_API_KEY" message above can print even if this package were
    # somehow missing too, instead of that error hiding the more useful one.
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    prompt_template = prompt_path.read_text()
    cases = load_cases(eval_path)

    passed_count = 0
    failure_lines = []

    for i, case in enumerate(cases, start=1):
        filled_prompt = fill_prompt(prompt_template, case["input"])

        try:
            response_text = call_claude(client, filled_prompt)
        except anthropic.AuthenticationError:
            print("Claude's API rejected your ANTHROPIC_API_KEY — it's missing or wrong.")
            print(f"Fix: open {PROJECT_ENV_FILE} and check ANTHROPIC_API_KEY is set to a real, current key.")
            sys.exit(1)
        except anthropic.APIConnectionError:
            print("Couldn't reach Claude's API. Check your internet connection and try again.")
            sys.exit(1)
        except anthropic.APIStatusError as error:
            # Catches anything else Claude's API rejected (a bad request, a
            # setting the model doesn't support, rate limiting, etc.) that
            # isn't specifically a key or connection problem. Prints the
            # actual reason Claude gave, not a Python stack trace.
            print(f"Claude's API returned an error on case {i}: {error.message}")
            sys.exit(1)

        actual_parsed = extract_json(response_text)
        passed, mismatches = score_case(case["expected"], actual_parsed)

        if passed:
            passed_count += 1
        else:
            shown_actual = actual_parsed if actual_parsed is not None else response_text.strip()
            failure_lines.append(f"Case {i}: expected {case['expected']}, got {shown_actual}")

    total = len(cases)
    score = (passed_count / total) if total else 0.0

    print(f"\nScore: {score:.2f}  ({passed_count}/{total} cases matched)")
    print(f"Model: {MODEL}")
    print(f"Cases run: {total}")

    if failure_lines:
        print("\nFailed cases:")
        for line in failure_lines:
            print(f"  {line}")


if __name__ == "__main__":
    main()
