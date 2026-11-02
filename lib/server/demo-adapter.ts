import { generateDemo } from "../storyboard";
import { delay, type GenerationAdapter } from "./generation-service";

export const demoAdapter: GenerationAdapter = {
  mode: "demo",
  model: "extractive-demo",
  promptVersion: "extractive-demo-v2-two-captions",
  async generate(input, { signal }) {
    await delay(1200, signal);
    const board = generateDemo(input.manuscript, input.settings, input.scene, input.direction);
    return {
      title: board.title, summary: board.summary, objectives: board.objectives,
      scenes: board.scenes.map(({ id, review, reviewReason, edited, generation, references, ...content }, i) => ({ sceneNo: i + 1, ...content })),
    };
  },
};
