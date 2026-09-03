---
name: humanize
description: Draft and rewrite prose in a human voice without machine-generated patterns.
---

# Humanize

Write so a person is visibly in the text. No tooling and no scoring. The rules below were derived from measured experiments against a detector, and the measurements are in `reference/findings.md` if you want the evidence. Follow them while drafting; do not write normally and clean up afterwards, because that does not work.

## Why default output fails

Competent assistant prose is detected outright, at the maximum score. Not borderline. Maximum. It fails because it is **relentlessly informative and even-handed**: it explains, it qualifies, it presents tradeoffs fairly, and every sentence carries useful content. That evenness is the signature. A machine wrote it because only a machine is that consistently reasonable.

Structural remedies do almost nothing. Measured on one piece, holding facts constant: varying sentence shapes left it at 0.9976 out of 1, reframing as first-person narrative 0.9854, adding concrete specifics 0.9658, injecting digressions 1.0000. Rewriting it with a point of view took it to 0.0154.

So the whole method is: **put a person in the text and keep them there.**

## Rule 1: judge, do not explain

Every few paragraphs, stop informing and deliver a verdict. Be rude about what deserves it. This is the entire ballgame; everything below is secondary.

| Instead of | Write |
|---|---|
| "Rule estates can become difficult to maintain over time." | "That is what a rule estate becomes if you leave it alone. A landfill with a change process." |
| "Static rules may not anticipate novel attack sequences." | "If your security depends on somebody having anticipated that precise ordering, the security is decorative." |
| "Explainability presents challenges for stakeholder communication." | "'The model said so' does not survive contact with a steering committee." |
| "This approach ensures alignment across teams." | Delete it. It says nothing and it is written in the detected register. |

**Add clauses that carry attitude rather than information.** "…generated on demand, by a machine, at three in the morning, for free." The last three beats add no facts. That is the point. A person bothered to be annoyed.

**Name costs in human terms.** Not "adoption friction" but "a partner who has never been told no by a computer."

**Let throwaway detail be absurdly specific.** Not "an old firewall rule" but "written in 2019, for a scraper that stopped existing in 2021, by somebody who left in 2022."

### Never strip judgement to create variety

The commonest way to ruin a good draft. Three independent rewrites made this mistake and measured it: removing wry closers from an opening sent it 0.10 → 0.96; flattening a section whose every paragraph ended on a verdict sent the document 0.48 → 0.88; flattening three section endings, 0.48 → 0.72.

If the attitude feels repetitive, **vary its form, never its presence**: verdict, contempt, understatement, refusal, a dry aside, a cost named in human terms, a flat admission of not knowing. Move it around inside the paragraph instead of always landing it last.

The one safe version: once a piece is already strong, a few paragraphs may end flat and factual. That is different from removing the opinion.

## Rule 2: the opening carries the piece

Readers and detectors both judge on the first 400 words or so. Write them last if you have to, but make them the strongest thing you have.

In that opening zone, favour **short declarative verdicts, roughly one per paragraph**. Measured head to head, a staccato verdict-per-paragraph opening beat the same content smoothed into flowing sentences, 0.4761 against 0.7241.

Note this inverts Rule 4 below. Punchy and clipped at the top; prose further down.

Open on something situated: a moment, a decision, a specific failure. Never open on a thesis about a category ("The era of the static security rule is ending"). That framing is the single most detected genre there is.

## Rule 3: never reuse a rhetorical move

A move is a sentence-shape: "It is not about X, it is about Y." "Where people get this wrong is Z." "The old model was P." Any one of them reads as human. The second and third use is what convicts you.

Three paragraphs each individually clean scored 0.9854 together, purely because two of them ran the same negation-correction shape. Rewriting those two, same content and length, dropped it to 0.0535.

Watch especially for the antithesis couplet, as in "Detection tells you X. Containment decides Y." One long piece used that shape about 25 times, and its clean blocks were the dense technical passages while every flagged block was aphoristic.

