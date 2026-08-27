export type HextapTargetOS = "darwin" | "linux" | "windows";
export type HextapTargetArch = "amd64" | "arm64";

export interface HextapTarget {
	os: HextapTargetOS;
	arch: HextapTargetArch;
	bunTarget:
		| "bun-darwin-arm64"
		| "bun-darwin-x64"
		| "bun-linux-arm64"
		| "bun-linux-x64"
		| "bun-windows-x64";
	releaseBinary: string;
}

const HEXTAP_TARGETS: Record<string, HextapTarget> = {
	"darwin/amd64": {
		os: "darwin",
		arch: "amd64",
		bunTarget: "bun-darwin-x64",
		releaseBinary: "better-ccflare-macos-x86_64",
	},
	"darwin/arm64": {
		os: "darwin",
		arch: "arm64",
		bunTarget: "bun-darwin-arm64",
		releaseBinary: "better-ccflare-macos-arm64",
	},
	"linux/amd64": {
		os: "linux",
		arch: "amd64",
		bunTarget: "bun-linux-x64",
		releaseBinary: "better-ccflare-linux-amd64",
	},
	"linux/arm64": {
		os: "linux",
		arch: "arm64",
		bunTarget: "bun-linux-arm64",
		releaseBinary: "better-ccflare-linux-arm64",
	},
	"windows/amd64": {
		os: "windows",
		arch: "amd64",
		bunTarget: "bun-windows-x64",
		releaseBinary: "better-ccflare-windows-x64.exe",
	},
};

/** Resolve one declared Hextap target to its canonical Bun compiler target. */
export function getHextapTarget(os: string, arch: string): HextapTarget {
	const target = HEXTAP_TARGETS[`${os}/${arch}`];
	if (!target) {
		throw new Error(`unsupported Hextap target: ${os}/${arch}`);
	}
	return target;
}

/** Return every release target in deterministic manifest order. */
export function getAllHextapTargets(): HextapTarget[] {
	return [
		getHextapTarget("linux", "amd64"),
		getHextapTarget("linux", "arm64"),
		getHextapTarget("darwin", "amd64"),
		getHextapTarget("darwin", "arm64"),
		getHextapTarget("windows", "amd64"),
	];
}
