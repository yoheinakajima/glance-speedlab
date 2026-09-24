import './style.css';
import { CameraCapture } from './camera';
import { SampleWindow, totalModelMs } from './metrics';
import { LiveRunner } from './runner';
import type { Backend, Question, Sample } from './types';

const QUESTIONS: Question[] = [
  {
    id: 'expression',
    label: 'Expression',
    type: 'choice',
    instructions: 'Which visible facial expression best matches the person in `img0` right now?',
    criteria: ['Happy', 'Sad', 'Angry', 'Confused', 'Neutral'],
  },
  {
    id: 'holding',
    label: 'Holding',
    type: 'choice',
    instructions: 'What is the person in `img0` holding?',
    criteria: ['Drink', 'Phone', 'Book', 'Nothing', 'Other'],
  },
  {
    id: 'fingers',
    label: 'Fingers',
    type: 'choice',
    instructions: 'How many fingers is the person in `img0` holding up?',
    criteria: ['0', '1', '2', '3', '4', '5'],
  },
  {
    id: 'custom_yesno',
    label: 'Custom yes/no',
    type: 'noul',
    instructions: 'Is the person in `img0` holding a phone?',
  },
];

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root is missing.');

app.innerHTML = `
  <main class="shell">
    <header class="masthead">
      <div class="brand"><span class="mark"></span><span>Glance <b>Speedlab</b></span></div>
      <div class="health"><span class="health-dot"></span><span id="health-label">checking model</span></div>
    </header>

    <section class="stage" aria-label="Live camera experiment">
      <video id="camera" autoplay muted playsinline></video>
      <div class="stage-vignette"></div>
      <div class="stage-empty" id="stage-empty">
        <p class="eyebrow">LOCAL VISION · MEASURED END TO END</p>
        <h1>Make every glance<br><em>feel immediate.</em></h1>
        <p>One clean path from photons to probabilities, with every millisecond accounted for.</p>
        <button id="start" class="primary">Start camera <span>→</span></button>
        <p class="privacy">Frames stay in memory and are sent only to your selected loopback backend.</p>
      </div>
      <div class="stage-top active-only">
        <div id="run-state" class="run-state"><i></i><span>ready</span></div>
        <button id="stop" class="icon-button" aria-label="Stop camera">■</button>
      </div>
      <div id="answers" class="answers active-only"></div>
      <div class="live-metric active-only">
        <span>loop p50</span><strong id="hero-latency">—</strong><small>ms</small>
      </div>
    </section>

    <aside class="control-panel">
      <div class="panel-heading">
        <div><p class="eyebrow">LIVE RESEARCH LAB</p><h2>Camera bench</h2></div>
        <button id="reset" class="text-button">Reset window</button>
      </div>
      <a class="lab-link" href="/lab.html">Run deterministic browser experiments →</a>

      <section class="control-section">
        <div class="section-title"><span>Questions</span><small id="question-count">1 native batch item</small></div>
        <div class="question-grid">
          ${QUESTIONS.map((question, index) => `
            <label class="question-toggle">
              <input type="checkbox" data-question="${question.id}" ${index === 0 ? 'checked' : ''} />
              <span>${question.label}</span>
            </label>
          `).join('')}
        </div>
        <label class="custom-question" hidden>
          <span>Yes/no prompt</span>
          <input id="custom-prompt" value="Is the person holding a phone?" maxlength="900" />
        </label>
      </section>

      <section class="control-section settings-row">
        <label><span>Long edge</span><select id="long-edge"><option>160</option><option>224</option><option selected>320</option><option>448</option></select></label>
        <label><span>JPEG quality</span><select id="quality"><option value="0.4">40%</option><option value="0.55">55%</option><option value="0.6" selected>60%</option><option value="0.75">75%</option><option value="0.9">90%</option></select></label>
      </section>

      <section class="control-section model-controls">
        <div class="section-title"><span>Inference experiment</span><small>recorded per sample</small></div>
        <label class="backend-select"><span>Backend</span><select id="backend"><option value="glance" selected>Glance · MPS FP16 reference</option><option value="mlx-8bit">MLX · 8-bit direct candidate</option></select></label>
        <div class="settings-row">
          <label><span>Choice scoring</span><select id="choice-method"><option value="independent" selected>Independent</option><option value="letter">Letter</option></select></label>
          <label><span>Loaded tier</span><output id="model-profile">checking…</output></label>
        </div>
        <p class="control-note" id="choice-note">Glance is the reference. The MLX 8-bit candidate passed E017 at 1.381× with 0.039 maximum probability drift.</p>
      </section>

      <section class="control-section temporal-controls">
        <label class="record-toggle temporal-toggle">
          <input id="temporal-reuse" type="checkbox" />
          <span><b>Experimental temporal reuse</b><small>Skip nearly identical frames; force refresh after 1 second.</small></span>
        </label>
        <label><span>Motion threshold</span><select id="motion-threshold"><option>1</option><option>2</option><option selected>4</option><option>8</option></select></label>
        <label><span>Forced refresh</span><select id="max-stale"><option value="250">250 ms</option><option value="500">500 ms</option><option value="1000" selected>1 second</option><option value="2000">2 seconds</option></select></label>
      </section>

      <section class="metric-grid" aria-label="Rolling inference metrics">
        <div><span>Loop p95</span><strong id="loop-p95">—</strong><small>ms</small></div>
        <div><span>Model p50</span><strong id="model-p50">—</strong><small>ms</small></div>
        <div><span>Capture p50</span><strong id="capture-p50">—</strong><small>ms</small></div>
        <div><span>Result rate</span><strong id="result-hz">—</strong><small>Hz</small></div>
      </section>

      <p class="control-note">Processing rate: <b id="processing-hz">—</b> Hz (excludes waits). Result rate averages intervals between retained results, including waits and reuse; updates on completion.</p>

      <section class="trace">
        <div class="section-title"><span>Latest trace</span><small id="sample-count">0 / 120 samples</small></div>
        <div class="trace-row"><span>capture + JPEG</span><b id="trace-capture">—</b></div>
        <div class="trace-row"><span>base64</span><b id="trace-encode">—</b></div>
        <div class="trace-row"><span>gateway + network</span><b id="trace-gateway">—</b></div>
        <div class="trace-row"><span>model prefix</span><b id="trace-prefix">—</b></div>
        <div class="trace-row"><span>model scoring</span><b id="trace-score">—</b></div>
        <div class="trace-row"><span>model total</span><b id="trace-model">—</b></div>
        <div class="trace-row total"><span>full loop</span><b id="trace-loop">—</b></div>
      </section>

      <label class="record-toggle">
        <input id="record" type="checkbox" />
        <span><b>Record timing metadata</b><small>Writes local JSONL. Never stores frames.</small></span>
      </label>
      <p id="error" class="error" role="alert"></p>
    </aside>
  </main>
`;

