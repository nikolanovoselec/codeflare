# Measurements

Evidence behind the rules in `SKILL.md`. Read this when a rule seems arbitrary or when you want to know how far to trust it. Several entries are weaker than they look, and two are retracted.

All figures from the Pangram detector, August 2026, `ai_likelihood` on a 0 (human) to 1 (AI) scale. Scoring was deterministic: identical input returned 0.9854 twice and 0.0552 / 0.0553 across runs.

The skill itself needs no tooling. Where an entry below mentions windowing, that refers to a scoring harness used during the experiments, which sliced text into 350-word blocks and scored each separately. It was removed from the skill deliberately so that using the skill costs nothing; it remains in this repository's git history if the measurements ever need repeating.

## The headline result: judgement beats structure

One 500-word piece on network security, same facts and same author throughout:

| Version | Score | Verdict |
|---|---|---|
| Original | 1.0000 | Highly Likely AI |
| Careful rewrite , varied moves, hard specifics, situated opening | 0.9976 | Highly Likely AI |
| Rewritten as chronological first-person narrative | 0.9854 | Highly Likely AI |
| Specificity added, nothing else | 0.9658 | Highly Likely AI |
| Digression, restatement and filler injected | 1.0000 | Highly Likely AI |
| **Rewritten with judgement, contempt and attitude** | **0.0154** | **Unlikely AI** |

Four structural interventions moved nothing. Point of view collapsed it. The winning version editorialises ("a landfill with a change process", "the security is decorative", "does not survive contact with a steering committee") and spends words on attitude rather than information.

## Controls: default assistant prose is detected outright

| Text | Score |
|---|---|
| Standard consulting-proposal paragraph | 1.0000 |
| Standard technical explainer, 204 words | 1.0000 |
| Standard marketing copy, 108 words | 1.0000 |

Shared traits: participial closers ("enabling your team to…"), abstract nouns, no specifics, uniform sentence length.

## Cumulative evidence: the parts can all be clean

Three paragraphs from one draft:

| Unit | Words | Score |
|---|---|---|
| P1 / P2 / P3 alone | 43 / 54 / 52 | 0.0002 / 0.0000 / 0.0000 |
| P1+P2 / P2+P3 / P1+P3 | ~100 | 0.0005 / 0.1122 / 0.0330 |
| **P1+P2+P3** | 149 | **0.9854** |
| Full five-paragraph draft | 225 | 1.0000 |

Repeated on a different 469-word draft: first third 0.0002, middle third 0.4864, last third 0.0002, first half 0.0006, second half 0.2219, **whole 0.9976**. No hotspot exists to find. The verdict is emergent from sustained uniformity, and adding more good paragraphs makes it worse.

## Move-variety ablation

Same content, same length, same voice; only rhetorical shape changed.

| Variant | Score |
|---|---|
| Original (P1 and P3 both run negation-correction) | 0.9854 |
| P1's move varied | 0.9341 |
| P3's move varied | 0.3768 |
| **Both varied** | **0.0535** |

A 247-word passage with a different move in every paragraph scored 0.0004.

## Topic dominates at length

Identical rhetorical skeleton, ~440 words each:

| Subject | Score |
|---|---|
| Network security | 0.9976 |
| Bread baking | 0.3082 |

A chronological personal narrative on the security topic still scored 0.9854. Security, Zero Trust, AI, agents, cloud and developer tooling are the hardest possible subjects.

**Superseded result:** the same template across six subjects (Zero Trust, AI agents, digital transformation, sourdough, badminton, guttering) scored 0.0005 / 0.0011 / 0.0002 / 0.0009 / 0.0000 / 0.0000, suggesting no topic effect. Those samples were ~120 words, below the evidence threshold. The finding does not survive at real length.

## Genre comparison, same subject, short form

| Framing | Score |
|---|---|
| Internal email to a colleague | 0.0000 |
| Flat, dry technical reference | 0.0001 |
| Personal account of a named engagement | 0.0006 |
| Vendor and number heavy assessment | 0.1099 |
| General conceptual explainer | 0.9854 |

