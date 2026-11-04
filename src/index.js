/*
 * check.espkvm.io: counts ESP-KVM devices in use.
 *
 * The console sends POST /v1/seen?id=&board=&ver=&rev= after a working update
 * check against the project's own manifest, at most once a day (see the
 * console's src/state/seen.ts). One row per device per month; a second
 * report the same day writes nothing. GET /v1/stats needs the STATS_TOKEN secret.
 * A cron trigger stores a snapshot of the counts once a day (table daily).
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/seen" && req.method === "POST") return seen(url, env);
    if (url.pathname === "/v1/stats" && req.method === "GET") return stats(req, env);
    return new Response("not found\n", { status: 404, headers: CORS });
  },
  async scheduled(event, env) {
    await snapshot(env, new Date(event.scheduledTime).toISOString().slice(0, 10));
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
    for (const k of [`board\t${r.board}`, `ver\t${r.ver}`, `rev\t${r.rev}`]) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of counts) {
    const [kind, key] = k.split("\t");
    await env.DB.prepare("INSERT OR REPLACE INTO daily (day, kind, key, devices) VALUES (?1, ?2, ?3, ?4)")
      .bind(day, kind, key, n)
      .run();
  }
}

async function seen(url, env) {
  const id = url.searchParams.get("id") ?? "";
  const board = url.searchParams.get("board") || "unknown";
  const ver = url.searchParams.get("ver") || "unknown";
  /* A revision that does not parse is dropped, never a reason to lose the count. */
  const rev = REV.test(url.searchParams.get("rev") ?? "") ? url.searchParams.get("rev") : "";
  if (!ID.test(id) || !BOARD.test(board) || !VER.test(ver)) {
    return new Response(null, { status: 400, headers: CORS });
  }
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO seen (month, id, board, ver, rev, first, last) VALUES (?1, ?2, ?3, ?4, ?6, ?5, ?5)
     ON CONFLICT (month, id) DO UPDATE SET board = ?3, ver = ?4, rev = CASE WHEN ?6 <> '' THEN ?6 ELSE seen.rev END, last = ?5
     WHERE seen.last <> ?5`,
  )
    .bind(day.slice(0, 7), id, board, ver, day, rev)
    .run();
  return new Response(null, { status: 204, headers: CORS });
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
  };
  let total = 0;
  for (const g of body.growth) g.total = total += g.new;
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
