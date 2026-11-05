import { ArrowDown, ArrowUp, Camera, Check, Circle, Download, Flame, Hand, RefreshCw, Video, X, createIcons } from "lucide";
import { CaptureCamera, type CameraState, type CaptureFrame, type CapturePoint } from "./captureCamera";
import { HandSwipeTracker, handSample } from "./handSwipe";
import swipeProfile from "../public/gesture/swipe-profile.json";
import "./capture.css";

type Label = "up" | "down" | "idle";
type Variation = "natural" | "fast" | "slow" | "small" | "large" | "diagonal";
interface SavedFrame {
  timestamp_ms: number;
  landmarks: CapturePoint[];
  world_landmarks: CapturePoint[];
  hand: "Left" | "Right" | "";
  confidence: number;
}
interface RuleEvent { direction: "up" | "down"; timestamp_ms: number }
interface SampleSummary {
  id: string; created_at: string; label: Label; variation: Variation; note: string;
  duration_ms: number; excluded: boolean; tracking_ratio: number; frame_count: number;
  quality: string; vertical_range: number; horizontal_range: number; rule_events: RuleEvent[];
}
interface SampleData extends SampleSummary { frames: SavedFrame[]; motion_cue_ms: number }
interface Trial {
  id: string; label: Label; variation: Variation; note: string; duration: number;
  started: number; frames: SavedFrame[]; events: RuleEvent[]; camera: Record<string, string | number>;
}
interface Draft { metadata: Record<string, unknown>; video: Blob }
const LABELS: Record<Label, string> = { up: "上挥", down: "下挥", idle: "静止" };
const VARIATIONS: Record<Variation, string> = {
  natural: "自然", fast: "快速", slow: "缓慢", small: "小幅", large: "大幅", diagonal: "斜向",
};
const TARGETS: Record<Label, number> = { up: 6, down: 6, idle: 3 };
const studioUrl = import.meta.env.VITE_STUDIO_URL ?? "http://127.0.0.1:5173";
const app = document.querySelector<HTMLElement>("#capture-app")!;
app.innerHTML = `
  <div class="capture-shell">
    <header class="capture-header">
      <a class="capture-brand" href="${studioUrl}" target="_blank" rel="noopener">
        <i data-lucide="flame"></i><span>Bonfire<small>GESTURE STUDIO</small></span>
      </a>
      <span class="local-badge"><span></span> 本地采集${location.port ? ` · ${location.port}` : ""}</span>
      <button class="quiet-button" id="refresh-library"><i data-lucide="refresh-cw"></i> 刷新样本</button>
    </header>
    <div class="capture-heading">
      <div><span class="eyebrow">TEACH THE FIRE YOUR GESTURES</span><h1>让火焰认识你的挥动。</h1></div>
      <p>上挥加火，下挥减火。<br>先留下几组自然的动作，再用你的数据调整识别。</p>
    </div>
    <div class="capture-workspace">
      <section class="recording-workspace" aria-label="摄像头与手势采集">
        <div class="viewfinder" id="viewfinder" data-camera="off" data-stage="idle">
          <video id="capture-video" autoplay muted playsinline width="640" height="480" aria-label="实时摄像头预览"></video>
          <canvas id="capture-landmarks" width="320" height="240" aria-hidden="true"></canvas>
          <div class="camera-empty" id="camera-empty">
            <span class="camera-outline"><i data-lucide="hand"></i></span>
            <h2>把你的手，带进画面。</h2>
            <p>点击下方「开启摄像头」，允许摄像头权限。<br>整只手入镜，上挥时掌心朝上，下挥时朝下。</p>
          </div>
          <div class="finder-top"><span id="finder-label">↑ 上挥样本</span><span id="record-clock">待采集</span></div>
          <div class="motion-cue" id="motion-cue" hidden><strong id="cue-symbol">2</strong><span id="cue-text">准备</span></div>
          <div class="finder-bottom"><span id="tracking-state">等待摄像头</span><span>VIDEO + 21 LANDMARKS</span></div>
          <div class="record-progress"><span id="record-progress"></span></div>
        </div>
        <div class="camera-toolbar">
          <button class="quiet-button camera-button" id="camera-start"><i data-lucide="camera"></i><span>开启摄像头</span></button>
          <span id="camera-status" role="status">首次开启会申请摄像头权限</span>
          <span class="permission-status" id="camera-permission">权限：待授权</span>
        </div>
        <div class="capture-settings">
          <div class="field-block"><span class="field-label">01 · 动作标签</span>
            <div class="label-options" role="group" aria-label="采集动作">
              <button data-label="up" class="is-selected" aria-pressed="true"><i data-lucide="arrow-up"></i>上挥</button>
              <button data-label="down" aria-pressed="false"><i data-lucide="arrow-down"></i>下挥</button>
              <button data-label="idle" aria-pressed="false"><i data-lucide="circle"></i>静止</button>
            </div>
          </div>
          <label class="field-block"><span class="field-label">02 · 动作变化</span>
            <select id="capture-variation">${Object.entries(VARIATIONS).map(([key, text]) => `<option value="${key}">${text}</option>`).join("")}</select>
          </label>
          <label class="field-block"><span class="field-label">03 · 采集时长</span>
            <select id="capture-duration"><option value="3">3 秒 / 次</option><option value="5">5 秒 / 次</option></select>
          </label>
        </div>
        <label class="sample-note"><span>样本备注</span><input id="capture-note" maxlength="1000" placeholder="可选，例如：左手、坐姿、手掌离镜头较远" /></label>
        <div class="record-actions">
          <button class="primary-button" id="record-button" disabled><span class="record-dot"></span><span>开始采集上挥</span></button>
          <button class="quiet-button" id="cancel-record" hidden><i data-lucide="x"></i>取消本次</button>
          <button class="quiet-button" id="retry-save" hidden>重新保存</button>
          <button class="quiet-button" id="discard-draft" hidden>放弃未保存样本</button>
          <p id="record-instruction" role="status">倒数 2 秒 → 稍停 → 挥动一次 → 自动保存</p>
        </div>
        <details class="permission-help"><summary>没有弹出摄像头授权？</summary>
          <p>已经允许的站点不会再次弹窗。若权限被阻止，请点击地址栏旁的站点设置，将「摄像头」设为允许。
          Mac 还需在「系统设置 → 隐私与安全性 → 摄像头」中允许当前浏览器。</p>
        </details>
      </section>
      <aside class="sample-library" aria-label="已保存的手势样本">
        <div class="library-heading"><div><span class="eyebrow">YOUR DATASET</span><h2>已采集样本</h2></div><span id="sample-total">00</span></div>
        <div class="sample-counts">${(["up", "down", "idle"] as Label[]).map(label => `
          <div><span>${LABELS[label]}</span><strong id="count-${label}">0<small> / ${TARGETS[label]}</small></strong>
          <span class="count-track"><span id="progress-${label}"></span></span></div>`).join("")}</div>
        <p class="library-hint">建议上挥、下挥各 6 组，覆盖不同速度与幅度。</p>
        <div class="library-filters" role="group" aria-label="筛选样本">
          <button data-filter="all" class="is-selected" aria-pressed="true">全部</button>
          <button data-filter="up" aria-pressed="false">上挥</button>
          <button data-filter="down" aria-pressed="false">下挥</button>
          <button data-filter="idle" aria-pressed="false">静止</button>
        </div>
        <div class="sample-list" id="sample-list"><div class="library-empty">正在连接本地样本库…</div></div>
        <section class="sample-review" id="sample-review" hidden aria-label="样本回放与标注">
          <div class="review-heading"><strong id="review-title">样本回放</strong><button class="quiet-button" id="review-close" aria-label="关闭样本回放"><i data-lucide="x"></i></button></div>
          <video id="review-video" controls playsinline preload="metadata" aria-label="已保存样本视频"></video>
          <div class="trajectory-row"><canvas id="review-trajectory" width="320" height="100" aria-label="已保存样本掌心轨迹"></canvas><span>掌心<br>轨迹</span></div>
          <p class="review-stats" id="review-stats"></p>
          <div class="review-actions"><label>标签 <select id="review-label"><option value="up">上挥</option><option value="down">下挥</option><option value="idle">静止</option></select></label>
            <button class="quiet-button" id="exclude-sample">排除此样本</button>
            <a class="quiet-button" id="download-sample" download><i data-lucide="download"></i>JSON</a></div>
          <label class="review-note-label">备注 <input id="review-note" maxlength="1000" /><button class="quiet-button" id="save-review-note">保存</button></label>
        </section>
        <div class="storage-footer"><i data-lucide="check"></i><span id="storage-state">连接本地存储中</span><code>backend/recognize_data</code></div>
      </aside>
    </div>
    <footer class="capture-footer"><span>仅在本机采集与保存 · 不录制麦克风</span><span>每条样本包含视频、关键点、时间戳和人工标签</span></footer>
    <div class="capture-toast" id="capture-toast" role="status"></div>
  </div>`;
