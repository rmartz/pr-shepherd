import type { Migration } from "../index";
import { initial } from "./001-initial";

export const workflowDefinitionsMigrations: Migration[] = [initial];
