// Image bytes stay in this browser. Large image blobs are stored in IndexedDB.
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const request = indexedDB.open("eduflow-images", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("images")) {
        request.result.createObjectStore("images");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("이미지를 브라우저에 저장하지 못했습니다."));
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction("images", mode);
      const request = operation(tx.objectStore("images"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error("이미지 브라우저 저장 공간을 확인해 주세요."));
    });
  } finally {
    database.close();
  }
}

export const saveSceneImage = (id: string, file: Blob): Promise<void> =>
  transaction("readwrite", (store) => store.put(file, id)).then(() => {});

export const loadSceneImage = (id: string): Promise<Blob | undefined> =>
  transaction("readonly", (store) => store.get(id));

export const deleteSceneImage = (id: string): Promise<void> =>
  transaction("readwrite", (store) => store.delete(id)).then(() => {});

export async function loadSceneImages(ids: string[]): Promise<Map<string, Blob>> {
  const map = new Map<string, Blob>();
  if (typeof indexedDB === "undefined" || ids.length === 0) return map;

  for (const id of ids) {
    try {
      const blob = await loadSceneImage(id);
      if (blob) map.set(id, blob);
    } catch {
      // Ignore individual read error
    }
  }
  return map;
}

