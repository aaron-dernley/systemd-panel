/**
 * Enable, disable, and inspect the status of any systemd unit through
 * swamp — one model instance per unit. Not tied to any particular
 * workload: `systemctl`/`journalctl` exist on any systemd-based Linux
 * host, so this works for a swamp-scheduled workflow's timer, a plain
 * long-running daemon, or any other unit a swamp user wants a typed
 * on/off switch and status view for.
 *
 * Two status-detection paths, chosen by `kind`:
 * - `"timer"` — the toggled unit only ever fires a paired oneshot
 *   `.service`; systemd never logs run *outcomes* against the timer unit
 *   itself, so the run-status signal comes primarily from parsing that
 *   service's journal. The parser is built and verified against real
 *   swamp workflow-runner output (`Gate: N/M passed`, `Assertions: X
 *   passed, Y failed`, `Completed workflow <name> succeeded in <dur>` on
 *   success, `Failed workflow <name> in <dur>` on failure — two distinct
 *   phrasings, not one with a succeeded/failed suffix). When the
 *   journal contains nothing recognizable at all — the paired service
 *   runs something other than `swamp workflow run` (e.g. `swamp model
 *   method run` in a wrapper script) — this falls back to `logUnit`'s own
 *   `systemctl show` exit state (`ActiveState`/`Result`), which systemd
 *   sets from the process's real exit code regardless of what it
 *   printed. Only when even that fallback is indeterminate (still
 *   running, or no structured fields at all — effectively "never run")
 *   is `lastRunRecognized: false` reported with the raw journal tail
 *   preserved, rather than guessing.
 * - `"service"` — a persistent process; status comes from
 *   `systemctl show`'s own structured fields (`ActiveState`, `Result`,
 *   `ActiveEnterTimestamp`), which are always well-formed.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

interface CommandResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

async function runCommand(cmd: string, args: string[]): Promise<CommandResult> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    success: output.success,
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

// --- Pure parsers (unit-testable without mocking Deno.Command) -----------

/**
 * `systemctl is-enabled <unit>` prints its state to stdout regardless of
 * exit code (disabled units exit 1, but still print "disabled") — sync is
 * about detection, not failure, so this never throws on a non-empty
 * result. Only "enabled" counts as `enabled: true`; "static"/"alias"/
 * "indirect"/etc. are real states worth seeing verbatim in `enabledRaw`
 * but aren't what our own `enable`/`disable` methods produce.
 */
export function parseIsEnabled(
  raw: string,
): { enabled: boolean; enabledRaw: string } {
  const enabledRaw = raw.trim() || "unknown";
  return { enabled: enabledRaw === "enabled", enabledRaw };
}

/** Same shape of reasoning as {@link parseIsEnabled}, for `is-active`. */
export function parseIsActive(
  raw: string,
): { active: boolean; activeRaw: string } {
  const activeRaw = raw.trim() || "unknown";
  return { active: activeRaw === "active", activeRaw };
}

/** Result of probing a `kind: "service"` instance via `systemctl show`. */
export interface ServiceStatus {
  lastRunAt: string | null;
  lastRunStatus: "running" | "stopped" | "failed" | "unknown";
  lastRunDetail: string | null;
}

/**
 * Parse `systemctl show <unit> -p ActiveEnterTimestamp,ActiveState,Result`
 * (order-independent `Key=Value` lines) — verified against this family's
 * own `swamp-serve.service` persistent daemon.
 */
export function parseServiceShow(showOutput: string): ServiceStatus {
  const fields: Record<string, string> = {};
  for (const line of showOutput.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  const activeState = fields["ActiveState"];
  const result = fields["Result"];
  const activeEnter = fields["ActiveEnterTimestamp"];
  const lastRunAt = activeEnter && activeEnter !== "n/a" ? activeEnter : null;

  if (activeState === "active" || activeState === "activating") {
    return { lastRunAt, lastRunStatus: "running", lastRunDetail: null };
  }
  if (activeState === "failed") {
    return {
      lastRunAt,
      lastRunStatus: "failed",
      lastRunDetail: `Result=${result ?? "unknown"}`,
    };
  }
  if (result && result !== "success") {
    return {
      lastRunAt,
      lastRunStatus: "failed",
      lastRunDetail: `Result=${result}`,
    };
  }
  if (activeState === "inactive") {
    return { lastRunAt, lastRunStatus: "stopped", lastRunDetail: null };
  }
  return { lastRunAt, lastRunStatus: "unknown", lastRunDetail: null };
}

/** Result of probing a `kind: "timer"` instance's paired service journal. */
export interface TimerJournalStatus {
  lastRunAt: string | null;
  lastRunStatus: "succeeded" | "failed" | "unknown";
  lastRunDetail: string | null;
  lastRunRecognized: boolean;
  rawJournalTail: string | null;
}

const COMPLETED_RE = /Completed workflow \S+ (succeeded|failed) in \S+/;
const FAILED_RE = /Failed workflow \S+ in \S+/;
const GATE_RE = /Gate: (\d+\/\d+ passed(?:, \d+ skipped)?)/;
const ASSERTIONS_RE = /Assertions: (\d+ passed(?:, \d+ failed)?)/;
const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})/;

