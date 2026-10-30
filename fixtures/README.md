# Demo fixtures (real federal docket data)

All genuine documents are public court records retrieved from CourtListener / RECAP.
The workflows never trust these local copies: at run time they re-fetch the docket
and document metadata from the CourtListener v4 API. The files here exist so the
demo can submit a document (genuine or forged) and so tests can run offline.

## Newton AC/DC Fund, L.P. v. Ermilov, No. 5:26-cv-05055-PCP (N.D. Cal.)

CourtListener docket id `73408471` (court `cand`). Plaintiffs named Circle Internet
Financial (the USDC issuer) as relief defendant, i.e. exactly the party a
court-ordered stablecoin freeze is served on.

| File | Docket entry | What it is | SHA-1 (matches CourtListener `sha1`) |
| --- | --- | --- | --- |
| `entry-18.genuine.pdf` / `.txt` / `.json` | ECF 18, filed 2026-06-05 | Stipulated Consent TRO, as modified. Enjoins transfers from 6 EVM wallets "until further order of this Court". | `ec485c6c5b714a2f1f7c3c365a2835a0e5d7b8bd` |
| `entry-38.pdf` / `.txt` / `.json` | ECF 38, filed 2026-08-03 | Order denying the motion for preliminary injunction. Used by the sweep workflow to dissolve the freeze. | `26009af814db8255e8f3a51d8f709717b8255c0d` |
| `entry-18.forged.pdf` | (none) | Forgery built by `scripts/make_forged_order.py`: wallet 5 (`0xe497...90a0`) whited-out and replaced with `0x4c1f...4e5f`. | `a40c167938d56e15f8959675bb5c7e46dda1bdea` |

Wallets named in ECF 18 (lower-cased):

```
0xf7fcc767de537953b3519d4b3097a24a6dfe1c84
0x898137400867603e6d713cbd40881dd0c79e47cb
0xf02d9f19060ee2dd50047dc6e1e9ebac9ba436fe
0x784cf4b62655486b405eb76731885cc9ed56f42f
0xe497285e466227f4e8648209e34b465daa1f90a0
0x9030d5c596d636eefc8f0ad7b2788ae7e9ef3d46
```

These are mainnet addresses named by a court. On Sepolia nobody controls them, so
the demo shows the freeze by attempting transfers *to* them with `WritToken`.

## Why this case

- The TRO is a **consent** order "until further order", so Fed. R. Civ. P. 65(b)(2)'s
  14-day limit for orders issued *without notice* does not apply. Writ's deterministic
  expiry logic has to tell the two apart.
- The docket later shows the PI being denied (ECF 38), so the freeze must be lifted.
  Nothing in the issuer's systems would notice this without watching the docket.

Also evaluated: *Cohn v. Popescu*, No. 1:24-cv-00337 (E.D. Tex.), an ex parte
pig-butchering TRO with 14-day expiry, extensions, and an amended PI that lifted
three of nine frozen addresses (ECF 15 -> ECF 18). Its 2025 TRO (ECF 38) redacts the
wallet addresses in the public copy, so it is not used as the primary demo.
