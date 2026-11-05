import {
  Bot,
  ChevronDown,
  Flame,
  Hand,
  Info,
  Keyboard,
  KeyRound,
  Maximize2,
  MessageCircle,
  Minimize2,
  MousePointerClick,
  Move,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Volume2,
  VolumeX,
  X,
  createIcons,
} from "lucide";
import "./styles.css";
import { AgentRequestError, BonfireAgent, initialAssistantMessage } from "./agent";
import { ApiKeyStore, validApiKey } from "./apiKey";
import { FireAudio } from "./audio";
import { FireScene } from "./fireScene";
import { burnAudioLevel } from "./fireIntensity";
import { windDirectionAngle } from "./fireWind";
import { HandControl } from "./handControl";
import { FireReadout } from "./fireReadout";
import {
  DEFAULT_CONFIG,
  FLAME_TONE_COLORS,
  PRESETS,
  NUMERIC_LIMITS,
  clampConfigPatch,
  type ChatMessage,
  type FireSceneConfig,
  type FireScenePatch,
} from "./types";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("App root not found");
const staticDeployment = import.meta.env.VITE_STATIC_DEPLOYMENT === "true";

app.innerHTML = `
  <section class="studio-shell${staticDeployment ? " is-static-deployment" : ""}" aria-label="Bonfire 交互式篝火工作台">
    <div class="scene-host" id="scene-host"></div>
    <div class="scene-shade" aria-hidden="true"></div>

    <header class="topbar">
      <div class="brand-lockup">
        <span class="brand-mark"><i data-lucide="flame"></i></span>
        <div>
          <strong>Bonfire</strong>
          <span>INTERACTIVE FIRE</span>
        </div>
      </div>
      <div class="scene-status" aria-label="实时渲染状态">
        <span class="live-dot"></span>
        <span>LIVE</span>
        <span class="status-rule"></span>
        <span id="fps-label">-- FPS</span>
      </div>
      <div class="topbar-actions">
        <button class="icon-button" id="pause-button" type="button" title="暂停动画" aria-label="暂停动画">
          <i data-lucide="pause"></i>
        </button>
        <button class="icon-button" id="audio-button" type="button" title="开启篝火声音" aria-label="开启篝火声音">
          <i data-lucide="volume-x"></i>
        </button>
        <button class="icon-button" id="immersive-button" type="button" title="沉浸模式" aria-label="沉浸模式">
          <i data-lucide="maximize-2"></i>
        </button>
        <button class="icon-button" id="hand-control-button" type="button" title="开启摄像头手势控制"
          aria-label="开启摄像头手势控制" aria-pressed="false" aria-controls="hand-control">
          <i data-lucide="hand"></i>
        </button>
        <button class="icon-button" id="interaction-help-button" type="button" title="交互说明" aria-label="交互说明"
          popovertarget="interaction-guide" aria-controls="interaction-guide" aria-expanded="false">
          <i data-lucide="info"></i>
        </button>
        <button class="icon-button panel-toggle" id="panel-toggle" type="button" title="展开工作台" aria-label="展开工作台">
          <i data-lucide="sliders-horizontal"></i>
        </button>
      </div>
    </header>

    <section class="hand-control" id="hand-control" hidden aria-label="摄像头手势控制" data-state="off">
      <div class="hand-control-header">
        <span><i data-lucide="hand"></i> 手势控制</span>
        <button class="icon-button" id="hand-control-close" type="button" aria-label="关闭摄像头">
          <i data-lucide="x"></i>
        </button>
      </div>
      <div class="hand-camera">
        <video id="hand-video" width="320" height="240" autoplay muted playsinline aria-label="手势摄像头预览"></video>
        <canvas id="hand-landmarks" width="320" height="240" aria-hidden="true"></canvas>
        <span class="hand-camera-badge"><span></span> CAMERA</span>
      </div>
      <div class="hand-directions" aria-label="上挥增大火势，下挥减小火势">
        <span><b>↑</b> 上挥 <strong>+25%</strong></span>
        <span><b>↓</b> 下挥 <strong>−25%</strong></span>
      </div>
      <p id="hand-control-status" role="status" aria-live="polite">掌心朝上托举加火，朝下压动减火</p>
      <button class="hand-retry" id="hand-control-retry" type="button" hidden>重新开启</button>
      <small>画面仅在本地识别 · 关闭即停用摄像头</small>
    </section>

    <section class="interaction-guide" id="interaction-guide" popover="auto"
      aria-labelledby="interaction-guide-title">
      <div class="guide-header">
        <div>
          <span class="eyebrow">INTERACTION GUIDE</span>
          <h2 id="interaction-guide-title">交互说明</h2>
        </div>
        <button class="icon-button guide-close" type="button" aria-label="关闭交互说明"
          popovertarget="interaction-guide" popovertargetaction="hide">
          <i data-lucide="x"></i>
        </button>
      </div>
      <ul class="guide-actions">
        <li class="guide-primary">
          <i data-lucide="move"></i>
          <div><strong>按住拖动 · 控制风向</strong>
            <p id="guide-wind-detail">向哪拖就向哪吹；上拖向里，下拖向外。</p>
            <small>松开保留风向，风力大小在「调节」中设置。</small>
          </div>
        </li>
        <li>
          <i data-lucide="mouse-pointer-click"></i>
          <div><strong>单击场景 · 添柴助燃</strong>
            <p id="guide-boost-detail">每次添柴增加 10 个百分点的火势，并激起一簇火星。</p>
          </div>
        </li>
        <li>
          <i data-lucide="keyboard"></i>
          <div><strong>方向键 · 调整火势与风向</strong>
            <p>↑ / ↓ 每次增减 10 个百分点火势；← / → 每次转动 10° 风向。</p>
            <small>按住可连续调整，左右键可接管自动风向；输入框和滑块内保留原有按键操作。</small>
          </div>
        </li>
        <li>
          <i data-lucide="hand"></i>
          <div><strong>手势 · 隔空调整火势</strong>
            <p>点击顶部手掌图标开启摄像头。掌心朝上向上托举加火，掌心朝下向下压动减火，每次 25 个百分点。</p>
            <small>整只手入镜，可以自然回位后连续挥动；暂停动画时手势也暂停。</small>
          </div>
        </li>
        <li>
          <i data-lucide="sliders-horizontal"></i>
          <div><strong>调节 · 修改场景参数</strong><p>风向滑块可转动小旗子，360° 调整吹向；也可调整火势、光线、音量与画质。</p></div>
        </li>
        <li class="guide-agent">
          <i data-lucide="message-circle"></i>
          <div><strong>Agent · 用文字控制</strong><p>例如「左吹 1 秒，右吹 1 秒，循环」。</p></div>
        </li>
        <li>
          <i data-lucide="volume-2"></i>
          <div><strong>声音 · 开启 / 静音</strong><p>收听木柴噼啪声与阵风声。</p></div>
        </li>
        <li>
          <i data-lucide="maximize-2"></i>
          <div><strong>沉浸模式</strong><p>隐藏控件，移动鼠标可唤回。</p></div>
        </li>
      </ul>
      <div class="guide-footer">
        <i data-lucide="undo-2"></i>
        <span><kbd>⌘ / Ctrl Z</kbd> 撤销参数 <span class="guide-footer-dot">·</span> <kbd>Esc</kbd> 关闭说明</span>
      </div>
    </section>

    <div class="scene-caption" id="scene-caption" aria-hidden="true">
      <span class="caption-detail" id="scene-caption-detail">
        <span class="caption-fire-value" id="caption-fire-value"></span>
        <span class="caption-fire-unit">% 火势</span>
        <span class="caption-fire-delta" id="caption-fire-delta" hidden></span>
        <span>·</span>
        <span class="caption-wind-value" id="caption-wind-value">10</span>
        <span class="caption-wind-unit">% 风力</span>
        <span id="caption-wind" hidden></span>
      </span>
    </div>

    <div class="interaction-hint" id="interaction-hint">
      <span id="wind-hint">点击鼠标，按拖动方向产生风向</span>
      <span class="hint-rule"></span>
      <span>点击火焰添柴</span>
    </div>

    <aside class="studio-panel" id="studio-panel" aria-label="篝火控制工作台">
      <div class="panel-top">
        <div class="panel-tabs" role="tablist">
          <button class="panel-tab is-active" data-tab="agent" type="button" role="tab" aria-selected="true">
            <i data-lucide="message-circle"></i>
            <span>Agent</span>
          </button>
          <button class="panel-tab" data-tab="controls" type="button" role="tab" aria-selected="false">
            <i data-lucide="settings-2"></i>
            <span>调节</span>
          </button>
        </div>
        <button class="icon-button panel-close" id="panel-close" type="button" title="收起工作台" aria-label="收起工作台">
          <i data-lucide="x"></i>
        </button>
      </div>

      <section class="tab-view agent-view is-active" id="agent-view" role="tabpanel">
        <div class="agent-heading">
          <div>
            <span class="eyebrow">SCENE AGENT</span>
            <h1>告诉我你想看到的篝火</h1>
          </div>
          <span class="model-status" id="model-status">
            <span></span>
            检查中
          </span>
        </div>

        <div class="conversation" id="conversation" aria-live="polite"></div>

        <div class="quick-prompts" aria-label="快捷指令">
          <button type="button" data-prompt="让火焰更旺盛一些，但保持现在的颜色">火势更旺</button>
          <button type="button" data-prompt="把火焰改成紫色，只改颜色">紫色火焰</button>
        </div>

        <form class="composer" id="composer">
          <div class="composer-key-row">
            <button class="api-key-button" id="api-key-button" type="button"
              aria-haspopup="dialog" aria-controls="api-key-dialog">
              <i data-lucide="key-round"></i><span id="api-key-button-label">输入 API Key</span>
            </button>
          </div>
          <label for="agent-input">场景指令</label>
          <textarea
            id="agent-input"
            rows="2"
            placeholder="例如：改成深夜余烬，风再小一点"
            autocomplete="off"
          ></textarea>
          <div class="composer-footer">
            <span id="composer-state">GLM 5.3 Flash</span>
            <button class="send-button" id="send-button" type="submit">
              <span>执行</span>
              <i data-lucide="sparkles"></i>
            </button>
          </div>
        </form>

        <button class="undo-button" id="undo-button" type="button" disabled>
          <i data-lucide="undo-2"></i>
          <span>撤销上一步</span>
          <kbd>⌘ Z</kbd>
        </button>
      </section>

      <section class="tab-view controls-view" id="controls-view" role="tabpanel">
        <div class="control-scroll">
          <section class="control-section">
            <div class="section-heading">
              <span class="eyebrow">MOOD</span>
              <h2>场景预设</h2>
            </div>
            <div class="preset-grid">
              <button class="preset-button is-active" data-preset="warm" type="button">
                <span class="preset-swatch warm"></span>
                <strong>温暖陪伴</strong>
                <small>稳定 · 柔和</small>
              </button>
              <button class="preset-button" data-preset="embers" type="button">
                <span class="preset-swatch embers"></span>
                <strong>深夜余烬</strong>
                <small>微火 · 安静</small>
              </button>
              <button class="preset-button" data-preset="blaze" type="button">
                <span class="preset-swatch blaze"></span>
                <strong>旺盛篝火</strong>
                <small>高火 · 活跃</small>
              </button>
            </div>
          </section>

          <section class="control-section">
            <div class="section-heading inline">
              <div>
                <span class="eyebrow">FIRE</span>
                <h2>核心参数</h2>
              </div>
              <button class="text-button" id="reset-button" type="button">
                <i data-lucide="rotate-ccw"></i>
                重置
              </button>
            </div>
            <div class="slider-list">
              ${sliderMarkup("burnIntensity", "燃烧强度", "持续保持设定火势，0% 熄火，最高 400%", DEFAULT_CONFIG.burnIntensity)}
              ${sliderMarkup("charGlowIntensity", "炭火红热亮度", "单独调节木柴与炭床的暗红余烬，0% 关闭", 70)}
              ${sliderMarkup("windSpeed", "风力", "中档侧弯、强风拉伸火舌；0% 停风", 10)}
              <div class="wind-direction-control">
                <div class="wind-direction-heading">
                  <label for="wind-angle">风向</label>
                  <span>360° ROTATION</span>
                </div>
                <div class="wind-direction-preview">
                  <div class="wind-flag-stage" aria-hidden="true">
                    <div class="wind-compass"></div>
                    <span class="wind-cardinal into">里</span>
                    <span class="wind-cardinal left">左</span>
                    <span class="wind-cardinal right">右</span>
                    <span class="wind-cardinal out">外</span>
                    <div class="wind-flag-view">
                      <div class="wind-flag" id="wind-flag">
                        <span class="wind-flag-cloth"></span>
                        <span class="wind-flag-stitch"></span>
                      </div>
                      <span class="wind-flag-pole"></span>
                      <span class="wind-flag-cap"></span>
                    </div>
                    <span class="wind-flag-base"></span>
                  </div>
                  <div class="wind-direction-reading">
                    <output id="wind-angle-value" for="wind-angle">90°</output>
                    <span id="wind-direction-label">向场景里吹</span>
                    <small id="wind-direction-mode">滑块 / 鼠标控制</small>
                  </div>
                </div>
                <input id="wind-angle" type="range" min="0" max="360" step="1" value="90"
                  aria-label="风向角度" aria-describedby="wind-direction-scale wind-direction-help" />
                <div class="wind-direction-scale" id="wind-direction-scale">
                  <span>0° 右</span><span>90° 里</span><span>180° 左</span><span>270° 外</span><span>360° 右</span>
                </div>
                <small id="wind-direction-help">拖动滑块，旗子绕杆转向；火焰与风车同步。</small>
              </div>
              ${sliderMarkup("sparkBurstFrequency", "两侧爆裂频率", "左右独立随机喷溅，0% 关闭自动爆裂", 35)}
              ${sliderMarkup("environmentLight", "环境亮度", "独立控制背景与环境光", 20)}
              ${sliderMarkup("volume", "篝火音量", "控制木柴噼啪声与轻微风声", 55)}
            </div>
          </section>

          <details class="advanced-controls">
            <summary>
              <span>
                <span class="eyebrow">PHYSICS</span>
                <strong>更多调节</strong>
              </span>
              <i data-lucide="chevron-down"></i>
            </summary>
            <div class="slider-list advanced-list">
              ${sliderMarkup("flameHeight", "火焰高度", "微调火舌纵向尺度", 58)}
              ${sliderMarkup("turbulence", "湍流强度", "控制卷曲和局部不稳定性", 52)}
              ${sliderMarkup("smokeDensity", "烟雾浓度", "控制烟雾产生量", 20)}
              ${sliderMarkup("emberRate", "火星数量", "控制持续飘出的火星密度", 38)}
              ${sliderMarkup("environmentTemperature", "环境色温", "在冷夜与暖夜之间变化", 42)}
              ${sliderMarkup("fireLight", "火光强度", "控制火焰对周围场景的照明", 72)}
            </div>
            <label class="select-control">
              <span>
                <strong>燃烧色调</strong>
                <small>选择预设会恢复自然火焰颜色</small>
              </span>
              <select data-config-select="flameTone">
                <option value="ember">暗红余烬</option>
                <option value="gold" selected>自然金黄</option>
                <option value="white-hot">白热中心</option>
              </select>
            </label>
            <div class="custom-color-control">
              <div class="color-control-heading">
                <label for="flame-color-value">自定义火焰颜色</label>
                <button class="text-button" id="flame-color-reset" type="button" disabled>恢复预设</button>
              </div>
              <div class="color-control-inputs">
                <input id="flame-color-picker" type="color" value="#ffa44e" aria-label="选择火焰颜色" />
                <input id="flame-color-value" type="text" maxlength="7" placeholder="使用预设色调"
                  spellcheck="false" autocomplete="off" aria-label="火焰十六进制颜色" />
              </div>
              <small>任意颜色均可；也可以对 Agent 说「绿色的火」。</small>
            </div>
            <label class="select-control">
              <span>
                <strong>输入映射</strong>
                <small>自然语言也可以修改该映射</small>
              </span>
              <select data-config-select="interactionMode">
                <option value="cursor-wind">鼠标控制风向</option>
                <option value="click-boost">点击增强火势</option>
                <option value="both" selected>两者同时</option>
              </select>
            </label>
          </details>

          <section class="control-section quality-section">
            <div class="section-heading">
              <span class="eyebrow">RENDER</span>
              <h2>实时质量</h2>
            </div>
            <div class="quality-control" role="group" aria-label="实时画质">
              <button type="button" data-quality="low">低</button>
              <button type="button" data-quality="medium">中</button>
              <button class="is-active" type="button" data-quality="high">高</button>
            </div>
            <p>高画质保留更细的火舌和火星轨迹；设备负载较高时可切换中、低画质。</p>
          </section>
        </div>
      </section>
    </aside>

    <div class="toast" id="toast" role="status"></div>
    <dialog class="api-key-dialog" id="api-key-dialog" aria-labelledby="api-key-title"
      aria-describedby="api-key-description">
      <form id="api-key-form">
        <div class="api-key-dialog-header">
          <div><span class="eyebrow">SCENE AGENT</span><h2 id="api-key-title">连接你的模型</h2></div>
          <button class="icon-button" id="api-key-close" type="button" aria-label="关闭 API Key 设置">
            <i data-lucide="x"></i>
          </button>
        </div>
        <p id="api-key-description">输入智谱 API Key，用于 Agent 对话。</p>
        <label class="api-key-field" for="api-key-input">
          <span>API Key</span>
          <input id="api-key-input" type="password" placeholder="粘贴你的 API Key"
            autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="api-key-feedback" />
        </label>
        <label class="api-key-remember">
          <input id="api-key-remember" type="checkbox" checked />
          <span>记住此浏览器，下次自动使用</span>
        </label>
        <p class="api-key-feedback" id="api-key-feedback" role="status" aria-live="polite"></p>
        <div class="api-key-dialog-footer">
          <button class="text-button" id="api-key-clear" type="button" disabled>清除 Key</button>
          <button class="send-button" type="submit">保存并使用</button>
        </div>
      </form>
    </dialog>
  </section>
`;

