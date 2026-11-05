import { HandSwipeTracker, handSample, type HandSwipe, type HandPoint } from "./handSwipe";
import swipeProfile from "../public/gesture/swipe-profile.json";

interface HandWorkerMessage {
  type: "ready" | "result" | "error";
  time: number;
  epoch: number;
  landmarks: HandPoint[];
  worldLandmarks: HandPoint[];
  confidence: number;
  hand: string;
}

interface HandControlElements {
  panel: HTMLElement;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  status: HTMLElement;
  button: HTMLButtonElement;
  retry: HTMLButtonElement;
}

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15],
  [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export class HandControl {
  private readonly tracker = new HandSwipeTracker(swipeProfile.parameters);
  private readonly context: CanvasRenderingContext2D | null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private timer = 0;
  private loadTimer = 0;
  private generation = 0;
  private epoch = 0;
  private ready = false;
  private busy = false;
  private paused = false;
  private active = false;
  private lastFrameAt = 0;
  private lastGestureAt = -Infinity;
  private frames = 0;
  private swipes = 0;
  private readonly visibilityChanged = (): void => this.suspendChanged();
  private readonly pageHidden = (): void => this.stop();

  constructor(
    private readonly elements: HandControlElements,
    private readonly onSwipe: (direction: HandSwipe) => string,
  ) {
    this.context = elements.canvas.getContext("2d");
    document.addEventListener("visibilitychange", this.visibilityChanged);
    window.addEventListener("pagehide", this.pageHidden);
  }

  get isEnabled(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.active) return;
    const generation = ++this.generation;
    this.active = true;
    this.frames = 0;
    this.swipes = 0;
    this.lastGestureAt = -Infinity;
    this.elements.panel.hidden = false;
    this.elements.panel.dataset.frames = "0";
    this.elements.panel.dataset.swipes = "0";
    this.elements.retry.hidden = true;
    this.syncButton();
    this.setStatus("requesting", "请允许使用摄像头");
    try {
      if (!window.isSecureContext) throw new Error("insecure-context");
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera-unsupported");
      if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined"
        || typeof createImageBitmap === "undefined") throw new Error("worker-unsupported");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 } },
        audio: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (generation === this.generation) this.fail("摄像头已断开，请重新开启");
        }, { once: true });
      }
      this.elements.video.srcObject = stream;
      await this.elements.video.play();
      if (generation !== this.generation) return;
      this.setStatus("loading", "正在准备手势识别…");
      const assetRoot = new URL(`${import.meta.env.BASE_URL}gesture/`, location.href);
      const worker = new Worker(new URL("hand-worker.js", assetRoot));
      this.worker = worker;
      worker.onmessage = ({ data }: MessageEvent<HandWorkerMessage>) => {
        if (generation !== this.generation) return;
        if (data.type === "ready") {
          window.clearTimeout(this.loadTimer);
          this.ready = true;
          this.setStatus(this.suspended ? "paused" : "searching",
            this.suspended ? "已暂停手势控制" : "掌心朝上托举加火，朝下压动减火");
          this.scheduleFrame();
        } else if (data.type === "error") {
          this.fail("识别未能启动，请重试或更新浏览器");
        } else if (data.type === "result") {
          this.busy = false;
          this.frames++;
          this.elements.panel.dataset.frames = String(this.frames);
          if (!this.suspended && data.epoch === this.epoch) this.handleResult(data);
          this.scheduleFrame();
        }
      };
      worker.onerror = () => {
        if (generation === this.generation) this.fail("识别资源加载失败，请重试");
      };
      this.loadTimer = window.setTimeout(() => {
        if (generation === this.generation) this.fail("识别加载超时，请重试");
      }, 30000);
      worker.postMessage({ type: "init", assetRoot: assetRoot.href, includeWorld: true });
    } catch (error) {
      if (generation !== this.generation) return;
      const name = error instanceof Error ? error.name : "";
      const message = error instanceof Error ? error.message : "";
      const detail = name === "NotAllowedError" || name === "SecurityError"
        ? "摄像头权限未开启，请在浏览器中允许后重试"
        : name === "NotFoundError" ? "未找到摄像头，请连接后重试"
          : name === "NotReadableError" ? "摄像头暂不可用，请关闭占用它的应用后重试"
            : message === "insecure-context" ? "手势控制需要 HTTPS 或 localhost"
              : message.endsWith("unsupported") ? "当前浏览器不支持，请使用新版 Chrome 或 Safari"
                : "摄像头启动失败，请重试";
      this.fail(detail);
    }
  }

  stop(): void {
    this.release();
    this.elements.panel.hidden = true;
    this.elements.panel.dataset.state = "off";
    this.elements.retry.hidden = true;
    this.context?.clearRect(0, 0, 320, 240);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.suspendChanged();
  }

  dispose(): void {
    this.stop();
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    window.removeEventListener("pagehide", this.pageHidden);
  }

  private get suspended(): boolean {
    return this.paused || document.hidden;
  }

  private suspendChanged(): void {
    this.epoch++;
    this.tracker.reset();
    window.clearTimeout(this.timer);
    if (!this.active || !this.ready) return;
    this.setStatus(this.suspended ? "paused" : "searching",
      this.suspended ? "已暂停手势控制" : "掌心朝上托举加火，朝下压动减火");
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (!this.active || !this.ready || this.busy || this.suspended) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.captureFrame(),
      Math.max(0, 1000 / 12 - (performance.now() - this.lastFrameAt)));
  }

  private async captureFrame(): Promise<void> {
    if (!this.active || !this.worker || this.busy || this.suspended) return;
    if (this.elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.lastFrameAt = performance.now();
      this.scheduleFrame();
      return;
    }
    this.busy = true;
    const generation = this.generation;
    const epoch = this.epoch;
    const time = performance.now();
    this.lastFrameAt = time;
    try {
      const bitmap = await createImageBitmap(this.elements.video, {
        resizeWidth: 320, resizeHeight: 240, resizeQuality: "low",
      });
      if (generation !== this.generation || !this.worker || this.suspended || epoch !== this.epoch) {
        bitmap.close();
        if (generation === this.generation) {
          this.busy = false;
          this.scheduleFrame();
        }
        return;
      }
      this.worker.postMessage({ type: "frame", bitmap, time, epoch }, [bitmap]);
    } catch {
      if (generation === this.generation) this.fail("摄像头画面读取失败，请重试");
    }
  }

  private handleResult(data: HandWorkerMessage): void {
    this.drawHand(data.landmarks);
    const palm = handSample(data.landmarks, data.worldLandmarks ?? [], data.hand, data.time, data.confidence);
    const swipe = this.tracker.update(palm);
    if (swipe) {
      this.lastGestureAt = performance.now();
      this.swipes++;
      this.elements.panel.dataset.swipes = String(this.swipes);
      this.setStatus(swipe, this.onSwipe(swipe));
    } else if (performance.now() - this.lastGestureAt > 1100) {
      this.setStatus(palm ? "tracking" : "searching",
        palm ? "已识别手掌 · 上托加火，下压减火" : "将整只手放入画面，向上托或向下压");
    }
  }

  private drawHand(points: HandPoint[]): void {
    const context = this.context;
    if (!context) return;
    context.clearRect(0, 0, 320, 240);
    if (points.length !== 21) return;
    context.strokeStyle = "rgba(255, 183, 110, 0.8)";
    context.lineWidth = 1.5;
    context.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      context.moveTo(points[a].x * 320, points[a].y * 240);
      context.lineTo(points[b].x * 320, points[b].y * 240);
    }
    context.stroke();
    context.fillStyle = "#ffe3be";
    for (const point of points) {
      context.beginPath();
      context.arc(point.x * 320, point.y * 240, 2, 0, Math.PI * 2);
      context.fill();
    }
  }

  private fail(message: string): void {
    this.release();
    this.context?.clearRect(0, 0, 320, 240);
    this.setStatus("error", message);
    this.elements.retry.hidden = false;
  }

  private release(): void {
    this.generation++;
    this.active = false;
    this.ready = false;
    this.busy = false;
    this.tracker.reset();
    window.clearTimeout(this.timer);
    window.clearTimeout(this.loadTimer);
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.elements.video.pause();
    this.elements.video.srcObject = null;
    this.syncButton();
  }

  private syncButton(): void {
    const button = this.elements.button;
    button.setAttribute("aria-pressed", String(this.active));
    button.title = this.active ? "关闭手势控制" : "开启摄像头手势控制";
    button.setAttribute("aria-label", button.title);
  }

  private setStatus(state: string, text: string): void {
    this.elements.panel.dataset.state = state;
    if (this.elements.status.textContent !== text) this.elements.status.textContent = text;
  }
}
