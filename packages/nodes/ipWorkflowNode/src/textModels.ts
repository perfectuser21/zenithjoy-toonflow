const textModelIds = ["gpt-6.1-terra", "gpt-6.2-sol"] as const;
const terraId = textModelIds[0];

export function chooseIpTextModel<T extends { modelId: string; selectionKey: string }>(catalog: readonly T[], current: string) {
  const available = textModelIds.flatMap(id => catalog.filter(model => model.modelId === id));
  const selected = available.find(model => model.selectionKey === current)
    ?? available.find(model => model.modelId === terraId);
  return { available, selected: selected?.selectionKey ?? "" };
}
