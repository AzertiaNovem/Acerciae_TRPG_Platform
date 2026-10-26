import { Howl, Howler } from 'howler';

// Thin audio layer over howler: one voice line at a time, independent voice/BGM/SFX volumes, explicit
// unlock handling for browsers that block autoplay until a user gesture.
export type Volumes = { voice: number; bgm: number; sfx: number };
export class VnAudio {
  private voice: Howl | null = null;
  private bgm: Howl | null = null;
  private bgmSrc: string | null = null;
  volumes: Volumes = { voice: 1, bgm: 0.4, sfx: 0.8 };
  rate = 1;
  unlocked = false;
  onVoiceEnd: (() => void) | null = null;
  onVoiceTime: ((ms: number) => void) | null = null;
  private tick: number | null = null;

  constructor() { try { const s = localStorage.getItem('acerciae.vn.volumes'); if (s) this.volumes = { ...this.volumes, ...JSON.parse(s) }; } catch { /* ignore */ } }
  setVolumes(v: Partial<Volumes>) { this.volumes = { ...this.volumes, ...v }; try { localStorage.setItem('acerciae.vn.volumes', JSON.stringify(this.volumes)); } catch { /* ignore */ } this.voice?.volume(this.volumes.voice); this.bgm?.volume(this.volumes.bgm); }
  async unlock() { try { const ctx = (Howler as any).ctx as AudioContext | undefined; if (ctx && ctx.state !== 'running') await ctx.resume(); this.unlocked = !ctx || ctx.state === 'running'; } catch { this.unlocked = false; } return this.unlocked; }
  playVoice(src: string, format: string | undefined, onEnd: () => void) {
    this.stopVoice();
    this.onVoiceEnd = onEnd;
    const h = new Howl({ src: [src], html5: true, format: format ? [format] : undefined, volume: this.volumes.voice, rate: this.rate,
      onend: () => { this.clearTick(); this.onVoiceEnd?.(); }, onloaderror: () => { this.clearTick(); this.onVoiceEnd?.(); }, onplayerror: () => { this.clearTick(); this.onVoiceEnd?.(); } });
    this.voice = h; h.play();
    this.tick = window.setInterval(() => { if (this.voice) this.onVoiceTime?.((this.voice.seek() as number) * 1000); }, 80);
    return h;
  }
  pauseVoice() { this.voice?.pause(); } resumeVoice() { this.voice?.play(); }
  replayVoice() { if (this.voice) { this.voice.seek(0); this.voice.play(); } }
  stopVoice() { this.clearTick(); if (this.voice) { this.voice.off(); this.voice.stop(); this.voice.unload(); this.voice = null; } }
  voiceDurationMs() { return this.voice ? (this.voice.duration() || 0) * 1000 : 0; }
  setRate(r: number) { this.rate = r; this.voice?.rate(r); }
  playBgm(src: string | null) {
    if (src === this.bgmSrc) return;
    if (this.bgm) { this.bgm.fade(this.volumes.bgm, 0, 600); const old = this.bgm; setTimeout(() => { old.stop(); old.unload(); }, 650); this.bgm = null; }
    this.bgmSrc = src;
    if (!src) return;
    this.bgm = new Howl({ src: [src], html5: true, loop: true, volume: 0 }); this.bgm.play(); this.bgm.fade(0, this.volumes.bgm, 800);
  }
  sfx(src: string) { new Howl({ src: [src], volume: this.volumes.sfx }).play(); }
  dispose() { this.stopVoice(); if (this.bgm) { this.bgm.stop(); this.bgm.unload(); this.bgm = null; } }
  private clearTick() { if (this.tick) { clearInterval(this.tick); this.tick = null; } }
}
