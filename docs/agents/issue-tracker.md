# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`.
- Implementation issues are separate files at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,
  numbered from `01`, never a single combined tickets file.
- Comments and conversation history append to the bottom
  of the file under a `## Comments` heading.

## When a skill says "publish to the issue tracker"

Create the appropriate spec or issue file under
`.scratch/<feature-slug>/`, creating directories if needed.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. When given only an
issue number, resolve it within the relevant feature directory.

## Wayfinding operations

Used by `/wayfinder`. The map is a file with one child file
per ticket.

- Map: `.scratch/<effort>/map.md`, containing Notes,
  Decisions-so-far, and Fog.
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md`,
  numbered from `01`, with the question in the body.
  A `Type:` line records `research`, `prototype`,
  `grilling`, or `task`. A `Status:` line records
  `claimed` or `resolved` when applicable.
- Blocking: a `Blocked by: NN, NN` line near the top.
  A ticket is unblocked when every listed ticket is resolved.
- Frontier: scan for open, unblocked, unclaimed tickets;
  the lowest number wins.
- Claim: set `Status: claimed` and save before any work.
- Resolve: append the answer under `## Answer`, set
  `Status: resolved`, and append a context pointer
  (gist and link) to Decisions-so-far in the map.