/**
 * Parse `journalctl -u <logUnit> -o short-iso` lines (newest last) for the
 * last run-completion line a swamp workflow run prints, plus the
 * Gate/Assertions summary lines immediately above it. Two distinct
 * phrasings mark completion, confirmed against this family's own real
 * runs — swamp does not use one consistent "Completed ... succeeded|
 * failed" sentence for both outcomes:
 * - success: "Completed workflow <name> succeeded in <dur>"
 * - failure: "Failed workflow <name> in <dur>" (no "Completed" prefix,
 *   no "failed" suffix word — captured verbatim from a real
 *   `link-integrity` run: "Failed workflow link-integrity in 4.4s")
 *
 * Verified against three real captures on this family's own Pi: a
 * fully-passing `host-health` run ("Gate: 9/9 passed, 0 skipped" /
 * "Assertions: 4 passed"), a `rpi-connect` run that "succeeded" overall
 * while one low-severity assert failed ("Gate: 2/3 passed, 0 skipped" /
 * "Assertions: 0 passed, 1 failed" — exactly the "technically succeeded
 * but still needs a look" case `lastRunDetail` exists for), and a
 * genuinely failed `link-integrity` run ("Assertions: 0 passed, 1
 * failed" / "Failed workflow link-integrity in 4.4s").
 *
 * A journal tail with no recognizable line at all (unit never ran, or a
 * future swamp version changes this log shape) reports
 * `lastRunRecognized: false` with the raw tail preserved, rather than
 * guessing "unknown" was a real signal.
 */
export function parseTimerJournal(lines: string[]): TimerJournalStatus {
  for (let i = lines.length - 1; i >= 0; i--) {
    const completed = COMPLETED_RE.exec(lines[i]);
    const failed = completed ? null : FAILED_RE.exec(lines[i]);
    if (!completed && !failed) continue;
    const status = completed
      ? (completed[1] as "succeeded" | "failed")
      : "failed";
    const tsMatch = ISO_TS_RE.exec(lines[i]);

    let gate: string | null = null;
    let assertions: string | null = null;
    for (let j = i; j >= Math.max(0, i - 4); j--) {
      if (!assertions) assertions = ASSERTIONS_RE.exec(lines[j])?.[1] ?? null;
      if (!gate) gate = GATE_RE.exec(lines[j])?.[1] ?? null;
    }

    const hasFailedAssertion = assertions !== null &&
      /\b[1-9]\d* failed\b/.test(assertions);
    const needsDetail = status === "failed" || hasFailedAssertion;
    const detailParts = needsDetail
      ? [
        gate ? `Gate: ${gate}` : null,
        assertions ? `Assertions: ${assertions}` : null,
      ].filter(
        (part): part is string => part !== null,
      )
      : [];

    return {
      lastRunAt: tsMatch ? tsMatch[1] : null,
      lastRunStatus: status,
      lastRunDetail: detailParts.length > 0 ? detailParts.join("; ") : null,
      lastRunRecognized: true,
      rawJournalTail: null,
    };
  }

  return {
    lastRunAt: null,
    lastRunStatus: "unknown",
    lastRunDetail: null,
    lastRunRecognized: false,
    rawJournalTail: lines.length > 0 ? lines.join("\n") : null,
  };
}

