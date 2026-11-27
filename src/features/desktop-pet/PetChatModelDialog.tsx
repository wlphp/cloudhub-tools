import { useState } from "react";
import { PetDialog } from "./PetDialog";
import type { PetChatService } from "../../platform/clients/desktopPet";

export function petChatModels(service: PetChatService): string[] {
  return [...new Set([service.model, ...(service.models ?? [])])].filter(Boolean);
}

export function PetChatModelDialog({ services, current, currentModel, busy, onApply, onClose, onManage }: {
  services: PetChatService[];
  current?: PetChatService;
  currentModel: string;
  busy: boolean;
  onApply: (service: PetChatService, model: string) => void;
  onClose: () => void;
  onManage: () => void;
}) {
  const [channelId, setChannelId] = useState(current?.id ?? "");
  const [model, setModel] = useState(currentModel);
  const channel = services.find(service => service.id === channelId) ?? services[0];
  const models = channel ? petChatModels(channel) : [];
  const modelToApply = models.includes(model) ? model : models[0];

  return <PetDialog title="切换聊天模型"
    className="pet-chat-model-dialog" onClose={onClose}
    onSubmit={event => { event.preventDefault(); if (!busy && channel && modelToApply) onApply(channel, modelToApply); }}
    footer={<>
      <button type="button" className="secondary" onClick={onClose}>取消</button>
      {channel ? <button type="submit" className="primary" disabled={busy || !modelToApply}>应用</button>
        : <button type="button" className="primary" onClick={onManage}>管理 AI 服务</button>}
    </>}>
    {channel ? <div className="pet-chat-model-fields">
      <label>渠道<select value={channel.id} onChange={event => {
        setChannelId(event.target.value);
        setModel(services.find(service => service.id === event.target.value)?.model ?? "");
      }}>{services.map(service => <option value={service.id} key={service.id}>{service.name}</option>)}</select></label>
      <label>模型<select value={modelToApply ?? ""} onChange={event => setModel(event.target.value)}>
        {models.map(name => <option value={name} key={name}>{name}</option>)}
      </select></label>
    </div> : <p>还没有启用的聊天渠道，请先在 AI 设置中配置。</p>}
  </PetDialog>;
}
