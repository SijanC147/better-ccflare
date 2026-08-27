# Hextap setup

Onboarding created only local files and did not inspect or mutate any remote repository, secret, ruleset, release, or tap.

Before releasing, make `main` the default branch and enable immutable releases for `SijanC147/better-ccflare`.

Set the one required Actions secret. This command prompts securely; do not put a value in argv or a file:

```sh
gh secret set OP_SERVICE_ACCOUNT_TOKEN --repo github.com/SijanC147/better-ccflare
```

Review the two owned ruleset payloads:

```sh
cat .hextap/rulesets/main.json
cat .hextap/rulesets/release-tags.json
```

Apply each reviewed payload manually:

```sh
gh api --hostname github.com --method POST repos/SijanC147/better-ccflare/rulesets --input .hextap/rulesets/main.json
gh api --hostname github.com --method POST repos/SijanC147/better-ccflare/rulesets --input .hextap/rulesets/release-tags.json
```

The tap registration destination is exactly `Projects/better-ccflare.json`, but the initial tap pull request must not contain that JSON alone. It must pair the byte-exact `.hextap/tap-registration.json` with `Formula/better-ccflare.rb`, and that Formula must declare `class BetterCcflare < Formula`. The tap remains the Formula registry; the paired pull request and merge are owner-controlled manual actions.

Coordinator bootstrap/recovery is an external adopter task:

1. Merge the reviewed onboarding files to `main`, apply the two reviewed rulesets, set the required secret, and enable immutable releases.
2. Push the first stable tag and let the full caller create and verify the immutable source release. When the project is not registered yet, the initial Homebrew publication can stop at the tap registry gate; do not replace or recreate that release.
3. From that immutable release and its verified `SHA256SUMS`, have the coordinator use the trusted pinned toolkit to render the exact Formula. Do not invent checksums or commit a placeholder Formula.
4. Open one tap pull request that adds both `Projects/better-ccflare.json` and the release-backed `Formula/better-ccflare.rb`; merge only after tap CI passes.
5. Dispatch the existing stable tag in `homebrew-only` mode to finish or recover publication. Do not create a replacement tag.

The caller is pinned to stable toolkit tag `v0.4.1` at full commit `67898bb09280a5325b89c1b23a70f2fc8b64ffae`; keep both the tag comment and immutable SHA provenance when upgrading. Never replace the pin with `@main` or a floating major tag.
