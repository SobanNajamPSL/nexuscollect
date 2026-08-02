import type { ReactNode } from "react";

export function Notice({ tone, children }: { tone: "good" | "bad" | "warn"; children: ReactNode }): JSX.Element {
  const cls =
    tone === "good" ? "border-fd-good bg-fd-good/[0.07] text-fd-good"
    : tone === "bad" ? "border-fd-bad bg-fd-bad/[0.06] text-fd-bad"
    : "border-fd-accent bg-fd-accent/[0.07] text-fd-accent";
  return <div className={`slab border-2 p-4 font-semibold ${cls}`}>{children}</div>;
}

export function Head({ title, sub }: { title: string; sub?: string }): JSX.Element {
  return (
    <div className="mb-5">
      <h1 className="text-2xl font-bold">{title}</h1>
      {sub && <p className="text-fd-inkDim mt-1 leading-snug">{sub}</p>}
    </div>
  );
}
