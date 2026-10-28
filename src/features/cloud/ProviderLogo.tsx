import { cloudProvider } from "./catalog";

import alibabacloudLogo from "./assets/alibabacloud.svg?raw";
import amazonwebservicesLogo from "./assets/amazonwebservices.svg?raw";
import baiduLogo from "./assets/baidu.svg?raw";
import googlecloudLogo from "./assets/googlecloud.svg?raw";
import huaweiLogo from "./assets/huawei.svg?raw";
import microsoftLogo from "./assets/microsoft.svg?raw";
import oracleLogo from "./assets/oracle.svg?raw";
import vultrLogo from "./assets/vultr.svg?raw";
import tencentLogo from "./assets/tencentcloud-color.svg?raw";
import volcengineLogo from "./assets/volcengine-color.svg?raw";
import jdcloudLogo from "./assets/jdcloud.svg?raw";

/** 打包内置的云厂商品牌图标，按 cloud_type 静态映射，运行时不请求外部资源；未覆盖的厂商回退文字头像。 */
const providerLogos: Record<string, string> = {
  aliyun: alibabacloudLogo,
  aws: amazonwebservicesLogo,
  azure: microsoftLogo,
  baidu: baiduLogo,
  gcp: googlecloudLogo,
  huawei: huaweiLogo,
  oracle: oracleLogo,
  vultr: vultrLogo,
  tencent: tencentLogo,
  volcengine: volcengineLogo,
  jdcloud: jdcloudLogo,
};

export function hasProviderLogo(cloudType: string) {
  return Boolean(providerLogos[cloudType]);
}

export function ProviderLogo({ cloudType, className }: { cloudType: string; className?: string }) {
  const svg = providerLogos[cloudType];
  if (!svg) return null;
  return <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function CloudAvatar({ cloudType }: { cloudType: string }) {
  const hasLogo = hasProviderLogo(cloudType);
  return (
    <span className={`avatar cloud-avatar ${cloudType}${hasLogo ? " has-logo" : ""}`}>
      {hasLogo ? <ProviderLogo cloudType={cloudType} className="cloud-avatar-logo" /> : cloudProvider(cloudType).avatar}
    </span>
  );
}
