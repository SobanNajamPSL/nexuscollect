/**
 * Placeholder for a screen this portal will own but that hasn't been built yet.
 * Deliberately says so rather than showing an empty shell — an unlabelled blank
 * page in a demonstration reads as a bug, not as scope.
 */
export function Pending({ title, note }: { title: string; note: string }): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between border-b border-ag-rule pb-3">
        <h1 className="doc-title text-xl">{title}</h1>
        <span className="badge badge-warn">Not yet built</span>
      </div>
      <div className="sheet p-5 text-sm text-ag-inkDim max-w-2xl leading-relaxed">{note}</div>
    </div>
  );
}
