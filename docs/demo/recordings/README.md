# Recordings

**The video files are not in git.** They are regenerated from
[`../../../scripts/record-demo.ts`](../../../scripts/record-demo.ts), which is
committed and is the authoritative version of the demonstration — the narration lives
in that script, so the film can always be rebuilt from it.

That is a deliberate choice rather than an oversight. The film is 27 MB and was
re-recorded three times while it was being got right; each pass added its full weight
to git history, and the repository was becoming several times heavier than the thing
it demonstrates. A voiceover pass will re-record it again.

## Getting the films

If they are not on your disk, with the API and the four portals running (see the root
[`README.md`](../../../README.md)):

```bash
npx tsx scripts/record-demo.ts        # ~35 min unattended, film + nine beat clips
bash scripts/convert-recordings.sh    # WebM → H.264 MP4
```

The result is deterministic — the database is reset before each take and the clock is
pinned — so a rebuild produces the same figures on the same screens as the original.

Otherwise ask whoever recorded them last; they are shared directly rather than through
the repository.

## What there is

| File | Length |
|---|---|
| `nexuscollect-full-demonstration.mp4` | ~12m 45s — the whole arc |
| `beat-00-cold-open.mp4` … `beat-08-prove-it.mp4` | 35s–2m 33s each |

[`../SHOT-LIST.md`](../SHOT-LIST.md) describes every beat and its narration verbatim,
so the content is documented in the repository even when the video is not.
