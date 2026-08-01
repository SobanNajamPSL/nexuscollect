import { useEffect, useState } from "react";
import { api } from "./api.js";

/**
 * The demo clock, shared between the harness (which moves it) and any screen
 * that shows a business date (which must never hardcode one).
 *
 * A tiny subscribe-able store rather than a React context: the harness bar and
 * the page tree are siblings under different providers in some portals, and a
 * business date is read-mostly global state, not something worth threading.
 *
 * Why this matters beyond tidiness: advancing the clock to demonstrate surcharge
 * accrual is a scripted demo moment. If a screen shows a date baked in at build
 * time, it silently contradicts the harness the moment the clock moves — which
 * is precisely the kind of detail that makes a demonstration look staged.
 */

let currentIso: string | null = null;
const listeners = new Set<(iso: string | null) => void>();

export function setDemoClock(iso: string | null): void {
  currentIso = iso;
  for (const fn of listeners) fn(iso);
}

/** There is no GET for the clock; advancing by zero is the read. */
export async function readDemoClock(): Promise<string | null> {
  try {
    const res = await api.post<{ now: string }>("/internal/demo/advance-clock", { by_ms: 0 }, { idempotent: false });
    setDemoClock(res.now);
    return res.now;
  } catch {
    setDemoClock(null);
    return null;
  }
}

export function useDemoClock(): string | null {
  const [iso, setIso] = useState<string | null>(currentIso);
  useEffect(() => {
    listeners.add(setIso);
    if (currentIso === null) void readDemoClock();
    return () => {
      listeners.delete(setIso);
    };
  }, []);
  return iso;
}

const KARACHI = "Asia/Karachi";

/** ISO instant → the Asia/Karachi business date, e.g. "2026-07-30". */
export function businessDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: KARACHI });
}

/** ISO instant → a long-form business date, e.g. "30 July 2026". */
export function businessDateLong(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: KARACHI,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** ISO instant → "2026-07-30 12:00", for the harness readout. */
export function businessDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-CA", { timeZone: KARACHI });
  const time = d.toLocaleTimeString("en-GB", { timeZone: KARACHI, hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}
