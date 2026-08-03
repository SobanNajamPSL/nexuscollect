# Documentation

| | |
|---|---|
| [`manual/`](manual/) | **Start here.** What the platform does and how each of the four portals is used, written for somebody who has not seen it before. One chapter per portal, with captured screenshots. |
| [`demo/`](demo/) | The recorded demonstration: the shot list, the narration recording sheets, what the demonstration deliberately does not show, and the films themselves. |
| [`runbooks/`](runbooks/) | Twelve operational runbooks — one per failure mode the platform is expected to survive, from a rail outage to a rejected treasury scroll. |

Two things live outside this directory on purpose:

- [`../spec/`](../spec/) — the normative specification and the OpenAPI contract. Cited
  by section number throughout the code, so it is a first-class part of the repository
  rather than documentation about it.
- [`../archive/`](../archive/) — the phase prompts, the original design brief and the
  reference prototype. Provenance, not documentation. Nothing there is current.

## If you have ten minutes

Read the core ideas in [`manual/00-concepts.md`](manual/00-concepts.md), then look at
two screens: the [agency's collection position](manual/03-agency-portal.md#collection-position)
for what the platform is *for*, and the
[control assertions](manual/04-operator-portal.md#control-assertions) for why its
figures can be believed.
