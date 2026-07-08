import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RunStatus } from "@/db/schemas";
import { RunListView } from "./RunListView";
import { RUN_LIST_COPY } from "./RunListView.copy";
import { makeRunRow } from "./runFixtures";

afterEach(cleanup);

describe("RunListView empty state", () => {
  it("shows the empty copy when there are no rows", () => {
    render(<RunListView rows={[]} />);
    expect(screen.getByText(RUN_LIST_COPY.empty)).toBeDefined();
  });
});

describe("RunListView renders a run's title, status badge, and metrics", () => {
  it("shows the PR title, the status label, and formatted durations", () => {
    render(
      <RunListView
        rows={[
          makeRunRow({
            id: "r1",
            prTitle: "Add fan-out",
            status: RunStatus.Completed,
            createdAt: 1_000_000,
            completedAt: 1_012_000, // 12s wall-clock
            metrics: {
              totalClaudeMs: 42_000, // 42.0s
              totalActiveMs: 500, // 500ms
              totalScheduleWaitMs: 0,
              totalExternalWaitMs: 0,
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText("Add fan-out")).toBeDefined();
    expect(
      screen.getByText(RUN_LIST_COPY.status[RunStatus.Completed]),
    ).toBeDefined();
    expect(screen.getByText("42.0s")).toBeDefined();
    expect(screen.getByText("500ms")).toBeDefined();
    expect(screen.getByText("12.0s")).toBeDefined();
  });
});

describe("RunListView indents child runs by depth", () => {
  it("applies a depth-proportional left pad to a nested run", () => {
    render(
      <RunListView
        rows={[
          makeRunRow({ id: "parent", prTitle: "Parent" }, 0),
          makeRunRow({ id: "child", prTitle: "Child" }, 2),
        ]}
      />,
    );

    const parentCell = screen.getByText("Parent").closest("div");
    const childCell = screen.getByText("Child").closest("div");
    expect(parentCell?.style.paddingLeft).toBe("0rem");
    expect(childCell?.style.paddingLeft).toBe("3rem");
  });
});

describe("RunListView shows a badge for each run status", () => {
  it("labels a failed run with the failed status copy", () => {
    render(
      <RunListView
        rows={[makeRunRow({ id: "r1", status: RunStatus.Failed })]}
      />,
    );
    expect(
      screen.getByText(RUN_LIST_COPY.status[RunStatus.Failed]),
    ).toBeDefined();
  });
});
