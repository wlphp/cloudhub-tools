import { invokeOrWeb, nativeOnly, previewOnly, queryPath } from "./base";

export type OssDetail = {
  storage: number;
  objectCount: number;
  multipartUploadCount: number;
  liveChannelCount: number;
  monthTraffic: number;
  monthRequests: number;
  acl: string;
  cnames: { Domain: string; Status?: string }[];
  cors: { origin: string[]; method: string[]; header: string[] }[];
  errors: string[];
};

export type OssObjectListing = {
  objects: Array<{ Key: string; LastModified: string; ETag: string; Size: string }>;
  prefixes: string[];
  isTruncated: boolean;
  nextMarker: string;
};

export type OssUploadSelection = { token: string; name: string; size: number };

const bucketQuery = (accountId: number, bucket: string, location: string, extra: Record<string, string | number | boolean | null | undefined> = {}) =>
  queryPath("/api/oss-objects", { id: accountId, bucket, location, ...extra });

export const storageClient = {
  detail(accountId: number, bucket: string, location: string): Promise<OssDetail> {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      return nativeOnly<string>("get_oss_acl", { id: accountId, bucket, location }).then((acl) => ({
        storage: 0, objectCount: 0, multipartUploadCount: 0, liveChannelCount: 0,
        monthTraffic: 0, monthRequests: 0, acl, cnames: [], cors: [], errors: [],
      }));
    }
    return previewOnly({ path: queryPath("/api/oss-detail", { id: accountId, bucket, location }) });
  },

  objects(accountId: number, bucket: string, location: string, prefix: string, marker: string): Promise<OssObjectListing> {
    return invokeOrWeb("list_oss_objects", { id: accountId, bucket, location, prefix, marker }, {
      path: bucketQuery(accountId, bucket, location, { prefix, marker }),
    });
  },

  publicRead(accountId: number, bucket: string, location: string): Promise<void> {
    return invokeOrWeb("set_oss_public_read", { id: accountId, bucket, location }, {
      path: queryPath("/api/oss-public-read", { id: accountId, bucket, location }), init: { method: "POST" },
    });
  },

  cors(accountId: number, bucket: string, location: string, origins: string): Promise<void> {
    return invokeOrWeb("set_oss_cors", { id: accountId, bucket, location, origins }, {
      path: queryPath("/api/oss-cors", { id: accountId, bucket, location, origins }), init: { method: "POST" },
    });
  },

  cnameToken(accountId: number, bucket: string, location: string, domain: string): Promise<Record<string, string>> {
    return previewOnly({ path: queryPath("/api/oss-cname-token", { id: accountId, bucket, location, domain }), init: { method: "POST" } });
  },

  bindCname(accountId: number, bucket: string, location: string, domain: string): Promise<void> {
    return previewOnly({ path: queryPath("/api/oss-cname", { id: accountId, bucket, location, domain }), init: { method: "POST" } });
  },

  deleteCname(accountId: number, bucket: string, location: string, domain: string): Promise<void> {
    return previewOnly({ path: queryPath("/api/oss-cname", { id: accountId, bucket, location, domain }), init: { method: "DELETE" } });
  },

  selectUploadFile(): Promise<OssUploadSelection | null> { return nativeOnly("select_oss_upload_file"); },
  stageUploadFile(sourcePath: string): Promise<OssUploadSelection> { return nativeOnly("stage_oss_upload_file", { sourcePath }); },
  discardUpload(selectionToken: string): Promise<void> { return nativeOnly("discard_oss_upload_selection", { selectionToken }); },
  upload(accountId: number, bucket: string, location: string, objectKey: string, selectionToken: string, overwrite: boolean): Promise<void> {
    return nativeOnly("upload_oss_object", { id: accountId, bucket, location, objectKey, selectionToken, overwrite });
  },
  download(accountId: number, bucket: string, location: string, objectKey: string): Promise<string | null> {
    return nativeOnly("download_oss_object", { id: accountId, bucket, location, objectKey });
  },
  downloadMany(accountId: number, bucket: string, location: string, objectKeys: string[]): Promise<string[] | null> {
    return nativeOnly("download_oss_objects", { id: accountId, bucket, location, objectKeys });
  },
  objectUrl(accountId: number, bucket: string, location: string, objectKey: string): Promise<string> {
    return nativeOnly("get_oss_object_url", { id: accountId, bucket, location, objectKey });
  },
};