function sliderMarkup(key: keyof typeof NUMERIC_LIMITS, label: string, help: string, value: number): string {
  const [min, max] = NUMERIC_LIMITS[key];
  return `
    <label class="slider-control" data-slider="${key}">
      <span class="slider-copy">
        <span>
          <strong>${label}</strong>
          <small>${help}</small>
        </span>
        <output>${value}%</output>
      </span>
      <input type="range" min="${min}" max="${max}" value="${value}" data-config-key="${key}" />
    </label>
  `;
}

createIcons({
  icons: {
    Bot,
    ChevronDown,
    Flame,
    Hand,
    Info,
    Keyboard,
    KeyRound,
    Maximize2,
    MessageCircle,
    Minimize2,
    MousePointerClick,
    Move,
    Pause,
    Play,
    RotateCcw,
    Settings2,
    SlidersHorizontal,
    Sparkles,
    Undo2,
    Volume2,
    VolumeX,
    X,
  },
});

const sceneHost = requiredElement<HTMLElement>("#scene-host");
const panel = requiredElement<HTMLElement>("#studio-panel");
const conversation = requiredElement<HTMLElement>("#conversation");
const agentInput = requiredElement<HTMLTextAreaElement>("#agent-input");
const sendButton = requiredElement<HTMLButtonElement>("#send-button");
const undoButton = requiredElement<HTMLButtonElement>("#undo-button");
const toast = requiredElement<HTMLElement>("#toast");
const modelStatus = requiredElement<HTMLElement>("#model-status");
const composerState = requiredElement<HTMLElement>("#composer-state");
const apiKeyButton = requiredElement<HTMLButtonElement>("#api-key-button");
const apiKeyDialog = requiredElement<HTMLDialogElement>("#api-key-dialog");
const apiKeyInput = requiredElement<HTMLInputElement>("#api-key-input");
const apiKeyRemember = requiredElement<HTMLInputElement>("#api-key-remember");
const apiKeyClear = requiredElement<HTMLButtonElement>("#api-key-clear");
const apiKeyFeedback = requiredElement<HTMLElement>("#api-key-feedback");
const interactionGuide = requiredElement<HTMLElement>("#interaction-guide");
const interactionHelpButton = requiredElement<HTMLButtonElement>("#interaction-help-button");
const flameColorPicker = requiredElement<HTMLInputElement>("#flame-color-picker");
const flameColorValue = requiredElement<HTMLInputElement>("#flame-color-value");
const flameColorReset = requiredElement<HTMLButtonElement>("#flame-color-reset");
const windAngleInput = requiredElement<HTMLInputElement>("#wind-angle");
const windFlag = requiredElement<HTMLElement>("#wind-flag");
const windAngleValue = requiredElement<HTMLOutputElement>("#wind-angle-value");
const windDirectionLabel = requiredElement<HTMLElement>("#wind-direction-label");
const windDirectionMode = requiredElement<HTMLElement>("#wind-direction-mode");
const windDirectionHelp = requiredElement<HTMLElement>("#wind-direction-help");

