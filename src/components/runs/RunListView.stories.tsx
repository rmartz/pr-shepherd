import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { RunStatus } from "@/db/schemas";
import { RunListView } from "./RunListView";
import { makeRunRow } from "./runFixtures";

const meta = {
  title: "Runs/RunListView",
  component: RunListView,
  parameters: { layout: "padded" },
} satisfies Meta<typeof RunListView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: { rows: [] },
};

export const Running: Story = {
  args: {
    rows: [
      makeRunRow({ id: "r1", prNumber: 12, prTitle: "Add fan-out primitive" }),
      makeRunRow({ id: "r2", prNumber: 9, prTitle: "Wire the scheduler" }),
    ],
  },
};

export const Mixed: Story = {
  args: {
    rows: [
      makeRunRow({
        id: "r1",
        prNumber: 12,
        prTitle: "Running review",
        status: RunStatus.Running,
      }),
      makeRunRow({
        id: "r2",
        prNumber: 11,
        prTitle: "Merged cleanly",
        status: RunStatus.Completed,
      }),
      makeRunRow({
        id: "r3",
        prNumber: 10,
        prTitle: "CI failed",
        status: RunStatus.Failed,
      }),
      makeRunRow({
        id: "r4",
        prNumber: 8,
        prTitle: "Queued",
        status: RunStatus.Pending,
      }),
      makeRunRow({
        id: "r5",
        prNumber: 7,
        prTitle: "Abandoned",
        status: RunStatus.Cancelled,
      }),
    ],
  },
};

export const Nested: Story = {
  args: {
    rows: [
      makeRunRow({ id: "parent", prNumber: 20, prTitle: "Parent run" }, 0),
      makeRunRow(
        {
          id: "child",
          prNumber: 21,
          prTitle: "Child fan-out run",
          parentRunId: "parent",
        },
        1,
      ),
      makeRunRow(
        {
          id: "grandchild",
          prNumber: 22,
          prTitle: "Grandchild run",
          parentRunId: "child",
        },
        2,
      ),
    ],
  },
};
