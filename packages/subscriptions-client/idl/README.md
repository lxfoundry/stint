# The Subscriptions & Allowances program's IDL

`subscriptions.json` is the Codama IDL of the Solana Foundation's Subscriptions & Allowances program
(`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, program version 0.5.0), copied unchanged from
<https://github.com/solana-foundation/subscriptions> at tag `ts-client-v0.5.0`, commit
`5a347ffaa969036061d274d3c91e0277962e2b51`. sha256: `461e1c41da256906644d3e20ab185e97de9d9c141661e1521bf5ef42e255ac40`.
It is distributed under the licence in `LICENSE` (MIT, Solana Foundation).

The client in `../src/generated` is rendered from it by `pnpm --filter @lxfoundry/stint-subscriptions-client run generate`
and committed. To update it: copy the IDL of a later tag, record the tag, commit and hash here, regenerate, and run the
tests of this package, the scheme (`packages/x402`) and the harness (`e2e/test/local-network.test.ts`).
