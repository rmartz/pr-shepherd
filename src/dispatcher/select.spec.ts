import { describe, expect, it } from "vitest";
import type { DispatchRule } from "./rules";
import type { PrSearchHit } from "./search";
import type {
  AttemptRecord,
  DispatchCandidate,
  SelectionInput,
} from "./select";
import { assignRules, prKey, recordAttempt, selectJobs } from "./select";

const FIX_RULE: DispatchRule = {
  name: "merge-conflict",
  skill: "/fix-review",
  filter: 'label:"merge conflict"',
};
const MERGE_RULE: DispatchRule = {
  name: "approved",
  skill: "/merge",
  filter: 'label:"approved"',
  serialPerRepo: true,
};

function makeHit(overrides: Partial<PrSearchHit> = {}): PrSearchHit {
  return {
    repo: "rmartz/trip-split",
    repoName: "trip-split",
    number: 42,
    headSha: "abc1234",
    url: "https://github.com/rmartz/trip-split/pull/42",
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<PrSearchHit> = {},
  rule: DispatchRule = MERGE_RULE,
): DispatchCandidate {
  const hit = makeHit(overrides);
  return { ...hit, key: prKey(hit), rule };
}

function makeInput(overrides: Partial<SelectionInput>): SelectionInput {
  return {
    candidates: [],
    running: new Map(),
    history: new Map(),
    now: 1_000_000,
    slots: 5,
    cooldownMs: 60_000,
    maxAttempts: 3,
    ...overrides,
  };
}

describe("assignRules", () => {
  it("keeps the highest-priority rule for a PR matching several searches", () => {
    const hit = makeHit();
    const [candidate] = assignRules([
      { rule: FIX_RULE, hits: [hit] },
      { rule: MERGE_RULE, hits: [hit] },
    ]);
    expect(candidate?.rule).toBe(FIX_RULE);
  });

  it("keys PRs by repo and number", () => {
    const candidates = assignRules([
      { rule: MERGE_RULE, hits: [makeHit({ repo: "rmartz/a", number: 7 })] },
    ]);
    expect(candidates.map((c) => c.key)).toEqual(["rmartz/a#7"]);
  });
});

describe("selectJobs", () => {
  it("skips a PR that already has a running job", () => {
    const candidate = makeCandidate();
    const { skipped } = selectJobs(
      makeInput({
        candidates: [candidate],
        running: new Map([[candidate.key, candidate]]),
      }),
    );
    expect(skipped.map((s) => s.reason)).toEqual(["running"]);
  });

  it("caps new jobs at the free slot count", () => {
    const candidates = [1, 2, 3].map((number) =>
      makeCandidate({ number }, FIX_RULE),
    );
    const { jobs } = selectJobs(makeInput({ candidates, slots: 2 }));
    expect(jobs.map((j) => j.number)).toEqual([1, 2]);
  });

  it("selects one serial-rule job per repo per cycle", () => {
    const candidates = [1, 2].map((number) => makeCandidate({ number }));
    const { jobs } = selectJobs(makeInput({ candidates }));
    expect(jobs.map((j) => j.number)).toEqual([1]);
  });

  it("holds a serial-rule job while another runs in the same repo", () => {
    const runningMerge = makeCandidate({ number: 1 });
    const candidate = makeCandidate({ number: 2 });
    const { skipped } = selectJobs(
      makeInput({
        candidates: [candidate],
        running: new Map([[runningMerge.key, runningMerge]]),
      }),
    );
    expect(skipped.map((s) => s.reason)).toEqual(["repo-busy"]);
  });

  it("runs serial-rule jobs in different repos concurrently", () => {
    const candidates = ["rmartz/a", "rmartz/b"].map((repo) =>
      makeCandidate({ repo }),
    );
    const { jobs } = selectJobs(makeInput({ candidates }));
    expect(jobs).toHaveLength(2);
  });

  it("does not serialize non-serial rules within a repo", () => {
    const candidates = [1, 2].map((number) =>
      makeCandidate({ number }, FIX_RULE),
    );
    const { jobs } = selectJobs(makeInput({ candidates }));
    expect(jobs).toHaveLength(2);
  });

  it("holds a same-skill, same-head retry inside the cooldown", () => {
    const candidate = makeCandidate();
    const history = new Map<string, AttemptRecord>([
      [
        candidate.key,
        {
          skill: "/merge",
          headSha: "abc1234",
          attempts: 1,
          lastFinishedAt: 990_000,
        },
      ],
    ]);
    const { skipped } = selectJobs(
      makeInput({ candidates: [candidate], history }),
    );
    expect(skipped.map((s) => s.reason)).toEqual(["cooldown"]);
  });

  it("marks a PR stalled once max attempts is reached on the same head", () => {
    const candidate = makeCandidate();
    const history = new Map<string, AttemptRecord>([
      [
        candidate.key,
        { skill: "/merge", headSha: "abc1234", attempts: 3, lastFinishedAt: 0 },
      ],
    ]);
    const { skipped } = selectJobs(
      makeInput({ candidates: [candidate], history }),
    );
    expect(skipped.map((s) => s.reason)).toEqual(["stalled"]);
  });

  it("dispatches again once the head SHA moves", () => {
    const candidate = makeCandidate({ headSha: "def5678" });
    const history = new Map<string, AttemptRecord>([
      [
        candidate.key,
        {
          skill: "/merge",
          headSha: "abc1234",
          attempts: 3,
          lastFinishedAt: 990_000,
        },
      ],
    ]);
    const { jobs } = selectJobs(
      makeInput({ candidates: [candidate], history }),
    );
    expect(jobs).toEqual([candidate]);
  });

  it("dispatches again once the routed skill changes", () => {
    const candidate = makeCandidate({}, FIX_RULE);
    const history = new Map<string, AttemptRecord>([
      [
        candidate.key,
        {
          skill: "/merge",
          headSha: "abc1234",
          attempts: 3,
          lastFinishedAt: 990_000,
        },
      ],
    ]);
    const { jobs } = selectJobs(
      makeInput({ candidates: [candidate], history }),
    );
    expect(jobs).toEqual([candidate]);
  });
});

describe("recordAttempt", () => {
  it("increments attempts for the same skill and head", () => {
    const candidate = makeCandidate();
    const history = new Map<string, AttemptRecord>([
      [
        candidate.key,
        { skill: "/merge", headSha: "abc1234", attempts: 2, lastFinishedAt: 0 },
      ],
    ]);
    recordAttempt(history, candidate, 500);
    expect(history.get(candidate.key)?.attempts).toBe(3);
  });

  it("resets attempts when the head moved", () => {
    const candidate = makeCandidate({ headSha: "def5678" });
    const history = new Map<string, AttemptRecord>([
      [
        candidate.key,
        { skill: "/merge", headSha: "abc1234", attempts: 2, lastFinishedAt: 0 },
      ],
    ]);
    recordAttempt(history, candidate, 500);
    expect(history.get(candidate.key)?.attempts).toBe(1);
  });
});
