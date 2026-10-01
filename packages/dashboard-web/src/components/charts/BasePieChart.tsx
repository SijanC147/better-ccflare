import type { ReactNode } from "react";
import {
	Cell,
	Legend,
	Pie,
	PieChart,
	ResponsiveContainer,
	Tooltip,
} from "recharts";
import {
	CHART_COLORS,
	type CHART_HEIGHTS,
	type CHART_TOOLTIP_STYLE,
} from "../../constants";
import { ChartContainer } from "./ChartContainer";
import { getChartHeight, getTooltipStyles } from "./chart-utils";
import type { ChartClickHandler, TooltipFormatterFunction } from "./types";

interface BasePieChartProps {
	data: Array<{ name: string; value: number; [key: string]: string | number }>;
	dataKey?: string | undefined;
	nameKey?: string | undefined;
	loading?: boolean | undefined;
	height?: keyof typeof CHART_HEIGHTS | number | undefined;
	innerRadius?: number | undefined;
	outerRadius?: number | undefined;
	paddingAngle?: number | undefined;
	cx?: string | number | undefined;
	cy?: string | number | undefined;
	colors?: string[] | undefined;
	tooltipFormatter?: TooltipFormatterFunction | undefined;
	tooltipStyle?: keyof typeof CHART_TOOLTIP_STYLE | object | undefined;
	animationDuration?: number | undefined;
	showLegend?: boolean | undefined;
	legendLayout?: "horizontal" | "vertical" | undefined;
	legendAlign?: "left" | "center" | "right" | undefined;
	legendVerticalAlign?: "top" | "middle" | "bottom" | undefined;
	renderLabel?: boolean | undefined;
	className?: string | undefined;
	error?: Error | null | undefined;
	emptyState?: ReactNode | undefined;
	onPieClick?: ChartClickHandler | undefined;
}

export function BasePieChart({
	data,
	dataKey = "value",
	nameKey = "name",
	loading = false,
	height = "medium",
	innerRadius = 0,
	outerRadius = 80,
	paddingAngle = 0,
	cx = "50%",
	cy = "50%",
	colors = [...CHART_COLORS],
	tooltipFormatter,
	tooltipStyle = "default",
	animationDuration = 1000,
	showLegend = false,
	legendLayout = "horizontal",
	legendAlign = "center",
	legendVerticalAlign = "bottom",
	renderLabel = false,
	className = "",
	error = null,
	emptyState,
	onPieClick,
}: BasePieChartProps) {
	const chartHeight = getChartHeight(height);
	const isEmpty = !data || data.length === 0;
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
				<PieChart>
					<Pie
						data={data}
						cx={cx}
						cy={cy}
						innerRadius={innerRadius}
						outerRadius={outerRadius}
						paddingAngle={paddingAngle}
						dataKey={dataKey}
						nameKey={nameKey}
						animationDuration={animationDuration}
						label={renderLabel}
						{...(onPieClick !== undefined ? { onClick: onPieClick } : {})}
					>
						{data.map((entry, index) => (
							<Cell
								key={`cell-${entry[nameKey]}`}
								fill={colors[index % colors.length]}
							/>
						))}
					</Pie>
					<Tooltip
						contentStyle={tooltipStyles}
						// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened Formatter to include undefined
						formatter={tooltipFormatter as any}
					/>
					{showLegend && (
						<Legend
							layout={legendLayout}
							align={legendAlign}
							verticalAlign={legendVerticalAlign}
						/>
					)}
				</PieChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
