/**
 * Core metronome audio engine.
 *
 * Design notes (why it's built this way — two earlier designs failed on a
 * real iPhone and are worth recording so nobody re-tries them):
 *
 * 1. First attempt: a live Web Audio lookahead scheduler connected straight
 *    to `audioContext.destination`. Sample-accurate, but iOS only keeps a
 *    page's JS/audio processing alive in the background if the *actual*
 *    audible output is a playing HTMLMediaElement. A bare AudioContext with
 *    no media element gets suspended the moment the screen locks — the beat
 *    stopped entirely.
 * 2. Second attempt: kept the live scheduler, but routed it through a
 *    `MediaStreamAudioDestinationNode` into a hidden `<audio>` element so
 *    *something* playing counted as "now playing" media. That kept the page
 *    alive, but a live MediaStream has its own clock, independent from the
 *    AudioContext's internal clock. Under background CPU throttling the two
 *    drift apart and the element has to skip/stretch samples to resync —
 *    audible as a chaotic, randomly-shifting tempo.
 *
 * The design that actually holds up: don't stream anything live. Render the
 * whole beat pattern (many bars' worth, so any loop-seam is rare) offline
 * into one real WAV file with `OfflineAudioContext`, and hand that file to a
 * normal `<audio loop>` element. There is exactly one clock involved — the
 * browser's native media pipeline looping a static file, the same mechanism
 * every music/podcast site relies on for gapless background playback. No JS
 * timer needs to run at all once playback starts, so background throttling
 * can't touch its timing, and it *is* the audible output, so iOS has no
 * reason to suspend it.
 *
 * The trade-off: changing BPM/sound/mode on the fly re-renders the loop and
 * swaps it in, which causes a brief (roughly one render cycle) restart click
 * — acceptable since it only happens on an explicit user action, same as
 * changing tempo on a physical metronome.
 */

export type BeatSoundId = "click" | "tik" | "tok" | "tik2" | "tak2";

export const SOUND_FILES: Record<BeatSoundId, string> = {
  click: "/sounds/click.mp3",
  tik: "/sounds/tik.mp3",
  tok: "/sounds/tok.mp3",
  tik2: "/sounds/tik2.mp3",
  tak2: "/sounds/tak2.mp3",
};

export type SoundPackId = "click" | "classic" | "sharp";

export interface SoundPackDef {
  label: string;
  description: string;
  even: BeatSoundId;
  odd: BeatSoundId;
}

export const SOUND_PACKS: Record<SoundPackId, SoundPackDef> = {
  click: {
    label: "Klik",
    description: "Satu bunyi netral untuk tiap ketukan",
    even: "click",
    odd: "click",
  },
  classic: {
    label: "Tik-Tok",
    description: "Tik untuk kiri, tok untuk kanan",
    even: "tik",
    odd: "tok",
  },
  sharp: {
    label: "Tik-Tak",
    description: "Varian lebih tajam — tik kiri, tak kanan",
    even: "tik2",
    odd: "tak2",
  },
};

export type BeatMode = "same" | "alternate";

export const MIN_BPM = 40;
export const MAX_BPM = 240;

export interface LoopInfo {
  bpm: number;
  soundPack: SoundPackId;
  beatMode: BeatMode;
}

interface EngineOptions {
  onRunningChange?: (running: boolean) => void;
  onError?: (message: string) => void;
  /** Fires exactly when a (re)built loop actually starts audibly playing —
   * use this, not the live bpm/mode state, to keep any UI beat-indicator in
   * phase with what's actually audible (see MetronomeApp.tsx). */
  onLoopStart?: (info: LoopInfo) => void;
}

const SAMPLE_RATE = 44100;
// How many beats get baked into one loop. Larger = the (unavoidable, see
// README "Keterbatasan yang diketahui") loop-seam hiccup happens less
// often, at the cost of a slightly bigger render/file. Render cost stays
// trivial even at this size, so we bias toward "rare seams".
const LOOP_BEATS = 128;
// Debounce for on-the-fly changes (BPM +/- held down, quick pack switching)
// so we don't re-render and restart the loop on every single tick.
const REBUILD_DEBOUNCE_MS = 180;

/** Minimal 16-bit PCM WAV encoder — turns a rendered AudioBuffer into a
 * real file `<audio loop>` can play natively (gapless, no JS involved). */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = buffer.length * blockAlign;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const clamped = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

export class MetronomeEngine {
  private audioEl: HTMLAudioElement | null = null;
  private decodeCtx: OfflineAudioContext | null = null;
  private buffers = new Map<BeatSoundId, AudioBuffer>();
  private loadingPromise: Promise<void> | null = null;
  private currentLoopUrl: string | null = null;
  private rebuildTimer: number | null = null;
  private rebuildToken = 0;
  private visibilityBound = false;

  private bpm = 160;
  private soundPack: SoundPackId = "click";
  private beatMode: BeatMode = "same";
  private volume = 1;
  private running = false;

  constructor(private options: EngineOptions = {}) {}

  get isRunning() {
    return this.running;
  }

  private ensureAudioElement(): HTMLAudioElement {
    if (this.audioEl) return this.audioEl;
    const el = document.createElement("audio");
    el.loop = true;
    el.setAttribute("playsinline", "true");
    el.style.display = "none";
    el.volume = this.volume;
    el.addEventListener("pause", () => {
      if (this.running) el.play().catch(() => {});
    });
    // Genuinely attached to the DOM (not just JS-referenced) — some iOS
    // Safari versions are more reliable about not tearing down a media
    // element's background-audio grant when it's part of the document.
    document.body.appendChild(el);
    this.audioEl = el;

    if (!this.visibilityBound) {
      this.visibilityBound = true;
      document.addEventListener("visibilitychange", this.handleWake);
      window.addEventListener("pageshow", this.handleWake);
      window.addEventListener("focus", this.handleWake);
    }
    return el;
  }

