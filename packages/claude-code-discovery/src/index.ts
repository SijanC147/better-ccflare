export type { DiscoveredProject, DiscoveryOptions } from "./discovery";
export { ClaudeCodeDiscovery, SlugRuleDriftError } from "./discovery";
export type { ReadDirFn } from "./path-encoding";
export {
	encodePath,
	isLikelyWorktreePath,
	naiveDecode,
	resolveEncodedName,
} from "./path-encoding";
