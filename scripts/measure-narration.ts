/**
 * Take the recorded narration and work out how long each line runs for.
 *
 * The output — `docs/demo/narration/durations.json` — is what makes the film hold
 * each caption for exactly as long as its narration instead of estimating from word
 * count. Getting that the wrong way round is what makes a voiceover drift out of
 * step with the picture.
 *
 * Two ways to supply audio, because reading fifty-two separate files is miserable:
 *
 *   audio/<beat>.wav        one take for the whole beat, split here on the pauses
 *   audio/<beat>/01.wav     or one file per line, already separated
 *
 * Per-line files always win where they exist, so a single line that came out badly
 * can be re-recorded on its own without redoing the beat.
 *
 *   npx tsx scripts/measure-narration.ts
 *   npx tsx scripts/measure-narration.ts --silence=-32dB --gap=0.7
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const NARRATION = join(__dirname, "..", "docs", "demo", "narration");
const AUDIO = join(NARRATION, "audio");
const SPLIT = join(AUDIO, "split");

/**
 * What counts as a pause between lines.
 *
 * A person reading a script leaves a beat between paragraphs, and that beat is the
 * only signal available for where one line ends and the next begins. The defaults
 * are deliberately forgiving: -35 dB catches room tone rather than requiring true
 * digital silence, and 0.6 s is short enough to catch a brisk reader without
 * splitting on the pause inside "PKR 16,500 — delivered to the payer's phone".
 */
const noiseFloor = process.argv.find((a) => a.startsWith("--silence="))?.slice("--silence=".length) ?? "-35dB";
const minGap = process.argv.find((a) => a.startsWith("--gap="))?.slice("--gap=".length) ?? "0.6";

interface NarrationLine {
  beat: string;
  index: number;
  title: string;
  words: number;
}

async function durationOf(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Math.round(Number(stdout.trim()) * 1000);
}

/** Where speech starts and stops in a single take, derived from the silences between. */
async function speechSpans(file: string): Promise<{ start: number; end: number }[]> {
  const total = await durationOf(file);
  // ffmpeg reports silences on stderr; the spans between them are the lines.
  const { stderr } = await run("ffmpeg", [
    "-nostdin", "-i", file, "-af", `silencedetect=noise=${noiseFloor}:d=${minGap}`, "-f", "null", "-",
  ]).catch((err: { stderr?: string }) => ({ stderr: err.stderr ?? "" }));

  const silences: { start: number; end: number }[] = [];
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
  for (let i = 0; i < starts.length; i += 1) silences.push({ start: starts[i]!, end: ends[i] ?? total });

  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start > cursor) spans.push({ start: cursor, end: silence.start });
    cursor = silence.end;
  }
  if (cursor < total) spans.push({ start: cursor, end: total });

  // Anything under a second is a cough, a page turn or a false start, not a line.
  return spans.filter((s) => s.end - s.start >= 1_000);
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const path of candidates) {
    try {
      await readFile(path);
      return path;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const manifestPath = join(NARRATION, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "")) as NarrationLine[] | "";
  if (!manifest || manifest.length === 0) {
    process.stderr.write("No manifest. Run: npx tsx scripts/record-demo.ts --dry --film --manifest\n");
    process.exitCode = 1;
    return;
  }

  const byBeat = new Map<string, NarrationLine[]>();
  for (const line of manifest) byBeat.set(line.beat, [...(byBeat.get(line.beat) ?? []), line]);

  await mkdir(SPLIT, { recursive: true });
  const durations: Record<string, number> = {};
  const files: Record<string, string> = {};
  const problems: string[] = [];
  let measured = 0;

  for (const [beat, lines] of byBeat) {
    // Per-line files first: a single retaken line should not need the beat redone.
    const perLine: (string | null)[] = await Promise.all(
      lines.map((line) =>
        firstExisting(["wav", "aiff", "aif", "m4a", "mp3"].map((ext) => join(AUDIO, beat, `${String(line.index).padStart(2, "0")}.${ext}`))),
      ),
    );

    if (perLine.every((f) => f !== null)) {
      for (const [i, file] of perLine.entries()) {
        const key = `${beat}/${String(lines[i]!.index).padStart(2, "0")}`;
        durations[key] = await durationOf(file!);
        files[key] = file!;
        measured += 1;
      }
      process.stdout.write(`${beat}: ${lines.length} per-line files\n`);
      continue;
    }

    const whole = await firstExisting(["wav", "aiff", "aif", "m4a", "mp3"].map((ext) => join(AUDIO, `${beat}.${ext}`)));
    if (!whole) {
      const partial = perLine.filter((f) => f !== null).length;
      problems.push(`${beat}: no audio yet${partial > 0 ? ` (${partial} of ${lines.length} lines present)` : ""}`);
      continue;
    }

    const spans = await speechSpans(whole);
    if (spans.length !== lines.length) {
      // Refuse to guess. A mismatch means the split is wrong, and silently mapping
      // eleven spans onto ten lines would put the wrong words under the wrong screen.
      problems.push(
        `${beat}: found ${spans.length} spoken passage${spans.length === 1 ? "" : "s"} but the beat has ${lines.length} lines. ` +
          `Try --gap=0.4 or --silence=-30dB, leave longer pauses, or supply audio/${beat}/NN.wav per line.`,
      );
      continue;
    }

    for (const [i, span] of spans.entries()) {
      const line = lines[i]!;
      const key = `${beat}/${String(line.index).padStart(2, "0")}`;
      const out = join(SPLIT, `${beat}-${String(line.index).padStart(2, "0")}.wav`);
      await run("ffmpeg", [
        "-nostdin", "-loglevel", "error", "-y", "-i", whole,
        "-ss", String(span.start / 1000), "-to", String(span.end / 1000),
        "-ac", "1", "-ar", "48000", out,
      ]);
      durations[key] = span.end - span.start;
      files[key] = out;
      measured += 1;
    }
    process.stdout.write(`${beat}: split one take into ${spans.length} lines\n`);
  }

  await writeFile(join(NARRATION, "durations.json"), `${JSON.stringify(durations, null, 2)}\n`, "utf8");
  await writeFile(join(NARRATION, "audio-files.json"), `${JSON.stringify(files, null, 2)}\n`, "utf8");

  const spoken = Object.values(durations).reduce((a, b) => a + b, 0);
  process.stdout.write(`\n${measured} of ${manifest.length} lines measured — ${Math.floor(spoken / 60000)}m ${Math.round((spoken % 60000) / 1000)}s of speech.\n`);

  if (problems.length > 0) {
    process.stdout.write(`\nStill to do:\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
    process.stdout.write(`\nA partly-narrated film is fine — any line without audio falls back to its\nword-count estimate, so you can record a beat at a time.\n`);
  } else {
    process.stdout.write(`\nAll lines measured. Next:\n  npx tsx scripts/record-demo.ts\n  npx tsx scripts/mux-narration.ts\n`);
  }
}

await main();
