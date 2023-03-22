// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.
import {
  assert,
  assertEquals,
  AssertionError,
  assertRejects,
  assertThrows,
} from "./test_util.ts";

Deno.test({
  name: "openKv :memory: no permissions",
  permissions: {},
  async fn() {
    const db = await Deno.openKv(":memory:");
    await db.close();
  },
});

Deno.test({
  name: "openKv invalid filenames",
  permissions: {},
  async fn() {
    await assertRejects(
      async () => await Deno.openKv(""),
      TypeError,
      "Filename cannot be empty",
    );
    await assertRejects(
      async () => await Deno.openKv(":foo"),
      TypeError,
      "Filename cannot start with ':' unless prefixed with './'",
    );
  },
});

function dbTest(name: string, fn: (db: Deno.Kv) => Promise<void>) {
  Deno.test({
    name,
    async fn() {
      const db: Deno.Kv = await Deno.openKv(
        ":memory:",
      );
      try {
        await fn(db);
      } finally {
        await db.close();
      }
    },
  });
}

dbTest("basic read-write-delete and versionstamps", async (db) => {
  const result1 = await db.get(["a"]);
  assertEquals(result1.key, ["a"]);
  assertEquals(result1.value, null);
  assertEquals(result1.versionstamp, null);

  await db.set(["a"], "b");
  const result2 = await db.get(["a"]);
  assertEquals(result2.key, ["a"]);
  assertEquals(result2.value, "b");
  assertEquals(result2.versionstamp, "00000000000000010000");

  await db.set(["a"], "c");
  const result3 = await db.get(["a"]);
  assertEquals(result3.key, ["a"]);
  assertEquals(result3.value, "c");
  assertEquals(result3.versionstamp, "00000000000000020000");

  await db.delete(["a"]);
  const result4 = await db.get(["a"]);
  assertEquals(result4.key, ["a"]);
  assertEquals(result4.value, null);
  assertEquals(result4.versionstamp, null);
});

const VALUE_CASES = [
  { name: "string", value: "hello" },
  { name: "number", value: 42 },
  { name: "bigint", value: 42n },
  { name: "boolean", value: true },
  { name: "null", value: null },
  { name: "undefined", value: undefined },
  { name: "Date", value: new Date(0) },
  { name: "Uint8Array", value: new Uint8Array([1, 2, 3]) },
  { name: "ArrayBuffer", value: new ArrayBuffer(3) },
  { name: "array", value: [1, 2, 3] },
  { name: "object", value: { a: 1, b: 2 } },
  { name: "nested array", value: [[1, 2], [3, 4]] },
  { name: "nested object", value: { a: { b: 1 } } },
];

for (const { name, value } of VALUE_CASES) {
  dbTest(`set and get ${name} value`, async (db) => {
    await db.set(["a"], value);
    const result = await db.get(["a"]);
    assertEquals(result.key, ["a"]);
    assertEquals(result.value, value);
  });
}

dbTest("set and get recursive object", async (db) => {
  // deno-lint-ignore no-explicit-any
  const value: any = { a: undefined };
  value.a = value;
  await db.set(["a"], value);
  const result = await db.get(["a"]);
  assertEquals(result.key, ["a"]);
  // deno-lint-ignore no-explicit-any
  const resultValue: any = result.value;
  assert(resultValue.a === resultValue);
});

const keys = [
  ["a"],
  ["a", "b"],
  ["a", "b", "c"],
  [1],
  ["a", 1],
  ["a", 1, "b"],
  [1n],
  ["a", 1n],
  ["a", 1n, "b"],
  [true],
  ["a", true],
  ["a", true, "b"],
  [new Uint8Array([1, 2, 3])],
  ["a", new Uint8Array([1, 2, 3])],
  ["a", new Uint8Array([1, 2, 3]), "b"],
  [1, 1n, true, new Uint8Array([1, 2, 3]), "a"],
];

for (const key of keys) {
  dbTest(`set and get ${Deno.inspect(key)} key`, async (db) => {
    await db.set(key, "b");
    const result = await db.get(key);
    assertEquals(result.key, key);
    assertEquals(result.value, "b");
  });
}

