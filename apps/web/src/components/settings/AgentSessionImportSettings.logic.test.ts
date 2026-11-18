import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  importLimitsResetPatch,
  importWindowLabel,
  isImportLimitRaised,
} from "./AgentSessionImportSettings.logic";

const defaults = DEFAULT_SERVER_SETTINGS.agentSessionImport;

describe("import limits", () => {
  it("leaves locked and unchanged limits out of Reset to defaults", () => {
    expect(
      importLimitsResetPatch(
        { ...defaults, windowDays: null, messagesPerThread: null, scanBudgetMiB: 64 },
        (key) => key === "windowDays",
      ),
    ).toEqual({ messagesPerThread: 200 });
  });

  it("counts a lifted or higher limit as raised", () => {
    expect(isImportLimitRaised({ ...defaults, windowDays: null })).toBe(true);
    expect(isImportLimitRaised({ ...defaults, windowDays: 20 })).toBe(false);
    expect(isImportLimitRaised({ ...defaults, conversationsPerRun: 250 })).toBe(true);
    expect(isImportLimitRaised(defaults)).toBe(false);
  });

  it("labels the time window by its length", () => {
    expect([1, 30, null].map((days) => importWindowLabel(days))).toEqual([
      "Last day",
      "Last 30 days",
      "All history",
    ]);
  });
});
