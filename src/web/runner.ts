import type { Backend, CaptureConfig, CapturedFrame, ChoiceMethod, DecideResponse, Question, Sample } from './types';

type RunnerOptions = {
  capture: (config: CaptureConfig) => Promise<CapturedFrame>;
  getConfig: () => CaptureConfig;
  getQuestions: () => Question[];
  getBackend: () => Backend;
  getChoiceMethod: () => ChoiceMethod;
  getRecording: () => boolean;
  getMeasurementVersion?: () => number;
  getTemporalReuse?: () => { enabled: boolean; threshold: number; maxStaleMs: number };
  measureMotion?: () => number;
  commitMotionReference?: () => void;
  sessionId: string;
  onSample: (sample: Sample) => void;
  onState: (state: 'idle' | 'capturing' | 'inferencing' | 'reusing' | 'error', detail?: string) => void;
};

export class LiveRunner {
  #generation = 0;
  #sequence = 0;
  #abort: AbortController | null = null;
  #lastInferenceAt = 0;

  constructor(private readonly options: RunnerOptions) {}

  start(): void {
    this.stop();
    const generation = this.#generation;
    void this.#run(generation);
  }

  stop(): void {
    this.#generation += 1;
    this.#lastInferenceAt = 0;
    this.#abort?.abort();
    this.#abort = null;
    this.options.onState('idle');
  }

  async #run(generation: number): Promise<void> {
    while (generation === this.#generation) {
      const measurementVersion = this.options.getMeasurementVersion?.() ?? 0;
      const questions = this.options.getQuestions();
      if (!questions.length) {
        this.options.onState('error', 'Enable at least one question.');
        await nextPaint();
        continue;
      }
      const temporal = this.options.getTemporalReuse?.();
      if (temporal?.enabled && this.options.measureMotion) {
        const motion = this.options.measureMotion();
        if (this.#lastInferenceAt > 0 && motion < temporal.threshold && performance.now() - this.#lastInferenceAt < temporal.maxStaleMs) {
          this.options.onState('reusing', `motion ${motion.toFixed(1)}`);
          await nextPaint();
          continue;
        }
      }
      const loopStartedAt = performance.now();
      try {
        this.options.onState('capturing');
        const frame = await this.options.capture(this.options.getConfig());
        if (generation !== this.#generation) return;
        if ((this.options.getMeasurementVersion?.() ?? 0) !== measurementVersion) continue;
        this.options.onState('inferencing');
        this.#abort = new AbortController();
        const requestStartedAt = performance.now();
        const response = await fetch('/api/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: this.#abort.signal,
          body: JSON.stringify({
            imageBase64: frame.imageBase64,
            questions: questions.map(({ id, type, instructions, criteria }) => ({ id, type, instructions, criteria })),
            backend: this.options.getBackend(),
            choiceMethod: this.options.getChoiceMethod(),
            sessionId: this.options.sessionId,
            client: { ...frame, imageBase64: undefined, capturedAt: undefined, ...this.options.getConfig() },
          }),
        });
        const requestMs = performance.now() - requestStartedAt;
        const payload = await response.json() as DecideResponse & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
        if (generation !== this.#generation) return;
        if ((this.options.getMeasurementVersion?.() ?? 0) !== measurementVersion) continue;
        this.#sequence += 1;
        const sample: Sample = {
          sequence: this.#sequence,
          at: Date.now(),
          capturedAt: frame.capturedAt,
          loopMs: performance.now() - loopStartedAt,
          requestMs,
          capture: {
            width: frame.width,
            height: frame.height,
            bytes: frame.bytes,
            captureMs: frame.captureMs,
            encodeMs: frame.encodeMs,
          },
          response: payload,
        };
        this.options.onSample(sample);
        this.#lastInferenceAt = performance.now();
        this.options.commitMotionReference?.();
        if (this.options.getRecording()) recordMetric(
          this.options.sessionId,
          questions.length,
          sample,
          this.options.getTemporalReuse?.(),
        );
        this.options.onState('idle');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        this.options.onState('error', error instanceof Error ? error.message : 'Inference failed.');
        await delay(500);
      } finally {
        this.#abort = null;
      }
      await nextPaint();
    }
  }
}

function recordMetric(
  sessionId: string,
  questionCount: number,
  sample: Sample,
  temporal: { enabled: boolean; threshold: number; maxStaleMs: number } | undefined,
): void {
  const body = JSON.stringify({
    sessionId,
    traceId: sample.response.speedlab.traceId,
    sequence: sample.sequence,
    questionCount,
    backend: sample.response.speedlab.backend,
    choiceMethod: sample.response.speedlab.choiceMethod,
    temporalReuse: temporal?.enabled ?? false,
    motionThreshold: temporal?.threshold ?? 0,
    maxStaleMs: temporal?.maxStaleMs ?? 0,
    loopMs: sample.loopMs,
    requestMs: sample.requestMs,
    capture: sample.capture,
    gatewayMs: sample.response.speedlab.gatewayMs,
    upstreamMs: sample.response.speedlab.upstreamMs,
    modelTimingMs: sample.response.timing_ms ?? {},
  });
  navigator.sendBeacon('/api/metrics', new Blob([body], { type: 'application/json' }));
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
