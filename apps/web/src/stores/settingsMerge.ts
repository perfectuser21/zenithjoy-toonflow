import { isEqual } from "lodash-es";

type Settings = Record<string, unknown>;
type Merge<T> = { saved: T; draft: T; base: T; conflict: boolean };

function isRecord(value: unknown): value is Settings {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeSettings(base: Settings, draft: Settings, latest: Settings): Merge<Settings> {
  const entries = [...new Set([...Object.keys(base), ...Object.keys(draft), ...Object.keys(latest)])]
    .map(key => {
      const original = Object.hasOwn(base, key) ? base[key] : undefined;
      const local = Object.hasOwn(draft, key) ? draft[key] : undefined;
      const remote = Object.hasOwn(latest, key) ? latest[key] : undefined;
      return { key, change: mergeValue(original, local, remote) };
    });
  const collect = (value: "saved" | "draft" | "base") => Object.fromEntries(entries.flatMap(({ key, change }) =>
    change[value] === undefined ? [] : [[key, change[value]]],
  ));
  return {
    saved: collect("saved"), draft: collect("draft"), base: collect("base"),
    conflict: entries.some(({ change }) => change.conflict),
  };
}

function mergeValue(base: unknown, draft: unknown, latest: unknown): Merge<unknown> {
  if (isEqual(draft, base)) return { saved: latest, draft: latest, base: latest, conflict: false };
  if (isEqual(latest, base) || isEqual(draft, latest)) return { saved: draft, draft, base: draft, conflict: false };
  if (isRecord(draft) && isRecord(latest) && (base === undefined || isRecord(base))) {
    return mergeSettings(base ?? {}, draft, latest);
  }
  return { saved: latest, draft, base, conflict: true };
}