## Rule 4: prose beats lists

Lists force parallel structure, which is repetition by construction. Identical content scored 0.302 as uniform bullets, 0.142 as deliberately uneven bullets, 0.055 as flowing prose.

This applies to lists in disguise too: consecutive paragraphs that each open with a bolded label, or four paragraphs that all run "Noun phrase. Elaboration."

When a list is genuinely right, make the items structurally unlike each other. One three words long, one running two sentences.

## Rule 5: specifics, always

Names, figures, dates, vendors, places, times of day. "Discovery takes three weeks, longer if the Frankfurt estate is undocumented" is human. "Discovery is conducted over a multi-week period" is not.

Specificity alone is not sufficient, since a specifics-only rewrite still measured 0.9658, but judgement needs something concrete to bite on, and vague judgement reads as bluster.

## What not to do

**Do not lay on the tricks.** Rhetorical questions, sentence fragments, one-line paragraphs and punchy asides are a recognisable style in their own right, and detectors model humanised output as its own category. Piling them on measured 0.1812 → 0.2409, the wrong direction. Restraint outperforms effort.

**Typos and dropped apostrophes do nothing.** Messages written with deliberate misspellings still scored as AI. Surface noise is not the signal.

**Digression does not help.** Adding tangents, restatement and filler to a failing draft made it worse, 0.9976 → 1.0000. Slack is not the same as attitude.

**Flat and dry is fine in places.** A plain technical passage with no voice at all measured 0.0001. Dense, concrete, specific writing is safe. It is the *aphoristic* register that gets flagged when it repeats.

**Expect the piece to run 30 to 40% longer.** Attitude clauses add words without adding information; that is the mechanism, not a defect. If length must come down, cut informational sentences, not attitude-bearing ones.

## Register calibration

The target is not "casual". It is a specialist who has done the work and has opinions about it. These are real sentences from a piece that passed cleanly, by an author writing about his own systems:

> Because explaining to the board that your production database password is now a suggested autocomplete on a public language model is not a career-enhancing move.

> Enterprise development cannot grind to a halt because an AI provider is having a bad Tuesday.

> When the primary database drops at 03:00 on a Sunday, "The AI did it" is not going to hold up as a valid incident response strategy.

> If you give an autonomous agent unverified write access to Jira, it will eventually hallucinate a catastrophic production outage, page your entire on-call rotation at 4 AM, and then attempt to push a change to fix a bug that does not exist.

> If you cannot read the HR repository, neither can your coding agent.

Note what these do: a named consequence with a time attached, a cost expressed as something happening to a person, and a verdict the author is willing to own. None is decorative. Note also that the piece they come from keeps its headers, bullets and blockquotes. The register is doing the work, not the formatting.

## Surface tells: secondary, but cheap

These matter far less than Rule 1, and fixing them is not a substitute for it. A draft scrubbed of every item below still measured 0.9976. Clean them anyway, because readers notice even when detectors do not.

**AI vocabulary.** Replace on sight: delve, landscape (as metaphor), tapestry, realm, paradigm, embark, testament to, robust, comprehensive, cutting-edge, leverage (verb), pivotal, underscore, meticulous, seamless, game-changer, utilize, watershed moment, intricate, showcase, foster, garner, vibrant, crucial, key (as adjective). Two or more in a paragraph is a strong signal even when each is defensible alone.

**Copula avoidance.** "Serves as", "stands as", "represents", "boasts", "features" where "is" or "has" would do. Say "Gallery 825 is the exhibition space", not "serves as".

**Synonym cycling.** Repetition-penalty artefacts: the protagonist / the main character / the central figure / the hero, all in four consecutive sentences. Pick one name and reuse it. Humans repeat words.

**False ranges.** "From the singularity of the Big Bang to the grand cosmic web". X and Y are not endpoints of any real scale. State what is actually covered.

