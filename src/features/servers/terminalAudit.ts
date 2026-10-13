export type AuditFrame = { at: number; text: string };
export type TerminalRecording = { id: number; sessionId: string; label: string; startedAt: number; duration: number; frames: AuditFrame[]; bytes: number; stopped: boolean; reason?: string };

export class TerminalAuditStore {
  recordings: TerminalRecording[] = [];
  private pending = "";
  private privateKey = false;
  private droppingLine = false;
  private sequence = 0;
  private active: TerminalRecording | null = null;
  start(sessionId: string, label: string, now = Date.now()) {
    if (this.active) return;
    this.pending = ""; this.privateKey = false; this.droppingLine = false;
    this.active = { id: ++this.sequence, sessionId, label, startedAt: now, duration: 0, frames: [], bytes: 0, stopped: false };
    this.recordings = [this.active, ...this.recordings].slice(0, 10);
  }
  get recording() { return this.active; }
  private line(text: string, now: number, secrets: string[]) {
    const record = this.active;
    if (!record) return;
    const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const keyStart = /-----BEGIN .*PRIVATE KEY-----/.test(plain);
    const keyEnd = /-----END .*PRIVATE KEY-----/.test(plain);
    const inKey = this.privateKey || keyStart;
    if (keyStart) this.privateKey = true;
    const sensitive = inKey || /password|passwd|secret|token|credential|authorization|cookie|bearer|api[_-]?key|access[_-]?key|private[_-]?key/i.test(plain)
      || /[a-z0-9+/=_-]{32,}/i.test(plain)
      || /https?:\/\/[^\s/]+:[^\s/]+@/i.test(plain)
      || secrets.some(secret => secret.length > 0 && plain.includes(secret))
      // Echoed shell commands may contain credentials; keep them out of playback.
      || /(?:^|\s)[^\s]*[#$>]\s+\S/.test(plain);
    if (keyEnd) this.privateKey = false;
    const safe = sensitive ? "[敏感内容或输入回显已隐藏]\n" : `${plain}\n`;
    const size = new TextEncoder().encode(safe).byteLength;
    if (record.bytes + size > 512 * 1024 || record.frames.length >= 8000) {
      record.stopped = true; record.reason = "已达到录制容量上限"; record.duration = Math.max(0, now - record.startedAt); this.active = null; this.pending = ""; return;
    }
    record.frames.push({ at: Math.max(0, now - record.startedAt), text: safe });
    record.bytes += size; record.duration = Math.max(0, now - record.startedAt);
  }
  append(sessionId: string, output: string, secrets: string[] = [], now = Date.now()) {
    if (this.active?.sessionId !== sessionId) return;
    for (const char of output) {
      if (!this.active) break;
      if (char === "\n") {
        if (this.droppingLine) this.line("[超长终端行已省略]", now, []);
        else this.line(this.pending.replace(/\r/g, ""), now, secrets);
        this.pending = ""; this.droppingLine = false;
      } else if (!this.droppingLine) {
        this.pending += char;
        if (this.pending.length > 8192) { this.pending = ""; this.droppingLine = true; }
      }
    }
  }
  stop(reason = "手动停止", secrets: string[] = [], now = Date.now()) {
    const record = this.active;
    if (!record) return;
    if (this.pending && !this.droppingLine) this.line(this.pending.replace(/\r/g, ""), now, secrets);
    record.stopped = true; record.reason = reason; record.duration = Math.max(0, now - record.startedAt);
    this.active = null; this.pending = ""; this.droppingLine = false;
  }
  remove(id: number) { if (this.active?.id !== id) this.recordings = this.recordings.filter(record => record.id !== id); }
}
