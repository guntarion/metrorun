"use client";

import { useCallback, useEffect, useRef } from "react";
import { useMetronome } from "@/hooks/useMetronome";
import {
  BeatMode,
  MAX_BPM,
  MIN_BPM,
  SOUND_PACKS,
  SoundPackId,
} from "@/lib/metronome-engine";

const PRESETS = [152, 156, 160, 165, 170];
const SOUND_PACK_IDS = Object.keys(SOUND_PACKS) as SoundPackId[];

/** A press-and-hold repeat button, for fast BPM nudging on the fly. */
function RepeatButton({
  onTrigger,
  label,
  ariaLabel,
  className = "",
}: {
  onTrigger: () => void;
  label: string;
  ariaLabel: string;
  className?: string;
}) {
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    timeoutRef.current = null;
    intervalRef.current = null;
  }, []);

  const start = useCallback(() => {
    onTrigger();
    timeoutRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(onTrigger, 90);
    }, 400);
  }, [onTrigger]);

  useEffect(() => clearTimers, [clearTimers]);

  return (
    <button
      type="button"
      onPointerDown={(e) => {
        e.preventDefault();
        start();
      }}
      onPointerUp={clearTimers}
      onPointerLeave={clearTimers}
      onPointerCancel={clearTimers}
      className={`select-none rounded-full text-3xl font-semibold leading-none active:scale-95 transition-transform ${className}`}
      aria-label={ariaLabel}
    >
      {label}
    </button>
  );
}

export default function MetronomeApp() {
  const {
    bpm,
    setBpm,
    nudgeBpm,
    soundPack,
    setSoundPack,
    beatMode,
    setBeatMode,
    volume,
    setVolume,
    isRunning,
    isStarting,
    error,
    toggle,
  } = useMetronome();

  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        {/* BPM display + nudge */}
        <div className="mt-1 flex items-center justify-center gap-4">
          <RepeatButton
            label="−"
            ariaLabel="Kurangi BPM"
            onTrigger={() => nudgeBpm(-1)}
            className="h-14 w-14 bg-slate-800 text-slate-200 hover:bg-slate-700"
          />
          <div className="w-40 text-center">
            <div className="text-6xl font-bold tabular-nums tracking-tight">
              {bpm}
            </div>
            <div className="mt-1 text-xs uppercase tracking-widest text-slate-500">
              BPM
            </div>
          </div>
          <RepeatButton
            label="+"
            ariaLabel="Tambah BPM"
            onTrigger={() => nudgeBpm(1)}
            className="h-14 w-14 bg-slate-800 text-slate-200 hover:bg-slate-700"
          />
        </div>

        {/* BPM slider for coarse adjustment */}
        <input
          type="range"
          min={MIN_BPM}
          max={MAX_BPM}
          value={bpm}
          onChange={(e) => setBpm(Number(e.target.value))}
          className="range-big mt-1 w-full"
          style={{ "--pct": `${((bpm - MIN_BPM) / (MAX_BPM - MIN_BPM)) * 100}%` } as React.CSSProperties}
          aria-label="Atur BPM"
        />

        {/* Presets */}
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setBpm(preset)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                bpm === preset
                  ? "bg-orange-500 text-slate-950"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {preset}
            </button>
          ))}
        </div>

        {/* Sound pack */}
        <section className="mt-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Suara ketukan
          </h2>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {SOUND_PACK_IDS.map((id) => {
              const pack = SOUND_PACKS[id];
              const active = soundPack === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSoundPack(id)}
                  className={`rounded-xl border px-2 py-2.5 text-center transition-colors ${
                    active
                      ? "border-orange-500 bg-orange-500/10 text-orange-300"
                      : "border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700"
                  }`}
                >
                  <div className="text-sm font-semibold">{pack.label}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Beat mode */}
        <section className="mt-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Mode ketukan
          </h2>
          <div className="mt-2 grid grid-cols-2 gap-2 rounded-xl bg-slate-900 p-1">
            {(
              [
                ["same", "Sama"],
                ["alternate", "Kiri-Kanan"],
              ] as [BeatMode, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBeatMode(mode)}
                className={`rounded-lg py-2 text-sm font-medium transition-colors ${
                  beatMode === mode
                    ? "bg-orange-500 text-slate-950"
                    : "text-slate-300 hover:bg-slate-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {/* Volume */}
        <section className="mt-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Volume
          </h2>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="range-big w-full"
            style={{ "--pct": `${volume * 100}%` } as React.CSSProperties}
            aria-label="Atur volume"
          />
        </section>

        {error && (
          <p className="mt-4 rounded-lg bg-red-950 px-3 py-2 text-center text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="flex-1" />

        {/* Transport */}
        <button
          type="button"
          onClick={toggle}
          disabled={isStarting}
          className={`mt-4 w-full rounded-2xl py-4 text-lg font-bold tracking-wide transition-colors disabled:opacity-60 ${
            isRunning
              ? "bg-red-600 text-white active:bg-red-700"
              : "bg-orange-500 text-slate-950 active:bg-orange-400"
          }`}
        >
          {isStarting ? "Memuat..." : isRunning ? "Berhenti" : "Mulai"}
        </button>
      </div>
    </div>
  );
}
