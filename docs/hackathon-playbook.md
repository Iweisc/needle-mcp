# Needle Hackathon Playbook

## Positioning

Target primary win path as **Best AI Agentic System** and secondary path as overall placement.

Core message: Needle reduces hallucination risk for undocumented codebases by enforcing source-grounded answers with citation checks and optional snippet verification.

## Rubric Mapping

### Technical Implementation (60%)

- Multi-stage pipeline: resolve -> discover -> evidence -> synthesis -> verify.
- Multi-agent Nova Lite usage: query expansion, reranking, and gap analysis.
- Nova Premier synthesis with strict JSON schema + citation integrity validation.
- Verification loop for generated code snippets.

### Impact (20%)

- Benchmark report shows correctness uplift and expected time-to-correct reduction.
- Impact report translates quality/speed improvements into weekly and annual team savings.
- Demo scenario maps directly to developer onboarding/debug workflows.

### Creativity (20%)

- Hard-mode no-doc resources with minified/multi-file control flow.
- Evidence-driven, citation-enforced answer policy.
- Deterministic benchmark harness with per-case fact scoring and graph outputs.

## 3-Minute Demo Script

1. **Problem setup (0:00-0:25)**
   - "Undocumented libraries cause slow, error-prone onboarding and debugging."
2. **Baseline failure moment (0:25-0:50)**
   - Ask baseline LLM a hard question; show speculative/no-citation output.
3. **Needle run (0:50-1:50)**
   - Run same question via dashboard preset.
   - Show live timeline, evidence hits, deep reads, final citations.
4. **Trust and verification (1:50-2:20)**
   - Highlight citation integrity guard and optional snippet verification note.
5. **Quantified proof (2:20-2:50)**
   - Show benchmark graphs (`fact-coverage`, `correctness-rate`, `expected-time-to-correct`).
6. **Impact close (2:50-3:00)**
   - Show annual team-hour/value estimate from `impact.md`.

## Submission Checklist

- `README.md` includes setup + benchmark instructions.
- `benchmark-results/latest/report.md` generated from live run.
- `benchmark-results/latest/impact.md` generated from same run.
- `benchmark-results/latest/graphs/*.svg` exported and embedded in slides/devpost.
- `docs/impact-evidence.md` used for sourced industry context claims.
- Demo video follows the script above and references concrete metrics.

## Suggested Devpost Copy Snippets

- "Needle answers undocumented-library questions with source-grounded evidence and validated citations."
- "In our benchmark suite, Needle improved factual coverage and reduced expected time to first correct answer versus an ungrounded baseline."
- "Needle uses Nova Lite for search intelligence and Nova Premier for final synthesis, balancing speed, cost, and answer quality."
