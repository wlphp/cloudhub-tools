import { Cloud } from "lucide-react";
import { cloudProvider } from "../features/cloud/catalog";
import { hasProviderLogo, ProviderLogo } from "../features/cloud/ProviderLogo";

/** 与桌面端共用本地品牌资源；未知厂商保留云图标。 */
export function MobileProviderMark({ cloudType }: { cloudType: string }) {
  if (hasProviderLogo(cloudType)) {
    return <ProviderLogo cloudType={cloudType} className="mobile-provider-logo" />;
  }
  return cloudType === "other" ? <Cloud size={20} aria-hidden="true" /> : <span aria-hidden="true">{cloudProvider(cloudType).avatar}</span>;
}
