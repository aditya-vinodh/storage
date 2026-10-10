import { auditHandler } from "./audit.js";
import { collectionsHandler, createHandler, whoamiHandler } from "./collections.js";
import type { RegisteredHandler } from "./context.js";
import { grantsHandler, shareHandler, unshareHandler } from "./grants.js";
import { deleteHandler, downloadUrlHandler, historyHandler, listHandler, statHandler } from "./objects.js";
import { tokenCreateHandler, tokenListHandler, tokenRevokeHandler } from "./tokens.js";
import { uploadCommitHandler, uploadInitiateHandler } from "./uploads.js";

export type { RegisteredHandler, ServiceConfig, ServiceContext, ServiceDeps } from "./context.js";

/**
 * Server-side implementations, keyed by operation name. `put` and `get` run on
 * the client and reach the server through the upload and download operations.
 */
export const HANDLERS: ReadonlyMap<string, RegisteredHandler> = new Map(
  [
    whoamiHandler,
    collectionsHandler,
    createHandler,
    listHandler,
    statHandler,
    historyHandler,
    deleteHandler,
    grantsHandler,
    shareHandler,
    unshareHandler,
    auditHandler,
    uploadInitiateHandler,
    uploadCommitHandler,
    downloadUrlHandler,
    tokenCreateHandler,
    tokenListHandler,
    tokenRevokeHandler,
  ].map((handler) => [handler.spec.name, handler]),
);
