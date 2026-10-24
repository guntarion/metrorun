"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BeatMode,
  LoopInfo,
  MAX_BPM,
  MIN_BPM,
  MetronomeEngine,
  SoundPackId,
} from "@/lib/metronome-engine";

const STORAGE_KEY = "metrorun:settings:v1";
const DEFAULT_BPM = 160;

interface StoredSettings {
  bpm: number;
  soundPack: SoundPackId;
  beatMode: BeatMode;
  volume: number;
}

function readStored(): Partial<StoredSettings> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<StoredSettings>) : {};
  } catch {
    return {};
  }
}

export function useMetronome() {
  const engineRef = useRef<MetronomeEngine | null>(null);

  const [bpm, setBpmState] = useState<number>(
    () => readStored().bpm ?? DEFAULT_BPM,
  );
  const [soundPack, setSoundPackState] = useState<SoundPackId>(
    () => readStored().soundPack ?? "click",
  );
  const [beatMode, setBeatModeState] = useState<BeatMode>(
    () => readStored().beatMode ?? "same",
  );
  const [volume, setVolumeState] = useState<number>(
    () => readStored().volume ?? 1,
  );
  const [isRunning, setIsRunning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What's actually audible right now — used to keep the beat-indicator
  // animation in phase with the real loop instead of the live (possibly
  // just-changed, not-yet-rebuilt) bpm/mode state. See metronome-engine.ts.
  const [loopInfo, setLoopInfo] = useState<LoopInfo | null>(null);
  const [loopVersion, setLoopVersion] = useState(0);

  // Create the engine once on mount.
  useEffect(() => {
    const engine = new MetronomeEngine({
      onRunningChange: (running) => {
        setIsRunning(running);
        setIsStarting(false);
        if (!running) setLoopInfo(null);
      },
      onError: (message) => {
        setError(message);
        setIsStarting(false);
      },
      onLoopStart: (info) => {
        setLoopInfo(info);
        setLoopVersion((v) => v + 1);
      },
    });
    engineRef.current = engine;
    return () => engine.destroy();
  }, []);

  // Push settings into the engine whenever they change, and persist them.
  useEffect(() => {
    engineRef.current?.setBpm(bpm);
  }, [bpm]);

  useEffect(() => {
    engineRef.current?.setSoundPack(soundPack);
  }, [soundPack]);

  useEffect(() => {
    engineRef.current?.setBeatMode(beatMode);
  }, [beatMode]);

  useEffect(() => {
    engineRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ bpm, soundPack, beatMode, volume }),
      );
    } catch {
      // localStorage unavailable (private mode etc.) — settings just won't persist.
    }
  }, [bpm, soundPack, beatMode, volume]);

  const start = useCallback(async () => {
    setError(null);
    setIsStarting(true);
    await engineRef.current?.start();
  }, []);

  const stop = useCallback(() => {
    engineRef.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (isRunning) stop();
    else void start();
  }, [isRunning, start, stop]);

  const setBpm = useCallback((value: number) => {
    setBpmState(Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(value))));
  }, []);

  const nudgeBpm = useCallback((delta: number) => {
    setBpmState((b) => Math.min(MAX_BPM, Math.max(MIN_BPM, b + delta)));
  }, []);

  return {
    bpm,
    setBpm,
    nudgeBpm,
    soundPack,
    setSoundPack: setSoundPackState,
    beatMode,
    setBeatMode: setBeatModeState,
    volume,
    setVolume: setVolumeState,
    isRunning,
    isStarting,
    error,
    start,
    stop,
    toggle,
    loopInfo,
    loopVersion,
  };
}
