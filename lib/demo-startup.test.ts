import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoStartup } from "./demo-startup";

test("packaged example is imported once even when startup is called twice", async () => {
  let stored: string | null = null, reads = 0, imports = 0;
  const start = createDemoStartup({ readStored: () => stored,
    fetchExample: async () => { reads++; return new Response("example"); },
    importExample: async raw => { imports++; stored = raw; },
  });
  await Promise.all([start(), start()]);
  assert.equal(stored, "example"); assert.equal(reads, 1); assert.equal(imports, 1);
});

test("existing work, including unreadable work, is never replaced by the demo", async () => {
  for (const stored of ["existing draft", ""]) {
    const start = createDemoStartup({ readStored: () => stored,
      fetchExample: async () => { throw new Error("must not fetch"); },
      importExample: async () => { throw new Error("must not import"); },
    });
    await start();
  }
});

test("work created while loading the packaged example wins", async () => {
  let stored: string | null = null;
  const start = createDemoStartup({ readStored: () => stored,
    fetchExample: async () => { stored = "new work"; return new Response("example"); },
    importExample: async () => { throw new Error("must not replace new work"); },
  });
  await start(); assert.equal(stored, "new work");
});

test("a package without an example starts empty; failures remain actionable", async () => {
  for (const status of [404,500]) {
    const start = createDemoStartup({ readStored: () => null,
      fetchExample: async () => new Response("", { status }),
      importExample: async () => { throw new Error("must not import"); },
    });
    if (status === 404) await start(); else await assert.rejects(start, /새로고침/);
  }
});