const agent = new BonfireAgent();
const apiKeyStore = new ApiKeyStore();
const audio = new FireAudio();
let config: FireSceneConfig = { ...DEFAULT_CONFIG };
audio.setVolume(config.volume / 100);
audio.setIntensity(burnAudioLevel(config.burnIntensity));
audio.setWind(config.windSpeed / 100);
const undoStack: FireSceneConfig[] = [];
const messages: ChatMessage[] = [initialAssistantMessage()];
let activePreset = "warm";
let paused = false;
let immersive = false;
let sending = false;
let agentOnline = false;
let revealTimer = 0;
let toastTimer = 0;
let flameColorPickerEditing = false;
let windAngleStart: Pick<FireSceneConfig, "windAngle" | "windMode"> | null = null;
let windIndicatorState = "";
const heldSceneKeys = new Set<string>();

const fireScene = new FireScene(sceneHost, config);
const fireReadout = new FireReadout(
  requiredElement<HTMLElement>("#caption-fire-value"),
  requiredElement<HTMLElement>("#caption-fire-delta"),
  requiredElement<HTMLElement>("#scene-caption"),
);
const handControl = new HandControl({
  panel: requiredElement<HTMLElement>("#hand-control"),
  video: requiredElement<HTMLVideoElement>("#hand-video"),
  canvas: requiredElement<HTMLCanvasElement>("#hand-landmarks"),
  status: requiredElement<HTMLElement>("#hand-control-status"),
  button: requiredElement<HTMLButtonElement>("#hand-control-button"),
  retry: requiredElement<HTMLButtonElement>("#hand-control-retry"),
}, (direction) => {
  const [min, max] = NUMERIC_LIMITS.burnIntensity;
  const next = Math.max(min, Math.min(max, config.burnIntensity + (direction === "up" ? 25 : -25)));
  if (next === config.burnIntensity) return next === 0 ? "火势已到 0% · 已熄火" : "火势已到上限 400%";
  activePreset = "";
  applyPatch({ burnIntensity: next }, "", true, true);
  updatePresetState();
  return `${direction === "up" ? "↑ 上挥加火" : "↓ 下挥减火"} · ${Math.round(next)}%`;
});
// 自动循环时只更新方向指示，不写回配置或打断周期。
const windObserver = new MutationObserver(() => {
  if (config.windMode === "manual" || windAngleStart) return;
  const wind = JSON.parse(sceneHost.dataset.wind ?? "{}") as { targetVector?: number[] };
  if (wind.targetVector) syncWindDirection(windDirectionAngle(wind.targetVector[0], wind.targetVector[2]));
});
windObserver.observe(sceneHost, { attributes: true, attributeFilter: ["data-wind"] });
window.addEventListener("beforeunload", () => {
  windObserver.disconnect();
  handControl.dispose();
  fireReadout.dispose();
  audio.dispose();
  fireScene.dispose();
}, { once: true });
fireScene.setFpsCallback((fps) => {
  requiredElement<HTMLElement>("#fps-label").textContent = `${fps} FPS`;
  sceneHost.dataset.audio = JSON.stringify(audio.statistics);
});
sceneHost.addEventListener("fire-boost", () => {
  const next = Math.min(NUMERIC_LIMITS.burnIntensity[1], config.burnIntensity + 10);
  if (next !== config.burnIntensity) {
    activePreset = "";
    applyPatch({ burnIntensity: next }, "", true, true);
    updatePresetState();
  }
  audio.burst();
});
sceneHost.addEventListener("wind-direction-change", (event) => {
  const { angle } = (event as CustomEvent<{ angle: number }>).detail;
  config = { ...config, windAngle: angle };
  syncWindDirection(angle);
});
interactionGuide.addEventListener("toggle", () => {
  interactionHelpButton.setAttribute("aria-expanded", String(interactionGuide.matches(":popover-open")));
});

