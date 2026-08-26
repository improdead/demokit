# findings-app — the worked example

A deliberately **empty** production-like tenant: `GET /api/findings` really does return
`{"findings": []}`, so the app renders "No findings yet". The patch generator, though, genuinely
works server-side.

That is the exact shape the mock-data policy exists for. `flows/seeded-example.json` stubs the
findings list from `fixtures/findings.json` — **seeding the inputs** — and then lets the product
generate the patch on camera unaided. Stubbing that response instead would be fabricating the
payoff, which the skill refuses.

```bash
python3 examples/findings-app/serve.py &          # 127.0.0.1:8893
bin/demokit probe http://127.0.0.1:8893/          # verdict: empty=true stubbable=true
node fixtures/gen-findings.mjs                    # regenerate the fabricated data
bin/demokit flows/seeded-example.json out/seeded.mp4
```
