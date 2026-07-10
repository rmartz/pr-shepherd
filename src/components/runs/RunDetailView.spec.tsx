import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { StepStatus, StepType } from "@/db/schemas";
import { RunDetailView } from "./RunDetailView";
import { RUN_DETAIL_COPY } from "./RunDetailView.copy";
import { makeStep } from "./stepFixtures";

afterEach(cleanup);

describe("RunDetailView empty state", () => {
  it("shows the empty copy when the run has no steps", () => {
    render(<RunDetailView steps={[]} />);
    expect(screen.getByText(RUN_DETAIL_COPY.empty)).toBeDefined();
  });
});

describe("RunDetailView renders a step's status, type, and duration", () => {
  it("shows the status label, step type, and a formatted duration for a finished step", () => {
    render(
      <RunDetailView
        steps={[
          makeStep({
            id: "s1",
            stepDefinitionId: "review",
            stepType: StepType.ClaudeSkill,
            status: StepStatus.Completed,
            createdAt: 1_000_000,
            completedAt: 1_001_500, // 1.5s
          }),
        ]}
      />,
    );

    expect(
      screen.getByText(RUN_DETAIL_COPY.status[StepStatus.Completed]),
    ).toBeDefined();
    expect(screen.getByText(StepType.ClaudeSkill)).toBeDefined();
    expect(screen.getByText("1.5s")).toBeDefined();
  });

  it("shows the ongoing marker for a step still in flight", () => {
    render(
      <RunDetailView
        steps={[
          makeStep({
            id: "s1",
            status: StepStatus.Running,
            completedAt: undefined,
          }),
        ]}
      />,
    );
    expect(screen.getByText(RUN_DETAIL_COPY.ongoing)).toBeDefined();
    expect(
      screen.getByText(RUN_DETAIL_COPY.status[StepStatus.Running]),
    ).toBeDefined();
  });
});

describe("RunDetailView row opens the step drawer affordance", () => {
  it("calls onSelectStep with the clicked step's id", () => {
    const onSelectStep = vi.fn();
    render(
      <RunDetailView
        steps={[
          makeStep({ id: "s1", stepDefinitionId: "derive_pr_state" }),
          makeStep({ id: "s2", stepDefinitionId: "review" }),
        ]}
        onSelectStep={onSelectStep}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /review/ }));
    expect(onSelectStep).toHaveBeenCalledWith("s2");
  });
});
