/*
 * One-off: send the version_daily events for snapshots taken before the
 * Worker sent them, dated at each snapshot (23:55 UTC). GA takes events up
 * to 72 hours old only, so older days are skipped. Run it once per day sent:
 * a second run counts those days twice.
 *
 *   curl -s -H "Authorization: Bearer $STATS_TOKEN" https://check.espkvm.io/v1/stats > stats.json
 *   GA_MEASUREMENT_ID=... GA_API_SECRET=... node scripts/backfill-versions.mjs stats.json [--send]
 *
 * Without --send it checks every request against GA's validation endpoint and
 * records nothing.
 */
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const [file, flag] = process.argv.slice(2);
const send = flag === "--send";
const { GA_MEASUREMENT_ID: mid, GA_API_SECRET: secret } = process.env;
if (!file || !mid || !secret) {
  console.error("usage: GA_MEASUREMENT_ID=.. GA_API_SECRET=.. node scripts/backfill-versions.mjs stats.json [--send]");
  process.exit(2);
}
const { lineOf } = worker.helpers;
const host = send ? "https://www.google-analytics.com/mp/collect" : "https://www.google-analytics.com/debug/mp/collect";
const url = `${host}?measurement_id=${encodeURIComponent(mid)}&api_secret=${encodeURIComponent(secret)}`;

/* A little inside the 72 hours, so a run that takes a while is not refused.
   ONLY=YYYY-MM-DD sends that one day. */
const oldest = Date.now() - 71.8 * 3600 * 1000;
const only = process.env.ONLY;
const days = new Map();
for (const r of JSON.parse(readFileSync(file, "utf8")).daily) {
  if (r.kind !== "ver" || (only && r.day !== only)) continue;
  const at = Date.parse(`${r.day}T23:55:00Z`);
  if (at < oldest || at > Date.now()) continue;
  const lines = days.get(r.day) ?? new Map();
  lines.set(lineOf(r.key), (lines.get(lineOf(r.key)) ?? 0) + r.devices);
  days.set(r.day, lines);
}
for (const [day, lines] of [...days].sort()) {
  const events = [...lines].map(([line, n]) => ({ name: "version_daily", params: { ver_line: line, ver_devices: n } }));
  for (let i = 0; i < events.length; i += 25) {
    const body = {
      client_id: "espkvm-check.daily",
      timestamp_micros: String(Date.parse(`${day}T23:55:00Z`) * 1000),
      events: events.slice(i, i + 25),
    };
    const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });
    const v = send ? null : await res.json();
    if (!res.ok || v?.validationMessages?.length) {
      console.error(day, res.status, JSON.stringify(v?.validationMessages ?? ""));
      process.exitCode = 1;
    }
  }
  console.log(`${send ? "sent" : "validated"} ${day}: ${[...lines].map(([l, n]) => `${l}=${n}`).join(" ")}`);
}
