// Replays the actual frontend detector; no second implementation of its geometry or state machine.
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/handSwipe.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { HandSwipeTracker, handSample } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { samples, verifyProfile } = JSON.parse(input);

function resample(frames, hz) {
  if (hz === 15) return frames;
  const result = [];
  let next = frames[0]?.time ?? 0;
  for (const frame of frames) {
    if (frame.time < next) continue;
    result.push(frame);
    next += (Math.floor((frame.time - next) / (1000 / hz)) + 1) * 1000 / hz;
  }
  return result;
}
const clips = samples.map(sample => ({
  id: sample.id, label: sample.label,
  frames: sample.frames.map(frame => ({
    time: frame.timestamp_ms,
    value: handSample(frame.landmarks, frame.world_landmarks ?? [], frame.hand, frame.timestamp_ms, frame.confidence),
  })),
}));
function replay(frames, parameters) {
  const tracker = new HandSwipeTracker(parameters);
  const events = [];
  for (const frame of frames) {
    const direction = tracker.update(frame.value);
    if (direction) events.push({ direction, time_ms: Math.round(frame.time) });
  }
  return events;
}
function metrics(clip, parameters, hz) {
  const events = replay(resample(clip.frames, hz), parameters);
  return { id: clip.id, label: clip.label, hz, events,
    matched: clip.label === "idle" ? events.length === 0 : events.some(event => event.direction === clip.label),
    correct: events.filter(event => event.direction === clip.label).length,
    opposite: events.filter(event => event.direction !== clip.label).length };
}

// Derived controls are artificial negatives, not user-recorded idle examples.
const controls = [];
for (const clip of clips) {
  const anchor = clip.frames.find(frame => frame.value)?.value;
  if (!anchor) continue;
  for (const kind of ["hold", "jitter", "horizontal", "slow-drift"]) {
    const frames = Array.from({ length: 100 }, (_, index) => {
      const time = index * 1000 / 12;
      const dx = kind === "horizontal" ? Math.sin(index * 0.12) * 0.22
        : kind === "jitter" ? Math.sin(index * 2.3) * 0.008 : 0;
      const dy = kind === "slow-drift" ? index * -0.0015
        : kind === "jitter" ? Math.cos(index * 1.7) * 0.01 : 0;
      return { time, value: { ...anchor, time, x: anchor.x + dx, y: anchor.y + dy,
        tipX: anchor.tipX + dx, tipY: anchor.tipY + dy } };
    });
    controls.push({ id: clip.id, name: `${clip.id.slice(0, 8)}:${kind}`, frames });
  }
}

function evaluate(parameters) {
  return { parameters, rows: clips.flatMap(clip => [12, 15].map(hz => metrics(clip, parameters, hz))),
    negatives: controls.map(control => ({ id: control.id, events: replay(control.frames, parameters).length })) };
}
function score(candidate, excludedId) {
  const rows = candidate.rows.filter(row => row.id !== excludedId);
  return rows.reduce((sum, row) => sum + (row.matched ? 100 : 0) - row.opposite * 160, 0)
    - candidate.negatives.filter(row => row.id !== excludedId).reduce((sum, row) => sum + row.events * 200, 0);
}
function conservative(candidate) {
  const p = candidate.parameters;
  return p.travelPalmSizes + p.minTravel * 3 + p.minSpeed * 0.7 + p.normalThreshold * 0.25;
}
function select(candidates, excludedId) {
  return candidates.reduce((best, candidate) => {
    const a = score(candidate, excludedId), b = score(best, excludedId);
    return a > b || (a === b && conservative(candidate) > conservative(best)) ? candidate : best;
  });
}
function summary(rows) {
  return { clip_rate_combinations: rows.length,
    matched_without_opposite: rows.filter(row => row.matched && row.opposite === 0).length,
    missed: rows.filter(row => !row.matched).length,
    opposite_events: rows.reduce((sum, row) => sum + row.opposite, 0) };
}
let result;
if (verifyProfile) {
  const chosen = evaluate(verifyProfile);
  result = { summary: summary(chosen.rows), rows: chosen.rows, artificial_negative_cases: controls.length,
    artificial_negative_events: chosen.negatives.reduce((sum, row) => sum + row.events, 0) };
} else {
  const candidates = [];
  for (const normalThreshold of [0.3, 0.4, 0.5])
    for (const travelPalmSizes of [0.4, 0.5, 0.6, 0.7])
      for (const minTravel of [0.055, 0.07, 0.085])
        for (const minSpeed of [0.25, 0.35, 0.45])
          candidates.push(evaluate({ normalThreshold, travelPalmSizes, minTravel, minSpeed,
            minDurationMs: 140, windowMs: 650, cooldownMs: 550, rearmFraction: 0.4 }));
  const chosen = select(candidates);
  const heldOut = clips.flatMap(clip => {
    const fit = select(candidates, clip.id);
    return fit.rows.filter(row => row.id === clip.id).map(row => ({ ...row, parameters: fit.parameters }));
  });
  result = { parameters: chosen.parameters, candidates: candidates.length,
    fitted: summary(chosen.rows), leave_one_clip_out: summary(heldOut), rows: chosen.rows, held_out_rows: heldOut,
    artificial_negative_cases: controls.length,
    artificial_negative_events: chosen.negatives.reduce((sum, row) => sum + row.events, 0) };
}
process.stdout.write(JSON.stringify(result));
