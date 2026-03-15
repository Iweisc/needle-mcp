# Impact Evidence (Pitch-Ready)

Use this to justify "why this matters" in slides/devpost without making unsupported claims.

## External Signals (with sources)

1. **Developers are paying a correction tax**
   - Stack Overflow 2025 reports **66%** of developers spend more time fixing almost-right AI output than writing code from scratch.
   - Source: https://stackoverflow.blog/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/

2. **Trust remains limited**
   - Stack Overflow 2025 AI page shows only **33% trust AI output accuracy**, while **46% distrust**.
   - Source: https://survey.stackoverflow.co/2025/ai

3. **Measured slowdown in realistic repo work**
   - METR’s 2025 randomized study found experienced open-source developers were **19% slower** with early-2025 AI tools in the tested workflow.
   - Source: https://arxiv.org/abs/2507.09089

4. **Hallucinated dependencies are a real failure mode**
   - 2024 study on package hallucinations found code LLMs generating references to non-existent packages (higher incidence in open-source models).
   - Source: https://arxiv.org/abs/2406.10279

## Benchmark Claims You Can Make

Use your generated benchmark artifacts from `benchmark-results/latest/`:

- `report.md`: comparative score table
- `impact.md`: time/cost summary
- `graphs/time-cut-percent.svg`: headline "cuts time by X%"
- `graphs/weekly-time-saved.svg`: weekly recovered time
- `graphs/hallucination-tax-scenario.svg`: external context scenario chart

## Safe Messaging Template

- "In our benchmark, Needle reduced expected time to first correct answer by **X%** versus an ungrounded baseline."
- "That translates to **Y minutes saved per engineer per week** under our benchmark assumptions."
- "This addresses a known correction tax: most developers report losing time fixing almost-right AI output."

## Guardrail

Do not present external percentages as universal constants. Frame them as "industry signals" and keep your primary claim tied to your own measured benchmark outputs.
