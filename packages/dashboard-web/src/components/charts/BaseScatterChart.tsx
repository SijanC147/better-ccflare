import type { ReactNode } from "react";
import {
	CartesianGrid,
	ResponsiveContainer,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import {
	type CHART_HEIGHTS,
	CHART_PROPS,
	type CHART_TOOLTIP_STYLE,
	COLORS,
} from "../../constants";
import { ChartContainer } from "./ChartContainer";
import { getChartHeight, getTooltipStyles, isChartEmpty } from "./chart-utils";
import type {
	ChartClickHandler,
	ChartDataPoint,
	TooltipFormatterFunction,
} from "./types";

interface BaseScatterChartProps {
	data: ChartDataPoint[];
	xKey: string;
	yKey: string;
	loading?: boolean | undefined;
	height?: keyof typeof CHART_HEIGHTS | number | undefined;
	fill?: string | undefined;
	xAxisLabel?: string | undefined;
	yAxisLabel?: string | undefined;
	xAxisDomain?: [number | "auto", number | "auto"] | undefined;
	xAxisTickFormatter?: ((value: number | string) => string) | undefined;
	yAxisDomain?: [number | "auto", number | "auto"] | undefined;
	yAxisTickFormatter?: ((value: number | string) => string) | undefined;
	tooltipFormatter?: TooltipFormatterFunction | undefined;
	tooltipStyle?: keyof typeof CHART_TOOLTIP_STYLE | object | undefined;
	animationDuration?: number | undefined;
	margin?:
		| { top?: number; right?: number; bottom?: number; left?: number }
		| undefined;
	className?: string | undefined;
	error?: Error | null | undefined;
	emptyState?: ReactNode | undefined;
	onDotClick?: ChartClickHandler | undefined;
	renderLabel?: ((entry: ChartDataPoint) => ReactNode) | undefined;
}

export function BaseScatterChart({
	data,
	xKey,
	yKey,
	loading = false,
	height = "medium",
	fill = COLORS.primary,
	xAxisLabel,
	yAxisLabel,
	xAxisDomain,
	xAxisTickFormatter,
	yAxisDomain,
	yAxisTickFormatter,
	tooltipFormatter,
	tooltipStyle = "default",
	animationDuration = 1000,
	margin,
	className = "",
	error = null,
	emptyState,
	onDotClick,
	renderLabel,
}: BaseScatterChartProps) {
	const chartHeight = getChartHeight(height);
	const isEmpty = isChartEmpty(data);
	const tooltipStyles = getTooltipStyles(tooltipStyle);

	return (
		<ChartContainer
			loading={loading}
			height={height}
			className={className}
			error={error}
			isEmpty={isEmpty}
			emptyState={emptyState}
		>
			<ResponsiveContainer width="100%" height={chartHeight}>
				<ScatterChart {...(margin !== undefined ? { margin } : {})}>
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						className={CHART_PROPS.gridClassName}
					/>
					<XAxis
						dataKey={xKey}
						name={xAxisLabel || xKey}
						className="text-xs"
						{...(xAxisDomain !== undefined ? { domain: xAxisDomain } : {})}
						{...(xAxisTickFormatter !== undefined
							? { tickFormatter: xAxisTickFormatter }
							: {})}
						{...(xAxisLabel
							? {
									label: {
										value: xAxisLabel,
										position: "insideBottom" as const,
										offset: -5,
									},
								}
							: {})}
					/>
					<YAxis
						dataKey={yKey}
						name={yAxisLabel || yKey}
						className="text-xs"
						{...(yAxisDomain !== undefined ? { domain: yAxisDomain } : {})}
						{...(yAxisTickFormatter !== undefined
							? { tickFormatter: yAxisTickFormatter }
							: {})}
						{...(yAxisLabel
							? {
									label: {
										value: yAxisLabel,
										angle: -90,
										position: "insideLeft" as const,
									},
								}
							: {})}
					/>
					<Tooltip
						contentStyle={tooltipStyles}
						// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened Formatter to include undefined
						formatter={tooltipFormatter as any}
					/>
					<Scatter
						name="Data"
						data={data}
						fill={fill}
						animationDuration={animationDuration}
						{...(onDotClick !== undefined ? { onClick: onDotClick } : {})}
					>
						{renderLabel &&
							data.map((entry) => (
								<text
									key={`label-${entry[xKey]}-${entry[yKey]}`}
									x={entry[xKey] ?? undefined}
									y={entry[yKey] ?? undefined}
									dy={-10}
									textAnchor="middle"
									className="text-xs fill-foreground"
								>
									{renderLabel(entry)}
								</text>
							))}
					</Scatter>
				</ScatterChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
