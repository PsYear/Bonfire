export class FireAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private fireGain: GainNode | null = null;
  private detailGain: GainNode | null = null;
  private crackleGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windGustGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples = new Float32Array(2048);
  private loops: AudioBufferSourceNode[] = [];
  private voices = new Set<AudioBufferSourceNode>();
  private recordingLoaded = false;
  private recordingAttempted = false;
  private recordingRequest: AbortController | null = null;
  private pendingToggle: Promise<boolean> | null = null;
  private crackleTimer = 0;
  private windTimer = 0;
  private suspendTimer = 0;
  private crackleCount = 0;
  private windGustCount = 0;
  private enabled = false;
  private disposed = false;
  private volume = 0.55;
  private intensity = 0.6;
  private wind = 0.1;

  get isEnabled(): boolean {
    return this.enabled;
  }

  get statistics() {
    let sum = 0;
    let peak = 0;
    if (this.context?.state === "running" && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.samples);
      for (const sample of this.samples) {
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
    }
    return {
      enabled: this.enabled,
      recordingLoaded: this.recordingLoaded,
      contextState: this.context?.state ?? "uninitialized",
      volume: this.volume,
      intensity: this.intensity,
      wind: this.wind,
      windGain: this.windGain?.gain.value ?? 0,
      windEnvelope: this.windGustGain?.gain.value ?? 0,
      windFrequency: this.windFilter?.frequency.value ?? 0,
      windGustCount: this.windGustCount,
      rms: Math.sqrt(sum / this.samples.length),
      peak,
      activeVoices: this.voices.size,
      crackleCount: this.crackleCount,
    };
  }

  toggle(): Promise<boolean> {
    if (!this.pendingToggle) {
      this.pendingToggle = this.togglePlayback().finally(() => {
        this.pendingToggle = null;
      });
    }
    return this.pendingToggle;
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    this.ramp(this.master, this.enabled ? this.volume * 0.4 : 0, 0.03);
  }

  setIntensity(value: number): void {
    const wasBurning = this.intensity > 0;
    this.intensity = Math.max(0, Math.min(1, value));
    this.updateFireGains();
    if (this.intensity === 0) this.stopCrackles();
    else if (!wasBurning && this.enabled) this.scheduleCrackle();
  }

  setWind(value: number): void {
    const wasAudible = this.wind > 0.6;
    this.wind = Math.max(0, Math.min(1, value));
    // 保留微风时的安静；强风的短时峰值更清晰，阵间回落避免持续铺底。
    this.ramp(this.windGain, Math.pow(Math.max(0, (this.wind - 0.6) / 0.4), 1.6) * 0.1, 0.12);
    if (this.wind <= 0.6) this.stopWindGusts();
    else if (!wasAudible && this.enabled) this.scheduleWindGust();
  }

  burst(): void {
    if (!this.enabled || this.intensity === 0) return;
    this.createCrackle(0.15);
    this.createCrackle(0.08, 0.035 + Math.random() * 0.05);
    this.createCrackle(0.05, 0.1 + Math.random() * 0.07);
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    window.clearTimeout(this.suspendTimer);
    this.recordingRequest?.abort();
    this.stopCrackles();
    this.stopWindGusts();
    for (const source of this.loops) {
      source.stop();
      source.disconnect();
    }
    this.loops = [];
    void this.context?.close().catch(() => {});
  }

  private async togglePlayback(): Promise<boolean> {
    if (this.disposed) return false;
    window.clearTimeout(this.suspendTimer);
    if (!this.context) this.createGraph();
    const ctx = this.context;
    if (!ctx || !this.master) return false;

    if (this.enabled) {
      this.enabled = false;
      this.stopCrackles();
      this.stopWindGusts();
      this.ramp(this.master, 0, 0.025);
      this.suspendTimer = window.setTimeout(() => {
        if (!this.enabled && ctx.state === "running") void ctx.suspend().catch(() => {});
      }, 200);
      return false;
    }

    // resume 必须先在点击手势内调用，录音随后按需下载。
    await ctx.resume();
    await this.loadRecording();
    if (this.disposed) return false;
    this.enabled = true;
    this.ramp(this.master, this.volume * 0.4, 0.05);
    this.scheduleCrackle();
    this.scheduleWindGust();
    return true;
  }

  private createGraph(): void {
    this.context = new AudioContext();
    const ctx = this.context;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = this.samples.length;
    this.master.connect(compressor).connect(this.analyser).connect(ctx.destination);

    this.fireGain = ctx.createGain();
    this.detailGain = ctx.createGain();
    this.crackleGain = ctx.createGain();
    this.fireGain.connect(this.master);
    this.detailGain.connect(this.master);
    this.crackleGain.connect(this.master);
    this.updateFireGains();

    const buffer = ctx.createBuffer(1, ctx.sampleRate * 6, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const windSource = ctx.createBufferSource();
    windSource.buffer = buffer;
    windSource.loop = true;
    const lowCut = ctx.createBiquadFilter();
    lowCut.type = "highpass";
    lowCut.frequency.value = 100;
    lowCut.Q.value = 0.5;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 320;
    this.windFilter.Q.value = 0.4;
    this.windGustGain = ctx.createGain();
    this.windGustGain.gain.value = 0;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSource.connect(lowCut).connect(this.windFilter).connect(this.windGustGain)
      .connect(this.windGain).connect(this.master);
    windSource.start();
    this.loops.push(windSource);
    this.setWind(this.wind);
  }

  private async loadRecording(): Promise<void> {
    if (this.recordingAttempted || !this.context) return;
    this.recordingAttempted = true;
    const ctx = this.context;
    const request = new AbortController();
    this.recordingRequest = request;
    const timeout = window.setTimeout(() => request.abort(), 8000);
    try {
      const url = new URL("audio/campfire-crackle.mp3", document.baseURI);
      const response = await fetch(url, { signal: request.signal });
      if (!response.ok) throw new Error(`Campfire recording: ${response.status}`);
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      if (this.disposed || !this.fireGain || !this.detailGain) return;

      // 真实录音保留近距离的木柴碎裂；低音量错位层降低循环辨识度。
      for (const [gain, offset, rate] of [
        [this.fireGain, 0, 1],
        [this.detailGain, buffer.duration * 0.43, 0.971],
      ] as const) {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.playbackRate.value = rate;
        source.connect(gain);
        source.start(0, offset);
        this.loops.push(source);
      }
      this.recordingLoaded = true;
    } catch (error) {
      if (!this.disposed) console.warn("篝火录音加载失败，使用随机木柴爆裂声。", error);
    } finally {
      window.clearTimeout(timeout);
      this.recordingRequest = null;
    }
  }

  private ramp(node: GainNode | null, value: number, smoothing: number): void {
    if (!node || !this.context || this.disposed) return;
    const now = this.context.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setTargetAtTime(value, now, smoothing);
  }

  private updateFireGains(): void {
    const burning = this.intensity > 0;
    this.ramp(this.fireGain, burning ? 0.32 + 1.08 * this.intensity : 0, 0.06);
    this.ramp(this.detailGain, 0.2 * Math.pow(this.intensity, 1.8), 0.06);
    this.ramp(this.crackleGain, burning ? 0.45 + 0.55 * this.intensity : 0, 0.025);
  }

  private scheduleWindGust(): void {
    window.clearTimeout(this.windTimer);
    this.windTimer = 0;
    if (!this.enabled || this.wind <= 0.6 || !this.context
      || !this.windGustGain || !this.windFilter || this.disposed) return;
    const ctx = this.context;
    const strength = (this.wind - 0.6) / 0.4;
    const duration = 0.85 + Math.random() * 0.45 - strength * 0.25;
    const gap = 0.18 + Math.random() * 0.32 - strength * 0.1;
    const rise = 0.26 + Math.random() * 0.12;
    const peak = 0.7 + Math.random() * 0.3;
    const curve = new Float32Array(128);
    for (let i = 0; i < curve.length; i += 1) {
      const t = i / (curve.length - 1);
      const phase = t < rise ? t / rise * 0.5 : 0.5 + (t - rise) / (1 - rise) * 0.5;
      // 快起、圆峰、慢落，每阵都有明确的呼吸感，避免方波式开关。
      curve[i] = 0.008 + Math.sin(phase * Math.PI) ** 2 * peak;
    }
    const now = ctx.currentTime, start = now + 0.03;
    const gain = this.windGustGain.gain;
    gain.cancelAndHoldAtTime(now);
    gain.linearRampToValueAtTime(curve[0], start);
    gain.setValueCurveAtTime(curve, start, duration);

    // 气流增强时音色变亮，退去时变低沉；每阵中心频率不同。
    const frequency = this.windFilter.frequency;
    const base = 250 + Math.random() * 130;
    const crest = 650 + strength * 420 + Math.random() * 230;
    frequency.cancelAndHoldAtTime(now);
    frequency.linearRampToValueAtTime(base, start);
    frequency.exponentialRampToValueAtTime(crest, start + duration * rise);
    frequency.exponentialRampToValueAtTime(base * 0.9, start + duration);
    this.windGustCount += 1;
    this.windTimer = window.setTimeout(() => this.scheduleWindGust(),
      (0.03 + duration + gap) * 1000);
  }

  private stopWindGusts(): void {
    window.clearTimeout(this.windTimer);
    this.windTimer = 0;
    if (!this.context || !this.windGustGain) return;
    const now = this.context.currentTime;
    this.windGustGain.gain.cancelAndHoldAtTime(now);
    this.windGustGain.gain.setTargetAtTime(0, now, 0.035);
    this.windFilter?.frequency.cancelAndHoldAtTime(now);
  }

  private scheduleCrackle(): void {
    window.clearTimeout(this.crackleTimer);
    if (!this.enabled || this.intensity === 0 || this.disposed) return;
    const interval = this.recordingLoaded
      ? 300 + Math.random() * (1500 - this.intensity * 900)
      : 90 + Math.random() * (440 - this.intensity * 260);
    this.crackleTimer = window.setTimeout(() => {
      this.createCrackle(0.045 + Math.random() * 0.085);
      if (Math.random() < 0.35 + this.intensity * 0.3) {
        this.createCrackle(0.025 + Math.random() * 0.045, 0.025 + Math.random() * 0.09);
        if (Math.random() < 0.35) this.createCrackle(0.035, 0.12 + Math.random() * 0.07);
      }
      this.scheduleCrackle();
    }, interval);
  }

  private stopCrackles(): void {
    window.clearTimeout(this.crackleTimer);
    for (const source of this.voices) source.stop();
    this.voices.clear();
  }

  private createCrackle(gain: number, delay = 0): void {
    if (!this.enabled || this.intensity === 0 || !this.context || !this.crackleGain || this.disposed) return;
    const ctx = this.context;
    const duration = 0.025 + Math.random() * 0.075;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const resonance = 420 + Math.random() * 1200;
    for (let i = 0; i < data.length; i += 1) {
      const time = i / ctx.sampleRate;
      const attack = Math.min(1, time / 0.0007);
      const snap = (Math.random() * 2 - 1) * Math.exp(-time / (duration * 0.12));
      const wood = Math.sin(time * resonance * Math.PI * 2) * Math.exp(-time / (duration * 0.22));
      data[i] = attack * (snap * 0.78 + wood * 0.22) * (1 - i / data.length);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 650 + Math.random() * 950;
    filter.Q.value = 0.5;
    const node = ctx.createGain();
    node.gain.value = gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = (Math.random() * 2 - 1) * 0.7;
    source.connect(filter).connect(node).connect(panner).connect(this.crackleGain);
    this.voices.add(source);
    source.onended = () => {
      this.voices.delete(source);
      source.disconnect();
      filter.disconnect();
      node.disconnect();
      panner.disconnect();
    };
    source.start(ctx.currentTime + delay);
    this.crackleCount += 1;
  }
}
