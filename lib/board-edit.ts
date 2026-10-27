import { newScene, type Board, type Scene } from "./storyboard";

export const MAX_SCENES = 30;

// Every field change, including the review toggle, is recorded in `edited`.
export function editScene<K extends keyof Scene>(board: Board, index: number, key: K, value: Scene[K]): Board {
  return {
    ...board,
    scenes: board.scenes.map((s, i) =>
      i === index ? { ...s, [key]: value, edited: Array.from(new Set([...s.edited, key])) } : s,
    ),
  };
}

export function insertSceneAfter(board: Board, index: number, scene: Scene = newScene()): Board {
  const scenes = [...board.scenes];
  scenes.splice(index + 1, 0, scene);
  return { ...board, scenes };
}

export function moveScene(board: Board, index: number, delta: number): Board | null {
  const target = index + delta;
  if (target < 0 || target >= board.scenes.length) return null;
  const scenes = [...board.scenes];
  [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
  return { ...board, scenes };
}

export function removeScene(board: Board, index: number): Board | null {
  if (board.scenes.length <= 1) return null;
  return { ...board, scenes: board.scenes.filter((_, i) => i !== index) };
}

// A regenerated scene keeps the identity of the scene it replaces.
export function replaceScene(board: Board, id: string, replacement: Scene): Board {
  return { ...board, scenes: board.scenes.map((s) => (s.id === id ? { ...replacement, id: s.id } : s)) };
}
