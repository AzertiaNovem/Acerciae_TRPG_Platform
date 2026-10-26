import { renderPdf } from "./render.mjs";
const base = process.env.API_BASE || "http://backend:8080";
const token = process.env.PDF_WORKER_TOKEN || "";
if (token.length < 32)
  throw Error("PDF_WORKER_TOKEN must be at least 32 characters");
const request = async (path, body, headers = {}) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "X-Worker-Token": token, ...headers },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Error(`worker API ${r.status}`);
  return r.json();
};
let running = true;
process.on("SIGTERM", () => {
  running = false;
});
process.on("SIGINT", () => {
  running = false;
});
while (running) {
  try {
    const job = await request("/api/internal/pdf/claim");
    if (job) {
      try {
        const pdf = await renderPdf(job.render_payload);
        await request(`/api/internal/pdf/${job.id}/finish`, pdf, {
          "X-Worker-Lease": job.lease_token,
          "Content-Type": "application/pdf",
        });
      } catch (e) {
        await request(`/api/internal/pdf/${job.id}/finish`, "", {
          "X-Worker-Lease": job.lease_token,
          "X-Worker-Error": String(e.message)
            .replace(/[^\x20-\x7e]/g, " ")
            .slice(0, 900),
        });
      }
      continue;
    }
  } catch (e) {
    console.error("PDF worker:", e.message);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
