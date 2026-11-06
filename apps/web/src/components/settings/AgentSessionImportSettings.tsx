import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import { AgentSessionImportDialog } from "./AgentSessionImportDialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

export function AgentSessionImportSettingsSection() {
  const { connectedEnvironments, scope } = useSettingsScope();
  const importableEnvironments = useEnvironmentsWithScope(
    connectedEnvironments,
    AuthOrchestrationOperateScope,
  );
  const [open, setOpen] = useState(false);
  if (scope.kind === "project" || scope.kind === "checkout") return null;

  return (
    <SettingsSection id="agent-session-import" title="Session import">
      <SettingsRow
        {...searchableSetting("import-agent-sessions")}
        description="Add projects and recent conversations from Claude Code, Codex, and Pi. Conversations that were already imported are skipped."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={importableEnvironments.size === 0}
            onClick={() => setOpen(true)}
          >
            Import…
          </Button>
        }
      />
      <AgentSessionImportDialog
        open={open}
        onOpenChange={setOpen}
        environmentIds={connectedEnvironments
          .map((target) => target.environmentId)
          .filter((environmentId) => importableEnvironments.has(environmentId))}
      />
    </SettingsSection>
  );
}
