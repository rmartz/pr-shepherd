import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { StepStatus, StepType } from "@/db/schemas";
import { RunDetailView } from "./RunDetailView";
import { makeStep } from "./stepFixtures";

const meta = {
  title: "Runs/RunDetailView",
  component: RunDetailView,
  parameters: { layout: "padded" },
} satisfies Meta<typeof RunDetailView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: { steps: [] },
};

export const Running: Story = {
  args: {
    steps: [
      makeStep({
        id: "s1",
        stepDefinitionId: "derive_pr_state",
        stepType: StepType.DerivePrState,
        status: StepStatus.Completed,
        createdAt: 1_000_000,
        completedAt: 1_001_500,
      }),
      makeStep({
        id: "s2",
        stepDefinitionId: "review",
        stepType: StepType.ClaudeSkill,
        status: StepStatus.Running,
        createdAt: 1_002_000,
        completedAt: undefined,
      }),
    ],
  },
};

export const Mixed: Story = {
  args: {
    steps: [
      makeStep({
        id: "s1",
        stepDefinitionId: "derive_pr_state",
        stepType: StepType.DerivePrState,
        status: StepStatus.Completed,
        createdAt: 1_000_000,
        completedAt: 1_001_500,
      }),
      makeStep({
        id: "s2",
        stepDefinitionId: "wait_ci",
        stepType: StepType.WaitExternal,
        status: StepStatus.Waiting,
        createdAt: 1_002_000,
        completedAt: undefined,
      }),
      makeStep({
        id: "s3",
        stepDefinitionId: "authorize_ci",
        stepType: StepType.GithubApi,
        status: StepStatus.Queued,
        createdAt: 1_003_000,
        completedAt: undefined,
      }),
      makeStep({
        id: "s4",
        stepDefinitionId: "merge",
        stepType: StepType.GithubApi,
        status: StepStatus.Skipped,
        createdAt: 1_004_000,
        completedAt: 1_004_100,
      }),
    ],
  },
};

export const Failed: Story = {
  args: {
    steps: [
      makeStep({
        id: "s1",
        stepDefinitionId: "derive_pr_state",
        stepType: StepType.DerivePrState,
        status: StepStatus.Completed,
        createdAt: 1_000_000,
        completedAt: 1_001_500,
      }),
      makeStep({
        id: "s2",
        stepDefinitionId: "review",
        stepType: StepType.ClaudeSkill,
        status: StepStatus.Failed,
        createdAt: 1_002_000,
        completedAt: 1_090_000,
      }),
    ],
  },
};
