# ladder brick prototype — the security gradient

Proves a concern **gradient** (STDLIB-SPEC §9) expresses cleanly: a `ONEOF`
choice port drives an escalating stack of mechanisms, and the extreme rung fires
its trade-off. Requires `elenchus-cli` ≥ 0.15.0.

```sh
# top of ladder: regulated data + compute-on-encrypted
elenchus-cli app.vrf --data d-regulated.vrf
#   -> encryption_at_rest + field_encryption + homomorphic + tradeoff pay_cost_and_latency
# low rung: internal data
elenchus-cli app.vrf --data d-internal.vrf
#   -> authentication only
```

Mechanics shown:
- cumulative escalation via an ordinal derived atom (`is_confidential_or_up`);
- the extreme rung (`homomorphic`) fires its trade-off (`pay_cost_and_latency`);
- a **choice / `ONEOF` port** is supplied via `--data` / `values` (PROVIDE with a
  qualified multi-word key), NOT `--set` (which is whitespace-tokenized and cannot
  carry a multi-word atom). Boolean `VAR` ports still go through `--set` / `values`.
