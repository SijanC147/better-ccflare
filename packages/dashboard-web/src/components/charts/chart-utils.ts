import { CHART_HEIGHTS, CHART_TOOLTIP_STYLE } from "../../constants";
import type { ChartClickHandler, ChartDataPoint } from "./types";

/**
 * Calculate chart height from height prop
 */
export function getChartHeight(
	height: keyof typeof CHART_HEIGHTS | number,
): number {
	return typeof height === "number" ? height : CHART_HEIGHTS[height];
}

/**
 * Check if chart data is empty
 */
export function isChartEmpty(data: ChartDataPoint[] | undefined): boolean {
	return !data || data.length === 0;
}

/**
 * Get tooltip styles from prop
 */
export function getTooltipStyles(
	tooltipStyle: keyof typeof CHART_TOOLTIP_STYLE | object,
): object {
	return typeof tooltipStyle === "string"
		? CHART_TOOLTIP_STYLE[tooltipStyle]
		: tooltipStyle;
}

/**
 * Common chart axis props
 */
export interface CommonAxisProps {
	xAxisKey?: string | undefined;
	xAxisAngle?: number | undefined;
	xAxisTextAnchor?: "start" | "middle" | "end" | undefined;
	xAxisHeight?: number | undefined;
	xAxisTickFormatter?: ((value: number | string) => string) | undefined;
	yAxisDomain?: [number | "auto", number | "auto"] | undefined;
	yAxisTickFormatter?: ((value: number | string) => string) | undefined;
}

/**
 * Common chart props shared across all chart types
 */
export interface CommonChartProps extends CommonAxisProps {
	data: ChartDataPoint[];
	loading?: boolean | undefined;
	height?: keyof typeof CHART_HEIGHTS | number | undefined;
	className?: string | undefined;
	error?: Error | null | undefined;
	emptyState?: React.ReactNode | undefined;
	margin?:
		| { top?: number; right?: number; bottom?: number; left?: number }
		| undefined;
	showLegend?: boolean | undefined;
	legendHeight?: number | undefined;
	tooltipFormatter?:
		| ((value: number, name: string) => [string, string])
		| undefined;
	tooltipLabelFormatter?: ((label: string) => string) | undefined;
	tooltipStyle?: keyof typeof CHART_TOOLTIP_STYLE | object | undefined;
	animationDuration?: number | undefined;
	onChartClick?: ChartClickHandler | undefined;
}
