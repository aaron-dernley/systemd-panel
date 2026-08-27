// Run with `deno test -A`. -A is needed because probeStatus/setEnabled
// shell out via Deno.Command — see the sibling extensions' test files for
// the same requirement.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  model,
  parseIsActive,
  parseIsEnabled,
  parseServiceShow,
  parseTimerJournal,
} from "./systemd_unit.ts";

// createModelTestContext() returns a MethodContext typed with a default
// Record<string, unknown> globalArgs — narrower than each execute()'s own
// inline context type. This cast bridges that gap; the contextual type at
// each call site (inferred from execute()'s own parameter type) fills in T.
function asContext<T>(context: unknown): T {
  return context as T;
}

const TIMER_GLOBAL_ARGS = {
  unit: "swamp-workflow-host-health.timer",
  logUnit: "swamp-workflow-host-health.service",
  kind: "timer" as const,
  label: "host-health",
  useSudo: true,
  systemctlPath: "systemctl",
  journalctlPath: "journalctl",
  sudoPath: "sudo",
};

const SERVICE_GLOBAL_ARGS = {
  unit: "swamp-serve.service",
  logUnit: "swamp-serve.service",
  kind: "service" as const,
  label: "apt-inventory",
  useSudo: true,
  systemctlPath: "systemctl",
  journalctlPath: "journalctl",
  sudoPath: "sudo",
};

// --- parseIsEnabled / parseIsActive ---------------------------------------

Deno.test("parseIsEnabled recognizes enabled", () => {
  assertEquals(parseIsEnabled("enabled\n"), {
    enabled: true,
    enabledRaw: "enabled",
  });
});

Deno.test("parseIsEnabled treats disabled/static/masked as not enabled, keeping the raw state", () => {
  assertEquals(parseIsEnabled("disabled\n"), {
    enabled: false,
    enabledRaw: "disabled",
  });
  assertEquals(parseIsEnabled("static\n"), {
    enabled: false,
    enabledRaw: "static",
  });
  assertEquals(parseIsEnabled("masked\n"), {
    enabled: false,
    enabledRaw: "masked",
  });
});

Deno.test('parseIsEnabled falls back to "unknown" on empty output rather than guessing', () => {
  assertEquals(parseIsEnabled(""), { enabled: false, enabledRaw: "unknown" });
});

Deno.test("parseIsActive recognizes active vs inactive/failed", () => {
  assertEquals(parseIsActive("active\n"), {
    active: true,
    activeRaw: "active",
  });
  assertEquals(parseIsActive("inactive\n"), {
    active: false,
    activeRaw: "inactive",
  });
  assertEquals(parseIsActive("failed\n"), {
    active: false,
    activeRaw: "failed",
  });
});

// --- parseServiceShow ------------------------------------------------------
//
// The "running" case is captured verbatim from this family's own
// swamp-serve.service; the stopped/failed cases are synthetic but follow
// the same documented `systemctl show -p` key=value shape.

const REAL_RUNNING_SHOW =
  "Result=success\nActiveState=active\nSubState=running\nUnitFileState=enabled\n" +
  "ActiveEnterTimestamp=Tue 2026-08-25 21:49:09 BST\n";

Deno.test("parseServiceShow reports running from a real active swamp-serve.service capture", () => {
  const result = parseServiceShow(REAL_RUNNING_SHOW);
  assertEquals(result.lastRunStatus, "running");
  assertEquals(result.lastRunDetail, null);
  assertEquals(result.lastRunAt, "Tue 2026-08-25 21:49:09 BST");
});

Deno.test("parseServiceShow reports stopped for a cleanly-exited inactive service", () => {
  const result = parseServiceShow(
    "Result=success\nActiveState=inactive\nActiveEnterTimestamp=n/a\n",
  );
  assertEquals(result.lastRunStatus, "stopped");
  assertEquals(result.lastRunDetail, null);
  assertEquals(result.lastRunAt, null);
});

Deno.test("parseServiceShow reports failed with the Result detail when ActiveState=failed", () => {
  const result = parseServiceShow(
    "Result=exit-code\nActiveState=failed\nActiveEnterTimestamp=Wed 2026-08-27 09:00:00 BST\n",
  );
  assertEquals(result.lastRunStatus, "failed");
  assertEquals(result.lastRunDetail, "Result=exit-code");
});

// --- parseTimerJournal ------------------------------------------------------
//
// Both fixtures below are captured verbatim (`journalctl -u <service> -n 15
// --no-pager`, with the timestamp column reformatted to what `-o short-iso`
// actually produces on this host) from this family's real host-health and
// rpi-connect units.

const REAL_HOST_HEALTH_LINES = [
  "2026-08-27T17:00:17+01:00 raspberrypi swamp[306637]: Gate: 9/9 passed, 0 skipped",
  "2026-08-27T17:00:17+01:00 raspberrypi swamp[306637]:   system │ Assertions: 4 passed",
  "2026-08-27T17:00:17+01:00 raspberrypi swamp[306637]:   system │ Completed workflow host-health succeeded in 4.1s · 16:00:17 UTC",
  "2026-08-27T17:00:18+01:00 raspberrypi systemd[1]: swamp-workflow-host-health.service: Deactivated successfully.",
  "2026-08-27T17:00:18+01:00 raspberrypi systemd[1]: Finished swamp-workflow-host-health.service - swamp workflow run host-health (host-health).",
];