## Lists versus prose

| Rendering | Score |
|---|---|
| Uniform parallel bullets | 0.3022 |
| Deliberately uneven bullets | 0.1421 |
| **Flowing prose** | **0.0552** |

Corroborated on a real 2,218-word client document: whole file 0.0076, but the block at words 1050 to 1400, a dense parallel deliverables list with tricolon interiors ("what is already paid for, what it can deliver, and what needs new spend"), scored **0.9146**. The adjacent block, thick with week numbers and dates, scored 0.0001.

## Markdown syntax carries signal

Same draft with headers and bullet markers stripped: 0.2409 → **0.1267**.

## Over-humanising backfires

Adding rhetorical questions, fragments and punchier openings: 0.1812 → **0.2409**. The API exposes a `HUMANIZER` class alongside `CLAUDE`, `GPT4` and `DEEPSEEK`, so humanised output is modelled as its own category.

## Surface noise is not the signal

Two client WhatsApp messages carrying genuine-looking misspellings ("seperately", "assesment") and systematically dropped apostrophes scored 0.2382 and 0.0000. The more heavily "humanised" of the two scored higher.

## Corpus baseline: 11 published LinkedIn posts

| Score | Words | Post |
|---|---|---|
| 1.0000 | 556 | 1-quiet-shift |
| 1.0000 | 1064 | 2-great-decoupling-part1 |
| 1.0000 | 1668 | 3-great-decoupling-part2 |
| 1.0000 | 2286 | 4-integration-is-architecture |
| 1.0000 | 1886 | 5-spec-driven-development |
| 1.0000 | 1926 | 6-evaluation-framework |
| 1.0000 | 1872 | 7-things-you-arent-being-told |
| 1.0000 | 1536 | 8-sdd-update |
| **0.0068** | 1587 | **9-sdd-for-enterprise** |
| 0.9658 | 3120 | 10-two-worlds-microsegmentation |
| 0.7290 | 2353 | 11-naas-the-glue |

Ten of eleven at or above 0.5, mean 0.882, mostly attributed to DEEPSEEK. Post 9 is the outlier and the model to imitate: its git history is five successive `Update 9-sdd-for-enterprise.md` commits, the GitHub web-editor default, indicating repeated hand editing. Its register is markedly more opinionated than the rest: sardonic asides ("an AI provider is having a bad Tuesday", "not a career-enhancing move"), invented-but-vivid scenarios with times attached ("when the primary database drops at 03:00 on a Sunday"), and named products. That register is the basis of Rule 1.

## Convergence, hardest genre

Scope/deliverables document, the most list-shaped format: 0.3022 → 0.1371 → **0.0552**.

## The API truncates its input

A single score on a long document reflects only its opening.

- Prefixes of 450, 600, 750, 900, 1000, 1500 and 1900 words, plus the full 2,264-word document, all returned **exactly 0.6191**. A 300-word prefix returned 0.3499.
- Rewriting the final sentence left the score bit-identical; changing one word in the H1 moved it to 0.8389.
- Independently: a 2,218-word file scored 0.0076 and its first 350 words also scored 0.0076.

The cut-off sits somewhere between 300 and 450 words. Consequences: the corpus baseline table above is effectively a table of *prefix* scores; edits past the opening cannot move the headline number; and a long document that passes has had only its first page judged.

Window measurements are unaffected, because each 350-word block was submitted as its own request and so fell inside the scored range. This also means any experiment whose variable sat near word 450 was confounded by the boundary. The retracted blockquote result below is exactly that failure.

Which results survive: everything measured at or under ~500 words, which is all of the judgement, move-variety, list-versus-prose, genre and topic tables above. What does not survive as whole-document evidence: the 11-post corpus baseline, and post 9's 0.0068, which describe openings only.

**Why this matters for writing rather than testing:** it is the reason Rule 2 exists. The opening is what gets judged, by machines and by readers, so it earns disproportionate effort.

