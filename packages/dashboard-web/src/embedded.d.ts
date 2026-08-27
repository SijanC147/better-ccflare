declare module "@better-ccflare/dashboard-web/dist/embedded" {
	export interface EmbeddedAsset {
		content: string;
		contentType: string;
	}

	export const embeddedDashboard: Record<string, EmbeddedAsset>;
	export const dashboardManifest: Record<string, string>;
}

declare module "@better-ccflare/dashboard-web/dist/manifest.json" {
	const manifest: Record<string, string>;
	export default manifest;
}
