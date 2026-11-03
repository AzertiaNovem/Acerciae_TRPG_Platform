// Token accounting only: never persist or print prompts, replies, API keys or provider error bodies.
export function usageSink(store, log = () => {}) {
  return (record) => {
    const id = store.recordUsage(record);
    log(`LLM tokens #${id} ${record.purpose}${record.phase ? `/${record.phase}` : ""} attempt ${record.attempt ?? 1} ${record.status ?? "completed"}: ${tokenText(record)} (${record.durationMs ?? 0}ms)`);
  };
}

function tokenText(row) {
  if (row.usageKnown === false) return "usage not reported or incomplete; token total unknown";
  return `${row.estimated ? "estimated " : ""}input ${row.input ?? 0}, cache read ${row.cacheRead ?? 0}, cache write ${row.cacheWrite ?? 0}, output ${row.output ?? 0}, total ${(row.input ?? 0) + (row.output ?? 0)}`;
}

export function usageOptions(args = {}, now = Date.now()) {
  const number = (name, fallback, max) => {
    if (args[name] === undefined) return fallback;
    const value = Number(args[name]);
    if (args[name] === true || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`usage --${name} needs an integer from 1 to ${max}`);
    return value;
  };
  const days = args.days === "all" ? null : number("days", 7, 36500);
  if (args.purpose === true) throw new Error("usage --purpose needs a call type such as director or planner");
  return { since: days === null ? 0 : now - days * 86400000, purpose: String(args.purpose ?? ""),
    limit: number("limit", 50, 10000), beforeId: number("before-id", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) };
}

export function usageReport(store, options) {
  const calls = store.usageCalls(options);
  return { since: options.since, purpose: options.purpose || null,
    // Summary covers the whole selected time range; the cursor/limit only page the call details.
    summary: store.usageByPurpose(options.since, options.purpose), calls,
    nextBeforeId: calls.length === options.limit ? calls.at(-1).id : null };
}

export function printUsageSummary(rows, log = console.log) {
  if (!rows.length) { log("no model calls recorded in this range"); return; }
  for (const r of rows) log(`${r.purpose}${r.phase ? `/${r.phase}` : ""} [${r.provider || "legacy"} / ${r.model || "unknown model"}]: ${r.calls} calls, ${r.failed} failed, ${r.unknown} usage unknown, ${r.estimated} estimated; input ${r.input}, cache read ${r.cacheRead}, cache write ${r.cacheWrite}, output ${r.output}, total ${r.total}; output avg ${r.averageOutput === null ? "unknown" : Math.round(r.averageOutput)}, max ${r.maxOutput ?? "unknown"}`);
}

export function printUsageReport(report, log = console.log) {
  log("Token totals count input + output; cached tokens are already included in input. Unknown usage is not zero cost.");
  printUsageSummary(report.summary, log);
  log(`Recent calls (${report.calls.length}, newest first):`);
  for (const r of report.calls) log(`#${r.id} ${new Date(r.at).toISOString()} ${r.purpose}${r.phase ? `/${r.phase}` : ""} attempt ${r.attempt} [${r.provider || "legacy"} / ${r.model || "unknown"}] ${r.status}${r.httpStatus ? ` HTTP ${r.httpStatus}` : ""} ${r.durationMs === null ? "duration unknown" : `${r.durationMs}ms`}: ${tokenText(r)}; request ${r.requestId || "legacy"}`);
  if (report.nextBeforeId) log(`More call details: repeat with --before-id ${report.nextBeforeId}`);
}