## Corpus run: what worked and what did not

Ten posts rewritten against the live API, one agent each.

| Post | Before | After | Status |
|---|---|---|---|
| 1 quiet-shift | 1.0000 | **0.0021** | passed, 1 iteration |
| 3 great-decoupling-part2 | 1.0000 | **0.0002** | passed, 2 iterations |
| 8 sdd-update | 1.0000 | **0.0010** | passed, 3 iterations |
| 5 spec-driven-development | 1.0000 | **0.0204** | passed, 4 iterations |
| 11 naas-the-glue | 0.7290 | **0.0206** | passed, 2 iterations |
| 10 two-worlds-microsegmentation | 0.9658 | **0.0640** | passed, 4 iterations |
| 2 great-decoupling-part1 | 1.0000 | 0.3125 | plateaued, final draft unverified |
| 7 things-you-arent-being-told | 1.0000 | 0.4761 | plateaued, final draft unverified |
| 4 integration-is-architecture | 1.0000 | 0.4834 | plateaued, final draft unverified |
| 6 evaluation-framework | 0.7290 | 0.6191 | plateaued, final draft unverified |
| 9 sdd-for-enterprise | 0.0068 | , | already passing, untouched |

Six of ten cleared 0.10; four plateaued between 0.31 and 0.62 when credits ran out. Judgement reliably takes 1.0 to roughly 0.5 on the first pass. Whether it goes the rest of the way is not yet predictable, and all four that stalled are long argument-structured pieces.

**Opening style, measured head-to-head.** Because the API only reads the opening, one post's drafts became a direct A/B on opening shape: a staccato, verdict-per-paragraph opening scored **0.4761** while a smoothed, merged-sentence version of the same content scored **0.7241**. Short declarative verdicts beat flowing prose in the scored zone, which is the opposite of the prose-over-bullets rule that governs the rest of the document.

**Uniform failure with no hotspot is real.** One draft's window scan returned 0.9902 / 0.9951 / 0.9951 / 0.9219 / 1.0000 / 0.9731, every window hot. There was nothing to localise; only added judgement moved it.

### Confirmations from the run

- **Removing judgement to create variety backfires badly.** Stripping wry closers from an opening: 0.1025 → 0.9634. Flattening a section with one zinger per paragraph: 0.4834 → 0.8828. Varying the *kind* of attitude instead: 0.3874 → 0.3125.
- **Flattening paragraph endings helps only when already low.** One piece went 0.18 → 0.02 that way.
- **Blockquoting punchlines , RETRACTED, not confirmed.** Moving punchlines into `>` blocks measured 0.3125 → 0.7656, but the first blockquote fell at word ~430, on the truncation boundary, and a transition sentence in the same region was reworded in the same pass. The two variables cannot be separated. The corpus's best-scoring document uses twelve blockquotes. Needs a single-variable re-test.
- **A hot window inside a clean document can be ignored.** A shipped piece scoring 0.0204 contains a window at 1.0000; every attempt to fix it made the whole worse.
- **Aphoristic passages flag; dense technical passages do not.** In the longest post, the clean blocks (0.000 to 0.04) were Kubernetes/CNI, address collisions, SCIM certificates and PLCs; the flagged blocks were the framing and conclusion, built from stacked antithesis couplets used ~25 times.
- **Markdown stripping is weaker than measured.** The 0.0068 document keeps headers, bullets and blockquotes.
- **Length inflates 30 to 40%.** Bodies grew 1,678 → 2,242 and 1,064 → 1,414.

## Endpoint notes

Endpoint used for the experiments: `POST https://text.api.pangramlabs.com/`, header `x-api-key`, body `{"text": "..."}`, returning `ai_likelihood`, `prediction` and `llm_prediction`. No segment-level output exists. `return_segments`, `detailed`, `segments`, `return_sentence_scores` and `mode` were all accepted and ignored, which is why windowing had to be done client-side. Recorded here only so the measurements can be reproduced; the skill does not call it.
