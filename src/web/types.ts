export type Question = {
  id: string;
  label: string;
  type: 'noul' | 'choice';
  instructions: string;
  criteria?: string[];
};

export type CaptureConfig = {
  longEdge: number;
  quality: number;
};

export type ChoiceMethod = 'independent' | 'letter';
export type Backend = 'glance' | 'mlx-8bit';

export type CapturedFrame = {
  imageBase64: string;
  capturedAt: number;
  width: number;
  height: number;
  bytes: number;
  captureMs: number;
  encodeMs: number;
};

export type GlanceAnswer = {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  noul?: number;
  raw?: number;
};

export type DecideResponse = {
  answers: Record<string, GlanceAnswer>;
  timing_ms?: Record<string, number>;
  model?: string;
  request_id?: string;
  speedlab: {
    traceId: string;
    upstreamMs: number;
    gatewayMs: number;
    requestBytes: number;
    responseBytes: number;
    backend: Backend;
    choiceMethod: ChoiceMethod;
  };
};

export type Sample = {
  sequence: number;
  at: number;
  capturedAt: number;
  loopMs: number;
  requestMs: number;
  capture: Omit<CapturedFrame, 'imageBase64' | 'capturedAt'>;
  response: DecideResponse;
};
