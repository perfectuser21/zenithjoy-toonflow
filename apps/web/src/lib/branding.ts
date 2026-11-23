import toonflowLogo from "@toonflow/assets/logo.svg";
import yueshengLogo from "@/assets/yueshengCloud.svg";
import { actualPlatform } from "@/lib/platform";

export const webBrand = { name: "悦升云端", logoUrl: yueshengLogo };
export const isBrowserWeb = !actualPlatform.isDesktop && !actualPlatform.isMobile;
export const appBrand = isBrowserWeb ? webBrand : { name: "Toonflow", logoUrl: toonflowLogo };
