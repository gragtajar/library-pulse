// @ts-check
/**
 * Shared JSDoc typedefs. Importing the file is a no-op at runtime; importers
 * use the types via `@typedef import` references.
 */

/**
 * @typedef {Object} VercelRequest
 * @property {string=} method
 * @property {string=} url
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {Record<string, string | string[] | undefined>} query
 * @property {*} body
 */

/**
 * @typedef {Object} VercelResponse
 * @property {(name: string, value: string) => VercelResponse} setHeader
 * @property {(code: number) => VercelResponse} status
 * @property {(body?: any) => VercelResponse} json
 * @property {(body?: any) => VercelResponse} send
 * @property {(body?: any) => void} end
 */

/**
 * Discriminated union of messages the plugin sandbox sends to its UI.
 *
 * @typedef {{ type: "init", fileKey: string|null, fileName: string, currentUser: { id: string, name: string }|null }} InitMessage
 * @typedef {{ type: "storage-result", key: string, value: unknown }} StorageResultMessage
 * @typedef {{ type: "storage-saved", key: string }} StorageSavedMessage
 * @typedef {{ type: "storage-deleted", key: string }} StorageDeletedMessage
 * @typedef {{ type: "error", message: string }} PluginErrorMessage
 *
 * @typedef {InitMessage | StorageResultMessage | StorageSavedMessage | StorageDeletedMessage | PluginErrorMessage} PluginToUiMessage
 */

/**
 * @typedef {{ type: "close" }} CloseMessage
 * @typedef {{ type: "get-storage", key: string }} GetStorageMessage
 * @typedef {{ type: "set-storage", key: string, value: unknown }} SetStorageMessage
 * @typedef {{ type: "delete-storage", key: string }} DeleteStorageMessage
 * @typedef {{ type: "open-url", url: string }} OpenUrlMessage
 * @typedef {{ type: "notify", message: string, timeout?: number, error?: boolean }} NotifyMessage
 * @typedef {{ type: "resize", width?: number, height?: number }} ResizeMessage
 *
 * @typedef {CloseMessage | GetStorageMessage | SetStorageMessage | DeleteStorageMessage | OpenUrlMessage | NotifyMessage | ResizeMessage} UiToPluginMessage
 */

export {}; // make this a module
