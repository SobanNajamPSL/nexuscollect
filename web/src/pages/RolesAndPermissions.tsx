import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface Role { code: string; name: string; description: string }
interface UserRow { id: string; name: string; roles: string[] }

export default function RolesAndPermissions() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<Role[]>("/internal/roles"), api.get<UserRow[]>("/internal/users")])
      .then(([r, u]) => { setRoles(r); setUsers(u); })
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Roles &amp; Permissions</h1>
        <p className="text-sm text-gov-ink/70 mt-1">The 12 named internal roles (§3.2). This build's own maker-checker actions — refunds, break approvals, product config — are enforced against these roles server-side; this page is the read-only reference.</p>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gov-primaryDark/5 text-left">
            <tr><th className="p-3">Role</th><th className="p-3">Name</th><th className="p-3">Description</th></tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.code} className="border-t">
                <td className="p-3 font-mono text-xs">{r.code}</td>
                <td className="p-3 font-medium">{r.name}</td>
                <td className="p-3 text-gov-ink/70">{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="font-semibold text-lg mb-2">Seeded demo users</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gov-primaryDark/5 text-left">
              <tr><th className="p-3">Name</th><th className="p-3">Roles</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="p-3">{u.name}</td>
                  <td className="p-3">{u.roles.map((rc) => <span key={rc} className="inline-block bg-gov-primaryDark/10 rounded px-2 py-0.5 text-xs font-mono mr-1">{rc}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