createIcons({ icons: { ArrowDown, ArrowUp, Camera, Check, Circle, Download, Flame, Hand, RefreshCw, Video, X } });

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing capture element: ${selector}`);
  return found;
}
const video = element<HTMLVideoElement>("#capture-video");
const finder = element("#viewfinder");
const recordButton = element<HTMLButtonElement>("#record-button");
const cameraButton = element<HTMLButtonElement>("#camera-start");
const instruction = element("#record-instruction");
const cue = element("#motion-cue");
const noteInput = element<HTMLInputElement>("#capture-note");
const variationInput = element<HTMLSelectElement>("#capture-variation");
const durationInput = element<HTMLSelectElement>("#capture-duration");
const tracker = new HandSwipeTracker(swipeProfile.parameters);
let label: Label = "up";
let filter: Label | "all" = "all";
let cameraState: CameraState = "off";
let stage: "idle" | "countdown" | "recording" | "saving" = "idle";
let trial: Trial | null = null;
let draft: Draft | null = null;
let recorder: MediaRecorder | null = null;
let cancelled = false;
let clockTimer = 0;
let toastTimer = 0;
let samples: SampleSummary[] = [];
let selectedId = "";
let libraryRequest = 0;
let reviewRequest = 0;
let storageOnline = false;
let previousFrame: CaptureFrame | null = null;

const camera = new CaptureCamera(video, element<HTMLCanvasElement>("#capture-landmarks"), (state, text) => {
  cameraState = state;
  finder.dataset.camera = state;
  if (state === "ready") finder.style.setProperty("--camera-aspect", String(video.videoWidth / video.videoHeight));
  element("#camera-empty").hidden = state === "ready" || state === "loading";
  element("#camera-status").textContent = text;
  cameraButton.querySelector("span")!.textContent = state === "off" || state === "error" ? "开启摄像头" : "关闭摄像头";
  if (state === "error" || state === "off") {
    abortTrial();
    element("#tracking-state").textContent = "等待摄像头";
  }
  void refreshPermission();
  syncButtons();
}, onFrame);

function onFrame(frame: CaptureFrame): void {
  previousFrame = frame;
  const palm = handSample(frame.landmarks, frame.worldLandmarks ?? [], frame.hand, frame.time, frame.confidence);
  const swipe = tracker.update(palm);
  element("#tracking-state").textContent = palm
    ? `${frame.hand === "Left" ? "左手" : frame.hand === "Right" ? "右手" : "手掌"}已识别 · ${Math.round(frame.confidence * 100)}%${swipe ? ` · 拟合识别：${LABELS[swipe]}` : ""}`
    : "未识别到手掌 · 录制会保留这段画面";
  if (stage !== "recording" || !trial || frame.time < trial.started) return;
  const time = frame.time - trial.started;
  trial.frames.push({
    timestamp_ms: time, hand: frame.hand, confidence: frame.confidence,
    landmarks: frame.landmarks, world_landmarks: frame.worldLandmarks ?? [],
  });
  if (swipe) trial.events.push({ direction: swipe, timestamp_ms: time });
}

function syncButtons(): void {
  const locked = stage !== "idle" || draft !== null;
  recordButton.disabled = !camera.isReady || locked || !storageOnline;
  recordButton.querySelector("span:last-child")!.textContent = stage === "saving" ? "正在保存…"
    : stage === "countdown" || stage === "recording" ? "采集中…" : `开始采集${LABELS[label]}`;
  document.querySelectorAll<HTMLButtonElement>("[data-label]").forEach(button => {
    button.disabled = locked;
    button.classList.toggle("is-selected", button.dataset.label === label);
    button.setAttribute("aria-pressed", String(button.dataset.label === label));
  });
  variationInput.disabled = locked;
  durationInput.disabled = locked;
  noteInput.disabled = locked;
  element("#cancel-record").hidden = stage !== "countdown" && stage !== "recording";
  element("#retry-save").hidden = !draft || stage === "saving";
  element("#discard-draft").hidden = !draft || stage === "saving";
  cameraButton.disabled = stage === "saving";
  finder.dataset.stage = stage;
  element("#finder-label").textContent = `${label === "up" ? "↑" : label === "down" ? "↓" : "○"} ${LABELS[label]}样本`;
}

async function refreshPermission(): Promise<void> {
  try {
    const status = await navigator.permissions.query({ name: "camera" as PermissionName });
    element("#camera-permission").textContent = `权限：${{ granted: "已允许", denied: "已阻止", prompt: "待授权" }[status.state]}`;
  } catch {
    element("#camera-permission").textContent = camera.stream ? "权限：已允许" : "点击开启申请权限";
  }
}

function startTrial(): void {
  if (!camera.isReady || !camera.stream || stage !== "idle" || draft) return;
  if (!previousFrame || performance.now() - previousFrame.time > 500) {
    toast("摄像头画面还未就绪，请稍等");
    return;
  }
  cancelled = false;
  const settings = camera.stream.getVideoTracks()[0].getSettings();
  trial = {
    id: crypto.randomUUID(), label, variation: variationInput.value as Variation, note: noteInput.value.trim(),
    duration: Number(durationInput.value) * 1000, started: 0, frames: [], events: [],
    camera: { width: settings.width ?? video.videoWidth, height: settings.height ?? video.videoHeight,
      frame_rate: settings.frameRate ?? 0, inference_width: 320, inference_height: 240, inference_hz_limit: 15 },
  };
  stage = "countdown";
  cue.hidden = false;
  const started = performance.now();
  updateCue("2", "准备，手掌放入画面");
  instruction.textContent = "倒数结束后稍停，再按照屏幕提示挥动一次";
  syncButtons();
  clockTimer = window.setInterval(() => {
    const remaining = Math.ceil((2000 - (performance.now() - started)) / 1000);
    if (remaining > 0) updateCue(String(remaining), "准备，手掌放入画面");
    else { window.clearInterval(clockTimer); beginRecording(); }
  }, 100);
}

function beginRecording(): void {
  if (!trial || !camera.stream || cancelled) return;
  try {
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/mp4", "video/webm"]
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error("当前浏览器没有可用的视频录制格式");
    recorder = new MediaRecorder(camera.stream, { mimeType: mime, videoBitsPerSecond: 1_200_000 });
    const chunks: Blob[] = [];
    const current = trial;
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { abortTrial(true); toast("录制失败，请重新采集"); };
    recorder.onstart = () => {
      if (cancelled || trial !== current) return;
      current.started = performance.now();
      tracker.reset();
      stage = "recording";
      syncButtons();
      clockTimer = window.setInterval(() => {
        if (!trial || stage !== "recording") return;
        const elapsed = performance.now() - current.started;
        element("#record-clock").textContent = `${(elapsed / 1000).toFixed(1)} / ${current.duration / 1000}s`;
        element("#record-progress").style.width = `${Math.min(100, elapsed / current.duration * 100)}%`;
        if (elapsed < 700) updateCue("·", "稍停，保持手掌");
        else updateCue(current.label === "up" ? "↑" : current.label === "down" ? "↓" : "○",
          current.label === "idle" ? "保持静止" : `现在${LABELS[current.label]}一次`);
        if (elapsed >= current.duration) {
          window.clearInterval(clockTimer);
          stage = "saving";
          cue.hidden = true;
          syncButtons();
          recorder?.stop();
        }
      }, 50);
    };
    recorder.onstop = () => {
      if (cancelled || trial !== current) return;
      const duration = performance.now() - current.started;
      if (!chunks.length || !current.frames.length) {
        abortTrial(true);
        toast("本次没有完整视频或关键点帧，请重新采集");
        return;
      }
      draft = {
        video: new Blob(chunks, { type: mime.split(";")[0] }),
        metadata: { client_id: current.id, label: current.label, variation: current.variation, note: current.note,
          duration_ms: duration, motion_cue_ms: 700, frames: current.frames, rule_events: current.events,
          detector: `MediaPipe 0.10.32 / palm-normal-tip-v1 / profile ${swipeProfile.dataset.sha256.slice(0, 12)}`,
          camera: current.camera, user_agent: navigator.userAgent.slice(0, 500) },
      };
      trial = null;
      recorder = null;
      void saveDraft();
    };
    recorder.start(250);
  } catch (error) {
    abortTrial(true);
    toast(error instanceof Error ? error.message : "录制未能启动");
  }
}

async function saveDraft(): Promise<void> {
  if (!draft) return;
  const pending = draft;
  stage = "saving";
  instruction.textContent = "正在将视频与关键点保存到本机…";
  syncButtons();
  const body = new FormData();
  body.append("data", JSON.stringify(pending.metadata));
  body.append("video", pending.video, pending.video.type === "video/mp4" ? "video.mp4" : "video.webm");
  try {
    const saved = await api<SampleSummary>("/samples", { method: "POST", body, signal: AbortSignal.timeout(20000) });
    draft = null;
    stage = "idle";
    instruction.textContent = `已保存${LABELS[saved.label]} · ${saved.frame_count} 帧 · 手掌覆盖 ${Math.round(saved.tracking_ratio * 100)}%`;
    toast(saved.quality === "review" ? "样本已保存，建议回放复查" : "样本已保存");
    await refreshLibrary();
    void openSample(saved.id);
  } catch (error) {
    stage = "idle";
    instruction.textContent = `保存未完成，样本仍在当前页面：${error instanceof Error ? error.message : "请重试"}`;
    toast("保存失败，可点击「重新保存」");
  } finally {
    cue.hidden = true;
    element("#record-clock").textContent = "待采集";
    element("#record-progress").style.width = "0%";
    syncButtons();
  }
}

function abortTrial(force = false): void {
  if (stage === "saving" && !force) return;
  cancelled = true;
  window.clearInterval(clockTimer);
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
  trial = null;
  stage = "idle";
  tracker.reset();
  cue.hidden = true;
  element("#record-progress").style.width = "0%";
  element("#record-clock").textContent = "待采集";
  instruction.textContent = "倒数 2 秒 → 稍停 → 挥动一次 → 自动保存";
  syncButtons();
}

function updateCue(symbol: string, text: string): void {
  element("#cue-symbol").textContent = symbol;
  if (element("#cue-text").textContent !== text) element("#cue-text").textContent = text;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/capture-api${path}`, { ...options, signal: options.signal ?? AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : `服务返回 ${response.status}`);
  return body as T;
}