  /** Re-assert playback after coming back from background/lock/interruption. */
  private handleWake = () => {
    if (!this.running || !this.audioEl) return;
    if (this.audioEl.paused) this.audioEl.play().catch(() => {});
  };

  async loadSounds(): Promise<void> {
    if (this.loadingPromise) return this.loadingPromise;
    if (!this.decodeCtx) {
      this.decodeCtx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    }
    const decodeCtx = this.decodeCtx;
    this.loadingPromise = (async () => {
      const entries = Object.entries(SOUND_FILES) as [BeatSoundId, string][];
      await Promise.all(
        entries.map(async ([id, url]) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Gagal memuat suara: ${url}`);
          const arrayBuffer = await res.arrayBuffer();
          const buffer = await decodeCtx.decodeAudioData(arrayBuffer);
          this.buffers.set(id, buffer);
        }),
      );
    })();
    return this.loadingPromise;
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.audioEl) this.audioEl.volume = this.volume;
  }

  setBpm(bpm: number) {
    const next = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
    if (next === this.bpm) return;
    this.bpm = next;
    this.scheduleRebuild();
  }

  setSoundPack(pack: SoundPackId) {
    if (pack === this.soundPack) return;
    this.soundPack = pack;
    this.scheduleRebuild();
  }

  setBeatMode(mode: BeatMode) {
    if (mode === this.beatMode) return;
    this.beatMode = mode;
    this.scheduleRebuild();
  }

  private secondsPerBeat() {
    return 60 / this.bpm;
  }

  private soundForBeat(index: number): BeatSoundId {
    const pack = SOUND_PACKS[this.soundPack];
    if (this.beatMode === "same") return pack.even;
    return index % 2 === 0 ? pack.even : pack.odd;
  }

  /** Render the current settings into one seamless looping WAV buffer. */
  private async buildLoopBuffer(): Promise<AudioBuffer> {
    const spb = this.secondsPerBeat();
    const totalSamples = Math.round(LOOP_BEATS * spb * SAMPLE_RATE);
    const offlineCtx = new OfflineAudioContext(1, totalSamples, SAMPLE_RATE);

    for (let i = 0; i < LOOP_BEATS; i++) {
      const buffer = this.buffers.get(this.soundForBeat(i));
      if (!buffer) continue;
      const src = offlineCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(offlineCtx.destination);
      src.start(i * spb);
    }

    return offlineCtx.startRendering();
  }

  private scheduleRebuild() {
    if (!this.running) return;
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuildAndPlay();
    }, REBUILD_DEBOUNCE_MS);
  }

  private async rebuildAndPlay(): Promise<void> {
    const token = ++this.rebuildToken;
    const buffer = await this.buildLoopBuffer();
    // Bail out if stopped, or a newer rebuild was requested, while we were rendering.
    if (!this.running || token !== this.rebuildToken) return;

    const blob = audioBufferToWav(buffer);
    const url = URL.createObjectURL(blob);
    const previousUrl = this.currentLoopUrl;
    this.currentLoopUrl = url;

    const el = this.ensureAudioElement();
    el.src = url;
    try {
      await el.play();
      // Tell listeners the phase/tempo they should visually sync to — the
      // moment this loop (not the live, possibly just-changed bpm/mode
      // state) actually became audible.
      this.options.onLoopStart?.({
        bpm: this.bpm,
        soundPack: this.soundPack,
        beatMode: this.beatMode,
      });
    } catch {
      this.options.onError?.(
        "Gagal memulai audio. Coba tekan tombol mulai sekali lagi.",
      );
    }
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    this.refreshMediaSessionMetadata();
  }

  private refreshMediaSessionMetadata() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `Metrorun — ${this.bpm} BPM`,
        artist: "Metronome lari",
        artwork: [
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
      navigator.mediaSession.playbackState = "playing";
    } catch {
      // MediaMetadata not available — ignore, purely cosmetic.
    }
  }

  async start() {
    if (this.running) return;
    try {
      this.ensureAudioElement();
      await this.loadSounds();
      this.running = true;
      await this.rebuildAndPlay();

      if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler("play", () => this.start());
        navigator.mediaSession.setActionHandler("pause", () => this.stop());
        navigator.mediaSession.setActionHandler("stop", () => this.stop());
      }

      this.options.onRunningChange?.(true);
    } catch {
      this.running = false;
      this.options.onError?.(
        "Gagal memulai audio. Coba tekan tombol mulai sekali lagi.",
      );
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.rebuildTimer !== null) {
      window.clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.audioEl?.pause();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "paused";
    }
    this.options.onRunningChange?.(false);
    // The <audio> element is kept around (not destroyed) so the next
    // start() is instant and doesn't need another user-gesture unlock.
  }

  destroy() {
    this.stop();
    if (this.visibilityBound) {
      document.removeEventListener("visibilitychange", this.handleWake);
      window.removeEventListener("pageshow", this.handleWake);
      window.removeEventListener("focus", this.handleWake);
      this.visibilityBound = false;
    }
    if (this.currentLoopUrl) URL.revokeObjectURL(this.currentLoopUrl);
    this.audioEl?.remove();
    this.audioEl = null;
  }
}
