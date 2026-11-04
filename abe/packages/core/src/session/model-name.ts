/** A model's name as Abe says it, pure and import-free so `ui` can take it as a value (`@abe/core/model-name`). */

/** A model as the model line says it: a full Claude id by its family (`claude-haiku-5-5` → `haiku`). */
export const modelName = (model: string): string =>
  /^claude-(opus|sonnet|haiku)(?:-|$)/.exec(model)?.[1] ?? model;