renderConversation();
syncControls();
syncApiKeyState();
if (staticDeployment) {
  switchTab("controls");
} else {
  checkAgentHealth();
}
if (window.matchMedia("(max-width: 900px)").matches) {
  setPanel(false);
}

document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab ?? "agent"));
});

document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const name = button.dataset.preset;
    if (!name || !PRESETS[name]) return;
    activePreset = name;
    applyPatch(PRESETS[name], "已切换场景预设");
    updatePresetState();
  });
});

document.querySelectorAll<HTMLInputElement>("[data-config-key]").forEach((input) => {
  input.addEventListener("pointerdown", () => {
    input.dataset.startValue = String(config[input.dataset.configKey as keyof FireSceneConfig]);
  });
  input.addEventListener("input", () => {
    const key = input.dataset.configKey as keyof FireSceneConfig;
    const value = Number(input.value);
    config = { ...config, [key]: value };
    fireScene.setConfig(config);
    if (key === "volume") audio.setVolume(value / 100);
    if (key === "burnIntensity") audio.setIntensity(burnAudioLevel(value));
    if (key === "windSpeed") audio.setWind(value / 100);
    syncControls(false);
    activePreset = "";
    updatePresetState();
  });
  input.addEventListener("change", () => {
    const key = input.dataset.configKey as keyof FireSceneConfig;
    const startValue = Number(input.dataset.startValue);
    if (Number.isFinite(startValue) && startValue !== Number(input.value)) {
      const previous = { ...config, [key]: startValue };
      undoStack.push(previous);
      trimUndoStack();
      updateUndoState();
    }
  });
});

