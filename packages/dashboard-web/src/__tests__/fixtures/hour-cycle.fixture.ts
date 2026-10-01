/**
 * Negative fixture for `hour-cycle.test.ts`. It is parsed and type-checked by
 * the scan and never executed or imported.
 *
 * Every line the scan must report carries a trailing `expect:` marker naming
 * the rules it breaks. The test reads the markers to build its expected list,
 * so a line without one asserts that the scan stays silent on it.
 */
import { format, formatRelative } from "date-fns";

const d = new Date(0);
const n = 42;
// Named like the other type, to show the scan reads the type and not the name.
const total = new Date(0);
const when = 42;
const opts: Intl.DateTimeFormatOptions = { hour: "2-digit" };

export const reported = [
	d.toLocaleString(), // expect: unpinned
	total.toLocaleString(), // expect: unpinned
	d.toLocaleTimeString(), // expect: unpinned
	d.toLocaleTimeString(undefined, { hour: "2-digit" }), // expect: unpinned
	d.toLocaleDateString(undefined, { hour: "2-digit" }), // expect: unpinned
	new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(d), // expect: unpinned
	Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(d), // expect: unpinned
	d.toLocaleString(undefined, { hourCycle: "h23", ...opts }), // expect: unpinned
	d.toLocaleString(undefined, opts), // expect: options-not-literal
	new Intl.DateTimeFormat(undefined, opts).format(d), // expect: options-not-literal
	d.toLocaleString(undefined, { hourCycle: "h23", hour12: false }), // expect: hour12
	d.toLocaleString(undefined, { hourCycle: "h12" }), // expect: hour-cycle-not-h23, unpinned
	localStorage.getItem("ccflare-24h-time"), // expect: toggle-key
	format(d, "hh:mm"), // expect: date-fns-pattern
	format(d, "HH:mm a"), // expect: date-fns-pattern
	format(d, "PPpp"), // expect: date-fns-pattern
	formatRelative(d, d), // expect: date-fns-relative
];

export const silent = [
	n.toLocaleString(),
	when.toLocaleString(),
	d.toLocaleDateString(),
	d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
	d.toLocaleString(undefined, { hourCycle: "h23" }),
	d.toLocaleString(undefined, { ...opts, hourCycle: "h23" }),
	d.toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23" }),
	new Intl.DateTimeFormat(undefined, { month: "short" }).format(d),
	Intl.DateTimeFormat().resolvedOptions().timeZone,
	format(d, "HH:mm"),
	format(d, "HH:mm 'at the' yyyy"),
	format(d, "PP"),
];