async function refreshLibrary(): Promise<void> {
  const request = ++libraryRequest;
  try {
    const result = await api<{ items: SampleSummary[]; counts: Record<Label, number>; data_directory: string }>("/samples");
    if (request !== libraryRequest) return;
    samples = result.items;
    storageOnline = true;
    element("#sample-total").textContent = String(samples.length).padStart(2, "0");
    for (const name of ["up", "down", "idle"] as Label[]) {
      element(`#count-${name}`).innerHTML = `${result.counts[name]}<small> / ${TARGETS[name]}</small>`;
      element(`#progress-${name}`).style.width = `${Math.min(100, result.counts[name] / TARGETS[name] * 100)}%`;
    }
    element("#storage-state").textContent = "已连接本地存储";
    element("#storage-state").title = result.data_directory;
    renderLibrary();
  } catch {
    if (request !== libraryRequest) return;
    storageOnline = false;
    element("#storage-state").textContent = "存储未连接，请启动 8001 服务";
    element("#sample-list").textContent = "暂时无法读取样本库，点击右上角刷新重试。";
  } finally { syncButtons(); }
}

function renderLibrary(): void {
  const shown = samples.filter(sample => filter === "all" || sample.label === filter);
  const list = element("#sample-list");
  if (!shown.length) {
    list.innerHTML = `<div class="library-empty"><i data-lucide="video"></i><strong>${samples.length ? "这个动作还没有样本" : "你的第一组动作，从这里开始。"}</strong><p>开启摄像头，选择动作，点击开始采集。<br>保存后可在这里回放与标注。</p></div>`;
    createIcons({ icons: { Video } });
    return;
  }
  list.replaceChildren(...shown.map((sample, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `sample-row${selectedId === sample.id ? " is-selected" : ""}${sample.excluded ? " is-excluded" : ""}`;
    button.dataset.sampleId = sample.id;
    button.innerHTML = `<span class="sample-arrow">${sample.label === "up" ? "↑" : sample.label === "down" ? "↓" : "○"}</span>
      <span class="sample-copy"><strong>${LABELS[sample.label]} · ${VARIATIONS[sample.variation]}<small>${String(shown.length - index).padStart(2, "0")}</small></strong>
      <span>${new Date(sample.created_at).toLocaleTimeString("zh-CN", { hour12: false })} · ${(sample.duration_ms / 1000).toFixed(1)}s · ${sample.frame_count} 帧</span></span>
      <span class="sample-quality ${sample.quality}">${sample.excluded ? "已排除" : sample.quality === "review" ? "需复查" : "已保存"}</span>`;
    button.addEventListener("click", () => void openSample(sample.id));
    return button;
  }));
}