document.querySelectorAll<HTMLSelectElement>("[data-config-select]").forEach((select) => {
  select.addEventListener("change", () => {
    const key = select.dataset.configSelect as keyof FireSceneConfig;
    applyPatch({ [key]: select.value } as FireScenePatch, "场景映射已更新");
    activePreset = "";
    updatePresetState();
  });
});

windAngleInput.addEventListener("pointerdown", beginWindAngleEdit);
windAngleInput.addEventListener("input", () => {
  beginWindAngleEdit();
  config = { ...config, windMode: "manual", windAngle: Number(windAngleInput.value) };
  fireScene.setConfig(config);
  activePreset = "";
  syncControls(false);
  updatePresetState();
});
windAngleInput.addEventListener("change", finishWindAngleEdit);
windAngleInput.addEventListener("blur", finishWindAngleEdit);
windAngleInput.addEventListener("pointercancel", finishWindAngleEdit);

flameColorPicker.addEventListener("pointerdown", () => { flameColorPickerEditing = false; });
flameColorPicker.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") flameColorPickerEditing = false;
});
flameColorPicker.addEventListener("blur", () => { flameColorPickerEditing = false; });
flameColorPicker.addEventListener("input", () => {
  // 首次有效预览记录原色，后续拖动即时应用，不重复增加撤销或弹出提示。
  if (changeFlameColor(flameColorPicker.value, !flameColorPickerEditing, false)) {
    flameColorPickerEditing = true;
  }
});
flameColorPicker.addEventListener("change", () => {
  changeFlameColor(flameColorPicker.value, !flameColorPickerEditing);
  flameColorPickerEditing = false;
});
flameColorValue.addEventListener("change", () => changeFlameColor(flameColorValue.value.trim() || null));
flameColorValue.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    flameColorValue.blur();
  }
});
flameColorReset.addEventListener("click", () => changeFlameColor(null));

document.querySelectorAll<HTMLButtonElement>("[data-quality]").forEach((button) => {
  button.addEventListener("click", () => {
    const quality = button.dataset.quality as FireSceneConfig["quality"];
    applyPatch({ quality }, `实时画质已切换为${button.textContent ?? ""}`);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    agentInput.value = button.dataset.prompt ?? "";
    agentInput.focus();
  });
});

requiredElement<HTMLFormElement>("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendAgentCommand();
});

agentInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendAgentCommand();
  }
});

requiredElement<HTMLButtonElement>("#pause-button").addEventListener("click", () => {
  paused = !paused;
  fireScene.setPaused(paused);
  handControl.setPaused(paused);
  setIcon("#pause-button", paused ? "play" : "pause");
  const button = requiredElement<HTMLButtonElement>("#pause-button");
  button.title = paused ? "继续动画" : "暂停动画";
  button.setAttribute("aria-label", button.title);
  showToast(paused ? "动画已暂停" : "动画继续");
});

requiredElement<HTMLButtonElement>("#hand-control-button").addEventListener("click", () => {
  if (handControl.isEnabled) handControl.stop();
  else void handControl.start();
});
requiredElement<HTMLButtonElement>("#hand-control-close").addEventListener("click", () => handControl.stop());
requiredElement<HTMLButtonElement>("#hand-control-retry").addEventListener("click", () => void handControl.start());

