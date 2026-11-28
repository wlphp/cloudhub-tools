import { useEffect, useState } from "react";
import { certificatesClient } from "../../platform/clients/certificates";
import { notesClient } from "../../platform/clients/notes";
import { authenticatorClient } from "../../platform/clients/authenticator";
import { claudeProvidersClient } from "../../platform/clients/claudeProviders";
import { flowClient } from "../../platform/clients/flow";
import { frpClient } from "../../platform/clients/frp";
import { pluginsClient } from "../../platform/clients/plugins";
import { browserClient } from "../../platform/clients/browser";
import { mailClient } from "../../platform/clients/mail";
import { cloudDriveClient } from "../../platform/clients/cloudDrive";
import { codexClient } from "../../platform/clients/codex";
import { antigravityClient } from "../../platform/clients/antigravity";
export function useSoftwareCounts(applicationIds: string) {
  const [softwareCounts, setSoftwareCounts] = useState<Record<string, number>>({});
  const [softwareCountsLoaded, setSoftwareCountsLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    setSoftwareCounts({}); setSoftwareCountsLoaded(false);
    const counts: Record<string, Promise<number>> = {};
    const enabled = new Set(applicationIds.split(","));
    if (enabled.has("cloudhub.certificates")) counts["cloudhub.certificates"] = certificatesClient.summaries().then(items => items.length);
    if (enabled.has("cloudhub.notes")) counts["cloudhub.notes"] = notesClient.snapshot().then(snapshot => snapshot.notes.filter(note => note.deletedAt === null).length);
    if (enabled.has("cloudhub.authenticator")) counts["cloudhub.authenticator"] = authenticatorClient.status().then(status => status.unlocked ? authenticatorClient.list().then(items => items.length) : 0);
    if (enabled.has("cloudhub.claude-providers")) counts["cloudhub.claude-providers"] = claudeProvidersClient.list().then(result => result.providers.length);
    if (enabled.has("cloudhub.flow")) counts["cloudhub.flow"] = flowClient.connections().then(items => items.length);
    if (enabled.has("cloudhub.frp")) counts["cloudhub.frp"] = frpClient.servers().then(items => items.length);
    if (enabled.has("cloudhub.wsl-dashboard")) counts["cloudhub.wsl-dashboard"] = pluginsClient.wslList().then(items => items.length);
    if (enabled.has("cloudhub.fingerprint-browser")) counts["cloudhub.fingerprint-browser"] = browserClient.snapshot().then(snapshot => snapshot.environments.filter(item => item.deletedAt === null).length);
    if (enabled.has("cloudhub.mail")) counts["cloudhub.mail"] = mailClient.accounts().then(items => items.length);
    if (enabled.has("cloudhub.cloud-drive")) counts["cloudhub.cloud-drive"] = cloudDriveClient.snapshot().then(snapshot => snapshot.connections.length);
    if (enabled.has("cloudhub.codex")) counts["cloudhub.codex"] = codexClient.state().then(state => state.accounts.length);
    if (enabled.has("cloudhub.antigravity")) counts["cloudhub.antigravity"] = antigravityClient.list().then(state => state.accounts.length);
    void Promise.allSettled(Object.entries(counts).map(async ([id, request]) => [id, await request] as const)).then(results => {
      if (!active) return;
      setSoftwareCounts(Object.fromEntries(results.flatMap(result => result.status === "fulfilled" ? [result.value] : [])));
      setSoftwareCountsLoaded(true);
    });
    return () => { active = false; };
  }, [applicationIds]);
  return { softwareCounts, softwareCountsLoaded };
}
