import type { Sample } from './types';

export class SampleWindow {
  #samples: { sample: Sample; completedAt: number }[] = [];
  constructor(readonly capacity = 120) {}

  add(sample: Sample, completedAt = performance.now()): void {
    this.#samples.push({ sample, completedAt });
    if (this.#samples.length > this.capacity) this.#samples.shift();
  }

  clear(): void {
    this.#samples = [];
  }

  get count(): number {
    return this.#samples.length;
  }

  summary(): MetricSummary {
    const loops = this.#samples.map(({ sample }) => sample.loopMs);
    const requests = this.#samples.map(({ sample }) => sample.requestMs);
    const captures = this.#samples.map(({ sample }) => sample.capture.captureMs + sample.capture.encodeMs);
    const upstream = this.#samples.map(({ sample }) => sample.response.speedlab.upstreamMs);
    const model = this.#samples.map(({ sample }) => totalModelMs(sample.response.timing_ms));
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    const elapsedMs = first && last ? last.completedAt - first.completedAt : 0;
    return {
      count: this.count,
      processingHz: loops.length ? 1_000 / mean(loops) : 0,
      // N completions define N - 1 intervals, including waits and reuse.
      resultHz: this.count >= 2 && elapsedMs > 0 ? (this.count - 1) * 1_000 / elapsedMs : null,
      loopP50: percentile(loops, 0.5),
      loopP95: percentile(loops, 0.95),
      requestP50: percentile(requests, 0.5),
      captureP50: percentile(captures, 0.5),
      upstreamP50: percentile(upstream, 0.5),
      modelP50: percentile(model, 0.5),
    };
  }
}

export type MetricSummary = {
  count: number;
  processingHz: number;
  resultHz: number | null;
  loopP50: number;
  loopP95: number;
  requestP50: number;
  captureP50: number;
  upstreamP50: number;
  modelP50: number;
};

export function totalModelMs(timing: Record<string, number> | undefined): number {
  if (!timing) return 0;
  if (Number.isFinite(timing.total)) return timing.total ?? 0;
  return Object.entries(timing)
    .filter(([key, value]) => key !== 'total' && Number.isFinite(value))
    .reduce((sum, [, value]) => sum + value, 0);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index] ?? 0;
}
