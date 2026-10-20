# check.espkvm.io

Counts the [ESP-KVM](https://github.com/espkvm/espkvm) devices in use. A Cloudflare Worker with a D1 database,
sized for the free plan.

With **Offer firmware updates** on and the project's own manifest address, the
console reports `POST /v1/seen?id=&board=&ver=` once a day after a working
update check ([`src/state/seen.ts`](https://github.com/espkvm/console/blob/main/src/state/seen.ts) in the console). The id is the device's random
`installId` (NVS, not taken from the hardware, a settings reset makes a new
one). One row per device per month; no IP address is stored. The device itself
never sends anything.

`GET /v1/stats[?month=2026-10]` with `Authorization: Bearer <STATS_TOKEN>`
returns devices per month (and how many of them are new), and boards and
versions for one month.

## Deploy

```sh
npx wrangler login
npx wrangler d1 create espkvm-check      # put the id into wrangler.toml
npx wrangler d1 execute espkvm-check --remote --file schema.sql
npx wrangler secret put STATS_TOKEN
npx wrangler deploy                      # also creates the check.espkvm.io custom domain
```

## Test

`npm test` runs it against node's own SQLite in place of D1 (Node 22.5 or
later).

## License

Apache-2.0, see LICENSE.
