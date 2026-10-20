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
  DB.db.exec(`INSERT INTO seen VALUES ('2000-01','${ID}','funcev','v1','2000-01-01','2000-01-01')`);
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
