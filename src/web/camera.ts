import type { CaptureConfig, CapturedFrame } from './types';

export class CameraCapture {
  readonly video: HTMLVideoElement;
  readonly canvas = document.createElement('canvas');
  #context: CanvasRenderingContext2D;
  #motionCanvas = document.createElement('canvas');
  #motionContext: CanvasRenderingContext2D;
  #motionReference: Uint8Array | null = null;
  #motionCandidate: Uint8Array | null = null;
  #stream: MediaStream | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    const context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context) throw new Error('2D canvas is unavailable.');
    this.#context = context;
    this.#motionCanvas.width = 32;
    this.#motionCanvas.height = 18;
    const motionContext = this.#motionCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!motionContext) throw new Error('Motion canvas is unavailable.');
    this.#motionContext = motionContext;
  }

  async start(): Promise<void> {
    this.stop();
    this.#motionReference = null;
    this.#motionCandidate = null;
    this.#stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.#stream;
    await this.video.play();
  }

  stop(): void {
    this.video.pause();
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    this.video.srcObject = null;
    this.#motionReference = null;
    this.#motionCandidate = null;
  }

  measureMotion(): number {
    if (!this.#stream || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return Number.POSITIVE_INFINITY;
    const { width, height } = this.#motionCanvas;
    this.#motionContext.drawImage(this.video, 0, 0, width, height);
    const rgba = this.#motionContext.getImageData(0, 0, width, height).data;
    const luma = new Uint8Array(width * height);
    for (let pixel = 0, offset = 0; pixel < luma.length; pixel += 1, offset += 4) {
      luma[pixel] = Math.round((rgba[offset] ?? 0) * 0.299 + (rgba[offset + 1] ?? 0) * 0.587 + (rgba[offset + 2] ?? 0) * 0.114);
    }
    this.#motionCandidate = luma;
    if (!this.#motionReference) return Number.POSITIVE_INFINITY;
    let difference = 0;
    for (let index = 0; index < luma.length; index += 1) difference += Math.abs((luma[index] ?? 0) - (this.#motionReference[index] ?? 0));
    return difference / luma.length;
  }

  commitMotionReference(): void {
    if (this.#motionCandidate) this.#motionReference = this.#motionCandidate.slice();
  }

  async capture(config: CaptureConfig): Promise<CapturedFrame> {
    if (!this.#stream || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      throw new Error('Camera frame is not ready.');
    }
    const startedAt = performance.now();
    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    const scale = Math.min(1, config.longEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const capturedAt = performance.now();
    this.#context.drawImage(this.video, 0, 0, width, height);
    const blob = await canvasToBlob(this.canvas, config.quality);
    const jpegReadyAt = performance.now();
    const imageBase64 = await blobToBase64(blob);
    return {
      imageBase64,
      capturedAt,
      width,
      height,
      bytes: blob.size,
      captureMs: jpegReadyAt - startedAt,
      encodeMs: performance.now() - jpegReadyAt,
    };
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('JPEG encoding failed.')), 'image/jpeg', quality);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Base64 encoding failed.'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}
