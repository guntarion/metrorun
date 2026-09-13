"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BeatMode,
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
  const [lastBeat, setLastBeat] = useState<{
    index: number;
    side: "left" | "right";
  } | null>(null);

  // Create the engine once on mount.
  useEffect(() => {
    const engine = new MetronomeEngine({
      onBeat: (index, side) => setLastBeat({ index, side }),
      onRunningChange: (running) => {
        setIsRunning(running);
        setIsStarting(false);
      },
      onError: (message) => {
        setError(message);
        setIsStarting(false);
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
    lastBeat,
  };
}