const video = element<HTMLVideoElement>('camera');
const camera = new CameraCapture(video);
const metrics = new SampleWindow(120);
let measurementVersion = 0;
let active = false;
const sessionId = `live-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

const runner = new LiveRunner({
  capture: (config) => camera.capture(config),
  getConfig: () => ({
    longEdge: Number(element<HTMLSelectElement>('long-edge').value),
    quality: Number(element<HTMLSelectElement>('quality').value),
  }),
  getQuestions: selectedQuestions,
  getBackend: selectedBackend,
  getChoiceMethod: () => element<HTMLSelectElement>('choice-method').value === 'letter' ? 'letter' : 'independent',
  getRecording: () => element<HTMLInputElement>('record').checked,
  getMeasurementVersion: () => measurementVersion,
  getTemporalReuse: () => ({
    enabled: element<HTMLInputElement>('temporal-reuse').checked,
    threshold: Number(element<HTMLSelectElement>('motion-threshold').value),
    maxStaleMs: Number(element<HTMLSelectElement>('max-stale').value),
  }),
  measureMotion: () => camera.measureMotion(),
  commitMotionReference: () => camera.commitMotionReference(),
  sessionId,
  onSample: renderSample,
  onState: (state, detail) => {
    const stateElement = element('run-state');
    stateElement.dataset.state = state;
    stateElement.querySelector('span')!.textContent = state === 'inferencing' ? 'model' : state;
    element('error').textContent = detail ?? '';
  },
});

element('start').addEventListener('click', async () => {
  element('error').textContent = '';
  try {
    await camera.start();
    active = true;
    document.body.classList.add('is-active');
    runner.start();
  } catch (error) {
    element('error').textContent = error instanceof Error ? error.message : 'Camera could not start.';
  }
});

element('stop').addEventListener('click', stop);
element('reset').addEventListener('click', resetMeasurementWindow);

for (const input of document.querySelectorAll<HTMLInputElement>('[data-question]')) {
  input.addEventListener('change', () => {
    const customEnabled = element<HTMLInputElement>('custom-prompt').closest('label');
    if (customEnabled) customEnabled.hidden = !questionInput('custom_yesno').checked;
    const count = selectedQuestions().length;
    element('question-count').textContent = `${count} native batch item${count === 1 ? '' : 's'}`;
    resetMeasurementWindow();
  });
}
element<HTMLInputElement>('custom-prompt').addEventListener('input', resetMeasurementWindow);

for (const control of document.querySelectorAll<HTMLSelectElement>('#long-edge, #quality, #choice-method, #motion-threshold, #max-stale')) {
  control.addEventListener('change', resetMeasurementWindow);
}
element<HTMLSelectElement>('backend').addEventListener('change', () => {
  const isMlx = selectedBackend() === 'mlx-8bit';
  const choice = element<HTMLSelectElement>('choice-method');
  const letter = choice.querySelector<HTMLOptionElement>('option[value="letter"]');
  if (isMlx) choice.value = 'independent';
  if (letter) letter.disabled = isMlx;
  element('choice-note').textContent = isMlx
    ? 'E017 candidate: 27.6% lower p50, exact fixed-suite decisions, and 0.039 maximum probability drift. Independent scoring only.'
    : 'Glance is the FP16 reference. Letter scoring remains test-only: E010 did not improve latency and failed its quality guardrail.';
  resetMeasurementWindow();
  void checkHealth();
});
element<HTMLInputElement>('temporal-reuse').addEventListener('change', resetMeasurementWindow);

window.addEventListener('pagehide', stop);
void checkHealth();
setInterval(() => void checkHealth(), 5_000);

function stop(): void {
  if (!active) return;
  active = false;
  runner.stop();
  camera.stop();
  document.body.classList.remove('is-active');
}

function selectedQuestions(): Question[] {
  const custom = element<HTMLInputElement>('custom-prompt').value.trim();
  return QUESTIONS.filter((question) => questionInput(question.id).checked).map((question) =>
    question.id === 'custom_yesno'
      ? { ...question, instructions: `${custom || 'Is the person holding a phone?'} Consider \`img0\`.` }
      : question,
  );
}

