/**
 * Core metronome audio engine.
 *
 * Design notes (why it's built this way):
 * - Timing uses the classic "lookahead scheduler" pattern: a JS timer wakes up
 *   often and schedules upcoming beats on the Web Audio clock (AudioContext.currentTime),
 *   which is sample-accurate and keeps ticking independent of JS timer jitter.
 * - Beat audio is connected straight to `audioContext.destination`. That's the
 *   native Web Audio render path, driven by the hardware's own audio clock on
 *   a dedicated render thread — once a beat is scheduled with `start(time)`,
 *   its playback timing no longer depends on the JS main thread at all.
 * - A *separate* hidden <audio> element loops a real (tiny, near-silent) audio
 *   FILE purely to hold iOS's "this page is playing background media"
 *   permission, which is what stops Safari from fully suspending the page
 *   when the screen locks. This element is intentionally NOT part of the beat
 *   audio graph: an earlier version routed the actual beats through a
 *   MediaStreamAudioDestinationNode into this same element, but a live
 *   MediaStream and the AudioContext's internal clock are two independent
 *   clock domains — under background CPU throttling they drift apart and the
 *   <audio> element's playback has to skip/stretch samples to resync, which
 *   is exactly what produced the reported "chaotic tempo" once backgrounded.
 *   Keeping them separate means the audible metronome never depends on that
 *   resync behavior.
 * - BPM/sound/mode changes are applied to the *next unscheduled* beat only, so
 *   changing tempo on the fly never retroactively touches beats already
 *   committed to the audio graph (no glitches), and takes effect within one
 *   scheduling window.
 * - If the JS timer stalls for a while (backgrounding, a phone call, etc.) the
 *   scheduler self-heals by fast-forwarding the beat grid instead of trying to
 *   flush a backlog of overdue beats.
 */

export type BeatSoundId = "click" | "tik" | "tok" | "tik2" | "tak2";

export const SOUND_FILES: Record<BeatSoundId, string> = {
  click: "/sounds/click.mp3",
  tik: "/sounds/tik.mp3",
  tok: "/sounds/tok.mp3",
  tik2: "/sounds/tik2.mp3",
  tak2: "/sounds/tak2.mp3",
};

const KEEPALIVE_URL = "/sounds/keepalive.mp3";

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

interface EngineOptions {
  onBeat?: (beatIndex: number, side: "left" | "right") => void;
  onRunningChange?: (running: boolean) => void;
  onError?: (message: string) => void;
}

const SCHEDULE_AHEAD_TIME = 0.75; // seconds of lookahead scheduled each tick
const SCHEDULER_INTERVAL_MS = 100; // how often the scheduler wakes up
const MAX_CATCHUP_BEHIND = 1.0; // if we fall this far behind, fast-forward the grid

export class MetronomeEngine {
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private keepAliveEl: HTMLAudioElement | null = null;
  private buffers = new Map<BeatSoundId, AudioBuffer>();
  private loadingPromise: Promise<void> | null = null;
  private visibilityBound = false;

  private bpm = 160;
  private soundPack: SoundPackId = "click";
  private beatMode: BeatMode = "same";
  private volume = 1;

  private timerId: number | null = null;
  private nextBeatTime = 0;
  private beatIndex = 0;
  private startTime = 0;
  private running = false;

  constructor(private options: EngineOptions = {}) {}

  get isRunning() {
    return this.running;
  }

  private ensureContext(): AudioContext {
    if (this.audioCtx) return this.audioCtx;

    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctor();
    this.audioCtx = ctx;

    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    gain.connect(ctx.destination);
    this.masterGain = gain;

    // Keep-alive element: a real looped file, independent of the Web Audio
    // graph above, whose only job is to keep iOS treating this page as
    // "playing media" so it isn't fully suspended in the background.
    const keepAlive = new Audio(KEEPALIVE_URL);
    keepAlive.loop = true;
    keepAlive.setAttribute("playsinline", "true");
    keepAlive.addEventListener("pause", () => {
      if (this.running) keepAlive.play().catch(() => {});
    });
    this.keepAliveEl = keepAlive;

    if (!this.visibilityBound) {
      this.visibilityBound = true;
      document.addEventListener("visibilitychange", this.handleWake);
      window.addEventListener("pageshow", this.handleWake);
      window.addEventListener("focus", this.handleWake);
    }

    return ctx;
  }

  /** Re-assert playback state after coming back from background/lock. */
  private handleWake = () => {
    if (!this.running) return;
    if (this.audioCtx?.state === "suspended") {
      this.audioCtx.resume().catch(() => {});
    }
    if (this.keepAliveEl?.paused) {
      this.keepAliveEl.play().catch(() => {});
    }
  };

