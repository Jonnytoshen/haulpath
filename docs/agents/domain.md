# Domain Docs

This repo uses a single-context domain documentation layout.

## Before exploring, read these

- `GLOSSARY.md` at the repo root.
- ADRs in `docs/adr/` relevant to the area being explored.

If these files do not exist, proceed silently. Do not flag
their absence or suggest creating them upfront.
The `/domain-modeling` skill creates them lazily when
terms or decisions actually get resolved.

## File structure

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/`: architecture decision records.

## Use the glossary's vocabulary

When naming a domain concept in an issue title, refactor
proposal, hypothesis, or test name, use the term defined
in `GLOSSARY.md`. Avoid synonyms the glossary rejects.

If a needed concept is missing, reconsider whether the
language belongs in the project or note a real vocabulary
gap for `/domain-modeling`.

## Flag ADR conflicts

Explicitly surface any proposal that contradicts an
existing ADR, identifying the decision and explaining
why it should be reconsidered.
