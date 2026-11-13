/*
 * One-off: give GA4 a starting point. Every device known to D1 is sent once,
 * dated now, as device_baseline with the board, version and revision of its
 * latest row, under the same client id the Worker uses. GA then knows the
 * whole base from the first day, and a device the Worker sends later is a
 * returning user, not a new one. Run it ONCE (a second run counts them twice).
 *
 *   npx wrangler@4 d1 execute espkvm-check --remote --json --command \
 *     "SELECT id, board, ver, rev FROM seen s WHERE month = (SELECT MAX(month) FROM seen p WHERE p.id = s.id)" \
 *     > devices.json
 *   GA_MEASUREMENT_ID=... GA_API_SECRET=... INTERNAL_IDS=... node scripts/seed-ga.mjs devices.json [--send]
 *
 * Without --send it checks every request against GA's validation endpoint and
 * records nothing.
 */
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const [file, flag] = process.argv.slice(2);
const send = flag === "--send";
const { GA_MEASUREMENT_ID: mid, GA_API_SECRET: secret, INTERNAL_IDS = "" } = process.env;
if (!file || !mid || !secret) {
  console.error("usage: GA_MEASUREMENT_ID=.. GA_API_SECRET=.. node scripts/seed-ga.mjs devices.json [--send]");
  process.exit(2);
}
const internal = INTERNAL_IDS.split(",").map((s) => s.trim());
const rows = JSON.parse(readFileSync(file, "utf8"))[0].results.filter((r) => !internal.includes(r.id));
const { clientId, channelOf, familyOf } = worker.helpers;
const host = send ? "https://www.google-analytics.com/mp/collect" : "https://www.google-analytics.com/debug/mp/collect";
const url = `${host}?measurement_id=${encodeURIComponent(mid)}&api_secret=${encodeURIComponent(secret)}`;
const session = String(Math.floor(Date.now() / 86400000));

let ok = 0;
for (const r of rows) {
  const params = { board: r.board, ver: r.ver, rev: r.rev, family: familyOf(r.board, r.rev), channel: channelOf(r.ver) };
  const body = {
    client_id: await clientId(r.id),
    user_properties: { u_board: { value: params.board }, u_family: { value: params.family }, u_channel: { value: params.channel } },
    events: [{ name: "device_baseline", params: { ...params, session_id: session, engagement_time_msec: 1 } }],
  };
  const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  if (!send) {
    const v = await res.json();
    if (v.validationMessages?.length) {
      console.error(r.board, JSON.stringify(v.validationMessages));
      continue;
    }
  } else if (!res.ok) {
    console.error(r.board, res.status);
    continue;
  }
  ok++;
}
console.log(`${send ? "sent" : "validated"} ${ok} of ${rows.length} devices (${internal.filter(Boolean).length} internal skipped)`);