/**
 * Fallback run-outcome signal for a `kind: "timer"` instance whose paired
 * service never prints a recognizable "Completed workflow .../Failed
 * workflow ..." line at all — e.g. a service that runs `swamp model
 * method run` directly (or any other command) rather than `swamp
 * workflow run`. `parseTimerJournal` alone would report every such unit
 * as permanently `lastRunStatus: "unknown"` regardless of whether it's
 * actually succeeding or failing, since it has no workflow-shaped output
 * to parse.
 *
 * `systemctl show`'s `ActiveState`/`Result` fields are authoritative and
 * universal — set by systemd itself from the process's own exit code,
 * independent of anything the process printed — so they work for any
 * oneshot service regardless of what it runs. This only supplies the
 * coarse succeeded/failed signal (no Gate/Assertions detail, since there
 * was nothing workflow-shaped to parse); `probeStatus` only calls this
 * when `parseTimerJournal` found nothing to recognize.
 */
export function deriveFallbackFromServiceState(
  showOutput: string,
): Pick<TimerJournalStatus, "lastRunAt" | "lastRunStatus" | "lastRunDetail"> {
  const service = parseServiceShow(showOutput);
  if (service.lastRunStatus === "failed") {
    return {
      lastRunAt: service.lastRunAt,
      lastRunStatus: "failed",
      lastRunDetail: service.lastRunDetail,
    };
  }
  if (service.lastRunStatus === "stopped") {
    // A oneshot service that exited cleanly (ActiveState=inactive,
    // Result=success) — the closest this signal gets to "succeeded".
    return {
      lastRunAt: service.lastRunAt,
      lastRunStatus: "succeeded",
      lastRunDetail: null,
    };
  }
  // "running" (still mid-execution) or "unknown" (no structured fields
  // at all) — neither maps to a trustworthy succeeded/failed verdict.
  return {
    lastRunAt: service.lastRunAt,
    lastRunStatus: "unknown",
    lastRunDetail: null,
  };
}

// --- Model definition ------------------------------------------------------

