# Implementation plans

The system is specified in [`docs/specs/stint-system.md`](../specs/stint-system.md). This
directory holds the plans that build it.

## How the build is cut

The build proceeds in **stages**. Each stage is a vertical cut through the components: it adds
just enough to the program, the scheme, the facilitator, the gate and the client to make a set of
end-to-end scenarios (spec §12.7) pass on the `local` target. A stage is done when:

- its scenarios pass on `local` and are marked `required` (rule 8 in [`CLAUDE.md`](../../CLAUDE.md));
- every earlier `required` scenario still passes;
- the unit and program tests of the components it touched pass (spec §12.1);
- continuous integration is green on the branch.

All 35 scenarios exist from stage 0 as `pending`, so the run report shows how far the build has
come at any time.

Each stage has its own plan, written when the stage before it is done. A plan can then use what
the earlier stages confirmed (spec §14) and the versions they pinned, instead of guessing.

## Stages

| Stage | Delivers | Scenarios made `required` | Spec §14 questions answered | Plan |
|---|---|---|---|---|
| 0 | Toolchain, workspace, program skeleton, the local harness (embedded Surfpool with its fixtures, Kora), the scenario catalogue, continuous integration | None: a harness self-test | 6 | [00-toolchain-and-harness.md](00-toolchain-and-harness.md) |
| 1 | Walking skeleton: `open` and a `Standard` close in the program; the scheme, facilitator, gate, client and example resource in their minimal form, all through Kora | 1 | 1, 2, 4, 5, 7 | After stage 0 |
| 2 | The example agent's task, scripted; the MCP server; the first devnet deployment and a `devnet` run of scenarios 1 and 22 | 22 | — | After stage 1 |
| 3 | Payment refusals and settlement records | 5, 6, 13, 14, 17, 18, 19, 32 | — | |
| 4 | End of session: `claim`, `AtExpiry`, the gate's timers, the sweeper | 2, 3, 9, 16, 26 | — | |
| 5 | Top-up | 4, 34 | — | |
| 6 | Session tokens and adoption | 8, 20, 35 | — | |
| 7 | Fallback closes: unilateral, sponsored, without the gate or the facilitator | 7, 15, 24, 25 | — | |
| 8 | Closes that protect the buyer: outage and admin, `WaiveMinimum` | 10, 30 | — | |
| 9 | Account edge cases: a closed refund or receiver account, frozen accounts | 21, 27, 28 | — | |
| 10 | Resilience: several gate instances, gate restarts, client restarts, lost settlement replies | 11, 23, 29, 33 | — | |
| 11 | Allowance funding | 12 | 3 | |
| 12 | Long horizon: moving the network's time forward | 31 | — | |

Stages 0 to 2 come first, in that order. From stage 3 on, the order may change. Each plan names
the earlier stages it needs.

## How the program grows

The program is complete only at stage 9. Its LiteSVM tests (spec §12.1) grow with it, and every
instruction gets its tests in the stage that adds it:

| Stage | Instructions and paths added |
|---|---|
| 1 | `open`; `close` (`Standard`); `Opened` and `Closed` events; the account checks of §4.1 |
| 4 | `claim`; `close` (`AtExpiry`); the complete maths of §4.2 with its property tests |
| 5 | `top_up` |
| 8 | `close` (`WaiveMinimum`) |
| 9 | Zero transfers skipped; the residual redirected from a missing refund account; frozen accounts |

The spec gives `claim` no off-chain caller. Stage 4 adds the instruction and its program-client
function, and no automatic caller.

## Conventions for every plan

- Plans are written for an engineer who knows TypeScript and Rust but not this codebase. Every
  step shows the code or the command.
- Test first: write the failing test, run it, implement, run it again, commit.
- A behaviour that crosses components starts as a `pending` scenario and is done only when that
  scenario passes on `local`.
- Each task ends with a commit on the stage's branch. Commit messages are neutral and technical.
- Plans contain no dates and no schedule.
