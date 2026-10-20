/*
 * check.espkvm.io: counts ESP-KVM devices in use.
 *
 * The console sends POST /v1/seen?id=&board=&ver= after a working update
 * check against the project's own manifest, at most once a day (see the
 * console's src/state/seen.ts). One row per device per month; a second
 * report the same day writes nothing. GET /v1/stats needs the STATS_TOKEN secret.
 *
 * Sized for the free plan: 100k requests a day, and D1's 100k row writes a day.
 */

const CORS = { "Access-Control-Allow-Origin": "*" };

const ID = /^[0-9a-f]{32}$/;
const BOARD = /^[a-z0-9-]{1,40}$/;
const VER = /^[0-9A-Za-z.+-]{1,32}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/seen" && req.method === "POST") return seen(url, env);
    if (url.pathname === "/v1/stats" && req.method === "GET") return stats(req, env);
    return new Response("not found\n", { status: 404, headers: CORS });
  },
};

async function seen(url, env) {
  const id = url.searchParams.get("id") ?? "";
  const board = url.searchParams.get("board") || "unknown";
  const ver = url.searchParams.get("ver") || "unknown";
  if (!ID.test(id) || !BOARD.test(board) || !VER.test(ver)) {
    return new Response(null, { status: 400, headers: CORS });
  }
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO seen (month, id, board, ver, first, last) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (month, id) DO UPDATE SET board = ?3, ver = ?4, last = ?5
     WHERE seen.last <> ?5`,
  )
    .bind(day.slice(0, 7), id, board, ver, day)
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
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
