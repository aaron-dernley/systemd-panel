# @aaronge/systemd-panel

Enable, disable, and inspect the status of any systemd unit through swamp
— one typed, versioned model instance per unit. Not tied to any
particular workload, hardware, or Linux distribution: this wraps
`systemctl`/`journalctl`, which exist on any systemd-based host. Built
originally to give one interactive on/off + status view across a family
of Raspberry Pi extensions each scheduled via its own `systemd.timer`, but
the model itself has no Pi-specific (or even swamp-specific) assumptions
baked in — it works for any systemd unit you point it at.

Two status-detection paths, chosen per instance by the `kind` argument:

- **`timer`** — a scheduled oneshot job (e.g. a `swamp workflow run`
  fired by a `.timer`). Its paired `.service` never logs a "still
  running" state the way a daemon does, so run outcome comes from
  parsing that service's journal for the last completion line.
- **`service`** — a persistent, long-running daemon. Status comes
  straight from `systemctl show`'s own structured fields.

## Installation

```sh
swamp extension pull @aaronge/systemd-panel
```

Optionally, also grab the bundled interactive CLI toolkit
(`swamp-panel`), which ships as a `binaries` entry in the package (so its
executable bit survives the pull) and is cached locally under
`.swamp/pulled-extensions/`. Find it and put it on your `PATH`:

```sh
find .swamp/pulled-extensions -name swamp-panel -exec install -m 755 {} ~/.local/bin/swamp-panel \;
```

