import { describe, expect, it } from "bun:test";
import { getHextapTarget } from "./hextap-targets";

describe("getHextapTarget", () => {
	it.each([
		["linux", "amd64", "bun-linux-x64", "better-ccflare-linux-amd64"],
		["linux", "arm64", "bun-linux-arm64", "better-ccflare-linux-arm64"],
		["darwin", "amd64", "bun-darwin-x64", "better-ccflare-macos-x86_64"],
		["darwin", "arm64", "bun-darwin-arm64", "better-ccflare-macos-arm64"],
		["windows", "amd64", "bun-windows-x64", "better-ccflare-windows-x64.exe"],
	] as const)("maps %s/%s to %s", (os, arch, bunTarget, releaseBinary) => {
		expect(getHextapTarget(os, arch)).toEqual({
			os,
			arch,
			bunTarget,
			releaseBinary,
		});
	});

	it.each([
		["windows", "arm64"],
		["linux", "386"],
		["freebsd", "amd64"],
		["", "amd64"],
	] as const)("rejects undeclared target %s/%s", (os, arch) => {
		expect(() => getHextapTarget(os, arch)).toThrow(
			`unsupported Hextap target: ${os}/${arch}`,
		);
	});
});
