/*
 * check.espkvm.io: counts ESP-KVM devices in use.
 *
 * The console sends POST /v1/seen?id=&board=&ver=&rev= after a working update
 * check against the project's own manifest, at most once a day (see the
 * console's src/state/seen.ts). One row per device per month; a second
 * report the same day writes nothing. GET /v1/stats needs the STATS_TOKEN secret.
 * A cron trigger stores a snapshot of the counts once a day (table daily).
 * What a device changed since its last report goes to table changes.
 *
 * With GA_MEASUREMENT_ID and the GA_API_SECRET secret set, the same goes to
 * Google Analytics through the Measurement Protocol, as a view of the numbers
 * (D1 stays the record): device_seen / device_new / device_updated /
 * device_board_changed for the first report of a day, and devices_daily from
 * the cron with the totals. The client id is a hash of the installId, so GA
 * and D1 rows do not join up. Ids in INTERNAL_IDS (comma separated, a secret:
 * the author's bench devices) are counted in D1 but never sent.
 *
 * Sized for the free plan: 100k requests a day, and D1's 100k row writes a day.
 */

const CORS = { "Access-Control-Allow-Origin": "*" };

const ID = /^[0-9a-f]{32}$/;
const BOARD = /^[a-z0-9-]{1,40}$/;
const VER = /^[0-9A-Za-z.+-]{1,32}$/;
const REV = /^\d{1,2}\.\d{1,2}$/;

/* Boards whose image runs on rev 3.x silicon only; the rest is rev 1.x. Used
 * for devices that report no revision (consoles before chipRev). */
const REV3_BOARDS = ["funcev", "funcev-c5", "p4-wifi6-db", "p4-nano-wifi6-db", "m5-poe-p4x"];
const FAMILY = `CASE WHEN rev <> '' THEN rev
  WHEN board LIKE '%-rev3' OR board IN (${REV3_BOARDS.map((b) => `'${b}'`).join(", ")}) THEN '3.x'
  ELSE '1.x' END`;

/* A tagged release, v.0.83.0; anything else (-dirty, git describe, a fork) is dev. */
const RELEASE = /^v\.\d+\.\d+\.\d+$/;
const channelOf = (ver) => (RELEASE.test(ver) ? "release" : "dev");
const familyOf = (board, rev) =>
  rev ? `${rev.split(".")[0]}.x` : board.endsWith("-rev3") || REV3_BOARDS.includes(board) ? "3.x" : "1.x";

export default {
  /* For scripts/seed-ga.mjs: the same client id and labels as the Worker's. */
  helpers: { clientId: (id) => clientId(id), channelOf, familyOf },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/seen" && req.method === "POST") return seen(url, env, ctx);
    if (url.pathname === "/v1/stats" && req.method === "GET") return stats(req, env);
    return new Response("not found\n", { status: 404, headers: CORS });
  },
  async scheduled(event, env, ctx) {
    const day = new Date(event.scheduledTime).toISOString().slice(0, 10);
    const totals = await snapshot(env, day);
    ctx?.waitUntil(ga(env, "espkvm-check.daily", [{ name: "devices_daily", params: totals }]));
  },
};

/* Devices seen in the 30 days up to @p day, each with the board and version of
 * its latest row. About 20 row writes a day. */
