/* Runs the Worker against node:sqlite standing in for D1. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/index.js";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  let writes = 0;
  return {
    db,
    writes: () => writes,
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const self = {
        bind: (...a) => ((args = a), self),
        run: async () => {
          const r = st.run(...args);
          writes += r.changes;
          return r;
        },
        all: async () => ({ results: st.all(...args) }),
      };
      return self;
    },
  };
}

const ID = "0123456789abcdef0123456789abcdef";
const post = (q) => new Request(`https://check.espkvm.io/v1/seen?${q}`, { method: "POST" });

test("a device counts once a day, once a month", async () => {
  const DB = fakeD1();
  const env = { DB, STATS_TOKEN: "t" };
  const r = await worker.fetch(post(`id=${ID}&board=funcev&ver=v.0.67.0`), env);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  await worker.fetch(post(`id=${ID}&board=funcev&ver=v.0.67.0`), env);
  assert.equal(DB.writes(), 1);
  /* an earlier month: this id is then not new in this one */
  DB.db.exec(`INSERT INTO seen (month, id, board, ver, first, last) VALUES ('2000-01','${ID}','funcev','v1','2000-01-01','2000-01-01')`);
  await worker.fetch(post(`id=${"f".repeat(32)}&board=p4-eth&ver=v.0.67.0`), env);
  const s = await worker.fetch(
    new Request("https://check.espkvm.io/v1/stats", { headers: { Authorization: "Bearer t" } }),
    env,
  );
  const body = await s.json();
  const now = body.months.at(-1);
  assert.equal(now.devices, 2);
  assert.equal(now.new, 1);
  assert.deepEqual(body.versions, [{ ver: "v.0.67.0", devices: 2 }]);
});

test("junk is refused, stats need the token", async () => {
  const env = { DB: fakeD1(), STATS_TOKEN: "t" };
  assert.equal((await worker.fetch(post("id=xyz&board=a&ver=b"), env)).status, 400);
  assert.equal((await worker.fetch(post(`id=${ID}&board=A%20B&ver=1`), env)).status, 400);
  const s = await worker.fetch(new Request("https://check.espkvm.io/v1/stats"), env);
  assert.equal(s.status, 401);
  assert.equal((await worker.fetch(new Request("https://check.espkvm.io/"), env)).status, 404);
});

test("growth by first day, a daily snapshot of the last 30 days", async () => {
  const DB = fakeD1();
  const env = { DB, STATS_TOKEN: "t" };
  const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => x.repeat(32));
  DB.db.exec(`INSERT INTO seen (month, id, board, ver, first, last) VALUES
    ('2026-09','${a}','funcev','v.0.60.0','2026-09-10','2026-09-20'),
    ('2026-10','${a}','funcev','v.0.68.0','2026-10-02','2026-10-28'),
    ('2026-10','${b}','p4-eth','v.0.68.0','2026-10-02','2026-10-02'),
    ('2026-10','${c}','p4-eth','v.0.73.0','2026-10-27','2026-10-29'),
    ('2026-09','${d}','p4-nano','v.0.60.0','2026-09-05','2026-09-29')`);
  await worker.scheduled({ scheduledTime: Date.parse("2026-10-29T23:55:00Z") }, env);
  await worker.scheduled({ scheduledTime: Date.parse("2026-10-29T23:56:00Z") }, env); /* a rerun replaces */
  const s = await worker.fetch(
    new Request("https://check.espkvm.io/v1/stats", { headers: { Authorization: "Bearer t" } }),
    env,
  );
  const body = await s.json();
  assert.deepEqual(body.growth, [
    { day: "2026-09-05", new: 1, total: 1 },
    { day: "2026-09-10", new: 1, total: 2 },
    { day: "2026-10-02", new: 1, total: 3 },
    { day: "2026-10-27", new: 1, total: 4 },
  ]);
  /* d was last seen on 09-29, and the window starts on 09-30 */
  const get = (kind, key) => body.daily.find((r) => r.kind === kind && r.key === key)?.devices;
  assert.equal(get("all", ""), 3);
  assert.equal(get("board", "p4-eth"), 2);
  assert.equal(get("ver", "v.0.68.0"), 2);
  assert.equal(get("ver", "v.0.60.0"), undefined); /* a's latest row wins */
  assert.equal(get("rev", "3.x"), 1); /* funcev */
  assert.equal(get("rev", "1.x"), 2);
  /* all, 2 boards, 2 versions, 2 families, 1 channel (v1-style tags are dev) + the totals */
  assert.equal(get("channel", "release"), 3);
  assert.equal(get("total", ""), 4);
  assert.equal(get("new", ""), 0);
  assert.equal(get("active1", ""), 1); /* c */
  assert.equal(get("active7", ""), 2); /* a, c */
  assert.equal(get("lost", ""), 1); /* d: last seen 09-29, 30 days before */
  assert.equal(body.daily.length, 1 + 2 + 2 + 2 + 1 + 5);
});

