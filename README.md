# check.espkvm.io

Counts the [ESP-KVM](https://github.com/espkvm/espkvm) devices in use. A Cloudflare Worker with a D1 database,
sized for the free plan.

With **Offer firmware updates** on and the project's own manifest address, the
console reports `POST /v1/seen?id=&board=&ver=&rev=` once a day after a working
update check ([`src/state/seen.ts`](https://github.com/espkvm/console/blob/main/src/state/seen.ts) in the console). The id is the device's random
`installId` (NVS, not taken from the hardware, a settings reset makes a new
one). `rev` is the chip revision (3.1), sent by consoles from 0.76.0 on. A
value that does not parse is dropped, the device still counts. One row per device per month; no IP address is stored. The device itself
never sends anything.

`GET /v1/stats[?month=2026-10]` with `Authorization: Bearer <STATS_TOKEN>`
returns devices per month (and how many of them are new), boards, versions and
`revisions` for one month (the exact one where it was sent, else `1.x` or `3.x`
by the board's image), `growth` (new devices by the day each was first seen, and the
running total) and `daily`: a snapshot the cron trigger stores each day just
before midnight UTC, of the devices seen in the 30 days up to that day, in all,
by board, by version, by revision and by channel (a tagged release or a dev
build), plus the all-time total, new that day, active that day and in 7 days,
and lost (just fell out of the 30-day window). `changes` lists what devices
changed since their last report: updates (from and to version), another image
(board), a revision first reported.

## Google Analytics

With `GA_MEASUREMENT_ID` (wrangler.toml) and the `GA_API_SECRET` secret set, the
Worker also sends the counts to GA4 through the Measurement Protocol, as a view;
D1 stays the record. The first report of a device each day sends `device_seen`
(and `device_new`, `device_updated`, `device_board_changed` when they apply),
with board, version, revision, family and channel. The cron sends one
`devices_daily` event with the totals above. The GA client id is a hash of the
installId, never the id itself, and GA sees Cloudflare's address, not the
sender's. Ids in the `INTERNAL_IDS` secret (comma separated) are counted in D1
but not sent.

## Deploy

```sh
npx wrangler login
npx wrangler d1 create espkvm-check      # put the id into wrangler.toml
npx wrangler d1 execute espkvm-check --remote --file schema.sql   # a new database
npx wrangler d1 execute espkvm-check --remote --file migrate-rev.sql   # an existing one, before the deploy that needs it
npx wrangler d1 execute espkvm-check --remote --file migrate-changes.sql   # likewise
npx wrangler secret put STATS_TOKEN
npx wrangler secret put GA_API_SECRET    # optional, with INTERNAL_IDS
npx wrangler deploy                      # also creates the check.espkvm.io custom domain and the cron trigger
```

## Test

`npm test` runs it against node's own SQLite in place of D1 (Node 22.5 or
later).

## License

Apache-2.0, see LICENSE.