Deno.test("parseTimerJournal reports succeeded with no detail for a fully-passing run", () => {
  const result = parseTimerJournal(REAL_HOST_HEALTH_LINES);
  assertEquals(result.lastRunRecognized, true);
  assertEquals(result.lastRunStatus, "succeeded");
  assertEquals(result.lastRunDetail, null);
  assertEquals(result.lastRunAt, "2026-08-27T17:00:17+01:00");
});

const REAL_RPI_CONNECT_LINES = [
  "2026-08-27T17:00:14+01:00 raspberrypi swamp[306638]:   ✓ summarize  —  command/shell  (succeeded)",
  "2026-08-27T17:00:14+01:00 raspberrypi swamp[306638]: Gate: 2/3 passed, 0 skipped",
  "2026-08-27T17:00:14+01:00 raspberrypi swamp[306638]:   system │ Assertions: 0 passed, 1 failed",
  "2026-08-27T17:00:14+01:00 raspberrypi swamp[306638]:   system │ Completed workflow rpi-connect succeeded in 931ms · 16:00:14 UTC",
  "2026-08-27T17:00:15+01:00 raspberrypi systemd[1]: swamp-workflow-rpi-connect.service: Deactivated successfully.",
];

Deno.test("parseTimerJournal surfaces lastRunDetail for a run that succeeded overall but had a failed assertion", () => {
  const result = parseTimerJournal(REAL_RPI_CONNECT_LINES);
  assertEquals(result.lastRunRecognized, true);
  assertEquals(result.lastRunStatus, "succeeded");
  assertEquals(
    result.lastRunDetail,
    "Gate: 2/3 passed, 0 skipped; Assertions: 0 passed, 1 failed",
  );
});

Deno.test("parseTimerJournal reports failed with detail for a genuinely failed run", () => {
  const lines = [
    "2026-08-27T09:00:00+01:00 raspberrypi swamp[1]: Gate: 1/3 passed, 0 skipped",
    "2026-08-27T09:00:00+01:00 raspberrypi swamp[1]: Assertions: 1 passed, 2 failed",
    "2026-08-27T09:00:00+01:00 raspberrypi swamp[1]: Completed workflow example failed in 1.0s · 08:00:00 UTC",
  ];
  const result = parseTimerJournal(lines);
  assertEquals(result.lastRunStatus, "failed");
  assertEquals(
    result.lastRunDetail,
    "Gate: 1/3 passed, 0 skipped; Assertions: 1 passed, 2 failed",
  );
});

Deno.test("parseTimerJournal reports lastRunRecognized=false and preserves the raw tail when nothing matches", () => {
  const lines = [
    "2026-08-27T09:00:00+01:00 raspberrypi systemd[1]: some unrelated log line",
  ];
  const result = parseTimerJournal(lines);
  assertEquals(result.lastRunRecognized, false);
  assertEquals(result.lastRunStatus, "unknown");
  assertEquals(result.rawJournalTail, lines[0]);
});

Deno.test("parseTimerJournal reports lastRunRecognized=false for an empty journal (unit never ran)", () => {
  const result = parseTimerJournal([]);
  assertEquals(result.lastRunRecognized, false);
  assertEquals(result.rawJournalTail, null);
});

// --- sync ------------------------------------------------------------------

Deno.test("sync writes a fully-recognized status for a timer instance", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: TIMER_GLOBAL_ARGS,
    methodName: "sync",
  });

  await withMockedCommand((command, args) => {
    if (command === "systemctl" && args[0] === "is-enabled") {
      return { stdout: "enabled\n", code: 0 };
    }
    if (command === "systemctl" && args[0] === "is-active") {
      return { stdout: "active\n", code: 0 };
    }
    if (command === "journalctl") {
      return { stdout: REAL_HOST_HEALTH_LINES.join("\n") + "\n", code: 0 };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.sync.execute({}, asContext(context)));

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "status");
  const data = written[0].data as {
    enabled: boolean;
    active: boolean;
    lastRunStatus: string;
    lastRunRecognized: boolean;
  };
  assertEquals(data.enabled, true);
  assertEquals(data.active, true);
  assertEquals(data.lastRunStatus, "succeeded");
  assertEquals(data.lastRunRecognized, true);
});

Deno.test("sync writes a running status for a service instance via systemctl show, not journalctl", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: SERVICE_GLOBAL_ARGS,
    methodName: "sync",
  });

  await withMockedCommand((command, args) => {
    if (command === "systemctl" && args[0] === "is-enabled") {
      return { stdout: "enabled\n", code: 0 };
    }
    if (command === "systemctl" && args[0] === "is-active") {
      return { stdout: "active\n", code: 0 };
    }
    if (command === "systemctl" && args[0] === "show") {
      return { stdout: REAL_RUNNING_SHOW, code: 0 };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.sync.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    lastRunStatus: string;
    lastRunAt: string;
  };
  assertEquals(data.lastRunStatus, "running");
  assertEquals(data.lastRunAt, "Tue 2026-08-25 21:49:09 BST");
});

