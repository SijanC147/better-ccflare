import { jsonResponse } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("AdminRestart");

/**
 * POST /api/admin/restart
 *
 * Returns 202 Accepted and then exits the process with code 0.
 * This assumes the server is managed by a supervisor that restarts on exit
 * (bun --watch, systemd with Restart=always, Docker --restart=unless-stopped, PM2, etc.).
 */
export function createAdminRestartHandler() {
	return async (_req: Request): Promise<Response> => {
		log.info(
			"Restart requested via API — process will exit(0) after response flush",
		);

		// Schedule exit after the response has been sent
		setTimeout(() => {
			log.info("Exiting for restart…");
			process.exit(0);
		}, 200);

		return jsonResponse({ message: "Restarting…" }, 202);
	};
}