async function snapshot(env, day) {
  const from = new Date(Date.parse(day) - 29 * 86400000).toISOString().slice(0, 10);
  const rows = (
    await env.DB.prepare(
      `SELECT board, ver, ${FAMILY} AS rev FROM seen s
       WHERE last >= ?1 AND last <= ?2
         AND month = (SELECT MAX(month) FROM seen p WHERE p.id = s.id)`,
    )
      .bind(from, day)
      .all()
  ).results;
  const counts = new Map([["all\t", rows.length]]);
  for (const r of rows) {
    for (const k of [`board\t${r.board}`, `ver\t${r.ver}`, `rev\t${r.rev}`, `channel\t${channelOf(r.ver)}`]) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  /* The latest day each id was seen, and the first. */
  const one = async (sql, ...args) =>
    (
      await env.DB.prepare(sql)
        .bind(...args)
        .all()
    ).results[0].n;
  const week = new Date(Date.parse(day) - 6 * 86400000).toISOString().slice(0, 10);
  const gone = new Date(Date.parse(day) - 30 * 86400000).toISOString().slice(0, 10);
  const totals = {
    total: await one("SELECT COUNT(DISTINCT id) AS n FROM seen WHERE first <= ?1", day),
    new_devices: await one("SELECT COUNT(*) AS n FROM (SELECT MIN(first) AS f FROM seen GROUP BY id) WHERE f = ?1", day),
    active1: await one("SELECT COUNT(DISTINCT id) AS n FROM seen WHERE last = ?1", day),
    active7: await one("SELECT COUNT(DISTINCT id) AS n FROM seen WHERE last >= ?1 AND last <= ?2", week, day),
    active30: rows.length,
    lost: await one("SELECT COUNT(*) AS n FROM (SELECT MAX(last) AS l FROM seen GROUP BY id) WHERE l = ?1", gone),
  };
  for (const [k, n] of [
    ["total", totals.total],
    ["new", totals.new_devices],
    ["active1", totals.active1],
    ["active7", totals.active7],
    ["lost", totals.lost],
  ]) {
    counts.set(`${k}\t`, n);
  }
  for (const [k, n] of counts) {
    const [kind, key] = k.split("\t");
    await env.DB.prepare("INSERT OR REPLACE INTO daily (day, kind, key, devices) VALUES (?1, ?2, ?3, ?4)")
      .bind(day, kind, key, n)
      .run();
  }
  return totals;
}

async function seen(url, env, ctx) {
  const id = url.searchParams.get("id") ?? "";
  const board = url.searchParams.get("board") || "unknown";
  const ver = url.searchParams.get("ver") || "unknown";
  /* A revision that does not parse is dropped, never a reason to lose the count. */
  const rev = REV.test(url.searchParams.get("rev") ?? "") ? url.searchParams.get("rev") : "";
  if (!ID.test(id) || !BOARD.test(board) || !VER.test(ver)) {
    return new Response(null, { status: 400, headers: CORS });
  }
  const day = new Date().toISOString().slice(0, 10);
  const prev = (
    await env.DB.prepare("SELECT board, ver, rev FROM seen WHERE id = ?1 ORDER BY month DESC LIMIT 1")
      .bind(id)
      .all()
  ).results[0];
  const r = await env.DB.prepare(
    `INSERT INTO seen (month, id, board, ver, rev, first, last) VALUES (?1, ?2, ?3, ?4, ?6, ?5, ?5)
     ON CONFLICT (month, id) DO UPDATE SET board = ?3, ver = ?4, rev = CASE WHEN ?6 <> '' THEN ?6 ELSE seen.rev END, last = ?5
     WHERE seen.last <> ?5`,
  )
    .bind(day.slice(0, 7), id, board, ver, day, rev)
    .run();
  /* Only the first report of a day goes further. */
  if ((r.meta?.changes ?? r.changes) > 0) {
    const changed = [];
    if (prev) {
      for (const [field, old, now] of [
        ["ver", prev.ver, ver],
        ["board", prev.board, board],
        ["rev", prev.rev, rev],
      ]) {
        if (now && old !== now) changed.push([field, old, now]);
      }
    }
    for (const [field, old, now] of changed) {
      await env.DB.prepare("INSERT INTO changes (day, id, field, old, new) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(day, id, field, old, now)
        .run();
    }
    if (!internal(env, id)) {
      const base = { board, ver, rev: rev || prev?.rev || "", family: familyOf(board, rev || prev?.rev), channel: channelOf(ver) };
      const events = [{ name: "device_seen", params: base }];
      if (!prev) events.push({ name: "device_new", params: base });
      for (const [field, old, now] of changed) {
        if (field === "ver") events.push({ name: "device_updated", params: { ...base, from_ver: old, to_ver: now } });
        if (field === "board") events.push({ name: "device_board_changed", params: { ...base, from_board: old, to_board: now } });
      }
      const user = { u_board: board, u_family: base.family, u_channel: base.channel };
      ctx?.waitUntil(ga(env, await clientId(id), events, user));
    }
  }
  return new Response(null, { status: 204, headers: CORS });
}

const internal = (env, id) => (env.INTERNAL_IDS ?? "").split(",").map((s) => s.trim()).includes(id);

/* 32 hex digits of SHA-256 over the id: stable per device, not the id itself. */
async function clientId(id) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`espkvm-ga:${id}`)));
  return [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/*
 * Send @p events to GA4 through the Measurement Protocol. Device events carry
 * engagement_time_msec and a session per day, so devices count as active
 * users; the daily totals do not, so the cron is never one. A failure is
 * dropped: D1 already has the count.
 */
async function ga(env, client, events, user) {
  if (!env.GA_MEASUREMENT_ID || !env.GA_API_SECRET) return;
  const device = client !== "espkvm-check.daily";
  const session = String(Math.floor(Date.now() / 86400000));
  const body = {
    client_id: client,
    events: events.map((e) => ({
      name: e.name,
      params: device ? { ...e.params, session_id: session, engagement_time_msec: 1 } : e.params,
    })),
  };
  if (user) body.user_properties = Object.fromEntries(Object.entries(user).map(([k, v]) => [k, { value: v }]));
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(env.GA_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA_API_SECRET)}`;
  try {
    await fetch(url, { method: "POST", body: JSON.stringify(body) });
  } catch {
    /* D1 has it */
  }
}

async function stats(req, env) {
  if (!env.STATS_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.STATS_TOKEN}`) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const all = (sql, ...args) =>
    env.DB.prepare(sql)
      .bind(...args)
      .all()
      .then((r) => r.results);
  const month = new URL(req.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  /* New = an id not seen in any earlier month. */
  const body = {
    months: await all(
      `SELECT month, COUNT(*) AS devices,
              SUM(NOT EXISTS (SELECT 1 FROM seen p WHERE p.id = s.id AND p.month < s.month)) AS new
       FROM seen s GROUP BY month ORDER BY month`,
    ),
    month,
    boards: await all(
      "SELECT board, COUNT(*) AS devices FROM seen WHERE month = ?1 GROUP BY board ORDER BY devices DESC",
      month,
    ),
    versions: await all(
      "SELECT ver, COUNT(*) AS devices FROM seen WHERE month = ?1 GROUP BY ver ORDER BY devices DESC",
      month,
    ),
    /* An exact revision where the console sent one, else 1.x or 3.x by the board. */
    revisions: await all(
      `SELECT ${FAMILY} AS rev, COUNT(*) AS devices FROM seen WHERE month = ?1 GROUP BY 1 ORDER BY devices DESC`,
      month,
    ),
    /* The day each id was first seen, from the rows themselves: works back to
     * the first day of the counter. total = all ids known by that day. */
    growth: await all(
      `SELECT day, COUNT(*) AS new FROM (SELECT MIN(first) AS day FROM seen GROUP BY id)
       GROUP BY day ORDER BY day`,
    ),
    daily: await all("SELECT day, kind, key, devices FROM daily ORDER BY day, kind, devices DESC"),
    /* Per day and kind of change: updates from -> to, reflashes, revisions. */
    changes: await all(
      `SELECT day, field, old, new, COUNT(*) AS devices FROM changes
       GROUP BY day, field, old, new ORDER BY day, field, devices DESC`,
    ),
  };
  let total = 0;
  for (const g of body.growth) g.total = total += g.new;
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
