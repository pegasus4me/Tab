import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomic, single-process persistence. Deploy with a persistent disk and one API worker. */
export class JsonStore<T extends { id: string }> {
  private values: Map<string, T>;
  constructor(private readonly path?: string) {
    const rows: T[] = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    this.values = new Map(rows.map(row => [row.id, row]));
  }
  all() { return [...this.values.values()]; }
  get(id: string) { return this.values.get(id); }
  put(value: T) {
    const next = new Map(this.values); next.set(value.id, value);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.path}.tmp`, JSON.stringify([...next.values()]), { mode: 0o600 });
      renameSync(`${this.path}.tmp`, this.path);
    }
    this.values = next;
    return value;
  }
}
