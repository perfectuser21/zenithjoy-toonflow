/// <reference path="./types.d.ts" />

import deepSeek from "./src/language/deepSeek";
import apiMart from "./src/media/apiMart";
import metaso from "./src/media/metaso";
import compshare from "./src/media/compshare";
import openaiImage from "./src/media/openaiImage";

export type Provider = ProviderDefinition;
export type ProviderPrice = NonNullable<Awaited<ReturnType<NonNullable<Provider["getPrice"]>>>>;
export type ProviderPriceRequest = Parameters<NonNullable<Provider["getPrice"]>>[0];
export type ProviderPriceReference = NonNullable<ProviderPriceRequest["images"]>[number];
export type ProviderBalance = Awaited<ReturnType<NonNullable<Provider["getBalance"]>>>;
export type ProviderTools = ProviderContext["tool"];
export type ProviderTaskData = Parameters<NonNullable<ProviderContext["saveTaskData"]>>[0];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [deepSeek] as const;
export const mediaProviders = [apiMart, metaso, compshare, openaiImage] as const;

const imageReferenceLimits = new Map<string, ReadonlyMap<string, number>>([
  ["aliyun", new Map([
    ["qwen-image-3.0-pro", 3],
    ["qwen-image-3.0", 3],
    ["qwen-image-2.1-pro", 10],
    ["qwen-image-2.1-turbo", 10],
  ])],
  ["openaiImage", new Map([["gpt-image-2.5-sunburst", 4]])],
]);

export function getImageReferenceLimit(providerId: string, model: Pick<ProviderModel, "id" | "maxReferenceImages">) {
  return model.maxReferenceImages ?? imageReferenceLimits.get(providerId)?.get(model.id);
}
