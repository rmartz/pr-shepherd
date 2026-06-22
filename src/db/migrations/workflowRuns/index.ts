import type { Migration } from "../index";
import { initial } from "./001-initial";
import { backfillPaused } from "./002-backfill-paused";

export const workflowRunsMigrations: Migration[] = [initial, backfillPaused];
