import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  isManagedSettingPath,
  type AgentSessionImportSettings,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import {
  IMPORT_LIMIT_DEFAULTS,
  IMPORT_LIMITS,
  importLimitsResetPatch,
  importWindowLabel,
  isImportLimitRaised,
  type ImportLimitKey,
} from "../settings/AgentSessionImportSettings.logic";
import { ImportLimitControl, RaisedImportLimitsWarning } from "../settings/ImportLimitControl";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

const RESCAN_LIMIT_KEYS: ReadonlyArray<ImportLimitKey> = ["windowDays", "scanBudgetMiB"];

/**
 * Import limits of the computer being set up. The time window and the scan budget change which
 * projects the scan lists, so saving either rescans, and Start waits for that rescan so it cannot
 * import a list the new limits replace. `onSaved` runs once a patch is saved, before its rescan.
 */
export function useWelcomeImportOptions(
  environmentId: EnvironmentId,
  scan: { readonly isPending: boolean; readonly refresh: () => void } | undefined,
  onSaved: (patch: Partial<AgentSessionImportSettings>) => void,
) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [rescanning, setRescanning] = useState(false);
  const scanPending = scan?.isPending === true;
  if (rescanning && !scanPending) setRescanning(false);
  const save = (patch: Partial<AgentSessionImportSettings>, onFailed?: () => void) => {
    setPendingSaves((count) => count + 1);
    const settle = () => setPendingSaves((count) => count - 1);
    updateSettings(
      { agentSessionImport: patch },
      {
        onSaved: () => {
          settle();
          onSaved(patch);
          if (scan !== undefined && RESCAN_LIMIT_KEYS.some((key) => patch[key] !== undefined)) {
            scan.refresh();
            setRescanning(true);
          }
        },
        onFailed: () => {
          settle();
          onFailed?.();
        },
      },
    );
  };
  const saving = pendingSaves > 0;
  return {
    supported: serverConfig?.environment.capabilities.agentSessionImportSettings === true,
    limits: serverConfig?.settings.agentSessionImport ?? IMPORT_LIMIT_DEFAULTS,
    canWriteSettings,
    lockedBy: (key: ImportLimitKey) =>
      isManagedSettingPath(serverConfig?.managedPolicy, `agentSessionImport.${key}`)
        ? serverConfig?.managedPolicy?.organization
        : undefined,
    saving,
    blocksStart: saving || (rescanning && scanPending),
    save,
  };
}

export type WelcomeImportOptionsState = ReturnType<typeof useWelcomeImportOptions>;

export function WelcomeImportOptions({ options }: { readonly options: WelcomeImportOptionsState }) {
  const m = useMessages();
  const { limits, canWriteSettings, lockedBy, saving, save } = options;
  const resetPatch = importLimitsResetPatch(limits, (key) => lockedBy(key) !== undefined);
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
        {importWindowLabel(limits.windowDays, m)}
        <ChevronDownIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup align="end" width="xl">
        <div className="flex min-h-6 items-center justify-between gap-2">
          <PopoverTitle>
            <T>Import history</T>
          </PopoverTitle>
          {canWriteSettings && Object.keys(resetPatch).length > 0 ? (
            <Button variant="ghost" size="xs" disabled={saving} onClick={() => save(resetPatch)}>
              <T>Reset to defaults</T>
            </Button>
          ) : null}
        </div>
        <div className="mt-3 space-y-2">
          {IMPORT_LIMITS.map((limit) => (
            <ImportLimitRow
              key={limit.key}
              limitKey={limit.key}
              title={m(limit.title)}
              value={limits[limit.key]}
              editable={canWriteSettings}
              saving={saving}
              managedBy={lockedBy(limit.key)}
              onChange={(value, onFailed) => save({ [limit.key]: value }, onFailed)}
            />
          ))}
        </div>
        {canWriteSettings ? null : (
          <p className="mt-3 text-xs text-muted-foreground">
            <T>This connection cannot change import settings.</T>
          </p>
        )}
        {isImportLimitRaised(limits) ? (
          <div className="mt-3">
            <RaisedImportLimitsWarning />
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function ImportLimitRow({
  limitKey,
  title,
  value,
  editable,
  saving,
  managedBy,
  onChange,
}: {
  readonly limitKey: ImportLimitKey;
  readonly title: string;
  readonly value: number | null;
  readonly editable: boolean;
  readonly saving: boolean;
  readonly managedBy: string | undefined;
  readonly onChange: (value: number | null, onFailed: () => void) => void;
}) {
  const gt = useGT();
  const managedId = useId();
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs text-foreground">{title}</p>
        {managedBy === undefined ? null : (
          <p id={managedId} className="text-xs text-muted-foreground">
            {gt("Managed by {organization}.", { organization: managedBy })}
          </p>
        )}
      </div>
      <ImportLimitControl
        limitKey={limitKey}
        value={value}
        disabled={!editable || managedBy !== undefined}
        saving={saving}
        describedBy={managedBy === undefined ? undefined : managedId}
        onChange={onChange}
      />
    </div>
  );
}