`enable`/`disable` shell out to `sudo systemctl enable|disable --now
<unit>` by default (set the `useSudo: false` global argument if your
swamp process already runs as root, or your setup doesn't use sudo).
Passwordless sudo scoped to `systemctl` is the simplest way to make this
non-interactive; that's how this extension's own author runs it.

## Usage

Create one instance per unit you want to control. Every instance needs
`unit` and `kind`; `logUnit` and `label` are optional (`logUnit` defaults
to `unit`, which is correct for a `service`):

```sh
# A scheduled timer — status comes from its paired service's journal
swamp model create @aaronge/systemd-panel my-timer \
  --global-arg unit=my-app.timer \
  --global-arg logUnit=my-app.service \
  --global-arg kind=timer \
  --global-arg label="My App"

# A persistent daemon — status comes from systemctl show directly
swamp model create @aaronge/systemd-panel my-daemon \
  --global-arg unit=my-daemon.service \
  --global-arg kind=service \
  --global-arg label="My Daemon"

swamp model method run my-timer sync
swamp model method run my-timer enable
swamp model method run my-timer disable
swamp model method run my-timer restart
```

Each method writes one resource, `status`. Run `swamp model type describe
@aaronge/systemd-panel` to see the full schema.

Reference the latest snapshot from a workflow assert step or another
model:

```yaml
expr: >-
  data.latest("my-timer", "status").attributes.lastRunStatus == "succeeded"
```

To see every controlled unit at once (across however many instances
you've created), query by model type rather than by name:

```sh
swamp data query 'modelType == "@aaronge/systemd-panel" && dataType == "resource"' --json
```

That's exactly what the bundled `swamp-panel` CLI does:

```sh
swamp-panel            # sync every instance, print a status dashboard
swamp-panel toggle     # numbered menu to enable/disable one interactively
swamp-panel on <name>  # enable one instance directly
swamp-panel off <name> # disable one instance directly
swamp-panel watch      # dashboard in a detached terminal, refreshing every 30s
```

## Global arguments

| Arg              | Default        | Notes                                                                             |
| ---------------- | -------------- | ---------------------------------------------------------------------------------- |
| `unit`           | _(required)_   | The `.timer` or `.service` unit this instance controls.                          |
| `kind`           | _(required)_   | `"timer"` or `"service"` — selects which status-detection path `sync` uses.      |
| `logUnit`        | `unit`         | Unit whose journal holds run outcomes. Set this for a timer to its paired `.service`. |
| `label`          | `unit`         | Human-readable name shown in status output.                                        |
| `useSudo`        | `true`         | Prefix `enable`/`disable`'s systemctl call with `sudo`.                            |
| `systemctlPath`  | `"systemctl"`  | Override for odd installs.                                                        |
| `journalctlPath` | `"journalctl"` | Override for odd installs.                                                        |
| `sudoPath`       | `"sudo"`       | Override for odd installs.                                                        |

## How it works

- **`status`** — `enabled`/`active` come from `systemctl is-enabled`/
  `is-active` on `unit` (never throws on the "off" state — a disabled
  unit reported as `false` is a normal result, not a failure). Run
  outcome depends on `kind`:
  - `timer`: parses `journalctl -u <logUnit> -o short-iso` for the last
    run-completion line a swamp workflow run prints, plus the `Gate: N/M
    passed` / `Assertions: X passed, Y failed` lines immediately above
    it. Two distinct phrasings mark completion — swamp does not use one
    consistent sentence for both outcomes: success prints `Completed
    workflow <name> succeeded in <dur>`; failure prints `Failed workflow
    <name> in <dur>` (no "Completed" prefix at all). Both are recognized
    as of 2026.10.01.2 — an earlier version only matched the success
    phrasing, so a genuine failure was silently reported as
    `lastRunStatus: "unknown"` instead of `"failed"`. A run that technically
    "succeeded" but had a failed low-severity assertion still gets a
    non-null `lastRunDetail` — the exact "needs a look even though it
    didn't fail outright" case this was built to catch. A journal with no
    recognizable line at all (never run, or a future format change) sets
    `lastRunRecognized: false` and preserves the raw tail rather than
    guessing.
  - `service`: reads `systemctl show`'s `ActiveState`/`Result`/
    `ActiveEnterTimestamp` directly — always structured, so
    `lastRunRecognized` is always `true`.

`enable`/`disable` run `systemctl enable|disable --now <unit>` (via sudo
by default), throwing before writing anything if the command fails, then
immediately re-probe status so stored state reflects the change without a
separate `sync` call.

`restart` clears any failed-state latch (`systemctl reset-failed`,
best-effort — its result isn't checked, since a unit that was never
failed has nothing to reset) and restarts whichever unit actually runs
the job: `logUnit` for a `timer` instance (restarting the `.timer` itself
would only reschedule its next fire, not re-run the job now), or `unit`
directly for a `service`. Throws before writing anything if the restart
itself fails, then re-probes status the same way `enable`/`disable` do.
Useful for driving automated remediation (e.g. a health-check workflow
that restarts anything it finds in a failed state) — but note that for a
unit failing due to a persistent external condition (a hardware fault, a
port held by an unrelated process), restarting just re-runs the same
check and gets the same failure; it only helps with genuinely transient
failures.

## Workflow

None bundled — this is an on-demand control/status tool, not a scheduled
job. Run `sync`/`enable`/`disable` (or the `swamp-panel` CLI) whenever you
want a fresh read or want to flip a unit.

## This machine's setup

The Raspberry Pi this extension was built on runs 11 controllable units
across 8 sibling `@aaronge/*` extension repos — 1 persistent service and
10 scheduled timers:

| Instance                       | Unit                                          | Kind    |
| ------------------------------- | ---------------------------------------------- | ------- |
| `apt-inventory`                 | `swamp-serve.service`                          | service |
| `host-health`                   | `swamp-workflow-host-health.timer`             | timer   |
| `rpi-health`                    | `swamp-workflow-rpi-health.timer`              | timer   |
| `rpi-boot-config`                | `swamp-workflow-rpi-boot-config.timer`         | timer   |
| `rpi-connect`                    | `swamp-workflow-rpi-connect.timer`             | timer   |
| `rpi-gpio-inventory`             | `swamp-workflow-rpi-gpio-inventory.timer`      | timer   |
| `rpi-camera`                     | `swamp-workflow-rpi-camera.timer`              | timer   |
| `rpi-metrics-bridge`             | `swamp-workflow-rpi-metrics-bridge.timer`      | timer   |
| `rpi-workflows-thermal-integrity`| `swamp-workflow-rpi-workflows-thermal-integrity.timer` | timer   |
| `rpi-workflows-power-integrity`  | `swamp-workflow-rpi-workflows-power-integrity.timer`   | timer   |
| `rpi-workflows-link-integrity`   | `swamp-workflow-rpi-workflows-link-integrity.timer`    | timer   |

(`rpi-cooling`, `rpi-pcie`, and `rpi-rtc` are deliberately unscheduled on
this machine — their checks are subsumed by `rpi-workflows`, or manual-
only — so they have no systemd unit to control and aren't listed above.)

## License

MIT — see LICENSE for details.
