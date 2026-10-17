import { createPlugin } from "./core.mjs"
import protocol from "./protocol.mjs"

// magpie reads every exported function as a plugin entry; the named one is
// what `magpie plugin list` shows, the default keeps it loadable as a package.
// `NotionPlugin` is the upstream name, kept so the upstream transport tests
// (scripts/upstream-suite.sh) run against this adapter unchanged.
export const NotionBridgePlugin = async (_input, options) => createPlugin(protocol, options)
export const NotionPlugin = NotionBridgePlugin

export default NotionBridgePlugin
