import { DRAFT_STORAGE_KEY } from "./studio-state";

type StartupDependencies = {
  readStored: () => string | null;
  fetchExample: () => Promise<Response>;
  importExample: (raw: string) => Promise<void>;
};

// Share initialization across React Strict Mode effect replays. Import only into
// an empty browser, including a second check after the asynchronous fetch.
export function createDemoStartup(deps: StartupDependencies) {
  let pending: Promise<void> | undefined;
  return () => pending ??= (async () => {
    if (deps.readStored() !== null) return;
    const response = await deps.fetchExample();
    if (response.status === 404) return;
    if (!response.ok) throw new Error("데모 예제를 불러오지 못했습니다. 새로고침해 다시 시도해 주세요.");
    const raw = await response.text();
    if (deps.readStored() !== null) return;
    await deps.importExample(raw);
  })();
}

export const prepareDemoExample = createDemoStartup({
  readStored: () => localStorage.getItem(DRAFT_STORAGE_KEY),
  fetchExample: () => fetch("/api/demo/work", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Demo-Action": "read" },
    body: "{}", signal: AbortSignal.timeout(30000),
  }),
  importExample: async raw => {
    const { importWorkPackage } = await import("./work-package-browser");
    await importWorkPackage(raw);
  },
});
