import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { startDaemon } from "./startup";
import { runMigrations } from "@/db/migrations";

vi.mock("@/db/migrations", () => ({
  runMigrations: vi.fn(),
}));

describe("startDaemon", () => {
  const db: Db = {
    getCollectionMeta: vi.fn(),
    setCollectionMeta: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(runMigrations).mockReset();
  });

  it("runs migrations before startup work continues", async () => {
    vi.mocked(runMigrations).mockResolvedValue({ collections: [] });

    await startDaemon(db);

    expect(vi.mocked(runMigrations)).toHaveBeenCalledWith(db);
  });

  it("rethrows migration failures", async () => {
    const error = new Error("migrations failed");
    vi.mocked(runMigrations).mockRejectedValue(error);

    await expect(startDaemon(db)).rejects.toThrow("migrations failed");
  });
});