function selectedBackend(): Backend {
  return element<HTMLSelectElement>('backend').value === 'mlx-8bit' ? 'mlx-8bit' : 'glance';
}

function renderSample(sample: Sample): void {
  metrics.add(sample);
  renderSummary();
  element('trace-capture').textContent = milliseconds(sample.capture.captureMs);
  element('trace-encode').textContent = milliseconds(sample.capture.encodeMs);
  element('trace-gateway').textContent = milliseconds(sample.response.speedlab.gatewayMs);
  element('trace-prefix').textContent = milliseconds(sample.response.timing_ms?.prefix ?? 0);
  element('trace-score').textContent = milliseconds(sample.response.timing_ms?.score ?? 0);
  element('trace-model').textContent = milliseconds(totalModelMs(sample.response.timing_ms));
  element('trace-loop').textContent = milliseconds(sample.loopMs);
  element('answers').replaceChildren(...Object.entries(sample.response.answers).map(([id, answer]) => {
    const question = QUESTIONS.find((item) => item.id === id);
    const probability = answer.noul ?? answer.confidence ?? 0;
    const label = answer.noul === undefined ? answer.choice ?? '—' : answer.noul >= 0.5 ? 'Yes' : 'No';
    const node = document.createElement('article');
    node.className = 'answer-card';
    node.innerHTML = `<span>${escapeHtml(question?.label ?? id)}</span><strong>${escapeHtml(label)}</strong><div><i style="width:${Math.round(probability * 100)}%"></i></div><small>${Math.round(probability * 100)}% confidence</small>`;
    return node;
  }));
}

