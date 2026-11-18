import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ImportLimitControl } from "./ImportLimitControl";

describe("ImportLimitControl", () => {
  it("All history on saves no window and hides the days, and off saves the default window", async () => {
    const onChange = vi.fn();
    await using screen = await render(
      <ImportLimitControl limitKey="windowDays" value={30} onChange={onChange} />,
    );
    await expect.element(screen.getByLabelText("Time window in days")).toHaveValue("30");

    await userEvent.click(screen.getByRole("switch", { name: "All history" }));
    expect(onChange).toHaveBeenLastCalledWith(null, expect.any(Function));

    await screen.rerender(
      <ImportLimitControl limitKey="windowDays" value={null} onChange={onChange} />,
    );
    await expect.element(screen.getByRole("switch", { name: "All history" })).toBeChecked();
    expect(screen.container.querySelector("input:not([type=checkbox])")).toBeNull();

    await userEvent.click(screen.getByRole("switch", { name: "All history" }));
    expect(onChange).toHaveBeenLastCalledWith(30, expect.any(Function));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("Enter saves a typed value clamped to its bounds", async () => {
    const onChange = vi.fn();
    await using screen = await render(
      <ImportLimitControl limitKey="conversationsPerRun" value={100} onChange={onChange} />,
    );
    const input = screen.getByLabelText("Conversations per run in conversations");

    await userEvent.clear(input);
    await userEvent.type(input, "9000{Enter}");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(5000, expect.any(Function));
    await expect.element(input).toHaveValue("5,000");
  });
});
