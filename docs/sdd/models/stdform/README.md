# std-lib physical-form prototype

Proves the shared-ports + dormant-bricks mechanic behind `../../STDLIB-SPEC.md`
§9.1 (OD-5, OD-6). Requires `elenchus-cli` ≥ 0.15.0.

- `ports.vrf` — the single shared namespace (`DOMAIN std`, bare `VAR` ports).
- `cache.vrf`, `security.vrf` — bricks: `IMPORT "ports.vrf"`, read `std.<port>`,
  derive **multi-word** outputs in their own domain.
- `app.vrf` — entry: imports ports + all bricks, one `CHECK`.

Run:

```sh
# cache fires, security dormant (untrusted_input unset)
elenchus-cli app.vrf --set "std.read_heavy:true std.latency_sensitive:true"
# both fire — one shared namespace, independent triggers
elenchus-cli app.vrf --set "std.read_heavy:true std.latency_sensitive:true std.untrusted_input:true"
```

Shows: answering a `std.*` port once reaches every brick that reads it; a brick
whose ports are unset stays silent (no fire, no warning); brick outputs must be
multi-word atoms (a bare one-word consequent errors — the reason `cache is_needed`
is not `needed`).