requiredElement<HTMLButtonElement>("#audio-button").addEventListener("click", async () => {
  const button = requiredElement<HTMLButtonElement>("#audio-button");
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.title = audio.isEnabled ? "正在静音" : "正在准备篝火声音";
  try {
    const enabled = await audio.toggle();
    setIcon("#audio-button", enabled ? "volume-2" : "volume-x");
    showToast(enabled
      ? audio.statistics.recordingLoaded ? "木柴噼啪声已开启" : "木柴爆裂声已开启，录音暂不可用"
      : "篝火声音已静音");
  } catch {
    showToast("声音未能启动，请再点击一次");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.title = audio.isEnabled ? "关闭篝火声音" : "开启篝火声音";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(audio.isEnabled));
  }
});

requiredElement<HTMLButtonElement>("#immersive-button").addEventListener("click", () => {
  setImmersive(!immersive);
});

requiredElement<HTMLButtonElement>("#panel-toggle").addEventListener("click", () => setPanel(true));
requiredElement<HTMLButtonElement>("#panel-close").addEventListener("click", () => setPanel(false));
requiredElement<HTMLButtonElement>("#reset-button").addEventListener("click", () => {
  activePreset = "warm";
  applyConfig({ ...DEFAULT_CONFIG }, "已恢复默认火焰");
  updatePresetState();
});
undoButton.addEventListener("click", undo);

apiKeyButton.addEventListener("click", openApiKeyDialog);
requiredElement<HTMLButtonElement>("#api-key-close").addEventListener("click", () => apiKeyDialog.close());
apiKeyDialog.addEventListener("close", () => { apiKeyInput.value = ""; });
apiKeyDialog.addEventListener("click", (event) => {
  if (event.target !== apiKeyDialog) return;
  const bounds = apiKeyDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) apiKeyDialog.close();
});
apiKeyInput.addEventListener("input", () => {
  apiKeyInput.removeAttribute("aria-invalid");
  apiKeyFeedback.textContent = "";
});
requiredElement<HTMLFormElement>("#api-key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = apiKeyInput.value.trim() || apiKeyStore.value;
  if (!validApiKey(value)) {
    apiKeyFeedback.textContent = "请输入有效的 API Key，不能包含空格或换行。";
    apiKeyInput.setAttribute("aria-invalid", "true");
    apiKeyInput.focus();
    return;
  }
  const saved = apiKeyStore.save(value, apiKeyRemember.checked);
  syncApiKeyState();
  apiKeyInput.value = "";
  apiKeyDialog.close();
  agentInput.focus();
  showToast(saved
    ? apiKeyStore.remembered ? "API Key 已保存，下次自动使用" : "API Key 已设置，仅本次页面使用"
    : "浏览器缓存不可用，API Key 仅在本次页面使用");
});
apiKeyClear.addEventListener("click", () => {
  const cleared = apiKeyStore.clear();
  apiKeyInput.value = "";
  apiKeyInput.placeholder = "粘贴你的 API Key";
  apiKeyRemember.checked = true;
  apiKeyFeedback.textContent = cleared ? "API Key 已清除。" : "本次 Key 已清除，浏览器缓存暂时无法访问。";
  syncApiKeyState();
  apiKeyInput.focus();
});

document.addEventListener("keydown", (event) => {
  if (apiKeyDialog.open) {
    if (event.key === "Escape") {
      event.preventDefault();
      apiKeyDialog.close();
    }
    return;
  }
  if (event.key === "Escape" && interactionGuide.matches(":popover-open")) {
    event.preventDefault();
    interactionGuide.hidePopover();
    interactionHelpButton.focus();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    event.preventDefault();
    undo();
  }
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    if (event.defaultPrevented || event.isComposing ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        interactionGuide.matches(":popover-open") ||
        (event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable], [role=slider], [role=spinbutton], [role=textbox]"))) return;
    event.preventDefault();
    const fireKey = event.key === "ArrowUp" || event.key === "ArrowDown";
    let patch: FireScenePatch;
    if (fireKey) {
      const [min, max] = NUMERIC_LIMITS.burnIntensity;
      const intensity = Math.max(min, Math.min(max,
        config.burnIntensity + (event.key === "ArrowUp" ? 10 : -10)));
      if (intensity === config.burnIntensity) return;
      patch = { burnIntensity: intensity };
    } else {
      const currentAngle = config.windMode === "manual" ? config.windAngle : Number(windAngleInput.value);
      const angle = (currentAngle + (event.key === "ArrowLeft" ? 10 : -10) + 360) % 360;
      patch = { windMode: "manual", windAngle: angle };
    }
    const recordHistory = !heldSceneKeys.has(event.key);
    heldSceneKeys.add(event.key);
    activePreset = "";
    applyPatch(patch, "", recordHistory, fireKey);
    updatePresetState();
  }
  if (event.key === "Escape" && immersive) setImmersive(false);
});
document.addEventListener("keyup", (event) => heldSceneKeys.delete(event.key));
window.addEventListener("blur", () => heldSceneKeys.clear());

document.addEventListener("pointermove", () => {
  if (!immersive) return;
  if (!document.body.classList.contains("immersive-reveal")) document.body.classList.add("immersive-reveal");
  window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(() => {
    document.body.classList.remove("immersive-reveal");
  }, 2500);
});

async function sendAgentCommand(): Promise<void> {
  const prompt = agentInput.value.trim();
  if (!prompt || sending) return;
  const apiKey = apiKeyStore.value;
  if (!apiKey) {
    openApiKeyDialog();
    apiKeyFeedback.textContent = "先设置 API Key，再执行你的指令。";
    return;
  }
  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: prompt,
  };
  messages.push(userMessage);
  renderConversation();
  agentInput.value = "";
  setSending(true);

  try {
    const result = await agent.send(prompt, config, apiKey);
    const tool = result.response.tool_calls[0];
    if (tool?.name === "update_fire_scene") {
      const patch = clampConfigPatch(tool.arguments?.patch ?? {});
      if (Object.keys(patch).length > 0) {
        applyPatch(patch, "", true);
      }
    } else if (tool?.name === "reset_fire_scene") {
      activePreset = "warm";
      applyConfig({ ...DEFAULT_CONFIG }, "", true);
      updatePresetState();
    }
    messages.push(result.assistantMessage);
    setAgentStatus(true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "模型调用失败";
    messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: `${detail}。现场参数没有变化。`,
      error: true,
      usage: error instanceof AgentRequestError ? error.usage : undefined,
    });
    setAgentStatus(false);
  } finally {
    setSending(false);
    renderConversation();
  }
}

