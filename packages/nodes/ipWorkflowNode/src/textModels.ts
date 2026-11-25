const textModelIds = ["gpt-6.1-terra", "gpt-6.2-sol"] as const;
const terraId = textModelIds[0];

export function chooseIpTextModel<T extends { modelId: string; selectionKey: string }>(catalog: readonly T[], current: string) {
  const available = textModelIds.flatMap(id => catalog.filter(model => model.modelId === id));
  const selected = available.find(model => model.selectionKey === current)
    ?? available.find(model => model.modelId === terraId);
  return { available, selected: selected?.selectionKey ?? "" };
}

export function ipTrialModelName(selection: string, actualModelId?: string) {
  let id = actualModelId;
  if (id === undefined) {
    try {
      const identity = JSON.parse(selection);
      if (Array.isArray(identity) && identity.length === 2 && typeof identity[1] === "string") id = identity[1];
    } catch { return; }
  }
  if (id === "gpt-6.1-terra") return "GPT-6.1 Terra";
  if (id === "gpt-6.2-sol") return "GPT-6.2 Sol";
}
