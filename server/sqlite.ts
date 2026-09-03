/**
 * Шим над `node:sqlite`: модуль встроенный, но новее списков builtin'ов в Vite и Vitest,
 * поэтому статический import у них падает. createRequire прячет его от статического анализа.
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