function renderSummary(): void {
  const summary = metrics.summary();
  element('hero-latency').textContent = summary.count ? integer(summary.loopP50) : '—';
  element('loop-p95').textContent = summary.count ? integer(summary.loopP95) : '—';
  element('model-p50').textContent = summary.count ? integer(summary.modelP50) : '—';
  element('capture-p50').textContent = summary.count ? summary.captureP50.toFixed(1) : '—';
  element('result-hz').textContent = summary.resultHz === null ? '—' : summary.resultHz.toFixed(2);
  element('processing-hz').textContent = summary.count ? summary.processingHz.toFixed(2) : '—';
  element('sample-count').textContent = `${summary.count} / 120 samples`;
}

function resetMeasurementWindow(): void {
  measurementVersion += 1;
  metrics.clear();
  renderSummary();
}

async function checkHealth(): Promise<void> {
  const dot = document.querySelector<HTMLElement>('.health-dot');
  try {
    const response = await fetch('/api/health');
    const payload = await response.json() as {
      online?: boolean;
      glanceOnline?: boolean;
      mlxOnline?: boolean;
      glance?: { device?: string; loaded?: string[]; selected_tier?: string; prefix_cache?: boolean };
      mlx?: { backend?: string; model?: string };
      models?: Array<{ name?: string; image_token_budget?: number }>;
    };
    const online = response.ok && payload.online;
    if (dot) dot.dataset.online = String(online);
    const loaded = payload.glance?.loaded?.join(', ');
    const backend = selectedBackend();
    const selectedOnline = backend === 'mlx-8bit' ? payload.mlxOnline : payload.glanceOnline;
    element('health-label').textContent = selectedOnline
      ? backend === 'mlx-8bit' ? 'MLX 8-bit · Metal' : `${loaded || 'model'} · ${payload.glance?.device || 'ready'}`
      : `${backend === 'mlx-8bit' ? 'MLX' : 'Glance'} offline`;
    if (dot) dot.dataset.online = String(Boolean(selectedOnline));
    const mlxOption = element<HTMLSelectElement>('backend').querySelector<HTMLOptionElement>('option[value="mlx-8bit"]');
    if (mlxOption) mlxOption.disabled = !payload.mlxOnline;
    const vlm = payload.models?.find((model) => model.name === 'vlm');
    element('model-profile').textContent = selectedOnline
      ? backend === 'mlx-8bit'
        ? 'Qwen3-VL-2B · 8-bit · direct'
        : `${payload.glance?.selected_tier || 'unknown'} · ${vlm?.image_token_budget ?? '?'} tok · cache ${payload.glance?.prefix_cache ? 'on' : 'off'}`
      : 'offline';
  } catch {
    if (dot) dot.dataset.online = 'false';
    element('health-label').textContent = 'gateway offline';
    element('model-profile').textContent = 'offline';
  }
}

function questionInput(id: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`[data-question="${id}"]`);
  if (!input) throw new Error(`Question input ${id} is missing.`);
  return input;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Element #${id} is missing.`);
  return node as T;
}

function milliseconds(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
}

function integer(value: number): string {
  return Math.round(value).toString();
}

function escapeHtml(value: string): string {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}