const INVALID_KEYS = [
  [null],
  [undefined],
  [],
  [{}],
  [new Date()],
  [new ArrayBuffer(3)],
  [new Uint8Array([1, 2, 3]).buffer],
  [["a", "b"]],
];

for (const key of INVALID_KEYS) {
  dbTest(`set and get invalid key ${Deno.inspect(key)}`, async (db) => {
    await assertRejects(
      async () => {
        // @ts-ignore - we are testing invalid keys
        await db.set(key, "b");
      },
      Error,
    );
  });
}

dbTest("compare and mutate", async (db) => {
  await db.set(["t"], "1");

  const currentValue = await db.get(["t"]);
  assertEquals(currentValue.versionstamp, "00000000000000010000");

  let ok = await db.atomic()
    .check({ key: ["t"], versionstamp: currentValue.versionstamp })
    .set(currentValue.key, "2")
    .commit();
  assertEquals(ok, true);

  const newValue = await db.get(["t"]);
  assertEquals(newValue.versionstamp, "00000000000000020000");
  assertEquals(newValue.value, "2");

  ok = await db.atomic()
    .check({ key: ["t"], versionstamp: currentValue.versionstamp })
    .set(currentValue.key, "3")
    .commit();
  assertEquals(ok, false);

  const newValue2 = await db.get(["t"]);
  assertEquals(newValue2.versionstamp, "00000000000000020000");
  assertEquals(newValue2.value, "2");
});

dbTest("compare and mutate not exists", async (db) => {
  let ok = await db.atomic()
    .check({ key: ["t"], versionstamp: null })
    .set(["t"], "1")
    .commit();
  assertEquals(ok, true);

  const newValue = await db.get(["t"]);
  assertEquals(newValue.versionstamp, "00000000000000010000");
  assertEquals(newValue.value, "1");

  ok = await db.atomic()
    .check({ key: ["t"], versionstamp: null })
    .set(["t"], "2")
    .commit();
  assertEquals(ok, false);
});

dbTest("compare multiple and mutate", async (db) => {
  await db.set(["t1"], "1");
  await db.set(["t2"], "2");

  const currentValue1 = await db.get(["t1"]);
  assertEquals(currentValue1.versionstamp, "00000000000000010000");
  const currentValue2 = await db.get(["t2"]);
  assertEquals(currentValue2.versionstamp, "00000000000000020000");

  const ok = await db.atomic()
    .check({ key: ["t1"], versionstamp: currentValue1.versionstamp })
    .check({ key: ["t2"], versionstamp: currentValue2.versionstamp })
    .set(currentValue1.key, "3")
    .set(currentValue2.key, "4")
    .commit();
  assertEquals(ok, true);

  const newValue1 = await db.get(["t1"]);
  assertEquals(newValue1.versionstamp, "00000000000000030000");
  assertEquals(newValue1.value, "3");
  const newValue2 = await db.get(["t2"]);
  assertEquals(newValue2.versionstamp, "00000000000000030000");
  assertEquals(newValue2.value, "4");

  // just one of the two checks failed
  const ok2 = await db.atomic()
    .check({ key: ["t1"], versionstamp: newValue1.versionstamp })
    .check({ key: ["t2"], versionstamp: null })
    .set(newValue1.key, "5")
    .set(newValue2.key, "6")
    .commit();
  assertEquals(ok2, false);

  const newValue3 = await db.get(["t1"]);
  assertEquals(newValue3.versionstamp, "00000000000000030000");
  assertEquals(newValue3.value, "3");
  const newValue4 = await db.get(["t2"]);
  assertEquals(newValue4.versionstamp, "00000000000000030000");
  assertEquals(newValue4.value, "4");
});

dbTest("atomic mutation ordering (set before delete)", async (db) => {
  await db.set(["a"], "1");
  const ok1 = await db.atomic()
    .set(["a"], "2")
    .delete(["a"])
    .commit();
  assert(ok1);
  const result = await db.get(["a"]);
  assertEquals(result.value, null);
});

dbTest("atomic mutation ordering (delete before set)", async (db) => {
  await db.set(["a"], "1");
  const ok1 = await db.atomic()
    .delete(["a"])
    .set(["a"], "2")
    .commit();
  assert(ok1);
  const result = await db.get(["a"]);
  assertEquals(result.value, "2");
});