  async loadSounds(): Promise<void> {
    if (this.loadingPromise) return this.loadingPromise;
    const ctx = this.ensureContext();
    this.loadingPromise = (async () => {
      const entries = Object.entries(SOUND_FILES) as [BeatSoundId, string][];
      await Promise.all(
        entries.map(async ([id, url]) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Gagal memuat suara: ${url}`);
          const arrayBuffer = await res.arrayBuffer();
          const buffer = await ctx.decodeAudioData(arrayBuffer);
          this.buffers.set(id, buffer);
        }),
      );
    })();
    return this.loadingPromise;
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.masterGain) this.masterGain.gain.value = this.volume;
  }

  setBpm(bpm: number) {
    this.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
    this.refreshMediaSessionMetadata();
  }

  setSoundPack(pack: SoundPackId) {
    this.soundPack = pack;
  }

  setBeatMode(mode: BeatMode) {
    this.beatMode = mode;
  }

  private secondsPerBeat() {
    return 60 / this.bpm;
  }

  private soundForBeat(index: number): BeatSoundId {
    const pack = SOUND_PACKS[this.soundPack];
    if (this.beatMode === "same") return pack.even;
    return index % 2 === 0 ? pack.even : pack.odd;
  }

  private scheduleBeat(index: number, time: number) {
    const ctx = this.audioCtx;
    const gain = this.masterGain;
    if (!ctx || !gain) return;
    const soundId = this.soundForBeat(index);
    const buffer = this.buffers.get(soundId);
    if (!buffer) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    src.start(time);

    const side: "left" | "right" = index % 2 === 0 ? "left" : "right";
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    window.setTimeout(() => this.options.onBeat?.(index, side), delayMs);
  }

  private tick = () => {
    if (!this.running || !this.audioCtx) return;
    const ctx = this.audioCtx;
    const spb = this.secondsPerBeat();

    // Self-heal after a long stall (backgrounding, interruption, etc.)
    // instead of flooding a backlog of overdue beats.
    if (this.nextBeatTime < ctx.currentTime - MAX_CATCHUP_BEHIND) {
      const elapsedBeats = Math.floor(
        (ctx.currentTime - this.startTime) / spb,
      );
      this.beatIndex = Math.max(this.beatIndex, elapsedBeats);
      this.nextBeatTime = this.startTime + this.beatIndex * spb;
    }

    while (this.nextBeatTime < ctx.currentTime + SCHEDULE_AHEAD_TIME) {
      this.scheduleBeat(this.beatIndex, this.nextBeatTime);
      this.nextBeatTime += this.secondsPerBeat();
      this.beatIndex += 1;
    }

    this.handleWake();

    this.timerId = window.setTimeout(this.tick, SCHEDULER_INTERVAL_MS);
  };

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
    } catch {
      // MediaMetadata not available — ignore, purely cosmetic.
    }
  }

  async start() {
    if (this.running) return;
    try {
      const ctx = this.ensureContext();
      await this.loadSounds();
      if (ctx.state === "suspended") await ctx.resume();
      if (this.keepAliveEl) {
        await this.keepAliveEl.play().catch(() => {});
      }

      this.running = true;
      this.startTime = ctx.currentTime + 0.08; // tiny lead-in
      this.beatIndex = 0;
      this.nextBeatTime = this.startTime;

      if ("mediaSession" in navigator) {
        this.refreshMediaSessionMetadata();
        navigator.mediaSession.playbackState = "playing";
        navigator.mediaSession.setActionHandler("play", () => this.start());
        navigator.mediaSession.setActionHandler("pause", () => this.stop());
        navigator.mediaSession.setActionHandler("stop", () => this.stop());
      }

      this.options.onRunningChange?.(true);
      this.tick();
    } catch {
      this.options.onError?.(
        "Gagal memulai audio. Coba tekan tombol mulai sekali lagi.",
      );
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.keepAliveEl?.pause();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "paused";
    }
    this.options.onRunningChange?.(false);
    // The AudioContext is kept alive (not closed) so the next start() is
    // instant and doesn't need another user-gesture unlock.
  }

  destroy() {
    this.stop();
    if (this.visibilityBound) {
      document.removeEventListener("visibilitychange", this.handleWake);
      window.removeEventListener("pageshow", this.handleWake);
      window.removeEventListener("focus", this.handleWake);
      this.visibilityBound = false;
    }
    this.keepAliveEl?.pause();
    this.audioCtx?.close().catch(() => {});
  }
}
