import type { Migration } from "../index";
import { initial } from "./001-initial";

export const commandsMigrations: Migration[] = [initial];
