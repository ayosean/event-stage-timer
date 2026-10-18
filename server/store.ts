import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initialState, type State } from "../shared/timer.js";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS auth (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);",
    );
  }
  load(): State {
    const row = this.db.prepare("SELECT body FROM state WHERE id=1").get() as
      { body: string } | undefined;
    if (row) return JSON.parse(row.body);
    const s = initialState();
    this.save(s);
    return s;
  }
  save(state: State) {
    this.db
      .prepare(
        "INSERT INTO state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(JSON.stringify(state));
  }
  close() {
    this.db.close();
  }
}
