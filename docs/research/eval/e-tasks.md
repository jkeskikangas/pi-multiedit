# e-tasks: real-commit edit tasks from treat (main)

Fixture: `fixtures/eN` = `git clone --shared` of /Users/pyykkis/work/treat at the parent sha, with every AGENTS.md/CLAUDE.md, .claude/, .codex/, .pi/, opencode.json removed and committed as "eval: strip agent config" (status clean). Built by `setup-e.sh <dir> <sha>`.
Reference: `ref-eN` = same stripped parent with `git diff <parent> <commit>` applied uncommitted (what a perfect run looks like). check.py e-branches use file contents only (no `changed` set dependence), so the result is the same with the commit checked out.

| id | parent -> commit | subject | files |
|---|---|---|---|
| e1 | 9e418b306 -> 314f6da5b | fix(care): reject token-less legacy sessions in VerifiedSession (SEC3) (#1484) | services/care/lib/care_web/verified_session.ex services/care/test/care_web/patient_cases_channel_test.exs |
| e2 | 478c12316 -> 3253c4417 | fix(care): restrict the domain verification token to company admins (SEC4) (#1489) | services/care/lib/care/accounts/company_domain.ex services/care/lib/care/company_domains.ex services/care/test/care/accounts/company_member_read_policy_test.exs |
| e3 | d875275c2 -> c0c0ba670 | Label support Slack alerts and ping the channel without personal data (#1234) | services/care/lib/care/customer_service/notification_config.ex services/care/lib/care/customer_service/slack_sender.ex services/care/test/care/customer_service/notification_config_rules_test.exs services/care/test/care/customer_service/slack_sender_test.exs |
| e4 | 6d2ce0779 -> efb42768b | feat(core): add optional doctor presence and specialty to the case contract | docs/rest-api-state.md packages/api-mock/src/caseAuthority.ts packages/api-mock/src/cases.test.ts packages/api-mock/src/horizonScenarios.ts packages/core/src/schemas/cases.ts |

## Why chosen / caveats

- **e1** (SEC3, 2 files, Elixir lib + test): deletion of a function clause and two private helpers, an alias that becomes unused, and a rewritten test with several new assertions. Well-defined from the body. Caveat: checks require the now-unused `StagingInternalLogin` alias removed (prompt says so); the test check needs >=2 `resolve(%{"user" => ...}) == nil` assertions, one built with `<> ":" <>`.
- **e2** (SEC4, 3 files, Elixir DSL + moduledoc heredoc + test): adds an Ash `field_policies` block, flips `public? false -> true` on an attribute inside a heredoc-documented attribute block, edits prose inside a `@moduledoc """` heredoc, and adds a test plus a setup-context key. Caveat: moduledoc check is loose (some sentence in the moduledoc mentioning token/challenge ... admin).
- **e3** (Slack labels, 4 files, Elixir): struct field addition, new guard-clause normalizer, `load/0` config precedence, a string-concatenation change next to Finnish text ("Avaa asiakaspalvelun työjono"), and two test files with Finnish template strings (ä/ö). Largest task (124+/15-), tests are long; the prompt spells out the exact text format `[<label>] <!channel> ...` because the commit body does not. Caveat: test checks are loose (presence of label/mention/deployment_env, `"unknown` prefix).
- **e4** (TypeScript, 5 files, packages/core + packages/api-mock + docs table): optional nullable field pair added to a zod `strictObject`, mock aggregate populated, horizon scenarios cleared to null, fixture-comparison test adjusted, two Markdown table rows. Context has Finnish ("Liisa Lääkäri"). Caveat: `caseAuthority.ts` has several "Liisa Lääkäri" records; the check accepts populating any of them; the test check only requires the provisional key names and `general_practitioner` in cases.test.ts.

## Validation (python3 check.py eN <dir>)

- e1 parent: `{"pass": false, "failures": ["\"user\" clause still present", "legacy helpers left", "unused StagingInternalLogin alias left", "test still expects legacy session to resolve", "test lacks revoked-token / legacy jti:subject and bare-subject nil assertions"]}`
- e1 ref:    `{"pass": true, "failures": []}`
- e2 parent: `{"pass": false, "failures": ["no field_policies block", "verification_token field policy missing", "bypass or catch-all field policy missing", "verification_token not public? true", "CompanyDomains moduledoc not updated", "member/admin token test missing"]}`
- e2 ref:    `{"pass": true, "failures": []}`
- e3 parent: `{"pass": false, "failures": ["environment_label not in struct", "load/0 does not prefer :deployment_env", "environment normalization missing", "Slack text lacks label/mention/Finnish link text", "sender test lacks label/mention payload", "rules test lacks label normalization / unknown rejection"]}`
- e3 ref:    `{"pass": true, "failures": []}`
- e4 parent: `{"pass": false, "failures": ["doctor_presence schema missing or not optional+nullable", "doctor_specialty schema missing or not optional+nullable", "mock doctor-chat aggregate not populated", "horizon scenarios do not clear fields", "cases test does not handle provisional keys", "docs rows missing"]}`
- e4 ref:    `{"pass": true, "failures": []}`

## Considered and rejected

- 94dd8b486 fix(care): recognize only hexadecimal PDF name escapes: lib change is a one-regex edit; tests depend on a binary priv PDF and a sha256, so too small and too fixture-bound.
- d9ac57b3c admit scanned coverage PDFs: 223+ lines, mostly PDF-parsing logic not derivable from the subject.
- 34d82d0f8 start Req for pre-release employer storage runtime: 6 files including shell scripts and their test harness; the fix leans on deploy/runtime context.
- f8df8c433 pin GCS reads to one generation: 325+ lines across 5 files; too large to specify from the body.
- 8876eebfc provision system actor on deploy: release-task wiring; the body is thin.
- 20cd0ac92 refuse enrollment when the Redis client exits: 11 lines, effectively single-hunk.
- 688db00bd encode D-alusta invoice fields: depends on an external API's encoding rules not stated in the commit.
- e8ecc2cf6 / 85a089f76 / fddb762fd staging staff fixes: subject-only commits whose behaviour is not well-defined without the issue context.
- 952087838, 330b79487, 6f8b707ab and the other refactor/distill commits: refactors or comment-only changes, so there is no checkable behaviour.
- 015191c77 / 9f2b31ec8 typed API objects: touch the generated `.typed-api-baseline`.
- 73bbea3fd, 3e17db8cb, 8ccecfb72: more than 6 files, or migrations/endpoints spread too wide.
- ffbafb724 refactor(api-mock) field rename (TS): a good mechanical rename, but e4 has more substance; kept as a backup.
- 9f1e10622 (TS doctor presence mark in UI): a UI follow-up to e4, so it would need e4's contract first.
