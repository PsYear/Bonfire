/** Rolls the caption's fire percentage without delaying the actual scene update. */
export class FireReadout {
  private value: number | null = null;
  private from = 0;
  private animation: Animation | null = null;
  private feedbackTimer = 0;
  private readonly track: HTMLSpanElement;

  constructor(
    private readonly window: HTMLElement,
    private readonly delta: HTMLElement,
    private readonly caption: HTMLElement,
  ) {
    this.track = document.createElement("span");
    this.track.className = "caption-value-track";
    window.replaceChildren(this.track);
  }

  setValue(value: number, animate = false): void {
    value = Math.round(value);
    if (value === this.value) return;
    const previous = this.value;
    const progress = this.animation?.effect?.getComputedTiming().progress ?? 1;
    const displayed = previous === null ? value : Math.round(this.from + (previous - this.from) * progress);
    this.animation?.cancel();
    this.animation = null;
    window.clearTimeout(this.feedbackTimer);
    this.caption.classList.remove("is-gesture-changing");
    this.delta.hidden = true;
    this.window.dataset.animating = "false";
    this.window.dataset.value = String(value);
    this.value = value;
    this.from = displayed;

    if (!animate || previous === null) {
      this.showValue(value);
      return;
    }
    this.delta.textContent = `${value > previous ? "+" : "−"}${Math.abs(value - previous)}`;
    this.delta.hidden = false;
    this.caption.classList.add("is-gesture-changing");
    this.feedbackTimer = window.setTimeout(() => {
      this.delta.hidden = true;
      this.caption.classList.remove("is-gesture-changing");
    }, 1600);

    if (displayed === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.showValue(value);
      return;
    }
    const low = Math.min(displayed, value);
    const distance = Math.abs(value - displayed);
    const steps = Array.from({ length: distance + 1 }, (_, index) => this.row(low + index));
    this.track.replaceChildren(...steps);
    const endOffset = -100 * distance / steps.length;
    const increasing = value > displayed;
    this.window.dataset.direction = increasing ? "up" : "down";
    this.window.dataset.animating = "true";
    const animation = this.track.animate([
      { transform: `translateY(${increasing ? 0 : endOffset}%)` },
      { transform: `translateY(${increasing ? endOffset : 0}%)` },
    ], {
      duration: Math.min(900, 560 + distance * 6),
      easing: "cubic-bezier(0.18, 0.7, 0.2, 1)",
      fill: "forwards",
    });
    this.animation = animation;
    animation.onfinish = () => {
      if (this.animation !== animation) return;
      this.showValue(value);
      animation.cancel();
      this.animation = null;
      this.from = value;
      this.window.dataset.animating = "false";
    };
  }

  dispose(): void {
    this.animation?.cancel();
    window.clearTimeout(this.feedbackTimer);
  }

  private showValue(value: number): void {
    this.track.replaceChildren(this.row(value));
    this.from = value;
  }

  private row(value: number): HTMLSpanElement {
    const row = document.createElement("span");
    row.className = "caption-value-step";
    row.textContent = String(value);
    return row;
  }
}
