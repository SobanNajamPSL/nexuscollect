/**
 * Lay the recorded narration onto the finished videos.
 *
 * `record-demo.ts` writes `timings.json` on every real take — where each caption
 * actually appeared, in milliseconds from the start of that recording. This places
 * each line's audio at its caption's offset, so the words land with the picture
 * rather than near it.
 *
 * Each video is treated independently, because the offsets in a standalone beat clip
 * are relative to that clip while the film's are relative to the film. The same line
 * therefore appears at two different timestamps, which is exactly why this reads the
 * timings rather than assuming anything.
 *
 *   npx tsx scripts/mux-narration.ts            every video that has narration
 *   npx tsx scripts/mux-narration.ts --film     the continuous film only
 */
import { execFile } from "node:child_process";
import { readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const NARRATION = join(__dirname, "..", "docs", "demo", "narration");
const RECORDINGS = join(__dirname, "..", "docs", "demo", "recordings");
const FILM = "nexuscollect-full-demonstration";

const filmOnly = process.argv.includes("--film");

interface Timing {
  beat: string;
  index: number;
  title: string;
  startedAtMs?: number;
}

/** The lead-in the recorder allows before a caption's narration begins. */
const LEAD_MS = 350;

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function key(t: Timing): string {
  return `${t.beat}/${String(t.index).padStart(2, "0")}`;
}

/**
 * Build one narration track and mux it in.
 *
 * `adelay` per line then `amix` to combine: simpler and more robust than
 * concatenating with computed silence, because a line that overruns its caption
 * overlaps the next rather than shunting everything after it out of sync.
 */
async function narrate(video: string, lines: Timing[], audioFiles: Record<string, string>): Promise<boolean> {
  const usable = lines.filter((l) => l.startedAtMs !== undefined && audioFiles[key(l)]);
  if (usable.length === 0) return false;

  const inputs: string[] = ["-nostdin", "-loglevel", "error", "-y", "-i", video];
  for (const line of usable) inputs.push("-i", audioFiles[key(line)]!);

  const delays = usable
    .map((line, i) => `[${i + 1}:a]adelay=${Math.max(0, (line.startedAtMs ?? 0) + LEAD_MS)}:all=1[a${i}]`)
    .join(";");
  const mix = `${usable.map((_, i) => `[a${i}]`).join("")}amix=inputs=${usable.length}:normalize=0[out]`;

  const out = `${video.replace(/\.(mp4|webm)$/, "")}.narrated.mp4`;
  await run("ffmpeg", [
    ...inputs,
    "-filter_complex", `${delays};${mix}`,
    "-map", "0:v", "-map", "[out]",
    // Re-encoding the video would cost quality for nothing; only the audio is new.
    "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest",
    out,
  ]);

  // Replace the silent version, keeping the name the documentation refers to.
  await unlink(video).catch(() => undefined);
  await rename(out, video);
  return true;
}

async function main(): Promise<void> {
  const timings = JSON.parse(await readFile(join(NARRATION, "timings.json"), "utf8").catch(() => "[]")) as Timing[];
  const audioFiles = JSON.parse(await readFile(join(NARRATION, "audio-files.json"), "utf8").catch(() => "{}")) as Record<string, string>;

  if (timings.length === 0) {
    process.stderr.write("No timings.json — record the film first (npx tsx scripts/record-demo.ts).\n");
    process.exitCode = 1;
    return;
  }
  if (Object.keys(audioFiles).length === 0) {
    process.stderr.write("No measured narration — run npx tsx scripts/measure-narration.ts first.\n");
    process.exitCode = 1;
    return;
  }

  // A film run records every beat in one pass; a `--only` run records just one.
  const isFilmRun = new Set(timings.map((t) => t.beat)).size > 1;
  let done = 0;

  if (isFilmRun) {
    const video = join(RECORDINGS, `${FILM}.mp4`);
    if (await exists(video)) {
      process.stdout.write(`${FILM}\n`);
      if (await narrate(video, timings, audioFiles)) done += 1;
    }
  }

  if (!filmOnly) {
    const byBeat = new Map<string, Timing[]>();
    for (const t of timings) byBeat.set(t.beat, [...(byBeat.get(t.beat) ?? []), t]);

    for (const [beat, lines] of byBeat) {
      const video = join(RECORDINGS, `beat-${beat}.mp4`);
      if (!(await exists(video))) continue;
      // Only a run that recorded this beat on its own has offsets relative to it.
      if (isFilmRun) continue;
      process.stdout.write(`beat-${beat}\n`);
      if (await narrate(video, lines, audioFiles)) done += 1;
    }
  }

  process.stdout.write(
    done > 0
      ? `\n${done} video${done === 1 ? "" : "s"} narrated.\n`
      : "\nNothing to do. Beat clips need their own recording pass (--beats) so their\ncaption offsets are relative to the clip rather than to the film.\n",
  );
}

await main();
