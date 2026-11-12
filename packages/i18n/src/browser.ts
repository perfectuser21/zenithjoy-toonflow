/// <reference types="vite/client" />
import zhTwUrl from "./locales/zhTw.json?url";
import enUrl from "./locales/en.json?url";
import jaUrl from "./locales/ja.json?url";
import ruUrl from "./locales/ru.json?url";
import viUrl from "./locales/vi.json?url";
import thUrl from "./locales/th.json?url";
import koUrl from "./locales/ko.json?url";
import hiUrl from "./locales/hi.json?url";
import idUrl from "./locales/id.json?url";
import msUrl from "./locales/ms.json?url";
import filUrl from "./locales/fil.json?url";
import bnUrl from "./locales/bn.json?url";
import urUrl from "./locales/ur.json?url";
import taUrl from "./locales/ta.json?url";
import teUrl from "./locales/te.json?url";
import mrUrl from "./locales/mr.json?url";
import paUrl from "./locales/pa.json?url";
import arUrl from "./locales/ar.json?url";
import faUrl from "./locales/fa.json?url";
import trUrl from "./locales/tr.json?url";
import { getLocale, registerCatalog, setLocale as applyLocale, type Locale } from "./core";
export * from "./core";

// ACT: 浏览器只在用户实际使用某种语言时加载其字典；服务端继续同步加载完整字典。
const urls = { "zh-TW": zhTwUrl, "en": enUrl, "ja": jaUrl, "ru": ruUrl, "vi": viUrl, "th": thUrl, "ko": koUrl, "hi": hiUrl, "id": idUrl, "ms": msUrl, "fil": filUrl, "bn": bnUrl, "ur": urUrl, "ta": taUrl, "te": teUrl, "mr": mrUrl, "pa": paUrl, "ar": arUrl, "fa": faUrl, "tr": trUrl } satisfies Record<Exclude<Locale, "zh-CN">, string>;
const loaded = new Set<Locale>(["zh-CN"]);
let selection = 0;

export async function setLocale(locale: Locale) {
  const request = ++selection;
  if (!loaded.has(locale) && locale !== "zh-CN") {
    try {
      const response = await fetch(urls[locale], { cache: "no-store" });
      if (!response.ok) throw new Error("语言资源加载失败");
      const catalog: unknown = await response.json();
      if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("语言资源无效");
      registerCatalog(locale, catalog as Record<string, string>);
      loaded.add(locale);
    } catch (error) {
      if (request === selection) throw error;
      return;
    }
  }
  // 后发选择优先；失败时继续使用原有语言，不把未加载的语言发布给界面。
  if (request === selection && locale !== getLocale()) applyLocale(locale);
}
