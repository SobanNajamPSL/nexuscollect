# Archive

Nothing here is needed to run, build, test or understand the platform. It is kept
because it is the provenance record of how the thing came to exist, and deleting it
would lose something real — but it is dead, and it should not be read as current.

If you are looking for how the platform works, you want
[`docs/`](../docs/) and [`spec/`](../spec/).

| | What it is | Why it is dead |
|---|---|---|
| [`PROMPTS.md`](PROMPTS.md) | The eight phase prompts the build was worked through, one at a time, plus their acceptance gates. | The build is complete and every gate passed. Code comments still cite it where a design decision traces back to a specific prompt — those references are historical, not instructions. |
| [`UI-BRIEF.md`](UI-BRIEF.md) | The design brief handed to Claude Design, describing six screens for a government audience. | Superseded by the product. The brief describes a single-window application with six screens; the build is four separate portals with thirty-four. |
| [`ui-prototype/`](ui-prototype/) | The prototype Claude Design returned against that brief, plus the original zip. Validated at the time against `demo-data/` — every PSID and amount in it traced to a real row. | It prototypes screens that no longer exist. It was also never buildable as source: a proprietary browser-interpreted template runtime, not React + Vite + Tailwind, so it was always a reference rather than an ancestor of `web/`. |

## The one thing worth knowing about the prototype

It was validated, and four content bugs were found in it and recorded rather than
fixed: three fabricated receipt numbers, three control assertions hardcoded to pass,
a break-severity tone that was defined but never applied, and a header total that
disagreed with the brief it was built from. All four were fixed properly in the real
implementation. That history is the reason the current build asserts its figures
against `demo-data/expected-results.json` instead of trusting that they look right.
