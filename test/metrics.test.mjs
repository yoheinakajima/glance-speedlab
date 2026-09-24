import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the production metrics with the existing TypeScript dependency.
const source = await readFile(new URL('../src/web/metrics.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { SampleWindow, totalModelMs } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function sample(overrides = {}) {
  return {
    sequence: 1, at: 0, loopMs: 100, requestMs: 90,
    capture: { width: 320, height: 240, bytes: 16, captureMs: 2, encodeMs: 1 },
    response: { answers: {}, timing_ms: { total: 80 }, speedlab: { upstreamMs: 85 } },
    ...overrides,
  };
}

test('result rate is unavailable until two completions define an interval', () => {
  const window = new SampleWindow();
  assert.equal(window.summary().resultHz, null);
  assert.equal(window.summary().processingHz, 0);
  window.add(sample(), 100);
  assert.equal(window.summary().resultHz, null);
  assert.equal(window.summary().processingHz, 10);
});

test('waits between results lower result rate without changing processing rate', () => {
  const window = new SampleWindow();
  window.add(sample(), 100);
  window.add(sample(), 1_100);
  assert.equal(window.summary().resultHz, 1);
  assert.equal(window.summary().processingHz, 10);
});

test('N completions span N minus one intervals, including unequal gaps', () => {
  const window = new SampleWindow();
  window.add(sample(), 100);
  window.add(sample(), 200);
  assert.equal(window.summary().resultHz, 10);
  window.add(sample(), 1_100);
  assert.equal(window.summary().resultHz, 2);
});

test('rolling eviction removes the corresponding completion timestamp', () => {
  const window = new SampleWindow(2);
  window.add(sample({ loopMs: 1_000 }), 100);
  window.add(sample(), 1_100);
  window.add(sample(), 1_200);
  assert.equal(window.count, 2);
  assert.equal(window.summary().resultHz, 10);
  assert.equal(window.summary().processingHz, 10);
});

test('clear discards timing history as well as samples', () => {
  const window = new SampleWindow();
  window.add(sample(), 100);
  window.add(sample(), 200);
  window.clear();
  assert.equal(window.count, 0);
  assert.equal(window.summary().resultHz, null);
  window.add(sample(), 10_000);
  assert.equal(window.summary().resultHz, null);
  window.add(sample(), 11_000);
  assert.equal(window.summary().resultHz, 1);
});

test('equal timestamps do not produce an infinite rate', () => {
  const window = new SampleWindow();
  window.add(sample(), 100);
  window.add(sample(), 100);
  assert.equal(window.summary().resultHz, null);
});

test('default completion timestamps use the monotonic clock, not calendar time', (t) => {
  let completedAt = 100;
  let calendarAt = 10_000;
  t.mock.method(performance, 'now', () => completedAt);
  t.mock.method(Date, 'now', () => calendarAt);
  const window = new SampleWindow();
  window.add(sample({ at: Date.now() }));
  completedAt = 1_100;
  calendarAt = 1_000;
  window.add(sample({ at: Date.now() }));
  assert.equal(window.summary().resultHz, 1);
  completedAt = 9_100;
  assert.equal(window.summary().resultHz, 1, 'summary is a completed-interval snapshot, not a live rate');
});

test('latency summaries retain their existing definitions', () => {
  const window = new SampleWindow();
  window.add(sample({ loopMs: 200 }), 200);
  window.add(sample({ loopMs: 100 }), 300);
  const summary = window.summary();
  assert.equal(summary.loopP50, 100);
  assert.equal(summary.loopP95, 200);
  assert.equal(summary.requestP50, 90);
  assert.equal(summary.captureP50, 3);
  assert.equal(summary.upstreamP50, 85);
  assert.equal(summary.modelP50, 80);
});

test('model timing prefers total, including a cached zero, over component sums', () => {
  assert.equal(totalModelMs({ total: 0, prefix: 10, score: 20 }), 0);
  assert.equal(totalModelMs({ prefix: 10, score: 20, invalid: NaN }), 30);
  assert.equal(totalModelMs(undefined), 0);
});
