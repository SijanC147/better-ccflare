import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_PROPS, COLORS } from "../../constants";
import { ChartContainer } from "./ChartContainer";
import {
	type CommonChartProps,
	getChartHeight,
	getTooltipStyles,
	isChartEmpty,
} from "./chart-utils";

interface BarConfig {
	dataKey: string;
	fill?: string | undefined;
	name?: string | undefined;
	yAxisId?: string | undefined;
	radius?: [number, number, number, number] | undefined;
}

interface BaseBarChartProps extends CommonChartProps {
	bars: BarConfig | BarConfig[];
	layout?: "horizontal" | "vertical" | undefined;
	xAxisType?: "number" | "category" | undefined;
	yAxisType?: "number" | "category" | undefined;
	yAxisWidth?: number | undefined;
	yAxisOrientation?: "left" | "right" | undefined;
	secondaryYAxis?: boolean | undefined;
}

export function BaseBarChart({
	data,
	bars,
	xAxisKey = "name",
	loading = false,
	height = "medium",
	layout = "horizontal",
	xAxisAngle = 0,
	xAxisTextAnchor = "middle",
	xAxisHeight = 30,
	xAxisTickFormatter,
	xAxisType = layout === "vertical" ? "number" : "category",
	yAxisType = layout === "vertical" ? "category" : "number",
	yAxisWidth,
	yAxisDomain,
	yAxisTickFormatter,
	yAxisOrientation = "left",
	secondaryYAxis = false,
	tooltipFormatter,
	tooltipLabelFormatter,
	tooltipStyle = "default",
	animationDuration = 1000,
	showLegend = false,
	legendHeight = 36,
	margin,
	className = "",
	error = null,
	emptyState,
	onChartClick,
}: BaseBarChartProps) {
	const chartHeight = getChartHeight(height);
	const isEmpty = isChartEmpty(data);
	const tooltipStyles = getTooltipStyles(tooltipStyle);
	const barConfigs = Array.isArray(bars) ? bars : [bars];

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
				<BarChart
					data={data}
					layout={layout}
					{...(margin !== undefined ? { margin: margin } : {})}
					{...(onChartClick !== undefined ? { onClick: onChartClick } : {})}
				>
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						className={CHART_PROPS.gridClassName}
					/>
					{layout === "vertical" ? (
						<>
							<XAxis
								type={xAxisType as "number"}
								className="text-xs"
								{...(xAxisTickFormatter !== undefined
									? { tickFormatter: xAxisTickFormatter }
									: {})}
							/>
							<YAxis
								dataKey={xAxisKey}
								type={yAxisType as "category"}
								className="text-xs"
								{...(yAxisWidth !== undefined ? { width: yAxisWidth } : {})}
								{...(yAxisTickFormatter !== undefined
									? { tickFormatter: yAxisTickFormatter }
									: {})}
							/>
						</>
					) : (
						<>
							<XAxis
								dataKey={xAxisKey}
								type={xAxisType as "category"}
								className="text-xs"
								angle={xAxisAngle}
								textAnchor={xAxisTextAnchor}
								height={xAxisHeight}
								{...(xAxisTickFormatter !== undefined
									? { tickFormatter: xAxisTickFormatter }
									: {})}
							/>
							<YAxis
								{...(secondaryYAxis ? { yAxisId: "left" } : {})}
								type={yAxisType as "number"}
								className="text-xs"
								{...(yAxisDomain !== undefined ? { domain: yAxisDomain } : {})}
								orientation={yAxisOrientation}
								{...(yAxisTickFormatter !== undefined
									? { tickFormatter: yAxisTickFormatter }
									: {})}
							/>
							{secondaryYAxis && (
								<YAxis
									yAxisId="right"
									orientation="right"
									className="text-xs"
									{...(yAxisTickFormatter !== undefined
										? { tickFormatter: yAxisTickFormatter }
										: {})}
								/>
							)}
						</>
					)}
					<Tooltip
						contentStyle={tooltipStyles}
						// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened Formatter to include undefined
						formatter={tooltipFormatter as any}
						// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened labelFormatter label to ReactNode
						labelFormatter={tooltipLabelFormatter as any}
					/>
					{showLegend && <Legend height={legendHeight} />}
					{barConfigs.map((barConfig) => (
						<Bar
							key={barConfig.dataKey}
							dataKey={barConfig.dataKey}
							fill={barConfig.fill || COLORS.primary}
							name={barConfig.name || barConfig.dataKey}
							{...(barConfig.yAxisId !== undefined
								? { yAxisId: barConfig.yAxisId }
								: {})}
							{...(barConfig.radius !== undefined
								? { radius: barConfig.radius }
								: {})}
							animationDuration={animationDuration}
						/>
					))}
				</BarChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
