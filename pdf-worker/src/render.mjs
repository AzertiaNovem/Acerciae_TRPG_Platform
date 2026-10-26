import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { renderHtml } from "./template.mjs";
const exec = promisify(execFile);
export async function renderPdf(payload) {
  const dir = await mkdtemp(path.join(tmpdir(), "acerciae-pdf-"));
  try {
    const html = path.join(dir, "book.html"),
      output = path.join(dir, "book.pdf");
    await writeFile(html, renderHtml(payload));
    const cli = fileURLToPath(
      new URL("../node_modules/@vivliostyle/cli/dist/cli.js", import.meta.url),
    );
    // Only trusted flags, file paths and a generated HTML document reach the CLI. No shell, remote assets or user HTML.
    const args = [cli, "build", html, "-o", output, "--timeout", "180"];
    if (process.env.CHROMIUM_PATH)
      args.push("--executable-browser", process.env.CHROMIUM_PATH);
    await exec(process.execPath, args, {
      timeout: 210000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    const pdf = await readFile(output);
    if (pdf.subarray(0, 5).toString() !== "%PDF-")
      throw Error("invalid rendered PDF");
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
