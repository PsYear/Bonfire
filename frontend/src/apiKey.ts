const STORAGE_KEY = "bonfire.api-key";

export function validApiKey(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value.trim());
}

/** 只缓存用户在页面输入的 Key；存储不可用时保留在本标签页内存中。 */
export class ApiKeyStore {
  private key = "";
  private cached = false;

  constructor() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
      if (validApiKey(saved)) {
        this.key = saved;
        this.cached = true;
      }
    } catch {
      // 禁用浏览器存储仍可使用页面输入的 Key。
    }
  }

  get value(): string {
    return this.key;
  }

  get remembered(): boolean {
    return this.cached;
  }

  save(value: string, remember: boolean): boolean {
    const key = value.trim();
    if (!validApiKey(key)) throw new Error("请输入有效的 API Key，不能包含空格或换行");
    this.key = key;
    this.cached = false;
    try {
      if (remember) {
        localStorage.setItem(STORAGE_KEY, key);
        this.cached = true;
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
      return true;
    } catch {
      // 若覆盖旧值失败，尽可能移除旧缓存。
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* 存储已被禁用。 */ }
      return false;
    }
  }

  clear(): boolean {
    this.key = "";
    this.cached = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }
}
