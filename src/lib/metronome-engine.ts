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
 * The design that actually holds up: don't stream anything live. Build the
 * whole beat pattern (many minutes' worth, so any loop-seam is rare) ahead
 * of time into one real WAV file, and hand that file to a normal
 * `<audio loop>` element. There is exactly one clock involved — the
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
 *
 * One more pitfall worth recording: the loop is built by stamping each
 * beat's decoded PCM samples directly into a flat Float32Array with plain
 * TypedArray copies — NOT by creating one `AudioBufferSourceNode` per beat
 * inside an `OfflineAudioContext` (which is the "normal" Web Audio way to
 * assemble a buffer like this). That was tried first and measured ~21
 * seconds to render a 10-minute, 1600-beat loop at 160 BPM. Web Audio's
 * node graph re-evaluates every connected node on every render quantum
 * (~128 samples) for the whole render, so total work scales with
 * beats × quanta, not beats × sound-length — it falls over once beat count
 * climbs into four digits, exactly the range TARGET_LOOP_SECONDS needs.
 * Plain typed-array copies have no per-node graph overhead and finish in
 * single-digit milliseconds even at that scale.
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
// Target loop length in *time*, not beat count. This is the important fix:
// a fixed beat count makes the real-world loop-seam interval swing wildly
// across the BPM range (128 beats is 3.2 min at 40 BPM but only 32s at 240
// BPM) — sizing by time instead gives a consistent, predictable seam
// interval no matter what BPM is playing. 10 minutes covers most of a
// single run phase (warmup/main/cooldown) with at most one seam in it; see
// README "Kenapa bukan 1000/2000/5000 ketukan?" for the memory/render-time
// math behind this choice, and the note there on interval training (many
// tempo changes) where a shorter target may suit better.
const TARGET_LOOP_SECONDS = 600;
// Floor so a pathological state can't produce a near-empty buffer.
const MIN_LOOP_BEATS = 16;
// Debounce for on-the-fly changes (BPM +/- held down, quick pack switching)
// so we don't re-render and restart the loop on every single tick.
const REBUILD_DEBOUNCE_MS = 180;

/** Stamp each beat's decoded mono PCM samples into a flat Float32Array at
 * its beat-grid position. Plain typed-array copies (see the class doc
 * comment above for why this replaced an OfflineAudioContext render). Beats
 * never overlap in practice (each sound clip is ~100-150ms, well under one
 * beat interval even at MAX_BPM's 250ms), so this is just placement, not
 * mixing/summing. */
function buildLoopSamples(
  loopBeats: number,
  spb: number,
  soundForBeat: (index: number) => Float32Array | undefined,
): Float32Array {
  const totalSamples = Math.round(loopBeats * spb * SAMPLE_RATE);
  const out = new Float32Array(totalSamples);
  for (let i = 0; i < loopBeats; i++) {
    const src = soundForBeat(i);
    if (!src) continue;
    const start = Math.round(i * spb * SAMPLE_RATE);
    const len = Math.min(src.length, totalSamples - start);
    if (len <= 0) continue;
    out.set(len === src.length ? src : src.subarray(0, len), start);
  }
  return out;
}

/** Minimal 16-bit mono PCM WAV encoder — turns raw samples into a real file
 * `<audio loop>` can play natively (gapless, no JS involved after this).
 * Writes through an Int16Array view straight into the output buffer (both
 * are little-endian on every real-world JS engine, so this is safe) rather
 * than calling `DataView.setInt16` per sample — matters once
 * TARGET_LOOP_SECONDS pushes sample counts into the tens of millions, where
 * per-call overhead would otherwise add up to a noticeable stall. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;

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
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // Header is exactly 44 bytes = 22 Int16 slots, so byte offset 44 is
  // naturally 2-byte aligned and safe to view as Int16Array.
  const pcm = new Int16Array(arrayBuffer, 44);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

export class MetronomeEngine {
  private audioEl: HTMLAudioElement | null = null;
  private decodeCtx: OfflineAudioContext | null = null;
  // Mono PCM samples per sound, extracted once at decode time — everything
  // downstream (buildLoopSamples) works with these directly, no AudioBuffer
  // or audio-graph object needed for the actual loop-building step.
  private buffers = new Map<BeatSoundId, Float32Array>();
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
          this.buffers.set(id, buffer.getChannelData(0));
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

  /** Build one seamless looping sample buffer for the current settings.
   * Beat count is derived from TARGET_LOOP_SECONDS so the real-world seam
   * interval stays consistent regardless of BPM (see the constant's doc
   * comment for why a fixed beat count doesn't do that). Synchronous and
   * fast (plain typed-array copies — see the class doc comment for why this
   * isn't an OfflineAudioContext render). */
  private buildCurrentLoopSamples(): Float32Array {
    const spb = this.secondsPerBeat();
    const loopBeats = Math.max(
      MIN_LOOP_BEATS,
      Math.ceil(TARGET_LOOP_SECONDS / spb),
    );
    return buildLoopSamples(loopBeats, spb, (i) =>
      this.buffers.get(this.soundForBeat(i)),
    );
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
    const samples = this.buildCurrentLoopSamples();
    if (!this.running || token !== this.rebuildToken) return;

    const blob = encodeWav(samples, SAMPLE_RATE);
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