test("changes are kept, and the first report of a day goes to GA", async () => {
  const DB = fakeD1();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), new Response(null, { status: 204 }));
  try {
    const waits = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    const mine = "e".repeat(32);
    const env = { DB, STATS_TOKEN: "t", GA_MEASUREMENT_ID: "G-TEST", GA_API_SECRET: "s", INTERNAL_IDS: `x, ${mine}` };
    await worker.fetch(post(`id=${ID}&board=p4-eth&ver=v.0.82.0&rev=1.3`), env, ctx);
    await worker.fetch(post(`id=${ID}&board=p4-eth&ver=v.0.82.0&rev=1.3`), env, ctx); /* same day: nothing */
    DB.db.exec(`UPDATE seen SET last = '2000-01-01'`);
    await worker.fetch(post(`id=${ID}&board=p4-eth-rev3&ver=v.0.83.0-dirty`), env, ctx);
    await worker.fetch(post(`id=${mine}&board=jetkvm-mini&ver=v.0.83.0`), env, ctx); /* counted, not sent */
    await Promise.all(waits);
    assert.equal(sent.length, 2);
    assert.match(sent[0].url, /measurement_id=G-TEST&api_secret=s$/);
    const [first, second] = sent.map((s) => s.body);
    assert.equal(first.client_id, second.client_id);
    assert.notEqual(first.client_id, ID);
    assert.deepEqual(first.events.map((e) => e.name), ["device_seen", "device_new"]);
    assert.equal(first.events[0].params.family, "1.x");
    assert.equal(first.events[0].params.channel, "release");
    assert.equal(first.events[0].params.engagement_time_msec, 1);
    assert.deepEqual(second.events.map((e) => e.name), ["device_seen", "device_updated", "device_board_changed"]);
    assert.equal(second.events[1].params.from_ver, "v.0.82.0");
    assert.equal(second.events[0].params.rev, "1.3"); /* kept from before */
    assert.equal(second.user_properties.u_channel.value, "dev");
    const s = await worker.fetch(
      new Request("https://check.espkvm.io/v1/stats", { headers: { Authorization: "Bearer t" } }),
      env,
    );
    const changes = (await s.json()).changes.map((c) => [c.field, c.old, c.new]);
    assert.deepEqual(changes.sort(), [["board", "p4-eth", "p4-eth-rev3"], ["ver", "v.0.82.0", "v.0.83.0-dirty"]]);
    /* the cron sends the totals as one event, not as a device */
    waits.length = 0;
    sent.length = 0;
    await worker.scheduled({ scheduledTime: Date.now() }, env, ctx);
    await Promise.all(waits);
    assert.equal(sent[0].body.client_id, "espkvm-check.daily");
    assert.equal(sent[0].body.events[0].name, "devices_daily");
    assert.equal(sent[0].body.events[0].params.total, 2);
    assert.equal(sent[0].body.events[0].params.engagement_time_msec, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the chip revision: exact when sent, else the family by board", async () => {
  const DB = fakeD1();
  const env = { DB, STATS_TOKEN: "t" };
  const ids = ["a", "b", "c", "d", "e"].map((c) => c.repeat(32));
  /* an old console: no rev, and junk is dropped, not refused */
  assert.equal((await worker.fetch(post(`id=${ids[0]}&board=p4-eth&ver=v1`), env)).status, 204);
  assert.equal((await worker.fetch(post(`id=${ids[1]}&board=p4-eth-rev3&ver=v1&rev=junk`), env)).status, 204);
  await worker.fetch(post(`id=${ids[2]}&board=funcev&ver=v1`), env);
  await worker.fetch(post(`id=${ids[3]}&board=p4-nano-rev3&ver=v1&rev=3.1`), env);
  await worker.fetch(post(`id=${ids[4]}&board=p4-eth&ver=v1&rev=1.3`), env);
  /* a later report without rev keeps the one known */
  DB.db.exec(`UPDATE seen SET last = '2000-01-01' WHERE id = '${ids[3]}'`);
  await worker.fetch(post(`id=${ids[3]}&board=p4-nano-rev3&ver=v2`), env);
  const s = await worker.fetch(
    new Request("https://check.espkvm.io/v1/stats", { headers: { Authorization: "Bearer t" } }),
    env,
  );
  const body = await s.json();
  const revs = Object.fromEntries(body.revisions.map((r) => [r.rev, r.devices]));
  assert.deepEqual(revs, { "3.x": 2, "1.x": 1, "3.1": 1, "1.3": 1 });
  assert.equal(body.months.at(-1).devices, 5);
});
