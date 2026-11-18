import { T, useGT, useMessages } from "gt-react";

import {
  IMPORT_LIMIT_DEFAULTS,
  IMPORT_LIMITS,
  isImportLimitCustom,
  isImportLimitRaised,
} from "./AgentSessionImportSettings.logic";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ImportLimitControl, RaisedImportLimitsWarning } from "./ImportLimitControl";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function AgentSessionImportSettings() {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const { connectedEnvironments, targets, scope } = useSettingsScope();
  const settings = useScopedSettings((current) => current.agentSessionImport);
  const updateSettings = useUpdateScopedSettings();

  if (scope.kind === "project" || scope.kind === "checkout" || connectedEnvironments.length === 0)
    return null;

  const supportedEnvironments = connectedEnvironments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.agentSessionImportSettings === true,
  );
  const supported = supportedEnvironments.length === connectedEnvironments.length;
  const { id, title } = searchableSetting("agent-session-import");

  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={
        supported
          ? targets.some((target) => isImportLimitCustom(target.settings.agentSessionImport))
            ? gt("Custom limits")
            : gt("Default limits")
          : null
      }
    >
      {supported ? (
        <>
          <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
            <T>
              Limits for importing Claude Code, Codex, and Pi conversations. New limits apply to
              conversations that are not imported yet.
            </T>
          </p>
          {IMPORT_LIMITS.map((limit) => {
            const { key } = limit;
            const label = m(limit.title);
            const mixed = targets.some(
              (target) => target.settings.agentSessionImport[key] !== settings[key],
            );
            return (
              <SettingsRow
                key={key}
                {...searchableSetting(limit.searchId)}
                title={label}
                description={m(limit.description)}
                status={mixed ? gt("Mixed across selected machines") : undefined}
                serverScoped
                managedPaths={[`agentSessionImport.${key}`]}
                resetAction={
                  mixed || settings[key] !== IMPORT_LIMIT_DEFAULTS[key] ? (
                    <SettingResetButton
                      ariaLabel={gt("Reset {label} to default", { label })}
                      onClick={() =>
                        updateSettings({
                          agentSessionImport: { [key]: IMPORT_LIMIT_DEFAULTS[key] },
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <ImportLimitControl
                    limitKey={key}
                    value={settings[key]}
                    mixed={mixed}
                    onChange={(value, onFailed) =>
                      updateSettings({ agentSessionImport: { [key]: value } }, { onFailed })
                    }
                  />
                }
              />
            );
          })}
          {targets.some((target) => isImportLimitRaised(target.settings.agentSessionImport)) && (
            <div className="p-3 sm:p-4">
              <RaisedImportLimitsWarning />
            </div>
          )}
        </>
      ) : (
        <SettingsScopeNotice
          inline
          target="environment"
          targetId={id}
          eligibleEnvironmentIds={supportedEnvironments.map(
            (environment) => environment.environmentId,
          )}
        >
          {gt(
            "Update the selected environments to change import limits, or choose a machine that supports them.",
          )}
        </SettingsScopeNotice>
      )}
    </FoldedSettingsSection>
  );
}