function applyPatch(patch: FireScenePatch, notice = "", recordHistory = true, animateBurn = false): void {
  const safePatch = clampConfigPatch(patch);
  applyConfig({ ...config, ...safePatch }, notice, recordHistory, animateBurn);
}

function changeFlameColor(value: string | null, recordHistory = true, notify = true): boolean {
  const patch = clampConfigPatch({ flameColor: value });
  if (patch.flameColor === undefined) {
    flameColorValue.setAttribute("aria-invalid", "true");
    showToast("请输入有效的十六进制颜色，例如 #00FF66");
    return false;
  }
  const changed = patch.flameColor !== config.flameColor;
  flameColorValue.removeAttribute("aria-invalid");
  activePreset = "";
  const notice = patch.flameColor ? `火焰颜色已设为 ${patch.flameColor}` : "已恢复预设色调";
  applyPatch(patch, notify ? notice : "", recordHistory);
  updatePresetState();
  return changed;
}

function applyConfig(next: FireSceneConfig, notice = "", recordHistory = true, animateBurn = false): void {
  finishWindAngleEdit();
  if (JSON.stringify(next) === JSON.stringify(config)) return;
  if (recordHistory) {
    flameColorPickerEditing = false;
    undoStack.push({ ...config });
    trimUndoStack();
  }
  config = { ...next };
  fireScene.setConfig(config);
  audio.setVolume(config.volume / 100);
  audio.setIntensity(burnAudioLevel(config.burnIntensity));
  audio.setWind(config.windSpeed / 100);
  syncControls(true, animateBurn);
  updateUndoState();
  if (notice) showToast(notice);
}

function undo(): void {
  heldSceneKeys.clear();
  finishWindAngleEdit();
  flameColorPickerEditing = false;
  const previous = undoStack.pop();
  if (!previous) return;
  config = previous;
  fireScene.setConfig(config);
  audio.setVolume(config.volume / 100);
  audio.setIntensity(burnAudioLevel(config.burnIntensity));
  audio.setWind(config.windSpeed / 100);
  activePreset = "";
  syncControls();
  updatePresetState();
  updateUndoState();
  messages.push({
    id: crypto.randomUUID(),
    role: "assistant",
    content: "已撤销上一步，火焰恢复到之前的状态。",
    toolLabel: "undo_scene_change",
  });
  renderConversation();
  showToast("已撤销上一步");
}

function syncControls(syncValues = true, animateBurn = false): void {
  const wind = JSON.parse(sceneHost.dataset.wind ?? "{}") as { mode?: string; angle?: number };
  syncWindDirection(config.windMode === "manual" ? config.windAngle
    : wind.mode === config.windMode && wind.angle !== undefined ? wind.angle
      : config.windDirection === "left" ? 180 : 0);
  document.querySelectorAll<HTMLInputElement>("[data-config-key]").forEach((input) => {
    const key = input.dataset.configKey as keyof FireSceneConfig;
    const value = config[key];
    if (typeof value !== "number") return;
    if (syncValues) input.value = String(Math.round(value));
    const output = input.closest(".slider-control")?.querySelector("output");
    if (output) output.textContent = `${Math.round(value)}%`;
    const progress = (value - Number(input.min)) / Math.max(1, Number(input.max) - Number(input.min)) * 100;
    input.style.setProperty("--range-progress", `${progress}%`);
  });
  document.querySelectorAll<HTMLSelectElement>("[data-config-select]").forEach((select) => {
    const key = select.dataset.configSelect as keyof FireSceneConfig;
    if (syncValues) select.value = String(config[key]);
  });
  if (syncValues) {
    flameColorPicker.value = config.flameColor ?? FLAME_TONE_COLORS[config.flameTone];
    flameColorValue.value = config.flameColor ?? "";
    flameColorValue.removeAttribute("aria-invalid");
  }
  flameColorReset.disabled = config.flameColor === null;
  document.querySelectorAll<HTMLButtonElement>("[data-quality]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.quality === config.quality);
  });
  fireReadout.setValue(config.burnIntensity, animateBurn);
  requiredElement<HTMLElement>("#caption-wind-value").textContent = String(Math.round(config.windSpeed));
  const left = `左 ${config.windLeftSeconds} 秒`, right = `右 ${config.windRightSeconds} 秒`;
  const cycle = config.windDirection === "left" ? `${left} → ${right}` : `${right} → ${left}`;
  const windStatus = config.windMode === "alternating" ? `${cycle} · 循环`
    : config.windMode === "fixed" ? `持续向${config.windDirection === "left" ? "左" : "右"}吹` : "";
  const windCaption = requiredElement<HTMLElement>("#caption-wind");
  windCaption.textContent = windStatus ? `· ${windStatus}` : "";
  windCaption.hidden = !windStatus;
  requiredElement<HTMLElement>("#wind-hint").textContent = config.windMode === "manual"
    ? "点击鼠标，按拖动方向产生风向" : "Agent 控制风向 · 方向键或滑块可接管";
  requiredElement<HTMLElement>("#guide-wind-detail").textContent = config.windMode !== "manual"
    ? "当前由 Agent 控制，左右方向键或「调节」中的风向滑块即可接管。"
    : config.interactionMode === "click-boost"
      ? "当前拖动控制已关闭，可在「更多调节」中启用。"
      : "向哪拖就向哪吹；上拖向里，下拖向外。";
  requiredElement<HTMLElement>("#guide-boost-detail").textContent = config.interactionMode === "cursor-wind"
    ? "当前点击增强已关闭，可在「更多调节」中启用。"
    : "每次添柴增加 10 个百分点的火势，并激起一簇火星。";
}

function beginWindAngleEdit(): void {
  if (windAngleStart) return;
  windAngleStart = { windAngle: config.windAngle, windMode: config.windMode };
  windFlag.classList.add("is-adjusting");
}