const GlobalArgsSchema = z.object({
  unit: z.string().describe(
    'The systemd unit this instance controls — a ".timer" or ".service" ' +
      'unit name, e.g. "myapp.timer" or "myapp.service". enable/disable ' +
      "act on exactly this unit.",
  ),
  logUnit: z.string().optional().describe(
    "The unit whose journal carries this instance's actual run outcomes. " +
      "For a timer, this is normally its paired oneshot .service — " +
      "systemd never logs run results against the timer unit itself. " +
      "Defaults to `unit` when omitted, which is correct for a plain " +
      "long-running service.",
  ),
  kind: z.enum(["service", "timer"]).describe(
    '"service" for a persistent/long-running daemon (status comes from ' +
      '`systemctl show`); "timer" for a scheduled oneshot job (status ' +
      "comes from parsing the paired service's journal).",
  ),
  label: z.string().optional().describe(
    "Human-readable name shown in status output. Defaults to `unit` when omitted.",
  ),
  useSudo: z.boolean().default(true).describe(
    "Prefix enable/disable's systemctl call with sudo. Set false if the " +
      "swamp process already runs as root, or if sudo isn't configured.",
  ),
  systemctlPath: z.string().default("systemctl"),
  journalctlPath: z.string().default("journalctl"),
  sudoPath: z.string().default("sudo"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StatusSchema = z.object({
  unit: z.string(),
  kind: z.enum(["service", "timer"]),
  label: z.string(),
  enabled: z.boolean().describe(
    'True iff `systemctl is-enabled <unit>` reported exactly "enabled".',
  ),
  enabledRaw: z.string().describe(
    'Verbatim is-enabled output — kept because "static"/"masked"/etc. ' +
      "are real states `enabled: false` alone doesn't explain.",
  ),
  active: z.boolean().describe(
    'True iff `systemctl is-active <unit>` reported exactly "active".',
  ),
  activeRaw: z.string(),
  lastRunAt: z.string().nullable().describe(
    "For a timer: the timestamp of its last completed run, parsed from " +
      "the journal. For a service: when the current activation started " +
      "(ActiveEnterTimestamp). Null when it couldn't be determined.",
  ),
  lastRunStatus: z.enum([
    "succeeded",
    "failed",
    "running",
    "stopped",
    "unknown",
  ]).describe(
    "Timer: succeeded/failed from the last workflow-completion journal " +
      "line. Service: running/stopped/failed from systemctl's own state. " +
      "unknown when no recognizable signal was found at all.",
  ),
  lastRunDetail: z.string().nullable().describe(
    "Extra context worth a look: the Gate/Assertions summary for a " +
      'timer\'s non-fully-passing run (even one that still "succeeded" ' +
      "overall), or systemctl's Result value for a stopped/failed " +
      "service. Null when there's nothing notable to add.",
  ),
  lastRunRecognized: z.boolean().describe(
    "False only for a timer whose journal tail matched no known " +
      "run-outcome pattern AND whose paired service's systemctl-show " +
      "fallback was also indeterminate (still running, or never run) — " +
      "meaning lastRunAt/lastRunStatus shouldn't be trusted and " +
      "rawJournalTail needs a human look. True whenever either signal " +
      "produced a trustworthy succeeded/failed verdict, including via " +
      "the systemctl-show fallback for a paired service that doesn't " +
      "run `swamp workflow run`. Always true for a service, whose " +
      "systemctl-show fields are always structured.",
  ),
  rawJournalTail: z.string().nullable().describe(
    "The unparsed journal tail, stored only when lastRunRecognized is " +
      "false; null otherwise and always null for a service.",
  ),
  checkedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

type Status = z.infer<typeof StatusSchema>;

async function probeStatus(globalArgs: GlobalArgs): Promise<Status> {
  const { unit, kind, systemctlPath, journalctlPath } = globalArgs;
  const label = globalArgs.label ?? unit;
  const logUnit = globalArgs.logUnit ?? unit;

  const [isEnabledResult, isActiveResult] = await Promise.all([
    runCommand(systemctlPath, ["is-enabled", unit]),
    runCommand(systemctlPath, ["is-active", unit]),
  ]);
  const { enabled, enabledRaw } = parseIsEnabled(isEnabledResult.stdout);
  const { active, activeRaw } = parseIsActive(isActiveResult.stdout);

  let runStatus: ServiceStatus | TimerJournalStatus;
  if (kind === "service") {
    const show = await runCommand(systemctlPath, [
      "show",
      unit,
      "-p",
      "ActiveEnterTimestamp,ActiveState,Result",
    ]);
    runStatus = parseServiceShow(show.stdout);
  } else {
    const journal = await runCommand(journalctlPath, [
      "-u",
      logUnit,
      "-n",
      "40",
      "--no-pager",
      "-o",
      "short-iso",
    ]);
    const lines = journal.stdout.split("\n").filter((line) => line.length > 0);
    const journalStatus = parseTimerJournal(lines);

    if (journalStatus.lastRunRecognized) {
      runStatus = journalStatus;
    } else {
      // Nothing workflow-shaped in the journal (logUnit runs something
      // other than `swamp workflow run`) — fall back to systemd's own
      // exit-state for logUnit rather than reporting "unknown" forever.
      const show = await runCommand(systemctlPath, [
        "show",
        logUnit,
        "-p",
        "ActiveEnterTimestamp,ActiveState,Result",
      ]);
      const fallback = deriveFallbackFromServiceState(show.stdout);
      const recognized = fallback.lastRunStatus !== "unknown";
      runStatus = {
        ...fallback,
        lastRunRecognized: recognized,
        // Only preserved when even the fallback couldn't produce a
        // trustworthy verdict — matches the field's documented contract
        // (non-null only when lastRunRecognized is false).
        rawJournalTail: recognized ? null : journalStatus.rawJournalTail,
      };
    }
  }

  return {
    unit,
    kind,
    label,
    enabled,
    enabledRaw,
    active,
    activeRaw,
    lastRunAt: runStatus.lastRunAt,
    lastRunStatus: runStatus.lastRunStatus,
    lastRunDetail: runStatus.lastRunDetail,
    lastRunRecognized: "lastRunRecognized" in runStatus
      ? runStatus.lastRunRecognized
      : true,
    rawJournalTail: "rawJournalTail" in runStatus
      ? runStatus.rawJournalTail
      : null,
    checkedAt: new Date().toISOString(),
  };
}

async function setEnabled(
  globalArgs: GlobalArgs,
  enable: boolean,
): Promise<void> {
  const { unit, useSudo, sudoPath, systemctlPath } = globalArgs;
  const systemctlArgs = [enable ? "enable" : "disable", "--now", unit];
  const result = useSudo
    ? await runCommand(sudoPath, [systemctlPath, ...systemctlArgs])
    : await runCommand(systemctlPath, systemctlArgs);
  if (!result.success) {
    throw new Error(
      `systemctl ${systemctlArgs.join(" ")} failed (exit ${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
}

/**
 * Clear a unit's failed-state latch (`systemctl reset-failed`) and restart
 * it. Targets `logUnit` (defaulting to `unit`), not `unit` itself: for a
 * `kind: "timer"` instance, `unit` is the `.timer`, and restarting a timer
 * only reschedules its next fire — it does not re-run the job now. The
 * paired oneshot `.service` (`logUnit`) is what actually needs restarting
 * to retry immediately, which is also exactly the unit whose journal this
 * extension already reads for run status. For a `kind: "service"`
 * instance, `logUnit` defaults to `unit`, so this is a no-op distinction.
 * `reset-failed` runs first so systemd doesn't refuse the restart with
 * "unit is in a failed state" on older systemd versions that gate
 * start-while-failed.
 */
async function restartUnit(globalArgs: GlobalArgs): Promise<void> {
  const { useSudo, sudoPath, systemctlPath } = globalArgs;
  const target = globalArgs.logUnit ?? globalArgs.unit;
  const run = (args: string[]) =>
    useSudo
      ? runCommand(sudoPath, [systemctlPath, ...args])
      : runCommand(systemctlPath, args);

  // Best-effort: a unit that was never in a failed state (e.g. only
  // inactive/stopped) doesn't need its latch cleared, and some systemd
  // versions exit non-zero here when there's nothing to reset.
  await run(["reset-failed", target]);

  const result = await run(["restart", target]);
  if (!result.success) {
    throw new Error(
      `systemctl restart ${target} failed (exit ${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
}

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: MinimalLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Model definition for `@aaronge/systemd-panel` — generic systemd unit control. */
export const model = {
  type: "@aaronge/systemd-panel",
  version: "2026.10.01.3",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.08.27.2",
      description:
        "Version bump, no schema changes (bundled swamp-panel CLI fix only).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.1",
      description:
        "Add restart method. No schema change to existing instances.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.2",
      description:
        "Fix parseTimerJournal to recognize the real 'Failed workflow " +
        "<name> in <dur>' failure phrasing (previously only the success " +
        "phrasing matched, so a genuine failure was misreported as " +
        "lastRunStatus: 'unknown'). No schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.3",
      description:
        "Add a systemctl-show fallback for timer instances whose paired " +
        "service never prints a workflow-shaped journal line (e.g. a " +
        "wrapper script calling 'swamp model method run' directly) — " +
        "previously always reported as lastRunStatus: 'unknown' " +
        "regardless of real outcome. No schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    status: {
      description:
        "Enablement, activation, and last-run status of the controlled unit.",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    sync: {
      description:
        "Refresh status from systemctl/journalctl. Zero-arg, safe, read-only.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        context.logger.info("Syncing status for {unit}", {
          unit: context.globalArgs.unit,
        });
        const status = await probeStatus(context.globalArgs);
        context.logger.info(
          "{unit}: enabled={enabled} active={active} lastRunStatus={lastRunStatus}",
          {
            unit: status.unit,
            enabled: status.enabled,
            active: status.active,
            lastRunStatus: status.lastRunStatus,
          },
        );
        const handle = await context.writeResource("status", "status", status);
        return { dataHandles: [handle] };
      },
    },
    enable: {
      description:
        "systemctl enable --now the controlled unit, then refresh status.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        context.logger.info("Enabling {unit}", {
          unit: context.globalArgs.unit,
        });
        await setEnabled(context.globalArgs, true);
        const status = await probeStatus(context.globalArgs);
        context.logger.info("Enabled {unit}", { unit: status.unit });
        const handle = await context.writeResource("status", "status", status);
        return { dataHandles: [handle] };
      },
    },
    disable: {
      description:
        "systemctl disable --now the controlled unit, then refresh status.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        context.logger.info("Disabling {unit}", {
          unit: context.globalArgs.unit,
        });
        await setEnabled(context.globalArgs, false);
        const status = await probeStatus(context.globalArgs);
        context.logger.info("Disabled {unit}", { unit: status.unit });
        const handle = await context.writeResource("status", "status", status);
        return { dataHandles: [handle] };
      },
    },
    restart: {
      description:
        "Clear any failed-state latch and restart the unit that actually " +
        "runs the job (logUnit, or unit itself for a service), then " +
        "refresh status. For a timer instance this re-runs the paired " +
        "oneshot service immediately rather than just rescheduling it.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const target = context.globalArgs.logUnit ?? context.globalArgs.unit;
        context.logger.info("Restarting {target}", { target });
        await restartUnit(context.globalArgs);
        const status = await probeStatus(context.globalArgs);
        context.logger.info(
          "Restarted {target}: lastRunStatus={lastRunStatus}",
          { target, lastRunStatus: status.lastRunStatus },
        );
        const handle = await context.writeResource("status", "status", status);
        return { dataHandles: [handle] };
      },
    },
  },
};
