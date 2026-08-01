import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Every portal is its own Vite app on its own port and hostname — so the
 * citizen bundle physically cannot contain operator code. That's a real
 * property, not a cosmetic one, and it's the main reason these are four
 * projects rather than one app with four route trees.
 *
 * Hostnames are `*.localhost` subdomains, which Chrome resolves to loopback
 * automatically (RFC 6761) — no /etc/hosts edit and no sudo required. Vite
 * blocks unrecognised Host headers since 5.4.12, hence `allowedHosts`.
 */
export function portalConfig(opts: { port: number }): UserConfig {
  return defineConfig({
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: opts.port,
      strictPort: true,
      allowedHosts: [".localhost"],
      proxy: {
        "/v1": "http://localhost:3000",
        "/internal": "http://localhost:3000",
        "/switch": "http://localhost:3000",
        "/health": "http://localhost:3000",
      },
    },
  });
}
