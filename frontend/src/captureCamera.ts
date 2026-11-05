export interface CapturePoint { x: number; y: number; z: number }
export interface CaptureFrame {
  time: number;
  landmarks: CapturePoint[];
  worldLandmarks: CapturePoint[];
  hand: "Left" | "Right" | "";
  confidence: number;
}
export type CameraState = "off" | "requesting" | "loading" | "ready" | "error";

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15],
  [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export class CaptureCamera {
  private media: MediaStream | null = null;
  private worker: Worker | null = null;
  private generation = 0;
  private timer = 0;
  private loadTimer = 0;
  private busy = false;
  private ready = false;
  private lastFrame = 0;
  private context: CanvasRenderingContext2D | null;
  private readonly visibility = (): void => {
    window.clearTimeout(this.timer);
    if (!document.hidden) this.schedule();
  };

  constructor(
    private readonly video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    private readonly status: (state: CameraState, text: string) => void,
    private readonly result: (frame: CaptureFrame) => void,
  ) {
    this.context = canvas.getContext("2d");
    document.addEventListener("visibilitychange", this.visibility);
  }

  get stream(): MediaStream | null { return this.media; }
  get isReady(): boolean { return this.ready; }

  async start(): Promise<void> {
    if (this.media || this.worker) return;
    const generation = ++this.generation;
    this.status("requesting", "请在浏览器中允许摄像头");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("secure-camera");
      }
      if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined"
        || typeof MediaRecorder === "undefined") throw new Error("unsupported-browser");
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 }, facingMode: "user" },
        audio: false,
      });
      if (generation !== this.generation) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      this.media = media;
      media.getVideoTracks()[0].addEventListener("ended", () => {
        if (generation === this.generation) this.fail("摄像头已断开，请重新开启");
      }, { once: true });
      this.video.srcObject = media;
      await this.video.play();
      if (generation !== this.generation) return;
      this.status("loading", "摄像头已开启，正在载入手部模型…");
      const root = new URL(`${import.meta.env.BASE_URL}gesture/`, location.href);
      const worker = new Worker(new URL("hand-worker.js", root));
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        if (data.type === "ready") {
          window.clearTimeout(this.loadTimer);
          this.ready = true;
          this.status("ready", "摄像头已就绪 · 可以开始采集");
          this.schedule();
        } else if (data.type === "error") {
          this.fail("手部模型加载或运行失败，请重新开启摄像头");
        } else if (data.type === "result") {
          this.busy = false;
          if (!document.hidden) {
            this.draw(data.landmarks);
            this.result(data as CaptureFrame);
          }
          this.schedule();
        }
      };
      worker.onerror = () => {
        if (generation === this.generation) this.fail("手部模型资源加载失败，请重试");
      };
      this.loadTimer = window.setTimeout(() => {
        if (generation === this.generation) this.fail("模型加载超时，请重新开启");
      }, 30000);
      worker.postMessage({ type: "init", assetRoot: root.href, includeWorld: true });
    } catch (error) {
      if (generation !== this.generation) return;
      const name = error instanceof Error ? error.name : "";
      const message = error instanceof Error ? error.message : "";
      this.fail(name === "NotAllowedError" || name === "SecurityError"
        ? "摄像头被阻止：请点击地址栏的站点设置允许摄像头，并检查系统隐私权限"
        : name === "NotFoundError" ? "没有找到摄像头，请连接设备后重试"
          : name === "NotReadableError" ? "摄像头被其他应用占用或被系统阻止，请检查后重试"
            : message === "secure-camera" ? "请用 localhost / 127.0.0.1 或 HTTPS 打开采集页"
              : message === "unsupported-browser" ? "请使用新版 Chrome、Edge 或 Safari 进行采集"
                : "摄像头启动失败，请重新开启");
    }
  }

  stop(): void {
    this.release();
    this.status("off", "摄像头未开启");
  }

  dispose(): void {
    this.release();
    document.removeEventListener("visibilitychange", this.visibility);
  }

  private fail(message: string): void {
    this.release();
    this.status("error", message);
  }

  private release(): void {
    this.generation++;
    this.ready = false;
    this.busy = false;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.loadTimer);
    this.worker?.terminate();
    this.worker = null;
    this.media?.getTracks().forEach(track => track.stop());
    this.media = null;
    this.video.pause();
    this.video.srcObject = null;
    this.context?.clearRect(0, 0, 320, 240);
  }

  private schedule(): void {
    if (!this.ready || this.busy || document.hidden) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.capture(),
      Math.max(0, 1000 / 15 - (performance.now() - this.lastFrame)));
  }

  private async capture(): Promise<void> {
    if (!this.worker || this.busy || !this.ready || document.hidden) return;
    const generation = this.generation;
    this.busy = true;
    this.lastFrame = performance.now();
    try {
      const bitmap = await createImageBitmap(this.video, { resizeWidth: 320, resizeHeight: 240 });
      if (generation !== this.generation || !this.worker || document.hidden) {
        bitmap.close();
        if (generation === this.generation) { this.busy = false; this.schedule(); }
        return;
      }
      this.worker.postMessage({ type: "frame", bitmap, time: this.lastFrame, epoch: 0 }, [bitmap]);
    } catch {
      if (generation === this.generation) this.fail("摄像头画面读取失败，请重试");
    }
  }

  private draw(points: CapturePoint[]): void {
    const context = this.context;
    if (!context) return;
    context.clearRect(0, 0, 320, 240);
    if (points.length !== 21) return;
    context.strokeStyle = "rgba(248, 195, 120, 0.9)";
    context.lineWidth = 1.3;
    context.beginPath();
    for (const [a, b] of CONNECTIONS) {
      context.moveTo(points[a].x * 320, points[a].y * 240);
      context.lineTo(points[b].x * 320, points[b].y * 240);
    }
    context.stroke();
    context.fillStyle = "#ffebcb";
    for (const point of points) {
      context.beginPath();
      context.arc(point.x * 320, point.y * 240, 1.8, 0, Math.PI * 2);
      context.fill();
    }
  }
}
