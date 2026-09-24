import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as settle } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the production modules with the existing TypeScript dependency.
// Each test has isolated browser/clock doubles; no camera or model is required.
const compiled = new Map(await Promise.all(['camera', 'runner', 'main', 'metrics'].map(async (name) => {
  const source = await readFile(new URL(`../src/web/${name}.ts`, import.meta.url), 'utf8');
  return [name, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText];
})));

function load(name, globals = {}, imports = {}) {
  const exports = {};
  runInNewContext(compiled.get(name), {
    exports, performance, Date, AbortController, DOMException, Blob,
    require: (path) => { assert.ok(path in imports, `Unexpected import: ${path}`); return imports[path]; },
    ...globals,
  }, { filename: `${name}.js` });
  return exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const frame = { imageBase64: 'synthetic', capturedAt: 100, width: 320, height: 240, bytes: 16, captureMs: 300, encodeMs: 200 };
const payload = {
  answers: { expression: { choice: 'Neutral', confidence: 0.9 } }, timing_ms: { total: 200 },
  speedlab: { traceId: 'trace', backend: 'glance', choiceMethod: 'independent', gatewayMs: 200, upstreamMs: 190 },
};
const sample = (capturedAt) => ({
  capturedAt, sequence: 1, at: 123456, loopMs: 700, requestMs: 200,
  capture: { width: 320, height: 240, bytes: 16, captureMs: 300, encodeMs: 200 }, response: payload,
});

test('camera timestamps the draw, not JPEG or base64 completion', async () => {
  let now = 100;
  let drawnAt;
  let finishJpeg;
  let reader;
  const video = { videoWidth: 640, videoHeight: 480, readyState: 2, pause() {}, async play() {} };
  const { CameraCapture } = load('camera', {
    performance: { now: () => now }, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    document: { createElement: () => ({
      // Clock advances during canvas setup, so capture-start is not draw time.
      set width(value) { now += 5; }, set height(value) { now += 5; },
      getContext: () => ({ drawImage: () => { drawnAt = now; } }),
      toBlob: (callback) => { finishJpeg = callback; },
    }) },
    FileReader: class { readAsDataURL() { reader = this; } },
  });
  const camera = new CameraCapture(video);
  await camera.start();
  now = 100;
  const pending = camera.capture({ longEdge: 320, quality: 0.6 });
  assert.equal(drawnAt, 110);
  now = 400;
  finishJpeg({ size: 16 });
  await settle();
  now = 600;
  reader.result = 'data:image/jpeg;base64,synthetic';
  reader.onload();
  const result = await pending;
  assert.equal(result.capturedAt, 110);
  assert.equal(result.captureMs, 300, 'existing capture duration includes setup and JPEG');
  assert.equal(result.encodeMs, 200);
  assert.equal(result.imageBase64, 'synthetic');
  camera.stop();
});

for (const capturedAt of [0, 100]) {
  test(`runner preserves frame timestamp ${capturedAt} without transmitting or recording it`, async (t) => {
    const h = runnerHarness(t, { ...frame, capturedAt });
    h.runner.start();
    await settle();
    h.clock.now = 900;
    h.headers.resolve({ ok: true, json: () => h.body.promise });
    await settle();
    assert.equal(h.samples.length, 0, 'headers alone must not publish an answer');
    h.clock.now = 1_200;
    h.body.resolve(payload);
    await settle();
    assert.equal(h.samples.length, 1);
    assert.equal(h.samples[0].capturedAt, capturedAt);
    assert.equal(h.samples[0].capture.captureMs, frame.captureMs);
    assert.deepEqual(Object.keys(h.request().client).sort(), ['bytes', 'captureMs', 'encodeMs', 'height', 'longEdge', 'quality', 'width']);
    assert.equal(h.beacons.length, 1);
    const recorded = JSON.parse(await h.beacons[0].text());
    assert.equal('capturedAt' in recorded, false);
    assert.equal('capturedAt' in recorded.capture, false);
    assert.deepEqual(recorded.capture, { ...h.samples[0].capture });
  });
}

test('stopping during a response cannot publish a new answer timestamp', async (t) => {
  const h = runnerHarness(t, frame);
  h.runner.start();
  await settle();
  h.runner.stop();
  h.headers.resolve({ ok: true, json: () => h.body.promise });
  h.body.resolve(payload);
  await settle();
  assert.equal(h.samples.length, 0);
  assert.equal(h.beacons.length, 0);
});

test('a rejected response cannot publish a new answer timestamp', async (t) => {
  const h = runnerHarness(t, frame);
  h.runner.start();
  await settle();
  h.headers.resolve({ ok: false, status: 503, json: () => h.body.promise });
  h.body.resolve({ error: 'offline' });
  await settle();
  assert.equal(h.samples.length, 0);
  assert.equal(h.beacons.length, 0);
  assert.equal(h.states.at(-1), 'error');
});

function runnerHarness(t, captured) {
  const headers = deferred();
  const body = deferred();
  const clock = { now: 600 };
  const samples = [];
  const beacons = [];
  const states = [];
  const waits = [];
  let request;
  const { LiveRunner } = load('runner', {
    performance: { now: () => clock.now },
    fetch: (url, init) => { request = JSON.parse(init.body); return headers.promise; },
    requestAnimationFrame: (callback) => waits.push(callback),
    setTimeout: (callback) => waits.push(callback),
    navigator: { sendBeacon: (url, data) => { beacons.push(data); return true; } },
  });
  const runner = new LiveRunner({
    capture: async () => captured, getConfig: () => ({ longEdge: 320, quality: 0.6 }),
    getQuestions: () => [{ id: 'visible', type: 'noul', instructions: 'Visible in `img0`?' }],
    getBackend: () => 'glance', getChoiceMethod: () => 'independent', getRecording: () => true,
    sessionId: 'test-age', onSample: (value) => samples.push(value), onState: (state) => states.push(state),
  });
  t.after(async () => {
    runner.stop();
    headers.resolve({ ok: true, json: () => body.promise });
    body.resolve(payload);
    await settle();
    while (waits.length) { waits.shift()(0); await settle(); }
  });
  return { runner, headers, body, clock, samples, beacons, states, request: () => request };
}

test('UI starts unknown and includes inference time in the first displayed age', async () => {
  const h = uiHarness();
  assert.equal(h.age(), '—');
  assert.equal(h.ageTimers().length, 0);
  await h.click('start');
  assert.equal(h.ageTimers().length, 1);
  assert.equal(h.age(), '—');
  h.clock.now = 800;
  h.options().onSample(sample(100));
  assert.equal(h.age(), '700 ms');
  h.options().onSample(sample(0));
  assert.equal(h.age(), '800 ms', 'a zero timestamp is valid');
});

test('reuse, pending work and errors age the same answer without adding samples', async () => {
  const h = uiHarness();
  await h.click('start');
  h.options().onSample(sample(100));
  for (const state of ['reusing', 'capturing', 'inferencing', 'error']) {
    h.clock.now += 300;
    h.options().onState(state);
    h.tick();
    assert.equal(h.age(), `${h.clock.now - 100} ms`);
    assert.equal(h.node('sample-count').textContent, '1 / 120 samples');
  }
});

test('delayed timer callbacks read elapsed time instead of accumulating ticks', async () => {
  const h = uiHarness();
  await h.click('start');
  h.options().onSample(sample(100));
  h.clock.now = 10_100;
  h.tick();
  assert.equal(h.age(), '10000 ms');
});

test('resetting statistics keeps the age until a newly accepted answer replaces it', async () => {
  const h = uiHarness();
  await h.click('start');
  h.options().onSample(sample(100));
  await h.click('reset');
  h.clock.now = 1_100;
  h.tick();
  assert.equal(h.node('sample-count').textContent, '0 / 120 samples');
  assert.equal(h.age(), '1000 ms');
  // Setting changes also reset statistics, but not the displayed answer.
  await h.node('long-edge').dispatch('change');
  h.tick();
  assert.equal(h.age(), '1000 ms');
  h.clock.now = 1_600;
  h.options().onSample(sample(1_400));
  assert.equal(h.age(), '200 ms');
});

for (const trigger of ['stop', 'pagehide']) {
  test(`${trigger} clears answers and timer; restart waits for a new answer`, async () => {
    const h = uiHarness();
    await h.click('start');
    h.options().onSample(sample(100));
    if (trigger === 'stop') await h.click('stop');
    else h.events.get('pagehide')();
    assert.equal(h.age(), '—');
    assert.equal(h.node('answers').children.length, 0);
    assert.equal(h.ageTimers().length, 0);
    await h.click('start');
    assert.equal(h.age(), '—');
    assert.equal(h.ageTimers().length, 1);
    // Repeated start must not leak an additional display interval.
    await h.click('start');
    assert.equal(h.ageTimers().length, 1);
    h.options().onSample(sample(600));
    assert.equal(h.age(), '200 ms');
  });
}

test('an empty result clears age because no answer is displayed', async () => {
  const h = uiHarness();
  await h.click('start');
  h.options().onSample(sample(100));
  h.options().onSample({ ...sample(600), response: { ...payload, answers: {} } });
  assert.equal(h.age(), '—');
  assert.equal(h.node('answers').children.length, 0);
});

test('missing or invalid timestamps remain unknown rather than looking fresh', async () => {
  const h = uiHarness();
  await h.click('start');
  for (const value of [undefined, NaN, Infinity, 10_000]) {
    h.options().onSample(sample(value));
    assert.equal(h.age(), '—');
  }
});

function uiHarness() {
  const clock = { now: 800 };
  const nodes = new Map();
  const intervals = new Map();
  const events = new Map();
  let nextId = 1;
  let options;
  const makeNode = () => ({
    textContent: '—', value: '', checked: false, dataset: {}, children: [], handlers: new Map(),
    addEventListener(event, callback) { this.handlers.set(event, callback); },
    async dispatch(event) { await this.handlers.get(event)?.(); },
    replaceChildren(...children) { this.children = children; },
    querySelector: () => makeNode(), closest: () => makeNode(),
  });
  const app = makeNode();
  Object.defineProperty(app, 'innerHTML', { set(html) {
    for (const [, id] of html.matchAll(/id="([^"]+)"/g)) nodes.set(id, makeNode());
  } });
  const document = {
    querySelector: (selector) => selector === '#app' ? app : makeNode(),
    querySelectorAll: (selector) => selector.startsWith('#')
      ? selector.split(', ').map((id) => nodes.get(id.slice(1))) : [],
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: () => makeNode(),
    body: { classList: { add() {}, remove() {} } },
  };
  const setInterval = (callback, ms) => { const id = nextId++; intervals.set(id, { callback, ms }); return id; };
  load('main', {
    document, performance: { now: () => clock.now }, setInterval,
    window: { setInterval, clearInterval: (id) => intervals.delete(id), addEventListener: (event, callback) => events.set(event, callback) },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  }, {
    './style.css': {}, './metrics': load('metrics'),
    './camera': { CameraCapture: class { async start() {} stop() {} } },
    './runner': { LiveRunner: class { constructor(value) { options = value; } start() {} stop() {} } },
  });
  const ageTimers = () => [...intervals.values()].filter(({ ms }) => ms === 250);
  return {
    clock, events, options: () => options, node: (id) => nodes.get(id), ageTimers,
    age: () => nodes.get('answer-age')?.textContent,
    click: async (id) => nodes.get(id).dispatch('click'),
    tick: () => { assert.equal(ageTimers().length, 1); ageTimers()[0].callback(); },
  };
}
