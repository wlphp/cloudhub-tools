import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Account, LocalAsset } from "../../shared/types";
import { assetFavoriteKey, savedFavoriteAssetKeys, stringListFromValue, stringRecordFromValue } from "./preferences";

const favoriteAssetsStorageKey = "cloudhub-tools-favorite-assets";
const favoriteAssetOrderStorageKey = "cloudhub-tools-favorite-asset-order";
const assetNotesStorageKey = "cloudhub-tools-asset-notes";
const assetOrderStorageKey = "cloudhub-tools-asset-order";
const assetDisplayNamesStorageKey = "cloudhub-tools-asset-display-names";

type AssetNoteDraft = { key: string; value: string; initial: string } | null;

type UseAssetCollectionOptions = {
  accounts: Account[];
  localAssets: LocalAsset[];
  pageSize: number;
  clientPreferencesReady: boolean;
  savePreference: (key: string, value: string) => void;
};

export function useAssetCollection({ accounts, localAssets, pageSize, clientPreferencesReady, savePreference }: UseAssetCollectionOptions) {
  const [resourceAccountId, setResourceAccountId] = useState<number | null>(null);
  const [resourceTypeFilter, setResourceTypeFilter] = useState<string | null>(null);
  const [assetKeyword, setAssetKeyword] = useState("");
  const [assetRegionFilter, setAssetRegionFilter] = useState("");
  const [assetStatusFilter, setAssetStatusFilter] = useState("");
  const [favoriteTypeFilter, setFavoriteTypeFilter] = useState<string | null>(null);
  const [favoriteKeyword, setFavoriteKeyword] = useState("");
  const [favoriteRegionFilter, setFavoriteRegionFilter] = useState("");
  const [assetPage, setAssetPage] = useState(1);
  const [favoritePage, setFavoritePage] = useState(1);
  const [favoriteAssetKeys, setFavoriteAssetKeys] = useState<string[]>(savedFavoriteAssetKeys);
  const [assetNotes, setAssetNotes] = useState<Record<string, string>>(() => stringRecordFromValue(localStorage.getItem(assetNotesStorageKey) || undefined));
  const [assetOrder, setAssetOrder] = useState<string[]>(() => stringListFromValue(localStorage.getItem(assetOrderStorageKey) || undefined));
  const [favoriteAssetOrder, setFavoriteAssetOrder] = useState<string[]>(() => stringListFromValue(localStorage.getItem(favoriteAssetOrderStorageKey) || undefined));
  const [assetDisplayNames, setAssetDisplayNames] = useState<Record<string, string>>(() => stringRecordFromValue(localStorage.getItem(assetDisplayNamesStorageKey) || undefined));
  const [editingAssetNote, setEditingAssetNote] = useState<AssetNoteDraft>(null);
  const [favoriteRefreshingKey, setFavoriteRefreshingKey] = useState<string | null>(null);
  const [draggedAssetKey, setDraggedAssetKey] = useState<string | null>(null);
  const [draggedFavoriteKey, setDraggedFavoriteKey] = useState<string | null>(null);
  const [assetMoreKey, setAssetMoreKey] = useState<string | null>(null);
  const assetDragKeyRef = useRef<string | null>(null);
  const favoriteDragKeyRef = useRef<string | null>(null);

  useEffect(() => { setAssetPage(1); }, [resourceAccountId, resourceTypeFilter, assetKeyword, assetRegionFilter, assetStatusFilter]);
  useEffect(() => { setFavoritePage(1); }, [favoriteTypeFilter, favoriteKeyword, favoriteRegionFilter]);
  useEffect(() => { const value = JSON.stringify(favoriteAssetKeys); localStorage.setItem(favoriteAssetsStorageKey, value); savePreference(favoriteAssetsStorageKey, value); }, [favoriteAssetKeys, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(favoriteAssetOrder); localStorage.setItem(favoriteAssetOrderStorageKey, value); savePreference(favoriteAssetOrderStorageKey, value); }, [favoriteAssetOrder, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(assetNotes); localStorage.setItem(assetNotesStorageKey, value); savePreference(assetNotesStorageKey, value); }, [assetNotes, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(assetOrder); localStorage.setItem(assetOrderStorageKey, value); savePreference(assetOrderStorageKey, value); }, [assetOrder, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(assetDisplayNames); localStorage.setItem(assetDisplayNamesStorageKey, value); savePreference(assetDisplayNamesStorageKey, value); }, [assetDisplayNames, clientPreferencesReady]);

  const visibleLocalAssets = useMemo(() => {
    const order = new Map(assetOrder.map((key, index) => [key, index]));
    return localAssets
      .filter((asset) => {
        const payload = asset.payload || {};
        const label = String(payload.InstanceName || payload.DBInstanceDescription || payload.SiteName || payload.DomainName || payload.Name || asset.asset_key);
        const region = String(asset.region_id || payload.RegionId || payload.Location || "");
        const status = String(payload.Status || payload.InstanceStatus || payload.DBInstanceStatus || payload.DomainStatus || "");
        const note = assetNotes[assetFavoriteKey(asset)] || "";
        return (resourceAccountId === null || asset.account_id === resourceAccountId)
          && (!resourceTypeFilter || asset.resource_type === resourceTypeFilter)
          && (!assetKeyword || `${label} ${asset.asset_key} ${note}`.toLowerCase().includes(assetKeyword.toLowerCase()))
          && (!assetRegionFilter || region === assetRegionFilter)
          && (!assetStatusFilter || status === assetStatusFilter);
      })
      .sort((left, right) => (order.get(assetFavoriteKey(left)) ?? Number.MAX_SAFE_INTEGER) - (order.get(assetFavoriteKey(right)) ?? Number.MAX_SAFE_INTEGER));
  }, [localAssets, assetOrder, assetNotes, resourceAccountId, resourceTypeFilter, assetKeyword, assetRegionFilter, assetStatusFilter]);
  const pagedLocalAssets = visibleLocalAssets.slice((assetPage - 1) * pageSize, assetPage * pageSize);
  const favoriteAssets = useMemo(() => {
    const keys = new Set(favoriteAssetKeys);
    return localAssets.filter((asset) => keys.has(assetFavoriteKey(asset)));
  }, [localAssets, favoriteAssetKeys]);
  const visibleFavoriteAssets = useMemo(() => {
    const order = new Map(favoriteAssetOrder.map((key, index) => [key, index]));
    return favoriteAssets.filter((asset) => {
      const payload = asset.payload || {};
      const account = accounts.find((item) => item.id === asset.account_id);
      const label = String(payload.InstanceName || payload.DBInstanceDescription || payload.SiteName || payload.DomainName || payload.Name || asset.asset_key);
      const region = String(asset.region_id || payload.RegionId || payload.Location || "");
      return (!favoriteTypeFilter || asset.resource_type === favoriteTypeFilter)
        && (!favoriteKeyword || `${label} ${asset.asset_key} ${account?.account_name || ""}`.toLowerCase().includes(favoriteKeyword.toLowerCase()))
        && (!favoriteRegionFilter || region === favoriteRegionFilter);
    }).sort((left, right) => (order.get(assetFavoriteKey(left)) ?? Number.MAX_SAFE_INTEGER) - (order.get(assetFavoriteKey(right)) ?? Number.MAX_SAFE_INTEGER));
  }, [favoriteAssets, favoriteAssetOrder, accounts, favoriteTypeFilter, favoriteKeyword, favoriteRegionFilter]);
  const pagedFavoriteAssets = visibleFavoriteAssets.slice((favoritePage - 1) * pageSize, favoritePage * pageSize);

  function toggleFavorite(asset: LocalAsset) {
    const key = assetFavoriteKey(asset);
    setFavoriteAssetKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  function saveAssetNote(key: string) {
    const draft = editingAssetNote;
    if (!draft || draft.key !== key) return;
    const note = draft.value.trim();
    setEditingAssetNote(null);
    if (note === draft.initial) return;
    setAssetNotes((current) => {
      const next = { ...current };
      if (note) next[key] = note;
      else delete next[key];
      return next;
    });
  }

  function moveAssetBefore(sourceKey: string, targetKey: string) {
    if (!sourceKey || sourceKey === targetKey) return;
    const visibleKeys = visibleLocalAssets.map(assetFavoriteKey);
    const sourceIndex = visibleKeys.indexOf(sourceKey);
    const targetIndex = visibleKeys.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextVisible = [...visibleKeys];
    nextVisible.splice(sourceIndex, 1);
    nextVisible.splice(targetIndex, 0, sourceKey);
    const visibleKeySet = new Set(nextVisible);
    setAssetOrder([...nextVisible, ...localAssets.map(assetFavoriteKey).filter((key) => !visibleKeySet.has(key))]);
  }

  function startAssetDrag(event: PointerEvent<HTMLButtonElement>, sourceKey: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    assetDragKeyRef.current = sourceKey;
    setDraggedAssetKey(sourceKey);
    const cancelDrag = () => {
      assetDragKeyRef.current = null;
      setDraggedAssetKey(null);
      document.removeEventListener("pointerup", endDrag);
    };
    const endDrag = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-asset-row-key]");
      if (assetDragKeyRef.current && target?.dataset.assetRowKey) moveAssetBefore(assetDragKeyRef.current, target.dataset.assetRowKey);
      assetDragKeyRef.current = null;
      setDraggedAssetKey(null);
      document.removeEventListener("pointercancel", cancelDrag);
    };
    document.addEventListener("pointerup", endDrag, { once: true });
    document.addEventListener("pointercancel", cancelDrag, { once: true });
  }

  function moveFavoriteBefore(sourceKey: string, targetKey: string) {
    if (!sourceKey || sourceKey === targetKey) return;
    const visibleKeys = visibleFavoriteAssets.map(assetFavoriteKey);
    const sourceIndex = visibleKeys.indexOf(sourceKey);
    const targetIndex = visibleKeys.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextVisible = [...visibleKeys];
    nextVisible.splice(sourceIndex, 1);
    nextVisible.splice(targetIndex, 0, sourceKey);
    const visibleKeySet = new Set(nextVisible);
    setFavoriteAssetOrder([...nextVisible, ...favoriteAssets.map(assetFavoriteKey).filter((key) => !visibleKeySet.has(key))]);
  }

  function startFavoriteCardDrag(event: PointerEvent<HTMLButtonElement>, sourceKey: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    favoriteDragKeyRef.current = sourceKey;
    setDraggedFavoriteKey(sourceKey);
    const cancelDrag = () => {
      favoriteDragKeyRef.current = null;
      setDraggedFavoriteKey(null);
      document.removeEventListener("pointerup", endDrag);
    };
    const endDrag = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-favorite-asset-key]");
      if (favoriteDragKeyRef.current && target?.dataset.favoriteAssetKey) moveFavoriteBefore(favoriteDragKeyRef.current, target.dataset.favoriteAssetKey);
      favoriteDragKeyRef.current = null;
      setDraggedFavoriteKey(null);
      document.removeEventListener("pointercancel", cancelDrag);
    };
    document.addEventListener("pointerup", endDrag, { once: true });
    document.addEventListener("pointercancel", cancelDrag, { once: true });
  }

  return {
    resourceAccountId, setResourceAccountId, resourceTypeFilter, setResourceTypeFilter,
    assetKeyword, setAssetKeyword, assetRegionFilter, setAssetRegionFilter, assetStatusFilter, setAssetStatusFilter,
    favoriteTypeFilter, setFavoriteTypeFilter, favoriteKeyword, setFavoriteKeyword, favoriteRegionFilter, setFavoriteRegionFilter,
    assetPage, setAssetPage, favoritePage, setFavoritePage, favoriteAssetKeys, setFavoriteAssetKeys,
    assetNotes, setAssetNotes, assetOrder, setAssetOrder, favoriteAssetOrder, setFavoriteAssetOrder,
    assetDisplayNames, setAssetDisplayNames, editingAssetNote, setEditingAssetNote,
    favoriteRefreshingKey, setFavoriteRefreshingKey, draggedAssetKey, draggedFavoriteKey, assetMoreKey, setAssetMoreKey,
    visibleLocalAssets, pagedLocalAssets, favoriteAssets, visibleFavoriteAssets, pagedFavoriteAssets,
    toggleFavorite, saveAssetNote, startAssetDrag, startFavoriteCardDrag,
  };
}