dbTest("atomic mutation type=set", async (db) => {
  const ok = await db.atomic()
    .mutate({ key: ["a"], value: "1", type: "set" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assertEquals(result.value, "1");
});

dbTest("atomic mutation type=set overwrite", async (db) => {
  await db.set(["a"], "1");
  const ok = await db.atomic()
    .mutate({ key: ["a"], value: "2", type: "set" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assertEquals(result.value, "2");
});

dbTest("atomic mutation type=delete", async (db) => {
  await db.set(["a"], "1");
  const ok = await db.atomic()
    .mutate({ key: ["a"], type: "delete" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assertEquals(result.value, null);
});

dbTest("atomic mutation type=delete no exists", async (db) => {
  const ok = await db.atomic()
    .mutate({ key: ["a"], type: "delete" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assertEquals(result.value, null);
});

dbTest("atomic mutation type=sum", async (db) => {
  await db.set(["a"], new Deno.KvU64(10n));
  const ok = await db.atomic()
    .mutate({ key: ["a"], value: new Deno.KvU64(1n), type: "sum" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assertEquals(result.value, new Deno.KvU64(11n));
});

dbTest("atomic mutation type=sum no exists", async (db) => {
  const ok = await db.atomic()
    .mutate({ key: ["a"], value: new Deno.KvU64(1n), type: "sum" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assert(result.value);
  assertEquals(result.value, new Deno.KvU64(1n));
});

dbTest("atomic mutation type=sum wrap around", async (db) => {
  await db.set(["a"], new Deno.KvU64(0xffffffffffffffffn));
  const ok = await db.atomic()
    .mutate({ key: ["a"], value: new Deno.KvU64(10n), type: "sum" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assertEquals(result.value, new Deno.KvU64(9n));

  const ok2 = await db.atomic()
    .mutate({
      key: ["a"],
      value: new Deno.KvU64(0xffffffffffffffffn),
      type: "sum",
    })
    .commit();
  assert(ok2);
  const result2 = await db.get(["a"]);
  assertEquals(result2.value, new Deno.KvU64(8n));
});

dbTest("atomic mutation type=sum wrong type in db", async (db) => {
  await db.set(["a"], 1);
  assertRejects(
    async () => {
      await db.atomic()
        .mutate({ key: ["a"], value: new Deno.KvU64(1n), type: "sum" })
        .commit();
    },
    TypeError,
    "Failed to perform 'sum' mutation on a non-U64 value in the database",
  );
});

dbTest("atomic mutation type=sum wrong type in mutation", async (db) => {
  await db.set(["a"], new Deno.KvU64(1n));
  assertRejects(
    async () => {
      await db.atomic()
        // @ts-expect-error wrong type is intentional
        .mutate({ key: ["a"], value: 1, type: "sum" })
        .commit();
    },
    TypeError,
    "Failed to perform 'sum' mutation on a non-U64 operand",
  );
});

dbTest("atomic mutation type=min", async (db) => {
  await db.set(["a"], new Deno.KvU64(10n));
  const ok = await db.atomic()
    .mutate({ key: ["a"], value: new Deno.KvU64(5n), type: "min" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assertEquals(result.value, new Deno.KvU64(5n));

  const ok2 = await db.atomic()
    .mutate({ key: ["a"], value: new Deno.KvU64(15n), type: "min" })
    .commit();
  assert(ok2);
  const result2 = await db.get(["a"]);
  assertEquals(result2.value, new Deno.KvU64(5n));
});

dbTest("atomic mutation type=min no exists", async (db) => {
  const ok = await db.atomic()
    .mutate({ key: ["a"], value: new Deno.KvU64(1n), type: "min" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assert(result.value);
  assertEquals(result.value, new Deno.KvU64(1n));
});

dbTest("atomic mutation type=min wrong type in db", async (db) => {
  await db.set(["a"], 1);
  assertRejects(
    async () => {
      await db.atomic()
        .mutate({ key: ["a"], value: new Deno.KvU64(1n), type: "min" })
        .commit();
    },
    TypeError,
    "Failed to perform 'min' mutation on a non-U64 value in the database",
  );
});

dbTest("atomic mutation type=min wrong type in mutation", async (db) => {
  await db.set(["a"], new Deno.KvU64(1n));
  assertRejects(
    async () => {
      await db.atomic()
        // @ts-expect-error wrong type is intentional
        .mutate({ key: ["a"], value: 1, type: "min" })
        .commit();
    },
    TypeError,
    "Failed to perform 'min' mutation on a non-U64 operand",
  );
});

dbTest("atomic mutation type=max", async (db) => {
  await db.set(["a"], new Deno.KvU64(10n));
  const ok = await db.atomic()
    .mutate({ key: ["a"], value: new Deno.KvU64(5n), type: "max" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assertEquals(result.value, new Deno.KvU64(10n));

  const ok2 = await db.atomic()
    .mutate({ key: ["a"], value: new Deno.KvU64(15n), type: "max" })
    .commit();
  assert(ok2);
  const result2 = await db.get(["a"]);
  assertEquals(result2.value, new Deno.KvU64(15n));
});

dbTest("atomic mutation type=max no exists", async (db) => {
  const ok = await db.atomic()
    .mutate({ key: ["a"], value: new Deno.KvU64(1n), type: "max" })
    .commit();
  assert(ok);
  const result = await db.get(["a"]);
  assert(result.value);
  assertEquals(result.value, new Deno.KvU64(1n));
});

dbTest("atomic mutation type=max wrong type in db", async (db) => {
  await db.set(["a"], 1);
  assertRejects(
    async () => {
      await db.atomic()
        .mutate({ key: ["a"], value: new Deno.KvU64(1n), type: "max" })
        .commit();
    },
    TypeError,
    "Failed to perform 'max' mutation on a non-U64 value in the database",
  );
});

dbTest("atomic mutation type=max wrong type in mutation", async (db) => {
  await db.set(["a"], new Deno.KvU64(1n));
  assertRejects(
    async () => {
      await db.atomic()
        // @ts-expect-error wrong type is intentional
        .mutate({ key: ["a"], value: 1, type: "max" })
        .commit();
    },
    TypeError,
    "Failed to perform 'max' mutation on a non-U64 operand",
  );
});

Deno.test("KvU64 comparison", () => {
  const a = new Deno.KvU64(1n);
  const b = new Deno.KvU64(1n);
  assertEquals(a, b);
  assertThrows(() => {
    assertEquals(a, new Deno.KvU64(2n));
  }, AssertionError);
});

Deno.test("KvU64 overflow", () => {
  assertThrows(() => {
    new Deno.KvU64(2n ** 64n);
  }, RangeError);
});

Deno.test("KvU64 underflow", () => {
  assertThrows(() => {
    new Deno.KvU64(-1n);
  }, RangeError);
});

Deno.test("KvU64 frozen", () => {
  const a = new Deno.KvU64(1n);
  assertThrows(() => {
    // @ts-expect-error value is readonly
    a.value = 2n;
  }, TypeError);
});

Deno.test("KvU64 unbox", () => {
  const a = new Deno.KvU64(1n);
  assertEquals(a.value, 1n);
});

async function collect(iter: Deno.KvListIterator): Promise<Deno.KvEntry[]> {
  const entries: Deno.KvEntry[] = [];
  for await (const entry of iter) {
    entries.push(entry);
  }
  return entries;
}

async function setupData(db: Deno.Kv) {
  await db.atomic()
    .set(["a"], -1)
    .set(["a", "a"], 0)
    .set(["a", "b"], 1)
    .set(["a", "c"], 2)
    .set(["a", "d"], 3)
    .set(["a", "e"], 4)
    .set(["b"], 99)
    .set(["b", "a"], 100)
    .commit();
}

dbTest("list prefix", async (db) => {
  await setupData(db);
  const entries = await collect(db.list({ prefix: ["a"] }));
  assertEquals(entries, [
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix empty", async (db) => {
  await setupData(db);
  const entries = await collect(db.list({ prefix: ["c"] }));
  assertEquals(entries.length, 0);

  const entries2 = await collect(db.list({ prefix: ["a", "f"] }));
  assertEquals(entries2.length, 0);
});

dbTest("list prefix with start", async (db) => {
  await setupData(db);
  const entries = await collect(db.list({ prefix: ["a"], start: ["a", "c"] }));
  assertEquals(entries, [
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix with start empty", async (db) => {
  await setupData(db);
  const entries = await collect(db.list({ prefix: ["a"], start: ["a", "f"] }));
  assertEquals(entries.length, 0);
});

dbTest("list prefix with end", async (db) => {
  await setupData(db);
  const entries = await collect(db.list({ prefix: ["a"], end: ["a", "c"] }));
  assertEquals(entries, [
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix with end empty", async (db) => {
  await setupData(db);
  const entries = await collect(db.list({ prefix: ["a"], end: ["a", "a"] }));
  assertEquals(entries.length, 0);
});

dbTest("list prefix reverse", async (db) => {
  await setupData(db);

  const entries = await collect(db.list({ prefix: ["a"] }, { reverse: true }));
  assertEquals(entries, [
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix reverse with start", async (db) => {
  await setupData(db);
  const entries = await collect(
    db.list({ prefix: ["a"], start: ["a", "c"] }, { reverse: true }),
  );
  assertEquals(entries, [
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix reverse with start empty", async (db) => {
  await setupData(db);
  const entries = await collect(
    db.list({ prefix: ["a"], start: ["a", "f"] }, { reverse: true }),
  );
  assertEquals(entries.length, 0);
});

dbTest("list prefix reverse with end", async (db) => {
  await setupData(db);
  const entries = await collect(
    db.list({ prefix: ["a"], end: ["a", "c"] }, { reverse: true }),
  );
  assertEquals(entries, [
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix reverse with end empty", async (db) => {
  await setupData(db);
  const entries = await collect(
    db.list({ prefix: ["a"], end: ["a", "a"] }, { reverse: true }),
  );
  assertEquals(entries.length, 0);
});

dbTest("list prefix limit", async (db) => {
  await setupData(db);
  const entries = await collect(db.list({ prefix: ["a"] }, { limit: 2 }));
  assertEquals(entries, [
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix limit reverse", async (db) => {
  await setupData(db);
  const entries = await collect(
    db.list({ prefix: ["a"] }, { limit: 2, reverse: true }),
  );
  assertEquals(entries, [
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix with small batch size", async (db) => {
  await setupData(db);
  const entries = await collect(db.list({ prefix: ["a"] }, { batchSize: 2 }));
  assertEquals(entries, [
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix with small batch size reverse", async (db) => {
  await setupData(db);
  const entries = await collect(
    db.list({ prefix: ["a"] }, { batchSize: 2, reverse: true }),
  );
  assertEquals(entries, [
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix with small batch size and limit", async (db) => {
  await setupData(db);
  const entries = await collect(
    db.list({ prefix: ["a"] }, { batchSize: 2, limit: 3 }),
  );
  assertEquals(entries, [
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix with small batch size and limit reverse", async (db) => {
  await setupData(db);
  const entries = await collect(
    db.list({ prefix: ["a"] }, { batchSize: 2, limit: 3, reverse: true }),
  );
  assertEquals(entries, [
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix with manual cursor", async (db) => {
  await setupData(db);

  const iterator = db.list({ prefix: ["a"] }, { limit: 2 });
  const values = await collect(iterator);
  assertEquals(values, [
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
  ]);

  const cursor = iterator.cursor;
  assertEquals(cursor, "AmIA");

  const iterator2 = db.list({ prefix: ["a"] }, { cursor });
  const values2 = await collect(iterator2);
  assertEquals(values2, [
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list prefix with manual cursor reverse", async (db) => {
  await setupData(db);

  const iterator = db.list({ prefix: ["a"] }, { limit: 2, reverse: true });
  const values = await collect(iterator);
  assertEquals(values, [
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
  ]);

  const cursor = iterator.cursor;
  assertEquals(cursor, "AmQA");

  const iterator2 = db.list({ prefix: ["a"] }, { cursor, reverse: true });
  const values2 = await collect(iterator2);
  assertEquals(values2, [
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list range", async (db) => {
  await setupData(db);

  const entries = await collect(
    db.list({ start: ["a", "a"], end: ["a", "z"] }),
  );
  assertEquals(entries, [
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list range reverse", async (db) => {
  await setupData(db);

  const entries = await collect(
    db.list({ start: ["a", "a"], end: ["a", "z"] }, { reverse: true }),
  );
  assertEquals(entries, [
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list range with limit", async (db) => {
  await setupData(db);

  const entries = await collect(
    db.list({ start: ["a", "a"], end: ["a", "z"] }, { limit: 3 }),
  );
  assertEquals(entries, [
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list range with limit reverse", async (db) => {
  await setupData(db);

  const entries = await collect(
    db.list({ start: ["a", "a"], end: ["a", "z"] }, {
      limit: 3,
      reverse: true,
    }),
  );
  assertEquals(entries, [
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list range nesting", async (db) => {
  await setupData(db);

  const entries = await collect(db.list({ start: ["a"], end: ["a", "d"] }));
  assertEquals(entries, [
    { key: ["a"], value: -1, versionstamp: "00000000000000010000" },
    { key: ["a", "a"], value: 0, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list range short", async (db) => {
  await setupData(db);

  const entries = await collect(
    db.list({ start: ["a", "b"], end: ["a", "d"] }),
  );
  assertEquals(entries, [
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list range with manual cursor", async (db) => {
  await setupData(db);

  const iterator = db.list({ start: ["a", "b"], end: ["a", "z"] }, {
    limit: 2,
  });
  const entries = await collect(iterator);
  assertEquals(entries, [
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
  ]);

  const cursor = iterator.cursor;
  const iterator2 = db.list({ start: ["a", "b"], end: ["a", "z"] }, {
    cursor,
  });
  const entries2 = await collect(iterator2);
  assertEquals(entries2, [
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list range with manual cursor reverse", async (db) => {
  await setupData(db);

  const iterator = db.list({ start: ["a", "b"], end: ["a", "z"] }, {
    limit: 2,
    reverse: true,
  });
  const entries = await collect(iterator);
  assertEquals(entries, [
    { key: ["a", "e"], value: 4, versionstamp: "00000000000000010000" },
    { key: ["a", "d"], value: 3, versionstamp: "00000000000000010000" },
  ]);

  const cursor = iterator.cursor;
  const iterator2 = db.list({ start: ["a", "b"], end: ["a", "z"] }, {
    cursor,
    reverse: true,
  });
  const entries2 = await collect(iterator2);
  assertEquals(entries2, [
    { key: ["a", "c"], value: 2, versionstamp: "00000000000000010000" },
    { key: ["a", "b"], value: 1, versionstamp: "00000000000000010000" },
  ]);
});

dbTest("list invalid selector", async (db) => {
  await setupData(db);

  await assertRejects(async () => {
    await collect(
      db.list({ prefix: ["a"], start: ["a", "b"], end: ["a", "c"] }),
    );
  }, TypeError);

  await assertRejects(async () => {
    await collect(
      // @ts-expect-error missing end
      db.list({ start: ["a", "b"] }),
    );
  }, TypeError);

  await assertRejects(async () => {
    await collect(
      // @ts-expect-error missing start
      db.list({ end: ["a", "b"] }),
    );
  }, TypeError);
});

dbTest("invalid versionstamp in atomic check rejects", async (db) => {
  await assertRejects(async () => {
    await db.atomic().check({ key: ["a"], versionstamp: "" }).commit();
  }, TypeError);

  await assertRejects(async () => {
    await db.atomic().check({ key: ["a"], versionstamp: "xx".repeat(10) })
      .commit();
  }, TypeError);

  await assertRejects(async () => {
    await db.atomic().check({ key: ["a"], versionstamp: "aa".repeat(11) })
      .commit();
  }, TypeError);
});

dbTest("invalid mutation type rejects", async (db) => {
  await assertRejects(async () => {
    await db.atomic()
      // @ts-expect-error invalid type + value combo
      .mutate({ key: ["a"], type: "set" })
      .commit();
  }, TypeError);

  await assertRejects(async () => {
    await db.atomic()
      // @ts-expect-error invalid type + value combo
      .mutate({ key: ["a"], type: "delete", value: "123" })
      .commit();
  }, TypeError);

  await assertRejects(async () => {
    await db.atomic()
      // @ts-expect-error invalid type
      .mutate({ key: ["a"], type: "foobar" })
      .commit();
  }, TypeError);

  await assertRejects(async () => {
    await db.atomic()
      // @ts-expect-error invalid type
      .mutate({ key: ["a"], type: "foobar", value: "123" })
      .commit();
  }, TypeError);
});