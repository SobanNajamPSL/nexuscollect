import Fastify from "fastify";

/**
 * Phase 0 skeleton only — per PROMPTS.md Prompt 0: "Do not build any API endpoint,
 * any UI, or any business logic beyond what Phase 0 lists." `/health` is
 * infrastructure (Docker Compose's healthcheck target), not part of the v1 API
 * surface defined in api/openapi.yaml — that surface starts at Phase 1's
 * `POST /v1/resolve`.
 */
const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

const port = Number(process.env["API_PORT"] ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
