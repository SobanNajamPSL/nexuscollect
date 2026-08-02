import { useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { Notice, PageHead } from "../ui.js";

interface Role { code: string; name: string; description: string }
interface User { id: string; name: string; agency_code: string | null; roles: string[] }

export default function Roles(): JSX.Element {
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<Role[]>("/internal/roles"), api.get<User[]>("/internal/users")])
      .then(([r, u]) => { setRoles(r); setUsers(u); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <PageHead
        title="Roles"
        note="The twelve named internal roles. Three pairs are deliberately segregated — analyst/approver for reconciliation, maker/approver for refunds, teller/supervisor at a counter — and in each case the platform requires two different people, not merely two clicks."
      />

      {error && <Notice tone="bad">{error}</Notice>}

      <section className="panel mb-3">
        <div className="panel-head">Roles — {roles.length}</div>
        <table className="grid-table">
          <thead><tr><th style={{ width: "13rem" }}>Code</th><th style={{ width: "14rem" }}>Name</th><th>What it can and cannot do</th></tr></thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.code}>
                <td className="ref font-semibold">{r.code}</td>
                <td>{r.name}</td>
                <td className="text-op-inkDim">{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel-head">Who holds them — {users.length} users</div>
        <table className="grid-table">
          <thead><tr><th>User</th><th style={{ width: "7rem" }}>Agency</th><th>Roles</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name.replace(/\s*\(.*\)$/, "")}</td>
                <td>{u.agency_code ?? <span className="text-op-inkDim">platform</span>}</td>
                <td>{u.roles.map((r) => <span key={r} className="badge badge-neutral mr-1">{r}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
