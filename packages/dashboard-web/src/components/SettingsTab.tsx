import React from "react";
import { CacheKeepaliveCard } from "./overview/CacheKeepaliveCard";
import { DataRetentionCard } from "./overview/DataRetentionCard";
import { PostgresConfigCard } from "./overview/PostgresConfigCard";
import { RequestStorageCard } from "./overview/RequestStorageCard";
import { SystemCacheTtlCard } from "./overview/SystemCacheTtlCard";
import { UsageThrottlingCard } from "./overview/UsageThrottlingCard";

export const SettingsTab = React.memo(() => {
	return (
		<div className="space-y-6">
			{/* Configuration Cards Grid */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<CacheKeepaliveCard />
				<SystemCacheTtlCard />
				<UsageThrottlingCard />
				<DataRetentionCard />
				<RequestStorageCard />
				<PostgresConfigCard />
			</div>
		</div>
	);
});