async function openSample(id: string): Promise<void> {
  const request = ++reviewRequest;
  selectedId = id;
  renderLibrary();
  try {
    const sample = await api<SampleData>(`/samples/${id}`);
    if (request !== reviewRequest) return;
    element("#sample-review").hidden = false;
    element("#review-title").textContent = `${LABELS[sample.label]} · ${VARIATIONS[sample.variation]}`;
    const player = element<HTMLVideoElement>("#review-video");
    player.src = `/capture-api/samples/${id}/video`;
    element<HTMLSelectElement>("#review-label").value = sample.label;
    element<HTMLInputElement>("#review-note").value = sample.note;
    element("#exclude-sample").textContent = sample.excluded ? "恢复此样本" : "排除此样本";
    element<HTMLAnchorElement>("#download-sample").href = `/capture-api/samples/${id}/data`;
    const predictions = sample.rule_events.map(event => LABELS[event.direction]).join("、") || "未触发";
    const summary = samples.find(item => item.id === id);
    if (!summary) return;
    element("#review-stats").textContent = `覆盖 ${Math.round(summary.tracking_ratio * 100)}% · 纵向位移 ${Math.round(summary.vertical_range * 100)}% · 录制时识别：${predictions}`;
    drawTrajectory(sample.frames);
  } catch (error) { toast(error instanceof Error ? error.message : "样本读取失败"); }
}