Deno.test("sync reports a disabled/inactive timer without throwing (detection, not failure)", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: TIMER_GLOBAL_ARGS,
    methodName: "sync",
  });

  await withMockedCommand((command, args) => {
    if (command === "systemctl" && args[0] === "is-enabled") {
      return { stdout: "disabled\n", code: 1 };
    }
    if (command === "systemctl" && args[0] === "is-active") {
      return { stdout: "inactive\n", code: 3 };
    }
    if (command === "journalctl") return { stdout: "", code: 0 };
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.sync.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    enabled: boolean;
    active: boolean;
  };
  assertEquals(data.enabled, false);
  assertEquals(data.active, false);
});

// --- enable / disable --------------------------------------------------

Deno.test("enable runs sudo systemctl enable --now, then writes refreshed status", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: TIMER_GLOBAL_ARGS,
    methodName: "enable",
  });

  const calls: string[][] = [];
  await withMockedCommand((command, args) => {
    calls.push([command, ...args]);
    if (command === "sudo") return { stdout: "", code: 0 };
    if (command === "systemctl" && args[0] === "is-enabled") {
      return { stdout: "enabled\n", code: 0 };
    }
    if (command === "systemctl" && args[0] === "is-active") {
      return { stdout: "active\n", code: 0 };
    }
    if (command === "journalctl") return { stdout: "", code: 0 };
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.enable.execute({}, asContext(context)));

  assert(
    calls.some((c) =>
      c[0] === "sudo" && c[1] === "systemctl" && c[2] === "enable" &&
      c[3] === "--now"
    ),
  );
  const data = getWrittenResources()[0].data as { enabled: boolean };
  assertEquals(data.enabled, true);
});

Deno.test("enable skips sudo when useSudo is false", async () => {
  const { context } = createModelTestContext({
    globalArgs: { ...TIMER_GLOBAL_ARGS, useSudo: false },
    methodName: "enable",
  });

  const calls: string[][] = [];
  await withMockedCommand((command, args) => {
    calls.push([command, ...args]);
    if (command === "systemctl" && args[0] === "enable") {
      return { stdout: "", code: 0 };
    }
    if (command === "systemctl" && args[0] === "is-enabled") {
      return { stdout: "enabled\n", code: 0 };
    }
    if (command === "systemctl" && args[0] === "is-active") {
      return { stdout: "active\n", code: 0 };
    }
    if (command === "journalctl") return { stdout: "", code: 0 };
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.enable.execute({}, asContext(context)));

  assert(!calls.some((c) => c[0] === "sudo"));
  assert(calls.some((c) => c[0] === "systemctl" && c[1] === "enable"));
});

Deno.test("enable throws and writes nothing when systemctl enable fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: TIMER_GLOBAL_ARGS,
    methodName: "enable",
  });

  await assertRejects(
    () =>
      withMockedCommand(
        (command) => {
          if (command === "sudo") {
            return {
              stdout: "",
              stderr: "Access denied",
              code: 1,
            };
          }
          throw new Error(`unexpected command in test: ${command}`);
        },
        () => model.methods.enable.execute({}, asContext(context)),
      ).then((r) => r.result),
    Error,
    "Access denied",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("disable runs sudo systemctl disable --now, then writes refreshed status", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: TIMER_GLOBAL_ARGS,
    methodName: "disable",
  });

  const calls: string[][] = [];
  await withMockedCommand((command, args) => {
    calls.push([command, ...args]);
    if (command === "sudo") return { stdout: "", code: 0 };
    if (command === "systemctl" && args[0] === "is-enabled") {
      return { stdout: "disabled\n", code: 1 };
    }
    if (command === "systemctl" && args[0] === "is-active") {
      return { stdout: "inactive\n", code: 3 };
    }
    if (command === "journalctl") return { stdout: "", code: 0 };
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.disable.execute({}, asContext(context)));

  assert(
    calls.some((c) =>
      c[0] === "sudo" && c[1] === "systemctl" && c[2] === "disable" &&
      c[3] === "--now"
    ),
  );
  const data = getWrittenResources()[0].data as { enabled: boolean };
  assertEquals(data.enabled, false);
});

Deno.test("enable on a service instance re-probes via systemctl show, not journalctl", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: SERVICE_GLOBAL_ARGS,
    methodName: "enable",
  });

  await withMockedCommand((command, args) => {
    if (command === "sudo") return { stdout: "", code: 0 };
    if (command === "systemctl" && args[0] === "is-enabled") {
      return { stdout: "enabled\n", code: 0 };
    }
    if (command === "systemctl" && args[0] === "is-active") {
      return { stdout: "active\n", code: 0 };
    }
    if (command === "systemctl" && args[0] === "show") {
      return { stdout: REAL_RUNNING_SHOW, code: 0 };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.enable.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    enabled: boolean;
    lastRunStatus: string;
  };
  assertEquals(data.enabled, true);
  assertEquals(data.lastRunStatus, "running");
});
