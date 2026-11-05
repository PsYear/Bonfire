import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/handSwipe.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { HandSwipeTracker } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function harness() {
  const tracker = new HandSwipeTracker();
  const gestures = [];
  let time = 0;
  const sample = (x, y, hand = "Right", size = 0.14) => {
    time += 80;
    const swipe = tracker.update({ x, y, hand, size, time });
    if (swipe) gestures.push(swipe);
  };
  const hold = (y, count = 5) => { for (let i = 0; i < count; i++) sample(0.5, y); };
  return { tracker, gestures, sample, hold, gap: () => { time += 600; } };
}

{
  const h = harness();
  h.hold(0.7);
  for (const y of [0.67, 0.62, 0.57, 0.52, 0.46, 0.4]) h.sample(0.5, y);
  // Returning the hand immediately should not undo the intended swipe.
  for (const y of [0.46, 0.52, 0.58, 0.64, 0.7]) h.sample(0.5, y);
  assert.deepEqual(h.gestures, ["up"]);
  h.hold(0.7, 12);
  for (const y of [0.66, 0.62, 0.58, 0.54, 0.5]) h.sample(0.5, y);
  assert.deepEqual(h.gestures, ["up", "up"]);
  h.hold(0.5, 14);
  for (const y of [0.54, 0.58, 0.62, 0.66, 0.7]) h.sample(0.5, y);
  assert.deepEqual(h.gestures, ["up", "up", "down"]);
}
{
  const h = harness();
  for (let i = 0; i < 60; i++) h.sample(0.5 + Math.sin(i) * 0.005, 0.5 + Math.cos(i) * 0.006);
  for (let i = 0; i < 8; i++) h.sample(0.5 + i * 0.04, 0.5 + i * 0.01);
  h.hold(0.5);
  for (let i = 0; i < 45; i++) h.sample(0.5, 0.5 - i * 0.004);
  assert.deepEqual(h.gestures, []);
}
{
  const h = harness();
  h.hold(0.7);
  h.sample(0.5, 0.63);
  h.tracker.update(null);
  h.sample(0.5, 0.5);
  h.sample(0.5, 0.43);
  h.sample(0.5, 0.36);
  assert.deepEqual(h.gestures, []);
  h.hold(0.7);
  h.sample(0.5, 0.64);
  h.gap();
  for (const y of [0.48, 0.42, 0.36]) h.sample(0.5, y);
  assert.deepEqual(h.gestures, []);
}
{
  const h = harness();
  h.hold(0.7);
  h.sample(0.5, 0.63);
  for (const y of [0.57, 0.51, 0.45]) h.sample(0.5, y, "Left");
  assert.deepEqual(h.gestures, []);
  h.tracker.reset(); // Pause or visibility reset discards pre-pause movement.
  for (const y of [0.4, 0.34, 0.28]) h.sample(0.5, y, "Left");
  assert.deepEqual(h.gestures, []);
}
console.log("PASS: vertical swipes, one action per swipe, return-motion suppression, rearm, jitter, horizontal movement, slow drift, lost-hand/gap/identity/pause resets.");
