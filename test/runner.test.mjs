import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as settle } from 'node:timers/promises';
import ts from 'typescript';

// Compile the production runner with the existing TypeScript dependency.
// Its only import is type-only; no DOM, camera, model, or new loader is needed.
const source = await readFile(new URL('../src/web/runner.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { LiveRunner } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const frame = { imageBase64: 'synthetic-frame', width: 320, height: 240, bytes: 16, captureMs: 2, encodeMs: 1 };
const payload = {
  answers: { visible: { noul: 0.9 } },
  timing_ms: { total: 10 },
  speedlab: { traceId: 'trace', backend: 'glance', choiceMethod: 'independent', gatewayMs: 12, upstreamMs: 10 },
};

for (const withVersion of [true, false]) {
  test(`unchanged windows publish and record samples ${withVersion ? 'with' : 'without'} a version callback`, async (t) => {
    const h = harness(t, withVersion);
    h.runner.start();
    await h.finishCapture();
    await h.finishRequest();
    await h.paint();
    await h.finishCapture();
    await h.finishRequest();

    assert.deepEqual(h.samples.map((sample) => sample.sequence), [1, 2]);
    assert.equal(h.commits.mock.callCount(), 2);
    assert.equal(h.beacons.length, 2);
    const recorded = JSON.parse(await h.beacons[1].body.text());
    assert.equal(recorded.sequence, 2);
    assert.equal(recorded.questionCount, 1);
    assert.equal(h.beacons[1].url, '/api/metrics');
    assert.equal(h.errors.length, 0);
  });
}

for (const stage of ['capture', 'response', 'response body']) {
  test(`reset during ${stage} discards old work and accepts the next window`, async (t) => {
    const h = harness(t);
    h.runner.start();
    if (stage !== 'capture') await h.finishCapture();
    if (stage === 'response body') {
      h.requests[0].headers.resolve(h.requests[0].response);
      await settle();
      assert.equal(h.requests[0].response.json.mock.callCount(), 1);
    }

    h.reset();
    if (stage === 'capture') await h.finishCapture();
    else await h.finishRequest();

    assert.equal(h.samples.length, 0, 'obsolete work must not repopulate the window');
    assert.equal(h.beacons.length, 0, 'obsolete work must not be recorded');
    assert.equal(h.commits.mock.callCount(), 0, 'obsolete work must not commit a motion reference');
    if (stage === 'capture') assert.equal(h.requests.length, 0, 'obsolete captures must not be submitted');
    assert.equal(h.captures.length, 2, 'the next capture must start without restarting the runner');

    await h.finishCapture();
    await h.finishRequest();
    assert.equal(h.samples.length, 1);
    assert.equal(h.samples[0].sequence, 1, 'discarded work must not consume a sequence number');
    assert.equal(h.commits.mock.callCount(), 1);
    assert.equal(h.beacons.length, 1);
    const request = JSON.parse(h.requests.at(-1).init.body);
    assert.match(request.questions[0].instructions, /window 1/);
    assert.equal(h.errors.length, 0);
  });
}

test('repeated resets keep the latest window usable after a previously accepted sample', async (t) => {
  const h = harness(t);
  h.runner.start();
  await h.finishCapture();
  await h.finishRequest();
  await h.paint();
  await h.finishCapture();

  h.reset();
  h.reset();
  await h.finishRequest();
  assert.equal(h.samples.length, 0);
  assert.equal(h.beacons.length, 1, 'only the previously accepted sample was recorded');
  assert.equal(h.commits.mock.callCount(), 1);

  await h.finishCapture();
  await h.finishRequest();
  assert.deepEqual(h.samples.map((sample) => sample.sequence), [2]);
  assert.equal(h.beacons.length, 2);
  assert.match(JSON.parse(h.requests.at(-1).init.body).questions[0].instructions, /window 2/);
  assert.equal(h.errors.length, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(t, withVersion = true) {
  let version = 0;
  const captures = [];
  const requests = [];
  const paints = [];
  const samples = [];
  const beacons = [];
  const errors = [];
  const globals = new Map();
  const commits = t.mock.fn();
  const replaceGlobal = (name, value) => {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  replaceGlobal('requestAnimationFrame', (callback) => { paints.push(callback); return paints.length; });
  replaceGlobal('navigator', { sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } });
  replaceGlobal('fetch', (url, init) => {
    assert.equal(url, '/api/decide');
    const headers = deferred();
    const body = deferred();
    const response = { ok: true, status: 200, json: t.mock.fn(() => body.promise) };
    requests.push({ headers, body, response, init });
    return headers.promise;
  });
  const runner = new LiveRunner({
    capture: () => { const pending = deferred(); captures.push(pending); return pending.promise; },
    getConfig: () => ({ longEdge: 320, quality: 0.6 }),
    getQuestions: () => [{ id: 'visible', type: 'noul', instructions: `Question for window ${version} about \`img0\`` }],
    getBackend: () => 'glance',
    getChoiceMethod: () => 'independent',
    getRecording: () => true,
    ...(withVersion ? { getMeasurementVersion: () => version } : {}),
    commitMotionReference: commits,
    sessionId: 'test-window',
    onSample: (sample) => samples.push(sample),
    onState: (state, detail) => { if (state === 'error') errors.push(detail); },
  });
  t.after(async () => {
    runner.stop();
    for (const capture of captures) capture.resolve(frame);
    for (const request of requests) {
      request.headers.resolve(request.response);
      request.body.resolve(payload);
    }
    for (const paint of paints.splice(0)) paint(0);
    await settle();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return {
    runner, captures, requests, samples, beacons, commits, errors,
    reset: () => { version += 1; samples.length = 0; },
    finishCapture: async () => {
      assert.ok(captures.length, 'a capture must be pending');
      captures.at(-1).resolve(frame);
      await settle();
    },
    finishRequest: async () => {
      assert.ok(requests.length, 'a request must be pending');
      const request = requests.at(-1);
      request.headers.resolve(request.response);
      request.body.resolve(payload);
      await settle();
    },
    paint: async () => {
      assert.equal(paints.length, 1);
      paints.shift()(0);
      await settle();
    },
  };
}