**Aphorism formulas.** "X is the language of Y", "the currency of", "the architecture of", "X is not a tool but a mirror". This one is more than cosmetic: in the longest piece measured, every flagged block was aphoristic while the dense technical blocks scored near zero. Replace the formula with the concrete claim it gestures at.

**Manufactured staccato.** A run of short fragments engineered into drama, as in "It had no preference for symmetry. No aesthetic prior. No nostalgia for human taste." One short sentence for emphasis is fine; a stack of them reads as machinery. This is the same failure as over-applying the tricks, above.

**Hedging, filler and servility.** "It is worth noting that", "it is important to remember", "arguably", "some might say", knowledge-cutoff disclaimers, "Great question", "Let's dive in", and generic uplifting conclusions.

**Passive and subjectless constructions.** "The results are preserved automatically" → "the system preserves the results". Name who does the thing.

**Em dashes: never use one.** Not a preference to weigh, a hard rule. No em dashes, no en dashes used as sentence punctuation, and no spaced-hyphen substitutes standing in for the same move.

Recast the sentence instead of swapping in another mark. A comma, a full stop, a colon or a pair of brackets will each carry a different one of the jobs an em dash was doing, and picking the right one usually improves the sentence. If a dash felt necessary, the sentence was probably doing two things at once and wants splitting.

This rule is the author's standing preference and it stands on its own. It is not a detection lever, and the skill should not claim otherwise: one post with 78 em dashes and one with none both measured above 0.96, and the best-scoring piece in the corpus also had none. Follow the rule because it is the house style, not because a classifier cares.

*This section condenses the MIT-licensed `humanizer` and `avoid-ai-writing` skills, which it replaces; both were removed from the roster on 7 August 2026 and remain available upstream if the fuller pattern lists are ever wanted. What they lacked was the finding that none of it outranks having a point of view, and their advice to cut em dashes was kept here as house style rather than as the detection rule they believed it to be.*

## Self-check before delivering

Read the draft back against these. Each is answerable by reading, and each maps to a measured failure.

1. **Column-read your paragraph openings.** Any two sharing a shape? Rewrite one.
2. **Find a paragraph that delivers no verdict, only information.** If most paragraphs are like that, the draft fails. Go back to Rule 1.
3. **Count the sentences you could delete without losing a fact.** If the answer is zero, there is no person in the text.
4. **Look at the first 400 words alone.** Do they open on a situation, and do they contain several short verdicts? If they open on a thesis about a category, rewrite them.
5. **Find every tricolon**, such as "practical, prioritised and achievable". Kill them; leave two items or four.
6. **Check paragraph lengths.** If they all sit within a narrow band, split one and merge two.
7. **Find any list.** Can it be prose? If not, are the items structurally different from each other?
8. **Look for participial closers** ("enabling teams to…", "ensuring alignment…", "allowing you to…"). These are the strongest single marker of the detected register. Delete every one.
8b. **Search the draft for em dashes, en dashes and spaced hyphens.** The count must be zero. Recast each sentence rather than substituting another mark.
9. **Is there a sentence a vendor or a colleague would be annoyed to read?** If not, the draft is too safe to read as human.
10. **Is any passage explaining a concept in the abstract**, unanchored to a specific situation, system or decision? Anchor it or cut it.

## Honesty constraint

Rules 1 and 5 pull toward invented detail, and that is a real hazard when the writing belongs to someone. When rewriting a person's actual work (a proposal, a published post, a client message), do not fabricate events, figures, attributions or anecdotes.

Reach for **judgement ahead of invented fact**: an opinion cannot be false, and it moves the needle harder than a made-up number does. Use specifics already present in the source. If you do introduce a concrete detail that is not in the original, list it explicitly when you hand the work back so the author can verify or cut it.

The strongest version of this method is applied by the author to their own material, because then the judgement and the specifics are simply true.
