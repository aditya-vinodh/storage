import { auditHandler } from "./audit.js";
import { bindHandler, unbindHandler } from "./bindings.js";
import { collectionsHandler, createHandler, whoamiHandler } from "./collections.js";
import { connectStartHandler, disconnectHandler } from "./connect.js";
import type { RegisteredHandler } from "./context.js";
import { githubInstallationListHandler, githubInstallationRemoveHandler, githubInstallStartHandler } from "./github.js";
import { grantsHandler, shareHandler, unshareHandler } from "./grants.js";
import { lifecycleHandler, setLifecycleHandler } from "./lifecycle.js";
import { linkCreateHandler, linkListHandler, linkRevokeHandler } from "./links.js";
import {
  deleteHandler,
  downloadUrlHandler,
  historyHandler,
  listHandler,
  restoreHandler,
  statHandler,
} from "./objects.js";
import { serviceCreateHandler, serviceDeleteHandler, serviceListHandler } from "./services.js";
import { tokenCreateHandler, tokenListHandler, tokenRevokeHandler } from "./tokens.js";
import { uploadCommitHandler, uploadInitiateHandler } from "./uploads.js";

export type { ConnectConfig, RegisteredHandler, ServiceConfig, ServiceContext, ServiceDeps } from "./context.js";

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
    restoreHandler,
    grantsHandler,
    shareHandler,
    unshareHandler,
    lifecycleHandler,
    setLifecycleHandler,
    bindHandler,
    unbindHandler,
    auditHandler,
    uploadInitiateHandler,
    uploadCommitHandler,
    downloadUrlHandler,
    serviceCreateHandler,
    serviceListHandler,
    serviceDeleteHandler,
    tokenCreateHandler,
    tokenListHandler,
    tokenRevokeHandler,
    linkCreateHandler,
    linkListHandler,
    linkRevokeHandler,
    connectStartHandler,
    disconnectHandler,
    githubInstallStartHandler,
    githubInstallationListHandler,
    githubInstallationRemoveHandler,
  ].map((handler) => [handler.spec.name, handler]),
);
