/**
 * `node:sqlite` shim.
 *
 * The module is a genuine Node builtin, but it is newer than the builtin lists
 * that Vite and Vitest resolve against, so a static `import` from those tools
 * fails with "Failed to load url sqlite". Loading it through createRequire
 * keeps it opaque to static analysis while behaving identically at runtime.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => Database;
}

const { DatabaseSync } = nodeRequire('node:sqlite') as SqliteModule;

export { DatabaseSync };