function drawTrajectory(frames: SavedFrame[]): void {
  const canvas = element<HTMLCanvasElement>("#review-trajectory");
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgba(255,255,255,0.06)";
  context.lineWidth = 1;
  for (const y of [25, 50, 75]) { context.beginPath(); context.moveTo(0, y); context.lineTo(320, y); context.stroke(); }
  context.strokeStyle = "#d4a768";
  context.lineWidth = 2;
  const end = Math.max(1, frames.at(-1)?.timestamp_ms ?? 1);
  let penDown = false;
  context.beginPath();
  for (const frame of frames) {
    if (frame.landmarks.length !== 21) { penDown = false; continue; }
    const y = [0, 5, 9, 13, 17].reduce((sum, i) => sum + frame.landmarks[i].y, 0) / 5;
    const x = frame.timestamp_ms / end * 312 + 4;
    if (penDown) context.lineTo(x, y * 80 + 10); else context.moveTo(x, y * 80 + 10);
    penDown = true;
  }
  context.stroke();
}

async function annotate(patch: { label?: Label; note?: string; excluded?: boolean }): Promise<void> {
  const id = selectedId;
  if (!id) return;
  try {
    await api(`/samples/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    await refreshLibrary();
    if (selectedId === id) await openSample(id);
    toast("样本标注已保存");
  } catch { toast("标注保存失败，请重试"); }
}

function toast(text: string): void {
  window.clearTimeout(toastTimer);
  const notification = element("#capture-toast");
  notification.textContent = text;
  notification.classList.add("is-visible");
  toastTimer = window.setTimeout(() => notification.classList.remove("is-visible"), 3000);
}

document.querySelectorAll<HTMLButtonElement>("[data-label]").forEach(button => button.addEventListener("click", () => {
  label = button.dataset.label as Label;
  syncButtons();
}));
document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach(button => button.addEventListener("click", () => {
  filter = button.dataset.filter as Label | "all";
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach(tab => {
    tab.classList.toggle("is-selected", tab === button);
    tab.setAttribute("aria-pressed", String(tab === button));
  });
  renderLibrary();
}));
cameraButton.addEventListener("click", () => {
  if (cameraState === "requesting" || cameraState === "loading" || cameraState === "ready") camera.stop();
  else void camera.start();
});
recordButton.addEventListener("click", startTrial);
element("#cancel-record").addEventListener("click", () => abortTrial());
element("#retry-save").addEventListener("click", () => void saveDraft());
element("#discard-draft").addEventListener("click", () => { draft = null; abortTrial(); });
element("#refresh-library").addEventListener("click", () => void refreshLibrary());
element("#review-close").addEventListener("click", () => {
  reviewRequest++;
  selectedId = "";
  element<HTMLVideoElement>("#review-video").pause();
  element("#sample-review").hidden = true;
  renderLibrary();
});
element<HTMLSelectElement>("#review-label").addEventListener("change", event =>
  void annotate({ label: (event.target as HTMLSelectElement).value as Label }));
element("#exclude-sample").addEventListener("click", () => {
  const sample = samples.find(item => item.id === selectedId);
  if (sample) void annotate({ excluded: !sample.excluded });
});
element("#save-review-note").addEventListener("click", () => void annotate({ note: element<HTMLInputElement>("#review-note").value.trim() }));
document.addEventListener("visibilitychange", () => {
  tracker.reset();
  previousFrame = null;
  if (document.hidden && (stage === "countdown" || stage === "recording")) { abortTrial(); toast("页面切到后台，本次采集已取消"); }
});
window.addEventListener("pagehide", () => { abortTrial(); camera.dispose(); }, { once: true });
window.addEventListener("beforeunload", event => {
  if (draft || stage === "recording" || stage === "saving") { event.preventDefault(); event.returnValue = ""; }
});
void refreshPermission();
void refreshLibrary();