function finishWindAngleEdit(): void {
  const start = windAngleStart;
  windAngleStart = null;
  windFlag.classList.remove("is-adjusting");
  if (!start || (start.windAngle === config.windAngle && start.windMode === config.windMode)) return;
  // 一次拖动只保存一条撤销，同时保留其间其他参数的最新值。
  undoStack.push({ ...config, ...start });
  trimUndoStack();
  updateUndoState();
}

function syncWindDirection(angle: number): void {
  const degrees = Math.round(angle);
  const state = `${config.windMode}:${degrees}:${config.interactionMode}`;
  if (state === windIndicatorState) return;
  windIndicatorState = state;
  const labels = ["向右吹", "向右后方吹", "向场景里吹", "向左后方吹",
    "向左吹", "向左前方吹", "向场景外吹", "向右前方吹"];
  const direction = labels[Math.round(degrees / 45) % 8];
  windAngleInput.value = String(degrees);
  windAngleInput.setAttribute("aria-valuetext", `${degrees} 度，${direction}`);
  windAngleInput.style.setProperty("--range-progress", `${degrees / 360 * 100}%`);
  windFlag.style.setProperty("--wind-angle", `${angle}deg`);
  windAngleValue.value = `${degrees}°`;
  windDirectionLabel.textContent = direction;
  windDirectionMode.textContent = config.windMode === "alternating" ? "Agent · 左右循环"
    : config.windMode === "fixed" ? "Agent · 固定风向"
      : config.interactionMode === "click-boost" ? "滑块 / 键盘控制" : "滑块 / 鼠标 / 键盘";
  windDirectionHelp.textContent = config.windMode === "manual"
    ? "拖动滑块，旗子绕杆转向；火焰与风车同步。"
    : "旗子跟随 Agent 风向；左右方向键或拖动滑块即可接管。";
}

function updatePresetState(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.preset === activePreset);
  });
}

function switchTab(tab: string): void {
  if (staticDeployment) tab = "controls";
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll<HTMLElement>(".tab-view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `${tab}-view`);
  });
}

function renderConversation(): void {
  conversation.innerHTML = messages
    .map(
      (message) => `
        <article class="message ${message.role} ${message.error ? "is-error" : ""}">
          ${
            message.role === "assistant"
              ? `<span class="message-avatar"><i data-lucide="bot"></i></span>`
              : ""
          }
          <div class="message-body">
            <p>${escapeHtml(message.content)}</p>
            ${
              message.toolLabel
                ? `<span class="tool-call"><span></span>${escapeHtml(message.toolLabel)}</span>`
                : ""
            }
            ${
              message.role === "assistant" && message.usage
                ? `<div class="token-usage" aria-label="本次模型 Token 用量">
                    <span>输入 <b>${formatTokens(message.usage.input_tokens)}</b></span>
                    <span>输出 <b>${formatTokens(message.usage.output_tokens)}</b></span>
                    <span class="token-unit">Tokens</span>
                  </div>`
                : ""
            }
          </div>
        </article>
      `,
    )
    .join("");
  createIcons({ icons: { Bot } });
  conversation.scrollTop = conversation.scrollHeight;
}

function setSending(value: boolean): void {
  sending = value;
  sendButton.disabled = value;
  agentInput.disabled = value;
  apiKeyButton.disabled = value;
  composerState.textContent = value ? "正在解析并调用工具…" : "GLM 5.3 Flash";
  sendButton.classList.toggle("is-loading", value);
}

async function checkAgentHealth(): Promise<void> {
  try {
    const response = await fetch("/api/health", { signal: AbortSignal.timeout(2200) });
    setAgentStatus(response.ok);
  } catch {
    setAgentStatus(false);
  }
}

function setAgentStatus(online: boolean): void {
  agentOnline = online;
  syncApiKeyState();
}

function syncApiKeyState(): void {
  const hasKey = Boolean(apiKeyStore.value);
  requiredElement<HTMLElement>("#api-key-button-label").textContent = hasKey ? "API Key 已设置" : "输入 API Key";
  apiKeyButton.classList.toggle("is-configured", hasKey);
  apiKeyClear.disabled = !hasKey;
  modelStatus.classList.toggle("is-online", hasKey && agentOnline);
  modelStatus.innerHTML = `<span></span>${hasKey ? agentOnline ? "已连接" : "未连接" : "待设置 Key"}`;
}

function openApiKeyDialog(): void {
  apiKeyInput.value = "";
  apiKeyInput.placeholder = apiKeyStore.value ? "已设置；输入新 Key 可替换" : "粘贴你的 API Key";
  apiKeyRemember.checked = apiKeyStore.value ? apiKeyStore.remembered : true;
  apiKeyInput.removeAttribute("aria-invalid");
  apiKeyFeedback.textContent = apiKeyStore.value
    ? apiKeyStore.remembered ? "当前 Key 已缓存在此浏览器。" : "当前 Key 仅在本次页面使用。" : "";
  apiKeyDialog.showModal();
  apiKeyInput.focus();
}

function formatTokens(value: number | null): string {
  return value === null ? "未返回" : value.toLocaleString("zh-CN");
}

function updateUndoState(): void {
  undoButton.disabled = undoStack.length === 0;
}

function trimUndoStack(): void {
  if (undoStack.length > 30) undoStack.splice(0, undoStack.length - 30);
}

function setPanel(visible: boolean): void {
  panel.classList.toggle("is-hidden", !visible);
  document.body.classList.toggle("panel-hidden", !visible);
}

function setImmersive(value: boolean): void {
  immersive = value;
  document.body.classList.toggle("immersive", value);
  if (!value) document.body.classList.remove("immersive-reveal");
  setIcon("#immersive-button", value ? "minimize-2" : "maximize-2");
  showToast(value ? "已进入沉浸模式，移动鼠标显示控件" : "已退出沉浸模式");
}

function setIcon(selector: string, name: string): void {
  const button = requiredElement<HTMLButtonElement>(selector);
  button.innerHTML = `<i data-lucide="${name}"></i>`;
  createIcons({ icons: { Pause, Play, Volume2, VolumeX, Maximize2, Minimize2 } });
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function escapeHtml(value: string): string {
  const node = document.createElement("div");
  node.textContent = value;
  return node.innerHTML;
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
