// PDF bytes stay in this browser. Only the selected pages are stored.
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("eduflow-pdf", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("PDF를 브라우저에 저장하지 못했습니다."));
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction("files", mode), request = operation(tx.objectStore("files"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error("PDF 브라우저 저장 공간을 확인해 주세요."));
    });
  } finally { database.close(); }
}

export const savePdf = (id: string, file: Blob) => transaction("readwrite", (store) => store.put(file, id));
export const loadPdf = (id: string): Promise<Blob | undefined> => transaction("readonly", (store) => store.get(id));
export const deletePdf = (id: string) => transaction("readwrite", (store) => store.delete(id));
