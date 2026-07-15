/**
 * src/commands/help.js — Re-export so the command auto-loader picks this up
 * from src/commands/ while the actual implementation lives in
 * src/features/help/handler.js.
 */
export { data, execute } from "../features/help/handler.js";
