import { AGENT_SESSION_IMPORT_BOUNDS } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";
import {
  IMPORT_LIMIT_DEFAULTS,
  importLimit,
  type ImportLimitKey,
} from "./AgentSessionImportSettings.logic";

/**
 * Stepper for one import limit; a lifted limit's switch ON means more history. A failed save
 * restores the stored value. Enter blurs and refocuses because Base UI commits on blur, not Enter.
 * `saving` holds only the switch: Base UI commits each arrow step, and disabling the input would
 * drop its focus.
 */
export function ImportLimitControl({
  limitKey,
  value,
  mixed = false,
  disabled = false,
  saving = false,
  describedBy,
  onChange,
}: {
  readonly limitKey: ImportLimitKey;
  readonly value: number | null;
  readonly mixed?: boolean;
  readonly disabled?: boolean;
  readonly saving?: boolean;
  readonly describedBy?: string | undefined;
  readonly onChange: (value: number | null, onFailed: () => void) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const limit = importLimit(limitKey);
  const label = m(limit.title);
  const unit = m(limit.unit);
  const bounds = AGENT_SESSION_IMPORT_BOUNDS[limitKey];
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState<number | null | undefined>(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <div className="flex items-center gap-3">
      {value !== null && (
        <NumberField
          value={draft}
          min={bounds.minimum}
          max={bounds.maximum}
          step={limit.step ?? 1}
          size="sm"
          className="w-auto"
          disabled={disabled}
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) {
              setDraft(value);
              return;
            }
            const rounded = Math.min(bounds.maximum, Math.max(bounds.minimum, Math.round(next)));
            setDraft(rounded);
            if (mixed || rounded !== value) onChange(rounded, () => setSavedValue(undefined));
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={gt("Decrease {label}", { label })} />
            <NumberFieldInput
              aria-label={gt("{label} in {unit}", { label, unit })}
              aria-describedby={describedBy}
              size={new Intl.NumberFormat().format(draft ?? value).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                const input = event.currentTarget;
                input.blur();
                input.focus();
              }}
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {unit}
            </span>
            <NumberFieldIncrement aria-label={gt("Increase {label}", { label })} />
          </NumberFieldGroup>
        </NumberField>
      )}
      {limit.offLabel !== undefined && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            aria-label={m(limit.offLabel)}
            aria-describedby={describedBy}
            checked={value === null}
            disabled={disabled || saving}
            onCheckedChange={(lifted) =>
              onChange(lifted ? null : IMPORT_LIMIT_DEFAULTS[limitKey], () => {})
            }
          />
          {m(limit.offLabel)}
        </label>
      )}
    </div>
  );
}

export function RaisedImportLimitsWarning() {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertDescription>
        <T>Higher limits make imports slower and use more memory.</T>
      </AlertDescription>
    </Alert>
  );
}
