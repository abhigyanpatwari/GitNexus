/** Protocol registry: language syntax and parsing stay in the owning provider. */
export { default as DUBBO_LANGUAGE } from 'tree-sitter-java';
export {
  buildDubboSites as buildSites,
  dubboContractId,
  scanDubboJava as scanSource,
  type DubboSite,
  type JavaFile as SourceFile,
} from '../../../ingestion/languages/java/dubbo-source.js';
export const DUBBO_SCAN_GLOB = '**/*.java';
