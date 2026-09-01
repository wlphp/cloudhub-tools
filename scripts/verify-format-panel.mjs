 // 验证 src/shared/utils/format.ts 与 src/features/panels/panelMetrics.ts
 // 的纯函数行为。
 import {
   displayDnsServers,
   formatMoney,
   daysUntil,
   domainStatus,
   cloudStatusText,
   formatBytes,
   formatMetric,
   formatEsaTime,
   columnLabel,
 } from "../src/shared/utils/format.ts";
 import {
   panelAddress,
   hiddenPanelAddress,
   panelMetricNumber,
   panelMetricField,
   panelPercent,
   formatPanelNumber,
   panelLoadText,
   panelCpuInfo,
   panelMemoryInfo,
   formatPanelStorage,
   panelDiskInfo,
   panelNetworkInfo,
 } from "../src/features/panels/panelMetrics.ts";
 
 let ok = true;
 const assert = (label, got, expected) => {
   const pass = JSON.stringify(got) === JSON.stringify(expected);
   if (!pass) {
     console.error("FAIL", label, "got", JSON.stringify(got), "want", JSON.stringify(expected));
     ok = false;
   } else {
     console.log("ok", label, "->", JSON.stringify(got));
   }
 };
 
 // format.ts
 assert("displayDnsServers.array", displayDnsServers(["ns1.x", "ns2.x"]), "ns1.x, ns2.x");
 assert("displayDnsServers.null", displayDnsServers(null), "");
 assert("formatMoney.number", formatMoney(12.345), "12.35");
 assert("formatMoney.null", formatMoney(null), "-");
 assert("daysUntil.future", daysUntil("2099-01-01") > 0, true);
 assert("daysUntil.null", daysUntil(null), null);
 assert("domainStatus.normal", domainStatus({ DomainStatus: "OK" })[0], "正常");
 assert("domainStatus.expired", domainStatus({ DomainStatus: "OK", ExpirationDate: "2000-01-01" })[0], "已过期");
 assert("domainStatus.pause", domainStatus({ DomainStatus: "PAUSE" })[0], "暂停");
 assert("cloudStatusText.running", cloudStatusText("Running"), "运行中");
 assert("cloudStatusText.empty", cloudStatusText(""), "-");
 assert("formatBytes.kb", formatBytes(1500), "1.46 KB");
 assert("formatBytes.zero", formatBytes(0), "0 B");
 assert("formatMetric.thousand", formatMetric(1234), "1,234");
 assert("columnLabel.instanceName", columnLabel("InstanceName"), "实例名称");
 assert("columnLabel.unknown", columnLabel("FooBar"), "Foo Bar");
 assert("formatEsaTime.empty", formatEsaTime(""), "-");
 
 // panelMetrics.ts
 assert("panelAddress.url", panelAddress("https://example.com:8080/path"), "example.com");
 assert("panelAddress.raw", panelAddress("plain.example.com"), "plain.example.com");
 assert("hiddenPanelAddress.ip", hiddenPanelAddress("https://192.168.1.10:8080"), "192.***.***.10");
 assert("hiddenPanelAddress.domain", hiddenPanelAddress("https://example.com"), "example.com");
 assert("panelMetricNumber.string", panelMetricNumber("42ms"), 42);
 assert("panelMetricNumber.null", panelMetricNumber(null), null);
 assert("panelMetricField.found", panelMetricField({ a: 1, b: "" }, ["a", "b"]), 1);
 assert("panelMetricField.miss", panelMetricField({}, ["a"]), undefined);
 assert("panelPercent.above100", panelPercent(150), 100);
 assert("panelPercent.below0", panelPercent(-5), 0);
 assert("panelPercent.fraction", panelPercent(0.4), 40);
 assert("formatPanelNumber.string", formatPanelNumber("123"), "123");
 assert("formatPanelNumber.nan", formatPanelNumber("abc"), "abc");
 assert("panelLoadText.array", panelLoadText([10, 20, 30]), "10 / 20 / 30");
 assert("panelLoadText.empty", panelLoadText({}), "-");
 assert("panelCpuInfo.coresOnly", panelCpuInfo({ cores: 4 }).detail, "4 核");
 assert("panelMemoryInfo.usedTotal", panelMemoryInfo({ used: 512, total: 1024, unit: "MB" }).detail.includes("512"), true);
 assert("formatPanelStorage.gb", formatPanelStorage("20G"), "20 GB");
 assert("formatPanelStorage.unknown", formatPanelStorage("20T"), "20T");
 assert("panelDiskInfo.empty", panelDiskInfo(null), { path: "-", detail: "-", percent: null });
 assert("panelNetworkInfo.empty", panelNetworkInfo(null), { up: "-", down: "-" });
 
 process.exit(ok ? 0 : 1);
