import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { setIdentity } from "./api.js";
import { fetchPersonas, type Persona, type PortalId } from "./personas.js";

interface PersonaState {
  personas: Persona[];
  current: Persona | null;
  setCurrent: (p: Persona) => void;
  /** True until the roster has loaded; portals gate data fetches on this so
   * they never fire a tenant-scoped request before knowing the tenant. */
  loading: boolean;
  error: string | null;
}

const PersonaCtx = createContext<PersonaState | null>(null);

export function PersonaProvider({ portal, children }: { portal: PortalId; children: ReactNode }): JSX.Element {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [current, setCurrentState] = useState<Persona | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const storageKey = `nexus.persona.${portal}`;

  function setCurrent(p: Persona): void {
    setCurrentState(p);
    setIdentity({ userId: p.id, agencyCode: p.agency_code });
    localStorage.setItem(storageKey, p.id);
  }

  useEffect(() => {
    let cancelled = false;
    fetchPersonas(portal)
      .then((list) => {
        if (cancelled) return;
        setPersonas(list);
        // Restore the previously chosen persona so a page reload mid-demo
        // doesn't silently change who you are.
        const remembered = localStorage.getItem(storageKey);
        const pick = list.find((p) => p.id === remembered) ?? list[0];
        if (pick) {
          setCurrentState(pick);
          setIdentity({ userId: pick.id, agencyCode: pick.agency_code });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [portal, storageKey]);

  return (
    <PersonaCtx.Provider value={{ personas, current, setCurrent, loading, error }}>{children}</PersonaCtx.Provider>
  );
}

export function usePersona(): PersonaState {
  const ctx = useContext(PersonaCtx);
  if (!ctx) throw new Error("usePersona must be used inside a PersonaProvider");
  return ctx;
}
